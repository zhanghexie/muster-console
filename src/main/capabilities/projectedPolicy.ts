import type { ProjectedHostDefinition } from './catalog/hostProjection';
import { routeProjectedHostCall } from './projectedHostRoute';
import { planProjectedSessionUpdate, sessionUpdatePermissionSource } from './projectedSessionUpdate';
import type { SessionUpdateInput } from './sessionUpdate';

export interface ProjectedPolicyRequest {
  source: string;
  target: string;
  args: Record<string, unknown>;
}

/** Resolve every underlying permission before executing a public projected call. */
export function projectedPolicyRequests(entries: readonly ProjectedHostDefinition[],
  caller: { kind: 'scheduler' } | { kind: 'worker'; sessionId: string }, name: string, raw: unknown,
  target?: { id: string; parentSessionId?: string }): ProjectedPolicyRequest[] {
  const route = routeProjectedHostCall(entries, caller.kind, name, raw);
  if (route.kind === 'direct') return [{ source: route.permissionSource, target: route.target, args: route.args }];
  if (route.kind === 'ask') return [{ source: route.permissionSource, target: route.route.tool, args: route.route.args }];
  const operations = planProjectedSessionUpdate(route.args as SessionUpdateInput, caller, target);
  return operations.map(operation => ({ source: sessionUpdatePermissionSource(operation.tool, route.sources),
    target: operation.tool, args: operation.args }));
}
