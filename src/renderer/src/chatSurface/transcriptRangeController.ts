/** Pure range decisions used by the transcript viewport.
 *
 * DOM measurement and scroll effects stay in ChatTranscript. These functions
 * only decide which absolute stream range should be retained, so range rules
 * can be tested without React or a browser layout engine.
 */
export interface TranscriptClipRangeInput {
  streamLength: number;
  messageCount: number;
  clipExtra: number;
  clipThreshold: number;
  clipWindow: number;
  measuredVirtualizerActive: boolean;
  stickBottom: boolean;
  frozenClipStart: number | null;
}

export interface TranscriptClipRangeResult {
  clipStart: number;
  movingClipStart: number;
  frozenClipStart: number | null;
}

export function resolveTranscriptClipRange(input: TranscriptClipRangeInput): TranscriptClipRangeResult {
  const clipActive = input.messageCount > input.clipThreshold;
  const movingClipStart = clipActive
    ? Math.max(0, input.streamLength - (input.clipWindow + Math.max(0, input.clipExtra)))
    : 0;
  let clipStart = movingClipStart;
  let frozenClipStart = input.frozenClipStart;

  if (input.measuredVirtualizerActive || !clipActive || input.stickBottom) {
    frozenClipStart = null;
  } else {
    const frozen = frozenClipStart ?? movingClipStart;
    clipStart = Math.min(frozen, movingClipStart);
    frozenClipStart = clipStart;
  }

  return { clipStart, movingClipStart, frozenClipStart };
}

export interface ProgressiveRangeItem {
  kind: 'message' | 'compaction' | 'gap';
  partCount?: number;
}

export interface ProgressiveRangeInput {
  items: { length: number; get(index: number): ProgressiveRangeItem | undefined };
  clipStart: number;
  budget: number;
}

export interface ProgressiveRangeResult {
  renderFrom: number;
  nextProgressBudget: number;
}

export function resolveProgressiveRange(input: ProgressiveRangeInput): ProgressiveRangeResult {
  if (!Number.isFinite(input.budget)) {
    return { renderFrom: input.clipStart, nextProgressBudget: 0 };
  }

  let used = 0;
  let renderFrom = input.items.length;
  for (let index = input.items.length - 1; index >= input.clipStart; index--) {
    const item = input.items.get(index);
    const weight = item?.kind === 'message' ? Math.max(1, item.partCount ?? 1) : 1;
    if (used + weight > input.budget && renderFrom < input.items.length) break;
    used += weight;
    renderFrom = index;
  }

  const previous = input.items.get(renderFrom - 1);
  const previousWeight = previous?.kind === 'message' ? Math.max(1, previous.partCount ?? 1) : 1;
  return {
    renderFrom: Math.max(input.clipStart, renderFrom),
    nextProgressBudget: used + previousWeight
  };
}
