import { afterEach, describe, expect, it } from 'vitest';
import {
  rememberTranscriptScroll,
  resetOneTranscriptScroll,
  resetTranscriptScrollMemoryForTest,
  takeTranscriptScroll,
  type TranscriptScrollMemory
} from '../../src/renderer/src/chatSurface/transcriptScrollMemory';

function memory(top: number): TranscriptScrollMemory {
  return { top, clipExtra: top, anchorMid: `m-${top}`, anchorOffset: top / 10 };
}

describe('transcript scroll memory', () => {
  afterEach(() => resetTranscriptScrollMemoryForTest());

  it('updates recency and evicts the oldest session at the bounded cap', () => {
    for (let i = 0; i < 64; i++) rememberTranscriptScroll(`s-${i}`, memory(i));
    rememberTranscriptScroll('s-0', memory(100));
    rememberTranscriptScroll('s-64', memory(64));

    expect(takeTranscriptScroll('s-0')?.top).toBe(100);
    expect(takeTranscriptScroll('s-1')).toBeNull();
    expect(takeTranscriptScroll('s-64')?.top).toBe(64);
  });

  it('clears one session without affecting the other sessions', () => {
    rememberTranscriptScroll('keep', memory(1));
    rememberTranscriptScroll('clear', memory(2));

    resetOneTranscriptScroll('clear');

    expect(takeTranscriptScroll('clear')).toBeNull();
    expect(takeTranscriptScroll('keep')?.top).toBe(1);
  });
});
