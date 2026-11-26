import { mockHistoryRange } from './helpers/chat-history-mock';
/**
 * 调度面板 fork：caps 开启 + 用户气泡菜单与中栏同款入口。
 * 运行: npx vitest run test/unit/orchestrator-fork.spec.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { getOrchestratorSurface } from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { ChatMessage } from '../../src/shared/types';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '从这里分叉', createdAt: 100 },
  { id: 'a1', role: 'assistant', content: '好的', createdAt: 200 }
];

function makeDispatchSurface(fork: boolean, onFork = vi.fn()): ChatSurface {
  const snap = {
    messages,
    busy: false,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: null as null,
    preset: null
  };
  return {
    sessionId: 'ws-fork',
    caps: {
      surfaceKind: 'dispatch',
      draftKey: 'ws-fork',
      images: true,
      fork
    },
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    actions: {
      send: async () => true,
      stop: () => undefined,
      clear: async () => undefined,
      retry: () => undefined,
      cancelQueued: () => undefined,
      ...(fork ? { fork: onFork } : {})
    }
  };
}

describe('调度面板 fork 入口', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  it('orchestratorSurface caps.fork 开启并接线 actions.fork', async () => {
    mockHistoryRange(currentApiMock(), async () => []);
    currentApiMock().override('chat.getMode', async () => 'default');
    currentApiMock().override('chat.context', async () => ({
      modelId: 'm',
      modelName: 'm',
      provider: 'p',
      tokens: null,
      contextWindow: 1,
      percent: null
    }));
    const surface = getOrchestratorSurface('ws-orch-fork');
    expect(surface.caps.fork).toBe(true);
    expect(typeof surface.actions.fork).toBe('function');
    currentApiMock().override('chat.fork', async () => ({
      ok: true,
      sessionFile: '/pi/fork.jsonl'
    }));
    surface.actions.fork?.('u1');
    await vi.waitFor(() => {
      expect(currentApiMock().mockOf('chat.fork').mock.calls.length).toBeGreaterThan(0);
    });
    expect(currentApiMock().mockOf('chat.fork').mock.calls[0][0]).toBe('u1');
    expect(currentApiMock().mockOf('chat.fork').mock.calls[0][1]).toBe('ws-orch-fork');
  });

  it('caps.fork 开启时用户气泡出现分叉按钮，点击走 surface.fork', async () => {
    const onFork = vi.fn();
    const user = userEvent.setup();
    render(
      <StoreProvider>
        <ChatSurfaceView surface={makeDispatchSurface(true, onFork)} workspaceId="ws-fork" />
      </StoreProvider>
    );
    const btns = screen.getAllByRole('button', { name: '分叉会话' });
    expect(btns.length).toBeGreaterThan(0);
    await user.click(btns[0]!);
    expect(onFork).toHaveBeenCalledWith('u1');
  });

  it('caps.fork 关闭时不渲染分叉按钮', () => {
    render(
      <StoreProvider>
        <ChatSurfaceView surface={makeDispatchSurface(false)} workspaceId="ws-fork" />
      </StoreProvider>
    );
    expect(screen.queryByRole('button', { name: '分叉会话' })).toBeNull();
  });
});
