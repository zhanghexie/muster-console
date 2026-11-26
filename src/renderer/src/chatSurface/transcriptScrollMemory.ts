/**
 * Bounded reading-position memory shared by transcript instances.
 *
 * The view itself owns DOM anchors and restoration timing. This module only
 * owns the small process-local LRU so ChatTranscript does not mix persistence
 * policy with layout and row rendering.
 */
export interface TranscriptScrollMemory {
  /** Absolute scrollTop fallback when the anchor is unavailable. */
  top: number;
  /** Number of older rows loaded before the current viewport. */
  clipExtra: number;
  /** Message id at the top of the viewport, when one is available. */
  anchorMid: string | null;
  /** Offset from the anchor row top to the viewport top. */
  anchorOffset: number;
}

const SCROLL_MEMORY_CAP = 64;
const scrollMemory = new Map<string, TranscriptScrollMemory>();

export function rememberTranscriptScroll(sessionId: string, memory: TranscriptScrollMemory): void {
  scrollMemory.delete(sessionId);
  scrollMemory.set(sessionId, memory);
  while (scrollMemory.size > SCROLL_MEMORY_CAP) {
    const oldest = scrollMemory.keys().next().value;
    if (oldest === undefined || oldest === sessionId) break;
    scrollMemory.delete(oldest);
  }
}

/** Reaching the tail clears the saved reading position for the session. */
export function resetOneTranscriptScroll(sessionId: string): void {
  scrollMemory.delete(sessionId);
}

export function takeTranscriptScroll(sessionId: string): TranscriptScrollMemory | null {
  return scrollMemory.get(sessionId) ?? null;
}

/** Test-only reset. The production view never needs to clear all sessions. */
export function resetTranscriptScrollMemoryForTest(): void {
  scrollMemory.clear();
}
