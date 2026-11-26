import { renderWithAppTips as render } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { getFreeViewLayout, setFilterActiveWorkspace, setFreeViewLayout, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { emptyFreeViewLayout } from '../../src/renderer/src/panels/freeViewGeom';
import type { BoardTodo } from '../../src/shared/boardTodo';
import { currentApiMock } from './helpers/api-mock';

const workspaces = [{ id: 'a', name: 'Alpha', path: 'E:/A', openedAt: 1 }, { id: 'b', name: 'Beta', path: 'E:/B', openedAt: 2 }];
const todos: BoardTodo[] = workspaces.map(ws => ({ id: `todo:${ws.id}`, workspaceId: ws.id, name: `${ws.name} 待办`,
  task: `${ws.name} 完整任务内容`, runtime: '', surface: 'chat', advanced: {}, isolate: false, createdAt: 1, updatedAt: 2 }));
beforeEach(() => {
  setFreeViewLayout({ ...emptyFreeViewLayout(), nodes: { 'todo:a': { x: 120, y: 240 }, 'todo:b': { x: 440, y: 240 } } });
  currentApiMock().override('workspaces.list', async () => ({ workspaces, activeWorkspaceId: 'a' }));
  currentApiMock().override('config.get', async () => ({ workspaces, activeWorkspaceId: 'a', locale: 'zh-CN' }));
  currentApiMock().override('boardTodos.list', async () => todos);
  currentApiMock().override('runtimes.availability', async () => ({ runtimes: [], acpAgents: [], checkedAt: 1 }));
});

it('只有 TODO 没有会话也显示 TODO 列，双击在原面板编辑且不选择会话', async () => {
  const view = render(<StoreProvider><BoardPanel /></StoreProvider>);
  const card = await waitFor(() => {
    const card = view.container.querySelector('[data-zone="todo"] [data-todo-id="todo:a"]'); expect(card).toBeTruthy(); return card!;
  });
  expect(view.container.querySelector('[data-zone="working"] [data-todo-id]')).toBeNull();
  fireEvent.click(card); expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => fireEvent.doubleClick(card));
  expect(screen.getByRole('dialog', { name: '编辑代办' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: '任务' }).textContent).toBe(todos[0].task);
  expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
});

it('延迟载入和过滤不丢画布落点，两个视图同源，画布双击编辑', async () => {
  let resolve!: (items: BoardTodo[]) => void;
  currentApiMock().override('boardTodos.list', () => new Promise<BoardTodo[]>(done => { resolve = done; }));
  setFreeViewMode('free');
  const view = render(<StoreProvider><BoardPanel /></StoreProvider>);
  await act(async () => {});
  expect(getFreeViewLayout().nodes['todo:a']).toEqual({ x: 120, y: 240 });
  await act(async () => resolve(todos));
  await waitFor(() => expect(view.container.querySelector('[data-cnode="todo:a"]')).toBeTruthy());
  expect(getFreeViewLayout().nodes['todo:a']).toEqual({ x: 120, y: 240 });
  act(() => setFilterActiveWorkspace(true));
  expect(view.container.querySelector('[data-cnode="todo:b"]')).toBeNull();
  expect(getFreeViewLayout().nodes['todo:b']).toEqual({ x: 440, y: 240 });
  act(() => setFilterActiveWorkspace(false));
  const node = view.container.querySelector('[data-cnode="todo:a"]')!;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => node });
  await act(async () => fireEvent.doubleClick(view.container.querySelector('.fc-viewport')!));
  expect(screen.getByRole('dialog', { name: '编辑代办' })).toBeTruthy();
  expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
  // Pointer capture can deliver the native dblclick after pointerup opened the modal.
  // Its real hit is now an overlay element: it must not be classified as blank canvas.
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.new-task-title') });
  const errors: string[] = [];
  const onError = (event: ErrorEvent): void => { errors.push(event.message); event.preventDefault(); };
  window.addEventListener('error', onError);
  try { await act(async () => fireEvent.doubleClick(view.container.querySelector('.fc-viewport')!)); }
  finally { window.removeEventListener('error', onError); }
  expect(errors).toEqual([]);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: '编辑代办' })).toBeTruthy();
});

it('读取失败显示原因，不清空持久位置；变更事件刷新同一份数据', async () => {
  currentApiMock().mockOf('boardTodos.list').mockRejectedValueOnce(new Error('corrupt file'));
  const view = render(<StoreProvider><BoardPanel /></StoreProvider>);
  await screen.findByText('读取代办失败：corrupt file');
  expect(getFreeViewLayout().nodes['todo:a']).toBeTruthy();
  act(() => currentApiMock().emit('boardTodos:changed', {}));
  await waitFor(() => expect(view.container.querySelector('[data-zone="todo"] [data-todo-id="todo:a"]')).toBeTruthy());
  expect(view.container.textContent).not.toContain('读取代办失败：corrupt file');
});
