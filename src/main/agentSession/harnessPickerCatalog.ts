import { t } from '../../shared/i18n';
import { createHmac, randomBytes } from 'node:crypto';
import { app } from 'electron';
import type { HarnessPickerAvailability, HarnessPickerCatalog, HarnessPickerIdentity, HarnessPickerModelIdentity, HarnessPickerRequest, SetModelConfigurationInput, SetModelConfigurationResult } from '../../shared/harnessPicker';
import { cliCapabilities, cliReasoningLevels } from '../../shared/cliLaunchOptions';
import { getChatCapabilities } from '../../shared/agentRuntimeCapabilities';
import { hasConfiguredModelParameterDefault, normalizeModelParameterValues, resolveModelParameters, type ModelParameterState, type ModelParameterValues } from '../../shared/modelParameters';
import type { SessionMeta } from '../../shared/types';
import type { AppContext } from '../context';
import { readRuntimeAvailability } from '../runtime/availability';
import { primePiCatalogSnapshot } from '../agent/piConfigSync';
import type { SessionTarget } from '../sessions/targets';
import { listWorkerHarnesses, optionObject, optionText, readTargetConfig, readWorkerNativeCatalog, workerCatalogEnvironment, workerCatalogRevision } from '../tasks/workerRoutingCatalog';
import { defaultAcpAgentId, getAcpPresets } from './drivers/acp/agents';
import { assertModelCatalogSourceCurrent, modelCatalogDirectory, modelCatalogScope, resolveLaunchModelSource, resolveSessionModelSource } from './harnessCatalogSource';
import { pickerModelRows } from '../../shared/harnessModelPresentation';

type NativeCatalog = Awaited<ReturnType<typeof readWorkerNativeCatalog>>;
const stampKey = randomBytes(32);
const stamp = (parts: unknown): string => createHmac('sha256', stampKey).update(JSON.stringify(parts)).digest('base64url');
const identity = (model?: HarnessPickerModelIdentity | null): HarnessPickerModelIdentity | null => model ? { providerId: model.providerId, modelId: model.modelId } : null;
const sameModel = (a?: HarnessPickerModelIdentity | null, b?: HarnessPickerModelIdentity | null) => (a?.providerId ?? '') === (b?.providerId ?? '') && (a?.modelId ?? '') === (b?.modelId ?? '');

function parseModel(value: unknown): HarnessPickerModelIdentity | null {
  if (value === null) return null;
  if (!optionObject(value) || Object.keys(value).length !== 2 || !optionText(value.providerId, 512) || !optionText(value.modelId, 2048)) throw new Error(t('模型身份无效。'));
  return { providerId: value.providerId, modelId: value.modelId };
}

export function parsePickerParameters(value: unknown): ModelParameterValues {
  if (!optionObject(value) || Object.keys(value).length > 32) throw new Error(t('模型参数无效。'));
  const normalized = normalizeModelParameterValues(value);
  if (Object.keys(normalized).length !== Object.keys(value).length) throw new Error(t('模型参数无效。'));
  return normalized;
}

export async function listHarnessPickerChoices(ctx: AppContext): Promise<HarnessPickerAvailability> {
  const availability = await readRuntimeAvailability(ctx);
  const runtimes = new Set(availability.runtimes.map(runtime => runtime.id));
  const acpAgents = new Set(availability.acpAgents.map(agent => agent.id));
  const choices = listWorkerHarnesses(ctx).flatMap(({ name: label, enabled, ...harness }) => {
    const check = harness.acpPresetId ? availability.acpPreflights?.[harness.acpPresetId] : availability.runtimePreflights?.[harness.runtimeId];
    const available = enabled && runtimes.has(harness.runtimeId) && (!harness.acpPresetId || acpAgents.has(harness.acpPresetId));
    const foundCli = harness.surface === 'cli' && availability.cliPrograms?.[harness.runtimeId]?.status === 'found';
    const installed = available || harness.runtimeId === 'pi' || check?.status === 'available' || check?.status === 'not_configured' || !!check?.executable || foundCli;
    if (!installed || check?.status === 'not_installed') return [];
    const status = available ? 'available' : !enabled ? 'disabled' : check?.status ?? 'unknown';
    const warning = check?.problems.map(problem => problem.message).join('；');
    return [{ ...harness, label, available, status, ...(warning ? { warning } : {}) }] as HarnessPickerAvailability['choices'];
  });
  return { choices, checkedAt: availability.checkedAt };
}

function sessionPickerIdentity(ctx: AppContext, session: SessionMeta): HarnessPickerIdentity {
  const runtimeId = session.runtime;
  if (!runtimeId || session.archived || session.launchKind === 'shell' || !ctx.sessions.isChatRuntime(runtimeId) || !ctx.agentSessions?.getDriver(runtimeId)) {
    throw new Error(t('会话不存在或不支持模型选择。'));
  }
  const acpPresetId = runtimeId === 'acp' ? defaultAcpAgentId(session.piModeId, getAcpPresets(app.getPath('userData'))) : undefined;
  const match = listWorkerHarnesses(ctx).find(choice => choice.surface === 'gui' && choice.runtimeId === runtimeId && choice.acpPresetId === acpPresetId);
  if (!match?.enabled) throw new Error(t('会话 Harness 已停用或配置已变化。'));
  return { harnessId: match.harnessId, runtimeId, surface: 'gui', ...(acpPresetId ? { acpPresetId } : {}) };
}

function currentSessionStamp(ctx: AppContext, session: SessionMeta, source: SessionTarget, physicalCwd: string): string {
  const cfg = ctx.config.get();
  const driver = ctx.agentSessions?.getDriver(session.runtime ?? '');
  const harness = sessionPickerIdentity(ctx, session);
  return stamp([sessionSelectionState(session), harness, modelCatalogScope(source), physicalCwd, source.sourceKey, source.controlKey,
    driver?.connectionVersion, cfg.llm, cfg.modelParameterProfiles, ctx.agentSessions?.modelAdmission?.selections.read()]);
}

function sessionSelectionState(session: SessionMeta | undefined): string {
  return JSON.stringify(session && [session.id, session.archived, session.runtime, session.piModeId, session.workspaceId, session.cwd,
    session.sourceRoot, session.worktreeGroups, session.modelOverride, session.modelParameters, session.thinkingLevel]);
}

async function pickerSession(ctx: AppContext, sessionId: string) {
  const session = ctx.sessions.get(sessionId);
  if (!session) throw new Error(t('会话不存在。'));
  const before = sessionSelectionState(session);
  const harness = sessionPickerIdentity(ctx, session);
  const source = await resolveSessionModelSource(ctx.config.get(), session);
  if (before !== sessionSelectionState(ctx.sessions.get(sessionId))) throw new Error(t('会话配置已变化，请重新读取。'));
  const physicalCwd = modelCatalogDirectory(source.sourceRoot.cwd);
  const expected = currentSessionStamp(ctx, session, source, physicalCwd);
  const assertCurrent = (): void => {
    assertModelCatalogSourceCurrent(ctx.config.get(), source, physicalCwd);
    const current = ctx.sessions.get(sessionId);
    if (!current || currentSessionStamp(ctx, current, source, physicalCwd) !== expected) throw new Error(t('会话、模型或目录来源已变化，请重新选择。'));
  };
  return { harness, source, session, expected, assertCurrent };
}

function modelRows(native: NativeCatalog) {
  return pickerModelRows(native.items.map(row => ({ providerId: row.providerId, modelId: row.modelId, label: row.name,
    ...(row.providerLabel ? { group: { id: row.providerId, label: row.providerLabel } } : row.group ? { group: row.group } : {}),
    ...(row.nativeModelId ? { nativeLaunchModel: row.nativeModelId } : {}) })));
}

async function pickerParameters(ctx: AppContext, harness: HarnessPickerIdentity, source: SessionTarget, native: NativeCatalog,
  model: HarnessPickerModelIdentity | null, session?: SessionMeta) {
  const selected = model ?? native.defaultRow ?? null;
  const row = selected && native.items.find(item => sameModel(item, selected));
  if (model && !row) throw new Error(t('所选模型已隐藏或不在当前目录中，请重新选择。'));
  if (harness.surface === 'cli' && harness.runtimeId !== 'kimi-cli') {
    const caps = cliCapabilities(harness.runtimeId, ctx.runtimes.get(harness.runtimeId)?.manifest);
    if (!caps.reasoning) return { parameters: [] };
    if (row && row.effortLevels === undefined && ['codex', 'claude-code'].includes(harness.runtimeId)) return { parameters: [], warning: t('当前模型的思考档位尚未确认。') };
    const levels = cliReasoningLevels(caps, row?.effortLevels);
    const parameters: ModelParameterState[] = levels.length ? [{ descriptor: { id: 'reasoning', semantic: 'reasoning', label: t('思考强度'),
      options: levels.map(value => ({ value, label: value })), apply: 'reconnect', supportsDefault: true }, override: null, effectiveValue: null, source: 'engine' }] : [];
    return { parameters };
  }
  const runtimeId = native.catalogRuntime ?? harness.runtimeId;
  const piModeId = native.catalogPreset ?? (runtimeId === 'pi' ? session?.piModeId : harness.acpPresetId);
  const current = session && sameModel(model, session.modelOverride);
  const resolvesGuiDefault = model === null && harness.surface === 'gui';
  const context = await ctx.agentSessions?.describePickerModelParameters({ runtimeId, piModeId, cwd: source.sourceRoot.cwd,
    ...(!resolvesGuiDefault ? { providerId: selected?.providerId, modelId: selected?.modelId } : {}) }, current ? session : undefined, resolvesGuiDefault);
  if (!context || context.unavailable) return { parameters: [], warning: context?.warning ?? t('当前模型参数尚未确认。'),
    requiresDescription: !!context && hasConfiguredModelParameterDefault(context, ctx.config.get().modelParameterProfiles ?? []) };
  return { parameters: resolveModelParameters(context, ctx.config.get().modelParameterProfiles ?? [], current ? session.modelParameters : undefined).controls };
}

export async function readHarnessPickerCatalog(ctx: AppContext, request: HarnessPickerRequest, signal: AbortSignal): Promise<{
  catalog: HarnessPickerCatalog; updated?: { runtimeId: string; agentId?: string }; cleanupFailed?: true;
}> {
  const model = request.model === undefined ? undefined : parseModel(request.model);
  const session = 'sessionId' in request ? await pickerSession(ctx, request.sessionId) : undefined;
  if ('dispatch' in request) await primePiCatalogSnapshot();
  const dispatch = 'dispatch' in request ? ctx.orchestrator?.getPickerConfiguration(request.dispatch.workspaceId) : undefined;
  if ('dispatch' in request && !dispatch) throw new Error(t('调度模型配置不可用。'));
  const source = session?.source ?? await resolveLaunchModelSource(ctx.config.get(), dispatch?.source ?? ('source' in request ? request.source : {}));
  const harness = session?.harness ?? (dispatch ? { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui' as const }
    : readTargetConfig('harness' in request ? request.harness : undefined));
  const environment = workerCatalogEnvironment(ctx, harness, !!dispatch);
  let revision = workerCatalogRevision(ctx, harness, source.sourceRoot.cwd);
  const physicalCwd = modelCatalogDirectory(source.sourceRoot.cwd);
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertModelCatalogSourceCurrent(ctx.config.get(), source, physicalCwd);
    if (workerCatalogEnvironment(ctx, harness, !!dispatch) !== environment || workerCatalogRevision(ctx, harness, source.sourceRoot.cwd) !== revision) throw new Error(t('模型目录已变化，请重新读取。'));
    session?.assertCurrent();
    if (dispatch && 'dispatch' in request && ctx.orchestrator?.getPickerConfiguration(request.dispatch.workspaceId).expected !== dispatch.expected) {
      throw new Error(t('调度模型或工作区配置已变化，请重新读取。'));
    }
  };
  assertCurrent();
  const native = await readWorkerNativeCatalog(ctx, harness, source, { refresh: request.refresh === true, signal,
    modelId: model?.modelId ?? session?.session.modelOverride?.modelId, dispatch: !!dispatch });
  if (request.refresh) revision = workerCatalogRevision(ctx, harness, source.sourceRoot.cwd);
  assertCurrent();
  const preview = model === undefined ? undefined : dispatch && 'dispatch' in request
    ? ctx.orchestrator?.getPickerConfiguration(request.dispatch.workspaceId, model) : await pickerParameters(ctx, harness, source, native, model, session?.session);
  assertCurrent();
  return { catalog: { harness, source: modelCatalogScope(source), models: modelRows(native), defaultModel: identity(native.defaultRow),
    state: native.state === 'unknown' ? 'missing' : native.state, warning: native.warning ?? native.reason,
    parameterState: preview ? preview.warning ? 'unknown' : 'ready' : 'not-requested', parameters: preview?.parameters, parameterWarning: preview?.warning,
    canRefresh: !!native.catalogRuntime && native.catalogRuntime !== 'pi',
    canSetModel: session ? (ctx.agentSessions?.getDriver(harness.runtimeId)?.modelOverridePolicy ?? getChatCapabilities(harness.runtimeId).modelOverridePolicy) !== 'unsupported'
      : native.state !== 'unsupported',
    ...(session ? { selectedModel: identity(session.session.modelOverride), selectedParameters: session.session.modelParameters ?? {},
      sessionStamp: session.expected, commitStamp: stamp([session.expected, environment, revision]) } : {}),
    ...(dispatch ? { selectedModel: dispatch.selectedModel, selectedParameters: dispatch.selectedParameters, sessionStamp: dispatch.expected, commitStamp: dispatch.expected } : {}) },
    ...(native.refreshed && native.catalogRuntime ? { updated: { runtimeId: native.catalogRuntime, agentId: native.catalogPreset } } : {}),
    ...(native.cleanupFailed ? { cleanupFailed: true } : {}) };
}

export async function setPickerModelConfiguration(ctx: AppContext, request: SetModelConfigurationInput): Promise<SetModelConfigurationResult> {
  const model = parseModel(request.model);
  const parameters = parsePickerParameters(request.parameters);
  const binding = await pickerSession(ctx, request.sessionId);
  const { harness, source } = binding;
  const revision = workerCatalogRevision(ctx, harness, source.sourceRoot.cwd);
  const environment = workerCatalogEnvironment(ctx, harness);
  if (stamp([binding.expected, environment, revision]) !== request.expected || !ctx.agentSessions) throw new Error(t('会话、模型或目录来源已变化，请重新选择。'));
  const assertCurrent = () => {
    binding.assertCurrent();
    if (workerCatalogRevision(ctx, harness, source.sourceRoot.cwd) !== revision || workerCatalogEnvironment(ctx, harness) !== environment) throw new Error(t('模型目录已变化，请重新选择。'));
  };
  const native = await readWorkerNativeCatalog(ctx, harness, source);
  const preview = await pickerParameters(ctx, harness, source, native, model, binding.session);
  if (preview.requiresDescription) throw new Error(preview.warning);
  for (const [id, value] of Object.entries(parameters)) {
    if (!preview.parameters.some(control => control.descriptor.id === id && control.descriptor.options.some(option => option.value === value))) {
      throw new Error(preview.warning ?? t('该模型不支持所选参数 {{id}}。', { id }));
    }
  }
  await ctx.agentSessions.validateLaunchModel(harness.runtimeId, source.sourceRoot.cwd, model ?? undefined, harness.acpPresetId);
  assertCurrent();
  return ctx.agentSessions.commitPickerModelConfiguration(request.sessionId, model, parameters, assertCurrent);
}
