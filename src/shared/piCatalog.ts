/**
 * pi-ai 内置目录的共享形状（models.dev 同步；主进程 prime 后经 IPC 供设置页消费）。
 * 主进程 piConfigSync 与设置页共用端点匹配和默认规格解析。
 */
import type { LlmModelConfig } from './types';

export const DEFAULT_CORE_CONTEXT_WINDOW = 1_000_000;
export const MODEL_INPUT_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const;
export type ModelInputModality = typeof MODEL_INPUT_MODALITIES[number];

export interface ModelInputSpecification {
  readonly contextWindow?: number;
  readonly input?: readonly ModelInputModality[];
}

export interface PublishedModelInputSpecification extends ModelInputSpecification {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly protocol: string;
  readonly modelId: string;
  readonly sources: readonly string[];
  readonly verified?: true;
}

/** 目录单模型默认值（只取消费面字段；来源 pi-ai Model） */
export interface PiCatalogModel {
  name?: string;
  api?: string;
  baseUrl?: string;
  /** USD / 百万 token */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  input?: ('text' | 'image')[];
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

/** 目录 provider 元数据（添加供应商菜单与一键预填用） */
export interface PiCatalogProviderMeta {
  id: string;
  name: string;
  /** 官方端点（zai 等含完整路径，勿再拼 /v1） */
  baseUrl?: string;
  /** An endpoint that contains the user's resource, region, or account. */
  accountEndpointExample?: string;
  /** Native catalog API; model-list refresh must use the provider's actual protocol. */
  api?: string;
  /** 认证方式（apiKey / oauth）；UI 一键添加仅放行含 apiKey 的 */
  authMethods: string[];
}

export function piProviderPresetId(id: string): string {
  return id.replace(/_\d+$/, '');
}

// Pi registers these providers but does not set a provider-wide base URL.
export const PI_PUBLIC_BASE_URLS: Readonly<Record<string, string>> = {
  opencode: 'https://opencode.ai/inference',
  'opencode-go': 'https://opencode.ai/inference/go',
  radius: 'https://radius.pi.dev/v1'
};

export const PI_ACCOUNT_ENDPOINT_EXAMPLES: Readonly<Record<string, string>> = {
  'amazon-bedrock': 'https://bedrock-runtime.us-east-1.amazonaws.com',
  azure: 'https://{resource}.openai.azure.com/openai/v1',
  'cloudflare-ai-gateway': 'https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat',
  'cloudflare-workers-ai': 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
  'google-vertex': 'https://aiplatform.googleapis.com'
};

/** Verify a configured account URL. Only a Pi model route supplies the protocol. */
export function piAccountEndpoint(id: string, baseUrl: string): string | undefined {
  const url = URL.parse(baseUrl.trim());
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return;
  const path = url.pathname.replace(/\/+$/, '');
  const host = url.hostname;
  switch (piProviderPresetId(id)) {
    case 'amazon-bedrock':
      if (path || !/^bedrock-runtime\.[a-z]{2}(?:-[a-z]+)+-\d\.amazonaws\.com(?:\.cn)?$/.test(host)) return;
      break;
    case 'azure':
      if (!/^[a-z0-9][a-z0-9-]*\.openai\.azure\.com$/.test(host) || !['', '/openai', '/openai/v1'].includes(path)) return;
      return `${url.origin}/openai/v1`;
    case 'cloudflare-ai-gateway':
      if (host !== 'gateway.ai.cloudflare.com' || !/^\/v1\/[0-9a-f]{32}\/[a-zA-Z0-9_-]+(?:\/(?:compat|anthropic|openai))?$/.test(path)) return;
      return `${url.origin}${path.replace(/\/(?:compat|anthropic|openai)$/, '')}`;
    case 'cloudflare-workers-ai':
      if (host !== 'api.cloudflare.com' || !/^\/client\/v4\/accounts\/[0-9a-f]{32}\/ai\/v1$/.test(path)) return;
      break;
    case 'google-vertex':
      if (path || !/^(?:[a-z]+(?:-[a-z0-9]+)*-)?aiplatform\.googleapis\.com$/.test(host)) return;
      break;
    default:
      return;
  }
  return `${url.origin}${path}`;
}

export function piAccountModelBaseUrl(id: string, endpoint: string, api: string): string | undefined {
  if (piProviderPresetId(id) !== 'cloudflare-ai-gateway') return endpoint;
  const suffix = api === 'openai-completions' ? 'compat' : api === 'anthropic-messages' ? 'anthropic' : api === 'openai-responses' ? 'openai' : undefined;
  return suffix ? `${endpoint}/${suffix}` : undefined;
}

/** 设置页目录视图（getPiCatalogForUi / config:piCatalog IPC 形状） */
export interface PiCatalogView {
  providers: Array<PiCatalogProviderMeta & { models: Array<PiCatalogModel & { id: string }> }>;
  capabilities?: readonly PublishedModelInputSpecification[];
}

/**
 * Pi openai-completions 通常要带 /v1；工作台配置 historically 可能不带。
 * 真源放 shared（纯函数）：主进程 pi 同步（piConfigSync re-export）、连通性探针
 * （openaiClient）与设置页目录判定（ModelProviderPane）三处共用同一归一化，
 * 探针与运行时能力保持一致（model-providers F-01）。anthropic 协议勿用——
 * Anthropic SDK 自行拼 /v1/messages，套本函数会 /v1/v1。
 */
export function normalizePiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.openai.com/v1';
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  // DeepSeek 官方两种都行；统一补 /v1 给 Pi
  return `${trimmed}/v1`;
}

/** The Anthropic SDK appends /v1/messages to the base, including any gateway prefix. */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function normalizeModelCatalogEndpoint(baseUrl: string, protocol: string): string | undefined {
  const url = URL.parse(baseUrl.trim());
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return;
  if (['openai-completions', 'openai-responses', 'azure-openai-responses'].includes(protocol)) return normalizePiBaseUrl(url.href);
  const endpoint = url.href.replace(/\/+$/, '');
  return protocol === 'anthropic-messages' ? normalizeAnthropicBaseUrl(endpoint) : endpoint;
}

export function indexModelInputSpecifications(rows?: readonly PublishedModelInputSpecification[]) {
  const index = new Map<string, PublishedModelInputSpecification[]>();
  for (const row of rows ?? []) {
    const entries = index.get(row.modelId);
    if (entries) entries.push(row);
    else index.set(row.modelId, [row]);
  }
  return index;
}

export function resolveCoreModelInput(
  provider: { id: string; baseUrl: string; api?: string },
  model: Pick<LlmModelConfig, 'id' | 'contextWindow' | 'maxTokens' | 'reasoning' | 'multimodal' | 'multimodalExplicit' | 'attachments'>,
  published: readonly PublishedModelInputSpecification[] | undefined,
  bundled?: PiCatalogModel,
  meta?: PiCatalogProviderMeta
) {
  const id = piProviderPresetId(provider.id);
  const fixed = !!provider.baseUrl && !!meta?.baseUrl && normalizePiBaseUrl(meta.baseUrl) === normalizePiBaseUrl(provider.baseUrl);
  const account = meta?.accountEndpointExample && piAccountEndpoint(id, provider.baseUrl);
  const bundledApi = bundled?.api ?? provider.api ?? 'openai-completions';
  const bundledEndpoint = bundled?.baseUrl ? normalizeModelCatalogEndpoint(bundled.baseUrl, bundledApi) : undefined;
  const bundledOnEndpoint = bundled && (fixed || account || (bundledEndpoint &&
    bundledEndpoint === normalizeModelCatalogEndpoint(provider.baseUrl, bundledApi)));
  const protocol = bundledOnEndpoint ? bundledApi : provider.api ?? 'openai-completions';
  const accountBase = account && piAccountModelBaseUrl(id, account, protocol);
  const endpoint = normalizeModelCatalogEndpoint(accountBase || (bundledOnEndpoint && bundled.baseUrl) || provider.baseUrl, protocol);
  const onEndpoint = (baseUrl: string | undefined) => {
    if (!baseUrl) return;
    const candidates = published?.filter(row => row.protocol === protocol &&
      normalizeModelCatalogEndpoint(row.baseUrl, protocol) === baseUrl) ?? [];
    return candidates.find(row => row.providerId === provider.id) ?? candidates.find(row => row.providerId === id) ??
      (candidates.length === 1 ? candidates[0] : undefined);
  };
  const online = onEndpoint(endpoint);
  const local = bundledOnEndpoint ? bundled : undefined;
  const input = online?.input ?? local?.input ?? ['text', 'image'] as const;
  // Older manual adds wrote false even when the checkbox had not been used.
  const legacyDefault = model.multimodal === false && !model.multimodalExplicit && model.contextWindow === undefined &&
    model.maxTokens === undefined && model.reasoning !== true && (!model.attachments || !Object.keys(model.attachments).length) &&
    online?.verified && online.input?.includes('image');
  const imageOverride = legacyDefault ? undefined : model.multimodal;
  const multimodal = imageOverride ?? input.includes('image');
  const publishedWindow = model.contextWindow === undefined ? online?.contextWindow : undefined;
  const publishedImages = imageOverride === undefined && online?.input ? multimodal : undefined;
  return {
    contextWindow: model.contextWindow ?? online?.contextWindow ?? (local?.contextWindow || DEFAULT_CORE_CONTEXT_WINDOW),
    input: multimodal ? (input.includes('image') ? input : [...input, 'image'] as const) : input.filter(kind => kind !== 'image'),
    multimodal,
    imageOverride,
    catalogInput: publishedWindow !== undefined || publishedImages !== undefined
      ? { contextWindow: publishedWindow, multimodal: publishedImages } : undefined
  };
}
