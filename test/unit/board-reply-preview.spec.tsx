import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { currentApiMock } from './helpers/api-mock';

const props = { sessionId: 'reply', name: '会话', runtimeLabel: 'Codex', status: 'idle' as const,
  relTimeTs: Date.now(), isActive: false, onSelect: vi.fn(), onContextMenu: vi.fn() };

it('直接展示元数据预览并随属性更新，无需读取历史', () => {
  const view = render(<BoardCard {...props} replyPreview="旧的最后一句。" />);
  expect(screen.getByText('旧的最后一句。')).toBeTruthy();
  view.rerender(<BoardCard {...props} replyPreview="新的最后一句。" />);
  expect(screen.getByText('新的最后一句。')).toBeTruthy();
  expect(screen.queryByText('旧的最后一句。')).toBeNull();
  view.rerender(<BoardCard {...props} />);
  expect(view.container.querySelector('.board-card-output')).toBeNull();
});

it('看板从会话元数据展示预览，旧会话无预览时正常显示', async () => {
  setFreeViewMode('status'); setFilterActiveWorkspace(false);
  const api = currentApiMock();
  const ws = [{ id: 'w', name: '工作区', path: 'E:/fixture', openedAt: 1 }];
  const base = { type: 'terminal', launchKind: 'agent', workspaceId: 'w', createdAt: 1, status: 'running', lifecycle: 'idle' };
  api.override('workspaces.list', async () => ({ workspaces: ws, activeWorkspaceId: 'w' }));
  api.override('config.get', async () => ({ workspaces: ws, activeWorkspaceId: 'w', locale: 'zh-CN' }));
  api.override('sessions.list', async () => ({ sessions: [
    { ...base, id: 'gui', name: 'GUI 会话', runtime: 'pi', boardReplyPreview: '最后一句。' },
    { ...base, id: 'cli', name: 'CLI 会话', runtime: 'codex' }
  ], activeId: null }));
  render(<StoreProvider><BoardPanel active /></StoreProvider>);
  expect(await screen.findByText('最后一句。')).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'CLI 会话' })).toBeTruthy();
  act(() => api.emit('sessions:changed', { sessions: [
    { ...base, id: 'gui', name: 'GUI 会话', runtime: 'pi', boardReplyPreview: '更新后的最后一句。' },
    { ...base, id: 'cli', name: 'CLI 会话', runtime: 'codex' }
  ], activeId: null }));
  expect(await screen.findByText('更新后的最后一句。')).toBeTruthy();
  expect(screen.queryByText('最后一句。')).toBeNull();
});
