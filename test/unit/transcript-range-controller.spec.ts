import { describe, expect, it } from 'vitest';
import { resolveProgressiveRange, resolveTranscriptClipRange } from '../../src/renderer/src/chatSurface/transcriptRangeController';

describe('transcript range controller', () => {
  it('freezes the leading edge while reading and only expands toward older rows', () => {
    const first = resolveTranscriptClipRange({
      streamLength: 1000, messageCount: 1000, clipExtra: 0, clipThreshold: 500, clipWindow: 120,
      measuredVirtualizerActive: false, stickBottom: false, frozenClipStart: null
    });
    const live = resolveTranscriptClipRange({
      streamLength: 1100, messageCount: 1100, clipExtra: 0, clipThreshold: 500, clipWindow: 120,
      measuredVirtualizerActive: false, stickBottom: false, frozenClipStart: first.frozenClipStart
    });
    const older = resolveTranscriptClipRange({
      streamLength: 1100, messageCount: 1100, clipExtra: 200, clipThreshold: 500, clipWindow: 120,
      measuredVirtualizerActive: false, stickBottom: false, frozenClipStart: live.frozenClipStart
    });

    expect(first.clipStart).toBe(880);
    expect(live.clipStart).toBe(880);
    expect(older.clipStart).toBe(780);
  });

  it('resets frozen range when the viewport returns to the tail or virtualizer', () => {
    const tail = resolveTranscriptClipRange({
      streamLength: 1000, messageCount: 1000, clipExtra: 0, clipThreshold: 500, clipWindow: 120,
      measuredVirtualizerActive: false, stickBottom: true, frozenClipStart: 300
    });
    const virtual = resolveTranscriptClipRange({
      streamLength: 1000, messageCount: 1000, clipExtra: 0, clipThreshold: 500, clipWindow: 120,
      measuredVirtualizerActive: true, stickBottom: false, frozenClipStart: 300
    });

    expect(tail.frozenClipStart).toBeNull();
    expect(virtual.frozenClipStart).toBeNull();
  });

  it('computes the progressive tail window from message part weights', () => {
    const items = [
      { kind: 'message' as const, partCount: 12 },
      { kind: 'message' as const, partCount: 3 },
      { kind: 'compaction' as const },
      { kind: 'message' as const, partCount: 5 }
    ];
    const result = resolveProgressiveRange({
      items: { length: items.length, get: index => items[index] },
      clipStart: 0,
      budget: 6
    });

    expect(result.renderFrom).toBe(2);
    expect(result.nextProgressBudget).toBe(9);
  });
});
