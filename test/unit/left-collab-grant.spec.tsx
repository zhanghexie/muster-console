/**
 * R-08 通用能力授权 · 左栏会话右键菜单：授权/回收协作工具 toggle（✓ 态）、
 * 点击调 sessions.setGrantedScope IPC、已授权会话行出「协」角标；
 * 主进程广播 sessions:changed 后菜单态随会话刷新。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function sess(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-collab',
    type: 'terminal',
    name: '手动 Worker',
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    ...extra
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
  mock.override('sessions.list', () =>
    Promise.resolve({ sessions: [session], activeId: session.id })
  );
}

function renderLeft(session: SessionMeta): ReturnType<typeof render> {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  seed(session);
  const noop = (): void => {};
  return render(
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

it('任务协作授权退出，已有会话菜单仍可重命名与归档', async () => {
  const view = renderLeft(sess());
  const label = await screen.findByText('手动 Worker');
  fireEvent.contextMenu(label.closest('.session-item')!);
  await waitFor(() => expect(document.getElementById('ctx-item-rename')).toBeTruthy());
  expect(document.getElementById('ctx-item-collab-grant')).toBeNull();
  expect(view.container.querySelector('.session-collab-mark')).toBeNull();
  expect(document.getElementById('ctx-item-archive')).toBeTruthy();
});
