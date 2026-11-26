/**
 * JSON-RPC 2.0 over NDJSON（ACP stdio 传输）。
 * 入站单行和无换行残缓冲共用 8 MiB 限额。
 * 超限按传输错 failAll（不截断静默）；出站走
 * 有界缓冲写（8MiB/128 帧上限，drain 恢复），防行为异常的 agent 撑爆主进程内存。
 */
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class NdjsonRpcResponseError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

/** Shared inbound per-line limit (8 MiB). */
export const MAX_WIRE_BYTES = 8 * 1024 * 1024;
/** 出站有界缓冲：待写字节 + 流内积压合计上限（8MiB）与待写帧数上限（128） */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_FRAMES = 128;

export class NdjsonRpc extends EventEmitter {
  private nextId = 1;
  private buf = '';
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; observe?: (v: unknown) => void }
  >();
  private closed = false;
  private eofError?: Error;
  /** 出站背压：blocked=上游 write 返回 false，drain 恢复后回放 pending */
  private outbound: string[] = [];
  private outboundBlocked = false;
  private outboundBytes = 0;
  private streamClosed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly options: { omitJsonRpcVersion?: boolean; unexpectedEof?: () => Error } = {}
  ) {
    super();
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.onData(chunk));
    stdout.on('end', () => {
      if (this.closed) return;
      this.eofError = this.options.unexpectedEof?.();
      this.failAll(this.eofError ?? new Error('ACP stdio EOF'));
    });
    stdout.on('error', (e: Error) => this.failAll(e));
    // 向已退出 agent 的管道写入是异步 EPIPE（emit 而非同步 throw），必须在此收口
    stdin.on('error', (e: Error) => this.failAll(e));
    stdin.once('close', () => {
      this.streamClosed = true;
      this.outbound.length = 0;
      this.outboundBytes = 0;
    });
    stdin.on('drain', () => {
      this.outboundBlocked = false;
      while (!this.streamClosed && this.outbound.length && !this.outboundBlocked) {
        const line = this.outbound.shift()!;
        this.outboundBytes -= Buffer.byteLength(line, 'utf8');
        this.outboundBlocked = !this.stdin.write(line);
      }
    });
  }

  request(method: string, params?: unknown, observe?: (v: unknown) => void, onSubmission?: () => void): Promise<unknown> {
    if (this.closed) return Promise.reject(this.eofError ?? new Error('ACP rpc 已关闭'));
    const id = this.nextId++;
    const key = String(id);
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(key, { resolve, reject, observe });
    });
    if (this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })) onSubmission?.();
    return p;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: JsonRpcId, message: string, code = -32000): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('ACP rpc 已关闭'));
  }

  /** 传输层外部错误（如 child spawn 失败）：与流死亡同语义收口 */
  failExternal(err: Error): void {
    this.failAll(err);
  }

  private failAll(err: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    this.buf = '';
    this.outbound.length = 0;
    this.outboundBytes = 0;
    for (const [, w] of this.pending) w.reject(err);
    this.pending.clear();
    this.emit('close', err);
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buf += chunk;
    while (!this.closed) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_WIRE_BYTES) {
        this.failAll(new Error(`ACP rpc 入站单行超过 ${MAX_WIRE_BYTES}B 上限`));
        return;
      }
      if (!line.trim()) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.emit('parse-error', line);
        continue;
      }
      this.dispatch(msg);
    }
    // 无换行的残缓冲同样受限：行为异常的 agent 持续输出无换行长行时不得无界增长
    if (Buffer.byteLength(this.buf, 'utf8') > MAX_WIRE_BYTES) {
      this.failAll(new Error(`ACP rpc 入站缓冲超过 ${MAX_WIRE_BYTES}B 上限（无换行）`));
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const w = this.pending.get(String(msg.id));
      if (!w) return;
      this.pending.delete(String(msg.id));
      if (msg.error) w.reject(new NdjsonRpcResponseError(msg.error.code, msg.error.message || 'ACP rpc error', msg.error.data));
      else {
        try {
          // Observe authoritative snapshots in wire order, before a later
          // notification in the same stdout chunk can update them.
          w.observe?.(msg.result);
          w.resolve(msg.result);
        } catch (error) {
          w.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return;
    }
    if (typeof msg.method === 'string') {
      this.emit('message', msg);
    }
  }

  private write(obj: JsonRpcMessage): boolean {
    try {
      if (this.streamClosed) throw new Error('ACP rpc 管道已关闭');
      // Some NDJSON protocols use the same request/response shape but reject
      // JSON-RPC's version field; keep ACP's default envelope unchanged.
      const { jsonrpc: _version, ...bare } = obj;
      const line = `${JSON.stringify(this.options.omitJsonRpcVersion ? bare : obj)}\n`;
      const frameBytes = Buffer.byteLength(line, 'utf8');
      if (
        this.outboundBytes + (this.stdin.writableLength ?? 0) + frameBytes > MAX_PENDING_BYTES ||
        this.outbound.length >= MAX_PENDING_FRAMES
      ) {
        throw new Error('ACP rpc 出站背压超限（8MiB/128 帧）');
      }
      if (this.outboundBlocked) {
        this.outbound.push(line);
        this.outboundBytes += frameBytes;
        return true;
      }
      this.outboundBlocked = !this.stdin.write(line);
      return true;
    } catch (e) {
      this.failAll(e as Error);
      return false;
    }
  }
}
