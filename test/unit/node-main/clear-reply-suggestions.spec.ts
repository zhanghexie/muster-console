import { describe, expect, it, vi } from 'vitest';
import type { HostCore } from '../../../src/main/agentSession/host/internal';
import type { OrchestratorHost } from '../../../src/main/agent/orchestrator/internal';
import { clearSuggestedReplies as clearGui } from '../../../src/main/agentSession/host/suggestions';
import { clearSuggestedReplies as clearDispatch } from '../../../src/main/agent/orchestrator/suggestions';

describe('clearing the current reply suggestions', () => {
  it('GUI persists and broadcasts the current snapshot, leaving other sessions untouched', () => {
    const message = { id: 'a1', role: 'assistant', parts: [], ts: 1, suggestedReplies: ['继续', '稍后'] };
    const other = { id: 'a2', role: 'assistant', parts: [], ts: 1, suggestedReplies: ['别的会话'] };
    const entry = { sessionId: 'one', closed: false, busy: false, messages: [message], lastUsage: null, injections: [], compactions: [] };
    const save = vi.fn(), push = vi.fn();
    const host = { entries: new Map([['one', entry], ['two', { ...entry, sessionId: 'two', messages: [other] }]]),
      ctx: { getWindow: () => null }, store: { save }, pushSubs: new Set([push]) } as unknown as HostCore;
    expect(clearGui(host, 'one', { messageId: 'a1', replies: ['继续', '稍后'] })).toBe(true);
    expect(message.suggestedReplies).toBeUndefined();
    expect(other.suggestedReplies).toEqual(['别的会话']);
    expect(save).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sync', sessionId: 'one' }));
  });

  it('a late GUI request cannot clear a changed snapshot or an older turn', () => {
    const message = { id: 'a1', role: 'assistant', parts: [], ts: 1, suggestedReplies: ['新建议'] };
    const entry = { sessionId: 'one', closed: false, busy: false, messages: [message], lastUsage: null, injections: [], compactions: [] };
    const save = vi.fn();
    const host = { entries: new Map([['one', entry]]), store: { save } } as unknown as HostCore;
    expect(clearGui(host, 'one', { messageId: 'a1', replies: ['旧建议'] })).toBe(false);
    entry.messages.push({ id: 'u1', role: 'user', parts: [], ts: 2, suggestedReplies: [] });
    expect(clearGui(host, 'one', { messageId: 'a1', replies: ['新建议'] })).toBe(false);
    expect(message.suggestedReplies).toEqual(['新建议']);
    expect(save).not.toHaveBeenCalled();
  });

  it('bounds the sync payload to the live tail for long GUI sessions', () => {
    const messages = Array.from({ length: 140 }, (_, i) => ({
      id: `m${i}`, role: 'assistant', parts: [], ts: i, suggestedReplies: i === 139 ? ['继续'] : undefined
    }));
    const entry = { sessionId: 'long', closed: false, busy: false, messages, lastUsage: null, injections: [], compactions: [] };
    const save = vi.fn(), push = vi.fn();
    const host = { entries: new Map([['long', entry]]), ctx: { getWindow: () => null }, store: { save }, pushSubs: new Set([push]) } as unknown as HostCore;
    expect(clearGui(host, 'long', { messageId: 'm139', replies: ['继续'] })).toBe(true);
    expect(push.mock.calls[0]?.[0]?.messages).toHaveLength(120);
    expect(push.mock.calls[0]?.[0]?.messages.at(-1)?.id).toBe('m139');
  });

  it('restores GUI suggestions when persistence fails', () => {
    const message = { id: 'a1', role: 'assistant', parts: [], ts: 1, suggestedReplies: ['继续'] };
    const host = { entries: new Map([['one', { sessionId: 'one', closed: false, busy: false, messages: [message],
      lastUsage: null, injections: [], compactions: [] }]]), store: { save: () => { throw new Error('disk'); } } } as unknown as HostCore;
    expect(() => clearGui(host, 'one', { messageId: 'a1', replies: ['继续'] })).toThrow('disk');
    expect(message.suggestedReplies).toEqual(['继续']);
  });

  it('dispatch rejects stale clear requests while a question is pending', () => {
    const userQuestion = { status: 'pending', questions: [{ id: 'q' }] };
    const message = { id: 'a1', role: 'assistant', content: '', userQuestion, suggestedReplies: ['方案A', '方案B'] };
    const persistBucket = vi.fn(), emit = vi.fn();
    const host = { buckets: new Map([['ws', { busy: true, display: [message] }]]), persistBucket, emit } as unknown as OrchestratorHost;
    expect(clearDispatch(host, 'ws', { messageId: 'a1', replies: ['旧建议'] })).toBe(false);
    expect(clearDispatch(host, 'ws', { messageId: 'a1', replies: ['方案A', '方案B'] })).toBe(false);
    expect(message.suggestedReplies).toEqual(['方案A', '方案B']);
    expect(message.userQuestion).toBe(userQuestion);
    expect(persistBucket).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
