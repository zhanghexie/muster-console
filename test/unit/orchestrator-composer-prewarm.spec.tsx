import { mockHistoryRange } from './helpers/chat-history-mock';
/**
 * 调度和会话输入区获得焦点不触发审阅目录预热。
 * 运行: npx vitest run test/unit/orchestrator-composer-prewarm.spec.tsx
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { getOrchestratorSurface } from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import type { ChatSurface } from '../../src/shared/chatSurface';

vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });

function seedScheduler(): void {
  const mock = currentApiMock();
  mockHistoryRange(mock, async () => []);
  mock.override('chat.getMode', async () => 'default');
  mock.override('chat.context', async () => ({ modelId: 'm', modelName: 'm', provider: 'p', tokens: null, contextWindow: 1, percent: null }));
}

function plainSurface(): ChatSurface {
  const snap = { messages: [], busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null as null, preset: null };
  return {
    sessionId: 'gui-1',
    caps: { surfaceKind: 'gui-session', draftKey: 'gui-1', images: true },
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    actions: { send: async () => true, stop: () => undefined, clear: async () => undefined, retry: () => undefined, cancelQueued: () => undefined }
  };
}

const focusComposer = (container: HTMLElement) => {
  const wrap = container.querySelector('.agent-chat-composer-wrap') as HTMLElement;
  const target = (wrap.querySelector('[contenteditable], textarea') as HTMLElement | null) ?? wrap;
  fireEvent.focusIn(target);
};

describe('输入区焦点不预热审阅基线', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  });

  it('调度面板输入区获得焦点时不请求预热', async () => {
    seedScheduler();
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<StoreProvider><ChatSurfaceView surface={getOrchestratorSurface('ws-prewarm')} workspaceId="ws-prewarm" /></StoreProvider>); });
    const prewarm = currentApiMock().mockOf('turnChanges.prewarmScheduler');
    expect(prewarm).not.toHaveBeenCalled();
    focusComposer(view.container);
    expect(prewarm).not.toHaveBeenCalled();
  });

  it('GUI 会话聚焦不预热', async () => {
    let none!: ReturnType<typeof render>;
    await act(async () => { none = render(<StoreProvider><ChatSurfaceView surface={plainSurface()} workspaceId="ws-gui" /></StoreProvider>); });
    expect(() => focusComposer(none.container)).not.toThrow();
    expect(currentApiMock().mockOf('turnChanges.prewarmScheduler')).not.toHaveBeenCalled();
  });
});
