import { describe, expect, it } from 'vitest';
import { transcriptRows } from '../../src/renderer/src/chatSurface/sparseTranscript';
import { resolveChatHistoryWindow } from '../../src/shared/chatHistory';
import type { ChatSurfacePageState } from '../../src/shared/chatSurface';

const page = (total: number, slots: Array<{ index: number; messageId: string }>): ChatSurfacePageState => ({
  generation: 1, total, slots, loadedRanges: [], cursor: {}, loadState: {
    tail: { status: 'loaded', generation: 1 }, earlier: { status: 'idle', generation: 1 }, later: { status: 'idle', generation: 1 }
  }
});

describe('sparse transcript coordinates', () => {
  it('keeps holes and absolute indexes without materializing the full session', () => {
    const source = transcriptRows([{ id: 'a', createdAt: 100 }, { id: 'z', createdAt: 1000000 }], [],
      page(1000000, [{ index: 100, messageId: 'a' }, { index: 999999, messageId: 'z' }, { index: 101, messageId: 'hidden' }]));
    expect(source.length).toBe(1000000);
    expect(source.findIndex(row => row.kind === 'message' && row.message.id === 'z')).toBe(999999);
    expect(source.slice(99, 103).map(row => row.kind)).toEqual(['gap', 'message', 'gap', 'gap']);
    expect(source.get(101)).toMatchObject({ kind: 'gap', hidden: true });
    expect(source.get(102)).toMatchObject({ kind: 'gap', hidden: false });
    expect(source.get(1000000)).toBeUndefined();
  });

  it('keeps compaction decoration inside its anchored row without shifting later slots', () => {
    const slots = [{ index: 10, messageId: 'a' }, { index: 11, messageId: 'b' }];
    const source = transcriptRows([{ id: 'a', createdAt: 10 }, { id: 'b', createdAt: 20 }],
      [{ id: 'c', createdAt: 15, status: 'complete' }], page(100, slots));
    expect(source.get(10)).toMatchObject({ kind: 'message', decorations: [{ id: 'c' }] });
    expect(source.findIndex(row => row.kind === 'message' && row.message.id === 'b')).toBe(11);
    expect(source.length).toBe(100);
  });

  it('locates a target in one bounded range and never treats an absent target as tail', () => {
    const all = Array.from({ length: 10000 }, (_, i) => ({ id: `m${i}` }));
    expect(resolveChatHistoryWindow(all, undefined, 120, 'm5000')).toEqual({ start: 4940, end: 5060 });
    expect(resolveChatHistoryWindow(all, undefined, 120, 'missing')).toEqual({ start: 0, end: 0 });
    expect(resolveChatHistoryWindow(all, undefined, 120, 'm9999')).toEqual({ start: 9880, end: 10000 });
    expect(resolveChatHistoryWindow(all, 480, 120)).toEqual({ start: 360, end: 480 });
  });
});
