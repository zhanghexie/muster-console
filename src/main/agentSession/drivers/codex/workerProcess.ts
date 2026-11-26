import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Interface as ReadlineInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProcessLimits } from './processSupervisor';

const unpack = (file: string): string => file.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
const moduleFile = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
export function codexWorkerAsset(name: string, override?: string): string {
  const base = path.dirname(moduleFile);
  const found = [override, path.join(base, 'worker', name), path.join(base, 'agentSession/drivers/codex/worker', name)]
    .filter((p): p is string => !!p).map(unpack).find(p => fs.existsSync(p));
  if (!found) throw new Error(`Codex worker asset missing: ${name}`);
  return found;
}
export interface CodexWorkerLimits extends ProcessLimits { workerPath?: string; jobPath?: string; }

/** The private worker remains idle until this freshly challenged reply. */
export function challengeCodexWorker(child: ChildProcessWithoutNullStreams, reader: ReadlineInterface,
  nonce: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      reader.removeListener('line', onLine);
      reader.removeListener('close', onClose);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      child.stdout.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(value ?? '');
    };
    const onAbort = (): void => finish(new Error('Codex 工作进程身份校验已取消'));
    const onExit = (): void => finish(new Error('Codex 工作进程在身份校验时退出'));
    const onClose = (): void => finish(new Error('Codex 工作进程输出已关闭'));
    const onError = (error: Error): void => finish(error);
    const onLine = (line: string): void => {
      let message: { type?: unknown; nonce?: unknown };
      try { message = JSON.parse(line) as { type?: unknown; nonce?: unknown }; }
      catch { finish(new Error('Codex 工作进程身份响应无效')); return; }
      if (message.type === 'ready') return;
      if (message.type !== 'identity-response' || typeof message.nonce !== 'string') {
        finish(new Error('Codex 工作进程身份响应无效')); return;
      }
      finish(undefined, message.nonce);
    };
    if (signal.aborted) { onAbort(); return; }
    reader.on('line', onLine);
    reader.once('close', onClose);
    child.once('exit', onExit);
    child.once('error', onError);
    child.stdout.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      child.stdin.write(JSON.stringify({ type: 'identity-challenge', nonce }) + '\n', error => { if (error) finish(error); });
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
