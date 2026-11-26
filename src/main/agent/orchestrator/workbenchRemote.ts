import type { ChatMessage } from '../../../shared/types';
import { messagingTurnIdentity } from '../../messaging/sessionAuthority';
import type { OrchestratorHost } from './internal';
import { schedulerIsClosing } from './lifecycle';

type Scheduler = Pick<OrchestratorHost, 'buckets' | 'send' | 'isBusy'> & {
  stop(workspaceId: string): unknown;
  getHistoryRange(workspaceId: string, before: number | undefined, limit: number, target: string): { messages: readonly ChatMessage[] };
};

export type WorkbenchSchedulerResult =
  | { status: 'completed'; message: ChatMessage }
  | { status: 'busy' | 'unavailable' | 'unknown' };

/** Host-only paired IM admission. The initiating caller owns the exact assistant result. */
export async function sendWorkbenchRemote(scheduler: Scheduler, text: string, workspaceId: string, requestId: string,
  signal: AbortSignal, isCurrent: () => boolean): Promise<WorkbenchSchedulerResult> {
  if (schedulerIsClosing(scheduler) || signal.aborted || !isCurrent()) return { status: 'unavailable' };
  if (scheduler.isBusy(workspaceId)) return { status: 'busy' };
  const { userMessageId, assistantMessageId } = messagingTurnIdentity(requestId);
  const recovered = scheduler.getHistoryRange(workspaceId, undefined, 1, assistantMessageId).messages[0];
  if (recovered?.id === assistantMessageId && recovered.finishedAt) return { status: 'completed', message: recovered };
  let accepted = false;
  let skipped = false;
  let settled: ChatMessage | undefined;
  const abortOwnedTurn = () => {
    const bucket = scheduler.buckets.get(workspaceId);
    if (!bucket?.busy || bucket.streamingAssistant?.id !== assistantMessageId) return;
    bucket.streamingAssistant.aborted = true;
    scheduler.stop(workspaceId);
  };
  signal.addEventListener('abort', abortOwnedTurn, { once: true });
  try {
    await scheduler.send(text, workspaceId, undefined, {
      requireIdle: true,
      messageId: userMessageId,
      onAccepted: () => { accepted = true; },
      onSkipped: () => { skipped = true; },
      beforeStart: () => !signal.aborted && isCurrent(),
      workbenchRemote: { assistantId: assistantMessageId, signal, settle: message => { settled = message; } }
    });
  } catch {
    return { status: 'unknown' };
  } finally { signal.removeEventListener('abort', abortOwnedTurn); }
  if (settled) return { status: 'completed', message: settled };
  if (accepted) return { status: 'unknown' };
  return { status: skipped && !signal.aborted && isCurrent() ? 'busy' : 'unavailable' };
}
