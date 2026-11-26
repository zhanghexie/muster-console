import {
  canonicalModelParameterOverrides,
  changeModelParameters,
  normalizeModelParameterDescriptors,
  normalizeModelParameterValues,
  parseModelParameterProfiles,
  resolveModelParameters,
  validateModelParameterProfile,
  type ModelParameterContext,
  type ModelParameterProfile,
  type ModelParameterSnapshot
} from '../../../shared/modelParameters';
import { getChatCapabilities, isChatRuntimeId } from '../../../shared/agentRuntimeCapabilities';
import { t } from '../../../shared/i18n';
import type { HostCore } from './internal';
import { getDriver, syncEntry, push } from './base';
import { resolveLlmConfig } from '../../config';
import { sessionModelSourceCwd } from '../harnessCatalogSource';
import { defaultAcpAgentId, getAcpPresets } from '../drivers/acp/agents';
import type { SessionMeta } from '../../../shared/types';
import type { GuiRuntimeDriver } from '../types';

export interface ParameterTarget {
  runtimeId: string;
  providerId?: string;
  modelId?: string;
  cwd?: string;
  piModeId?: string;
  refresh?: boolean;
}

type DriverParameterContext = Awaited<ReturnType<NonNullable<GuiRuntimeDriver['describeModelParameters']>>>;
export type TurnModelParameterSnapshot = ModelParameterSnapshot & Pick<DriverParameterContext, 'coreReasoning'>;

// A new isolated worktree may not have a catalog yet. Preserve the already
// validated source-directory parameter metadata without probing another engine.
const launchContexts = new WeakMap<HostCore, Map<string, { identity: string; driver: ReturnType<typeof getDriver>; version?: string; context: ModelParameterContext }>>();
const validatedContexts = new WeakMap<ModelParameterContext, { driver: ReturnType<typeof getDriver>; version?: string }>();
const sessionParameterIdentity = (session: import('../../../shared/types').SessionMeta): string =>
  JSON.stringify([session.runtime, session.cwd, session.modelOverride, session.piModeId]);

export function rememberLaunchParameterContext(host: HostCore, session: import('../../../shared/types').SessionMeta, context: ModelParameterContext): void {
  const original = validatedContexts.get(context);
  const driver = getDriver(host, session.runtime ?? '');
  if (!original || original.driver !== driver || original.version !== driver?.connectionVersion) return;
  let entries = launchContexts.get(host);
  if (!entries) { entries = new Map(); launchContexts.set(host, entries); }
  if (entries.size >= 128 && !entries.has(session.id)) entries.delete(entries.keys().next().value!);
  entries.set(session.id, { identity: sessionParameterIdentity(session), driver, version: driver?.connectionVersion, context: structuredClone(context) });
}

export async function describeParameters(host: HostCore, target: ParameterTarget, session?: import('../../../shared/types').SessionMeta): Promise<DriverParameterContext> {
  const driver = getDriver(host, target.runtimeId);
  const config = host.ctx.config.get();
  const preset = session?.piModeId ?? target.piModeId;
  const acpProvider = target.runtimeId === 'acp' ? `acp:${defaultAcpAgentId(preset ?? (target.providerId?.startsWith('acp:') ? target.providerId.slice(4) : undefined), getAcpPresets(host.semanticRoot))}` : undefined;
  const modeModel = target.runtimeId === 'pi' && preset ? driver?.resolveMode?.(preset)?.connectExtras.modelOverride as SessionMeta['modelOverride'] : undefined;
  const coreDefault = target.runtimeId === 'pi' && !session?.modelOverride && !target.modelId
    ? resolveLlmConfig(config, modeModel) : undefined;
  const fallback: ModelParameterContext = {
    runtimeId: target.runtimeId, providerId: acpProvider ?? session?.modelOverride?.providerId ?? target.providerId ?? coreDefault?.provider.id ?? target.runtimeId,
    modelId: session?.modelOverride?.modelId ?? target.modelId ?? coreDefault?.model.id ?? '',
    parameters: normalizeModelParameterDescriptors(getChatCapabilities(target.runtimeId).modelParameters)
  };
  if (!isChatRuntimeId(target.runtimeId) || !driver) return { ...fallback, parameters: [], unavailable: true, warning: t('运行时不可用') };
  if (!driver.describeModelParameters) return fallback;
  try {
    // Saved ACP profiles identify their preset through the provider namespace.
    // Validation must use that same preset, rather than the transport's default.
    const scopedAgent = target.runtimeId === 'acp' && target.providerId?.startsWith('acp:') ? target.providerId.slice(4) : undefined;
    const explicitAgent = preset;
    if (scopedAgent !== undefined && (!scopedAgent || (explicitAgent && scopedAgent !== explicitAgent))) throw new Error(t('ACP 参数范围与目标 Agent 不一致'));
    const source = session && sessionModelSourceCwd(config, session);
    if (!target.cwd && session && !source && (session.worktreePath || session.worktreeSource || session.worktreeGroups)) throw new Error('会话缺少可确认的模型目录来源。');
    const context = await driver.describeModelParameters({
      cwd: target.cwd ?? source ?? session?.cwd ?? config.workspace,
      modelOverride: session?.modelOverride ?? (target.modelId || target.providerId ? { providerId: target.providerId, modelId: target.modelId } : undefined),
      piModeId: explicitAgent ?? scopedAgent,
      refresh: target.refresh === true,
      legacyThinkingLevel: session?.modelParameters === undefined ? session?.thinkingLevel : undefined,
      legacyParameters: session?.modelParameters === undefined
    });
    return { ...context, runtimeId: target.runtimeId, parameters: normalizeModelParameterDescriptors(context.parameters) };
  } catch (e) {
    return { ...fallback, unavailable: true, warning: (e as Error).message };
  }
}

/** Capture configuration before discovery awaits; a mid-connect edit cannot change this turn. */
async function captureParameterSnapshot(host: HostCore, sessionId: string, admitted?: import('../modelAdmissionPolicy').AdmissionModel) {
  const original = host.ctx.sessions.get(sessionId);
  if (!original) throw new Error(t('会话不可用'));
  const session = structuredClone(original);
  const runtimeId = session.runtime ?? '';
  if (!admitted && host.modelAdmission.hasSelection(runtimeId, session.piModeId)) {
    const driver = getDriver(host, runtimeId);
    const mode = runtimeId === 'pi' && session.piModeId ? driver?.resolveMode?.(session.piModeId) : null;
    const modeModel = mode?.connectExtras.modelOverride as typeof session.modelOverride;
    const llm = runtimeId === 'pi' ? resolveLlmConfig(host.ctx.config.get(), modeModel) : undefined;
    const localDefault = llm ? { providerId: llm.provider.id, modelId: llm.model.id } : undefined;
    admitted = await host.modelAdmission.resolve(runtimeId, sessionModelSourceCwd(host.ctx.config.get(), session) ?? session.cwd ?? host.ctx.config.get().workspace, session.piModeId,
      session.modelOverride ?? (modeModel ? localDefault : undefined), localDefault);
  }
  if (admitted) session.modelOverride = admitted;
  const profiles = structuredClone(host.ctx.config.get().modelParameterProfiles ?? []);
  let context = await describeParameters(host, { runtimeId: session.runtime ?? '' }, session);
  const seed = launchContexts.get(host)?.get(sessionId);
  const driver = getDriver(host, session.runtime ?? '');
  if (context.unavailable && seed && seed.identity === sessionParameterIdentity(session) && seed.driver === driver && seed.version === driver?.connectionVersion) {
    context = structuredClone(seed.context);
  }
  const snapshot = resolveModelParameters(context, profiles, normalizeModelParameterValues(session.modelParameters));
  return { context, profiles, snapshot: context.coreReasoning ? { ...snapshot, coreReasoning: context.coreReasoning } : snapshot };
}

export async function parameterSnapshot(host: HostCore, sessionId: string, admitted?: import('../modelAdmissionPolicy').AdmissionModel): Promise<TurnModelParameterSnapshot> {
  return (await captureParameterSnapshot(host, sessionId, admitted)).snapshot;
}

const mutations = new WeakMap<HostCore, Map<string, Promise<unknown>>>();
export function setModelParameters(host: HostCore, sessionId: string, changes: unknown) {
  let pending = mutations.get(host);
  if (!pending) { pending = new Map(); mutations.set(host, pending); }
  const previous = pending.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => applyModelParameters(host, sessionId, changes));
  pending.set(sessionId, run);
  void run.finally(() => { if (pending!.get(sessionId) === run) pending!.delete(sessionId); });
  return run;
}

/** discovery 不可用（CLI 未装/驱动异常）与「配置非法」不同类：归类文案区分，原始原因内嵌保留。 */
function discoveryUnavailableError(warning?: string): string {
  return warning
    ? t('参数发现服务不可用（{{warning}}），请稍后重试', { warning })
    : t('参数发现服务不可用，请稍后重试');
}

async function applyModelParameters(host: HostCore, sessionId: string, changes: unknown) {
  try {
    const identity = () => {
      const s = host.ctx.sessions.get(sessionId);
      return JSON.stringify([s?.runtime, s?.modelOverride, s?.piModeId, s?.modelParameters, s?.thinkingLevel, host.ctx.config.get().modelParameterProfiles]);
    };
    const before = identity();
    const snapshot = await parameterSnapshot(host, sessionId);
    // Discovery may have awaited a model switch; never validate against the old model.
    const { context, profiles, snapshot: current } = await captureParameterSnapshot(host, sessionId);
    const session = host.ctx.sessions.get(sessionId);
    if (!session) return { ok: false, error: t('会话不可用') };
    if (before !== identity()) return { ok: false, error: t('模型参数已变化，请刷新后重试') };
    if (current.unavailable) return { ok: false, error: discoveryUnavailableError(current.warning) };
    if (JSON.stringify([snapshot.providerId, snapshot.modelId, snapshot.parameters]) !== JSON.stringify([current.providerId, current.modelId, current.parameters])) return { ok: false, error: t('模型参数已变化，请刷新后重试') };
    const inherited = Object.fromEntries(current.controls.filter(c => c.override !== null).map(c => [c.descriptor.id, c.override! ]));
    const values = changeModelParameters(current, session.modelParameters ?? inherited, changes);
    // Reuse the native context that was validated. No discovery can fail after commit.
    const updated = resolveModelParameters({ ...context, legacyValues: undefined }, profiles, values);
    host.ctx.sessions.updateModelParameters(sessionId, values);
    // params was the legacy parameter transport, independent of the new generic state.
    if (session.modelOverride?.params) {
      const { params: _legacy, ...model } = session.modelOverride;
      host.ctx.sessions.updateModelOverride(sessionId, model);
    }
    const entry = host.entries.get(sessionId);
    if (entry) { entry.thinkingLevel = null; syncEntry(host, entry); }
    push(host, { kind: 'parameters', sessionId, controls: updated.controls, warning: updated.warning, providerId: updated.providerId, modelId: updated.modelId });
    return { ok: true, applied: entry?.busy ? 'next-turn' as const : 'immediate' as const, snapshot: updated };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Called after a model switch; explicit incompatible overrides are cleared with feedback. */
export async function reconcileModelParameters(host: HostCore, sessionId: string) {
  const original = host.ctx.sessions.get(sessionId);
  const identity = JSON.stringify([original?.runtime, original?.modelOverride, original?.modelParameters]);
  const snapshot = await parameterSnapshot(host, sessionId);
  const session = host.ctx.sessions.get(sessionId);
  if (!session?.modelParameters || snapshot.unavailable || identity !== JSON.stringify([session.runtime, session.modelOverride, session.modelParameters])) return snapshot;
  const values = Object.fromEntries(Object.entries(session.modelParameters).filter(([id, value]) => snapshot.controls.some(c => c.descriptor.id === id && c.descriptor.options.some(o => o.value === value))));
  if (Object.keys(values).length !== Object.keys(session.modelParameters).length) host.ctx.sessions.updateModelParameters(sessionId, values);
  return snapshot;
}

/** Read-only validation also serves mixed config patches, which must commit once. */
export async function validateParameterProfiles(host: HostCore, raw: unknown): Promise<ModelParameterProfile[]> {
  const profiles = parseModelParameterProfiles(raw);
  const existing = host.ctx.config.get().modelParameterProfiles ?? [];
  for (const profile of profiles) {
    if (existing.some(p => JSON.stringify(p) === JSON.stringify(profile))) continue;
    const context = await describeParameters(host, profile);
    if (context.unavailable) throw new Error(discoveryUnavailableError(context.warning));
    const rank = (p: ModelParameterProfile) => Number(!!p.modelId) * 2 + Number(!!p.providerId);
    const error = validateModelParameterProfile(context, profile, profiles.filter(p => p !== profile && rank(p) < rank(profile)));
    if (error) throw new Error(error);
  }
  return profiles;
}

/** Failed UI refreshes do not turn a committed configuration write into a failure. */
export async function refreshModelParameters(host: HostCore): Promise<void> {
  const updates = await Promise.allSettled([...host.entries.keys()].map(async sessionId => {
    const snapshot = await parameterSnapshot(host, sessionId);
    push(host, { kind: 'parameters', sessionId, controls: snapshot.controls, warning: snapshot.warning, providerId: snapshot.providerId, modelId: snapshot.modelId });
  }));
  for (const update of updates) if (update.status === 'rejected') console.warn('[model-parameters] refresh failed:', update.reason);
}

export async function saveParameterProfiles(host: HostCore, raw: unknown): Promise<{ ok: boolean; error?: string; profiles?: ModelParameterProfile[] }> {
  try {
    const profiles = await validateParameterProfiles(host, raw);
    host.ctx.config.update({ modelParameterProfiles: profiles });
    await refreshModelParameters(host);
    return { ok: true, profiles };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}


/** Validate requested launch controls before allocating a session or worktree. */
export async function validateLaunchParameters(host: HostCore, target: ParameterTarget, meta: import('../../../shared/types').GuiSessionInitialMeta): Promise<ModelParameterContext | undefined> {
  const hasProfiles = (host.ctx.config.get().modelParameterProfiles ?? []).some(profile =>
    profile.runtimeId === target.runtimeId && Object.keys(profile.parameters).length > 0);
  if (!meta.thinkingLevel && !Object.keys(meta.modelParameters ?? {}).length && !hasProfiles) return undefined;
  const driver = getDriver(host, target.runtimeId);
  const version = driver?.connectionVersion;
  const context = await describeParameters(host, target);
  if (getDriver(host, target.runtimeId) !== driver || driver?.connectionVersion !== version) throw new Error(t('引擎配置在模型参数校验期间变化，请重试'));
  if (context.unavailable) throw new Error(discoveryUnavailableError(context.warning));
  canonicalModelParameterOverrides(context, host.ctx.config.get().modelParameterProfiles ?? [], meta.modelParameters ?? {});
  if (meta.thinkingLevel) {
    const reasoning = context.parameters.find(parameter => parameter.semantic === 'reasoning');
    if (!reasoning?.options.some(option => option.value === meta.thinkingLevel)) throw new Error(t('模型不支持 thinking={{level}}', { level: meta.thinkingLevel }));
  }
  validatedContexts.set(context, { driver, version });
  return context;
}
