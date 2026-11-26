import { createHash } from 'node:crypto';
import type { AppContext } from '../context';
import { currentAgentSessionId, isSchedulerInvocation } from '../agent/agentScope';
import { uploadScope } from '../browser/uploadScope';
import type { TrustedDisplayActor } from './displayService';
/** The task storage key includes the host generation; it is never supplied by a model. */
function workerStorageTask(sessionId: string, generation: number): string {
  return `worker:${createHash('sha256').update(JSON.stringify([sessionId, generation])).digest('hex')}`;
}

/** Resolve a live task for pixel reads. No caller may nominate another session or epoch. */
export async function captureIdentity(ctx: AppContext, signal?: AbortSignal): Promise<TrustedDisplayActor> {
  const scope = uploadScope(ctx, undefined, 'Desktop capture');
  const sessionId = currentAgentSessionId();
  const scopeCurrent = (): boolean => { try { scope.assertCurrent(); return !signal?.aborted; } catch { return false; } };
  scope.assertCurrent(); signal?.throwIfAborted();
  if (sessionId) {
    if (!ctx.desktopWorkerTask) throw new Error('Desktop Worker task identity is unavailable');
    const lease = ctx.desktopWorkerTask().epochs.capture(sessionId, scope.workspaceId);
    const actor = { sessionId, taskId: workerStorageTask(sessionId, lease.generation),
      isCurrent: () => scopeCurrent() && lease.isCurrent() };
    if (!actor.isCurrent()) throw new Error('Desktop Worker task is no longer current');
    return Object.freeze(actor);
  }
  if (!isSchedulerInvocation() || !ctx.desktopSchedulerTask) throw new Error('Desktop scheduler task identity is unavailable');
  const owner = `orchestrator:${scope.workspaceId}`, epochs = ctx.desktopSchedulerTask();
  const taskId = await epochs.ensureCapture(owner, scopeCurrent, signal);
  const actor = { sessionId: owner, taskId, isCurrent: () => scopeCurrent() && epochs.currentBinding(owner)?.epoch === taskId };
  if (!actor.isCurrent()) throw new Error('Desktop scheduler task is no longer current');
  return Object.freeze(actor);
}
