/** Independent of discovery/installation: any applicable deny wins. */
export type UsageKind = 'skill' | 'mcp';
export type UsageScope = { kind: 'global' } | { kind: 'harness'; runtimeId: string } | { kind: 'workspace'; workspaceId: string };
export interface UsageRule { scope: UsageScope; kind: UsageKind; resourceId: string }
export interface UsagePolicy { revision: number; disabled: UsageRule[] }
export interface UsageContext { runtimeId?: string; workspaceId?: string }
export interface UsageState {
  enabled: boolean;
  blockedBy?: 'global' | 'harness' | 'workspace' | 'configuration';
  globalEnabled: boolean;
  harnessEnabled: boolean;
  workspaceEnabled: boolean;
  categoryBlocked?: boolean;
}
export interface UsageResource { id: string; name: string; kind: UsageKind; state: UsageState; externalDiscovery?: boolean }
export interface UsageSnapshot {
  revision: number;
  resources: UsageResource[];
  runtimes: Array<{ id: string; label: string }>;
  categories: Record<UsageKind, UsageState>;
}
export interface UsageListInput extends UsageContext { kind?: UsageKind }
export interface UsageSetInput {
  scope: UsageScope;
  kind: UsageKind;
  /** '*' is the category switch. Multiple IDs permit one atomic bulk change. */
  resourceIds: string[];
  enabled: boolean;
  expectedRevision: number;
}
export function sameUsageScope(a: UsageScope, b: UsageScope): boolean {
  return a.kind === b.kind && (a.kind === 'global' || (a.kind === 'harness' && b.kind === 'harness' && a.runtimeId === b.runtimeId) || (a.kind === 'workspace' && b.kind === 'workspace' && a.workspaceId === b.workspaceId));
}
export function resolveUsage(policy: UsagePolicy | undefined, kind: UsageKind, resourceId: string, context: UsageContext = {}, configured = true): UsageState {
  const allowed = (scope: UsageScope): boolean => !policy?.disabled.some(rule => rule.kind === kind && (rule.resourceId === '*' || rule.resourceId === resourceId) && sameUsageScope(rule.scope, scope));
  const globalEnabled = allowed({ kind: 'global' });
  const harnessEnabled = !context.runtimeId || allowed({ kind: 'harness', runtimeId: context.runtimeId });
  const workspaceEnabled = !context.workspaceId || allowed({ kind: 'workspace', workspaceId: context.workspaceId });
  const blockedBy = !globalEnabled ? 'global' : !harnessEnabled ? 'harness' : !workspaceEnabled ? 'workspace' : !configured ? 'configuration' : undefined;
  const categoryBlocked = resourceId !== '*' && !!policy?.disabled.some(rule => rule.kind === kind && rule.resourceId === '*' && (rule.scope.kind === 'global' || (rule.scope.kind === 'harness' && rule.scope.runtimeId === context.runtimeId) || (rule.scope.kind === 'workspace' && rule.scope.workspaceId === context.workspaceId)));
  return { enabled: !blockedBy, blockedBy, globalEnabled, harnessEnabled, workspaceEnabled, categoryBlocked };
}
