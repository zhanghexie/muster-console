import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnOwnedProcess } from '../../process/owner';
import { boundedAcpRequest } from '../../processReclamation';
import { ConnectionCleanupError } from '../../host/retirement';
import { genericWorkerEnvironment } from '../../process/workerEnvironment';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { challengeCodexWorker, codexWorkerAsset, type CodexWorkerLimits } from './workerProcess';
import { CodexProcessSupervisor } from './processSupervisor';

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};

type Request = (method: string, params: Obj) => Promise<unknown>;

export class CodexRpcError extends Error {
  constructor(message: string, readonly code: number | undefined) { super(message); }
}

function normalizedCodexPath(value: string): string {
  let result = path.resolve(value);
  try { result = fs.realpathSync.native(result); } catch { /* a new home may not exist yet */ }
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

export function codexHomeOf(env: Record<string, string>): string {
  return normalizedCodexPath(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

export function sameCodexHome(actual: unknown, env: Record<string, string>): boolean {
  return typeof actual === 'string' && !!actual.trim() && normalizedCodexPath(actual) === codexHomeOf(env);
}

/** Run history RPCs in an owned app-server without subscribing to a thread. */
export async function withCodexNativeRpc<T>(
  cwd: string, executable: string, env: Record<string, string>, run: (request: Request) => Promise<T>,
  options: Pick<CodexWorkerLimits, 'workerPath' | 'jobPath'> & { timeoutMs?: number } = {}
): Promise<T> {
  let reader: ReadlineInterface | undefined;
  const secrets = collectEnvSecrets(env);
  const clean = (value: unknown): string => redactSafetyText(value instanceof Error ? value.message : String(value), secrets).slice(0, 1600);
  const owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({
    command: process.execPath, args: [codexWorkerAsset('native-worker.mjs', options.workerPath)],
    spawnOptions: { env: genericWorkerEnvironment({ ELECTRON_RUN_AS_NODE: '1' }), stdio: 'pipe' },
    windows: { kind: 'job', jobPath: process.platform === 'win32' ? codexWorkerAsset('windows-job.ps1', options.jobPath) : '' },
    identityChallenge: (child, nonce, signal) => reader
      ? challengeCodexWorker(child, reader, nonce, signal)
      : Promise.reject(new Error('Codex 原生会话工作进程身份通道尚未初始化')),
    beforeReclaim: child => { if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write('{"type":"abort"}\n'); }
  });
  const supervisor = new CodexProcessSupervisor(owner, () => {});
  const child = owner.child;
  reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdout.once('close', () => reader?.close());
  child.stderr.resume();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let sequence = 0;
  const fail = (message: string): void => { for (const request of pending.values()) request.reject(new Error(clean(message))); pending.clear(); };
  const onLine = (line: string): void => {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) { fail('Codex 原生会话响应超限'); return; }
    let frame: Obj;
    try { frame = obj(JSON.parse(line)); } catch { fail('Codex 原生会话响应格式无效'); return; }
    if (frame.type === 'app-error' || frame.type === 'app-exit') { fail(String(frame.error || frame.stderr || 'Codex 原生会话进程提前退出，结果可能未知')); return; }
    if (frame.type !== 'app-rpc') return;
    const message = obj(frame.value), id = message.id;
    if (typeof id !== 'number' || typeof message.method === 'string') return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (message.error) {
      const error = obj(message.error);
      request.reject(new CodexRpcError(clean(error.message || 'Codex 原生会话请求失败'), typeof error.code === 'number' ? error.code : undefined));
    }
    else request.resolve(message.result);
  };
  const onClose = (): void => fail('Codex 原生会话进程提前退出，结果可能未知');
  const request = (method: string, params: Obj): Promise<unknown> => {
    const id = ++sequence;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ type: 'app-rpc', value: { id, method, params } }) + '\n', error => {
        if (error) { pending.delete(id); reject(new Error('Codex 原生会话请求发送失败，结果可能未知')); }
      });
    });
    return boundedAcpRequest(result, options.timeoutMs ?? 30_000, `Codex ${method}`);
  };
  try {
    await owner.ready;
    if (owner.state !== 'ready') throw new Error('Codex 原生会话工作进程不可用');
    reader.on('line', onLine); reader.once('close', onClose);
    child.stdin.write(JSON.stringify({ type: 'run-app-server', executable, cwd, env }) + '\n');
    const init = obj(await request('initialize', { clientInfo: { name: 'muster_workbench', version: '0.1.31' }, capabilities: { experimentalApi: true } }));
    if (!sameCodexHome(init.codexHome, env)) throw new Error('Codex 会话存储位置不一致，无法操作原生会话');
    child.stdin.write(JSON.stringify({ type: 'app-rpc', value: { method: 'initialized', params: {} } }) + '\n');
    return await run(request);
  } finally {
    fail('Codex 原生会话连接已关闭');
    try { await supervisor.stop(); await supervisor.release(); }
    catch (error) { throw new ConnectionCleanupError(`Codex 原生会话工作进程回收失败：${clean(error)}`); }
    finally { reader.close(); }
  }
}
