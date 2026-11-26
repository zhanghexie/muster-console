/**
 * Pure range math for a bounded, bidirectional transcript virtualizer.
 *
 * The module deliberately has no DOM or React dependency.  Row indexes are
 * absolute indexes in the session projection.  `before`/`after` therefore
 * describe rows outside the returned window and remain useful when a page is
 * loaded from a bounded history source.
 */

export type VirtualizerDirection = 'forward' | 'backward' | 'tail';

export interface VirtualizerAnchor {
  /** Absolute row index. */
  index: number;
  /** Row top relative to the viewport top, in pixels. */
  offset: number;
}

export interface VirtualizerViewport {
  /** Scroll offset in estimated/realized content coordinates. */
  offset?: number;
  /** Viewport height in pixels. */
  height: number;
}

/** JSON-safe measured-height map. Keys are absolute row indexes. */
export type MeasuredHeights = Readonly<Record<string, number | null | undefined>>;
export type MeasuredMargins = Readonly<Record<string, number | null | undefined>>;

export interface MeasuredVirtualizerInput {
  /** Total number of rows in the projection. */
  total: number;
  /** Absolute history cursor supplied by a range source. */
  before?: number;
  /** Viewport geometry. `viewport` takes precedence over these legacy fields. */
  viewport?: VirtualizerViewport;
  viewportHeight?: number;
  scrollOffset?: number;
  /** A visible row and its viewport-relative top. */
  anchor?: VirtualizerAnchor | null;
  /** Number of rows to retain on each side of the visible range. */
  overscan?: number;
  /** Fixed fallback height used by every row without a valid measurement. */
  estimatedRowHeight?: number;
  /** Short alias for callers that use a fixed row-height setting. */
  rowHeight?: number;
  /** Gap between adjacent rows in the containing column. */
  rowGap?: number;
  /** Optional sparse absolute-index measurements. */
  measuredHeights?: MeasuredHeights;
  /** Alias kept for callers that name the map after rows. */
  measuredRowHeights?: MeasuredHeights;
  /** Measured top margins for rows whose height was observed in the DOM. */
  measuredMargins?: MeasuredMargins;
  /** Hard cap for the returned render window. Omit for no row-count cap. */
  maxWindow?: number;
  /** Direction used to choose which side survives a hard cap. */
  direction?: VirtualizerDirection;
}

export interface VirtualizerRange {
  /** Half-open absolute row interval. */
  start: number;
  end: number;
  /** Rows before/after this interval in the absolute projection. */
  before: number;
  after: number;
}

export interface MeasuredVirtualizerResult {
  total: number;
  /** The input range cursor, normalized and preserved for range-source use. */
  sourceBefore: number;
  estimatedRowHeight: number;
  viewportHeight: number;
  contentHeight: number;
  /** Estimated/realized spacer heights outside the mounted window. */
  beforeHeight: number;
  afterHeight: number;
  scrollOffset: number;
  /** Visible rows before overscan and hard-window capping. */
  visible: VirtualizerRange;
  /** Rows that should remain mounted. */
  window: VirtualizerRange;
  /** Absolute rows outside the mounted window. */
  before: number;
  after: number;
  /** Effective anchor after clamping to the measured content. */
  anchor: VirtualizerAnchor | null;
  direction: VirtualizerDirection;
  /** True when no explicit position was supplied and the calculation tracks the tail. */
  tail: boolean;
}

export interface AnchorCompensationInput {
  anchor: VirtualizerAnchor;
  estimatedRowHeight?: number;
  rowHeight?: number;
  previousMeasuredHeights?: MeasuredHeights;
  nextMeasuredHeights?: MeasuredHeights;
  /** Optional scroll offset to return after applying the compensation. */
  scrollOffset?: number;
}

export interface AnchorCompensationResult {
  anchor: VirtualizerAnchor;
  /** Height change strictly before the anchor row. */
  deltaBeforeAnchor: number;
  /** Add this value to scrollTop to keep the anchor at its old offset. */
  scrollAdjustment: number;
  /** Equal to the input offset. Kept explicit for serializable state updates. */
  compensatedOffset: number;
  /** Present when a scroll offset was supplied. */
  scrollOffset?: number;
}

export interface VirtualizerPage {
  /** Half-open absolute interval covered by the page. */
  start: number;
  end: number;
}

export interface PageEvictionInput {
  pages: readonly VirtualizerPage[];
  /** Mounted/desired interval. Pages intersecting this interval are retained. */
  keep: VirtualizerRange | Pick<VirtualizerRange, 'start' | 'end'>;
  total?: number;
  /** Keep this many adjacent pages on each side of the intersecting pages. */
  overscanPages?: number;
  /** Optional page-count bound. */
  maxPages?: number;
  /** Used to choose the closest pages when maxPages trims both sides. */
  anchorIndex?: number;
}

export interface PageEvictionResult {
  pages: VirtualizerPage[];
  evicted: VirtualizerPage[];
  evictedBefore: VirtualizerPage[];
  evictedAfter: VirtualizerPage[];
  before: number;
  after: number;
  total: number;
}

export const DEFAULT_ESTIMATED_ROW_HEIGHT = 80;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = finiteNumber(value, fallback);
  return Math.max(0, Math.floor(number));
}

function positiveHeight(value: unknown, fallback: number): number {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function normalizeTotal(total: number): number {
  return nonNegativeInteger(total, 0);
}

function normalizeHeightMap(input: MeasuredHeights | undefined, total: number): Record<string, number> {
  if (!input) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(input)) {
    const index = Number(key);
    const height = typeof raw === 'number' ? raw : Number.NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index >= total || !Number.isFinite(height) || height <= 0) continue;
    result[String(index)] = height;
  }
  return result;
}

function normalizeMarginMap(input: MeasuredMargins | undefined, total: number): Record<string, number> {
  if (!input) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(input)) {
    const index = Number(key);
    const margin = typeof raw === 'number' ? raw : Number.NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index >= total || !Number.isFinite(margin)) continue;
    result[String(index)] = margin;
  }
  return result;
}

interface HeightModel {
  readonly measured: Record<string, number>;
  readonly margins: Record<string, number>;
  readonly indices: number[];
  readonly prefixDeltas: number[];
  readonly estimate: number;
  readonly gap: number;
  prefix(index: number): number;
  row(index: number): number;
  marginTop(index: number): number;
}

function rowTop(model: HeightModel, index: number): number {
  const safeIndex = Math.max(0, Math.floor(index));
  return model.prefix(safeIndex) + (safeIndex > 0 ? model.gap : 0) + model.marginTop(safeIndex);
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function makeHeightModel(
  total: number,
  estimate: number,
  measured: Record<string, number>,
  margins: Record<string, number>,
  gap: number
): HeightModel {
  const indices = Object.keys(measured).map(Number).sort((a, b) => a - b);
  const prefixDeltas = [0];
  for (const index of indices) {
    const delta = measured[String(index)]! - estimate;
    prefixDeltas.push(prefixDeltas[prefixDeltas.length - 1]! + delta);
  }
  return {
    measured,
    margins,
    indices,
    prefixDeltas,
    estimate,
    gap,
    prefix(index: number): number {
      const clamped = Math.max(0, Math.min(total, Math.floor(index)));
      const measuredBefore = upperBound(indices, clamped);
      return clamped * estimate + prefixDeltas[measuredBefore]! + Math.max(0, clamped - 1) * gap;
    },
    row(index: number): number {
      return measured[String(index)] ?? estimate;
    },
    marginTop(index: number): number {
      return margins[String(index)] ?? 0;
    }
  };
}

/** First row whose bottom is greater than `offset`; `total` means the tail. */
function rowAtOffset(model: HeightModel, total: number, offset: number): number {
  if (total <= 0 || offset >= model.prefix(total)) return total;
  let low = 0;
  let high = total;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (model.prefix(middle + 1) <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** First row whose top is at or after `offset`. */
function firstRowAtOrAfter(model: HeightModel, total: number, offset: number): number {
  let low = 0;
  let high = total;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const top = rowTop(model, middle);
    if (top < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function range(start: number, end: number, total: number): VirtualizerRange {
  const safeStart = Math.max(0, Math.min(total, Math.floor(start)));
  const safeEnd = Math.max(safeStart, Math.min(total, Math.floor(end)));
  return { start: safeStart, end: safeEnd, before: safeStart, after: total - safeEnd };
}

function capWindow(
  visible: VirtualizerRange,
  requested: VirtualizerRange,
  total: number,
  maxWindow: number,
  direction: VirtualizerDirection,
  anchorIndex: number | null
): VirtualizerRange {
  if (maxWindow >= requested.end - requested.start) return requested;
  if (maxWindow <= 0 || total <= 0) return range(0, 0, total);

  const length = Math.min(total, maxWindow);
  let start: number;
  if (direction === 'tail') {
    start = total - length;
  } else if (direction === 'backward') {
    start = visible.start;
  } else if (direction === 'forward') {
    start = visible.end - length;
  } else {
    const center = anchorIndex ?? Math.floor((visible.start + visible.end) / 2);
    start = center - Math.floor(length / 2);
  }

  if (anchorIndex != null && anchorIndex >= 0 && anchorIndex < total) {
    if (anchorIndex < start) start = anchorIndex;
    else if (anchorIndex >= start + length) start = anchorIndex - length + 1;
  }
  return range(Math.max(0, Math.min(total - length, start)), Math.max(0, Math.min(total, start + length)), total);
}

/**
 * Calculate a bounded absolute render window from a viewport/anchor snapshot.
 * The result is a plain object and can be persisted or passed over IPC.
 */
export function computeVirtualWindow(input: MeasuredVirtualizerInput): MeasuredVirtualizerResult {
  const total = normalizeTotal(input.total);
  const sourceBefore = Math.max(0, Math.min(total, nonNegativeInteger(input.before, 0)));
  const estimate = positiveHeight(
    input.estimatedRowHeight ?? input.rowHeight,
    DEFAULT_ESTIMATED_ROW_HEIGHT
  );
  const measured = normalizeHeightMap(
    input.measuredHeights ?? input.measuredRowHeights,
    total
  );
  const margins = normalizeMarginMap(input.measuredMargins, total);
  const gap = Math.max(0, finiteNumber(input.rowGap, 0));
  const model = makeHeightModel(total, estimate, measured, margins, gap);
  const contentHeight = model.prefix(total);
  const viewportHeight = Math.max(
    0,
    finiteNumber(input.viewport?.height ?? input.viewportHeight, 0)
  );
  const layoutViewportHeight = viewportHeight > 0 ? viewportHeight : estimate;
  const direction = input.direction ?? 'tail';
  const explicitAnchor = input.anchor && total > 0
    ? {
        index: Math.max(0, Math.min(total - 1, nonNegativeInteger(input.anchor.index, 0))),
        offset: finiteNumber(input.anchor.offset, 0)
      }
    : null;
  const hasExplicitPosition = explicitAnchor != null || input.scrollOffset != null || input.viewport?.offset != null;
  const tail = !hasExplicitPosition && direction === 'tail';

  let scrollOffset: number;
  if (explicitAnchor) {
    scrollOffset = rowTop(model, explicitAnchor.index) - explicitAnchor.offset;
  } else if (input.viewport?.offset != null || input.scrollOffset != null) {
    scrollOffset = finiteNumber(input.viewport?.offset ?? input.scrollOffset, 0);
  } else if (direction === 'forward') {
    scrollOffset = 0;
  } else if (direction === 'backward') {
    scrollOffset = rowTop(model, sourceBefore);
  } else {
    scrollOffset = contentHeight - layoutViewportHeight;
  }
  const maxScroll = Math.max(0, contentHeight - layoutViewportHeight);
  scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset));

  let visibleStart = rowAtOffset(model, total, scrollOffset);
  let visibleEnd = firstRowAtOrAfter(model, total, Math.min(contentHeight, scrollOffset + layoutViewportHeight));
  if (total > 0 && viewportHeight <= 0) {
    visibleEnd = Math.min(total, visibleStart + 1);
  }
  visibleStart = Math.max(0, Math.min(total, visibleStart));
  visibleEnd = Math.max(visibleStart, Math.min(total, visibleEnd));
  const visible = range(visibleStart, visibleEnd, total);

  const overscan = nonNegativeInteger(input.overscan, 0);
  const requested = range(
    Math.max(0, visible.start - overscan),
    Math.min(total, visible.end + overscan),
    total
  );
  const configuredMax = input.maxWindow == null
    ? Number.POSITIVE_INFINITY
    : nonNegativeInteger(input.maxWindow, 0);
  const anchorIndex = explicitAnchor?.index ?? (visible.end > visible.start ? visible.start : null);
  const window = capWindow(visible, requested, total, configuredMax, direction, anchorIndex);
  const effectiveAnchor = total > 0
    ? {
        index: explicitAnchor?.index ?? Math.min(total - 1, visible.start),
        offset: rowTop(model, explicitAnchor?.index ?? Math.min(total - 1, visible.start)) - scrollOffset
      }
    : null;

  return {
    total,
    sourceBefore,
    estimatedRowHeight: estimate,
    viewportHeight,
    contentHeight,
    beforeHeight: model.prefix(window.start),
    afterHeight: Math.max(
      0,
      contentHeight - model.prefix(window.end) -
        (window.end > 0 && window.end < total ? gap : 0)
    ),
    scrollOffset,
    visible,
    window,
    before: window.before,
    after: window.after,
    anchor: effectiveAnchor,
    direction,
    tail
  };
}

/**
 * Return the scroll correction required after measured rows settle.  Only
 * rows before the anchor move its viewport-relative position.  The anchor row
 * itself is intentionally excluded because changing its height does not move
 * its top edge.
 */
export function computeAnchorCompensation(input: AnchorCompensationInput): AnchorCompensationResult {
  const estimate = positiveHeight(
    input.estimatedRowHeight ?? input.rowHeight,
    DEFAULT_ESTIMATED_ROW_HEIGHT
  );
  const anchorIndex = nonNegativeInteger(input.anchor.index, 0);
  const previous = normalizeHeightMap(input.previousMeasuredHeights, Number.MAX_SAFE_INTEGER);
  const next = normalizeHeightMap(input.nextMeasuredHeights, Number.MAX_SAFE_INTEGER);
  const indexes = new Set<number>();
  for (const key of Object.keys(previous)) indexes.add(Number(key));
  for (const key of Object.keys(next)) indexes.add(Number(key));
  let deltaBeforeAnchor = 0;
  for (const index of indexes) {
    if (index >= anchorIndex) continue;
    const before = previous[String(index)] ?? estimate;
    const after = next[String(index)] ?? estimate;
    deltaBeforeAnchor += after - before;
  }
  const compensatedOffset = finiteNumber(input.anchor.offset, 0);
  return {
    anchor: { index: anchorIndex, offset: compensatedOffset },
    deltaBeforeAnchor,
    scrollAdjustment: deltaBeforeAnchor,
    compensatedOffset,
    ...(input.scrollOffset != null ? { scrollOffset: finiteNumber(input.scrollOffset, 0) + deltaBeforeAnchor } : {})
  };
}

function normalizePage(page: VirtualizerPage, total: number): VirtualizerPage | null {
  const start = nonNegativeInteger(page.start, 0);
  const end = nonNegativeInteger(page.end, start);
  const safeStart = Math.min(total, start);
  const safeEnd = Math.max(safeStart, Math.min(total, end));
  return safeEnd > safeStart ? { start: safeStart, end: safeEnd } : null;
}

function pageIntersects(page: VirtualizerPage, start: number, end: number): boolean {
  return page.start < end && page.end > start;
}

/**
 * Keep pages intersecting a desired range, optionally retaining adjacent pages,
 * then enforce a page-count bound around the anchor.  No page objects are
 * mutated and every return value is JSON serializable.
 */
export function evictVirtualPages(input: PageEvictionInput): PageEvictionResult {
  const hasExplicitTotal = input.total != null;
  const hintedTotal = hasExplicitTotal ? normalizeTotal(input.total!) : 0;
  const pageTotal = hasExplicitTotal ? hintedTotal : undefined;
  const normalized = input.pages
    .map(page => normalizePage(
      page,
      pageTotal ?? Math.max(0, nonNegativeInteger(page.end, 0))
    ))
    .filter((page): page is VirtualizerPage => page != null)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const total = hasExplicitTotal ? hintedTotal : normalized.reduce((max, page) => Math.max(max, page.end), 0);
  const keepStart = Math.max(0, Math.min(total, nonNegativeInteger(input.keep.start, 0)));
  const keepEnd = Math.max(keepStart, Math.min(total, nonNegativeInteger(input.keep.end, keepStart)));
  if (normalized.length === 0) {
    return { pages: [], evicted: [], evictedBefore: [], evictedAfter: [], before: keepStart, after: total - keepEnd, total };
  }

  const intersecting = normalized
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => pageIntersects(page, keepStart, keepEnd));
  const keepIndexes = new Set<number>(intersecting.map(item => item.index));
  const adjacent = nonNegativeInteger(input.overscanPages, 0);
  if (intersecting.length > 0 && adjacent > 0) {
    const first = intersecting[0]!.index;
    const last = intersecting[intersecting.length - 1]!.index;
    for (let distance = 1; distance <= adjacent; distance++) {
      if (first - distance >= 0) keepIndexes.add(first - distance);
      if (last + distance < normalized.length) keepIndexes.add(last + distance);
    }
  }
  if (intersecting.length === 0) {
    // A range gap still needs a deterministic page around the requested
    // anchor so a bounded source can make progress in either direction.
    const target = input.anchorIndex == null ? keepStart : nonNegativeInteger(input.anchorIndex, keepStart);
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    normalized.forEach((page, index) => {
      const pageDistance = target < page.start ? page.start - target : target >= page.end ? target - page.end + 1 : 0;
      if (pageDistance < distance) {
        distance = pageDistance;
        nearest = index;
      }
    });
    keepIndexes.add(nearest);
  }

  let retainedIndexes = [...keepIndexes].sort((a, b) => a - b);
  const maxPages = input.maxPages == null ? Number.POSITIVE_INFINITY : nonNegativeInteger(input.maxPages, 0);
  if (retainedIndexes.length > maxPages) {
    const target = input.anchorIndex == null ? (keepStart + keepEnd) / 2 : input.anchorIndex;
    retainedIndexes = retainedIndexes
      .sort((a, b) => {
        const aPage = normalized[a]!;
        const bPage = normalized[b]!;
        const aDistance = target < aPage.start ? aPage.start - target : target >= aPage.end ? target - aPage.end + 1 : 0;
        const bDistance = target < bPage.start ? bPage.start - target : target >= bPage.end ? target - bPage.end + 1 : 0;
        return aDistance - bDistance || a - b;
      })
      .slice(0, maxPages)
      .sort((a, b) => a - b);
  }
  const retainedSet = new Set(retainedIndexes);
  const pages = retainedIndexes.map(index => normalized[index]!);
  const evicted = normalized.filter((_page, index) => !retainedSet.has(index));
  const retainedStart = pages.length > 0 ? pages[0]!.start : keepStart;
  const retainedEnd = pages.length > 0 ? pages[pages.length - 1]!.end : keepEnd;
  const evictedBefore = evicted.filter(page => page.end <= retainedStart);
  const evictedAfter = evicted.filter(page => page.start >= retainedEnd);
  return {
    pages,
    evicted,
    evictedBefore,
    evictedAfter,
    before: retainedStart,
    after: total - retainedEnd,
    total
  };
}

/** Alias used by callers that name the operation after page trimming. */
export const trimVirtualizerPages = evictVirtualPages;

