/** 调度 Agent 从全局看板移除后的回归：看板仍显示 Worker，但不再挂调度卡或状态胶囊。 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';

const WORKSPACES: WorkspaceInfo[] = [
  { id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 },
  { id: 'ws-b', path: 'E:/demo/b', name: 'Beta', openedAt: 2 }
];

function session(): SessionMeta {
  return {
    id: 'worker-a', type: 'terminal', name: 'Worker', createdAt: 1, lastUsedAt: 1,
    launchKind: 'agent', runtime: 'pi', workspaceId: 'ws-a', status: 'running', lifecycle: 'idle'
  };
}

function seed(sessions: SessionMeta[] = []): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces: WORKSPACES, activeWorkspaceId: 'ws-a' }));
  mock.override('config.get', () => Promise.resolve({ workspaces: WORKSPACES, activeWorkspaceId: 'ws-a', locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({
    sessions,
    activeId: sessions[0]?.id ?? null,
    schedulerByWs: {
      'ws-a': { workspaceId: 'ws-a', sessionId: 'orchestrator:ws-a', phase: 'needs_you', note: '等你确认', ts: 1 }
    }
  }));
}

function renderBoard(): void {
  render(<StoreProvider><BoardPanel /></StoreProvider>);
}

describe('全局看板调度入口', () => {
  it('调度状态不再生成调度卡或状态胶囊', async () => {
    seed([session()]);
    renderBoard();
    await screen.findAllByText('Worker');
    expect(document.querySelector('.board-sched-card')).toBeNull();
    expect(document.querySelector('.board-sched-capsule')).toBeNull();
    expect(document.querySelector('.agent-notify-scheduler')).toBeNull();
  });

  it('没有 Worker 时保留工作会话空态和空 TODO 列，不用调度卡占位', async () => {
    seed();
    renderBoard();
    await waitFor(() => expect(screen.getByText('所有工作区都还没有工作会话')).toBeTruthy());
    expect(document.querySelector('.board-sched-card')).toBeNull();
    expect(document.querySelector('.board-grid [data-zone="todo"]')).toBeTruthy();
    expect(document.querySelector('.board-grid [data-zone="todo"] .board-column-count')?.textContent).toBe('0');
  });
});
