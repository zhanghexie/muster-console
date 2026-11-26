/**
 * A small, UI-independent page map for a bounded chat transcript.
 *
 * Pages own absolute half-open message ranges.  Their payloads are kept
 * separate from the map's canonical message-id index so overlapping pages,
 * duplicate responses and out-of-order responses never create duplicate rows.
 * The coordinator deliberately does not know how a page is fetched or how a
 * message is rendered; both ChatSurface adapters use it to own retained payloads.
 */

import {
  evictVirtualPages,
  type PageEvictionInput,
  type PageEvictionResult,
  type VirtualizerPage,
  type VirtualizerRange
} from './measuredVirtualizer';

/** Absolute half-open message interval. */
export interface AbsoluteMessageRange {
  start: number;
  end: number;
}

/** A source cursor attached to one page or to the aggregate map snapshot. */
export interface PageCursor {
  /** Absolute index or an opaque source token for the next older page. */
  before?: number | string | null;
  /** Absolute index or an opaque source token for the next newer page. */
  after?: number | string | null;
  total?: number;
  hasEarlier?: boolean;
  hasLater?: boolean;
  token?: string | null;
}

/** Stable identity and render payload for one message. */
export interface PageMessage<T = unknown> {
  messageId: string;
  payload: T;
}

/** A response from a bounded range source. */
export interface PagePayload<T = unknown> {
  generation: number;
  range: AbsoluteMessageRange;
  messages: readonly PageMessage<T>[];
  cursor?: PageCursor;
}

export type PageMapLoadDirection = 'tail' | 'earlier' | 'later';
export type PageLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface PageLoadState {
  status: PageLoadStatus;
  generation: number;
  requestId?: string;
  error?: string;
}

export type PageLoadStates = Readonly<Record<PageMapLoadDirection, PageLoadState>>;

/** Opaque completion token returned by startLoad. */
export interface PageLoadToken {
  direction: PageMapLoadDirection;
  generation: number;
  requestId: string;
}

export interface PageMapCoordinatorOptions {
  /** Initial generation. A clear/reset always advances this value. */
  generation?: number;
  /** Known total before the first page arrives. */
  total?: number;
}

export interface PageMapSnapshot<T = unknown> {
  generation: number;
  total: number;
  pages: readonly PagePayload<T>[];
  /** Canonical messages sorted by their containing absolute page range. */
  messages: readonly PageMessage<T>[];
  /** Union of loaded page ranges (overlapping pages are coalesced). */
  loadedRanges: readonly AbsoluteMessageRange[];
  /** Aggregate cursor. Individual page cursors remain on `pages`. */
  cursor: PageCursor;
  loadState: PageLoadStates;
}

export interface PageMessageLocation<T = unknown> {
  messageId: string;
  index: number;
  range: AbsoluteMessageRange;
  page: PagePayload<T>;
}

export type PageApplyStatus =
  | 'accepted'
  | 'replaced'
  | 'duplicate'
  | 'stale-generation'
  | 'invalid';

export interface PageApplyResult<T = unknown> {
  status: PageApplyStatus;
  generation: number;
  page?: PagePayload<T>;
}

export interface PageMapEvictionInput extends Omit<PageEvictionInput, 'pages' | 'total'> {
  /** An old eviction request must not mutate a newer generation. */
  generation?: number;
}

export interface PageMapEvictionResult<T = unknown> {
  generation: number;
  /** Pages retained by the virtualizer decision, with their full metadata. */
  pages: readonly PagePayload<T>[];
  evicted: readonly PagePayload<T>[];
  evictedBefore: readonly PagePayload<T>[];
  evictedAfter: readonly PagePayload<T>[];
  before: number;
  after: number;
  total: number;
  /** Raw range result from measuredVirtualizer for callers needing math fields. */
  virtualizer: PageEvictionResult;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = safeInteger(value);
  return number == null ? fallback : Math.max(0, number);
}

function normalizeGeneration(value: unknown, fallback: number): number {
  return nonNegativeInteger(value, fallback);
}

function normalizeRange(value: unknown): AbsoluteMessageRange | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AbsoluteMessageRange>;
  const start = safeInteger(candidate.start);
  const end = safeInteger(candidate.end);
  if (start == null || end == null || start < 0 || end < start) return null;
  return { start, end };
}

function normalizeCursor(cursor: PageCursor | undefined): PageCursor | undefined {
  if (!cursor || typeof cursor !== 'object') return undefined;
  const normalized: PageCursor = {};
  if (cursor.before === null || typeof cursor.before === 'string' || safeInteger(cursor.before) != null) {
    normalized.before = cursor.before;
  }
  if (cursor.after === null || typeof cursor.after === 'string' || safeInteger(cursor.after) != null) {
    normalized.after = cursor.after;
  }
  if (safeInteger(cursor.total) != null) normalized.total = Math.max(0, cursor.total!);
  if (typeof cursor.hasEarlier === 'boolean') normalized.hasEarlier = cursor.hasEarlier;
  if (typeof cursor.hasLater === 'boolean') normalized.hasLater = cursor.hasLater;
  if (cursor.token === null || typeof cursor.token === 'string') normalized.token = cursor.token;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function rangeKey(range: AbsoluteMessageRange): string {
  return `${range.start}:${range.end}`;
}

function cloneCursor(cursor: PageCursor | undefined): PageCursor | undefined {
  return cursor ? { ...cursor } : undefined;
}

function clonePage<T>(page: PagePayload<T>): PagePayload<T> {
  return {
    generation: page.generation,
    range: { ...page.range },
    messages: page.messages.map(message => ({ messageId: message.messageId, payload: message.payload })),
    ...(page.cursor ? { cursor: cloneCursor(page.cursor) } : {})
  };
}

function sameCursor(a: PageCursor | undefined, b: PageCursor | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.before === b.before && a.after === b.after && a.total === b.total &&
    a.hasEarlier === b.hasEarlier && a.hasLater === b.hasLater && a.token === b.token;
}

function samePage<T>(a: PagePayload<T>, b: PagePayload<T>): boolean {
  if (a.generation !== b.generation || a.range.start !== b.range.start || a.range.end !== b.range.end ||
      !sameCursor(a.cursor, b.cursor) || a.messages.length !== b.messages.length) return false;
  return a.messages.every((message, index) => {
    const other = b.messages[index];
    return message.messageId === other?.messageId && Object.is(message.payload, other.payload);
  });
}

function normalizePage<T>(page: PagePayload<T>): PagePayload<T> | null {
  if (!page || typeof page !== 'object') return null;
  const range = normalizeRange(page.range);
  const generation = safeInteger(page.generation);
  if (!range || generation == null || generation < 0 || !Array.isArray(page.messages)) return null;

  const ids = new Set<string>();
  const messages: PageMessage<T>[] = [];
  for (const candidate of page.messages) {
    if (!candidate || typeof candidate !== 'object') return null;
    const messageId = (candidate as Partial<PageMessage<T>>).messageId;
    if (typeof messageId !== 'string' || messageId.length === 0 || ids.has(messageId)) return null;
    ids.add(messageId);
    messages.push({ messageId, payload: (candidate as PageMessage<T>).payload });
  }
  return {
    generation,
    range,
    messages,
    ...(normalizeCursor(page.cursor) ? { cursor: normalizeCursor(page.cursor) } : {})
  };
}

function emptyLoadState(generation: number): PageLoadState {
  return { status: 'idle', generation };
}

function initialLoadStates(generation: number): Record<PageMapLoadDirection, PageLoadState> {
  return {
    tail: emptyLoadState(generation),
    earlier: emptyLoadState(generation),
    later: emptyLoadState(generation)
  };
}

function comparePages<T>(a: PagePayload<T>, b: PagePayload<T>): number {
  return a.range.start - b.range.start || a.range.end - b.range.end;
}

function mergeRanges(ranges: readonly AbsoluteMessageRange[]): AbsoluteMessageRange[] {
  const sorted = ranges
    .map(range => ({ ...range }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: AbsoluteMessageRange[] = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      result.push(range);
    }
  }
  return result;
}

function numericCursor(value: number | string | null | undefined): number | null {
  return safeInteger(value);
}

/**
 * Owns a generation-scoped map of bounded transcript pages.
 *
 * The class is intentionally synchronous. Fetching, subscriptions and React
 * snapshots belong to an adapter; this module only decides whether a response
 * is current, how pages are ordered/deduplicated, and what may be evicted.
 */
export class PageMapCoordinator<T = unknown> {
  private generationValue: number;
  private totalValue: number;
  private readonly pagesByRange = new Map<string, PagePayload<T>>();
  private readonly canonicalById = new Map<string, PageMessage<T>>();
  private loadStates: Record<PageMapLoadDirection, PageLoadState>;
  private requestCounter = 0;
  private version = 0;

  constructor(options: PageMapCoordinatorOptions = {}) {
    this.generationValue = normalizeGeneration(options.generation, 1);
    this.totalValue = nonNegativeInteger(options.total, 0);
    this.loadStates = initialLoadStates(this.generationValue);
  }

  get generation(): number {
    return this.generationValue;
  }

  get versionNumber(): number {
    return this.version;
  }

  /** Normalize overlapping responses into disjoint, at most 120-row pages. */
  applyWindow(page: PagePayload<T>, replaceAll = false): PageApplyResult<T> {
    const normalized = normalizePage(page);
    if (!normalized || normalized.messages.length !== normalized.range.end - normalized.range.start) {
      return { status: 'invalid', generation: this.generationValue };
    }
    if (page.generation !== this.generationValue) return { status: 'stale-generation', generation: this.generationValue };
    const slots = new Map<number, PageMessage<T>>();
    const incoming = new Set(normalized.messages.map(message => message.messageId));
    for (const stored of replaceAll ? [] : this.pagesByRange.values()) stored.messages.forEach((message, offset) => {
      const index = stored.range.start + offset;
      if (!incoming.has(message.messageId) && (index < normalized.range.start || index >= normalized.range.end)) {
        slots.set(index, this.canonicalById.get(message.messageId) ?? message);
      }
    });
    normalized.messages.forEach((message, offset) => slots.set(normalized.range.start + offset, message));
    this.totalValue = Math.max(replaceAll ? 0 : this.totalValue, normalized.range.end, normalized.cursor?.total ?? 0);
    this.pagesByRange.clear();
    this.canonicalById.clear();
    let current: PagePayload<T> | undefined;
    for (const [index, message] of [...slots].sort((a, b) => a[0] - b[0])) {
      if (!current || index !== current.range.end || index % 120 === 0) {
        if (current) this.pagesByRange.set(rangeKey(current.range), current);
        current = { generation: this.generation, range: { start: index, end: index }, messages: [] };
      }
      (current.messages as PageMessage<T>[]).push(message);
      current.range.end = index + 1;
      this.canonicalById.set(message.messageId, message);
    }
    if (current) this.pagesByRange.set(rangeKey(current.range), current);
    this.version++;
    return { status: 'accepted', generation: this.generationValue, page: normalized };
  }

  /** Refresh loaded payloads without assigning unknown historical messages new positions. */
  updatePayloads(messages: readonly PageMessage<T>[]): void {
    for (const message of messages) {
      if (this.canonicalById.has(message.messageId)) this.canonicalById.set(message.messageId, message);
    }
    for (const page of this.pagesByRange.values()) {
      page.messages = page.messages.map(message => this.canonicalById.get(message.messageId) ?? message);
    }
  }

  /** Keep a bounded reader window and live tail; all other payload owners are released. */
  retainWindow(window: AbsoluteMessageRange, navigation?: AbsoluteMessageRange): boolean {
    let changed = false;
    const start = Math.max(0, window.start - 120);
    const end = Math.min(this.totalValue, window.end + 120);
    const tail = Math.max(0, this.totalValue - 240);
    for (const [key, page] of this.pagesByRange) {
      if ((page.range.end > start && page.range.start < end) || page.range.end > tail ||
          (navigation && page.range.end > navigation.start && page.range.start < navigation.end)) continue;
      this.pagesByRange.delete(key);
      changed = true;
    }
    if (changed) { this.rebuildCanonicalIndex(); this.version++; }
    return changed;
  }

  loadedSlots(): Array<{ index: number; messageId: string }> {
    return [...this.pagesByRange.values()].sort(comparePages).flatMap(page =>
      page.messages.map((message, offset) => ({ index: page.range.start + offset, messageId: message.messageId })));
  }

  missingWindows(window: AbsoluteMessageRange): AbsoluteMessageRange[] {
    const ranges = this.getSnapshot().loadedRanges;
    const missing: AbsoluteMessageRange[] = [];
    const start = Math.max(0, Math.floor(window.start / 120) * 120);
    const end = Math.min(this.totalValue, Math.ceil(window.end / 120) * 120);
    for (let from = start; from < end; from += 120) {
      const to = Math.min(end, from + 120);
      if (!ranges.some(range => range.start <= from && range.end >= to)) missing.push({ start: from, end: to });
    }
    return missing;
  }

  /** Stop suspended transport requests while preserving the bounded reading pages. */
  cancelLoads(): void {
    this.loadStates = initialLoadStates(this.generationValue);
    this.version++;
  }

  /** Start a new lifetime. Pages and in-flight load state from the old one die together. */
  reset(nextGeneration?: number, total = 0): number {
    const requested = nextGeneration == null
      ? this.generationValue + 1
      : normalizeGeneration(nextGeneration, this.generationValue + 1);
    this.generationValue = requested > this.generationValue ? requested : this.generationValue + 1;
    this.totalValue = nonNegativeInteger(total, 0);
    this.pagesByRange.clear();
    this.canonicalById.clear();
    this.loadStates = initialLoadStates(this.generationValue);
    this.version++;
    return this.generationValue;
  }

  /** Alias that reads naturally at call sites handling a clear/new history. */
  beginGeneration(nextGeneration?: number, total = 0): number {
    return this.reset(nextGeneration, total);
  }

  /** Accept a page only for the current generation. */
  applyPage(page: PagePayload<T>): PageApplyResult<T> {
    const normalized = normalizePage(page);
    if (!normalized) return { status: 'invalid', generation: this.generationValue };
    if (normalized.generation !== this.generationValue) {
      return { status: 'stale-generation', generation: this.generationValue };
    }

    const key = rangeKey(normalized.range);
    const previous = this.pagesByRange.get(key);
    if (previous && samePage(previous, normalized)) {
      return { status: 'duplicate', generation: this.generationValue, page: this.resolvePage(previous) };
    }

    const stored = clonePage(normalized);
    this.pagesByRange.set(key, stored);
    for (const message of stored.messages) this.canonicalById.set(message.messageId, message);
    this.totalValue = Math.max(this.totalValue, stored.range.end, stored.cursor?.total ?? 0);
    this.version++;
    return {
      status: previous ? 'replaced' : 'accepted',
      generation: this.generationValue,
      page: this.resolvePage(stored)
    };
  }

  /** Mark a range request in flight and return a generation-bound completion token. */
  startLoad(direction: PageMapLoadDirection, requestId?: string): PageLoadToken {
    const token: PageLoadToken = {
      direction,
      generation: this.generationValue,
      requestId: requestId && requestId.length > 0 ? requestId : `${this.generationValue}:${++this.requestCounter}`
    };
    this.loadStates[direction] = {
      status: 'loading',
      generation: this.generationValue,
      requestId: token.requestId
    };
    this.version++;
    return token;
  }

  /** Complete a load only if its generation and request identity are current. */
  finishLoad(token: PageLoadToken, error?: string): boolean {
    const current = this.loadStates[token.direction];
    if (token.generation !== this.generationValue || current.requestId !== token.requestId || current.status !== 'loading') {
      return false;
    }
    this.loadStates[token.direction] = {
      status: error ? 'error' : 'loaded',
      generation: this.generationValue,
      ...(token.requestId ? { requestId: token.requestId } : {}),
      ...(error ? { error } : {})
    };
    this.version++;
    return true;
  }

  /** Explicit state setter for adapters that own request tokens themselves. */
  setLoadState(direction: PageMapLoadDirection, state: Omit<PageLoadState, 'generation'> & { generation?: number }): boolean {
    const generation = state.generation ?? this.generationValue;
    if (generation !== this.generationValue) return false;
    this.loadStates[direction] = {
      status: state.status,
      generation,
      ...(state.requestId ? { requestId: state.requestId } : {}),
      ...(state.error ? { error: state.error } : {})
    };
    this.version++;
    return true;
  }

  /** Apply measuredVirtualizer's page decision while preserving payload/cursor metadata. */
  evict(input: PageMapEvictionInput): PageMapEvictionResult<T> {
    const currentPages = [...this.pagesByRange.values()].sort(comparePages);
    const emptyVirtualizer: PageEvictionResult = {
      pages: [],
      evicted: [],
      evictedBefore: [],
      evictedAfter: [],
      before: input.keep.start,
      after: Math.max(0, this.totalValue - input.keep.end),
      total: this.totalValue
    };
    if (input.generation != null && input.generation !== this.generationValue) {
      return {
        generation: this.generationValue,
        pages: currentPages.map(page => this.resolvePage(page)),
        evicted: [],
        evictedBefore: [],
        evictedAfter: [],
        before: emptyVirtualizer.before,
        after: emptyVirtualizer.after,
        total: this.totalValue,
        virtualizer: emptyVirtualizer
      };
    }

    const virtualizerPages: VirtualizerPage[] = currentPages.map(page => ({ ...page.range }));
    const virtualizer = evictVirtualPages({
      ...input,
      pages: virtualizerPages,
      total: this.totalValue
    });
    const retainedKeys = new Set(virtualizer.pages.map(rangeKey));
    const evictedKeys = new Set(virtualizer.evicted.map(rangeKey));
    const retained = currentPages.filter(page => retainedKeys.has(rangeKey(page.range)));
    const evicted = currentPages.filter(page => evictedKeys.has(rangeKey(page.range)));
    const evictedBeforeKeys = new Set(virtualizer.evictedBefore.map(rangeKey));
    const evictedAfterKeys = new Set(virtualizer.evictedAfter.map(rangeKey));
    const evictedBefore = evicted.filter(page => evictedBeforeKeys.has(rangeKey(page.range)));
    const evictedAfter = evicted.filter(page => evictedAfterKeys.has(rangeKey(page.range)));

    for (const page of evicted) this.pagesByRange.delete(rangeKey(page.range));
    this.rebuildCanonicalIndex();
    if (evicted.length > 0) this.version++;
    return {
      generation: this.generationValue,
      pages: retained.map(page => this.resolvePage(page)),
      evicted: evicted.map(page => this.resolvePage(page)),
      evictedBefore: evictedBefore.map(page => this.resolvePage(page)),
      evictedAfter: evictedAfter.map(page => this.resolvePage(page)),
      before: virtualizer.before,
      after: virtualizer.after,
      total: virtualizer.total,
      virtualizer
    };
  }

  /** Locate a loaded message in absolute projection coordinates. */
  locateMessage(messageId: string): PageMessageLocation<T> | undefined {
    if (typeof messageId !== 'string' || messageId.length === 0) return undefined;
    const pages = [...this.pagesByRange.values()].sort(comparePages);
    for (const page of pages) {
      const offset = page.messages.findIndex(message => message.messageId === messageId);
      if (offset < 0) continue;
      return {
        messageId,
        index: page.range.start + offset,
        range: { ...page.range },
        page: this.resolvePage(page)
      };
    }
    return undefined;
  }

  /** Return a defensive, sorted snapshot suitable for a React external store. */
  getSnapshot(): PageMapSnapshot<T> {
    const pages = [...this.pagesByRange.values()].sort(comparePages);
    const messages: PageMessage<T>[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      for (const message of page.messages) {
        if (seen.has(message.messageId)) continue;
        seen.add(message.messageId);
        messages.push(this.canonicalById.get(message.messageId) ?? message);
      }
    }
    const loadedRanges = mergeRanges(pages.map(page => page.range));
    return {
      generation: this.generationValue,
      total: this.totalValue,
      pages: pages.map(page => this.resolvePage(page)),
      messages: messages.map(message => ({ ...message })),
      loadedRanges,
      cursor: this.aggregateCursor(pages),
      loadState: {
        tail: { ...this.loadStates.tail },
        earlier: { ...this.loadStates.earlier },
        later: { ...this.loadStates.later }
      }
    };
  }

  private resolvePage(page: PagePayload<T>): PagePayload<T> {
    return {
      generation: page.generation,
      range: { ...page.range },
      messages: page.messages.map(message => this.canonicalById.get(message.messageId) ?? message),
      ...(page.cursor ? { cursor: cloneCursor(page.cursor) } : {})
    };
  }

  private rebuildCanonicalIndex(): void {
    const ids = new Set<string>();
    for (const page of this.pagesByRange.values()) {
      for (const message of page.messages) ids.add(message.messageId);
    }
    for (const id of this.canonicalById.keys()) {
      if (!ids.has(id)) this.canonicalById.delete(id);
    }
  }

  private aggregateCursor(pages: readonly PagePayload<T>[]): PageCursor {
    const first = pages[0];
    const last = pages[pages.length - 1];
    let before: number | string | null | undefined;
    let after: number | string | null | undefined;
    let hasEarlier = false;
    let hasLater = false;
    let token: string | null | undefined;
    for (const page of pages) {
      const cursor = page.cursor;
      const candidateBefore = numericCursor(cursor?.before);
      if (candidateBefore != null) before = before == null ? candidateBefore : Math.min(Number(before), candidateBefore);
      else if (before === undefined && cursor?.before !== undefined) before = cursor.before;
      const candidateAfter = numericCursor(cursor?.after);
      if (candidateAfter != null) after = after == null ? candidateAfter : Math.max(Number(after), candidateAfter);
      else if (after === undefined && cursor?.after !== undefined) after = cursor.after;
      hasEarlier ||= cursor?.hasEarlier === true;
      hasLater ||= cursor?.hasLater === true;
      if (cursor?.token !== undefined) token = cursor.token;
    }
    if (first && before === undefined) before = first.range.start;
    if (last && after === undefined) after = Math.max(0, this.totalValue - last.range.end);
    if (first && first.range.start > 0) hasEarlier = true;
    if (last && last.range.end < this.totalValue) hasLater = true;
    const result: PageCursor = { total: this.totalValue, hasEarlier, hasLater };
    if (before !== undefined) result.before = before;
    if (after !== undefined) result.after = after;
    if (token !== undefined) result.token = token;
    return result;
  }
}

/** Alias kept short for adapters that use the page map as their store. */
export { PageMapCoordinator as PageMap };

/** Compile-time helper for callers constructing an eviction range. */
export type PageKeepRange = VirtualizerRange | Pick<VirtualizerRange, 'start' | 'end'>;
