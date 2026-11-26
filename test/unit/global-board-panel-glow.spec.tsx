/** 全局看板只在通知探出时使用 Beam，不恢复旧渐变灯带。 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider, useSessionStore } from '../../src/renderer/src/store';
import { GlobalBoard } from '../../src/renderer/src/panels/GlobalBoard';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => vi.unstubAllGlobals());

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

const WS: WorkspaceInfo[] = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];
const session = (needs: boolean): SessionMeta => ({
  id: 's-a', type: 'terminal', name: '工作会话', createdAt: 1, lastUsedAt: 1,
  launchKind: 'agent', runtime: 'cursor', workspaceId: 'ws-a',
  status: 'running', lifecycle: 'idle',
  ...(needs ? { phase: { value: 'needs_you' as const, source: 'model' as const, ts: 1 } } : {})
});

function seed(sessions: SessionMeta[]): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' }));
  mock.override('config.get', () => Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN', globalPanelGlow: true }));
  mock.override('sessions.list', () => Promise.resolve({ sessions, activeId: sessions[0]?.id ?? null }));
}

function SessionCountProbe(): React.JSX.Element {
  const { sessions } = useSessionStore();
  return <div data-testid="session-count">{sessions.length}</div>;
}

it('需要你探出停稳显示 Beam，不渲染旧渐变灯带', async () => {
  seed([session(false)]);
  render(
    <StoreProvider>
      <SessionCountProbe />
      <GlobalBoard open={false} onClose={() => undefined} onOpen={() => undefined} />
    </StoreProvider>
  );
  await waitFor(() => expect(screen.getByTestId('session-count').textContent).toBe('1'));
  act(() => currentApiMock().emit('sessions:changed', { sessions: [session(true)], activeId: 's-a' }));
  await waitFor(() => {
    const el = document.querySelector('.g-board-sheet.is-peek');
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  await waitFor(() => expect(document.querySelector('.g-board-sheet.is-peek')).toBeTruthy());
  expect(document.querySelector('.g-board-ring')).toBeNull();
  await waitFor(() => expect(document.querySelector('.g-board-peek-beam[data-active]')).toBeTruthy());
});
