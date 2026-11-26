import type { CliLaunchOptions } from './cliLaunchOptions';
import type { ModelParameterValues } from './modelParameters';
import type { NativeConfigIntent } from './nativeSessionConfig';

export const WORKER_ROUTING_LIMITS = { tiers: 16, membersPerTier: 12, tierName: 80, tierDescription: 400, mentionsPerMessage: 12 } as const;
export const WORKER_ROUTING_STANDARD_KINDS = ['low', 'medium', 'high', 'xhigh'] as const;
export const WORKER_ROUTING_SETTINGS_LOCATION = 'Settings → Harness (Automatic delegation section below the resource list)';
export const WORKER_CODEX_PERMISSION_PROFILES = [':read-only', ':workspace', ':danger-full-access'] as const;

export type WorkerRoutingStandardKind = typeof WORKER_ROUTING_STANDARD_KINDS[number];
export type WorkerRoutingTierKind = WorkerRoutingStandardKind | 'special';

export function isWorkerRoutingTierKind(value: unknown): value is WorkerRoutingTierKind {
  return value === 'special' || WORKER_ROUTING_STANDARD_KINDS.some(kind => kind === value);
}

export function workerRoutingTierKindRank(kind: WorkerRoutingTierKind): number {
  return kind === 'special' ? WORKER_ROUTING_STANDARD_KINDS.length : WORKER_ROUTING_STANDARD_KINDS.indexOf(kind);
}

/** The adapter-facing identity of one worker choice. The source is bound separately. */
export interface WorkerTargetConfig {
  harnessId: string;
  surface: 'gui' | 'cli';
  runtimeId: string;
  acpPresetId?: string;
  model?: { providerId: string; modelId: string };
  modelParameters?: ModelParameterValues;
  cliLaunchOptions?: CliLaunchOptions;
}

export interface WorkerRoutingScope {
  workspaceId: string;
  rootId: string;
  rootsRevision: number;
  cwd?: string;
}

export type WorkerTargetSelection = { tierId: string } | { targetRef: string };

export interface WorkerCrossHarnessConsent {
  nativeConfig: NativeConfigIntent;
  /** The desktop settings host writes this after confirming the effective native permissions. */
  binding?: string;
}

export interface WorkerRoutingMember {
  id: string;
  enabled: boolean;
  config: WorkerTargetConfig;
  crossHarness?: WorkerCrossHarnessConsent;
}

export interface WorkerRoutingTier {
  id: string;
  name: string;
  /** Omitted by legacy settings and clients. */
  kind?: WorkerRoutingTierKind;
  description: string;
  members: WorkerRoutingMember[];
  fallbackTierIds: string[];
}

const legacyWorkerTierKinds = new Map<string, WorkerRoutingStandardKind>([
  ['轻量', 'low'], ['Lightweight', 'low'], ['攻坚', 'high'], ['Complex tasks', 'high']
]);

/** Classify legacy pools without changing their identities or route order. */
export function normalizeWorkerRoutingTierKinds(
  tiers: readonly WorkerRoutingTier[], previousTiers: readonly WorkerRoutingTier[] = []
): Array<WorkerRoutingTier & { kind: WorkerRoutingTierKind }> {
  const previousKinds = new Map(previousTiers.map(tier => [tier.id, tier.kind]));
  const retained = tiers.map(tier => ({ ...tier, kind: tier.kind ?? previousKinds.get(tier.id) }));
  const occupied = new Set<WorkerRoutingTierKind>();
  const legacyCounts = new Map<WorkerRoutingStandardKind, number>();
  for (const tier of retained) {
    if (tier.kind) occupied.add(tier.kind);
    else {
      const legacyKind = legacyWorkerTierKinds.get(tier.name);
      if (legacyKind) legacyCounts.set(legacyKind, (legacyCounts.get(legacyKind) ?? 0) + 1);
    }
  }
  return retained.map(tier => {
    const legacyKind = legacyWorkerTierKinds.get(tier.name);
    return { ...tier, kind: tier.kind ?? (legacyKind && !occupied.has(legacyKind) && legacyCounts.get(legacyKind) === 1 ? legacyKind : 'special') };
  });
}

export interface WorkerRoutingConfig {
  revision: number;
  tiers: WorkerRoutingTier[];
}

export interface WorkerRoutingMemberStatus {
  id: string;
  state: 'available' | 'unknown' | 'disabled' | 'cooldown' | 'invalid';
  reason?: string;
  retryAt?: number;
}

export type WorkerRoutingLayer = 'global' | 'workspace';

export interface WorkerRoutingReadInput {
  scope: WorkerRoutingScope;
  layer: WorkerRoutingLayer;
}

export interface WorkerRoutingSaveInput extends WorkerRoutingReadInput {
  expectedVersion: string;
  config: WorkerRoutingConfig;
}

export interface WorkerRoutingFollowGlobalInput {
  scope: WorkerRoutingScope;
  expectedVersion: string;
}

export interface WorkerRoutingResetCooldownInput extends WorkerRoutingReadInput {
  expectedVersion: string;
  memberId: string;
}

export interface WorkerRoutingSettings {
  layer: WorkerRoutingLayer;
  origin: WorkerRoutingLayer;
  version: string;
  config: WorkerRoutingConfig;
  members: WorkerRoutingMemberStatus[];
}

export type WorkerRoutingChanged = { kind: 'global' } | { kind: 'workspace'; workspaceId: string } |
  { kind: 'cooldown'; workspaceId?: string };

export interface WorkerRoutingRouteVersion {
  origin: WorkerRoutingLayer;
  revision: number;
  workspaceRevision: number;
}

export interface WorkerTargetReference {
  targetRef: string;
  config: WorkerTargetConfig;
}

export interface WorkerRouteCandidate {
  tierId?: string;
  tierName?: string;
  memberId?: string;
  config: WorkerTargetConfig;
  crossHarness?: WorkerCrossHarnessConsent;
}

export interface WorkerRoutePlan {
  requested: WorkerTargetSelection;
  requestedTierName?: string;
  scope: WorkerRoutingScope;
  sourceKey: string;
  controlKey: string;
  /** Old plans only carry the revision of a workspace override. */
  revision?: number;
  routingVersion?: WorkerRoutingRouteVersion;
  candidates: WorkerRouteCandidate[];
}

export type WorkerRouteReason = 'quota' | 'rate-limit' | 'engine-unavailable' | 'authentication' | 'temporary-service' | 'invalid-choice' | 'delivery-unknown' | 'source-changed';

export interface WorkerRouteAttempt extends WorkerRouteCandidate {
  attempt: number;
  startedAt: number;
  state: 'starting' | 'running' | 'idle' | 'failed' | 'blocked' | 'completed' | 'cancelled';
  reason?: WorkerRouteReason;
  nativeConfirmed?: { providerId?: string; modelId?: string; modelParameters?: ModelParameterValues };
}

export interface WorkerRouteState {
  plan: WorkerRoutePlan;
  attempts: WorkerRouteAttempt[];
  phase: 'starting' | 'running' | 'idle' | 'switching' | 'blocked' | 'completed' | 'cancelled';
  reason?: WorkerRouteReason;
  /** An explicit launch policy or inherited parent policy takes priority over pool consent. */
  crossHarnessRestricted?: true;
}

export interface WorkerRouteReceipt {
  requested: { tierId: string } | { exact: true };
  state: WorkerRouteState['phase'] | 'queued';
  resolved?: WorkerRouteCandidate;
  attempt?: number;
  reason?: WorkerRouteReason;
  nativeConfirmed?: WorkerRouteAttempt['nativeConfirmed'];
}

/** Pending native delivery cannot be confirmed from a persisted route alone. */
export function recoverWorkerRouteAfterRestart(route: WorkerRouteState): WorkerRouteState {
  if (!['starting', 'running', 'switching'].includes(route.phase)) return route;
  const recovered = structuredClone(route);
  recovered.phase = 'blocked';
  recovered.reason = 'delivery-unknown';
  const attempt = recovered.attempts.at(-1);
  if (attempt && attempt.state !== 'failed') { attempt.state = 'blocked'; attempt.reason = 'delivery-unknown'; }
  return recovered;
}
