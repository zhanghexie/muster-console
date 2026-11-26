import { describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  AgentSessionSurfaceStore
} from '../../src/renderer/src/chatSurface/agentSessionSurface';
import {
  OrchestratorChatStore
} from '../../src/renderer/src/chatSurface/orchestratorSurface';
import type { GuiChatMessage, GuiWorkerHistoryPage } from '../../src/shared/guiWorker';
import { resolveChatHistoryWindow } from '../../src/shared/chatHistory';
import type { ChatMessage } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

function guiMessage(id: string, ts: number): GuiChatMessage {
  return { id, role: 'user', ts, parts: [{ kind: 'text', text: id }] } as GuiChatMessage;
}

function schedulerMessage(id: string, createdAt: number): ChatMessage {
  return { id, role: 'assistant', content: id, createdAt };
}

describe('surface page-map integration', () => {
  it('publishes GUI absolute ranges and an earlier-page load guard without changing messages[]', async () => {
    const api = currentApiMock();
    const pages: GuiWorkerHistoryPage[] = [
      { messages: [guiMessage('m1', 1), guiMessage('m2', 2)], mode: 'auto', busy: false, before: 1, total: 3, hasEarlier: true },
      { messages: [guiMessage('m0', 0)], mode: 'auto', busy: false, before: 0, total: 3, hasEarlier: false }
    ];
    api.mockOf('agentSession.historyRange').mockImplementation(async (_id: string, before?: number) =>
      before === undefined ? pages[0] : pages[1]);

    const store = new AgentSessionSurfaceStore('page-map-gui', {
      id: 'pi', pi: true, claude: false, acp: false, codex: false
    });
    store.attach('pi', { flashTip: vi.fn(), t: (key) => key });
    try {
      await waitFor(() => expect(store.getSnapshot().messages).toHaveLength(2));
      const tail = store.getSnapshot();
      expect(tail.page).toMatchObject({
        total: 3,
        loadedRanges: [{ start: 1, end: 3 }],
        loadState: { tail: { status: 'loaded' } }
      });
      const generation = tail.page?.generation;
      expect(generation).toBeGreaterThan(1);

      const loading = store.loadEarlier();
      await waitFor(() => expect(store.getSnapshot().page?.loadState.earlier.status).toBe('loading'));
      await loading;
      const full = store.getSnapshot();
      expect(full.messages.map((item) => (item as GuiChatMessage).id)).toEqual(['m0', 'm1', 'm2']);
      expect(full.page).toMatchObject({
        generation,
        total: 3,
        loadedRanges: [{ start: 0, end: 3 }],
        loadState: { earlier: { status: 'loaded' } }
      });
      // A hidden keep-alive tab cancels IO but must not look like cleared
      // history to ChatTranscript when it is selected again.
      store.dispose(true);
      store.attach('pi', { flashTip: vi.fn(), t: key => key });
      await waitFor(() => expect(store.getSnapshot().page?.loadState.tail.status).toBe('loaded'));
      expect(store.getSnapshot().page?.generation).toBe(generation);
      expect(store.getSnapshot().messages.map(message => (message as GuiChatMessage).id)).toEqual(['m0', 'm1', 'm2']);
    } finally {
      store.dispose();
    }
  });

  it('invalidates a scheduler page generation on clear while an initial page is in flight', async () => {
    const api = currentApiMock();
    let release: ((page: ChatHistoryPageLike) => void) | undefined;
    api.override('chat.historyRange', async () => new Promise<ChatHistoryPageLike>((resolve) => { release = resolve; }));
    const store = new OrchestratorChatStore();
    const wsId = 'page-map-scheduler';
    store.registerLive(wsId);
    const pending = store.ensureHistory(wsId);
    await waitFor(() => expect(store.snapshot(wsId).page?.loadState.tail.status).toBe('loading'));
    const before = store.snapshot(wsId).page?.generation;

    await store.clear(wsId);
    const afterClear = store.snapshot(wsId);
    expect(afterClear.messages).toEqual([]);
    expect(afterClear.page?.generation).toBeGreaterThan(before ?? 0);
    expect(afterClear.page?.loadedRanges).toEqual([]);

    release?.({ messages: [schedulerMessage('stale', 1)], before: 0, total: 1, hasEarlier: false });
    await pending;
    expect(store.snapshot(wsId).messages).toEqual([]);
    expect(store.snapshot(wsId).page?.loadedRanges).toEqual([]);
  });

  it('publishes scheduler absolute ranges while preserving the existing message projection', async () => {
    const api = currentApiMock();
    api.override('chat.historyRange', async () => ({
      messages: [schedulerMessage('s1', 1), schedulerMessage('s2', 2)],
      before: 1,
      total: 3,
      hasEarlier: true
    }));
    const store = new OrchestratorChatStore();
    const wsId = 'page-map-scheduler-loaded';
    store.registerLive(wsId);
    await store.ensureHistory(wsId);

    const snapshot = store.snapshot(wsId);
    expect(snapshot.messages.map((item) => (item as ChatMessage).id)).toEqual(['s1', 's2']);
    expect(snapshot.page).toMatchObject({
      total: 3,
      loadedRanges: [{ start: 1, end: 3 }],
      loadState: { tail: { status: 'loaded' } }
    });
  });

  it('fetches a scheduler target directly', async () => {
    const api = currentApiMock();
    api.override('chat.historyRange', async (_wsId: string, _before?: number, _limit?: number, target?: string) => !target
      ? { messages: [schedulerMessage('s2', 2)], before: 2, total: 3, hasEarlier: true }
      : { messages: [schedulerMessage('s0', 0), schedulerMessage('s1', 1)], before: 0, total: 3, hasEarlier: false });
    const store = new OrchestratorChatStore();
    const wsId = 'page-map-scheduler-target';
    store.registerLive(wsId);
    await store.ensureHistory(wsId);

    await expect(store.ensureMessageLoaded(wsId, 's0')).resolves.toBe(true);
    expect(store.snapshot(wsId).messages.map((item) => (item as ChatMessage).id)).toEqual(['s0', 's1', 's2']);
    expect(api.mockOf('chat.historyRange')).toHaveBeenNthCalledWith(2, wsId, undefined, 120, 's0');
  });

  it('releases GUI payloads, preserves absolute slots and reloads gaps in both directions', async () => {
    const all = Array.from({ length: 10000 }, (_, i) => guiMessage(`m${i}`, i));
    const range = currentApiMock().mockOf('agentSession.historyRange');
    range.mockImplementation(async (_id: string, before?: number, limit?: number, target?: string) => {
      const { start, end } = resolveChatHistoryWindow(all, before, limit, target);
      return { messages: all.slice(start, end), mode: 'auto', busy: false, before: start, total: all.length, hasEarlier: start > 0 };
    });
    const store = new AgentSessionSurfaceStore('page-map-eviction', {
      id: 'pi', pi: true, claude: false, acp: false, codex: false
    });
    store.attach('pi', { flashTip: vi.fn(), t: (key) => key });
    try {
      await waitFor(() => expect(store.messageIndex('m9999')).toBe(9999));
      for (const start of [0, 4800, 1200, 9600, 0]) {
        store.retainPageWindow({ start, end: start + 60, anchorIndex: start });
        await waitFor(() => expect(store.messageIndex(`m${start}`)).toBe(start));
        expect(store.getSnapshot().messages.length).toBeLessThanOrEqual(840);
        expect(store.getPageMapSnapshot().total).toBe(10000);
        expect(store.messageIndex('m9999')).toBe(9999);
      }
      expect(store.messageIndex('m4800')).toBeUndefined();
      expect(store.getSnapshot().messages.some(message => (message as GuiChatMessage).id === 'm4800')).toBe(false);
      const calls = range.mock.calls.length;
      expect(await store.ensureMessageLoaded('m4800')).toBe(true);
      expect(range.mock.calls.length).toBe(calls + 1);
      expect(store.messageIndex('m4800')).toBe(4800);
      // The old viewport can report once after the async response but before
      // React commits the new target. It must not evict that target again.
      store.retainPageWindow({ start: 9880, end: 10000 });
      expect(store.messageIndex('m4800')).toBe(4800);
      store.retainPageWindow({ start: 4780, end: 4820 });
      store.retainPageWindow({ start: 9880, end: 10000 });
      expect(store.messageIndex('m4800')).toBeUndefined();
      expect(await store.ensureMessageLoaded('missing')).toBe(false);
    } finally { store.dispose(); }
  });

  it('bounds scheduler payloads during navigation and ongoing live appends', async () => {
    const all = Array.from({ length: 10000 }, (_, i) => schedulerMessage(`s${i}`, i));
    const api = currentApiMock();
    api.override('chat.historyRange', async (_id: string, before?: number, limit?: number, target?: string) => {
      const { start, end } = resolveChatHistoryWindow(all, before, limit, target);
      return { messages: all.slice(start, end), before: start, total: all.length, hasEarlier: start > 0 };
    });
    const store = new OrchestratorChatStore();
    const ws = 'sparse-scheduler';
    store.registerLive(ws);
    await store.ensureHistory(ws);
    for (const start of [0, 3600, 1200, 9600]) {
      store.retainPageWindow(ws, { start, end: start + 60 });
      await waitFor(() => expect(store.messageIndex(ws, `s${start}`)).toBe(start));
      expect(store.snapshot(ws).messages.length).toBeLessThanOrEqual(840);
    }
    for (let i = 10000; i < 10500; i++) store.handleMessage({ ...schedulerMessage(`s${i}`, i), workspaceId: ws });
    expect(store.snapshot(ws).messages.length).toBeLessThanOrEqual(840);
    expect(store.getPageMapSnapshot(ws)?.total).toBe(10500);
    expect(store.messageIndex(ws, 's10499')).toBe(10499);
    expect(store.messageIndex(ws, 's0')).toBeUndefined();
  });

});

type ChatHistoryPageLike = {
  messages: ChatMessage[];
  before: number;
  total: number;
  hasEarlier: boolean;
};
