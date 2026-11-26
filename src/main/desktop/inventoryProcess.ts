import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import path from 'node:path';
import { desktopRuntime } from './runtime';
import { projectDesktopMetadata } from './inventoryProjection';
import type { Win32InventoryResult } from './win32Inventory';
import type { MacInventoryResult } from './macInventory';
import type { X11InventoryResult } from './x11Inventory';

type Launch = (file: string, args: string[], options: ForkOptions & { windowsHide: boolean }) => ChildProcess;

/** Internal, read-only metadata adapter. Returned observations are not actionable surface identities. */
export function runDesktopInventory(options: { workerFile: string; limit?: number; timeoutMs?: number; signal?: AbortSignal;
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; launch?: Launch }): Promise<ReturnType<typeof projectDesktopMetadata>> {
  const limit = options.limit ?? 500, timeoutMs = options.timeoutMs ?? 10_000;
  if (!path.isAbsolute(options.workerFile) || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid desktop inventory options');
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  const runtime = desktopRuntime(options.platform ?? process.platform, env);
  if (runtime !== 'windows' && runtime !== 'macos' && runtime !== 'linux-x11') {
    throw new Error(`Desktop window inventory is unavailable for ${runtime}; a native desktop adapter is required`);
  }
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = (options.launch ?? fork)(options.workerFile, [String(limit)], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }); }
    catch (error) { reject(new Error(`Desktop inventory worker failed to start: ${String(error)}`)); return; }
    let message: unknown, count = 0, finished = false;
    const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true; cleanup();
      if (child.exitCode === null && child.signalCode === null) {
        let requested = false;
        try { requested = child.kill(); } catch { /* Failure is reported below. */ }
        reject(new Error(`${error.message}; worker termination ${requested ? 'requested' : 'could not be requested'} and is not confirmed`));
      } else reject(error);
    };
    const abort = (): void => fail(new Error('Desktop inventory was cancelled'));
    const timer = setTimeout(() => fail(new Error('Desktop inventory worker timed out')), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('message', value => {
      if (finished) return;
      if (++count !== 1) { fail(new Error('Desktop inventory worker returned multiple responses')); return; }
      try { if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new Error('too large'); }
      catch { fail(new Error('Invalid desktop inventory response')); return; }
      message = value;
    });
    child.once('error', error => fail(new Error(`Desktop inventory worker failed: ${error.message}`)));
    // Wait for the IPC channel to drain; `exit` alone may precede the last message.
    child.once('close', code => {
      if (finished) return;
      const value = message as { ok?: unknown; runtime?: unknown; result?: unknown; error?: unknown } | undefined;
      if (code !== 0 || value?.ok !== true || value.runtime !== runtime || !value.result) {
        fail(new Error(typeof value?.error === 'string' ? `Desktop inventory failed: ${value.error}` : 'Desktop inventory worker exited without a valid response')); return;
      }
      try {
        const projected = projectDesktopMetadata(runtime, value.result as Win32InventoryResult | MacInventoryResult | X11InventoryResult);
        if (projected.observations.length > limit) throw new Error('Inventory exceeds the requested limit');
        finished = true; cleanup(); resolve(projected);
      } catch (error) { fail(new Error(`Invalid desktop inventory response: ${String(error)}`)); }
    });
    if (options.signal?.aborted) abort();
  });
}
