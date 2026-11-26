import { mockHistoryRange } from './helpers/chat-history-mock';
/**
 * 调度面思考档：status.thinking 推送 + actions.setThinking 接线 + chip 显隐。
 * 回归：orchestratorSurface 不接 thinking / 不把 available 推到 ChatSurfaceView，本文件应转红。
 * 运行: npx vitest run test/unit/orchestrator-thinking.spec.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import {
  ensureOrchestratorHistory,
  getOrchestratorSurface
} from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const CONTEXT = {
  modelId: 'deepseek-chat',
  modelName: 'DeepSeek',
  provider: 'deepseek',
  tokens: null,
  contextWindow: 128000,
  percent: null
};

describe('调度面思考档', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  it('orchestratorSurface 接线 setThinking，context 推 status.thinking', async () => {
    mockHistoryRange(currentApiMock(), async () => []);
    currentApiMock().override('chat.getMode', async () => 'default');
    currentApiMock().override('chat.context', async () => ({
      ...CONTEXT,
      thinking: { level: null, available: true }
    }));
    const wsId = 'ws-orch-thinking-status';
    const surface = getOrchestratorSurface(wsId);
    expect(typeof surface.actions.setThinking).toBe('function');
    ensureOrchestratorHistory(wsId);
    await waitFor(() => {
      expect(surface.getSnapshot().status?.thinking).toEqual({ level: null, available: true });
    });
  });

  it('setThinking 走 chat.setThinking 并回写 level', async () => {
    mockHistoryRange(currentApiMock(), async () => []);
    currentApiMock().override('chat.getMode', async () => 'default');
    currentApiMock().override('chat.context', async () => ({
      ...CONTEXT,
      thinking: { level: null, available: true }
    }));
    currentApiMock().override('chat.setThinking', async () => ({
      ok: true,
      thinkingLevel: 'high',
      available: true
    }));
    const wsId = 'ws-orch-thinking-set';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => {
      expect(surface.getSnapshot().status?.thinking?.available).toBe(true);
    });
    const r = await surface.actions.setThinking!('high');
    expect(r.ok).toBe(true);
    expect(currentApiMock().mockOf('chat.setThinking')).toHaveBeenCalledWith('high', wsId);
    expect(surface.getSnapshot().status?.thinking).toEqual({ level: 'high', available: true });
  });

  it('available=true 时 Composer 出思考 chip，点选触发 setThinking', async () => {
    mockHistoryRange(currentApiMock(), async () => []);
    currentApiMock().override('chat.getMode', async () => 'default');
    currentApiMock().override('chat.context', async () => ({
      ...CONTEXT,
      thinking: { level: null, available: true }
    }));
    currentApiMock().override('chat.setThinking', async () => ({
      ok: true,
      thinkingLevel: 'max',
      available: true
    }));
    const wsId = 'ws-orch-thinking-chip';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => {
      expect(surface.getSnapshot().status?.thinking?.available).toBe(true);
    });
    render(
      <StoreProvider>
        <ChatSurfaceView surface={surface} workspaceId={wsId} />
      </StoreProvider>
    );
    const chip = await screen.findByTitle(/模型思考强度/);
    await userEvent.click(chip);
    await userEvent.click(screen.getByRole('menuitem', { name: '最高' }));
    await waitFor(() => {
      expect(currentApiMock().mockOf('chat.setThinking')).toHaveBeenCalledWith('max', wsId);
    });
  });

  it('available=false 不画出思考 chip', async () => {
    mockHistoryRange(currentApiMock(), async () => []);
    currentApiMock().override('chat.getMode', async () => 'default');
    currentApiMock().override('chat.context', async () => ({
      ...CONTEXT,
      thinking: { level: 'high', available: false }
    }));
    const wsId = 'ws-orch-thinking-hidden';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => {
      expect(surface.getSnapshot().status?.thinking).toEqual({ level: 'high', available: false });
    });
    render(
      <StoreProvider>
        <ChatSurfaceView surface={surface} workspaceId={wsId} />
      </StoreProvider>
    );
    expect(screen.queryByTitle(/模型思考强度/)).toBeNull();
  });
});
