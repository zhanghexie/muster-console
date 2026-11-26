import { mockHistoryRange } from './helpers/chat-history-mock';
/**
 * 调度面工作区缓存逐出（A2-5-1）：workspaces:changed 到达时，已关闭/被移除工作区
 * 的全部缓存键（messages/snapCache/queuedCache/loaded…+ surfaceCache）被逐出，
 * 存活工作区原样保留；被逐出工作区重进靠既有 ensureHistory 重拉。
 * 还原即红：移除 evictDeadWorkspaces 订阅块（回滚动作）后，
 * 「dead 工作区快照清空 / surfaceCache 逐出 / 重进重拉」断言转红。
 * 运行: npx vitest run test/unit/orchestrator-workspace-evict.spec.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  ensureOrchestratorHistory,
  getOrchestratorSurface,
  resetOrchestratorListenersForTest
} from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { currentApiMock } from './helpers/api-mock';
import type { ChatMessage } from '../../src/shared/types';

const CONTEXT = {
  modelId: 'm',
  modelName: 'M',
  provider: 'p',
  tokens: null,
  contextWindow: 128000,
  percent: null
};

const contentOf = (m: unknown): string | undefined => (m as ChatMessage | undefined)?.content;

describe('调度面工作区缓存逐出（A2-5-1）', () => {
  beforeEach(() => {
    resetOrchestratorListenersForTest();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  });

  it('closed 工作区键被逐出，存活工作区保留，重进重拉', async () => {
    const mock = currentApiMock();
    const aliveMsgs: ChatMessage[] = [
      { id: 'alive-m1', role: 'assistant', content: '存活区回复', createdAt: 1 }
    ];
    const deadMsgs: ChatMessage[] = [
      {
        id: 'dead-q1',
        role: 'user',
        content: '已关闭区的排队消息',
        createdAt: 2,
        queued: true
      },
      { id: 'dead-a1', role: 'assistant', content: '已关闭区回复', createdAt: 3 }
    ];
    let historyCalls = 0;
    mockHistoryRange(mock, async (wsId: string) => {
      historyCalls += 1;
      return wsId === 'ws-alive' ? aliveMsgs : deadMsgs;
    });
    mock.override('chat.getMode', async () => 'default');
    mock.override('chat.context', async () => CONTEXT);

    const alive = getOrchestratorSurface('ws-alive');
    ensureOrchestratorHistory('ws-alive');
    const dead = getOrchestratorSurface('ws-dead');
    ensureOrchestratorHistory('ws-dead');
    await waitFor(() => {
      expect(alive.getSnapshot().messages.length).toBe(1);
      expect(dead.getSnapshot().messages.length).toBe(2);
    });
    // snapshot() 顺带填 queuedCache/snapCache（dead 区有排队消息）
    expect(dead.getSnapshot().queuedCount).toBe(1);
    const deadBefore = dead;

    // 关闭 ws-dead：workspaces:changed 只剩存活区
    currentApiMock().emit('workspaces:changed', {
      workspaces: [{ id: 'ws-alive', path: 'E:/alive', name: 'Alive' }],
      activeWorkspaceId: 'ws-alive'
    });

    // dead 区快照被逐出清空；alive 原样保留
    expect(dead.getSnapshot().messages.length).toBe(0);
    expect(dead.getSnapshot().queuedCount).toBe(0);
    expect(alive.getSnapshot().messages.length).toBe(1);
    expect(contentOf(alive.getSnapshot().messages[0])).toBe('存活区回复');
    // surfaceCache 一并逐出：同 wsId 再取是新实例
    const deadReAcquired = getOrchestratorSurface('ws-dead');
    expect(deadReAcquired).not.toBe(deadBefore);

    // 被逐出工作区重进：走既有 ensureHistory 重拉
    const callsBefore = historyCalls;
    ensureOrchestratorHistory('ws-dead');
    await waitFor(() => expect(historyCalls).toBeGreaterThan(callsBefore));
    await waitFor(() => {
      expect(deadReAcquired.getSnapshot().messages.length).toBe(2);
      expect(contentOf(deadReAcquired.getSnapshot().messages[1])).toBe('已关闭区回复');
    });
  });
});
