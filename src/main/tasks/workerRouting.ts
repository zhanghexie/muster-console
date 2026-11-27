import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { app } from 'electron';
import { writeJsonAtomicSync } from '../atomicJson';
import type { AppContext } from '../context';
import type { AppConfig } from '../../shared/types';
import type { WorkerCrossHarnessConsent, WorkerRouteCandidate, WorkerRoutePlan, WorkerRouteReceipt, WorkerRouteState, WorkerRoutingConfig, WorkerRoutingLayer, WorkerRoutingMemberStatus, WorkerRoutingRouteVersion, WorkerRoutingScope, WorkerRoutingSettings, WorkerRoutingTier, WorkerTargetConfig, WorkerTargetReference, WorkerTargetSelection } from '../../shared/workerRouting';
import { parseNativeConfigIntent } from '../../shared/nativeSessionConfig';
import { isWorkerRoutingTierKind, normalizeWorkerRoutingTierKinds, workerRoutingTierKindRank, WORKER_ROUTING_LIMITS, WORKER_ROUTING_SETTINGS_LOCATION } from '../../shared/workerRouting';
import { assertSessionTargetCurrent, legacySessionSourceRoot, resolveSessionTarget, type SessionTarget, type SessionTargetInput } from '../sessions/targets';
import { currentAgentSessionId, currentAgentWorkspaceId, isSchedulerInvocation } from '../agent/agentScope';
import { optionObject, optionText, readTargetConfig, readWorkerNativeCatalog, validateWorkerConfig, WorkerOptionError } from './workerRoutingCatalog';
import { cooldownFor, publishWorkerRoutingChanged, resetWorkerCooldown } from './workerRoutingPolicy';
import { serializeWorkerModelMentions, workerModelMentions } from '../../shared/workerModelMention';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';

type ParsedWorkerRoutingConfig = Omit<WorkerRoutingConfig, 'tiers'> & { tiers: ReturnType<typeof normalizeWorkerRoutingTierKinds> };
type WorkerRoutingStorage = Pick<AppConfig, 'workerRoutingDefault' | 'workerRoutingByWorkspace' | 'workerRoutingWorkspaceRevisions'>;
type WorkerRoutingView = Omit<WorkerRoutingSettings, 'members' | 'config'> & { config: ParsedWorkerRoutingConfig };
const EMPTY: ParsedWorkerRoutingConfig = { revision: 0, tiers: [] };
const REFERENCE_COUNT = 2048;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const permissionBindingPattern = /^wp1\.([0-9a-f]{64})\.([0-9a-f]{64})$/;

function readCrossHarnessConsent(raw: unknown): WorkerCrossHarnessConsent | undefined {
  if (raw === undefined) return undefined;
  if (!optionObject(raw) || (raw.binding !== undefined && (typeof raw.binding !== 'string' || !permissionBindingPattern.test(raw.binding)))) {
    throw new WorkerOptionError('Invalid Worker candidate permission approval. Choose the native settings again.');
  }
  const nativeConfig = parseNativeConfigIntent(raw.nativeConfig);
  if (!nativeConfig) throw new WorkerOptionError('Choose explicit native permissions before approving Worker handoff.');
  return { nativeConfig, ...(raw.binding ? { binding: raw.binding as string } : {}) };
}

function readWorkspaceOverride(config: WorkerRoutingStorage, workspaceId: string): ParsedWorkerRoutingConfig | undefined {
  const entries = config.workerRoutingByWorkspace;
  return entries && Object.hasOwn(entries, workspaceId) ? parseWorkerRoutingConfig(entries[workspaceId]) : undefined;
}

function readGlobalDefault(config: WorkerRoutingStorage): ParsedWorkerRoutingConfig {
  if (config.workerRoutingDefault === undefined) return structuredClone(EMPTY);
  const routing = parseWorkerRoutingConfig(config.workerRoutingDefault);
  // Disk or an older client cannot turn a reusable model choice into a source approval.
  for (const tier of routing.tiers) for (const member of tier.members) delete member.crossHarness;
  return routing;
}

function workspaceGeneration(config: WorkerRoutingStorage, workspaceId: string, override?: ParsedWorkerRoutingConfig): number {
  const revisions = config.workerRoutingWorkspaceRevisions;
  const stored = revisions && Object.hasOwn(revisions, workspaceId) ? revisions[workspaceId] : undefined;
  return Math.max(override?.revision ?? 0, typeof stored === 'number' && Number.isSafeInteger(stored) ? stored : 0);
}

function resolveWorkerRouting(config: WorkerRoutingStorage, workspaceId: string) {
  const override = readWorkspaceOverride(config, workspaceId);
  const effective = override ?? readGlobalDefault(config);
  const version: WorkerRoutingRouteVersion = { origin: override ? 'workspace' : 'global', revision: effective.revision,
    workspaceRevision: workspaceGeneration(config, workspaceId, override) };
  return { config: effective, version };
}

export function readWorkerRoutingConfig(config: WorkerRoutingStorage, workspaceId: string): ParsedWorkerRoutingConfig {
  return resolveWorkerRouting(config, workspaceId).config;
}

export function parseWorkerRoutingConfig(input: unknown, previousTiers: readonly WorkerRoutingTier[] = []): ParsedWorkerRoutingConfig {
  if (!optionObject(input) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || !Array.isArray(input.tiers) || input.tiers.length > WORKER_ROUTING_LIMITS.tiers) {
    throw new WorkerOptionError('Invalid Worker tiers or revision. Reload the routing settings.');
  }
  const ids = new Set<string>();
  const members = new Set<string>();
  const rawTiers: WorkerRoutingTier[] = input.tiers.map(tier => {
    if (!optionObject(tier) || !validId(tier.id) || ids.has(tier.id) || !optionText(tier.name, WORKER_ROUTING_LIMITS.tierName) || typeof tier.description !== 'string' || tier.description.length > WORKER_ROUTING_LIMITS.tierDescription ||
      !Array.isArray(tier.members) || tier.members.length > WORKER_ROUTING_LIMITS.membersPerTier || !Array.isArray(tier.fallbackTierIds) || tier.fallbackTierIds.length >= WORKER_ROUTING_LIMITS.tiers ||
      !tier.fallbackTierIds.every(validId) || new Set(tier.fallbackTierIds).size !== tier.fallbackTierIds.length) throw new WorkerOptionError('Invalid Worker tier.');
    const kind = tier.kind;
    if (kind !== undefined && !isWorkerRoutingTierKind(kind)) throw new WorkerOptionError('Invalid Worker tier classification.');
    ids.add(tier.id);
    return { id: tier.id, name: tier.name, ...(kind !== undefined ? { kind } : {}), description: tier.description.trim(), fallbackTierIds: [...tier.fallbackTierIds] as string[], members: tier.members.map(member => {
      if (!optionObject(member) || !validId(member.id) || members.has(member.id) || typeof member.enabled !== 'boolean') throw new WorkerOptionError('Invalid or duplicate Worker pool member.');
      members.add(member.id);
      const crossHarness = readCrossHarnessConsent(member.crossHarness);
      return { id: member.id, enabled: member.enabled, config: readTargetConfig(member.config), ...(crossHarness ? { crossHarness } : {}) };
    }) };
  });
  const tiers = normalizeWorkerRoutingTierKinds(rawTiers, previousTiers);
  const standardKinds = tiers.filter(tier => tier.kind !== 'special').map(tier => tier.kind);
  if (new Set(standardKinds).size !== standardKinds.length) throw new WorkerOptionError('Each standard Worker tier can only have one pool.');
  const tierMap = new Map(tiers.map(tier => [tier.id, tier]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const tier = tierMap.get(id);
    if (!tier) throw new WorkerOptionError('A fallback tier was deleted. Remove its route before saving.');
    if (visiting.has(id)) throw new WorkerOptionError('Worker fallback tiers cannot form a cycle.');
    visiting.add(id);
    for (const next of tier.fallbackTierIds) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const tier of tiers) visit(tier.id);
  return { revision: Number(input.revision), tiers };
}

export function summarizeWorkerRoutingTiers(config: WorkerRoutingStorage, workspaceId: string) {
  const tiers = readWorkerRoutingConfig(config, workspaceId).tiers.sort((a, b) => workerRoutingTierKindRank(a.kind) - workerRoutingTierKindRank(b.kind));
  return tiers.map(tier => ({ tierId: tier.id, name: tier.name, kind: tier.kind, description: tier.description,
    enabledCandidates: tier.members.filter(member => member.enabled).length }));
}

export function parseWorkerTargetSelection(input: unknown): WorkerTargetSelection {
  if (!optionObject(input) || Object.keys(input).length !== 1) throw new WorkerOptionError('Worker target must contain exactly one of tierId or targetRef.');
  if (validId(input.tierId)) return { tierId: input.tierId };
  if (typeof input.targetRef === 'string' && /^wr1\.[A-Za-z0-9_-]{32}$/.test(input.targetRef)) return { targetRef: input.targetRef };
  throw new WorkerOptionError('Invalid Worker target. Choose a tier or select the model again.');
}

const scopeFor = (target: SessionTarget): WorkerRoutingScope => ({ workspaceId: target.workspaceId, rootId: target.sourceRoot.rootId,
  rootsRevision: target.rootsRevision, cwd: target.sourceRoot.cwd });

function crossHarnessBinding(target: SessionTarget, memberId: string, fingerprint: string,
  nativeConfig: WorkerCrossHarnessConsent['nativeConfig'], snapshot: string): string {
  const input = [scopeFor(target), target.sourceKey, target.controlKey, memberId, fingerprint, nativeConfig, snapshot];
  return `wp1.${createHash('sha256').update(JSON.stringify(input)).digest('hex')}.${snapshot}`;
}

export function workerCrossHarnessSnapshot(target: SessionTarget, candidate: WorkerRouteCandidate, fingerprint: string): string | undefined {
  const consent = candidate.crossHarness;
  if (candidate.config.runtimeId !== 'codex-gui' || candidate.config.surface !== 'gui' || !candidate.memberId || !consent?.binding) return undefined;
  const snapshot = workerCrossHarnessDigest(consent);
  return snapshot && consent.binding === crossHarnessBinding(target, candidate.memberId, fingerprint, consent.nativeConfig, snapshot) ? snapshot : undefined;
}

function workerCrossHarnessDigest(consent: WorkerCrossHarnessConsent): string | undefined {
  return consent.binding ? permissionBindingPattern.exec(consent.binding)?.[2] : undefined;
}

export function assertWorkerSourceCurrent(ctx: AppContext, target: SessionTarget): void {
  const config = ctx.config.get();
  assertSessionTargetCurrent(config, target);
  if ((config.workspaces.find(workspace => workspace.id === target.workspaceId)?.rootsRevision ?? 0) !== target.rootsRevision) {
    throw new WorkerOptionError('Worker source folders changed. Select the tier or model again.');
  }
}

interface ReferencePayload { scope: WorkerRoutingScope; sourceKey: string; controlKey: string; config: WorkerTargetConfig; fingerprint: string }
const referenceFile = (): string => userDataStorage(app.getPath('userData')).manifestPath('worker-target-references');

function readReferenceRecords(): Array<[string, ReferencePayload]> {
  try {
    const raw = JSON.parse(fs.readFileSync(referenceFile(), 'utf8')) as { version?: unknown; entries?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.entries) || raw.entries.length > REFERENCE_COUNT) throw new Error('Invalid Worker reference store');
    return raw.entries as Array<[string, ReferencePayload]>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new WorkerOptionError('Worker model references cannot be read. Check application storage before reselecting.');
  }
}

const referenceId = (payload: ReferencePayload): string => `wr1.${createHash('sha256').update(JSON.stringify(payload)).digest().subarray(0, 24).toString('base64url')}`;

export function decodeWorkerReference(targetRef: string): ReferencePayload {
  parseWorkerTargetSelection({ targetRef });
  const record = readReferenceRecords().find(([id]) => id === targetRef)?.[1];
  if (!record || referenceId(record) !== targetRef) throw new WorkerOptionError('Worker model reference is expired or belongs to another installation. Select the model again.');
  return record;
}

function assertReferenceSource(target: SessionTarget, reference: ReferencePayload): void {
  if (JSON.stringify(scopeFor(target)) !== JSON.stringify(reference.scope) || target.sourceKey !== reference.sourceKey || target.controlKey !== reference.controlKey) {
    throw new WorkerOptionError('Worker model reference is for a different or outdated source. Select the model again.');
  }
}

export async function mintWorkerReference(ctx: AppContext, target: SessionTarget, config: unknown, native?: Awaited<ReturnType<typeof import('./workerRoutingCatalog').readWorkerNativeCatalog>>): Promise<WorkerTargetReference> {
  const requested = readTargetConfig(config);
  const catalog = native ?? await readWorkerNativeCatalog(ctx, requested, target);
  if (requested.surface === 'gui' ? !requested.model : !requested.cliLaunchOptions?.model) {
    const row = catalog.defaultRow;
    if (!row) throw new WorkerOptionError('The native default model is unknown. Refresh this Harness and choose an explicit model.', 'unknown');
    if (requested.surface === 'gui') requested.model = { providerId: row.providerId, modelId: row.modelId };
    else requested.cliLaunchOptions = { ...requested.cliLaunchOptions, model: row.nativeModelId ?? row.modelId };
  }
  const validated = await validateWorkerConfig(ctx, target, requested, false, catalog);
  assertWorkerSourceCurrent(ctx, target);
  const payload: ReferencePayload = { scope: scopeFor(target), sourceKey: target.sourceKey, controlKey: target.controlKey,
    config: validated.config, fingerprint: validated.fingerprint };
  const targetRef = referenceId(payload);
  const records = readReferenceRecords();
  if (!records.some(([id]) => id === targetRef)) {
    writeJsonAtomicSync(referenceFile(), { version: 1, entries: [...records.slice(1 - REFERENCE_COUNT), [targetRef, payload]] }, 0);
  }
  return { targetRef, config: validated.config };
}

export async function validateWorkerReference(ctx: AppContext, target: SessionTarget, targetRef: string): Promise<WorkerTargetReference> {
  const payload = decodeWorkerReference(targetRef);
  assertReferenceSource(target, payload);
  const current = await validateWorkerConfig(ctx, target, payload.config, true);
  assertWorkerSourceCurrent(ctx, target);
  if (current.fingerprint !== payload.fingerprint) throw new WorkerOptionError('Worker model configuration changed. Select the model again.');
  return { targetRef, config: current.config };
}

function settingsView(storage: WorkerRoutingStorage, workspaceId: string, layer: WorkerRoutingLayer): WorkerRoutingView {
  if (layer === 'global') {
    const config = readGlobalDefault(storage);
    return { layer, origin: 'global', version: JSON.stringify([layer, config.revision]), config };
  }
  const { config, version } = resolveWorkerRouting(storage, workspaceId);
  return { layer, origin: version.origin, version: JSON.stringify([layer, workspaceId, version.origin, version.revision, version.workspaceRevision]), config };
}

function staleSettings(): WorkerOptionError {
  return new WorkerOptionError('Worker routing settings changed. Reload before saving.');
}

function assertSettingsCurrent(ctx: AppContext, target: SessionTarget, layer: WorkerRoutingLayer, version: unknown): void {
  assertWorkerSourceCurrent(ctx, target);
  if (settingsView(ctx.config.get(), target.workspaceId, layer).version !== version) throw staleSettings();
}

async function routingMembers(ctx: AppContext, target: SessionTarget, config: WorkerRoutingConfig): Promise<WorkerRoutingMemberStatus[]> {
  return Promise.all(config.tiers.flatMap(tier => tier.members).map(async (member): Promise<WorkerRoutingMemberStatus> => {
    if (!member.enabled) return { id: member.id, state: 'disabled' };
    const cooldown = cooldownFor(ctx, target, member.config);
    if (cooldown) return { id: member.id, state: 'cooldown', ...cooldown };
    try {
      const checked = await validateWorkerConfig(ctx, target, member.config, true);
      return { id: member.id, state: checked.catalogState === 'ready' ? 'available' : 'unknown' };
    } catch (error) {
      return { id: member.id, state: error instanceof WorkerOptionError && error.availability === 'unknown' ? 'unknown' : 'invalid',
        reason: error instanceof WorkerOptionError ? error.message : 'Worker configuration is unavailable.' };
    }
  }));
}

export async function routingSettings(ctx: AppContext, target: SessionTarget, layer: WorkerRoutingLayer): Promise<WorkerRoutingSettings> {
  const view = settingsView(ctx.config.get(), target.workspaceId, layer);
  const members = await routingMembers(ctx, target, view.config);
  assertSettingsCurrent(ctx, target, layer, view.version);
  return { ...view, members };
}

async function committedRoutingSettings(ctx: AppContext, target: SessionTarget, view: WorkerRoutingView): Promise<WorkerRoutingSettings> {
  try {
    const members = await routingMembers(ctx, target, view.config);
    assertSettingsCurrent(ctx, target, view.layer, view.version);
    return { ...view, members };
  } catch {
    // The write is already durable. Return its exact version even if the next
    // edit or a source change made the optional readiness projection stale.
    const members = view.config.tiers.flatMap(tier => tier.members).map((member): WorkerRoutingMemberStatus =>
      ({ id: member.id, state: member.enabled ? 'unknown' : 'disabled' }));
    return { ...view, members };
  }
}

function nextRoutingRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new WorkerOptionError('Worker routing revision is exhausted. Check the application configuration.');
  return revision + 1;
}

export async function saveWorkerRoutingSettings(ctx: AppContext, target: SessionTarget,
  input: { layer: WorkerRoutingLayer; expectedVersion: unknown; config: unknown }): Promise<WorkerRoutingSettings> {
  const { layer, expectedVersion } = input;
  const previous = settingsView(ctx.config.get(), target.workspaceId, layer);
  if (previous.version !== expectedVersion) throw staleSettings();
  assertWorkerSourceCurrent(ctx, target);
  const config = parseWorkerRoutingConfig(input.config, previous.config.tiers);
  if (previous.config.revision !== config.revision) throw staleSettings();
  const members = config.tiers.flatMap(tier => tier.members);
  if (layer === 'global' && members.some(member => member.crossHarness)) {
    throw new WorkerOptionError('Cross-Harness permission approval is available only in workspace routing settings.');
  }
  const previousMembers = new Map(previous.config.tiers.flatMap(tier => tier.members).map(member => [member.id, member]));
  for (const member of members) {
    const existing = previousMembers.get(member.id);
    const unchanged = !!existing && JSON.stringify(existing.config) === JSON.stringify(member.config);
    const pendingConsent = member.crossHarness && !member.crossHarness.binding ? member.crossHarness : undefined;
    if (member.crossHarness?.binding && (!unchanged || JSON.stringify(member.crossHarness) !== JSON.stringify(existing?.crossHarness))) {
      throw new WorkerOptionError('The Worker candidate or its permissions changed. Confirm its native permissions again.');
    }
    if (!unchanged || (member.enabled && !existing?.enabled) || pendingConsent) {
      const model = member.config.surface === 'gui' ? member.config.model?.modelId : member.config.cliLaunchOptions?.model;
      if (!model) throw new WorkerOptionError('Choose a concrete model from the Harness catalog before saving the pool member.');
      const validated = await validateWorkerConfig(ctx, target, member.config, true);
      member.config = validated.config;
      if (pendingConsent) {
        if (member.config.surface !== 'gui' || member.config.runtimeId !== 'codex-gui' || !ctx.agentSessions) {
          throw new WorkerOptionError('This Harness cannot verify its native permissions for a running Worker handoff.');
        }
        const nativeConfig = pendingConsent.nativeConfig;
        const snapshot = await ctx.agentSessions.captureWorkerPermission({ runtime: member.config.runtimeId, cwd: target.sourceRoot.cwd,
          workspaceId: target.workspaceId, sourceRoot: target.sourceRoot }, nativeConfig);
        if (!/^[0-9a-f]{64}$/.test(snapshot)) throw new WorkerOptionError('The Harness did not confirm a native permission snapshot.');
        member.crossHarness = { nativeConfig, binding: crossHarnessBinding(target, member.id, validated.fingerprint, nativeConfig, snapshot) };
      }
    }
  }
  assertSettingsCurrent(ctx, target, layer, expectedVersion);
  const latest = ctx.config.get();
  const workspaceId = target.workspaceId;
  let patch: WorkerRoutingStorage;
  if (layer === 'global') {
    config.revision = nextRoutingRevision(config.revision);
    patch = { workerRoutingDefault: config };
  } else {
    config.revision = nextRoutingRevision(workspaceGeneration(latest, workspaceId, readWorkspaceOverride(latest, workspaceId)));
    patch = { workerRoutingByWorkspace: { ...latest.workerRoutingByWorkspace, [workspaceId]: config },
      workerRoutingWorkspaceRevisions: { ...latest.workerRoutingWorkspaceRevisions, [workspaceId]: config.revision } };
  }
  const view = settingsView({ ...latest, ...patch }, workspaceId, layer);
  ctx.config.updateWorkerRouting(patch);
  publishWorkerRoutingChanged(ctx, layer === 'global' ? { kind: 'global' } : { kind: 'workspace', workspaceId });
  return committedRoutingSettings(ctx, target, view);
}

export async function followGlobalWorkerRouting(ctx: AppContext, target: SessionTarget, expectedVersion: unknown): Promise<WorkerRoutingSettings> {
  assertSettingsCurrent(ctx, target, 'workspace', expectedVersion);
  const latest = ctx.config.get();
  const workspaceId = target.workspaceId;
  const override = readWorkspaceOverride(latest, workspaceId);
  if (!override) return routingSettings(ctx, target, 'workspace');
  const overrides = { ...latest.workerRoutingByWorkspace };
  delete overrides[workspaceId];
  const generation = nextRoutingRevision(workspaceGeneration(latest, workspaceId, override));
  const patch = { workerRoutingByWorkspace: overrides,
    workerRoutingWorkspaceRevisions: { ...latest.workerRoutingWorkspaceRevisions, [workspaceId]: generation } };
  const view = settingsView({ ...latest, ...patch }, workspaceId, 'workspace');
  ctx.config.updateWorkerRouting(patch);
  publishWorkerRoutingChanged(ctx, { kind: 'workspace', workspaceId });
  return committedRoutingSettings(ctx, target, view);
}

export function clearRoutingCooldown(ctx: AppContext, target: SessionTarget, layer: WorkerRoutingLayer, expectedVersion: unknown, memberId: unknown): Promise<WorkerRoutingSettings> {
  assertSettingsCurrent(ctx, target, layer, expectedVersion);
  const view = settingsView(ctx.config.get(), target.workspaceId, layer);
  const member = view.config.tiers.flatMap(tier => tier.members).find(member => member.id === memberId);
  if (!member) throw new WorkerOptionError('Worker pool member no longer exists.');
  resetWorkerCooldown(ctx, target, member.config);
  return committedRoutingSettings(ctx, target, view);
}

/** Model source is captured from the authenticated bridge. Scheduler tools may select a registered root of their own workspace. */
export function workerToolSource(ctx: AppContext, input: SessionTargetInput): SessionTargetInput & { workspaceId: string } {
  const callerId = currentAgentSessionId();
  const caller = callerId ? ctx.sessions.get(callerId) : undefined;
  const workspaceId = caller?.workspaceId ?? currentAgentWorkspaceId() ?? ctx.resolveBubbleWorkspaceId();
  if (callerId && (!caller || caller.archived || !caller.workspaceId)) throw new WorkerOptionError('Worker tool caller no longer exists.');
  if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) throw new WorkerOptionError('Worker model choices are scoped to the current workspace.');
  const callerSource = caller && legacySessionSourceRoot(ctx.config.get(), caller);
  if (callerSource) {
    if ((input.rootId !== undefined && input.rootId !== callerSource.rootId) ||
        (input.cwd !== undefined && input.cwd !== callerSource.cwd)) throw new WorkerOptionError('Worker model choices are scoped to the caller’s source folder.');
    return { workspaceId, rootId: callerSource.rootId, cwd: callerSource.cwd, rootsRevision: input.rootsRevision, capturedSource: callerSource };
  }
  if (isSchedulerInvocation() && input.rootId === undefined && input.cwd === undefined) {
    const scope = ctx.orchestrator?.getWorkspacePromptScope?.(workspaceId).workspaceContext;
    if (scope) return { workspaceId, rootId: scope.sourceRootId, cwd: scope.cwd, rootsRevision: input.rootsRevision ?? scope.rootsRevision };
  }
  return { workspaceId, rootId: input.rootId, cwd: input.cwd, rootsRevision: input.rootsRevision };
}

export function workerReferenceSource(ctx: AppContext, input: SessionTargetInput, selection: WorkerTargetSelection): SessionTargetInput {
  if ('tierId' in selection) return workerToolSource(ctx, input);
  const { scope } = decodeWorkerReference(selection.targetRef);
  if ((input.workspaceId !== undefined && input.workspaceId !== scope.workspaceId) || (input.rootId !== undefined && input.rootId !== scope.rootId) ||
      (input.rootsRevision !== undefined && input.rootsRevision !== scope.rootsRevision) || (input.cwd !== undefined && input.cwd !== scope.cwd)) {
    throw new WorkerOptionError('Worker model reference does not match the requested source. Select it again.');
  }
  return workerToolSource(ctx, scope);
}

export async function captureWorkerRoute(ctx: AppContext, target: SessionTarget, requested: WorkerTargetSelection): Promise<WorkerRoutePlan> {
  const plan: WorkerRoutePlan = { requested, scope: scopeFor(target), sourceKey: target.sourceKey, controlKey: target.controlKey, candidates: [] };
  if ('targetRef' in requested) {
    plan.candidates.push({ config: (await validateWorkerReference(ctx, target, requested.targetRef)).config });
    return plan;
  }
  const { config, version } = resolveWorkerRouting(ctx.config.get(), target.workspaceId);
  plan.routingVersion = version;
  const tiers = new Map(config.tiers.map(tier => [tier.id, tier]));
  if (!tiers.has(requested.tierId)) throw new WorkerOptionError(`Worker tier is not configured. Choose an existing tier or open ${WORKER_ROUTING_SETTINGS_LOCATION}.`);
  plan.requestedTierName = tiers.get(requested.tierId)!.name;
  const visited = new Set<string>();
  const visit = (tierId: string): void => {
    if (visited.has(tierId)) return;
    visited.add(tierId);
    const tier = tiers.get(tierId)!;
    for (const member of tier.members.filter(member => member.enabled)) plan.candidates.push({ tierId, tierName: tier.name, memberId: member.id, config: member.config,
      ...(member.crossHarness?.binding ? { crossHarness: member.crossHarness } : {}) });
    for (const next of tier.fallbackTierIds) visit(next);
  };
  visit(requested.tierId);
  if (!plan.candidates.length) throw new WorkerOptionError(`This Worker route has no enabled candidates. Add or enable a model in ${WORKER_ROUTING_SETTINGS_LOCATION}.`);
  return plan;
}

export function assertWorkerRouteCurrent(ctx: AppContext, target: SessionTarget, plan: WorkerRoutePlan): void {
  assertWorkerSourceCurrent(ctx, target);
  if (JSON.stringify(scopeFor(target)) !== JSON.stringify(plan.scope) || target.sourceKey !== plan.sourceKey || target.controlKey !== plan.controlKey) {
    throw new WorkerOptionError('Worker route source changed. Create the task again with a current source.');
  }
  if (plan.routingVersion || plan.revision !== undefined) {
    const { version } = resolveWorkerRouting(ctx.config.get(), target.workspaceId);
    const expected = plan.routingVersion;
    const current = expected ? expected.origin === version.origin && expected.revision === version.revision &&
      expected.workspaceRevision === version.workspaceRevision : version.origin === 'workspace' && version.revision === plan.revision;
    if (!current) throw new WorkerOptionError('Worker tiers changed while this task was pending. Retry with the current tier settings.');
  }
}

export function workerRouteReceipt(state: WorkerRouteState): WorkerRouteReceipt {
  const current = state.attempts.at(-1);
  const lastFailure = state.attempts.slice().reverse().find(attempt => attempt.state === 'failed');
  const resolved: WorkerRouteCandidate | undefined = current && { tierId: current.tierId, tierName: current.tierName, memberId: current.memberId, config: current.config };
  return { requested: 'tierId' in state.plan.requested ? { tierId: state.plan.requested.tierId } : { exact: true },
    state: state.phase, ...(resolved ? { resolved } : {}), attempt: current?.attempt, reason: state.reason ?? current?.reason ?? lastFailure?.reason,
    nativeConfirmed: current?.nativeConfirmed };
}

/** Last-send validation for persisted/queued composer chips. Ordinary input does no catalog IO. */
export async function prepareWorkerModelMentions(ctx: AppContext, source: SessionTargetInput & { workspaceId: string }, text: string): Promise<string> {
  const mentions = workerModelMentions(text);
  if (!mentions.length) return text;
  if (mentions.length > WORKER_ROUTING_LIMITS.mentionsPerMessage) throw new WorkerOptionError(`A message can include at most ${WORKER_ROUTING_LIMITS.mentionsPerMessage} Worker model choices.`);
  const target = await resolveSessionTarget(ctx.config.get(), source);
  for (const targetRef of new Set(mentions.map(mention => mention.mention.targetRef))) await validateWorkerReference(ctx, target, targetRef);
  return serializeWorkerModelMentions(text);
}
