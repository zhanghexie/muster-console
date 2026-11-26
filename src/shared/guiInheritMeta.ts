import type { GuiSessionInitialMeta, GuiThinkingLevel, GuiWorkerMode } from './types';
import { resolveInheritedDefaults, type InheritableSession } from './launchDefaults';
import { getChatCapabilities } from './agentRuntimeCapabilities';
import { normalizeModelParameterValues, type ModelParameterValues } from './modelParameters';
import { supportsGuiPermissionMode } from './guiPermissionOptions';
import { parseNativeConfigIntent, type NativeConfigIntent } from './nativeSessionConfig';

export class GuiInheritMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuiInheritMetaError';
  }
}

/** 组装 create/delegate 的 inheritMeta；model 只给一半则拒绝（P1：禁止静默丢弃） */
export function buildGuiInheritMeta(input: {
  configurePermissions?: boolean;
  guiMode?: GuiWorkerMode;
  piModeId?: string;
  model?: { providerId?: string; modelId?: string };
  thinking?: GuiThinkingLevel;
  modelParameters?: ModelParameterValues;
  nativeConfig?: NativeConfigIntent;
}): GuiSessionInitialMeta | undefined {
  if (input.configurePermissions !== undefined && typeof input.configurePermissions !== 'boolean') throw new GuiInheritMetaError('configurePermissions must be a boolean.');
  const model = parseGuiModelArg(input.model);
  const values = input.modelParameters === undefined ? undefined : normalizeModelParameterValues(input.modelParameters);
  if (values && (typeof input.modelParameters !== 'object' || !input.modelParameters || Array.isArray(input.modelParameters) || Object.keys(values).length !== Object.keys(input.modelParameters).length)) throw new GuiInheritMetaError('INVALID_MODEL_PARAMETERS');
  const nativeConfig = parseNativeConfigIntent(input.nativeConfig);
  if (input.configurePermissions === undefined && !input.guiMode && !input.piModeId?.trim() && !model && !input.thinking && !values && !nativeConfig) return undefined;
  return {
    ...(input.configurePermissions !== undefined ? { configurePermissions: input.configurePermissions } : {}),
    ...(input.guiMode ? { guiMode: input.guiMode } : {}),
    ...(nativeConfig ? { nativeConfig } : {}),
    ...(input.piModeId?.trim() ? { piModeId: input.piModeId.trim() } : {}),
    ...(model ? { modelOverride: model } : {}),
    ...(input.thinking ? { thinkingLevel: input.thinking } : {}),
    ...(values ? { modelParameters: values } : {})
  };
}

export function parseGuiModelArg(
  model?: { providerId?: string; modelId?: string }
): { providerId: string; modelId: string } | undefined {
  if (model === undefined) return undefined;
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new GuiInheritMetaError('model 必须是包含 providerId 与 modelId 的对象');
  const providerId = typeof model.providerId === 'string' ? model.providerId.trim() : '';
  const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : '';
  if (!providerId && !modelId) return undefined;
  if (!providerId || !modelId) {
    throw new GuiInheritMetaError('INCOMPLETE_MODEL');
  }
  return { providerId, modelId };
}

/** Reject metadata that the selected built-in adapter cannot consume before creating a session. */
export function assertLaunchModel(runtime: string, model: { providerId: string; modelId: string } | undefined, isChat: boolean): void {
  if (!model) return;
  if (!isChat) throw new GuiInheritMetaError(`runtime ${runtime} 是 CLI 接入，不接受 GUI model 参数；请使用该 CLI 的原生模型配置`);
  if (['claude', 'codex-gui', 'cursor', 'acp', 'pi-external', 'omp', 'muse-gui', 'zcode-gui'].includes(runtime) && model.providerId !== runtime)
    throw new GuiInheritMetaError(`runtime ${runtime} 的 model.providerId 必须为 ${runtime}，收到 ${model.providerId}`);
}


/** One launch contract for empty sessions and delegated tasks. Runtime-specific values never cross adapters. */
export function resolveLaunchConfiguration(
  input: Parameters<typeof buildGuiInheritMeta>[0] & { runtime?: string; acpPresetId?: string },
  parent: (InheritableSession & { modelParameters?: ModelParameterValues; nativeConfig?: NativeConfigIntent }) | null | undefined,
  defaultRuntime: string,
  isChatRuntime: (runtime: string) => boolean
): { runtime: string; inheritMeta: GuiSessionInitialMeta | undefined } {
  // Validate explicit values before applying inheritance; malformed input cannot become a default.
  const explicit = buildGuiInheritMeta(input);
  // A CLI runtime is a deliberate per-launch choice, never an implicit parent/config default.
  const implicitParent = !input.runtime?.trim() && parent?.runtime?.trim() && !isChatRuntime(parent.runtime.trim())
    ? { ...parent, runtime: undefined } : parent;
  const configuredDefault = typeof defaultRuntime === 'string' ? defaultRuntime.trim() : '';
  const guiDefault = configuredDefault && isChatRuntime(configuredDefault) ? configuredDefault : 'pi';
  const runtime = resolveInheritedDefaults({ runtime: input.runtime }, implicitParent, { runtime: guiDefault }).runtime;
  const legacyPreset = runtime === 'acp' ? explicit?.piModeId : undefined;
  if (input.acpPresetId !== undefined && (runtime !== 'acp' || typeof input.acpPresetId !== 'string' || !input.acpPresetId.trim())) {
    throw new GuiInheritMetaError('acpPresetId requires the acp runtime and a valid preset id.');
  }
  if (legacyPreset && input.acpPresetId && legacyPreset !== input.acpPresetId.trim()) {
    throw new GuiInheritMetaError('acpPresetId conflicts with the legacy piModeId preset.');
  }
  const parentPreset = parent?.runtime === 'acp' ? parent.piModeId?.trim() || undefined : undefined;
  const preset = runtime === 'acp' ? input.acpPresetId?.trim() || legacyPreset || parentPreset : undefined;
  const sameAdapter = parent?.runtime === runtime && (runtime !== 'acp' || (preset !== undefined && preset === parentPreset));
  const compatibleParent = sameAdapter ? implicitParent : undefined;
  const configurePermissions = explicit?.configurePermissions ?? compatibleParent?.configurePermissions;
  const resolved = resolveInheritedDefaults({ runtime, modelOverride: explicit?.modelOverride,
    thinkingLevel: input.thinking, guiMode: runtime === 'pi' ? input.guiMode : undefined }, compatibleParent, { runtime: guiDefault });
  const chat = isChatRuntime(runtime);
  const caps = chat ? getChatCapabilities(runtime) : undefined;
  // A new approval mode inherited across runtimes must never disappear and
  // silently fall back to auto when the selected adapter cannot enforce it.
  if (configurePermissions === true && runtime === 'pi' && resolved.guiMode && !supportsGuiPermissionMode(runtime, resolved.guiMode)) {
    throw new GuiInheritMetaError(`${runtime} does not support guiMode=${resolved.guiMode}; choose a supported permission mode.`);
  }
  assertLaunchModel(runtime, resolved.modelOverride, chat);
  if (resolved.modelOverride && caps?.modelOverridePolicy !== 'reconnect') throw new GuiInheritMetaError(`${runtime} does not support model overrides.`);
  if (input.thinking !== undefined && caps?.thinkingPolicy !== 'hot') throw new GuiInheritMetaError(`${runtime} does not support thinking; use its advertised modelParameters.`);
  if (configurePermissions === true && input.guiMode !== undefined && !supportsGuiPermissionMode(runtime, input.guiMode)) throw new GuiInheritMetaError('guiMode applies to Muster Core only.');
  const nativeConfig = explicit?.nativeConfig ?? (sameAdapter ? parent?.nativeConfig : undefined);
  if (configurePermissions === true && nativeConfig && (!chat || runtime === 'pi' || nativeConfig.identity.runtimeId !== runtime ||
      nativeConfig.identity.presetId !== (runtime === 'acp' ? preset : undefined))) {
    throw new GuiInheritMetaError('nativeConfig does not match the selected Harness.');
  }
  if (input.piModeId !== undefined && runtime !== 'pi' && runtime !== 'acp') throw new GuiInheritMetaError('piModeId requires the pi or acp runtime.');
  const sameModel = sameAdapter && parent?.modelOverride?.providerId === resolved.modelOverride?.providerId && parent?.modelOverride?.modelId === resolved.modelOverride?.modelId;
  const parameters = explicit?.modelParameters ?? (input.thinking === undefined && sameModel ? parent?.modelParameters : undefined);
  if (parameters && Object.keys(parameters).length && !chat) throw new GuiInheritMetaError(`${runtime} is CLI-only; configure model parameters through the CLI.`);
  if (input.thinking !== undefined && input.modelParameters !== undefined) throw new GuiInheritMetaError('Use thinking or modelParameters, not both.');
  const thinking = caps?.thinkingPolicy === 'hot' && !parameters
    ? input.thinking ?? (sameModel ? parent?.thinkingLevel : undefined) : undefined;
  return { runtime, inheritMeta: buildGuiInheritMeta({ model: resolved.modelOverride,
    thinking, modelParameters: parameters, configurePermissions, piModeId: runtime === 'acp' ? preset : input.piModeId, nativeConfig,
    guiMode: runtime === 'pi' ? resolved.guiMode : undefined }) };
}
