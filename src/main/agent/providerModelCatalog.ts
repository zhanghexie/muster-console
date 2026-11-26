import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { t } from '../../shared/i18n';
import { normalizePiBaseUrl } from '../../shared/piCatalog';
import type { ProviderModelCatalogRequest, ProviderModelCatalogSnapshot } from '../../shared/providerModelCatalog';
import { writeJsonAtomicSync } from '../atomicJson';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';

const TIMEOUT_MS = 12_000;
const MAX_PAGES = 100;
const MAX_MODELS = 20_000;
type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

function endpoint(args: ProviderModelCatalogRequest): { url: URL; headers: Record<string, string>; google: boolean } {
  const base = args.baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error(t('请先填写服务商地址'));
  const api = args.api || 'openai-completions';
  const google = api === 'google-generative-ai';
  const anthropic = api === 'anthropic-messages';
  // DeepSeek's official model discovery endpoint is rooted at `/models`, while
  // its OpenAI-compatible inference endpoints use `/v1/...`.
  const officialDeepSeek = /^https:\/\/api\.deepseek\.com(?:\/v\d+)?$/i.test(base);
  if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'].includes(api)) {
    throw new Error(t('此协议暂不支持刷新模型目录，请手动添加模型。'));
  }
  const normalized = google ? (/\/v\d+(?:beta\d*)?$/.test(base) ? base : `${base}/v1beta`)
    : anthropic ? (/\/v1$/.test(base) ? base : `${base}/v1`)
      : officialDeepSeek ? base.replace(/\/v\d+$/i, '') : normalizePiBaseUrl(base);
  const url = new URL(`${normalized}/models`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(t('请填写有效的 HTTP(S) 服务商地址'));
  }
  const key = args.apiKey.trim();
  if (officialDeepSeek && !key) throw new Error(t('DeepSeek 模型目录需要 API Key，请先填写。'));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (google) {
    if (key) headers['x-goog-api-key'] = key;
  } else if (key) headers.Authorization = `Bearer ${key}`;
  return { url, headers, google };
}

/** Read-only server request; only a complete, validated listing may replace a cache. */
export async function fetchProviderModelCatalog(args: ProviderModelCatalogRequest): Promise<ProviderModelCatalogSnapshot> {
  const { url, headers, google } = endpoint(args);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const models = new Map<string, ProviderModelCatalogSnapshot['models'][number]>();
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (!response.ok) {
        if ([404, 405, 501].includes(response.status)) throw new Error(t('服务商未提供模型列表接口（HTTP {{status}}），请手动添加模型。', { status: response.status }));
        const body = (await response.text()).slice(0, 300);
        const safeBody = args.apiKey.trim() ? body.split(args.apiKey.trim()).join('***') : body;
        throw new Error(`HTTP ${response.status}: ${safeBody || response.statusText}`);
      }
      const data = record(await response.json());
      const rows = data?.[google ? 'models' : 'data'];
      // Google's REST JSON omits empty repeated fields. An empty object is a valid empty list.
      if (!data || (!Array.isArray(rows) && !(google && rows === undefined && !data.error))) throw new Error(t('服务商返回的模型列表格式无效，已保留原目录。'));
      for (const raw of (rows ?? []) as unknown[]) {
        const row = record(raw);
        const rawId = row?.[google ? 'name' : 'id'];
        if (!row || typeof rawId !== 'string' || !rawId.trim()) throw new Error(t('服务商返回的模型列表格式无效，已保留原目录。'));
        if (google && Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.includes('generateContent')) continue;
        const id = google ? rawId.replace(/^models\//, '') : rawId.trim();
        const name = row.display_name ?? row.displayName ?? row.name;
        const contextWindow = positive(row.context_length ?? row.context_window ?? row.inputTokenLimit);
        const maxTokens = positive(row.max_tokens ?? row.max_output_tokens ?? row.outputTokenLimit);
        const input = Array.isArray(row.input_modalities)
          ? row.input_modalities.filter(value => value === 'text' || value === 'image') as ('text' | 'image')[]
          : undefined;
        const effort = record(row.effort);
        const reasoning = Array.isArray(effort?.supported_levels) && effort.supported_levels.length > 0;
        models.set(id, { id, ...(typeof name === 'string' && name !== rawId ? { name } : {}),
          ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}),
          ...(input?.length ? { input } : {}), ...(reasoning ? { reasoning } : {}) });
        if (models.size > MAX_MODELS) throw new Error(t('模型目录过大或分页异常，已保留原目录。'));
      }
      const cursor = google ? data.nextPageToken : data.has_more === true ? data.last_id : undefined;
      if (cursor === undefined || cursor === null || cursor === '') {
        if (!google && data.has_more === true) throw new Error(t('模型目录过大或分页异常，已保留原目录。'));
        return { fetchedAt: Date.now(), models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)) };
      }
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error(t('模型目录过大或分页异常，已保留原目录。'));
      cursors.add(cursor);
      url.searchParams.set(google ? 'pageToken' : 'after_id', cursor);
    }
    throw new Error(t('模型目录过大或分页异常，已保留原目录。'));
  } catch (error) {
    if (controller.signal.aborted) throw new Error(t('连接超时（12秒未响应）'));
    throw error;
  } finally { clearTimeout(timer); }
}

/** Isolated by provider, endpoint, protocol and credential. Keys are never persisted. */
export class ProviderModelCatalogStore {
  private file: string;
  private pending = new Map<string, Promise<ProviderModelCatalogSnapshot>>();
  constructor(userDataRoot: string) { this.file = userDataStorage(userDataRoot).file('provider-model-catalogs'); }

  private key(args: ProviderModelCatalogRequest): string {
    return createHash('sha256').update(JSON.stringify([args.id, args.baseUrl.trim().replace(/\/+$/, ''), args.api || 'openai-completions', args.apiKey.trim()])).digest('hex');
  }
  private entries(): Record<string, ProviderModelCatalogSnapshot> {
    try { return record(JSON.parse(fs.readFileSync(this.file, 'utf8'))) as Record<string, ProviderModelCatalogSnapshot> ?? {}; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return {};
      throw error;
    }
  }
  read(args: ProviderModelCatalogRequest): ProviderModelCatalogSnapshot | null {
    const value = this.entries()[this.key(args)];
    return value && Number.isFinite(value.fetchedAt) && Array.isArray(value.models)
      && value.models.every(model => typeof model?.id === 'string') ? value : null;
  }
  refresh(args: ProviderModelCatalogRequest): Promise<ProviderModelCatalogSnapshot> {
    const key = this.key(args);
    const current = this.pending.get(key);
    if (current) return current;
    const request = fetchProviderModelCatalog(args).then(snapshot => {
      const entries = this.entries();
      entries[key] = snapshot;
      const recent = Object.entries(entries).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, 64);
      writeJsonAtomicSync(this.file, Object.fromEntries(recent));
      return snapshot;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }
}
