import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import type { SessionMeta } from '../../src/shared/types';
import type { FreeCanvasProps } from '../../src/renderer/src/panels/freeCanvas/types';
const canvas = vi.hoisted(() => ({ latest: null as FreeCanvasProps | null }));
vi.mock('../../src/renderer/src/panels/FreeCanvas', () => ({
  FreeCanvas: React.forwardRef((_props: FreeCanvasProps, _ref) => { canvas.latest = _props; return <div data-testid="canvas-fixture" />; })
}));
beforeEach(() => { setFreeViewMode('status'); setFilterActiveWorkspace(false); });
it('状态/归档列、自由视图数据和数量均排除子孙，切工作区范围也不重新引入', async () => {
  const mock = currentApiMock();
  const workspaces = [{ id: 'w', path: 'E:/fixture', name: '演示', openedAt: 1 }];
  const row = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ id, name: id, type: 'terminal', launchKind: 'agent',
    workspaceId: 'w', runtime: 'pi', lifecycle: 'idle', createdAt: 1, lastUsedAt: 1, ...extra });
  const sessions = [row('父会话'), row('子会话', { parentSessionId: '父会话', phase: { value: 'needs_you', source: 'model', ts: 1 } }),
    row('孙会话', { parentSessionId: '子会话' }), row('归档子会话', { parentSessionId: '父会话', archived: true }), row('其他顶层')];
  mock.override('workspaces.list', () => Promise.resolve({ workspaces, activeWorkspaceId: 'w' }));
  mock.override('config.get', () => Promise.resolve({ workspaces, activeWorkspaceId: 'w', locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({ sessions, activeId: '父会话' }));
  const view = render(<StoreProvider><BoardPanel onClose={() => {}} /></StoreProvider>);
  await waitFor(() => expect(view.container.querySelector('.board-status-body')?.textContent).toContain('父会话'));
  for (const text of ['子会话', '孙会话', '归档子会话']) expect(view.container.textContent).not.toContain(text);
  expect(view.container.querySelector('.board-ticker')?.textContent).not.toMatch(/[1-9].*待处理/);
  expect(canvas.latest?.items.map(item => item.id).sort()).toEqual(['其他顶层', '父会话'].sort());
  expect(canvas.latest?.aliveIds?.slice().sort()).toEqual(['其他顶层', '父会话'].sort());
  expect(Object.keys(canvas.latest?.zones ?? {}).sort()).toEqual(['其他顶层', '父会话'].sort());
  fireEvent.click(screen.getByRole('tab', { name: '自由' }));
  expect(canvas.latest?.active).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '过滤' }));
  fireEvent.click(await screen.findByRole('button', { name: '当前工作区' }));
  expect(canvas.latest?.items.length).toBe(2);
});
