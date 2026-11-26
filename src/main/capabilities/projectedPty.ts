import { safetyRisk } from '../safety/policy';
import type { ProjectedHostDefinition } from './catalog/hostProjection';
import type { ExecuteResult } from './executor';
import { executeProjectedHostCall } from './projectedExecution';
import { routeProjectedHostCall } from './projectedHostRoute';
import { captureProjectedSessionTarget } from './projectedSessionTarget';

/** Caller identity and source binding must be supplied by the authenticated PTY gateway. */
export async function executeProjectedPty(entries: readonly ProjectedHostDefinition[], name: string, raw: Record<string, unknown>,
  deps: { sessionId: string; resolveSession(ref: string): { id: string; parentSessionId?: string } | undefined;
    sessionIdentity(id: string): object | undefined;
    isCurrent(): boolean; execute(target: string, args: Record<string, unknown>): Promise<ExecuteResult>;
    ask(args: Record<string, unknown>): Promise<unknown> }): Promise<unknown> {
  if (!deps.sessionId || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PTY host caller or arguments are invalid');
  let args = structuredClone(raw);
  let target: { id: string; parentSessionId?: string } | undefined;
  let targetCurrent = () => true;
  if (name === 'host.sessions.update') {
    const ref = typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId : deps.sessionId;
    const binding = captureProjectedSessionTarget(ref, deps.resolveSession, deps.sessionIdentity);
    target = binding.target;
    targetCurrent = binding.isCurrent;
    args = { ...args, sessionId: target.id };
  }
  const isCurrent = () => deps.isCurrent() && targetCurrent();
  if (name === 'host.ask') {
    if (routeProjectedHostCall(entries, 'worker', name, args).kind !== 'ask') throw new Error('Invalid host question route');
    if (!isCurrent()) throw new Error('PTY host caller changed');
    const answer = await deps.ask(args);
    if (!isCurrent()) throw new Error('PTY host caller changed');
    return answer;
  }
  return executeProjectedHostCall(entries, { kind: 'worker', sessionId: deps.sessionId }, name, args, target, {
    isCurrent,
    async authorize(request) {
      if (name === 'host.sessions.update' && safetyRisk({ action: request.target, args: { ...request.args }, source: 'catalog', workspaceId: '' }) !== 'routine') {
        throw new Error('Session update requires multi-operation approval');
      }
      return isCurrent;
    },
    async dispatch(action, actionArgs) {
      const result = await deps.execute(action, actionArgs);
      if (name !== 'host.sessions.update' || !result.ok) return result;
      const value = result.result;
      if (value && typeof value === 'object' && ((value as { ok?: unknown }).ok === false ||
          (Array.isArray((value as { failed?: unknown }).failed) && (value as { failed: unknown[] }).failed.length))) return value;
      return result;
    },
    async ask() { throw new Error('PTY question route is unavailable'); }
  });
}
