import { isToolDefHidden, type TurnHiddenTools } from '../../shared/turnVisibility';
import { safetyRisk } from '../safety/policy';
import type { ProjectedHostDefinition } from './catalog/hostProjection';
import type { ExecuteResult } from './executor';
import { executeProjectedHostCall } from './projectedExecution';
import { captureProjectedSessionTarget } from './projectedSessionTarget';

/** Scheduler adapter. The injected executor retains its existing confirmation and audit behavior. */
export async function executeProjectedScheduler(entries: readonly ProjectedHostDefinition[], name: string, raw: Record<string, unknown>,
  deps: { resolveSession(ref: string): { id: string; parentSessionId?: string } | undefined;
    sessionIdentity(id: string): object | undefined;
    isCurrent(): boolean; execute(target: string, args: Record<string, unknown>): Promise<ExecuteResult> },
  hidden?: TurnHiddenTools): Promise<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Host tool parameters must be an object');
  let args = structuredClone(raw);
  let target: { id: string; parentSessionId?: string } | undefined;
  let targetCurrent = () => true;
  if (name === 'host.sessions.update' && typeof args.sessionId === 'string' && args.sessionId.trim()) {
    const binding = captureProjectedSessionTarget(args.sessionId, deps.resolveSession, deps.sessionIdentity);
    target = binding.target;
    targetCurrent = binding.isCurrent;
    args = { ...args, sessionId: target.id };
  }
  const isCurrent = () => deps.isCurrent() && targetCurrent();
  return executeProjectedHostCall(entries, { kind: 'scheduler' }, name, args, target, {
    isCurrent,
    async authorize(request) {
      if (hidden && (isToolDefHidden({ name: request.source }, hidden) || isToolDefHidden({ name: request.target }, hidden))) {
        throw new Error(`Host tool ${request.target} is hidden for the current turn`);
      }
      // All current session setters are routine. If that policy changes, fail before
      // any field is modified until a multi-operation approval receipt is available.
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
    async ask(route) { return deps.execute(route.tool, route.args); }
  });
}
