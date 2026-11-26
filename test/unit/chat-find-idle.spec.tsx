import { mockSearch } from './helpers/chat-search-mock';
/** 保活会话的关闭/隐藏查找不扫全文、不重复拉历史；再次打开仍使用保留的查询。 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentApiMock, installApiMock } from './helpers/api-mock';
import { patchChatFindShared, resetChatFindSharedForTest } from '../../src/renderer/src/chatSurface/chatFindRegistry';
import { useChatFind } from '../../src/renderer/src/chatSurface/useChatFind';
import type { ChatSearchableMessage } from '../../src/shared/chatSearch';
import type { AgentRuntimeEntry, SessionMeta } from '../../src/shared/types';

const runtime: AgentRuntimeEntry = {
  id: 'gui', label: 'GUI', script: '', builtin: true, enabled: true, updatedAt: 1, surface: 'chat'
};
const sessions = ['own', 'other'].map(id => ({
  id, type: 'terminal', name: id, createdAt: 1, runtime: 'gui'
})) as SessionMeta[];
const common = {
  surfaceKind: 'gui-session' as const, sessionId: 'own', sessionName: 'Own', workspaceId: 'ws',
  sessions, runtimes: [runtime], surfaceEl: null
};

describe('useChatFind inactive work', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installApiMock();
    resetChatFindSharedForTest();
  });
  afterEach(() => vi.useRealTimers());

  it('关闭及隐藏保留查询但不读正文，重新打开时搜索最新消息', () => {
    const read = vi.fn(() => 'kw first');
    const message = { id: 'm1', role: 'assistant', get content() { return read(); } } as ChatSearchableMessage;
    act(() => patchChatFindShared({ query: 'kw', ownerId: 'own' }));
    const view = renderHook(({ enabled, messages }) => useChatFind({ ...common, enabled, messages }), {
      initialProps: { enabled: true, messages: [message] }
    });
    expect(read).not.toHaveBeenCalled(); // 还原 searching 门控即红
    expect(view.result.current.query).toBe('kw');
    act(() => patchChatFindShared({ open: true }));
    expect(read).toHaveBeenCalled();
    expect(view.result.current.hits).toHaveLength(1);
    read.mockClear();
    view.rerender({ enabled: false, messages: [message] });
    expect(read).not.toHaveBeenCalled();
    expect(view.result.current.hits).toEqual([]);
    act(() => view.result.current.close());
    read.mockReturnValue('kw newest');
    view.rerender({ enabled: true, messages: [message] });
    expect(read).not.toHaveBeenCalled();
    act(() => patchChatFindShared({ open: true, ownerId: 'own' }));
    expect(view.result.current.hits[0]?.snippet).toContain('newest');
  });

  it('隐藏实例不拉全部会话，激活后拉取一次并保留跨会话结果', async () => {
    const api = currentApiMock();
    mockSearch(api, 'chat.search', async () => []);
    mockSearch(api, 'agentSession.search', async () => ({
      messages: [{ id: 'remote', role: 'assistant', content: 'kw remote' }]
    }));
    act(() => patchChatFindShared({ open: true, query: 'kw', scope: 'all', ownerId: 'own' }));
    const view = renderHook(({ enabled }) => useChatFind({ ...common, enabled, messages: [] }), {
      initialProps: { enabled: false }
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.mockOf('chat.search')).not.toHaveBeenCalled();
    expect(api.mockOf('agentSession.search')).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.mockOf('chat.search')).toHaveBeenCalledTimes(1);
    expect(api.mockOf('agentSession.search')).toHaveBeenCalledTimes(1);
    expect(view.result.current.hits[0]?.messageId).toBe('remote');
  });

  it('关闭时已发出的远端搜索不回写到下次打开的列表', async () => {
    const api = currentApiMock();
    let finish!: (value: { messages: ChatSearchableMessage[] }) => void;
    mockSearch(api, 'chat.search', async () => []);
    mockSearch(api, 'agentSession.search', () => new Promise(resolve => { finish = resolve; }));
    act(() => patchChatFindShared({ open: true, query: 'kw', scope: 'all', ownerId: 'own' }));
    const view = renderHook(() => useChatFind({ ...common, enabled: true, messages: [] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    act(() => view.result.current.close());
    await act(async () => { finish({ messages: [{ id: 'stale', role: 'assistant', content: 'kw old' }] }); });
    act(() => patchChatFindShared({ open: true, ownerId: 'own' }));
    expect(view.result.current.hits).toEqual([]); // 新防抖尚未触发，旧结果不能冒出
  });

  it('稀疏当前会话搜索未加载正文，关闭取消主进程扫描', async () => {
    const api = currentApiMock();
    api.override('agentSession.search', async () => ({ hits: [{ sessionId: 'own', sessionName: 'Own', messageId: 'old',
      role: 'assistant', start: 0, end: 2, indexInMessage: 0, messageIndex: 3, snippet: 'kw old unloaded' }], truncated: false }));
    act(() => patchChatFindShared({ open: true, query: 'kw', scope: 'current', ownerId: 'own' }));
    const view = renderHook(() => useChatFind({ ...common, enabled: true, historyIncomplete: true,
      messages: [{ id: 'tail', role: 'assistant', content: 'kw tail' }], messageSlots: [{ index: 9999, messageId: 'tail' }] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(view.result.current.hits.map(hit => hit.messageId)).toEqual(['old', 'tail']);
    expect(api.mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
    expect(api.mockOf('chat.historyRange')).not.toHaveBeenCalled();
    const requestId = api.mockOf('agentSession.search').mock.calls[0][3];
    act(() => view.result.current.close());
    expect(api.mockOf('agentSession.searchCancel')).toHaveBeenCalledWith(requestId);
  });
});
