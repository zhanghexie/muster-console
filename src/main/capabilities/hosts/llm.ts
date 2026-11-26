import type { AppContext } from '../../context';
import { mergeModelAttachmentPolicy } from '../../../shared/attachmentPolicy';
import { t } from '../../../shared/i18n';
import {
  LLM_THINKING_FORMATS,
  GUI_THINKING_LEVELS,
  type GuiThinkingLevel,
  type LlmApiProtocol,
  type LlmConfig,
  type LlmProviderConfig,
  type LlmThinkingFormat
} from '../../../shared/types';
import { testLlmConnection } from '../../agent/openaiClient';
import { computeLlmQuota, normalizeQuotaWindowMs, type QuotaSample } from '../../../shared/llmQuota';

const API_KEY_MASK = '***configured***';

const API_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
  'azure-openai-responses'
] as const;

function redactKey(key: string): string {
  return key ? API_KEY_MASK : '';
}

/**
 * 协议/方言 → 思考配置各字段的有效性。给 agent 的「先看再配」提示，避免配了静默无效的字段：
 * - levels 值映射全协议生效；thinkingFormat/reasoningEffortField/disableAtOff 仅 completions 生效；
 * - off 档能否真正关闭思考：仅 completions + DeepSeek 系（GLM-5.3 系/OpenAI 协议层禁止关闭）。
 */
function thinkingEffect(p: LlmProviderConfig) {
  const api = p.api ?? 'openai-completions';
  const completions = api === 'openai-completions';
  const isDeepSeekFamily =
    completions &&
    (p.id.toLowerCase().includes('deepseek') ||
      /deepseek\.com/i.test(p.baseUrl) ||
      p.thinking?.thinkingFormat === 'deepseek');
  return {
    levels: true,
    dialectFields: completions,
    offCanDisable: isDeepSeekFamily,
    ...(completions
      ? {}
      : { note: t('非 completions 协议：thinkingFormat/reasoningEffortField/disableAtOff 不生效；off 档建议留空') })
  };
}

/** 服务商 → 对外形态（apiKey 恒为掩码，模型面裁到最小） */
function toPublicProvider(p: LlmProviderConfig) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    api: p.api ?? 'openai-completions',
    enabled: p.enabled !== false,
    apiKey: redactKey(p.apiKey),
    models: p.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning === true,
      ...(typeof m.multimodal === 'boolean' ? { multimodal: m.multimodal } : {}),
      ...(m.attachments ? { attachments: m.attachments } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {})
    })),
    ...(p.thinking ? { thinking: p.thinking } : {}),
    ...(p.compat ? { compat: p.compat } : {}),
    thinkingEffect: thinkingEffect(p)
  };
}

/**
 * thinking 合并语义：未提及的字段保留；levels 某档传空串/null=清除该档；
 * thinkingFormat 传空串/null=恢复自动探测。全空时收掉整个 thinking。
 */
function mergeThinking(
  cur: LlmProviderConfig['thinking'],
  patch: Record<string, unknown> | undefined
): LlmProviderConfig['thinking'] {
  const next: NonNullable<LlmProviderConfig['thinking']> = { ...(cur ?? {}) };
  if (patch && typeof patch === 'object') {
    if (patch.levels !== undefined && typeof patch.levels === 'object' && patch.levels) {
      const levels: Partial<Record<GuiThinkingLevel, string>> = { ...(cur?.levels ?? {}) };
      const src = patch.levels as Record<string, unknown>;
      for (const key of GUI_THINKING_LEVELS) {
        if (src[key] === undefined) continue;
        const v = typeof src[key] === 'string' ? src[key].trim() : '';
        if (v) levels[key] = v;
        else delete levels[key];
      }
      if (Object.keys(levels).length > 0) next.levels = levels;
      else delete next.levels;
    }
    if (patch.reasoningEffortField !== undefined) {
      if (patch.reasoningEffortField === true) next.reasoningEffortField = true;
      else delete next.reasoningEffortField;
    }
    if (patch.thinkingFormat !== undefined) {
      const v = typeof patch.thinkingFormat === 'string' ? patch.thinkingFormat.trim() : '';
      if (!v) {
        delete next.thinkingFormat;
      } else if ((LLM_THINKING_FORMATS as readonly string[]).includes(v)) {
        next.thinkingFormat = v as LlmThinkingFormat;
      } else {
        throw new Error(`${t('无效的思考方言 thinkingFormat')}: ${v}`);
      }
    }
    if (patch.disableAtOff !== undefined) {
      if (patch.disableAtOff === true) next.disableAtOff = true;
      else delete next.disableAtOff;
    }
  }
  if (
    !next.levels &&
    next.reasoningEffortField === undefined &&
    !next.thinkingFormat &&
    !next.disableAtOff
  ) {
    return undefined;
  }
  return next;
}

function upsertProviderInto(
  llm: LlmConfig,
  args: Record<string, unknown>
): { provider: LlmProviderConfig; created: boolean } {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new Error(t('缺少服务商 id'));
  const idx = llm.providers.findIndex((p) => p.id === id);
  const created = idx < 0;
  const cur = created ? undefined : llm.providers[idx];

  const baseUrl = typeof args.baseUrl === 'string' && args.baseUrl.trim() ? args.baseUrl.trim() : cur?.baseUrl ?? '';
  if (!baseUrl) throw new Error(t('新建服务商必须提供 baseUrl'));

  const apiRaw = typeof args.api === 'string' ? args.api.trim() : '';
  if (apiRaw && !(API_PROTOCOLS as readonly string[]).includes(apiRaw)) {
    throw new Error(`${t('无效的 API 协议 api')}: ${apiRaw}`);
  }
  const api: LlmApiProtocol | undefined = apiRaw ? (apiRaw as LlmApiProtocol) : cur?.api;

  // apiKey 传空或掩码值 = 保留原值（工具结果里密钥永远是掩码，agent 拿不到明文）
  const keyRaw = typeof args.apiKey === 'string' ? args.apiKey.trim() : '';
  const apiKey = keyRaw && keyRaw !== API_KEY_MASK ? keyRaw : cur?.apiKey ?? '';

  let models = cur?.models ?? [];
  if (Array.isArray(args.models)) {
    const list = (args.models as Array<Record<string, unknown>>)
      .map((m): LlmProviderConfig['models'][number] | null => {
        const mid = typeof m?.id === 'string' ? m.id.trim() : '';
        if (!mid) return null;
        const old = cur?.models.find(model => model.id === mid);
        return {
          id: mid,
          ...(typeof m?.name === 'string' && m.name.trim() ? { name: m.name.trim() } : {}),
          ...(m.reasoning === true ? { reasoning: true } : {}),
          multimodal: typeof m.multimodal === 'boolean' ? m.multimodal : old?.multimodal,
          ...(typeof m.multimodal === 'boolean' || old?.multimodalExplicit ? { multimodalExplicit: true } : {}),
          attachments: mergeModelAttachmentPolicy(m.attachments, old?.attachments),
          ...(typeof m?.contextWindow === 'number' && m.contextWindow > 0
            ? { contextWindow: m.contextWindow }
            : {}),
          ...(typeof m?.maxTokens === 'number' && m.maxTokens > 0 ? { maxTokens: m.maxTokens } : {})
        };
      })
      .filter((m): m is LlmProviderConfig['models'][number] => m !== null);
    if (list.length > 0) models = list;
  }
  if (models.length === 0) models = [{ id: 'default', name: 'default' }];

  const thinking = mergeThinking(cur?.thinking, args.thinking as Record<string, unknown> | undefined);
  let compat = cur?.compat;
  if (args.compat !== undefined) {
    if (!args.compat || typeof args.compat !== 'object' || Array.isArray(args.compat)) throw new Error('compat must be an object');
    const patch = args.compat as Record<string, unknown>;
    if (Object.keys(patch).some(key => key !== 'supportsDeveloperRole')) throw new Error('Unknown compat field');
    if (patch.supportsDeveloperRole !== undefined) {
      if (patch.supportsDeveloperRole !== null && typeof patch.supportsDeveloperRole !== 'boolean')
        throw new Error('compat.supportsDeveloperRole must be boolean or null');
      compat = patch.supportsDeveloperRole === null ? undefined : { supportsDeveloperRole: patch.supportsDeveloperRole };
    }
  }
  const provider: LlmProviderConfig = {
    id,
    name:
      typeof args.name === 'string' && args.name.trim()
        ? args.name.trim()
        : cur?.name ?? id,
    baseUrl,
    apiKey,
    ...(api ? { api } : {}),
    models,
    ...(args.enabled === undefined
      ? { enabled: cur?.enabled ?? true }
      : { enabled: args.enabled === true }),
    ...(thinking ? { thinking } : {}),
    ...(compat ? { compat } : {})
  };
  return { provider, created };
}

/**
 * llm.*（模型服务商配置的 agent 受控读写通道）：
 * - 读恒脱敏（apiKey 掩码）；写走 ctx.config.update（自动同步 Pi 配置 + 失效会话）。
 * - 写操作在 catalog 标 dangerous，executor 强制 ui.confirm——headless 链路 120s
 *   超时自动拒绝，即无人值守改不了配置，这是刻意约束。
 */
export const llmHost = {
  'llm.listProviders': (ctx: AppContext) => {
    const llm = ctx.config.get().llm;
    return {
      activeProviderId: llm?.activeProviderId ?? '',
      activeModelId: llm?.activeModelId ?? '',
      providers: (llm?.providers ?? []).map(toPublicProvider)
    };
  },

  'llm.upsertProvider': (ctx: AppContext, args: Record<string, unknown>) => {
    const llm = structuredClone(ctx.config.get().llm ?? { providers: [], activeProviderId: '', activeModelId: '' });
    const { provider, created } = upsertProviderInto(llm, args);
    const idx = llm.providers.findIndex((p) => p.id === provider.id);
    if (idx >= 0) llm.providers[idx] = provider;
    else llm.providers.push(provider);
    if (!llm.activeProviderId) {
      // 无任何激活项时首个入库的服务商自动成为激活项，否则保持不动
      llm.activeProviderId = provider.id;
      llm.activeModelId = llm.activeModelId || provider.models[0]?.id || 'default';
    }
    // 总闸告警：思考分支在 pi-ai 侧挂在 model.reasoning 上，没标记就整段静默跳过
    const warnings: string[] = [];
    if (provider.thinking && !provider.models.some((m) => m.reasoning === true)) {
      warnings.push(
        t('配置了 thinking 但没有任何模型标记 reasoning=true，思考参数不会下发；请在 models 里给思考模型加 reasoning:true')
      );
    }
    if (provider.thinking?.disableAtOff && !thinkingEffect(provider).offCanDisable) {
      warnings.push(t('disableAtOff 仅 DeepSeek 系 completions 生效，该服务商/协议下不会生效'));
    }
    ctx.config.update({ llm });
    return {
      created,
      ...(warnings.length ? { warnings } : {}),
      activeProviderId: ctx.config.get().llm?.activeProviderId ?? '',
      note: created
        ? t('已新增；默认服务商未变化，切换请用 llm.setDefault')
        : t('已更新；默认服务商未变化，切换请用 llm.setDefault'),
      provider: toPublicProvider(provider)
    };
  },

  'llm.setDefault': (ctx: AppContext, args: { providerId?: string; modelId?: string }) => {
    const providerId = typeof args?.providerId === 'string' ? args.providerId.trim() : '';
    const modelId = typeof args?.modelId === 'string' ? args.modelId.trim() : '';
    if (!providerId) throw new Error(t('缺少 providerId'));
    const llm = structuredClone(ctx.config.get().llm ?? { providers: [], activeProviderId: '', activeModelId: '' });
    const provider = llm.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error(t('服务商不存在') + `: ${providerId}`);
    if (provider.enabled === false) throw new Error(t('服务商已禁用，请先在设置里启用') + `: ${providerId}`);
    const nextModel = modelId || provider.models[0]?.id || 'default';
    if (!provider.models.some((m) => m.id === nextModel)) {
      throw new Error(`${t('该服务商没有此模型')}: ${nextModel}`);
    }
    llm.activeProviderId = providerId;
    llm.activeModelId = nextModel;
    ctx.config.update({ llm });
    return {
      activeProviderId: providerId,
      activeModelId: nextModel,
      note: t('已切换默认服务商，后续对话/任务即用新配置')
    };
  },

  'llm.testConnection': (
    ctx: AppContext,
    args: {
      providerId?: string;
      baseUrl?: string;
      apiKey?: string;
      api?: string;
      model?: string;
      /** 思考探针：按当前协议带上指定思考参数发一条极小请求，回传 reasoning token 数。
       *  判断某档/写法是否被服务端真实接受请做差分（如 effort=low 与 max 各调一次比 reasoningTokens），
       *  官方文档多套写法并存且可能过时，探针结果是唯一裁决。 */
      thinkingProbe?: { effort?: string; thinking?: 'enabled' | 'disabled'; prompt?: string };
    }
  ) => {
    const providerId = typeof args?.providerId === 'string' ? args.providerId.trim() : '';
    let baseUrl = typeof args?.baseUrl === 'string' ? args.baseUrl.trim() : '';
    let apiKey = typeof args?.apiKey === 'string' ? args.apiKey.trim() : '';
    let api = typeof args?.api === 'string' ? args.api.trim() : '';
    let model = typeof args?.model === 'string' ? args.model.trim() : '';
    if (providerId) {
      const provider = ctx.config.get().llm?.providers.find((p) => p.id === providerId);
      if (!provider) throw new Error(t('服务商不存在') + `: ${providerId}`);
      baseUrl = baseUrl || provider.baseUrl;
      if (!apiKey || apiKey === API_KEY_MASK) apiKey = provider.apiKey;
      api = api || provider.api || 'openai-completions';
      model = model || ctx.config.get().llm?.activeModelId || provider.models[0]?.id || 'default';
    } else if (!baseUrl) {
      throw new Error(t('需要 providerId 或 baseUrl'));
    }
    if (args?.thinkingProbe && typeof args.thinkingProbe === 'object') {
      return probeThinking(baseUrl, apiKey, api || 'openai-completions', model, args.thinkingProbe);
    }
    return testLlmConnection({
      baseUrl,
      apiKey,
      ...(model ? { model } : {}),
      ...(api ? { api: api as LlmProviderConfig['api'] } : {})
    });
  },

  /**
   * R11：派活前配额预检。剩余额度本地不暴露（不调厂商计费 API）；
   * 近窗失败率合并扩展明细与 Pi Worker 请求观测，拆 401 / 429。
   */
  'llm.quota': (ctx: AppContext, args?: { providerId?: string }) => {
    const llm = ctx.config.get().llm;
    const providerId =
      (typeof args?.providerId === 'string' && args.providerId.trim()) || llm?.activeProviderId || '';
    const windowMs = normalizeQuotaWindowMs(ctx.config.get().pipeline?.quotaWindowMs);
    const samples: QuotaSample[] = ctx.usage.peekLlmCalls().map((c) => ({
      ok: c.ok,
      error: c.error,
      startedAt: c.startedAt,
      providerHint: c.model
    }));
    samples.push(...ctx.usage.peekModelCalls());
    const view = computeLlmQuota(samples, providerId, Date.now(), windowMs);
    return {
      ...view,
      note: t('remaining 为 unknown：不查询厂商计费接口；样本包括扩展调用与本次启动以来 Pi Worker 模型请求。resetAt 仅来自服务商明确的重置提示。')
    };
  }
};

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_TOKENS = 1024;
const PROBE_PROMPT_DEFAULT = '9.11 和 9.8 哪个大？请一步步推理后给出答案';

/**
 * 思考探针：completions 走 reasoning_effort/thinking:{type}，responses 系走 reasoning:{effort}；
 * 只带探针指定的字段，回传 reasoningTokens（不同协议 usage 形态不同，逐层取）。
 * 差分用法：effort=low 与 max 各调一次，reasoningTokens 有量级差 = 参数真实生效。
 */
async function probeThinking(
  baseUrl: string,
  apiKey: string,
  api: string,
  model: string,
  probe: { effort?: string; thinking?: string; prompt?: string }
): Promise<Record<string, unknown>> {
  if (!model) throw new Error(t('需要 providerId 或 baseUrl'));
  const responsesStyle = api === 'openai-responses' || api === 'azure-openai-responses';
  if (api !== 'openai-completions' && !responsesStyle) {
    throw new Error(t('思考探针仅支持 openai-completions / openai-responses 协议'));
  }
  const base = baseUrl.trim().replace(/\/+$/, '');
  const url = responsesStyle ? `${base}/responses` : `${base}/chat/completions`;
  const prompt = probe.prompt?.trim() || PROBE_PROMPT_DEFAULT;
  const extra: Record<string, unknown> = {};
  if (probe.effort?.trim()) {
    if (responsesStyle) extra.reasoning = { effort: probe.effort.trim() };
    else extra.reasoning_effort = probe.effort.trim();
  }
  if (probe.thinking === 'enabled' || probe.thinking === 'disabled') {
    extra.thinking = { type: probe.thinking };
  }
  const body = responsesStyle
    ? { model, input: prompt, max_output_tokens: PROBE_MAX_TOKENS, ...extra }
    : { model, messages: [{ role: 'user', content: prompt }], max_tokens: PROBE_MAX_TOKENS, ...extra };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, ...(text ? { error: text.slice(0, 600) } : {}) };
    }
    let usage: Record<string, Record<string, unknown>> = {};
    try {
      usage = (JSON.parse(text)?.usage ?? {}) as typeof usage;
    } catch {
      /* usage 缺失不阻塞探测结果 */
    }
    const details = (usage.completion_tokens_details ?? usage.output_tokens_details ?? {}) as Record<string, unknown>;
    const reasoningTokens = details.reasoning_tokens;
    return {
      ok: true,
      status: res.status,
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      outputTokens: usage.output_tokens ?? usage.completion_tokens
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, ...(aborted ? { error: t('探测超时') } : { error: (e as Error).message }) };
  } finally {
    clearTimeout(timer);
  }
}
