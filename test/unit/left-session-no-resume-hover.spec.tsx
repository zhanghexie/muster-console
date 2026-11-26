/**
 * 左栏会话行不再提供悬浮「续作」入口（用户确认删除）。
 * 有 interruptSnapshot 的会话悬停后不得出现续作按钮 / tooltip 文案；
 * 底层续作仍走右键「带上下文续作」与 sessions.recoverInterrupted。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function interruptedSession(): SessionMeta {
  return {
    id: 'sess-resume',
    type: 'terminal',
    name: '被中断的会话',
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    phase: { value: 'needs_you', source: 'model', ts: 1 },
    interruptSnapshot: {
      interruptedAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_000_000,
      uncommitted: ['a.ts'],
      worktreeClean: false,
      phase: 'needs_you'
    }
  };
}

function seed(session: SessionMeta): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () => Promise.resolve({ sessions: [session], activeId: session.id }));
}

function renderLeft(): void {
  // jsdom 未实现 scrollIntoView（左栏键盘导航会调）
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  seed(interruptedSession());
  const noop = (): void => {};
  render(
    <StoreProvider>
      <PanelHistoryProvider>
        <LeftPanel
          utilityPanel={null}
          onSelectUtilityPanel={noop}
          onCloseUtilityPanel={noop}
        />
      </PanelHistoryProvider>
    </StoreProvider>
  );
}

describe('左栏会话行无悬浮续作', () => {
  it('有中断快照的会话悬停后不出现续作按钮或续作 tooltip', async () => {
    renderLeft();
    const row = await screen.findByText('被中断的会话');
    const item = row.closest('.session-item');
    expect(item).toBeTruthy();
    fireEvent.mouseEnter(item!);
    fireEvent.mouseOver(item!);

    expect(item!.querySelector('.session-resume-btn')).toBeNull();
    expect(screen.queryByRole('button', { name: '续作' })).toBeNull();
    expect(screen.queryByRole('button', { name: '带上下文续作' })).toBeNull();
    expect(screen.queryByText('续作')).toBeNull();
    expect(screen.queryByTitle(/带上下文续作/)).toBeNull();
  });

  it('右键菜单仍保留带上下文续作（底层入口）', async () => {
    renderLeft();
    const row = await screen.findByText('被中断的会话');
    const item = row.closest('.session-item');
    expect(item).toBeTruthy();
    fireEvent.contextMenu(item!);
    await waitFor(() => {
      expect(document.getElementById('ctx-item-resume-interrupted')?.textContent).toBe(
        '带上下文续作'
      );
    });
  });
});
