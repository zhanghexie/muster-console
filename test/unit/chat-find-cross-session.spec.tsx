import { mockSearch } from './helpers/chat-search-mock';
/**
 * 回归：全部会话查找的跨会话导航（2026-09-22 评审 major）。
 * 旧实现共享态存「当前表面组合列表的数字下标」——每个表面的列表都是自己在前、
 * 别人在后，跳到目标会话后同一数字按目标会话自己的列表取值，指向另一条命中，
 * 继续导航在会话间来回乱跳、n/N 计数错位。新实现共享命中身份 + 规范序：
 * 还原即红——把 useChatFind 的身份反查改回「hits[shared 下标]」即挂。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { currentApiMock, installApiMock } from './helpers/api-mock';
import {
  patchChatFindShared,
  resetChatFindSharedForTest
} from '../../src/renderer/src/chatSurface/chatFindRegistry';
import { useChatFind } from '../../src/renderer/src/chatSurface/useChatFind';
import type { ChatSearchableMessage } from '../../src/shared/chatSearch';
import type { AgentRuntimeEntry, SessionMeta } from '../../src/shared/types';

const GUI_RUNTIME: AgentRuntimeEntry = {
  id: 'gui',
  label: 'GUI',
  script: '',
  builtin: true,
  enabled: true,
  updatedAt: 1,
  surface: 'chat'
};

function session(id: string): SessionMeta {
  return {
    id,
    type: 'terminal',
    name: id,
    createdAt: 1,
    runtime: GUI_RUNTIME.id
  } as unknown as SessionMeta;
}

/** n 条消息、每条恰一个 kw 命中 */
function messagesWith(prefix: string, n: number): ChatSearchableMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-m${i}`,
    role: 'assistant' as const,
    content: `kw 命中 ${i}（${prefix}）`
  }));
}

describe('useChatFind 全部会话跨会话导航', () => {
  beforeEach(() => {
    installApiMock();
    resetChatFindSharedForTest();
  });

  it('单会话历史拉取失败聚合为 failedSessions，不与「无命中」混淆（F-01）', async () => {
    const api = currentApiMock();
    // 调度面与一个 GUI 会话都拉取失败；另一个 GUI 会话正常返回 1 条命中
    mockSearch(api, 'chat.search', async () => {
      throw new Error('history unavailable');
    });
    mockSearch(api, 'agentSession.search', async (sessionId: unknown) => {
      if (String(sessionId) === 'sess-b') {
        throw new Error('session gone');
      }
      return { messages: messagesWith('a', 1) };
    });

    const common = {
      enabled: true,
      surfaceKind: 'gui-session' as const,
      sessionName: 'x',
      workspaceId: 'ws',
      runtimes: [GUI_RUNTIME]
    };
    const surface = renderHook(() =>
      useChatFind({
        ...common,
        sessionId: 'sess-a',
        messages: messagesWith('a', 1),
        sessions: [session('sess-a'), session('sess-b')],
        surfaceEl: null
      })
    );
    act(() => {
      patchChatFindShared({ open: true, ownerId: 'sess-a' });
      surface.result.current.setQuery('kw');
      surface.result.current.toggleScope();
    });
    // 调度面与 sess-b 各失败一次 → failedSessions=2；本会话（sess-a，被 skipId 跳过远端拉取）仍贡献 1 条命中
    await waitFor(() => expect(surface.result.current.failedSessions).toBe(2));
    expect(surface.result.current.hits.length).toBe(1);
    expect(surface.result.current.truncated).toBe(false);
  });

  it('命中触达 2000 条上限时 truncated=true 且列表被截到上限（F-02）', async () => {
    const api = currentApiMock();
    mockSearch(api, 'chat.search', async () => []);
    mockSearch(api, 'agentSession.search', async () => ({
      messages: messagesWith('b', 1500)
    }));

    const common = {
      enabled: true,
      surfaceKind: 'gui-session' as const,
      sessionName: 'x',
      workspaceId: 'ws',
      runtimes: [GUI_RUNTIME]
    };
    const surface = renderHook(() =>
      useChatFind({
        ...common,
        sessionId: 'sess-a',
        messages: messagesWith('a', 1200), // 本会话 1200 + 远端 1500 = 2700 > 2000
        sessions: [session('sess-a'), session('sess-b')],
        surfaceEl: null
      })
    );
    act(() => {
      patchChatFindShared({ open: true, ownerId: 'sess-a' });
      surface.result.current.setQuery('kw');
      surface.result.current.toggleScope();
    });
    await waitFor(() => expect(surface.result.current.hits.length).toBe(2000));
    expect(surface.result.current.truncated).toBe(true);
    // 全部命中仍在前 2000 条规范序（本会话在前的部分未被挤掉）
    expect(surface.result.current.hits[0]?.sessionId).toBe('sess-a');

    // 缩回当前会话：未触达上限，截断标志复位
    act(() => surface.result.current.toggleScope());
    expect(surface.result.current.hits.length).toBe(1200);
    expect(surface.result.current.truncated).toBe(false);
  });

  it('跳到目标会话后身份不换命中，继续导航沿规范序走', async () => {
    const historyBySession: Record<string, ChatSearchableMessage[]> = {
      'sess-a': messagesWith('a', 3),
      'sess-b': messagesWith('b', 3)
    };
    const api = currentApiMock();
    mockSearch(api, 'chat.search', async () => []);
    mockSearch(api, 'agentSession.search', async (sessionId: unknown) => ({
      messages: historyBySession[String(sessionId)] ?? []
    }));

    const common = {
      enabled: true,
      surfaceKind: 'gui-session' as const,
      sessionName: 'x',
      workspaceId: 'ws',
      runtimes: [GUI_RUNTIME]
    };
    const surfaceA = renderHook(() =>
      useChatFind({
        ...common,
        sessionId: 'sess-a',
        messages: historyBySession['sess-a']!,
        sessions: [session('sess-a'), session('sess-b')],
        surfaceEl: null
      })
    );
    const surfaceB = renderHook(() =>
      useChatFind({
        ...common,
        sessionId: 'sess-b',
        messages: historyBySession['sess-b']!,
        sessions: [session('sess-a'), session('sess-b')],
        surfaceEl: null
      })
    );

    act(() => {
      patchChatFindShared({ open: true, ownerId: 'sess-a' });
      surfaceA.result.current.setQuery('kw');
      surfaceA.result.current.toggleScope();
    });

    // 远端历史拉齐后，两个表面的规范列表一致：A 在前、B 在后，各 3 条
    await waitFor(() => expect(surfaceA.result.current.hits.length).toBe(6));
    await waitFor(() => expect(surfaceB.result.current.hits.length).toBe(6));
    expect(surfaceA.result.current.hits.map((h) => h.sessionId)).toEqual([
      'sess-a',
      'sess-a',
      'sess-a',
      'sess-b',
      'sess-b',
      'sess-b'
    ]);
    expect(surfaceA.result.current.hits.map((h) => h.messageId)).toEqual(
      surfaceB.result.current.hits.map((h) => h.messageId)
    );

    // A 内走到第 4 条（B 的第 1 条）：身份落在 sess-b/b-m0
    act(() => surfaceA.result.current.go(1));
    act(() => surfaceA.result.current.go(1));
    act(() => surfaceA.result.current.go(1));

    expect(surfaceA.result.current.activeHit?.messageId).toBe('b-m0');
    // 落到 B 后，B 表面按身份反查到同一条命中（旧实现这里取到 b 列表下标 3 = a-m0）
    expect(surfaceB.result.current.activeHit?.messageId).toBe('b-m0');
    expect(surfaceB.result.current.activeIndex).toBe(3);
    expect(surfaceA.result.current.activeIndex).toBe(3);

    // 在 B 上继续下一条：沿规范序走到 b-m1，不再弹回 A
    act(() => surfaceB.result.current.go(1));
    expect(surfaceB.result.current.activeHit?.messageId).toBe('b-m1');
    expect(surfaceA.result.current.activeHit?.messageId).toBe('b-m1');
    expect(surfaceA.result.current.activeIndex).toBe(4);
    expect(surfaceB.result.current.activeIndex).toBe(4);
  });

  it('点结果列表跳转与计数一致（jumpToHit 写身份）', async () => {
    const historyBySession: Record<string, ChatSearchableMessage[]> = {
      'sess-a': messagesWith('a', 1),
      'sess-b': messagesWith('b', 2)
    };
    const api = currentApiMock();
    mockSearch(api, 'chat.search', async () => []);
    mockSearch(api, 'agentSession.search', async (sessionId: unknown) => ({
      messages: historyBySession[String(sessionId)] ?? []
    }));

    const common = {
      enabled: true,
      surfaceKind: 'gui-session' as const,
      sessionName: 'x',
      workspaceId: 'ws',
      runtimes: [GUI_RUNTIME]
    };
    const surfaceA = renderHook(() =>
      useChatFind({
        ...common,
        sessionId: 'sess-a',
        messages: historyBySession['sess-a']!,
        sessions: [session('sess-a'), session('sess-b')],
        surfaceEl: null
      })
    );
    const surfaceB = renderHook(() =>
      useChatFind({
        ...common,
        sessionId: 'sess-b',
        messages: historyBySession['sess-b']!,
        sessions: [session('sess-a'), session('sess-b')],
        surfaceEl: null
      })
    );

    act(() => {
      patchChatFindShared({ open: true, ownerId: 'sess-a' });
      surfaceA.result.current.setQuery('kw');
      surfaceA.result.current.toggleScope();
    });
    await waitFor(() => expect(surfaceA.result.current.hits.length).toBe(3));

    // 在 A 的结果列表里点 B 的第 2 条（全局第 3 条）
    const target = surfaceA.result.current.hits[2]!;
    expect(target.messageId).toBe('b-m1');
    act(() => surfaceA.result.current.jumpToHit(target));

    expect(surfaceB.result.current.activeHit?.messageId).toBe('b-m1');
    expect(surfaceB.result.current.activeIndex).toBe(2);
    expect(surfaceA.result.current.activeIndex).toBe(2);
  });
});
