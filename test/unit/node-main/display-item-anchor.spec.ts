// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AgentSessionHost } from '../../../src/main/agentSession/host/agentSessionHost';
import { Orchestrator } from '../../../src/main/agent/orchestrator';
import { GuiSessionStore } from '../../../src/main/agentSession/persist';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.stubGlobal('window', globalThis);
const payload = { kind: 'mail' as const, pages: [{ key: 'ws:one:0', text: '信件正文', offset: 0, sender: { sessionId: 'child', name: 'Child' } }] };

describe('仅展示记录绑定', () => {
  it('GUI 迟到结果绑定原消息，清空或会话代变化后不再写入', () => {
    const original = { id: 'first', role: 'assistant', parts: [{ kind: 'text', text: 'old' }] };
    const later = { id: 'second', role: 'assistant', parts: [] };
    const entry = { sessionId: 's', busy: true, assistant: original, messages: [original, later],
      closed: false, clearing: false, lastUsage: null, injections: [], compactions: [] };
    const save = vi.fn();
    const host = { entries: new Map([['s', entry]]), ctx: { getWindow: () => null }, pushSubs: new Set(), store: { save } };
    const capture = AgentSessionHost.prototype.captureDisplayItemSink.call(host as unknown as AgentSessionHost, 's')!;
    entry.assistant = later;
    expect(capture(payload)).toBe(true);
    expect(original).toMatchObject({ displayItems: [{ anchorPartIndex: 1, kind: 'mail' }] });
    expect(later).not.toHaveProperty('displayItems');
    expect(save).toHaveBeenCalledTimes(1);
    entry.messages = [later];
    expect(capture(payload)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    host.entries.set('s', { ...entry });
    expect(capture(payload)).toBe(false);
  });

  it('调度消息切换后仍绑定原工作区和消息，移除后拒绝迟到结果', () => {
    const original = { id: 'first', role: 'assistant', parts: [{ kind: 'text', text: 'old' }] };
    const later = { id: 'second', role: 'assistant', parts: [] };
    const bucket = { busy: true, streamingAssistant: original, display: [original, later] };
    const emit = vi.fn(), persistBucket = vi.fn();
    const host = { buckets: new Map([['ws', bucket]]), emit, persistBucket };
    const capture = Orchestrator.prototype.captureDisplayItemSink.call(host as unknown as Orchestrator, 'ws')!;
    bucket.streamingAssistant = later;
    expect(capture(payload)).toBe(true);
    expect(original).toMatchObject({ displayItems: [{ anchorPartIndex: 1, kind: 'mail' }] });
    expect(later).not.toHaveProperty('displayItems');
    expect(emit).toHaveBeenCalledTimes(1);
    bucket.display = [later];
    expect(capture(payload)).toBe(false);
    expect(persistBucket).toHaveBeenCalledTimes(1);
  });

  it('GUI 展示记录随历史恢复，过滤思考后保留对应锚点', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'display-items-test-'));
    try {
      const store = new GuiSessionStore(dir, () => true);
      const msg = { id: 'm', role: 'assistant' as const, ts: 1,
        parts: [{ kind: 'thinking' as const, text: 'private' }, { kind: 'text' as const, text: '回答' }],
        displayItems: [{ ...payload, id: 'd', anchorPartIndex: 1 }] };
      store.save('session', [msg], null, [], []);
      store.flushSync();
      const restored = new GuiSessionStore(dir).load('session')[0]!;
      expect(restored.parts).toEqual([{ kind: 'text', text: '回答' }]);
      expect(restored.displayItems).toEqual([{ ...payload, id: 'd', anchorPartIndex: 0 }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
