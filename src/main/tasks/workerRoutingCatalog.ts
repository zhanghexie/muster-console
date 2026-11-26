import { createHash } from 'node:crypto';
import { app } from 'electron';
import type { AppContext } from '../context';
import type { SessionTarget } from '../sessions/targets';
import { HARNESS_CATALOG } from '../../shared/harnessCatalog';
import { cliCapabilities, cliReasoningLevels, claudeModelReasoningLevels, normalizeCliLaunchOptions } from '../../shared/cliLaunchOptions';
import { codexModelReasoningLevels } from '../../shared/codexModels';
import { harnessModelId, harnessModelSelectionKey, isHarnessModelSelected } from '../../shared/harnessModelSelection';
import { canonicalModelParameterOverrides, modelParameterOptions, normalizeModelParameterValues, resolveModelParameters, type ModelParameterDescriptor, type ModelParameterValues } from '../../shared/modelParameters';
import type { WorkerTargetConfig } from '../../shared/workerRouting';
import { acpModelCatalogRevision, listAcpModels } from '../agentSession/drivers/acp/models';
import { getAcpPresets } from '../agentSession/drivers/acp/agents';
import { claudeModelCatalogRevision, claudeModelEnvironmentVersion, listClaudeModels } from '../agentSession/drivers/claude/models';
import { codexModelCatalogRevision, listCodexModels } from '../agentSession/drivers/codex/models';
import { externalPiModelCatalogRevision, listExternalPiModels } from '../agentSession/drivers/externalPi/models';
import { listMuseModels, museModelCatalogRevision } from '../agentSession/drivers/muse/process';
import { listZCodeModels, zcodeModelCatalogRevision } from '../agentSession/drivers/zcode/process';
import { resolveLlmConfig } from '../config';
import { parseExternalPiModelKey } from '../../shared/externalPiModel';
import type { HarnessModelGroup } from '../../shared/harnessPicker';

export class WorkerOptionError extends Error {
  constructor(message: string, readonly availability: 'invalid' | 'unavailable' | 'unknown' = 'invalid') { super(message); }
}

type CatalogIdentity = Pick<WorkerTargetConfig, 'harnessId' | 'surface' | 'runtimeId' | 'acpPresetId'>;
type NativeCatalogRow = { providerId: string; modelId: string; name: string; providerLabel?: string; group?: HarnessModelGroup; nativeModelId?: string; effortLevels?: readonly string[] };
type NativeCatalog = { state: 'ready' | 'unknown' | 'unsupported'; items: NativeCatalogRow[]; defaultRow?: NativeCatalogRow; catalogRuntime?: string; catalogPreset?: string;
  reason?: string; warning?: string; refreshed?: boolean; cleanupFailed?: true };
type CatalogReadOptions = { refresh?: boolean; signal?: AbortSignal; modelId?: string; dispatch?: boolean };
const unavailableCatalog = (catalogRuntime?: string): NativeCatalog => ({ state: 'unknown', items: [], catalogRuntime, reason: 'Model catalog unavailable. Refresh this Harness in Settings.' });

export function optionText(input: unknown, max = 128): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= max && input === input.trim() && !/[\u0000-\u001f\u007f]/.test(input);
}

export function optionObject(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input));
}

export function readTargetConfig(input: unknown): WorkerTargetConfig {
  if (!optionObject(input) || !Object.keys(input).every(key => ['harnessId', 'surface', 'runtimeId', 'acpPresetId', 'model', 'modelParameters', 'cliLaunchOptions'].includes(key)) ||
      !optionText(input.harnessId) || !optionText(input.runtimeId) || (input.surface !== 'gui' && input.surface !== 'cli') ||
      (input.acpPresetId !== undefined && !optionText(input.acpPresetId))) throw new WorkerOptionError('Invalid Worker configuration.');
  const config: WorkerTargetConfig = { harnessId: input.harnessId, surface: input.surface, runtimeId: input.runtimeId };
  if (input.acpPresetId !== undefined) config.acpPresetId = input.acpPresetId;
  if (input.model !== undefined) {
    if (!optionObject(input.model) || Object.keys(input.model).length !== 2 || !optionText(input.model.providerId, 512) || !optionText(input.model.modelId, 2048)) throw new WorkerOptionError('Invalid Worker model identity.');
    config.model = { providerId: input.model.providerId, modelId: input.model.modelId };
  }
  if (input.modelParameters !== undefined) {
    if (!optionObject(input.modelParameters) || Object.keys(input.modelParameters).length > 32) throw new WorkerOptionError('Invalid Worker model parameters.');
    const values = normalizeModelParameterValues(input.modelParameters);
    if (Object.keys(values).length !== Object.keys(input.modelParameters).length) throw new WorkerOptionError('Invalid Worker model parameters.');
    config.modelParameters = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (input.cliLaunchOptions !== undefined) {
    if (!optionObject(input.cliLaunchOptions) || !Object.entries(input.cliLaunchOptions).every(([key, value]) => ['model', 'reasoning'].includes(key) && optionText(value, 256))) {
      throw new WorkerOptionError('Worker pool CLI choices accept only model and reasoning launch options.');
    }
    config.cliLaunchOptions = { ...(typeof input.cliLaunchOptions.model === 'string' ? { model: input.cliLaunchOptions.model } : {}),
      ...(typeof input.cliLaunchOptions.reasoning === 'string' ? { reasoning: input.cliLaunchOptions.reasoning } : {}) };
  }
  return config;
}

export function listWorkerHarnesses(ctx: AppContext): Array<CatalogIdentity & { name: string; enabled: boolean }> {
  const known = HARNESS_CATALOG.flatMap((h): Array<CatalogIdentity & { name: string; enabled: boolean }> => {
    const gui = h.runtimeId && ctx.runtimes.get(h.runtimeId);
    const cli = h.cliRuntimeId && ctx.runtimes.get(h.cliRuntimeId);
    return [
      ...(gui && h.runtimeId ? [{ harnessId: h.id, name: h.name, surface: 'gui' as const, runtimeId: h.runtimeId,
        acpPresetId: h.acpPresetId, enabled: gui.enabled && !ctx.config.get().disabledAcpAgents?.includes(h.acpPresetId ?? '') }] : []),
      ...(cli && h.cliRuntimeId ? [{ harnessId: h.id, name: h.name, surface: 'cli' as const, runtimeId: h.cliRuntimeId, enabled: cli.enabled }] : [])
    ];
  });
  for (const preset of getAcpPresets(app.getPath('userData'))) {
    if (!known.some(h => h.surface === 'gui' && h.acpPresetId === preset.id)) known.push({ harnessId: preset.id, name: preset.name,
      surface: 'gui', runtimeId: 'acp', acpPresetId: preset.id,
      enabled: ctx.runtimes.get('acp')?.enabled === true && !ctx.config.get().disabledAcpAgents?.includes(preset.id) });
  }
  for (const runtime of ctx.runtimes.list()) {
    if (known.some(h => h.runtimeId === runtime.id) || runtime.id === 'acp' || !runtime.manifest) continue;
    known.push({ harnessId: runtime.id, name: runtime.manifest.label || runtime.id, runtimeId: runtime.id,
      surface: ctx.sessions.isChatRuntime(runtime.id) ? 'gui' : 'cli', enabled: runtime.enabled });
  }
  return known;
}

function checkHarness(ctx: AppContext, config: CatalogIdentity): void {
  const match = listWorkerHarnesses(ctx).find(h => h.harnessId === config.harnessId && h.surface === config.surface && h.runtimeId === config.runtimeId && h.acpPresetId === config.acpPresetId);
  if (!match) throw new WorkerOptionError('Worker Harness, surface, or preset is no longer registered.');
  if (!match.enabled) throw new WorkerOptionError('Worker Harness or preset is disabled in Settings.', 'unavailable');
}

function catalogAdapter(ctx: AppContext, config: CatalogIdentity) {
  const manifest = ctx.runtimes.get(config.runtimeId)?.manifest;
  const product = HARNESS_CATALOG.find(h => h.id === config.harnessId);
  return {
    manifest,
    runtimeId: config.surface === 'gui' ? config.runtimeId : manifest?.chat ? 'acp' : product?.runtimeId,
    preset: config.surface === 'gui' ? config.acpPresetId : manifest?.chat ? manifest.id : product?.acpPresetId
  };
}

export function workerCatalogRevision(ctx: AppContext, config: CatalogIdentity, cwd: string): number {
  const { runtimeId, preset } = catalogAdapter(ctx, config);
  const cfg = ctx.config.get();
  const userDataDir = app.getPath('userData');
  if (runtimeId === 'pi') return ctx.coreReasoningCatalog?.version ?? 0;
  if (runtimeId === 'codex-gui') return codexModelCatalogRevision(cwd);
  if (runtimeId === 'acp' && preset) return acpModelCatalogRevision(cwd, preset, userDataDir);
  if (runtimeId === 'claude') return claudeModelCatalogRevision({ cwd, userDataDir, isolateConfig: config.surface === 'gui' && cfg.claude?.isolateConfig === true });
  if (runtimeId === 'pi-external' || runtimeId === 'omp') return externalPiModelCatalogRevision({ cwd, runtimeId, executableOverride: cfg.externalPi?.[runtimeId]?.executable });
  if (runtimeId === 'muse-gui') return museModelCatalogRevision(cwd, cfg.externalHarness?.[runtimeId]?.executable);
  if (runtimeId === 'zcode-gui') return zcodeModelCatalogRevision(cwd, cfg.externalHarness?.[runtimeId]?.executable);
  return 0;
}

export function workerCatalogEnvironment(ctx: AppContext, config: CatalogIdentity, dispatch = false): string {
  if (!dispatch) checkHarness(ctx, config);
  const { runtimeId, preset, manifest } = catalogAdapter(ctx, config);
  const cfg = ctx.config.get();
  const driver = runtimeId ? ctx.agentSessions?.getDriver(runtimeId) : undefined;
  const configured = runtimeId === 'claude' ? [config.surface === 'gui' && cfg.claude?.isolateConfig === true, process.env.CLAUDE_CONFIG_DIR]
    : runtimeId === 'codex-gui' ? [process.env.CODEX_HOME]
      : runtimeId === 'pi-external' || runtimeId === 'omp' ? [cfg.externalPi?.[runtimeId], process.env.PI_CODING_AGENT_DIR]
        : runtimeId === 'muse-gui' || runtimeId === 'zcode-gui' ? [cfg.externalHarness?.[runtimeId], process.env.ZCODE_DATA_BASE_DIR]
          : runtimeId === 'pi' ? [cfg.llm] : [];
  const selections = runtimeId ? ctx.agentSessions?.modelAdmission?.selections.read()[harnessModelSelectionKey(runtimeId, preset)] : undefined;
  const version = runtimeId === 'claude' ? claudeModelEnvironmentVersion(app.getPath('userData'), config.surface === 'gui' && cfg.claude?.isolateConfig === true)
    : [driver?.connectionVersion, driver?.nativeConfigVersion?.(preset)];
  return JSON.stringify([runtimeId, preset, manifest, version, configured, selections,
    cfg.modelParameterProfiles, process.env.PATH, process.env.PATHEXT]);
}

/** All external calls explicitly use the same cache-only readers as the renderer. */
export async function readWorkerNativeCatalog(ctx: AppContext, config: CatalogIdentity, target: SessionTarget, options: CatalogReadOptions = {}): Promise<NativeCatalog> {
  if (!options.dispatch) checkHarness(ctx, config);
  const cfg = ctx.config.get();
  const cwd = target.sourceRoot.cwd;
  const userDataDir = app.getPath('userData');
  const { manifest, runtimeId: catalogRuntime, preset } = catalogAdapter(ctx, config);
  const cli = config.surface === 'cli' ? cliCapabilities(config.runtimeId, manifest) : undefined;
  if (cli && !cli.model) return { state: 'unsupported', items: [] };
  if (catalogRuntime === 'pi') {
    const selections = options.dispatch ? {} : ctx.agentSessions?.modelAdmission?.selections.read() ?? {};
    const items = (cfg.llm?.providers ?? []).filter(p => p.enabled !== false)
      .flatMap(p => p.models.filter(m => isHarnessModelSelected(selections, harnessModelSelectionKey('pi'), harnessModelId('pi', p.id, m.id)))
        .map(m => ({ providerId: p.id, modelId: m.id, name: m.name || m.id, providerLabel: p.name || p.id })));
    const selected = resolveLlmConfig(cfg);
    return { state: 'ready', catalogRuntime, items, defaultRow: items.find(item => item.providerId === selected.provider.id && item.modelId === selected.model.id) };
  }
  const read = (refresh: boolean) => {
    const discovery = { cwd, refresh, signal: options.signal };
    return catalogRuntime === 'acp' && preset ? listAcpModels({ ...discovery, userDataDir, agentId: preset, modelId: options.modelId })
      : catalogRuntime === 'codex-gui' ? listCodexModels(cwd, refresh, options.signal)
        : catalogRuntime === 'claude' ? listClaudeModels({ ...discovery, userDataDir, isolateConfig: config.surface === 'gui' && cfg.claude?.isolateConfig === true })
          : catalogRuntime === 'pi-external' || catalogRuntime === 'omp' ? listExternalPiModels({ ...discovery, runtimeId: catalogRuntime, executableOverride: cfg.externalPi?.[catalogRuntime]?.executable })
            : catalogRuntime === 'muse-gui' ? listMuseModels({ ...discovery, executableOverride: cfg.externalHarness?.[catalogRuntime]?.executable })
              : catalogRuntime === 'zcode-gui' ? listZCodeModels({ ...discovery, executableOverride: cfg.externalHarness?.[catalogRuntime]?.executable }) : undefined;
  };
  const queried = await read(options.refresh === true);
  const failed = queried?.ok === false ? queried : undefined;
  const result = options.refresh && failed && !options.signal?.aborted ? await read(false) : queried;
  const warning = failed?.error ?? (result && 'warning' in result ? result.warning : undefined);
  const cleanupFailed = failed && 'cleanupFailed' in failed && failed.cleanupFailed ? true : undefined;
  if (!result?.ok || !catalogRuntime) return { ...unavailableCatalog(catalogRuntime), catalogPreset: preset,
    ...(warning ? { reason: warning } : {}), ...(cleanupFailed ? { cleanupFailed } : {}) };
  const selected = ctx.agentSessions?.modelAdmission?.selections.read()[harnessModelSelectionKey(catalogRuntime, preset)];
  const items = result.items.flatMap(item => {
    if (selected && !selected.includes(harnessModelId(catalogRuntime, catalogRuntime, item.id))) return [];
    const piModel = catalogRuntime === 'pi-external' || catalogRuntime === 'omp' ? parseExternalPiModelKey(item.id) : null;
    const nativeModelId = piModel ? `${piModel.providerId}/${piModel.modelId}`
      : 'resolvedModel' in item && typeof item.resolvedModel === 'string' ? item.resolvedModel : item.id;
    const effortLevels = catalogRuntime === 'codex-gui' ? codexModelReasoningLevels(result.items as Parameters<typeof codexModelReasoningLevels>[0], item.id)
      : catalogRuntime === 'claude' ? claudeModelReasoningLevels(result.items as Parameters<typeof claudeModelReasoningLevels>[0], nativeModelId) : undefined;
    return [{ providerId: catalogRuntime, modelId: item.id, name: 'displayName' in item ? item.displayName : item.name, nativeModelId, effortLevels,
      ...('group' in item && item.group ? { group: item.group } : {}) }];
  });
  const defaultId = 'defaultModelId' in result ? result.defaultModelId : 'currentModelId' in result ? result.currentModelId
    : 'defaultId' in result ? result.defaultId : undefined;
  return { state: 'ready', catalogRuntime, catalogPreset: preset, items, defaultRow: items.find(item => item.modelId === defaultId),
    ...(warning ? { warning } : {}), ...(options.refresh && !failed ? { refreshed: true } : {}), ...(cleanupFailed ? { cleanupFailed } : {}) };
}

export async function validateWorkerConfig(ctx: AppContext, target: SessionTarget, raw: unknown, canonical = false, native?: NativeCatalog): Promise<{
  config: WorkerTargetConfig; parameters: ModelParameterDescriptor[]; launchParameters?: ModelParameterValues; fingerprint: string; catalogState: NativeCatalog['state'];
}> {
  const config = readTargetConfig(raw);
  checkHarness(ctx, config);
  const catalog = native ?? await readWorkerNativeCatalog(ctx, config, target);
  const requestedId = config.surface === 'gui' ? config.model?.modelId : config.cliLaunchOptions?.model;
  const row = requestedId ? catalog.items.find(item => config.surface === 'gui'
    ? item.modelId === requestedId && item.providerId === config.model?.providerId
    : item.nativeModelId === requestedId || item.modelId === requestedId) : undefined;
  if (requestedId && !row) {
    if (catalog.state === 'unknown') throw new WorkerOptionError(catalog.reason!, 'unknown');
    throw new WorkerOptionError('Worker model is missing from the current catalog or disabled. Choose it again in Settings.');
  }
  const manifest = ctx.runtimes.get(config.runtimeId)?.manifest;
  if (config.surface === 'gui') {
    if (config.cliLaunchOptions) throw new WorkerOptionError('GUI Workers do not accept CLI launch options.');
    if (config.runtimeId === 'pi' && config.model && !ctx.config.get().llm?.providers.find(provider => provider.id === config.model!.providerId)?.apiKey) {
      throw new WorkerOptionError('Muster Core provider credentials are unavailable. Configure the provider in Settings.', 'unavailable');
    }
    await ctx.agentSessions?.validateLaunchModel(config.runtimeId, target.sourceRoot.cwd, config.model, config.acpPresetId);
  } else {
    if (config.model || config.acpPresetId || (config.modelParameters && config.runtimeId !== 'kimi-cli')) throw new WorkerOptionError('Use the selected CLI adapter’s native launch options.');
    if (config.cliLaunchOptions?.reasoning && !config.cliLaunchOptions.model) throw new WorkerOptionError('Select a CLI model before choosing model-specific reasoning.');
    if (config.cliLaunchOptions?.reasoning && ['codex', 'claude-code'].includes(config.runtimeId) && row?.effortLevels === undefined) {
      throw new WorkerOptionError('CLI model reasoning is unknown. Refresh the native model catalog.', 'unknown');
    }
    config.cliLaunchOptions = normalizeCliLaunchOptions(config.runtimeId, config.cliLaunchOptions, manifest, row?.effortLevels);
    if (config.runtimeId === 'kimi-cli' && config.cliLaunchOptions?.reasoning) {
      if (config.modelParameters?.reasoning && config.modelParameters.reasoning !== config.cliLaunchOptions.reasoning) throw new WorkerOptionError('Kimi reasoning is supplied twice with different values.');
      config.modelParameters = { ...config.modelParameters, reasoning: config.cliLaunchOptions.reasoning };
      const { reasoning: _reasoning, ...cli } = config.cliLaunchOptions;
      config.cliLaunchOptions = cli;
    }
  }
  const parameterRuntime = config.surface === 'gui' ? config.runtimeId : config.runtimeId === 'kimi-cli' ? 'acp' : undefined;
  const driver = parameterRuntime && ctx.agentSessions?.getDriver(parameterRuntime);
  const version = driver && driver.connectionVersion;
  const describe = parameterRuntime && ctx.agentSessions && (row || Object.keys(config.modelParameters ?? {}).length);
  const context = describe ? await ctx.agentSessions!.describeModelParameters({ runtimeId: parameterRuntime!,
    providerId: config.model?.providerId ?? parameterRuntime, modelId: row?.modelId, cwd: target.sourceRoot.cwd,
    piModeId: config.acpPresetId ?? (config.runtimeId === 'kimi-cli' ? 'kimi' : undefined) }) : undefined;
  if (parameterRuntime && (ctx.agentSessions?.getDriver(parameterRuntime) !== (driver || undefined) || version !== (driver && driver.connectionVersion))) throw new WorkerOptionError('Worker Harness changed during validation. Retry.', 'unknown');
  const profiles = ctx.config.get().modelParameterProfiles ?? [];
  const parameters = context && !context.unavailable ? resolveModelParameters(context, profiles).parameters : [];
  let launchParameters: ModelParameterValues | undefined;
  if (Object.keys(config.modelParameters ?? {}).length) {
    if (!context || context.unavailable) throw new WorkerOptionError('Model parameters are unavailable. Refresh the Harness model catalog.', 'unknown');
    const input = config.modelParameters!;
    launchParameters = canonical ? Object.fromEntries(Object.entries(input).map(([id, value]) => {
      const alias = modelParameterOptions(context, profiles, id).find(option => option.mappedValue === value);
      if (!alias) throw new WorkerOptionError(`Worker model parameter is no longer available: ${id}.`);
      return [id, alias.value];
    })) : input;
    config.modelParameters = canonicalModelParameterOverrides(context, profiles, launchParameters);
  }
  if (config.surface === 'cli' && config.runtimeId !== 'kimi-cli' && manifest !== undefined) {
    const cli = cliCapabilities(config.runtimeId, manifest);
    if (cli.reasoning && row) {
      const levels = cliReasoningLevels(cli, row.effortLevels);
      if (levels.length) parameters.push({ id: 'reasoning', semantic: 'reasoning', label: 'Reasoning', apply: 'reconnect', supportsDefault: true,
        options: levels.map(value => ({ value, label: value })) });
    }
  }
  checkHarness(ctx, config);
  const effective = context && !context.unavailable ? resolveModelParameters(context, profiles, launchParameters).values : {};
  const coreProvider = config.runtimeId === 'pi' && config.model
    ? ctx.config.get().llm?.providers.find(provider => provider.id === config.model!.providerId) : undefined;
  const runtime = ctx.runtimes.get(config.runtimeId);
  const fingerprint = createHash('sha256').update(JSON.stringify([config, effective, version || '', row?.nativeModelId ?? null,
    coreProvider && [coreProvider.baseUrl, coreProvider.apiKey, coreProvider.api], runtime?.manifest, runtime?.extraArgs])).digest('base64url');
  return { config, parameters, launchParameters, fingerprint, catalogState: catalog.state };
}
