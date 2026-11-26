/**
 * 中栏按工作区隔离显示：
 * - 当前在 B 区时，A 区会话即使变成 activeId 也不得 visible；
 * - 切回 A 区后该会话才可见。
 * 自查：CenterPanel 改回 visible={s.id === activeId} 时本用例应红。
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { CenterPanel } from '../../src/renderer/src/panels/CenterPanel';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';

vi.mock('../../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ sessionId, visible }: { sessionId: string; visible: boolean }) => (
    <div data-testid={`term-${sessionId}`} data-visible={visible ? 'yes' : 'no'} />
  )
}));

vi.mock('../../src/renderer/src/agentChat/AgentChatView', () => ({
  AgentChatView: ({ sessionId, visible }: { sessionId: string; visible: boolean }) => (
    <div data-testid={`chat-${sessionId}`} data-visible={visible ? 'yes' : 'no'} />
  )
}));


const WS: WorkspaceInfo[] = [
  { id: 'ws-a', path: 'E:/proj/a', name: 'Alpha', openedAt: 1 },
  { id: 'ws-b', path: 'E:/proj/b', name: 'Beta', openedAt: 2 }
];

function term(id: string, workspaceId: string): SessionMeta {
  return {
    id,
    type: 'terminal',
    name: id,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor-cli',
    workspaceId,
    status: 'running',
    lifecycle: 'idle'
  };
}

const SESS_A = term('sess-a', 'ws-a');
const SESS_B = term('sess-b', 'ws-b');
const ALL = [SESS_A, SESS_B];

function seed(activeWorkspaceId: string, activeId: string): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces: WS, activeWorkspaceId }));
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId, locale: 'zh-CN' })
  );
  mock.override('sessions.list', () => Promise.resolve({ sessions: ALL, activeId }));
}

function renderCenter(): void {
  render(
    <StoreProvider>
      <CenterPanel utilityPanel={null} onCloseUtilityPanel={() => {}} />
    </StoreProvider>
  );
}

describe('中栏跨工作区 select 隔离', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  it('当前在 B 区时，A 区会话即使变成 activeId 也不显示', async () => {
    // Visit A first: unvisited sessions are intentionally not mounted by the view cache.
    seed('ws-a', 'sess-a');
    renderCenter();
    await waitFor(() => expect(screen.getByTestId('term-sess-a').getAttribute('data-visible')).toBe('yes'));
    act(() => {
      currentApiMock().emit('workspaces:changed', { workspaces: WS, activeWorkspaceId: 'ws-b' });
      currentApiMock().emit('sessions:changed', { sessions: ALL, activeId: 'sess-b' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('term-sess-b').getAttribute('data-visible')).toBe('yes');
    });
    expect(screen.getByTestId('term-sess-a').getAttribute('data-visible')).toBe('no');

    act(() => {
      currentApiMock().emit('sessions:changed', { sessions: ALL, activeId: 'sess-a' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('term-sess-a').getAttribute('data-visible')).toBe('no');
    });
    expect(screen.getByTestId('term-sess-b').getAttribute('data-visible')).toBe('no');
    expect(document.querySelector('.center-placeholder')).toBeTruthy();
  });

  it('切回所属工作区后，待显示会话可见', async () => {
    seed('ws-b', 'sess-b');
    renderCenter();
    await waitFor(() => {
      expect(screen.getByTestId('term-sess-b').getAttribute('data-visible')).toBe('yes');
    });

    act(() => {
      currentApiMock().emit('workspaces:changed', {
        workspaces: WS,
        activeWorkspaceId: 'ws-a'
      });
      currentApiMock().emit('sessions:changed', { sessions: ALL, activeId: 'sess-a' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('term-sess-a').getAttribute('data-visible')).toBe('yes');
    });
    expect(screen.getByTestId('term-sess-b').getAttribute('data-visible')).toBe('no');
  });
});
