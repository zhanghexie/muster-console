import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../atomicJson';
import { MODEL_INPUT_MODALITIES, normalizeModelCatalogEndpoint, normalizePiBaseUrl, piProviderPresetId,
  type ModelInputModality, type PublishedModelInputSpecification } from '../../shared/piCatalog';
import type { LlmProviderConfig } from '../../shared/types';
import seed from './coreReasoningSeed';
import { catalogHttpsUrl as httpsUrl, isCatalogRecord as isRecord, parsePiReasoningShard,
  type PiReasoningModel, type PiReasoningShard } from './piReasoningCatalog';

export const CORE_REASONING_CATALOG_URL = 'https://muster-model-catalog.pages.dev/v1/reasoning.json';
export const CORE_EXPANDED_CATALOG_URL = 'https://muster-model-catalog.pages.dev/reasoning-v2.json';
const catalogSizeLimit = 1024 * 1024;
const refreshInterval = 4 * 60 * 60 * 1000;

interface ReasoningEndpoint {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly protocol: string;
  readonly modelId: string;
}

export interface PublishedCoreReasoningBinding extends ReasoningEndpoint {
  readonly protocol: 'openai-completions' | 'openai-responses';
  readonly reasoning: {
    readonly format: 'deepseek' | 'qwen' | 'openai' | 'openai-chat' | 'siliconflow' | 'zai';
    readonly effort: readonly string[];
    readonly defaultEffort?: string;
    readonly canDisable: boolean;
    readonly canEnable?: boolean;
    readonly budget?: { readonly min: number; readonly max: number };
  };
}

export interface NativePiReasoningBinding extends ReasoningEndpoint {
  readonly native: Pick<PiReasoningModel, 'thinkingLevelMap' | 'compat'>;
  readonly reasoning: Omit<PublishedCoreReasoningBinding['reasoning'], 'format'>;
}

export type CoreReasoningBinding = PublishedCoreReasoningBinding | NativePiReasoningBinding;

interface CatalogEntry extends PublishedCoreReasoningBinding {
  readonly sources: readonly string[];
}

export interface CoreReasoningCatalog {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly updatedAt: string;
  readonly models: readonly CatalogEntry[];
  /** Host-populated snapshots of Pi's public provider catalogs. */
  readonly pi?: Readonly<Record<string, PiReasoningShard>>;
  readonly extra?: readonly CatalogEntry[];
  readonly local?: readonly PublishedCoreReasoningBinding[];
  readonly publishedPi?: Readonly<Record<string, PiReasoningShard>>;
  readonly capabilities?: readonly PublishedModelInputSpecification[];
}

interface ExpandedReasoningCatalog {
  readonly schemaVersion: 2;
  readonly revision: string;
  readonly pi: Readonly<Record<string, PiReasoningShard>>;
  readonly models: readonly CatalogEntry[];
  readonly capabilities?: readonly PublishedModelInputSpecification[];
}

function parsePublishedModelInput(raw: unknown): readonly PublishedModelInputSpecification[] {
  if (!Array.isArray(raw)) throw new Error('Invalid Core model capability catalog');
  const seen = new Set<string>();
  return raw.map((row: unknown) => {
    if (!isRecord(row)) throw new Error('Invalid Core model capability entry');
    const { providerId, baseUrl, protocol, modelId, contextWindow, input, sources, verified } = row;
    const endpoint = typeof baseUrl === 'string' && typeof protocol === 'string' && normalizeModelCatalogEndpoint(baseUrl, protocol);
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(providerId) || !endpoint ||
      typeof protocol !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(protocol) ||
      typeof modelId !== 'string' || !/^\S{1,512}$/.test(modelId) ||
      !Array.isArray(sources) || !sources.length || !sources.every(source => httpsUrl(source, true)) ||
      (verified !== undefined && verified !== true) || (contextWindow === undefined && input === undefined) ||
      (contextWindow !== undefined && (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)) ||
      (input !== undefined && (!Array.isArray(input) || !input.length || new Set(input).size !== input.length ||
        !input.every(value => MODEL_INPUT_MODALITIES.includes(value as ModelInputModality))))) {
      throw new Error('Invalid Core model capability entry');
    }
    const identity = JSON.stringify([providerId, endpoint, protocol, modelId]);
    if (seen.has(identity)) throw new Error('Duplicate Core model capability entry');
    seen.add(identity);
    return { providerId, baseUrl: endpoint, protocol, modelId, sources,
      ...(contextWindow !== undefined ? { contextWindow } : {}), ...(input !== undefined ? { input } : {}),
      ...(verified === true ? { verified } : {}) };
  });
}

type WireReasoning = PublishedCoreReasoningBinding['reasoning'];
export function reasoningBudgetValues(budget?: WireReasoning['budget']): number[] {
  if (!budget) return [];
  const { min, max } = budget;
  return [...new Set([min, Math.floor((min + max) / 2), max])];
}

export function isReasoningEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,127}$/.test(value);
}

function parseExpandedReasoning(value: Record<string, unknown>, protocol: string): WireReasoning | undefined {
  const { format, effort, canDisable, canEnable, budget, defaultEffort } = value;
  if (format !== 'openai' && format !== 'deepseek' && format !== 'qwen' && format !== 'openai-chat' &&
    format !== 'siliconflow' && format !== 'zai') return;
  if (protocol !== (format === 'openai' ? 'openai-responses' : 'openai-completions')) return;
  if (typeof canDisable !== 'boolean' || (canEnable !== undefined && typeof canEnable !== 'boolean') ||
    !Array.isArray(effort) || effort.length > 32 || new Set(effort).size !== effort.length ||
    !effort.every(v => isReasoningEffort(v) && !['off', 'on', 'none', 'default'].includes(v) && !v.startsWith('budget-'))) return;
  let range: WireReasoning['budget'];
  if (budget !== undefined) {
    if ((format !== 'siliconflow' && format !== 'qwen') || !isRecord(budget) || typeof budget.min !== 'number' ||
      typeof budget.max !== 'number' || !Number.isSafeInteger(budget.min) || !Number.isSafeInteger(budget.max) ||
      budget.min < 1 || budget.max < budget.min || budget.max > 2_000_000) return;
    range = { min: budget.min, max: budget.max };
  }
  const possibleDefaults = [...effort, ...(canEnable ? ['on'] : []), ...(canDisable ? ['off'] : []),
    ...reasoningBudgetValues(range).map(tokens => `budget-${tokens}`)];
  if (defaultEffort !== undefined && (typeof defaultEffort !== 'string' || !possibleDefaults.includes(defaultEffort))) return;
  return { format, effort, canDisable, ...(canEnable ? { canEnable } : {}), ...(range ? { budget: range } : {}),
    ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}

export function parseExpandedReasoningCatalog(raw: unknown): ExpandedReasoningCatalog {
  if (!isRecord(raw) || raw.schemaVersion !== 2 || typeof raw.revision !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}\.\d{1,10}$/.test(raw.revision) || !isRecord(raw.pi) || !Array.isArray(raw.models)) {
    throw new Error('Invalid expanded Core reasoning catalog');
  }
  const seen = new Set<string>();
  const models = raw.models.map((row: unknown): CatalogEntry => {
    if (!isRecord(row)) throw new Error('Invalid expanded Core model');
    const { providerId, baseUrl, protocol, modelId, reasoning, sources } = row;
    const url = httpsUrl(baseUrl);
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(providerId) || typeof modelId !== 'string' ||
      !/^\S{1,512}$/.test(modelId) || !url || !isRecord(reasoning) || (protocol !== 'openai-completions' && protocol !== 'openai-responses') ||
      !Array.isArray(sources) || !sources.length || !sources.every(source => httpsUrl(source, true))) throw new Error('Invalid expanded Core model');
    const capability = parseExpandedReasoning(reasoning, protocol);
    if (!capability) throw new Error('Invalid expanded Core reasoning capability');
    const identity = JSON.stringify([providerId, normalizePiBaseUrl(url.href), protocol, modelId]);
    if (seen.has(identity)) throw new Error('Duplicate expanded Core model');
    seen.add(identity);
    return { providerId, baseUrl: url.href, protocol, modelId, reasoning: capability, sources };
  });
  const pi = Object.fromEntries(Object.entries(raw.pi).map(([id, rows]) => {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) throw new Error('Invalid expanded Pi provider');
    return [id, parsePiReasoningShard(rows, id)];
  }));
  if (!Object.keys(pi).length || !models.length) throw new Error('Empty expanded Core reasoning catalog');
  const capabilities = raw.capabilities === undefined ? undefined : parsePublishedModelInput(raw.capabilities);
  return { schemaVersion: 2, revision: raw.revision, pi, models, ...(capabilities !== undefined ? { capabilities } : {}) };
}

/** Validate the entire snapshot before replacing the last usable catalog. */
export function parseCoreReasoningCatalog(raw: unknown): CoreReasoningCatalog {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.revision !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}\.\d{1,10}$/.test(raw.revision) || typeof raw.updatedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(raw.updatedAt) || !Array.isArray(raw.models) || !raw.models.length) {
    throw new Error('Invalid Core reasoning catalog');
  }
  const identities = new Set<string>();
  const models = raw.models.map((row: unknown): CatalogEntry => {
    if (!isRecord(row)) throw new Error('Invalid Core reasoning model');
    const { providerId, baseUrl, protocol, modelId, reasoning, sources } = row;
    const url = httpsUrl(baseUrl);
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(providerId) ||
        typeof modelId !== 'string' || !/^\S{1,512}$/.test(modelId) || !url || url.href !== baseUrl ||
        !isRecord(reasoning) || !Array.isArray(sources) ||
        !sources.length || !sources.every(source => httpsUrl(source, true))) {
      throw new Error('Invalid Core reasoning model');
    }
    const { format, effort, defaultEffort, canDisable } = reasoning;
    if (!((protocol === 'openai-completions' && (format === 'deepseek' || format === 'qwen')) ||
          (protocol === 'openai-responses' && format === 'openai')) ||
        typeof canDisable !== 'boolean' || !Array.isArray(effort) ||
        !effort.length || effort.length + Number(canDisable) > 128 || new Set(effort).size !== effort.length ||
        !effort.every(value => isReasoningEffort(value) && (value !== 'off' || !canDisable)) ||
        (defaultEffort !== undefined && (typeof defaultEffort !== 'string' || !effort.includes(defaultEffort)))) {
      throw new Error('Invalid Core reasoning capability');
    }
    const identity = JSON.stringify([providerId, normalizePiBaseUrl(url.href), protocol, modelId]);
    if (identities.has(identity)) throw new Error('Duplicate Core reasoning model');
    identities.add(identity);
    return { providerId, baseUrl: url.href, protocol, modelId, sources,
      reasoning: { format, effort, canDisable, ...(defaultEffort === undefined ? {} : { defaultEffort }) } };
  });
  return { schemaVersion: 1, revision: raw.revision, updatedAt: raw.updatedAt, models };
}

export const bundledCoreReasoningCatalog = parseCoreReasoningCatalog(seed);

export function coreReasoningMatchesEndpoint(binding: Omit<ReasoningEndpoint, 'providerId'>, baseUrl: string, protocol: string, modelId: string): boolean {
  if (binding.protocol !== protocol || binding.modelId !== modelId) return false;
  const url = httpsUrl(baseUrl.trim()) ?? localOllamaUrl(baseUrl.trim());
  if (!url) return false;
  const normalize = protocol === 'openai-completions' || protocol === 'openai-responses'
    ? normalizePiBaseUrl : (input: string) => input.replace(/\/+$/, '');
  return normalize(binding.baseUrl) === normalize(url.href);
}

export function findCoreReasoning(catalog: CoreReasoningCatalog | undefined,
  provider: Pick<LlmProviderConfig, 'id' | 'baseUrl'>, protocol: string, modelId: string): PublishedCoreReasoningBinding | undefined {
  if (!catalog) return;
  return findPublishedReasoning(catalog.models, provider, protocol, modelId);
}

export function findPublishedReasoning(entries: readonly CatalogEntry[] | undefined,
  provider: Pick<LlmProviderConfig, 'id' | 'baseUrl'>, protocol: string, modelId: string): PublishedCoreReasoningBinding | undefined {
  const candidates = entries?.filter(row => coreReasoningMatchesEndpoint(row, provider.baseUrl, protocol, modelId)) ?? [];
  const row = candidates.find(entry => entry.providerId === provider.id) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!row) return;
  // Local provider IDs may be aliases. Keep source links in the catalog and only send the capability to Pi.
  const { sources: _sources, ...binding } = row;
  return binding;
}

export function localOllamaUrl(baseUrl: string): URL | undefined {
  const url = URL.parse(baseUrl);
  if (url && ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/(?:v1\/?|)$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash) return url;
}

function responseEtag(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 && /^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(value) ? value : undefined;
}

async function readCatalogBody(response: Response, maxSize = catalogSizeLimit): Promise<unknown> {
  if (!response.body) throw new Error('Empty reasoning catalog response');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) throw new Error('Reasoning catalog exceeds size limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    void reader.cancel().catch(() => {});
  }
}

interface PiReasoningSources {
  providers: readonly string[];
  generatedAt?: number;
  local?: readonly OllamaReasoningTarget[];
}

interface OllamaReasoningTarget {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
}

function ollamaReasoning(target: OllamaReasoningTarget, body: unknown): PublishedCoreReasoningBinding | undefined {
  if (!isRecord(body) || !isRecord(body.thinking) || !Array.isArray(body.thinking.values)) return;
  const { values, default: value } = body.thinking;
  if (values.length > 32 || !values.every(v => typeof v === 'boolean' || (isReasoningEffort(v) && !['on', 'off', 'none'].includes(v)))) return;
  const effort = [...new Set(values.filter(isReasoningEffort))];
  const canEnable = values.includes(true);
  const canDisable = values.includes(false) && (canEnable || effort.length > 0);
  const defaultEffort = value === true && canEnable ? 'on' : value === false && canDisable ? 'off' :
    typeof value === 'string' && effort.includes(value) ? value : undefined;
  return { ...target, protocol: 'openai-completions', reasoning: { format: 'openai-chat', effort, canEnable, canDisable,
    ...(defaultEffort === undefined ? {} : { defaultEffort }) } };
}

/** One app-wide public cache. Startup, turns and picker reads never wait for the network. */
export class CoreReasoningCatalogStore {
  private catalog = bundledCoreReasoningCatalog;
  private etag: string | undefined;
  private pending: Promise<void> | undefined;
  private loaded: Promise<void> | undefined;
  private pi: Readonly<Record<string, PiReasoningShard>> | undefined;
  private readonly piEtags = new Map<string, string>();
  private readonly piPending = new Map<string, Promise<void>>();
  private readonly piChecked = new Map<string, number>();
  private expanded?: ExpandedReasoningCatalog;
  private expandedEtag?: string;
  private expandedPending?: Promise<void>;
  private expandedLoaded = false;
  private readonly local = new Map<string, PublishedCoreReasoningBinding>();
  private readonly localChecked = new Map<string, number>();
  version = 0;

  constructor(private readonly file: string, private readonly onChange: () => void, private readonly request = fetch) {}

  get snapshot(): CoreReasoningCatalog {
    if (!this.pi && !this.expanded && !this.local.size) return this.catalog;
    return { ...this.catalog, pi: this.pi, extra: this.expanded?.models, publishedPi: this.expanded?.pi,
      capabilities: this.expanded?.capabilities, local: [...this.local.values()] };
  }

  private changed(): void { this.version++; this.onChange(); }

  private publish(catalog: CoreReasoningCatalog, etag?: string): void {
    const changed = JSON.stringify(catalog.models) !== JSON.stringify(this.catalog.models);
    this.catalog = catalog;
    this.etag = etag;
    if (changed) this.changed();
  }

  private async load(signal: AbortSignal): Promise<void> {
    try {
      if ((await fs.stat(this.file)).size > catalogSizeLimit * 2) throw new Error('Cached catalog exceeds size limit');
      const data: unknown = JSON.parse(await fs.readFile(this.file, { encoding: 'utf8', signal }));
      signal.throwIfAborted();
      if (!isRecord(data)) throw new Error('Invalid Core reasoning cache');
      const cached = parseCoreReasoningCatalog(data.catalog);
      if (data.seedRevision === bundledCoreReasoningCatalog.revision ||
        cached.revision.localeCompare(bundledCoreReasoningCatalog.revision, undefined, { numeric: true }) >= 0) {
        this.publish(cached, responseEtag(data.etag));
      }
    } catch (error) {
      if (!signal.aborted && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[core reasoning catalog] cached snapshot unavailable:', (error as Error).message);
      }
    }
  }

  refresh(signal: AbortSignal): Promise<void> {
    if (this.pending) return this.pending;
    const run = async () => {
      this.loaded ??= this.load(signal);
      await this.loaded;
      signal.throwIfAborted();
      const response = await this.request(CORE_REASONING_CATALOG_URL, {
        headers: { Accept: 'application/json', ...(this.etag ? { 'If-None-Match': this.etag } : {}) },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
      });
      if (response.status === 304 && this.etag) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const catalog = parseCoreReasoningCatalog(await readCatalogBody(response));
      const etag = responseEtag(response.headers.get('etag'));
      signal.throwIfAborted();
      let persisted = false;
      try {
        await writeJsonAtomic(this.file, { catalog, etag, seedRevision: bundledCoreReasoningCatalog.revision }, () => !signal.aborted, 0);
        persisted = true;
      } catch (error) { console.warn('[core reasoning catalog] cannot save snapshot:', (error as Error).message); }
      if (!signal.aborted) this.publish(catalog, persisted ? etag : undefined);
    };
    this.pending = run().catch(error => {
      if (!signal.aborted) console.warn('[core reasoning catalog] refresh failed:', (error as Error).message);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private publishPi(provider: string, shard: PiReasoningShard, etag?: string): void {
    if (etag) this.piEtags.set(provider, etag);
    else this.piEtags.delete(provider);
    if (JSON.stringify(this.pi?.[provider]) === JSON.stringify(shard)) return;
    this.pi = { ...this.pi, [provider]: shard };
    this.changed();
  }

  refreshPiProvider(provider: string, generatedAt: number, signal: AbortSignal): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(provider)) return Promise.resolve();
    const pending = this.piPending.get(provider);
    if (pending) return pending;
    const file = path.join(path.dirname(this.file), `pi-reasoning-v1-${provider}.json`);
    const run = async () => {
      if (!this.pi || !Object.hasOwn(this.pi, provider)) {
        try {
          if ((await fs.stat(file)).size > catalogSizeLimit) throw new Error('Cached catalog exceeds size limit');
          const cached: unknown = JSON.parse(await fs.readFile(file, { encoding: 'utf8', signal }));
          signal.throwIfAborted();
          if (!isRecord(cached) || typeof cached.modified !== 'number') throw new Error('Invalid cached Pi reasoning catalog');
          if (cached.modified > generatedAt) this.publishPi(provider, parsePiReasoningShard(cached.models, provider), responseEtag(cached.etag));
        } catch (error) {
          if (!signal.aborted && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[pi reasoning catalog] cached snapshot unavailable:', provider, (error as Error).message);
          }
        }
      }
      signal.throwIfAborted();
      const validator = this.piEtags.get(provider);
      const response = await this.request(`https://pi.dev/api/models/providers/${provider}?types=chat`, {
        headers: { Accept: 'application/json', ...(validator ? { 'If-None-Match': validator } : {}) },
        credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
      });
      if ((response.status === 304 && validator) || response.status === 404 || response.status === 501) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const modified = Date.parse(response.headers.get('last-modified') ?? '');
      // As in Pi, an older (or undated) remote shard cannot replace the bundled model data.
      if (!(modified > generatedAt)) return;
      const models = parsePiReasoningShard(await readCatalogBody(response), provider);
      const etag = responseEtag(response.headers.get('etag'));
      signal.throwIfAborted();
      try { await writeJsonAtomic(file, { models, etag, modified }, () => !signal.aborted, 0); }
      catch (error) { console.warn('[pi reasoning catalog] cannot save snapshot:', provider, (error as Error).message); }
      if (!signal.aborted) this.publishPi(provider, models, etag);
    };
    const operation = run().catch(error => {
      if (!signal.aborted) console.warn('[pi reasoning catalog] refresh failed:', provider, (error as Error).message);
    }).finally(() => { this.piPending.delete(provider); });
    this.piPending.set(provider, operation);
    return operation;
  }

  refreshExpanded(signal: AbortSignal): Promise<void> {
    if (this.expandedPending) return this.expandedPending;
    const file = path.join(path.dirname(this.file), 'core-reasoning-v2.json');
    const maxSize = 2 * catalogSizeLimit;
    const publish = (snapshot: ExpandedReasoningCatalog, etag?: string) => {
      const changed = JSON.stringify(snapshot) !== JSON.stringify(this.expanded);
      this.expanded = snapshot;
      this.expandedEtag = etag;
      if (changed) this.changed();
    };
    const run = async () => {
      if (!this.expandedLoaded) {
        try {
          if ((await fs.stat(file)).size > maxSize) throw new Error('Cached catalog exceeds size limit');
          const raw: unknown = JSON.parse(await fs.readFile(file, { encoding: 'utf8', signal }));
          signal.throwIfAborted();
          if (!isRecord(raw)) throw new Error('Invalid expanded Core catalog cache');
          const cached = parseExpandedReasoningCatalog(raw.catalog);
          // Older clients could cache this revision and its ETag while dropping the new field.
          publish(cached, cached.capabilities === undefined ? undefined : responseEtag(raw.etag));
        } catch (error) {
          if (!signal.aborted && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[core reasoning catalog v2] cached snapshot unavailable:', (error as Error).message);
          }
        }
        this.expandedLoaded = true;
      }
      signal.throwIfAborted();
      const response = await this.request(CORE_EXPANDED_CATALOG_URL, {
        headers: { Accept: 'application/json', ...(this.expandedEtag ? { 'If-None-Match': this.expandedEtag } : {}) },
        credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(7500)])
      });
      if (response.status === 304 && this.expandedEtag) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const catalog = parseExpandedReasoningCatalog(await readCatalogBody(response, maxSize));
      const etag = responseEtag(response.headers.get('etag'));
      signal.throwIfAborted();
      try { await writeJsonAtomic(file, { catalog, etag }, () => !signal.aborted, 0); }
      catch (error) { console.warn('[core reasoning catalog v2] cannot save snapshot:', (error as Error).message); }
      if (!signal.aborted) publish(catalog, etag);
    };
    this.expandedPending = run().catch(error => {
      if (!signal.aborted) console.warn('[core reasoning catalog v2] refresh failed:', (error as Error).message);
    }).finally(() => { this.expandedPending = undefined; });
    return this.expandedPending;
  }

  async refreshOllamaModel(target: OllamaReasoningTarget, signal: AbortSignal): Promise<void> {
    const base = localOllamaUrl(target.baseUrl.trim());
    if (!base || piProviderPresetId(target.providerId) !== 'ollama' || !/^\S{1,512}$/.test(target.modelId)) return;
    const key = JSON.stringify([target.providerId, target.baseUrl, target.modelId]);
    const now = Date.now();
    if (now - (this.localChecked.get(key) ?? 0) < 60_000) return;
    this.localChecked.set(key, now);
    try {
      const response = await this.request(new URL('/api/show', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: target.modelId }), credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)])
      });
      if (!response.ok) return;
      const binding = ollamaReasoning(target, await readCatalogBody(response, 2 * catalogSizeLimit));
      if (signal.aborted || JSON.stringify(binding) === JSON.stringify(this.local.get(key))) return;
      if (binding) this.local.set(key, binding);
      else this.local.delete(key);
      this.changed();
    } catch {
      // The local service may be stopped or the model is still downloading.
    }
  }

  start(piSources?: () => Promise<PiReasoningSources>, subscribe?: (callback: () => void) => () => void): () => void {
    const controller = new AbortController();
    const refreshPi = async (periodic: boolean) => {
      if (!piSources || controller.signal.aborted) return;
      const { providers, generatedAt = 0, local = [] } = await piSources();
      const now = Date.now();
      if (controller.signal.aborted) return;
      for (const provider of providers) {
        if (!periodic && now - (this.piChecked.get(provider) ?? 0) < refreshInterval) continue;
        this.piChecked.set(provider, now);
        void this.refreshPiProvider(provider, generatedAt, controller.signal);
      }
      for (const target of local) void this.refreshOllamaModel(target, controller.signal);
    };
    const startPiRefresh = (periodic = false) =>
      void refreshPi(periodic).catch(error => console.warn('[pi reasoning catalog]', (error as Error).message));
    const refresh = (periodic = false) => {
      void this.refresh(controller.signal);
      void this.refreshExpanded(controller.signal);
      startPiRefresh(periodic);
    };
    const unsubscribe = subscribe?.(() => startPiRefresh());
    const timer = setInterval(() => refresh(true), refreshInterval);
    timer.unref();
    refresh();
    return () => { controller.abort(); clearInterval(timer); unsubscribe?.(); };
  }
}
