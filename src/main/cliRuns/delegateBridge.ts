import { addDelegateDrainedListener, cancelQueuedDelegate, type DelegateDrainedOutcome } from '../tasks/delegateQueue';
import { cliWorkerFromDelegate } from './workers';
import type { CliWorker } from './runtime';

/** CLI submissions report a failed launch immediately instead of silently
 * retrying it and creating more unbound sessions. Other callers keep their queue policy. */
export function createCliDelegateBridge() {
  const waiting = new Map<string, { taskId?: string; resolve: (worker: CliWorker) => void; reject: (error: Error) => void }>();
  const early = new Map<string, DelegateDrainedOutcome>();
  const stopRetry = (id: string) => {
    cancelQueuedDelegate(id);
    // During the failure notification the item is still launching. The queue
    // may reinsert it after listeners return; remove that exact item afterwards.
    queueMicrotask(() => cancelQueuedDelegate(id));
  };
  const settle = (id: string, outcome: DelegateDrainedOutcome) => {
    const pending = waiting.get(id); if (!pending) return false;
    waiting.delete(id);
    try {
      if (outcome.ok) pending.resolve(cliWorkerFromDelegate(outcome.result, pending.taskId));
      else pending.reject(Object.assign(new Error(outcome.error), outcome.sessionId ? { sessionId: outcome.sessionId } : {}));
    } catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
    return true;
  };
  const off = addDelegateDrainedListener((id, _workspace, outcome) => {
    if (!outcome.ok && waiting.has(id)) stopRetry(id);
    if (settle(id, outcome)) return;
    early.set(id, outcome);
    const timer = setTimeout(() => early.delete(id), 60_000); timer.unref();
  });
  return {
    waitQueued: (id: string, registerCancel: (cancel: () => boolean) => void, taskId?: string) => new Promise<CliWorker>((resolve, reject) => {
      waiting.set(id, { taskId, resolve, reject });
      registerCancel(() => {
        if (!cancelQueuedDelegate(id)) return false;
        waiting.delete(id); reject(new Error('CLI run cancelled before worker launch')); return true;
      });
      const outcome = early.get(id);
      if (outcome) { early.delete(id); if (!outcome.ok) stopRetry(id); settle(id, outcome); }
    }),
    dispose: () => { off(); for (const [id, pending] of waiting) { stopRetry(id); pending.reject(new Error('CLI service stopped')); } waiting.clear(); early.clear(); }
  };
}
