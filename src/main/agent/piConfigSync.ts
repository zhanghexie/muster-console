import fs from 'node:fs';
import path from 'node:path';
import { GUI_THINKING_LEVELS, type GuiThinkingLevel } from '../../shared/thinkingLevels';
import type { AppConfig, LlmConfig, LlmModelConfig, LlmProviderConfig, OpenAIConfig } from '../../shared/types';
import { detectGitBashPath } from '../shell/profiles';
import { writeTextAtomicSync } from '../atomicJson';
import { coreReasoningMatchesEndpoint, findCoreReasoning, findPublishedReasoning, localOllamaUrl, type CoreReasoningBinding, type CoreReasoningCatalog } from './coreReasoningCatalog';
import { piDefaultThinkingLevel, piThinkingLevels, projectPiReasoningModel, type PiReasoningModel } from './piReasoningCatalog';

export const PROVIDER_ID = 'muster';

/** ── pi-ai 内置目录快照（models.dev 同步；pi SDK 加载后注入，静态推断降为回落） ── */

export type { PiCatalogModel, PiCatalogProviderMeta } from '../../shared/piCatalog';
import type { PiCatalogModel, PiCatalogProviderMeta } from '../../shared/piCatalog';
import { DEFAULT_CORE_CONTEXT_WINDOW, PI_ACCOUNT_ENDPOINT_EXAMPLES, PI_PUBLIC_BASE_URLS, indexModelInputSpecifications,
  piAccountEndpoint, piAccountModelBaseUrl, piProviderPresetId, resolveCoreModelInput,
  type PublishedModelInputSpecification } from '../../shared/piCatalog';

/** providerId -> modelId -> 默认值 */
export type PiCatalogSnapshot = Record<string, Record<string, PiCatalogModel>>;

let piCatalog: PiCatalogSnapshot | null = null;
let piCatalogProviders: PiCatalogProviderMeta[] | null = null;
let piNative = new Map<string, Map<string, PiReasoningModel>>();
let piGeneratedAt: number | undefined;
let publishedModelInput: readonly PublishedModelInputSpecification[] | undefined;
let publishedModelInputIndex = indexModelInputSpecifications();

export function setPublishedModelInputSpecifications(rows: readonly PublishedModelInputSpecification[] | undefined): void {
  if (rows === publishedModelInput) return;
  publishedModelInput = rows;
  publishedModelInputIndex = indexModelInputSpecifications(rows);
}

/** 注入/清除目录快照（测试与 primePiCatalogSnapshot 消费）；null = 回落静态推断 */
export function setPiCatalogSnapshot(
  snapshot: PiCatalogSnapshot | null,
  providers?: PiCatalogProviderMeta[] | null
): void {
  piCatalog = snapshot;
  piCatalogProviders = providers ?? null;
  piNative.clear();
  piGeneratedAt = undefined;
}

let catalogPrimed = false;

/**
 * 从 pi-ai 内置目录（models.dev 同步的生成数据）构建快照并注入（失败不置幂等标记，
 * 下次调用重试；目录增益不可用时行为与旧版一致）。piProvider / pi driver 在
 * syncPiConfigFromApp 前调用；config.ts、orchestrator 的早期 sync（pi 尚未加载）走
 * 回落，任一会话建立后自然生效。
 * dep：测试注入真目录模块（单文件转译环境里 import() 会被编译成 require() 而
 * pi-ai 的 exports 仅开放 import 条件，宿主内动态 import 生产可用、转译测试不可用）。
 */
export async function primePiCatalogSnapshot(
  dep?: {
    getBuiltinProviders: () => readonly string[];
    getBuiltinModels: (provider: string) => readonly unknown[];
    builtinProviders?: () => readonly unknown[];
    getBuiltinModelDataGeneratedAt?: () => number | undefined;
  }
): Promise<void> {
  if (catalogPrimed) return;
  try {
    const catalog = dep ?? (await import('@earendil-works/pi-ai/providers/all') as unknown as NonNullable<typeof dep>);
    if (!catalog || typeof catalog.getBuiltinProviders !== 'function') return;
    const snap: PiCatalogSnapshot = {};
    const native = new Map<string, Map<string, PiReasoningModel>>();
    const providerApis = new Map<string, string>();
    for (const prov of catalog.getBuiltinProviders()) {
      const nativeModels = new Map<string, PiReasoningModel>();
      native.set(prov, nativeModels);
      for (const raw of catalog.getBuiltinModels?.(prov) ?? []) {
        const m = raw as {
          id?: string; name?: string; api?: string; cost?: PiCatalogModel['cost'];
          contextWindow?: number; maxTokens?: number; input?: ('text' | 'image')[];
          reasoning?: boolean; thinkingLevelMap?: Record<string, string | null>;
        };
        if (!m.id) continue;
        const nativeModel = projectPiReasoningModel(raw, prov);
        if (nativeModel) nativeModels.set(m.id, nativeModel);
        if (m.api && !providerApis.has(prov)) providerApis.set(prov, m.api);
        const entry = (snap[prov] ??= {});
        if (entry[m.id]) continue;
        entry[m.id] = {
          ...(m.name ? { name: m.name } : {}),
          ...(m.api ? { api: m.api } : {}),
          ...(nativeModel?.baseUrl ? { baseUrl: nativeModel.baseUrl } : {}),
          ...(m.cost ? { cost: m.cost } : {}),
          ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
          ...(typeof m.maxTokens === 'number' ? { maxTokens: m.maxTokens } : {}),
          ...(Array.isArray(m.input) ? { input: m.input } : {}),
          ...(typeof m.reasoning === 'boolean' ? { reasoning: m.reasoning } : {}),
          ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {})
        };
      }
    }
    piCatalog = snap;
    piNative = native;
    piGeneratedAt = catalog.getBuiltinModelDataGeneratedAt?.();
    if (typeof catalog.builtinProviders === 'function') {
      const metas: PiCatalogProviderMeta[] = [];
      for (const raw of catalog.builtinProviders()) {
        const p = raw as { id?: string; name?: string; baseUrl?: string; auth?: Record<string, unknown> };
        if (!p?.id) continue;
        const baseUrl = p.baseUrl || (Object.hasOwn(PI_PUBLIC_BASE_URLS, p.id) ? PI_PUBLIC_BASE_URLS[p.id] : undefined);
        metas.push({
          id: p.id,
          name: p.name || p.id,
          ...(providerApis.has(p.id) ? { api: providerApis.get(p.id) } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(Object.hasOwn(PI_ACCOUNT_ENDPOINT_EXAMPLES, p.id) ? { accountEndpointExample: PI_ACCOUNT_ENDPOINT_EXAMPLES[p.id] } : {}),
          authMethods: p.auth && typeof p.auth === 'object' ? Object.keys(p.auth) : ['apiKey']
        });
      }
      piCatalogProviders = metas;
    }
    catalogPrimed = true; // 成功才置：失败（如目录模块不可用）下次调用重试
  } catch {
    /* 回落静态推断 */
  }
}

/** UI 目录视图：providers（含元数据与模型清单），未 prime 时返回 null（UI 回落静态 preset） */
export function getPiCatalogForUi(): import('../../shared/piCatalog').PiCatalogView | null {
  if (!piCatalog && !publishedModelInput) return null;
  const catalog = piCatalog ?? {};
  const metas = piCatalogProviders ?? Object.keys(catalog).map((id) => ({ id, name: id, authMethods: ['apiKey'] }));
  return {
    providers: metas.map((meta) => ({
      ...meta,
      models: Object.entries(catalog[meta.id] ?? {}).map(([id, m]) => ({ id, ...m }))
    })),
    ...(publishedModelInput ? { capabilities: publishedModelInput } : {})
  };
}

/** openai-completions 端点 /v1 归一化（真源 shared/piCatalog，探针/设置页目录判定共用） */
export { normalizePiBaseUrl } from '../../shared/piCatalog';
import { normalizeAnthropicBaseUrl, normalizePiBaseUrl } from '../../shared/piCatalog';

export interface PiSyncResult {
  providerId: string;
  modelId: string;
  agentDir: string;
  providers: string[];
  providerDefaultOutput?: Array<{ provider: string; id: string }>;
}

function extractLlmProviders(
  input: AppConfig | LlmConfig | OpenAIConfig
): { providers: LlmProviderConfig[]; activeProviderId: string; activeModelId: string } {
  if ('llm' in input && input.llm?.providers?.length) {
    return {
      providers: input.llm.providers,
      activeProviderId: input.llm.activeProviderId,
      activeModelId: input.llm.activeModelId
    };
  }
  if ('providers' in input && Array.isArray(input.providers) && input.providers.length) {
    return {
      providers: input.providers,
      activeProviderId: input.activeProviderId || input.providers[0].id,
      activeModelId: input.activeModelId || input.providers[0].models[0]?.id || 'default'
    };
  }
  // 单个 OpenAIConfig 回退
  const openai = 'openai' in input ? input.openai : (input as OpenAIConfig);
  const baseUrl = openai.baseUrl || 'https://api.deepseek.com';
  const apiKey = openai.apiKey || '';
  const modelId = (openai.model || 'deepseek-chat').trim();
  const provId = /deepseek\.com/i.test(baseUrl) ? 'deepseek' : PROVIDER_ID;
  const provName = provId === 'deepseek' ? 'DeepSeek' : 'Muster Console';
  const provider: LlmProviderConfig = {
    id: provId,
    name: provName,
    baseUrl,
    apiKey,
    models: [{ id: modelId, name: modelId }],
    enabled: true
  };
  return {
    providers: [provider],
    activeProviderId: provId,
    activeModelId: modelId
  };
}

export function inferModelSyncDefaults(
  id: string,
  explicit?: {
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    multimodal?: boolean;
  },
  /** SDK output limits, costs, and reasoning metadata. */
  catalog?: PiCatalogModel | null
): {
  contextWindow: number;
  maxTokens: number;
  knownOutputLimit: boolean;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Record<string, string | null>;
} {
  const lower = id.toLowerCase();
  const isReasoning =
    explicit?.reasoning ?? catalog?.reasoning ?? (/reasoner|r1|o1|o3|mimo-v2|thinking/i.test(lower) && !/omni/i.test(lower));
  const isMultimodal = explicit?.multimodal ?? catalog?.input?.includes('image') ?? true;

  let defaultMaxTokens = 8192;

  let knownOutputLimit = !!(explicit?.maxTokens || catalog?.maxTokens);
  if (lower === 'qwen4-max-preview') {
    // Model Studio publishes a single budget shared by thinking and final output.
    defaultMaxTokens = 393216;
    knownOutputLimit = true;
  } else if (/mimo-v2\.5|mimo-v2-pro|mimo-v2\.5-pro/i.test(lower)) {
    defaultMaxTokens = 131072;
    knownOutputLimit = true;
  } else if (/mimo-v2-flash|mimo-v2-omni/i.test(lower)) {
    defaultMaxTokens = 65536;
    knownOutputLimit = true;
  } else if (/claude|o1|o3/i.test(lower)) {
    defaultMaxTokens = 65536;
  }

  return {
    contextWindow: explicit?.contextWindow || catalog?.contextWindow || DEFAULT_CORE_CONTEXT_WINDOW,
    maxTokens: explicit?.maxTokens || catalog?.maxTokens || defaultMaxTokens,
    knownOutputLimit,
    reasoning: isReasoning,
    input: isMultimodal ? ['text', 'image'] : ['text'],
    cost: catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(catalog?.thinkingLevelMap ? { thinkingLevelMap: catalog.thinkingLevelMap } : {})
  };
}

/** Same-name compatibility for pricing, output budgets and reasoning hints. */
export function getPiCatalogModel(providerId: string, modelId: string): PiCatalogModel | null {
  if (!piCatalog) return null;
  const id = modelId.trim();
  const own = piCatalog[providerId]?.[id];
  if (own) return own;
  for (const models of Object.values(piCatalog)) {
    const hit = models[id];
    if (hit) return hit;
  }
  return null;
}

function configuredPiCatalogMeta(id: string) {
  return piCatalogProviders?.find(meta => meta.id === id) ?? piCatalogProviders?.find(meta => meta.id === piProviderPresetId(id));
}

export function getConfiguredModelSyncDefaults(provider: LlmProviderConfig, model: LlmModelConfig) {
  const meta = configuredPiCatalogMeta(provider.id);
  const bundled = piCatalog?.[meta?.id ?? piProviderPresetId(provider.id)]?.[model.id];
  const input = resolveCoreModelInput(provider, model, publishedModelInputIndex.get(model.id), bundled, meta);
  return { ...inferModelSyncDefaults(model.id, { ...model, contextWindow: input.contextWindow, multimodal: input.multimodal },
    getPiCatalogModel(provider.id, model.id)), catalogInput: input.catalogInput };
}

function verifiedPiCatalogProvider(provider: Pick<LlmProviderConfig, 'id' | 'baseUrl'>): boolean {
  const endpoint = configuredPiCatalogMeta(provider.id)?.baseUrl;
  return !!endpoint && normalizePiBaseUrl(endpoint) === normalizePiBaseUrl(provider.baseUrl);
}

/** Locate the same registered model endpoint used by SDK sync and by the capability resolver. */
function configuredPiModelRoute(provider: LlmProviderConfig, modelId: string) {
  const meta = configuredPiCatalogMeta(provider.id);
  const id = meta?.id ?? provider.id;
  const bundled = piNative.get(id)?.get(modelId);
  const account = meta?.accountEndpointExample && piAccountEndpoint(id, provider.baseUrl);
  const fixed = verifiedPiCatalogProvider(provider);
  const accountUrl = account && bundled && piAccountModelBaseUrl(id, account, bundled.api);
  if (bundled && (fixed || accountUrl)) return { id, api: bundled.api, baseUrl: accountUrl || bundled.baseUrl,
    compat: bundled.compat, account: Boolean(accountUrl) };
  // Test snapshots and legacy providers without complete metadata retain the SDK's inherited API.
  if (!meta?.accountEndpointExample && (!meta?.baseUrl || fixed) && piCatalog?.[id]?.[modelId]?.api) {
    return { id, api: piCatalog[id][modelId].api!, baseUrl: provider.baseUrl, account: false };
  }
}

export async function piReasoningSources(getConfig: () => AppConfig) {
  await primePiCatalogSnapshot();
  const ids = new Set<string>();
  const local: Array<{ providerId: string; baseUrl: string; modelId: string }> = [];
  for (const provider of extractLlmProviders(getConfig()).providers) {
    if (provider.enabled === false) continue;
    if (piProviderPresetId(provider.id) === 'ollama' && (!provider.api || provider.api === 'openai-completions') && localOllamaUrl(provider.baseUrl.trim())) {
      for (const model of provider.models) local.push({ providerId: provider.id, baseUrl: provider.baseUrl, modelId: model.id });
    }
    const id = configuredPiCatalogMeta(provider.id)?.id ?? provider.id;
    if (piNative.has(id)) ids.add(id);
    else for (const meta of piCatalogProviders ?? []) {
      if (verifiedPiCatalogProvider({ ...provider, id: meta.id })) ids.add(meta.id);
    }
  }
  return { providers: [...ids], generatedAt: piGeneratedAt, local };
}

export function getConfiguredCoreReasoning(catalog: CoreReasoningCatalog | undefined,
  provider: LlmProviderConfig, model: LlmModelConfig): CoreReasoningBinding | undefined {
  const route = configuredPiModelRoute(provider, model.id);
  const protocol = route?.api ?? provider.api ?? 'openai-completions';
  const baseUrl = route?.baseUrl ?? provider.baseUrl;
  const published = findCoreReasoning(catalog, { id: provider.id, baseUrl }, protocol, model.id);
  if (published) return published;
  if (userPiThinkingMap(provider)) return; // Existing explicitly configured mappings retain their semantics.
  const local = catalog?.local?.find(entry => entry.providerId === provider.id && coreReasoningMatchesEndpoint(entry, baseUrl, protocol, model.id));
  if (local) return local;
  const extra = findPublishedReasoning(catalog?.extra, { id: provider.id, baseUrl }, protocol, model.id);
  if (extra) return extra;

  const match = (candidate: PiReasoningModel | undefined, id: string) => candidate &&
    ((route?.account && route.id === id && candidate.api === protocol) ||
      coreReasoningMatchesEndpoint({ baseUrl: candidate.baseUrl, protocol: candidate.api, modelId: candidate.id }, baseUrl, protocol, model.id));
  const lookup = (id: string) => {
    const shard = catalog?.pi?.[id];
    const live = shard && Object.hasOwn(shard, model.id) ? shard[model.id] : undefined;
    if (match(live, id)) return live;
    const bundled = piNative.get(id)?.get(model.id);
    if (match(bundled, id)) return bundled;
    const published = catalog?.publishedPi?.[id];
    const row = published && Object.hasOwn(published, model.id) ? published[model.id] : undefined;
    return match(row, id) ? row : undefined;
  };
  let exact = lookup(route?.id ?? provider.id);
  if (!exact) {
    const aliases = [...piNative.keys()].flatMap(id => {
      const entry = id === provider.id ? undefined : lookup(id);
      return entry ? [entry] : [];
    });
    if (aliases.length === 1) [exact] = aliases;
  }
  if (!exact?.reasoning) return;
  const levels = piThinkingLevels(exact);
  const effort = levels.filter(level => level !== 'off');
  if (!effort.length) return;
  const canDisable = levels.includes('off');
  const defaultEffort = piDefaultThinkingLevel(levels);
  return { providerId: provider.id, baseUrl, protocol, modelId: model.id,
    reasoning: { effort, canDisable, defaultEffort },
    native: { thinkingLevelMap: exact.thinkingLevelMap, compat: exact.compat } };
}

/** 与同步给 Pi 的用户映射共用同一口径；未配置时交由模型目录决定。 */
function userPiThinkingMap(p: LlmProviderConfig): Record<string, string | null> | null {
  const levels = p.thinking?.levels;
  if (!levels) return null;
  const map: Record<string, string | null> = {};
  let any = false;
  for (const key of GUI_THINKING_LEVELS) {
    const value = levels[key]?.trim();
    map[key] = value || null;
    if (value) any = true;
  }
  const isDeepSeek = p.id === 'deepseek' || /deepseek\.com/i.test(p.baseUrl) ||
    p.thinking?.thinkingFormat === 'deepseek';
  if (p.thinking?.disableAtOff && !map.off && (p.api || 'openai-completions') === 'openai-completions' && isDeepSeek) {
    map.off = 'disabled';
    any = true;
  }
  return any ? map : null;
}

/**
 * 旧版自定义供应商映射。未核验端点不能借用其他服务商的同名档位。
 */
export function getConfiguredPiThinkingLevels(
  provider: LlmProviderConfig,
  model: LlmModelConfig
): GuiThinkingLevel[] | null {
  const catalog = getPiCatalogModel(provider.id, model.id);
  const explicitModel = provider.models.find((item) => item.id === model.id);
  if (!(explicitModel?.reasoning ?? catalog?.reasoning ?? model.reasoning)) return [];
  const userMap = userPiThinkingMap(provider);
  return userMap ? GUI_THINKING_LEVELS.filter(level => userMap[level] !== null) : null;
}

/**
 * 把工作台 LLM 服务商与模型同步到 Muster Core 的 models.json 和 auth.json，供 Pi SDK 使用。
 * 支持多 Provider 与多 Model 同时注册，支持 Pi SDK 无缝按 ID 调用任一模型。
 */
export function syncPiConfigFromApp(
  input: AppConfig | LlmConfig | OpenAIConfig,
  dir: string
): PiSyncResult {
  fs.mkdirSync(dir, { recursive: true });

  const { providers, activeProviderId, activeModelId } = extractLlmProviders(input);

  const syncedProviderIds: string[] = [];
  const providerDefaultOutput: NonNullable<PiSyncResult['providerDefaultOutput']> = [];

  // 读取现有 models.json（避免抹掉外部手动配置的其它 provider）。
  // model-providers F-04：损坏（半写/磁盘异常/外部改坏）时若按空配置合并落盘，会把用户
  // 手工配置的外部 provider 全部抹掉——读失败保留文件现状并跳过本次同步；缺文件属首启按空起步。
  const modelsPath = path.join(dir, 'models.json');
  const authPath = path.join(dir, 'auth.json');
  let existingModels: { providers?: Record<string, unknown> } = {};
  try {
    existingModels = JSON.parse(fs.readFileSync(modelsPath, 'utf-8')) as {
      providers?: Record<string, unknown>;
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[piConfigSync] models.json 读取/解析失败，跳过本次同步以保护外部手工配置:', (err as Error).message);
      return { providerId: activeProviderId, modelId: activeModelId, agentDir: dir, providers: [] };
    }
  }
  const mergedProviders: Record<string, unknown> = { ...(existingModels.providers || {}) };

  // 读取现有 auth.json；损坏同样跳过本次同步，不当作空配置整写
  let auth: Record<string, unknown> = {};
  try {
    auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[piConfigSync] auth.json 读取/解析失败，跳过本次同步以保护外部手工配置:', (err as Error).message);
      return { providerId: activeProviderId, modelId: activeModelId, agentDir: dir, providers: [] };
    }
  }

  for (const p of providers) {
    if (p.enabled === false) continue;
    const provId = p.id.trim() || PROVIDER_ID;
    const apiProtocol = p.api || 'openai-completions';
    // Native protocols keep their own path (for example Gemini's /v1beta).
    let baseUrl = p.baseUrl.trim().replace(/\/+$/, '');
    if (['openai-completions', 'openai-responses', 'azure-openai-responses'].includes(apiProtocol)) baseUrl = normalizePiBaseUrl(baseUrl);
    if (apiProtocol === 'anthropic-messages') baseUrl = normalizeAnthropicBaseUrl(baseUrl);
    const apiKey = p.apiKey?.trim() ?? '';
    syncedProviderIds.push(provId);

    const isXiaomi =
      provId === 'xiaomi' || /xiaomimimo|mimo\.mi\.com|api\.xiaomi\.com/i.test(baseUrl);
    // 用户配置的思考档映射（设置 → 模型服务商）：产品五档 → 服务商载荷值；
    // 空值=该档不可用（null）；全空视为未配置。允许重复映射（服务商三档 ↔ 产品五档）。
    const userThinking = p.thinking ?? null;
    const userThinkingMap = userPiThinkingMap(p);

    const userModels = p.models?.length ? p.models : [{ id: 'default', name: 'default' }];
    const catalogModels = piCatalog?.[provId];
    const catalogMeta = configuredPiCatalogMeta(provId);
    const accountEndpoint = catalogMeta?.accountEndpointExample ? piAccountEndpoint(provId, p.baseUrl) : undefined;
    // F-03：目录判定加「端点与目录一致」条件。存量用户在目录化之前用旧 preset id
    // （deepseek/zhipu 等）建过指向企业网关/反代的自定义 provider：仅凭 id 命中就收编，
    // 目录分支会丢弃 p.api 与用户思考映射（端点/协议被静默替换且 UI 无路可改）。
    // 端点不一致按自定义 provider 处理（保留 api/thinking，模型写全量条目）；
    // 目录 meta 未带官方端点时无从比对，维持目录判定不回归。
    const verifiedCatalogEndpoint = verifiedPiCatalogProvider(p) || Boolean(accountEndpoint);
    const isCatalogProvider = !!catalogModels && (verifiedCatalogEndpoint || (!catalogMeta?.baseUrl && !catalogMeta?.accountEndpointExample));

    const resolveEntry = (m: LlmModelConfig) => {
      const id = m.id.trim();
      const def = getConfiguredModelSyncDefaults(p, { ...m, id });
      if (!def.knownOutputLimit) providerDefaultOutput.push({ provider: provId, id });
      // 思考档：用户五档映射是全量契约（留空=该档不可用），整表生效不做目录合并；
      // 未配置时目录 map 为默认，均无保留小米 MiMo 特判
      const levelMap = userThinkingMap
        ? userThinkingMap
        : def.thinkingLevelMap ??
          (isXiaomi && apiProtocol === 'openai-completions' && def.reasoning ? { off: null } : undefined);
      return {
        id,
        name: (m.name || m.id).trim(),
        reasoning: def.reasoning,
        input: def.input,
        contextWindow: def.contextWindow,
        maxTokens: def.maxTokens,
        cost: def.cost,
        ...(levelMap ? { thinkingLevelMap: levelMap } : {})
      };
    };

    // Catalog models keep their declared capabilities. Custom endpoints have no
    // developer-role contract: use standard system instructions unless explicitly
    // supported. Never infer that support from a vendor name or URL substring.
    const isCompletions = apiProtocol === 'openai-completions';
    const userCompat: Record<string, unknown> = {
      ...(isCompletions && !verifiedCatalogEndpoint ? { supportsDeveloperRole: false } : {}),
      ...(isCompletions && typeof p.compat?.supportsDeveloperRole === 'boolean'
        ? { supportsDeveloperRole: p.compat.supportsDeveloperRole }
        : {}),
      ...(isCompletions && typeof userThinking?.reasoningEffortField === 'boolean'
        ? { supportsReasoningEffort: userThinking.reasoningEffortField }
        : {}),
      ...(isCompletions && userThinking?.thinkingFormat
        ? { thinkingFormat: userThinking.thinkingFormat }
        : {})
    };

    if (isCatalogProvider) {
      // 官方端点的目录内模型按字段继承 SDK 能力，目录外模型仍写全量条目。
      // overrides 只写显式配置与已核验的端点规格；其余字段由 SDK 目录继承。
      // 协议与 compat 由目录自带，旧配置里残留的 p.api 不再透传（目录说了算）。
      const overrides: Record<string, Record<string, unknown>> = {};
      const offCatalog: unknown[] = [];
      for (const m of userModels) {
        const entry = resolveEntry(m);
        const route = configuredPiModelRoute(p, entry.id);
        if (route?.account && catalogMeta?.id === 'cloudflare-ai-gateway') {
          offCatalog.push({ ...entry, api: route.api, baseUrl: route.baseUrl, compat: route.compat });
        } else if (catalogModels[entry.id]) {
          const bundled = catalogModels[entry.id];
          const explicit: Record<string, unknown> = {};
          if (entry.name !== entry.id) explicit.name = entry.name;
          if (entry.contextWindow !== bundled.contextWindow) explicit.contextWindow = entry.contextWindow;
          if (m.maxTokens) explicit.maxTokens = entry.maxTokens;
          if (m.reasoning !== undefined) explicit.reasoning = entry.reasoning;
          if (entry.input.includes('image') !== bundled.input?.includes('image')) explicit.input = entry.input;
          // 目录自带 map 不写进 overrides（写=钉死目录值）；仅用户配置过思考档时写合并结果
          if (userThinkingMap && entry.thinkingLevelMap) explicit.thinkingLevelMap = entry.thinkingLevelMap;
          if (Object.keys(explicit).length) overrides[entry.id] = explicit;
        } else {
          offCatalog.push({ ...entry, api: apiProtocol, baseUrl,
            ...(isCompletions && p.compat?.supportsDeveloperRole === undefined ? { compat: { supportsDeveloperRole: false } } : {}) });
        }
      }
      mergedProviders[provId] = {
        // Preserve per-model endpoints (one provider can mix native protocols).
        ...(accountEndpoint && catalogMeta?.id !== 'cloudflare-ai-gateway' ? { baseUrl: accountEndpoint } :
          !verifiedCatalogEndpoint || !piNative.get(provId)?.size ? { baseUrl } : {}),
        apiKey: apiKey || 'missing',
        authHeader: true,
        ...(Object.keys(userCompat).length ? { compat: userCompat } : {}),
        ...(offCatalog.length ? { models: offCatalog } : {}),
        ...(Object.keys(overrides).length ? { modelOverrides: overrides } : {})
      };
    } else {
      // 自定义 provider：逐模型按 id 抄目录同名默认值（价格/窗口/多模态/思考档随目录走），
      // 未命中回落静态正则（与旧版行为一致）；小米镜像补 DeepSeek 系方言（用户显式方言压过默认）
      const modelsList = userModels.map((m) => {
        const entry = resolveEntry(m);
        const route = configuredPiModelRoute(p, entry.id);
        return route ? { ...entry, api: route.api, baseUrl: route.baseUrl, compat: route.compat } : entry;
      });
      const compat: Record<string, unknown> = {
        ...(isXiaomi && isCompletions
          ? {
              requiresReasoningContentOnAssistantMessages: true,
              thinkingFormat: 'deepseek'
            }
          : {}),
        ...userCompat
      };
      mergedProviders[provId] = {
        baseUrl,
        api: apiProtocol,
        apiKey: apiKey || 'missing',
        authHeader: true,
        ...(Object.keys(compat).length ? { compat } : {}),
        models: modelsList
      };
    }

    if (apiKey) {
      auth[provId] = { type: 'api_key', key: apiKey };
    }
  }

  // F-04②：writeFileSync 非原子，中断窗口留下半截 JSON（正好触发上面的整写抹配置）——改原子写
  writeTextAtomicSync(modelsPath, JSON.stringify({ providers: mergedProviders }, null, 2));
  writeTextAtomicSync(authPath, JSON.stringify(auth, null, 2));

  syncPiShellPath(dir);
  syncPiRetrySettings(dir);

  return {
    providerId: activeProviderId,
    modelId: activeModelId,
    agentDir: dir,
    ...(providerDefaultOutput.length ? { providerDefaultOutput } : {}),
    providers: syncedProviderIds
  };
}

/**
 * 同步 shellPath 到 Muster Core 的 settings.json（合并写，保留用户其余键）。
 * Pi 的 bash 工具只认标准安装位置 / PATH；自定义安装盘（如 D:\Git）下
 * PATH 首个 bash 还是 WSL 占位 stub，会一直报 "No bash shell found"。
 *
 * 解冻结（评审返工②）：宿主同步值带 shellPathAuto 标记，探测结果变化时
 * 原地覆盖——否则首次同步后路径永久冻结，Git 挪盘后设置页新手工值永不生效。
 * 无标记的已有值视为用户手工：活着就尊重；死值（卸载/挪盘）无论是否标记
 * 都让位最新探测，避免死路径冻结住可用 shell。
 */
export function syncPiShellPath(dir: string): void {
  if (process.platform !== 'win32') return;
  const bash = detectGitBashPath();
  if (!bash) return;
  const settingsPath = path.join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  const existing = typeof settings.shellPath === 'string' ? settings.shellPath.trim() : '';
  if (existing) {
    const live = fs.existsSync(existing);
    const hostSynced = settings.shellPathAuto === true;
    if (live && !hostSynced) return; // 用户手工配置且路径仍存在：尊重
    if (live && existing === bash) return; // 已是最新（含宿主同步值未变）
    // 死值（Git 挪盘/卸载）或历史宿主同步值≠最新探测：覆盖，不冻结
  }
  settings.shellPath = bash;
  settings.shellPathAuto = true;
  fs.mkdirSync(dir, { recursive: true });
  writeTextAtomicSync(settingsPath, JSON.stringify(settings, null, 2));
}

/** 应用下发的请求级重试预算：6 次 × 2s 指数退避 ≈ 累计 126s，扛住短瞬断窗口 */
export const PI_RETRY_MAX_RETRIES = 6;
export const PI_RETRY_BASE_DELAY_MS = 2000;

/**
 * 同步请求级重试预算到 Muster Core 的 settings.json（合并写，保留用户其余键）。
 * 背景：本机跑重测试链时 LLM SSE 流会被整窗掐断（每次请求瞬败），pi 默认
 * 3 次 × 2s 只能扛 ~16 秒；放宽后单回合可跨 ~2 分钟窗口，分钟级窗口由调度
 * 回合级自动重试兜底（orchestrator/turnRetry）。用户手工配过 retry.maxRetries
 * 或显式 enabled:false 则尊重手工值。
 */
export function syncPiRetrySettings(dir: string): void {
  const settingsPath = path.join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  const existing = settings.retry;
  if (
    existing &&
    typeof existing === 'object' &&
    (typeof (existing as Record<string, unknown>).maxRetries === 'number' ||
      (existing as Record<string, unknown>).enabled === false)
  ) {
    // 用户手工配过 retry（限了次数或显式关闭）都尊重，不强制改回
    return;
  }
  if (
    existing &&
    typeof existing === 'object' &&
    (existing as Record<string, unknown>).enabled === true &&
    (existing as Record<string, unknown>).maxRetries === PI_RETRY_MAX_RETRIES &&
    (existing as Record<string, unknown>).baseDelayMs === PI_RETRY_BASE_DELAY_MS
  ) {
    return;
  }
  settings.retry = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    enabled: true,
    maxRetries: PI_RETRY_MAX_RETRIES,
    baseDelayMs: PI_RETRY_BASE_DELAY_MS
  };
  fs.mkdirSync(dir, { recursive: true });
  writeTextAtomicSync(settingsPath, JSON.stringify(settings, null, 2));
}
