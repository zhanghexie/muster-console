import type { PiSessionHandle } from '../../../shared/piEvents';
import type { TurnChangeTracker } from '../../turnChanges/service';

/** Agent-core awaits these listeners before the tool executes or the next event. */
export function subscribePiReview(session: PiSessionHandle, tracker?: TurnChangeTracker): () => void {
  if (!tracker || typeof session.agent?.subscribe !== 'function') return () => {};
  return session.agent.subscribe(async event => {
    if (event.type === 'tool_execution_start') {
      await tracker.toolStart(String(event.toolCallId ?? ''), String(event.toolName ?? ''),
        (event.args ?? {}) as Record<string, unknown>, undefined, true);
    } else if (event.type === 'tool_execution_end') {
      await tracker.toolEnd(String(event.toolCallId ?? ''), !event.isError, undefined, true);
    }
  });
}
