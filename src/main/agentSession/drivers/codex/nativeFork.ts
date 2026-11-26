import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { GuiNativeForkPoint, GuiRuntimeConnection } from '../../types';
import { spawnOwnedProcess } from '../../process/owner';
import { boundedAcpRequest } from '../../processReclamation';
import { ConnectionCleanupError } from '../../host/retirement';
import { genericWorkerEnvironment } from '../../process/workerEnvironment';
import { collectEnvSecrets, redactSafetyText } from '../../../safety/redact';
import { challengeCodexWorker, codexWorkerAsset } from './workerProcess';
import { CodexProcessSupervisor } from './processSupervisor';
import { sameCodexHome } from './appServerTransport';

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};

/** Fork only a completed native turn; the standard user-message boundary is finer. */
export async function forkCodexTurn(
  point: GuiNativeForkPoint, cwd: string, executable: string, env: Record<string, string>
): Promise<Awaited<ReturnType<NonNullable<GuiRuntimeConnection['nativeFork']>>>> {
  let reader: ReadlineInterface | undefined;
  const secrets = collectEnvSecrets(env);
  const clean = (value: unknown): string => redactSafetyText(value instanceof Error ? value.message : String(value), secrets).slice(0, 1600);
  const owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({
    command: process.execPath, args: [codexWorkerAsset('native-worker.mjs')],
    spawnOptions: { env: genericWorkerEnvironment({ ELECTRON_RUN_AS_NODE: '1' }), stdio: 'pipe' },
    windows: { kind: 'job', jobPath: process.platform === 'win32' ? codexWorkerAsset('windows-job.ps1') : '' },
    identityChallenge: (child, nonce, signal) => reader
      ? challengeCodexWorker(child, reader, nonce, signal)
      : Promise.reject(new Error('Codex 分叉工作进程身份通道尚未初始化')),
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
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) { fail('Codex 分叉响应超限'); return; }
    let frame: Obj;
    try { frame = obj(JSON.parse(line)); } catch { fail('Codex 分叉响应格式无效'); return; }
    if (frame.type === 'app-error' || frame.type === 'app-exit') { fail(String(frame.error || frame.stderr || 'Codex 分叉进程提前退出，结果可能未知')); return; }
    if (frame.type !== 'app-rpc') return;
    const message = obj(frame.value), id = message.id;
    if (typeof id !== 'number' || typeof message.method === 'string') return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (message.error) request.reject(new Error(clean(obj(message.error).message || 'Codex 分叉请求失败')));
    else request.resolve(message.result);
  };
  const onClose = (): void => fail('Codex 分叉进程提前退出，结果可能未知');
  const request = (method: string, params: Obj): Promise<unknown> => {
    const id = ++sequence;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ type: 'app-rpc', value: { id, method, params } }) + '\n', error => {
        if (error) { pending.delete(id); reject(new Error('Codex 分叉请求发送失败，结果可能未知')); }
      });
    });
    return boundedAcpRequest(result, 30_000, `Codex ${method}`);
  };
  try {
    await owner.ready;
    if (owner.state !== 'ready') throw new Error('Codex 分叉工作进程不可用');
    reader.on('line', onLine); reader.once('close', onClose);
    child.stdin.write(JSON.stringify({ type: 'run-app-server', executable, cwd, env }) + '\n');
    const init = obj(await request('initialize', { clientInfo: { name: 'muster_workbench', version: '0.1.31' }, capabilities: { experimentalApi: true } }));
    if (!sameCodexHome(init.codexHome, env)) throw new Error('Codex 会话存储位置不一致，无法安全分叉');
    child.stdin.write(JSON.stringify({ type: 'app-rpc', value: { method: 'initialized', params: {} } }) + '\n');
    // Page lightweight turn metadata, avoiding an unbounded full transcript read.
    const deadline = Date.now() + 30_000;
    let cursor: string | undefined;
    let found = false;
    for (let page = 0; page < 20 && Date.now() < deadline; page++) {
      const result = obj(await request('thread/turns/list', { threadId: point.sessionToken, limit: 100, itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) }));
      if (!Array.isArray(result.data)) return { status: 'unsupported' };
      const match = result.data.map(obj).find(turn => turn.id === point.entryId);
      if (match) {
        if (match.status !== 'completed') throw new Error('Codex 分叉截点不是已完成回合');
        found = true; break;
      }
      if (!result.nextCursor) break;
      if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) throw new Error('Codex 回合列表游标无效');
      cursor = result.nextCursor;
    }
    if (!found) return { status: 'unsupported' };
    const response = obj(await request('thread/fork', { threadId: point.sessionToken, lastTurnId: point.entryId, cwd,
      excludeTurns: true, deferGoalContinuation: true, config: { mcp_servers: {} } }));
    const fork = obj(response.thread);
    if (typeof fork.id !== 'string' || !fork.id || fork.id === point.sessionToken ||
        (fork.forkedFromId != null && fork.forkedFromId !== point.sessionToken))
      throw new Error('Codex 返回的分叉会话标识无效，请检查原生会话记录');
    return { status: 'forked', token: fork.id };
  } finally {
    fail('Codex 分叉连接已关闭');
    try { await supervisor.stop(); await supervisor.release(); }
    catch (error) { throw new ConnectionCleanupError(`Codex 分叉工作进程回收失败：${clean(error)}`); }
    finally { reader.close(); }
  }
}
