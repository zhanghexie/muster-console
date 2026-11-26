import type { AppContext } from '../context';
import type { PtyDesktopTurn } from './ptyDesktopTurns';

/** Capture before reading the HTTP body so a delayed old request cannot borrow a later instruction. */
export function capturePtyDesktopRequest(ctx: AppContext, token: string): PtyDesktopTurn {
  if (!token || !ctx.desktopPtyTurns) throw new Error('CLI desktop control requires an authenticated process-bound request');
  const caller = ctx.sessions.resolveSessionRef({ statusToken: token });
  const session = ctx.sessions.peek(caller.id), scopeToken = ctx.sessions.sessionScopeToken(caller.id);
  if (!session || session.type !== 'terminal' || session.launchKind === 'shell' || session.archived ||
      ctx.sessions.isChatRuntime(session.runtime) || !scopeToken) throw new Error('CLI desktop session is unavailable');
  const generation = ctx.pty.desktopProcessGeneration(caller.id);
  if (!generation) throw new Error('CLI desktop process is unavailable');
  return ctx.desktopPtyTurns().capture(caller.id, { processGeneration: generation, sessionToken: scopeToken,
    isCurrent: () => ctx.sessions.peek(caller.id) === session && !session.archived &&
      ctx.sessions.sessionScopeToken(caller.id) === scopeToken && ctx.pty.desktopProcessGeneration(caller.id) === generation });
}
