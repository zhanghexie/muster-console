import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { spawnOwnedProcess, type OwnedProcess } from '../../process/owner';

type Frame = Record<string, unknown>;
type Pending = { resolve(value: Frame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Chunk = { next: number; count: number; length: number; bytes: number; parts: Buffer[] };
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 16 * 1024 * 1024;
const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;

/** Pi/OMP's JSONL RPC, with bounded framing and request correlation. */
export class ExternalPiRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly owner: OwnedProcess<ChildProcessWithoutNullStreams>;
  private input = '';
  private pending = new Map<string, Pending>();
  private outbound: string[] = [];
  private outboundBytes = 0;
  private blocked = false;
  private closed = false;
  private sequence = 0;
  private readonly secrets: string[];
  private readonly chunks = new Map<string, Chunk>();
  private onFrame: (frame: Frame) => void;
  private onFailure: (error: Error) => void;

  constructor(options: {
    command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
    onFrame(frame: Frame): void; onFailure(error: Error): void; log(message: string): void; secrets?: string[];
  }) {
    this.onFrame = options.onFrame;
    this.onFailure = options.onFailure;
    this.owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({
      command: options.command,
      args: options.args,
      windows: { kind: 'taskkill' },
      spawnOptions: {
        cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/i.test(options.command)
      }
    });
    this.child = this.owner.child;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new Error(`外部 Pi 进程退出（${code ?? signal ?? '未知'}）`));
    });
    this.child.stdin.on('drain', () => this.flush());
    this.secrets = [...collectEnvSecrets(options.env, name => /BRIDGE/i.test(name)), ...(options.secrets ?? [])];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const text = redactSafetyText(chunk, this.secrets).trim();
      if (text) options.log(text.slice(0, 800));
    });
  }

  async waitReady(): Promise<void> {
    await this.owner.ready;
    if (this.closed || this.owner.state !== 'ready') throw new Error('外部 Pi 进程已退出或正在回收');
  }

  request(type: string, fields: Frame = {}, timeoutMs = 30_000, requestId?: string): Promise<Frame> {
    if (this.closed) return Promise.reject(new Error('外部 Pi 连接已关闭'));
    const id = requestId ?? `muster-${++this.sequence}`;
    if (this.pending.has(id)) return Promise.reject(new Error('外部 Pi RPC 请求标识冲突'));
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`外部 Pi ${type} 超时`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...fields, id, type }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  send(frame: Frame): void {
    if (this.closed) throw new Error('外部 Pi 连接已关闭');
    this.write(frame);
  }

  sanitize(value: string): string { return redactSafetyText(value, this.secrets).slice(0, 800); }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectPending(new Error('外部 Pi 连接已关闭'));
    await this.owner.reclaim();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  private write(frame: Frame): void {
    const line = `${JSON.stringify(frame)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_OUTBOUND_BYTES || this.outboundBytes + this.child.stdin.writableLength + bytes > MAX_OUTBOUND_BYTES || this.outbound.length >= 128)
      throw new Error('外部 Pi RPC 出站缓冲超限');
    if (this.blocked) { this.outbound.push(line); this.outboundBytes += bytes; return; }
    this.blocked = !this.child.stdin.write(line);
  }

  private flush(): void {
    this.blocked = false;
    while (!this.closed && !this.blocked && this.outbound.length) {
      const line = this.outbound.shift()!;
      this.outboundBytes -= Buffer.byteLength(line, 'utf8');
      this.blocked = !this.child.stdin.write(line);
    }
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.input += chunk;
    for (;;) {
      const end = this.input.indexOf('\n');
      if (end < 0) break;
      const line = this.input.slice(0, end).replace(/\r$/, '');
      this.input = this.input.slice(end + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) return this.fail(new Error('外部 Pi RPC 消息超限'));
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { return this.fail(new Error('外部 Pi RPC 输出不是有效 JSON')); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return this.fail(new Error('外部 Pi RPC 消息格式无效'));
      this.dispatch(value as Frame);
    }
    if (Buffer.byteLength(this.input, 'utf8') > MAX_FRAME_BYTES) this.fail(new Error('外部 Pi RPC 未结束消息超限'));
  }

  private dispatch(frame: Frame): void {
    if (frame.type === 'rpc_chunk') {
      const id = typeof frame.chunkId === 'string' ? frame.chunkId : '';
      const index = Number(frame.index), count = Number(frame.count), length = Number(frame.byteLength);
      const data = typeof frame.data === 'string' ? frame.data : '';
      if (!id || !Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 128 ||
          !Number.isInteger(length) || length < 1 || length > MAX_REASSEMBLED_BYTES || !data ||
          data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return this.fail(new Error('外部 Pi RPC 分片格式无效'));
      let state = this.chunks.get(id);
      if (!state) {
        if (index !== 0 || this.chunks.size >= 4) return this.fail(new Error('外部 Pi RPC 分片顺序无效'));
        state = { next: 0, count, length, bytes: 0, parts: [] };
        this.chunks.set(id, state);
      }
      if (state.next !== index || state.count !== count || state.length !== length) return this.fail(new Error('外部 Pi RPC 分片不一致'));
      const bytes = Buffer.from(data, 'base64');
      state.bytes += bytes.length;
      if (state.bytes > state.length) return this.fail(new Error('外部 Pi RPC 分片长度超限'));
      state.parts.push(bytes); state.next += 1;
      if (state.next === state.count) {
        this.chunks.delete(id);
        if (state.bytes !== state.length) return this.fail(new Error('外部 Pi RPC 分片长度不一致'));
        let assembled: unknown;
        try { assembled = JSON.parse(Buffer.concat(state.parts).toString('utf8')); }
        catch { return this.fail(new Error('外部 Pi RPC 分片不是有效 JSON')); }
        if (!assembled || typeof assembled !== 'object' || Array.isArray(assembled)) return this.fail(new Error('外部 Pi RPC 分片内容无效'));
        this.dispatch(assembled as Frame);
      }
      return;
    }
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(frame.id);
        if (frame.success === false) pending.reject(new Error(typeof frame.error === 'string' ? redactSafetyText(frame.error, this.secrets).slice(0, 800) : '外部 Pi RPC 请求失败'));
        else if (frame.success === true) pending.resolve(frame);
        else pending.reject(new Error('外部 Pi RPC 未确认请求结果'));
        return;
      }
    }
    this.onFrame(frame);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
    this.onFailure(error);
  }
}
