import { getColdSessionFile } from './buckets';
/**
 * 调度面的模型/思考档/上下文占用状态：会话级覆盖 → 工作区持久选择 → 全局默认。
 * （自 orchestrator.ts 拆分；`this.` 改经 OrchestratorHost 协作面，逻辑逐字保留。）
 */
import { resolveLlmConfig } from '../../config';
import { rejectImagesIfModelLacksSupport } from '../../../shared/modelCapabilities';
import { DEFAULT_CORE_CONTEXT_WINDOW } from '../../../shared/piCatalog';
import { resolveEffectiveMcpFromApp } from '../../../shared/mcpConfig';
import { t } from '../../../shared/i18n';
import type { AgentContextStatus, ChatImageAttachment } from '../../../shared/types';
import { measureSchedulerInjection } from '../injectionMetrics';
import { buildMetaAgentAppendPrompt } from '../systemPrompt';
import { snapshotPiContext } from '../piContext';
import { normalizeAgentModelSelection } from '../agentModelSelection';
import { normalizeAgentThinking } from '../agentThinking';
import type { OrchestratorHost } from './internal';
import { schedulerWorkspacePromptScope } from '../schedulerWorkspaceContext';
import { getConfiguredCoreReasoning, getConfiguredPiThinkingLevels } from '../piConfigSync';
import { describeCoreReasoning } from '../piReasoning';
import { createHmac, randomBytes } from 'node:crypto';
import type { HarnessPickerModelIdentity, SetDispatchModelConfigurationOptions, SetModelConfigurationResult } from '../../../shared/harnessPicker';
import type { ModelParameterDescriptor, ModelParameterState, ModelParameterValues } from '../../../shared/modelParameters';
import { modelCatalogDirectory } from '../../agentSession/harnessCatalogSource';

export function getWorkspacePromptScope(o: OrchestratorHost, workspaceId = o.workspaceId) {
  const b = o.buckets.get(workspaceId);
  return schedulerWorkspacePromptScope(o.ctx.config, workspaceId, b?.piSession, b ? b.piSessionFile : getColdSessionFile(o, workspaceId), !!b?.resetPiOnNextSend);
}

/** 当前区模型 + 上下文占用（无 Pi session 时仅回落配置模型名） */
export function getContextStatus(o: OrchestratorHost, workspaceId?: string): AgentContextStatus {
  const wsId = workspaceId ?? o.workspaceId;
  const b = o.buckets.get(wsId);
  const fullCfg = o.ctx.config.get();
  // D1：stable→catalog→workspace-context。目录事实忙时取当前操作，空闲取下一轮范围。
  // 口径偏差（均可接受，不改注入链路本身；②已随 A3 收敛，①③见下）：
  // ①正文/目录工具表度量当前配置；目录范围取本轮持有快照，空闲时展示下一轮范围；
  // ②（A3 收敛）MCP 面改按工作区 resolveEffectiveMcpFromApp 解析，与注入链路
  //   （piProvider 同函数）同源，多工作区 MCP 配置下不再有全局/按区偏差；
  // ③shellApi 未就绪时 baseUrl 为空，默认正文少 statusHint 行，字节数略有低估。
  const effMcp = resolveEffectiveMcpFromApp(fullCfg, wsId, 'pi-dispatcher');
  const promptScope = getWorkspacePromptScope(o, wsId);
  const source = promptScope.workspaceContext;
  const workerRoutingScope = source && { workspaceId: source.workspaceId, rootId: source.sourceRootId,
    rootsRevision: source.rootsRevision, cwd: source.cwd };
  const injection = measureSchedulerInjection(
    buildMetaAgentAppendPrompt(o.ctx.shellApi?.baseUrl, {
      mcpEnabled: effMcp.enabled,
      mcpServers: effMcp.enabled ? effMcp.servers.filter((s) => s.enabled).map((s) => s.name) : [],
      customBody: fullCfg.dispatcherAppendPrompt,
      rules: fullCfg.agentRules,
      ...promptScope
    })
  );
  const resolved = resolveLlmConfig(fullCfg, b ? {providerId:b.providerId,modelId:b.modelId} : o.models[wsId]);
  const fallback = resolved.model.id;
  if (b?.piSession) {
    const snap = snapshotPiContext(b.piSession, fallback);
    const contextWindow = snap.contextWindow || resolved.model.contextWindow || DEFAULT_CORE_CONTEXT_WINDOW;
    const percent =
      typeof snap.tokens === 'number' && contextWindow > 0
        ? Math.round((snap.tokens / contextWindow) * 100)
        : snap.percent;
    return {
      ...snap,
      contextWindow,
      percent,
      provider: snap.provider || resolved.provider.id,
      modelName: resolved.model.name || snap.modelName,
      supportsImages: !!resolved.model.multimodal,
      thinking: thinkingStatus(o, wsId, resolved),
      workerRoutingScope,
      injection
    };
  }
  return {
    modelId: resolved.model.id,
    modelName: resolved.model.name || resolved.model.id,
    provider: resolved.provider.id,
    tokens: null,
    contextWindow: resolved.model.contextWindow ?? DEFAULT_CORE_CONTEXT_WINDOW,
    percent: null,
    supportsImages: !!resolved.model.multimodal,
    thinking: thinkingStatus(o, wsId, resolved),
    workerRoutingScope,
    injection
  };
}

function thinkingStatus(
  o: OrchestratorHost,
  workspaceId: string,
  resolved: ReturnType<typeof resolveLlmConfig>
): NonNullable<AgentContextStatus['thinking']> {
  const level = o.getThinkingLevel(workspaceId);
  const binding = getConfiguredCoreReasoning(o.ctx.coreReasoningCatalog?.snapshot, resolved.provider, resolved.model);
  if (binding) {
    const descriptor = describeCoreReasoning(binding);
    const levels = descriptor.options.map(option => option.value);
    return { level: level && levels.includes(level) ? level : null, levels, available: levels.length > 0 };
  }
  const session = o.buckets.get(workspaceId)?.piSession;
  // Pi 对未知推理模型也可能返回一组通用档；须先有目录或用户映射声明。
  let levels = getConfiguredPiThinkingLevels(resolved.provider, resolved.model);
  if (session?.model?.id === resolved.model.id && session.model.provider === resolved.provider.id) {
    if (session.model.reasoning === false) {
      levels = [];
    } else if (session.model.reasoning === true && typeof session.getAvailableThinkingLevels === 'function') {
      try {
        const supported = session.getAvailableThinkingLevels();
        if (levels) levels = levels.filter((level) => supported.includes(level));
      } catch (error) {
        console.warn('[orchestrator] failed to read Pi thinking levels:', error);
      }
    }
  }
  return {
    level: level && levels?.some(value => value === level) ? level : null,
    available: !!levels?.length,
    ...(levels ? { levels } : {})
  };
}

const pickerKey = randomBytes(32);

export function getPickerConfiguration(o: OrchestratorHost, wsId: string, model?: HarnessPickerModelIdentity | null) {
  const config = o.ctx.config.get();
  if (!config.workspaces.some(workspace => workspace.id === wsId)) throw new Error(t('工作区不可用'));
  const context = getWorkspacePromptScope(o, wsId).workspaceContext;
  if (!context || context.workspaceId !== wsId) throw new Error(t('调度缺少可确认的工作区来源。'));
  const source = { workspaceId: wsId, rootId: context.sourceRootId, rootsRevision: context.rootsRevision, cwd: context.cwd };
  const selectedModel = o.models[wsId] ?? null;
  const bucket = o.buckets.get(wsId);
  const current = resolveLlmConfig(config, bucket ? { providerId: bucket.providerId, modelId: bucket.modelId } : selectedModel ?? undefined);
  const level = o.getThinkingLevel(wsId);
  const expected = createHmac('sha256', pickerKey).update(JSON.stringify([source, modelCatalogDirectory(source.cwd), selectedModel,
    current.provider.id, current.model.id, level, config.llm, o.ctx.coreReasoningCatalog?.version])).digest('base64url');
  const selectedParameters: ModelParameterValues = level ? { reasoning: level } : {};
  const resolved = model === undefined ? current : resolveLlmConfig(config, model ?? undefined);
  if (model && (resolved.provider.id !== model.providerId || resolved.model.id !== model.modelId || resolved.provider.enabled === false)) {
    throw new Error('所选调度模型已不可用，请重新选择。');
  }
  const binding = getConfiguredCoreReasoning(o.ctx.coreReasoningCatalog?.snapshot, resolved.provider, resolved.model);
  const levels = binding ? undefined : thinkingStatus(o, wsId, resolved).levels;
  const descriptor: ModelParameterDescriptor | undefined = binding ? describeCoreReasoning(binding)
    : levels?.length ? { id: 'reasoning', semantic: 'reasoning', label: t('思考强度'),
      options: levels.map(value => ({ value, label: value })), apply: 'next-turn', supportsDefault: true } : undefined;
  const sameModel = resolved.provider.id === current.provider.id && resolved.model.id === current.model.id;
  const override = sameModel && level && descriptor?.options.some(option => option.value === level) ? level : null;
  const parameters: ModelParameterState[] = descriptor?.options.length ? [{ descriptor, override, effectiveValue: override ?? descriptor.defaultValue ?? null,
    source: override ? 'session' : 'engine' }] : [];
  return { source, selectedModel, selectedParameters, expected, parameters,
    ...(!binding && levels === undefined ? { warning: t('当前模型的思考档位尚未确认。') } : {}) };
}

export async function setPickerConfiguration(o: OrchestratorHost, wsId: string, model: HarnessPickerModelIdentity | null,
  options: SetDispatchModelConfigurationOptions): Promise<SetModelConfigurationResult> {
  try {
    if (!options?.expected || !options.parameters || typeof options.parameters !== 'object' || Array.isArray(options.parameters) ||
        Object.keys(options.parameters).some(key => key !== 'reasoning') || (model !== null && !normalizeAgentModelSelection(model))) {
      throw new Error(t('调度模型配置无效。'));
    }
    const requested = options.parameters.reasoning;
    const level = requested === undefined ? null : normalizeAgentThinking(requested);
    if (requested !== undefined && !level) throw new Error(t('当前模型不支持该思考档'));
    let changedModel = false;
    await o.ctx.store.saveAgentModelConfigurationStrict(() => {
      const choice = getPickerConfiguration(o, wsId, model);
      if (choice.expected !== options.expected) throw new Error(t('调度模型或工作区配置已变化，请重新选择。'));
      if (level && !choice.parameters[0]?.descriptor.options.some(option => option.value === level)) throw new Error(t('当前模型不支持该思考档'));
      changedModel = choice.selectedModel?.providerId !== model?.providerId || choice.selectedModel?.modelId !== model?.modelId;
      const models = { ...o.models }, thinking = { ...o.thinkings };
      if (model) models[wsId] = model; else delete models[wsId];
      if (level) thinking[wsId] = level; else delete thinking[wsId];
      return { models, thinking };
    }, () => {
      const bucket = o.buckets.get(wsId);
      if (model) o.models[wsId] = model; else delete o.models[wsId];
      if (level) o.thinkings[wsId] = level; else delete o.thinkings[wsId];
      if (bucket) {
        bucket.providerId = model?.providerId;
        bucket.modelId = model?.modelId;
        bucket.thinkingLevel = level ?? undefined;
      }
      try {
        if (changedModel) o.invalidatePiSession(wsId);
        o.emitContextStatus(wsId);
      } catch (error) { console.warn('[orchestrator] model configuration notification failed:', error); }
    });
    return { ok: true, applied: o.isBusy(wsId) ? 'next-turn' : 'immediate' };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

/**
 * 切换调度思考档（工作区级，agent-thinking.json）。
 * null=跟随默认（删盘上条目）；切档即时落盘，下回合热读，无需重连。
 */
export function setThinking(
  o: OrchestratorHost,
  level: string | null,
  wsId: string
): { ok: boolean; error?: string; thinkingLevel: string | null; available: boolean } {
  if (level !== null && !normalizeAgentThinking(level)) {
    const st = o.getContextStatus(wsId);
    return {
      ok: false,
      error: t('未知思考档: {{level}}', { level }),
      thinkingLevel: st.thinking?.level ?? null,
      available: st.thinking?.available ?? false
    };
  }
  if (level !== null) {
    const st = o.getContextStatus(wsId);
    if (!st.thinking?.levels?.includes(level)) {
      return {
        ok: false,
        error: st.thinking?.levels ? t('当前模型不支持该思考档') : t('当前模型的思考档位尚不可用'),
        thinkingLevel: st.thinking?.level ?? null,
        available: st.thinking?.available ?? false
      };
    }
  }
  const b = o.buckets.get(wsId);
  if (level === null) {
    delete o.thinkings[wsId];
    if (b) delete b.thinkingLevel;
  } else {
    const sel = normalizeAgentThinking(level);
    if (!sel) {
      const st = o.getContextStatus(wsId);
      return {
        ok: false,
        error: t('未知思考档: {{level}}', { level }),
        thinkingLevel: st.thinking?.level ?? null,
        available: st.thinking?.available ?? false
      };
    }
    o.thinkings[wsId] = sel;
    if (b) b.thinkingLevel = sel;
  }
  o.ctx.store.saveAgentThinking(o.thinkings);
  o.emitContextStatus(wsId);
  const st = o.getContextStatus(wsId);
  return {
    ok: true,
    thinkingLevel: st.thinking?.level ?? null,
    available: st.thinking?.available ?? false
  };
}

/**
 * 调度面带图发送守卫：当前生效模型（会话覆盖 > 全局）非多模态则拒绝。
 * chat:send 在受理前调用；send() 内再拦一次防其它入口漏过。
 */
export function checkSendImages(
  o: OrchestratorHost,
  wsId: string,
  images?: ChatImageAttachment[]
): { ok: true } | { ok: false; error: string } {
  if (!images?.length) return { ok: true };
  const b = o.buckets.get(wsId);
  const resolved = resolveLlmConfig(o.ctx.config.get(), {
    providerId: b?.providerId,
    modelId: b?.modelId
  });
  return rejectImagesIfModelLacksSupport({
    images,
    modelId: resolved.model.id,
    modelName: resolved.model.name || resolved.model.id,
    explicitMultimodal: resolved.model.multimodal
  });
}

/**
 * 切换当前工作区调度对话使用的服务商与模型（会话级覆盖：只写本工作区 bucket，
 * 不动全局配置——全局默认模型由设置页管理，改它只影响没有覆盖的会话）。
 */
export function switchModel(
  o: OrchestratorHost,
  wsId: string,
  model: { providerId: string; modelId: string }
): { thinkingReset: boolean; thinkingUnknown: boolean } {
  const b = o.buckets.get(wsId);
  if (b) { b.providerId = model.providerId; b.modelId = model.modelId; }
  // 落盘（形状非法不入表，避免污染恢复数据）；resolveLlmConfig 对失效目标本就回落全局
  const sel = normalizeAgentModelSelection(model);
  if (sel) {
    o.models[wsId] = sel;
    o.ctx.store.saveAgentModels(o.models);
  }

  o.invalidatePiSession(wsId);
  // 仅保留新模型明确支持的工作区档位，避免 Pi 静默钳制为另一档。
  const previousThinking = o.getThinkingLevel(wsId);
  const levels = o.getContextStatus(wsId).thinking?.levels;
  const thinkingReset = !!previousThinking && !levels?.includes(previousThinking);
  if (thinkingReset) {
    delete o.thinkings[wsId];
    if (b) delete b.thinkingLevel;
    o.ctx.store.saveAgentThinking(o.thinkings);
  }
  o.emitContextStatus(wsId);
  return { thinkingReset, thinkingUnknown: thinkingReset && !levels };
}
