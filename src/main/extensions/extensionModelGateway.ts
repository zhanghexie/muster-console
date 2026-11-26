import type { LlmModality, LlmModelConfig, LlmProviderConfig } from '../../shared/types';
import { normalizePiBaseUrl } from '../../shared/piCatalog';
import type { ExtensionMediaAsset } from './extensionMediaStore';
import type { ExtensionMediaStore } from './extensionMediaStore';
import { assertCredentialStorage } from '../agentApps/credentialPolicy';

const MAX_RESULT_BYTES = 250 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: Record<LlmModality, number> = { text: 240_000, image: 300_000, video: 900_000, asr: 300_000, tts: 300_000 };
const STANDARD_PATH: Record<'image' | 'tts' | 'asr', string> = { image: '/images/generations', tts: '/audio/speech', asr: '/audio/transcriptions' };

export interface ExtensionModelConfigSource { get(): { llm?: { providers: LlmProviderConfig[]; activeProviderId: string; activeModelId: string } } }
export interface ExtensionModelDescriptor { providerId: string; providerName: string; modelId: string; modelName: string; modalities: LlmModality[]; api?: string; isDefault: boolean }
export interface ExtensionModelInvokeInput { modality: LlmModality; providerId?: string; modelId?: string; prompt?: string; messages?: unknown[]; assetId?: string; voice?: string; size?: string; input?: unknown; timeoutMs?: number }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function pathValue(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (Array.isArray(current)) return current[Number(key)];
    return record(current)[key];
  }, value);
}
function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function safeRemoteUrl(value: string, base: URL): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new Error('模型返回了无效媒体地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型媒体地址协议不受支持');
  if (url.origin === base.origin) return url;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.startsWith('169.254.')) throw new Error('模型媒体地址指向受限网络');
  return url;
}
function mediaFor(model: LlmModelConfig, provider: LlmProviderConfig): LlmModality[] {
  const declared = model.modalities ?? provider.modalities ?? ['text'];
  const result = new Set<LlmModality>(declared.filter((item): item is LlmModality => ['text', 'image', 'video', 'asr', 'tts'].includes(item)));
  if (!model.modalities && provider.media?.imagePath) result.add('image');
  if (provider.media?.ttsPath) result.add('tts');
  if (provider.media?.asrPath) result.add('asr');
  if (provider.media?.video) result.add('video');
  return [...result];
}

/** Host-side multimodal provider adapter. API keys and endpoint details never leave this class. */
export class ExtensionModelGateway {
  constructor(private readonly config: ExtensionModelConfigSource, private readonly media: ExtensionMediaStore, private readonly cipher?: Pick<Electron.SafeStorage, 'encryptString' | 'decryptString' | 'isEncryptionAvailable' | 'getSelectedStorageBackend'>) {}

  private credentialStorage() {
    const cipher = this.cipher;
    assertCredentialStorage(!!cipher?.isEncryptionAvailable(), process.platform, process.platform === 'linux' ? cipher?.getSelectedStorageBackend() : undefined);
    return cipher!;
  }

  private imageEndpoint(raw: unknown): URL {
    const url = new URL(String(raw));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入有效的 HTTP(S) 生图 API 地址');
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (!url.pathname.endsWith('/images/generations')) url.pathname = url.pathname.replace(/\/$/, '') + '/images/generations';
    return url;
  }

  sealImageKey(owner: string, address: unknown, key: unknown): string {
    if (typeof key !== 'string' || !key.trim() || key.length > 16000) throw new Error('请输入有效的 API Key');
    const endpoint = this.imageEndpoint(address).href;
    return this.credentialStorage().encryptString(JSON.stringify({ owner, endpoint, key: key.trim() })).toString('base64');
  }

  async customImage(owner: string, raw: unknown, signal: AbortSignal) {
    const input = record(raw);
    const url = this.imageEndpoint(input.baseUrl);
    const model = String(input.model ?? '').trim();
    if (!model) throw new Error('请填写生图模型名称');
    let key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!key && input.sealedKey) {
      const cipher = this.credentialStorage();
      let saved;
      try { saved = JSON.parse(cipher.decryptString(Buffer.from(String(input.sealedKey), 'base64'))); }
      catch { throw new Error('无法解密，请重新填写 API Key'); }
      if (saved.owner !== owner || saved.endpoint !== url.href) throw new Error('连接地址已更改，请重新填写 API Key');
      key = saved.key;
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS.image)]);
    const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: deadline, headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: input.prompt, n: 1, ...(input.size ? { size: input.size } : {}) }) });
    if (!response.ok) throw new Error(`生图 API HTTP ${response.status} (${model})`);
    let json;
    const body = await this.readBody(response);
    try { json = JSON.parse(Buffer.from(body).toString('utf8')); }
    catch { throw new Error('生图 API 返回了无效 JSON，请检查接口地址'); }
    const entry = json.data?.[0] ?? json.images?.[0];
    let bytes: Buffer;
    if (typeof entry?.b64_json === 'string') bytes = Buffer.from(entry.b64_json, 'base64');
    else if (typeof entry?.url === 'string') {
      const source = safeRemoteUrl(entry.url, url);
      const download = await fetch(source, { signal: deadline, redirect: 'error', headers: source.origin === url.origin ? headers : undefined });
      if (!download.ok) throw new Error(`下载图片失败 HTTP ${download.status}`);
      bytes = Buffer.from(await this.readBody(download));
    } else throw new Error('生图 API 没有返回图片 URL 或 b64_json');
    const format = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
      : bytes[0] === 255 && bytes[1] === 216 ? 'jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : undefined;
    if (!format) throw new Error('生图 API 返回的内容不是 PNG、JPEG 或 WebP 图片');
    return { asset: await this.media.importBytes(owner, bytes, `generated.${format}`, `image/${format}`) };
  }

  list(): ExtensionModelDescriptor[] {
    const config = this.config.get().llm;
    const providers = config?.providers ?? [];
    return providers.filter(provider => provider.enabled !== false && provider.baseUrl.trim()).flatMap(provider => provider.models.map(model => ({
      providerId: provider.id, providerName: provider.name, modelId: model.id, modelName: model.name ?? model.id,
      modalities: mediaFor(model, provider), isDefault: provider.id === config?.activeProviderId && model.id === config?.activeModelId, ...(provider.api ? { api: provider.api } : {})
    })));
  }

  async invoke(owner: string, raw: unknown): Promise<{ modality: LlmModality; asset?: ExtensionMediaAsset; text?: string; taskId?: string }> {
    const input = record(raw);
    const modality = input.modality as LlmModality;
    if (!['text', 'image', 'video', 'asr', 'tts'].includes(String(modality))) throw new Error('模型能力类型不受支持');
    const config = this.config.get().llm;
    if (!config) throw new Error('宿主未配置模型服务');
    const provider = config.providers.find(item => item.id === (typeof input.providerId === 'string' ? input.providerId : config.activeProviderId)) ?? config.providers.find(item => item.enabled !== false);
    if (!provider || provider.enabled === false || !provider.baseUrl.trim() || !provider.apiKey.trim()) throw new Error('模型服务商未配置或已禁用');
    const model = provider.models.find(item => item.id === (typeof input.modelId === 'string' ? input.modelId : config.activeModelId)) ?? provider.models[0];
    if (!model) throw new Error('模型不存在');
    const capabilities = mediaFor(model, provider);
    if (!capabilities.includes(modality as LlmModality)) throw new Error(`模型未声明 ${modality} 能力`);
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isInteger(input.timeoutMs) ? Math.max(5_000, Math.min(DEFAULT_TIMEOUT_MS[modality as LlmModality], input.timeoutMs)) : DEFAULT_TIMEOUT_MS[modality as LlmModality];
    if (modality === 'text') {
      const messages = Array.isArray(input.messages) ? input.messages : [{ role: 'user', content: typeof input.prompt === 'string' ? input.prompt : '' }];
      const response = await this.requestJson(provider, undefined, { model: model.id, messages, ...(typeof input.input === 'object' ? input.input : {}) }, timeoutMs, '/chat/completions');
      const text = pathValue(response, 'choices.0.message.content');
      if (typeof text !== 'string' || !text) throw new Error('模型返回空文本');
      return { modality: 'text', text };
    }
    if (modality === 'image') return { modality, asset: await this.image(owner, provider, model.id, input, timeoutMs) };
    if (modality === 'tts') return { modality, asset: await this.tts(owner, provider, model.id, input, timeoutMs) };
    if (modality === 'asr') return { modality, text: await this.asr(owner, provider, model.id, input, timeoutMs) };
    return { modality, asset: await this.video(owner, provider, model.id, input, timeoutMs) };
  }

  private endpoint(provider: LlmProviderConfig, configured: string | undefined, standard: string): { url: URL; base: URL } {
    const base = new URL(provider.baseUrl.trim());
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('模型服务 baseUrl 必须使用 HTTP(S)');
    const normalized = normalizePiBaseUrl(base.href);
    const url = configured ? new URL(configured, base) : new URL(standard.replace(/^\/+/, ''), `${normalized}/`);
    if (url.protocol !== base.protocol && !configured) throw new Error('模型服务端点协议不一致');
    return { url, base };
  }

  private async requestJson(provider: LlmProviderConfig, configured: string | undefined, body: unknown, timeoutMs: number, standard = '', method: 'GET' | 'POST' = 'POST'): Promise<unknown> {
    const { url } = this.endpoint(provider, configured, standard);
    const response = await this.fetch(provider, url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }, timeoutMs);
    const text = await response.text();
    if (!response.ok) throw new Error(`模型服务 HTTP ${response.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { throw new Error('模型服务返回了无效 JSON'); }
  }

  private async image(owner: string, provider: LlmProviderConfig, model: string, input: Record<string, unknown>, timeoutMs: number): Promise<ExtensionMediaAsset> {
    const response = await this.requestJson(provider, provider.media?.imagePath, { model, prompt: typeof input.prompt === 'string' ? input.prompt : '', ...(typeof input.size === 'string' ? { size: input.size } : {}), response_format: 'url' }, timeoutMs, STANDARD_PATH.image);
    return this.importResponse(owner, provider, response, 'generated.png', timeoutMs);
  }

  private async tts(owner: string, provider: LlmProviderConfig, model: string, input: Record<string, unknown>, timeoutMs: number): Promise<ExtensionMediaAsset> {
    const { url } = this.endpoint(provider, provider.media?.ttsPath, STANDARD_PATH.tts);
    const response = await this.fetch(provider, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: String(input.prompt ?? ''), voice: String(input.voice ?? 'alloy'), response_format: 'mp3' }) }, timeoutMs);
    if (!response.ok) throw new Error(`模型服务 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return this.media.importBytes(owner, new Uint8Array(await this.readBody(response)), 'speech.mp3', response.headers.get('content-type') ?? 'audio/mpeg');
  }

  private async asr(owner: string, provider: LlmProviderConfig, model: string, input: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const assetId = typeof input.assetId === 'string' ? input.assetId : '';
    if (!assetId) throw new Error('语音识别需要 assetId');
    const source = await this.media.readBytes(owner, assetId);
    const form = new FormData(); form.append('model', model); form.append('file', new Blob([Buffer.from(source.bytes) as unknown as ArrayBuffer], { type: source.mime }), source.name);
    if (typeof input.prompt === 'string' && input.prompt) form.append('prompt', input.prompt);
    const { url } = this.endpoint(provider, provider.media?.asrPath, STANDARD_PATH.asr);
    const response = await this.fetch(provider, url, { method: 'POST', body: form }, timeoutMs);
    const text = await response.text();
    if (!response.ok) throw new Error(`模型服务 HTTP ${response.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result = parsed.text ?? pathValue(parsed, 'data.text');
    if (typeof result !== 'string' || !result) throw new Error('语音识别返回空文本');
    return result;
  }

  private async video(owner: string, provider: LlmProviderConfig, model: string, input: Record<string, unknown>, timeoutMs: number): Promise<ExtensionMediaAsset> {
    const adapter = provider.media?.video;
    if (!adapter) throw new Error('该视频模型未配置异步适配器');
    const submitted = await this.requestJson(provider, adapter.submitPath, { model, prompt: typeof input.prompt === 'string' ? input.prompt : '', ...(typeof input.input === 'object' ? input.input : {}) }, timeoutMs);
    const taskId = String(pathValue(submitted, 'id') ?? pathValue(submitted, 'task_id') ?? pathValue(submitted, 'data.id') ?? '');
    if (!taskId) return this.importResponse(owner, provider, submitted, 'generated.mp4', timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const path = adapter.pollPath.replaceAll('{taskId}', encodeURIComponent(taskId));
      const status = await this.requestJson(provider, path, undefined, Math.min(timeoutMs, 60_000), '', 'GET');
      const state = String(pathValue(status, adapter.statusPath) ?? pathValue(status, 'status') ?? pathValue(status, 'data.status') ?? '').toLowerCase();
      if (['failed', 'error', 'cancelled'].includes(state)) throw new Error(`视频任务失败：${state}`);
      if (['succeeded', 'success', 'completed', 'done'].includes(state) || pathValue(status, adapter.resultPath) || pathValue(status, 'url') || pathValue(status, 'data.url')) return this.importResponse(owner, provider, status, 'generated.mp4', timeoutMs, adapter.resultPath);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('视频模型任务超时');
  }

  private async importResponse(owner: string, provider: LlmProviderConfig, response: unknown, defaultName: string, timeoutMs: number, resultPath?: string): Promise<ExtensionMediaAsset> {
    const row = (resultPath ? pathValue(response, resultPath) : undefined) ?? pathValue(response, 'data.0') ?? pathValue(response, 'data') ?? response;
    const value = record(row);
    const base = new URL(provider.baseUrl);
    if (typeof value.b64_json === 'string') return this.media.importBytes(owner, Buffer.from(value.b64_json, 'base64'), defaultName);
    const url = typeof value.url === 'string' ? safeRemoteUrl(value.url, base) : undefined;
    if (!url) throw new Error('模型未返回可用媒体结果');
    const responseBody = await this.fetch(provider, url, { method: 'GET' }, timeoutMs, false);
    if (!responseBody.ok) throw new Error(`模型媒体 HTTP ${responseBody.status}`);
    const bytes = await this.readBody(responseBody);
    return this.media.importBytes(owner, new Uint8Array(bytes), defaultName, responseBody.headers.get('content-type') ?? undefined);
  }

  private async fetch(provider: LlmProviderConfig, url: URL, init: RequestInit, timeoutMs: number, authorize = true): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers); if (authorize) headers.set('Authorization', `Bearer ${provider.apiKey}`);
      return await fetch(url, { ...init, headers, signal: controller.signal });
    } catch (error) { throw new Error(error instanceof Error && error.name === 'AbortError' ? '模型请求超时' : errorText(error)); }
    finally { clearTimeout(timer); }
  }

  private async readBody(response: Response): Promise<ArrayBuffer> {
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_RESULT_BYTES) throw new Error('模型媒体超过 250MB 限制');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error('模型媒体超过 250MB 限制');
    return bytes;
  }
}
