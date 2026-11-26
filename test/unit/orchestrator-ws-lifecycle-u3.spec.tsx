import { mockHistoryRange } from './helpers/chat-history-mock';
/**
 * 调度面工作区生命周期（U3，2026-10-02 修复）：工作区移除后，在途 history/getMode/
 * context/resync 的迟到响应不得重建 dead key；重开相同 id 只应用新生命周期的请求；
 * active/fallback/live 工作区与实时推送不退化。
 *
 * 修复机制（orchestratorSurface.tsx）：每工作区生命周期代 wsGen（全局单调计数）——
 * ensureHistory 重拉换代、evictDeadWorkspaces 删代、一切在途回调按「代失配」丢弃；
 * handleHistory/handleContext/setBusy/setMode/setThinkingState/localEcho 对未登记
 * （dead）工作区不落键。
 *
 * 还原修复即红：去掉 genCurrent 校验或 wsGen 逐出，「不重建 dead key」「重开只吃新
 * 请求」断言转红。
 * 运行: npx vitest run test/unit/orchestrator-ws-lifecycle-u3.spec.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  ensureOrchestratorHistory,
  getOrchestratorSurface,
  resetOrchestratorListenersForTest,
  setOrchestratorFallbackWs
} from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { currentApiMock } from './helpers/api-mock';
import type { ChatMessage } from '../../src/shared/types';

const CONTEXT = {
  modelId: 'm',
  modelName: 'M',
  provider: 'p',
  tokens: null as number | null,
  contextWindow: 128000,
  percent: null
};

const contentOf = (m: unknown): string | undefined => (m as ChatMessage | undefined)?.content;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const evict = (keep: string[], active = ''): void => {
  currentApiMock().emit('workspaces:changed', {
    workspaces: keep.map((id) => ({ id, path: `E:/${id}`, name: id })),
    activeWorkspaceId: active
  });
};

describe('调度面工作区生命周期（U3）', () => {
  beforeEach(() => {
    resetOrchestratorListenersForTest();
    setOrchestratorFallbackWs(null);
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

  it('history 等待点移除工作区：迟到 history/getMode 都不重建 dead key', async () => {
    const mock = currentApiMock();
    const histGate = deferred<ChatMessage[]>();
    const modeGate = deferred<'default' | 'ask' | 'plan'>();
    mockHistoryRange(mock, () => histGate.promise);
    mock.override('chat.getMode', () => modeGate.promise);

    const surface = getOrchestratorSurface('ws-u3-hist');
    ensureOrchestratorHistory('ws-u3-hist');
    // 等待期间工作区被关闭（存活列表不含它）
    evict(['ws-other'], 'ws-other');
    // 迟到 history 返回
    histGate.resolve([
      { id: 'dead-m1', role: 'assistant', content: '旧消息', createdAt: 1 }
    ]);
    // 迟到 getMode 返回
    modeGate.resolve('plan');
    await new Promise((r) => setTimeout(r, 20));

    expect(surface.getSnapshot().messages.length).toBe(0);
    expect(surface.getSnapshot().mode).toBeNull();
  });

  it('context 等待点移除工作区：迟到 context 不重建 dead key', async () => {
    const mock = currentApiMock();
    const ctxGate = deferred<typeof CONTEXT>();
    mockHistoryRange(mock, async () => []);
    mock.override('chat.context', () => ctxGate.promise);

    const surface = getOrchestratorSurface('ws-u3-ctx');
    ensureOrchestratorHistory('ws-u3-ctx');
    evict([], '');
    ctxGate.resolve({ ...CONTEXT, tokens: 123 });
    await new Promise((r) => setTimeout(r, 20));
    // dead key 的 context 不落（status 为 null，不因迟到响应复活）
    expect(surface.getSnapshot().status).toBeNull();
  });

  it('resync（delta 守卫）等待点移除工作区：迟到 resync 不重建 dead key', async () => {
    const mock = currentApiMock();
    const seeded: ChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '前文',
        createdAt: 1,
        parts: [
          { kind: 'text', text: '前文' },
          { kind: 'tool', toolCall: { id: 't1', name: 'x', arguments: '{}', result: '{}', status: 'ok' } }
        ]
      }
    ];
    const resyncGate = deferred<ChatMessage[]>();
    let call = 0;
    mockHistoryRange(mock, () => (call++ === 0 ? Promise.resolve(seeded) : resyncGate.promise));

    const surface = getOrchestratorSurface('ws-u3-resync');
    ensureOrchestratorHistory('ws-u3-resync');
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));

    // 错投 delta 触发 resync（第 2 次 history 挂起）
    mock.emit('agent:token', { workspaceId: 'ws-u3-resync', messageId: 'a1', token: 'X', partIndex: 1 });
    await waitFor(() => expect(call).toBe(2));
    // 等待期间关闭工作区
    evict(['ws-other'], 'ws-other');
    resyncGate.resolve(seeded);
    await new Promise((r) => setTimeout(r, 80));

    expect(surface.getSnapshot().messages.length).toBe(0);
  });

  it('重开相同 id：只有新生命周期的数据可用，旧请求迟到不覆盖', async () => {
    const mock = currentApiMock();
    const oldGate = deferred<ChatMessage[]>();
    const newMsgs: ChatMessage[] = [
      { id: 'fresh-m1', role: 'assistant', content: '重开后的新消息', createdAt: 2 }
    ];
    let call = 0;
    mockHistoryRange(mock, () => (call++ === 0 ? oldGate.promise : Promise.resolve(newMsgs)));

    const first = getOrchestratorSurface('ws-u3-reopen');
    ensureOrchestratorHistory('ws-u3-reopen');
    evict([], '');
    // 重开（同 id）：新生命周期、新请求
    const second = getOrchestratorSurface('ws-u3-reopen');
    ensureOrchestratorHistory('ws-u3-reopen');
    await waitFor(() => expect(second.getSnapshot().messages.length).toBe(1));
    expect(contentOf(second.getSnapshot().messages[0])).toBe('重开后的新消息');

    // 旧生命周期请求迟到——不得覆盖新数据
    oldGate.resolve([
      { id: 'stale-m1', role: 'assistant', content: '旧生命周期消息', createdAt: 1 }
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(second.getSnapshot().messages.length).toBe(1);
    expect(contentOf(second.getSnapshot().messages[0])).toBe('重开后的新消息');
    expect(first).not.toBe(second);
  });

  it('存活工作区不退化：active/fallback 保留缓存，实时推送（agent:message/history）照常落地', async () => {
    const mock = currentApiMock();
    mockHistoryRange(mock, async (wsId: string) =>
      wsId === 'ws-live' ? [{ id: 'live-m1', role: 'assistant', content: '存活区', createdAt: 1 }] : []
    );
    setOrchestratorFallbackWs('ws-fb');
    getOrchestratorSurface('ws-fb');

    const live = getOrchestratorSurface('ws-live');
    const fb = getOrchestratorSurface('ws-fb');
    ensureOrchestratorHistory('ws-live');
    await waitFor(() => expect(live.getSnapshot().messages.length).toBe(1));

    // 只关闭 ws-dead（未装载，仅登记 surface）
    getOrchestratorSurface('ws-dead');
    evict(['ws-live', 'ws-fb'], 'ws-live');

    // 存活区实时推送照常：新消息与全量 history 都落地
    mock.emit('agent:message', {
      workspaceId: 'ws-live',
      id: 'live-m2',
      role: 'assistant',
      content: '推送新消息',
      createdAt: 2
    });
    await waitFor(() => expect(live.getSnapshot().messages.length).toBe(2));
    mock.emit('agent:history', {
      workspaceId: 'ws-live',
      messages: [
        { id: 'live-m1', role: 'assistant', content: '存活区', createdAt: 1 },
        { id: 'live-m2', role: 'assistant', content: '推送新消息', createdAt: 2 },
        { id: 'live-m3', role: 'assistant', content: '历史补推', createdAt: 3 }
      ]
    });
    await waitFor(() => expect(live.getSnapshot().messages.length).toBe(3));
    expect(fb.getSnapshot()).toBeDefined();
    // fallback 推送（无 workspaceId 事件回落）也照常
    mock.emit('agent:history', [{ id: 'fb-m1', role: 'assistant', content: 'fallback', createdAt: 1 }]);
    await waitFor(() => expect(fb.getSnapshot().messages.length).toBe(1));
  });

  it('隐藏面板 ≠ 关闭：面板隐藏（工作区仍在存活列表）不逐出缓存', async () => {
    const mock = currentApiMock();
    mockHistoryRange(mock, async () => [
      { id: 'hidden-m1', role: 'assistant', content: '面板隐藏但工作区存活', createdAt: 1 }
    ]);
    const surface = getOrchestratorSurface('ws-hidden');
    ensureOrchestratorHistory('ws-hidden');
    await waitFor(() => expect(surface.getSnapshot().messages.length).toBe(1));

    // 面板隐藏只是 UI 不可见；workspaces:changed 仍列出该工作区
    evict(['ws-hidden'], 'ws-hidden');
    expect(surface.getSnapshot().messages.length).toBe(1);
    expect(contentOf(surface.getSnapshot().messages[0])).toBe('面板隐藏但工作区存活');
  });

  it('setThinking 回调代校验（r1-6）：逐出后同 id 重开，旧响应不覆盖新状态', async () => {
    const mock = currentApiMock();
    mockHistoryRange(mock, async () => []);
    mock.override('chat.context', async () => CONTEXT);
    const thinkingGate = deferred<{ ok: boolean; thinkingLevel?: string; available?: boolean }>();
    mock.override('chat.setThinking', () => thinkingGate.promise);

    const wsId = 'ws-u3-thinking';
    const first = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    // 旧生命周期的 setThinking（high）在途
    void first.actions.setThinking?.('high');

    // 逐出后重开同 id（新代）：新 context 推送 thinking=low
    evict([], '');
    const second = getOrchestratorSurface(wsId);
    mock.emit('agent:context', {
      workspaceId: wsId,
      ...CONTEXT,
      thinking: { level: 'low', available: true }
    });
    await waitFor(() => expect(second.getSnapshot().status?.thinking?.level).toBe('low'));

    // 旧 setThinking 响应（high）迟到：代失配 ⇒ 不得覆盖新状态（r1-6）
    thinkingGate.resolve({ ok: true, thinkingLevel: 'high', available: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(second.getSnapshot().status?.thinking?.level).toBe('low');
  });

  it('多轮开关有界：反复逐出后 dead key 不因迟到响应累积复活', async () => {
    const mock = currentApiMock();
    const gates: Array<{ promise: Promise<ChatMessage[]>; resolve: (v: ChatMessage[]) => void }> = [];
    mockHistoryRange(mock, () => {
      const g = deferred<ChatMessage[]>();
      gates.push(g);
      return g.promise;
    });
    const ids = ['ws-cycle-1', 'ws-cycle-2', 'ws-cycle-3'];
    for (const id of ids) {
      getOrchestratorSurface(id);
      ensureOrchestratorHistory(id);
      evict(['ws-live'], 'ws-live'); // 每轮开关即逐出
    }
    // 全部迟到响应一次性返回
    for (const g of gates) {
      g.resolve([{ id: `late-${Math.random()}`, role: 'assistant', content: '迟到', createdAt: 1 }]);
    }
    await new Promise((r) => setTimeout(r, 40));
    for (const id of ids) {
      // surfaceCache 已逐出 ⇒ 新实例（干净快照）；不得有任何消息复活
      const s = getOrchestratorSurface(id);
      // 注意：getOrchestratorSurface 重新登记了存活代，但未装载——快照为空
      expect(s.getSnapshot().messages.length).toBe(0);
    }
  });
});
