import { mockHistoryRange } from './helpers/chat-history-mock';
/**
 * 调度面 delta 守卫（A2-5-2）：applyDeltaBatch 对「同下标 tool part / kind 失配 /
 * 下标跳号」的 text/thinking 增量不再覆盖落盘，而是丢弃该批并触发 chat.history
 * resync（对齐 guiWorker.applyGuiMessagePart 返回 null→resync 的 GUI 语义）。
 * 回归：还原 orchestratorSurface.tsx 旧 else 覆盖分支（parts[min(idx,len)]=fresh），
 * 「tool part 不被覆盖」「resync 被调用」两断言转红。
 * 运行: npx vitest run test/unit/orchestrator-delta-guard.spec.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  ensureOrchestratorHistory,
  getOrchestratorSurface,
  resetOrchestratorListenersForTest
} from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { currentApiMock } from './helpers/api-mock';
import type { ChatMessage, ToolCallRecord } from '../../src/shared/types';

const CONTEXT = {
  modelId: 'm',
  modelName: 'M',
  provider: 'p',
  tokens: null,
  contextWindow: 128000,
  percent: null
};

const toolCall: ToolCallRecord = {
  id: 't1',
  name: 'sessions.list',
  arguments: '{}',
  result: '{"ok":true}',
  status: 'ok'
};

const seeded: ChatMessage[] = [
  {
    id: 'a1',
    role: 'assistant',
    content: '前文',
    createdAt: 1,
    parts: [
      { kind: 'text', text: '前文' },
      { kind: 'tool', toolCall }
    ]
  }
];

describe('调度面 delta 守卫（A2-5-2）', () => {
  beforeEach(() => {
    resetOrchestratorListenersForTest();
    const mock = currentApiMock();
    mock.override('chat.getMode', async () => 'default');
    mock.override('chat.context', async () => CONTEXT);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  });

  it('同下标 text delta 打到 tool part：丢弃该批 + resync 被调用 + tool 卡不被覆盖', async () => {
    const mock = currentApiMock();
    let historyCalls = 0;
    mockHistoryRange(mock, async () => {
      historyCalls += 1;
      return seeded;
    });
    const wsId = 'ws-a52-tool';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));
    const callsBefore = historyCalls;

    // 错投的增量：partIndex=1 落在 tool 卡上
    currentApiMock().emit('agent:token', {
      workspaceId: wsId,
      messageId: 'a1',
      token: 'X',
      partIndex: 1
    });
    // resync 必须被调用（还原修复即红：不触发 resync，此 waitFor 超时转红）
    await waitFor(() => expect(historyCalls).toBeGreaterThan(callsBefore));
    // 等合批兜底定时器（50ms）走完，确认 tool part 未被覆盖
    await new Promise((r) => setTimeout(r, 80));
    const m = surface.getSnapshot().messages[0];
    const parts = (m as { parts?: Array<{ kind: string; text?: string; toolCall?: ToolCallRecord }> }).parts;
    expect(parts?.[1]?.kind).toBe('tool');
    expect(parts?.[1]?.toolCall?.id).toBe('t1');
  });

  it('kind 失配（thinking delta 打到 text part 下标）：同样丢弃该批并 resync', async () => {
    const mock = currentApiMock();
    let historyCalls = 0;
    mockHistoryRange(mock, async () => {
      historyCalls += 1;
      return seeded;
    });
    const wsId = 'ws-a52-kind';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));
    const callsBefore = historyCalls;

    currentApiMock().emit('agent:thinking', {
      workspaceId: wsId,
      messageId: 'a1',
      token: 'X',
      partIndex: 0
    });
    await waitFor(() => expect(historyCalls).toBeGreaterThan(callsBefore));
    await new Promise((r) => setTimeout(r, 80));
    const parts = (
      surface.getSnapshot().messages[0] as {
        parts?: Array<{ kind: string; text?: string }>;
      }
    ).parts;
    expect(parts?.[0]).toEqual({ kind: 'text', text: '前文' });
  });

  it('合法路径不受影响：尾部追加与同 kind 追加照常落盘（不过度拦截）', async () => {
    const mock = currentApiMock();
    mockHistoryRange(mock, async () => seeded);
    const wsId = 'ws-a52-legal';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));

    // 合法追加：partIndex=2（= parts.length，尾部新开 text 段）
    currentApiMock().emit('agent:token', {
      workspaceId: wsId,
      messageId: 'a1',
      token: '追加',
      partIndex: 2
    });
    await waitFor(() => {
      const parts = (
        surface.getSnapshot().messages[0] as {
          parts?: Array<{ kind: string; text?: string }>;
        }
      ).parts;
      return parts?.length === 3 && parts[2]?.text === '追加';
    });
    // 合法同 kind 追加：partIndex=0 继续 text
    currentApiMock().emit('agent:token', {
      workspaceId: wsId,
      messageId: 'a1',
      token: '续',
      partIndex: 0
    });
    await waitFor(() => {
      const parts = (
        surface.getSnapshot().messages[0] as {
          parts?: Array<{ kind: string; text?: string }>;
        }
      ).parts;
      return parts?.[0]?.text === '前文续';
    });
    const parts = (
      surface.getSnapshot().messages[0] as {
        parts?: Array<{ kind: string; text?: string; toolCall?: ToolCallRecord }>;
      }
    ).parts;
    expect(parts?.[1]?.kind).toBe('tool');
  });

  it('完整历史已加载时，未知消息 delta 触发一次权威恢复', async () => {
    const mock = currentApiMock();
    let historyCalls = 0;
    mockHistoryRange(mock, async () => {
      historyCalls += 1;
      return seeded;
    });
    const wsId = 'ws-unknown-delta';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));
    const callsBefore = historyCalls;

    currentApiMock().emit('agent:token', {
      workspaceId: wsId,
      messageId: 'missing-message',
      token: 'late',
      partIndex: 0
    });
    await waitFor(() => expect(historyCalls).toBeGreaterThan(callsBefore));
    expect(surface.getSnapshot().messages.map((m) => (m as ChatMessage).id)).toEqual(['a1']);
  });

  it('权威恢复在途时重复未知 delta 只保留一个历史请求', async () => {
    const mock = currentApiMock();
    const range = mock.mockOf('chat.historyRange');
    let releaseRecovery: ((page: {
      messages: ChatMessage[];
      before: number;
      total: number;
      hasEarlier: boolean;
      eventSeq: number;
    }) => void) | undefined;
    range.mockImplementation(async () => {
      if (range.mock.calls.length === 1) {
        return { messages: seeded, before: 0, total: 1, hasEarlier: false, eventSeq: 1 };
      }
      return new Promise((resolve) => { releaseRecovery = resolve; });
    });
    const wsId = 'ws-resync-single-flight';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.map((m) => (m as ChatMessage).id)).toEqual(['a1']));

    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'missing-one', token: 'late', partIndex: 0
    });
    await waitFor(() => expect(range).toHaveBeenCalledTimes(2));
    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'missing-two', token: 'later', partIndex: 0
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(range).toHaveBeenCalledTimes(2);

    await releaseRecovery?.({ messages: seeded, before: 0, total: 1, hasEarlier: false, eventSeq: 2 });
    await waitFor(() => expect(surface.getSnapshot().messages.map((m) => (m as ChatMessage).id)).toEqual(['a1']));
  });

  it('重复 live seq 被丢弃，跳号触发有界历史恢复', async () => {
    const mock = currentApiMock();
    let historyCalls = 0;
    mockHistoryRange(mock, async () => {
      historyCalls += 1;
      return seeded;
    });
    const wsId = 'ws-live-seq';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));
    const callsBefore = historyCalls;

    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'a1', token: 'A', partIndex: 0, eventSeq: 1
    });
    await waitFor(() => expect((surface.getSnapshot().messages[0] as ChatMessage).parts?.[0]).toEqual({ kind: 'text', text: '前文A' }));
    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'a1', token: 'DUP', partIndex: 0, eventSeq: 1
    });
    await new Promise((r) => setTimeout(r, 80));
    expect((surface.getSnapshot().messages[0] as ChatMessage).parts?.[0]).toEqual({ kind: 'text', text: '前文A' });

    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'a1', token: 'GAP', partIndex: 0, eventSeq: 3
    });
    await waitFor(() => expect(historyCalls).toBeGreaterThan(callsBefore));
    expect((surface.getSnapshot().messages[0] as ChatMessage).parts?.[0]).toEqual({ kind: 'text', text: '前文' });
  });

  it('恢复页在途期间收到更高 seq 会自动追拉', async () => {
    const mock = currentApiMock();
    const range = mock.mockOf('chat.historyRange');
    let releaseRecovery: ((page: { messages: ChatMessage[]; before: number; total: number; hasEarlier: boolean; eventSeq: number }) => void) | undefined;
    range.mockImplementation(async () => {
      if (range.mock.calls.length === 1) {
        return { messages: [{ ...seeded[0], id: 'm1' }], before: 0, total: 1, hasEarlier: false, eventSeq: 1 };
      }
      if (range.mock.calls.length === 2) {
        return new Promise((resolve) => { releaseRecovery = resolve; });
      }
      return { messages: [{ ...seeded[0], id: 'm3' }], before: 0, total: 1, hasEarlier: false, eventSeq: 4 };
    });
    const wsId = 'ws-live-recovery-latch';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.map((m) => (m as ChatMessage).id)).toEqual(['m1']));

    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'm1', token: 'gap', partIndex: 0, eventSeq: 3
    });
    await waitFor(() => expect(range).toHaveBeenCalledTimes(2));
    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'm1', token: 'newer', partIndex: 0, eventSeq: 4
    });

    await releaseRecovery?.({ messages: [{ ...seeded[0], id: 'm2' }], before: 0, total: 1, hasEarlier: false, eventSeq: 2 });
    await waitFor(() => expect(range).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(surface.getSnapshot().messages.map((m) => (m as ChatMessage).id)).toEqual(['m3']));
  });

  it('过期 live seq 恢复尾部时保留已加载的更早页', async () => {
    const mock = currentApiMock();
    const range = mock.mockOf('chat.historyRange');
    range.mockImplementation(async (_wsId: string, before?: number) => before === undefined
      ? { messages: [{ ...seeded[0], id: 'tail' }], before: 2, total: 3, hasEarlier: true, eventSeq: 5 }
      : { messages: [{ ...seeded[0], id: 'older' }], before: 1, total: 3, hasEarlier: true, eventSeq: 5 });
    const wsId = 'ws-live-stale-range';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.map(m => (m as ChatMessage).id)).toEqual(['tail']));
    await surface.actions.loadEarlier?.();
    expect(surface.getSnapshot().messages.map(m => (m as ChatMessage).id)).toEqual(['older', 'tail']);

    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'tail', token: 'stale', partIndex: 0, eventSeq: 4
    });
    await waitFor(() => expect(range).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(surface.getSnapshot().messages.map(m => (m as ChatMessage).id)).toEqual(['older', 'tail']));
  });

  it('过期 history snapshot 不覆盖较新的 live 游标', async () => {
    const mock = currentApiMock();
    const wsId = 'ws-live-stale-snapshot';
    mockHistoryRange(mock, async () => seeded);
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));

    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'a1', token: 'new', partIndex: 0, eventSeq: 5
    });
    await waitFor(() => expect((surface.getSnapshot().messages[0] as ChatMessage).parts?.[0]).toEqual({ kind: 'text', text: '前文new' }));
    currentApiMock().emit('agent:history', {
      workspaceId: wsId,
      messages: [{ ...seeded[0], content: '旧快照', parts: [{ kind: 'text', text: '旧快照' }] }],
      before: 0,
      total: 1,
      hasEarlier: false,
      eventSeq: 4
    });
    await new Promise((r) => setTimeout(r, 40));
    expect((surface.getSnapshot().messages[0] as ChatMessage).parts?.[0]).toEqual({ kind: 'text', text: '前文new' });
  });

  it('回填到历史首端后，逆序恢复不重复请求已加载旧页', async () => {
    const mock = currentApiMock();
    const range = mock.mockOf('chat.historyRange');
    range.mockImplementation(async (_wsId: string, before?: number) => {
      if (range.mock.calls.length === 1) {
        return { messages: [{ ...seeded[0], id: 'tail', createdAt: 2 }], before: 1, total: 2, hasEarlier: true, eventSeq: 5 };
      }
      if (before === 1) {
        return { messages: [{ ...seeded[0], id: 'older', createdAt: 1 }], before: 0, total: 2, hasEarlier: false, eventSeq: 5 };
      }
      return { messages: [{ ...seeded[0], id: 'tail', createdAt: 2 }], before: 1, total: 2, hasEarlier: true, eventSeq: 6 };
    });
    const wsId = 'ws-live-cursor';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.map(m => (m as ChatMessage).id)).toEqual(['tail']));
    await surface.actions.loadEarlier?.();
    expect(surface.getSnapshot().messages.map(m => (m as ChatMessage).id)).toEqual(['older', 'tail']);
    expect(surface.getSnapshot().historyHasEarlier).toBe(false);

    currentApiMock().emit('agent:token', {
      workspaceId: wsId, messageId: 'tail', token: 'stale', partIndex: 0, eventSeq: 4
    });
    await waitFor(() => expect(range).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(surface.getSnapshot().messages.map(m => (m as ChatMessage).id)).toEqual(['older', 'tail']));
    expect(surface.getSnapshot().historyHasEarlier).toBe(false);
  });

  it('before=0 的缩短或清空 history 快照会权威替换旧消息', async () => {
    const mock = currentApiMock();
    mockHistoryRange(mock, async () => seeded);
    const wsId = 'ws-history-shrink';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));

    currentApiMock().emit('agent:history', {
      workspaceId: wsId,
      messages: [],
      before: 0,
      total: 0,
      hasEarlier: false,
      eventSeq: 1
    });
    await waitFor(() => expect(surface.getSnapshot().messages).toEqual([]));

    const replacement = { ...seeded[0], id: 'replacement', content: '新快照' };
    currentApiMock().emit('agent:history', {
      workspaceId: wsId,
      messages: [replacement],
      before: 0,
      total: 1,
      hasEarlier: false,
      eventSeq: 2
    });
    await waitFor(() => expect(surface.getSnapshot().messages.map((m) => (m as ChatMessage).id)).toEqual(['replacement']));
  });

  it('clear 完成后，迟到的初始 history 不会复活旧消息', async () => {
    const mock = currentApiMock();
    let resolveHistory!: (page: unknown) => void;
    const pending = new Promise((resolve) => { resolveHistory = resolve; });
    mock.override('chat.historyRange', async () => pending);
    mock.override('chat.clear', async () => ({ ok: true }));
    const wsId = 'ws-clear-late-history';
    const surface = getOrchestratorSurface(wsId);
    const ensure = ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(mock.mockOf('chat.historyRange')).toHaveBeenCalled());

    await surface.actions.clear?.();
    resolveHistory({ messages: seeded, before: 0, total: 1, hasEarlier: false, eventSeq: 1 });
    await ensure;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.getSnapshot().messages).toEqual([]);
    expect(surface.getSnapshot().historyLoading).toBe(false);
  });

  it('初始 history 迟到时保留更高 liveSeq 的同 id 更新', async () => {
    const mock = currentApiMock();
    let resolveHistory!: (page: unknown) => void;
    const pending = new Promise((resolve) => { resolveHistory = resolve; });
    mock.override('chat.historyRange', async () => pending);
    const wsId = 'ws-history-live-race';
    const surface = getOrchestratorSurface(wsId);
    const ensure = ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(mock.mockOf('chat.historyRange')).toHaveBeenCalled());

    currentApiMock().emit('agent:message', {
      workspaceId: wsId,
      id: 'a1',
      role: 'assistant',
      content: 'live-new',
      createdAt: 1,
      eventSeq: 2
    });
    resolveHistory({
      messages: [{ ...seeded[0], content: 'history-old' }],
      before: 0,
      total: 1,
      hasEarlier: false,
      eventSeq: 1
    });
    await ensure;
    await waitFor(() => expect((surface.getSnapshot().messages[0] as ChatMessage).content).toBe('live-new'));
  });
});
