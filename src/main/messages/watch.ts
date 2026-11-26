import type { AppContext } from '../context';
import { observeSessions } from '../sessions/observe';

/** A compact projection of observe; execution state never asserts result delivery. */
export function watchedSession(ctx: AppContext, sessionId: string) {
  if (sessionId.startsWith('orchestrator:')
    ? !ctx.workspaces.list().some(w => w.id === sessionId.slice('orchestrator:'.length))
    : !ctx.sessions.get(sessionId)) {
    return { sessionId, missing: true, busy: null, lifecycle: null, phase: null,
      archived: false, launchError: null, transcript: 'unavailable', lastReply: null };
  }
  const s = observeSessions(ctx, { sessionId });
  if (!('sessionId' in s)) throw new Error('会话观察未返回单会话状态');
  const reply = 'lastReply' in s ? s.lastReply : null;
  return { sessionId, missing: false, busy: s.busy, lifecycle: s.lifecycle, phase: s.phase,
    archived: s.archived, launchError: s.launchError, transcript: 'transcript' in s ? s.transcript : 'unavailable',
    lastReply: reply ? { messageId: reply.messageId, status: reply.status, finishedAt: reply.finishedAt } : null };
}
export type WatchedSession = ReturnType<typeof watchedSession>;
