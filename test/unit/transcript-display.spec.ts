import { describe, expect, it } from 'vitest';
import { mapTranscriptMessages, type TranscriptDisplayCache } from '../../src/renderer/src/chatSurface/transcriptDisplay';

type Source = { id: string; role: 'user' | 'assistant'; content: string };

function source(id: string, role: Source['role'], content = id): Source {
  return { id, role, content };
}

function map(message: Source, streaming: boolean) {
  return { id: message.id, role: message.role, content: `${message.content}:${streaming ? 'stream' : 'settled'}`, createdAt: 1 } as never;
}

describe('mapTranscriptMessages', () => {
  it('reuses equal projections and prunes removed source ids', () => {
    const cache: TranscriptDisplayCache<Source> = new Map();
    let calls = 0;
    const first = mapTranscriptMessages({ messages: [source('u', 'user')], busy: false, cache, toDisplay: (m, s) => { calls++; return map(m, s); }, throttleMs: 100, now: () => 100 });
    const second = mapTranscriptMessages({ messages: [{ ...source('u', 'user') }], busy: false, cache, toDisplay: (m, s) => { calls++; return map(m, s); }, messagesEqual: (a, b) => a.id === b.id && a.content === b.content, throttleMs: 100, now: () => 100 });

    expect(second[0]).toBe(first[0]);
    expect(calls).toBe(1);
    mapTranscriptMessages({ messages: [], busy: false, cache, toDisplay: map, throttleMs: 100, now: () => 100 });
    expect(cache.has('u')).toBe(false);
  });

  it('keeps a streaming projection stable inside the throttle window', () => {
    const cache: TranscriptDisplayCache<Source> = new Map();
    let now = 100;
    let calls = 0;
    const input = [source('u', 'user'), source('a', 'assistant', 'first')];
    const first = mapTranscriptMessages({ messages: input, busy: true, cache, toDisplay: (m, s) => { calls++; return map(m, s); }, throttleMs: 100, now: () => now });
    const second = mapTranscriptMessages({ messages: [{ ...input[0]! }, { ...input[1]!, content: 'new' }], busy: true, cache, toDisplay: (m, s) => { calls++; return map(m, s); }, messagesEqual: (a, b) => a.id === b.id && a.content === b.content, throttleMs: 100, now: () => now + 50 });

    expect(second[1]).toBe(first[1]);
    expect(calls).toBe(2);
    now = 300;
    const third = mapTranscriptMessages({ messages: [{ ...input[0]! }, { ...input[1]!, content: 'newer' }], busy: true, cache, toDisplay: (m, s) => { calls++; return map(m, s); }, messagesEqual: (a, b) => a.id === b.id && a.content === b.content, throttleMs: 100, now: () => now });
    expect(third[1]).not.toBe(second[1]);
    expect(calls).toBe(3);
  });
});
