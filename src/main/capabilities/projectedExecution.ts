import type { HostAskRoute } from '../../shared/hostAsk';
import type { ProjectedHostDefinition } from './catalog/hostProjection';
import { routeProjectedHostCall } from './projectedHostRoute';
import { executeProjectedSessionUpdate } from './projectedSessionUpdate';
import type { SessionUpdateInput } from './sessionUpdate';

type Caller = { kind: 'scheduler' } | { kind: 'worker'; sessionId: string };
type Target = { id: string; parentSessionId?: string };
type Request = Readonly<{ source: string; target: string; args: Readonly<Record<string, unknown>> }>;

/** The host supplies the existing permission and identity boundary; this adapter grants nothing. */
export async function executeProjectedHostCall(entries: readonly ProjectedHostDefinition[], caller: Caller,
  name: string, raw: unknown, target: Target | undefined, deps: {
    isCurrent(): boolean;
    authorize(request: Request): Promise<() => boolean>;
    dispatch(target: string, args: Record<string, unknown>): Promise<unknown>;
    ask(route: HostAskRoute): Promise<unknown>;
  }): Promise<unknown> {
  if (!deps || typeof deps.isCurrent !== 'function' || typeof deps.authorize !== 'function' ||
      typeof deps.dispatch !== 'function' || typeof deps.ask !== 'function') throw new Error('Projected host execution is unavailable');
  const current = (): void => { if (!deps.isCurrent()) throw new Error('Host caller or target changed'); };
  const route = routeProjectedHostCall(entries, caller.kind, name, raw);
  current();
  if (route.kind === 'session-update') {
    return executeProjectedSessionUpdate(route.args as SessionUpdateInput, caller, target, route.sources, {
      isCurrent: deps.isCurrent,
      authorize: (source, operation) => deps.authorize(Object.freeze({ source, target: operation.tool, args: operation.args })),
      execute: operation => deps.dispatch(operation.tool, operation.args)
    });
  }
  const source = route.permissionSource;
  const targetName = route.kind === 'direct' ? route.target : route.route.tool;
  const args = structuredClone(route.kind === 'direct' ? route.args : route.route.args);
  const guard = await deps.authorize(Object.freeze({ source, target: targetName, args: Object.freeze(structuredClone(args)) }));
  current();
  if (typeof guard !== 'function' || !guard()) throw new Error('Host authorization changed');
  if (route.kind === 'direct') return deps.dispatch(targetName, args);
  return deps.ask({ ...route.route, args } as HostAskRoute);
}
