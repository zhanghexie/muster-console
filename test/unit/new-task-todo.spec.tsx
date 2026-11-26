import { renderTask, enterTask } from './helpers/task-editor';
import { getTipSnapshot } from '../../src/renderer/src/tips';
import { serializeComposerDom } from '../../src/renderer/src/components/composerDomText';
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import type { BoardTodo } from '../../src/shared/boardTodo';
import type { AgentRuntimeEntry, WorkspaceInfo } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

const runtime = { id: 'pi', label: 'Muster Core', enabled: true, surface: 'chat' } as AgentRuntimeEntry;
const workspace = { id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0,
  roots: [{ id: 'a', path: 'E:/A' }, { id: 'b', path: 'E:/B' }], defaultRootId: 'a', rootsRevision: 1 } as WorkspaceInfo;
const todo: BoardTodo = { id: 'todo:test', task: '原始任务\n保留换行', name: '稍后处理', runtime: 'pi', surface: 'chat',
  advanced: { configurePermissions: true, guiMode: 'plan' }, isolate: false, workspaceId: 'ws', source: { rootId: 'b', path: 'E:/B' }, createdAt: 1, updatedAt: 2 };
const props = () => ({ open: true, workspace, runtimes: [runtime], onClose: vi.fn(), onDelegate: vi.fn(async () => ({ notified: false,
  session: { id: 'new', name: 'new', type: 'terminal' as const, createdAt: 0 } })), onBlankSession: vi.fn(async () => {}) });
beforeEach(() => {
  localStorage.clear();
  currentApiMock().override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
  currentApiMock().override('runtimes.availability', async () => ({ runtimes: [runtime], acpAgents: [], checkedAt: 1 }));
  currentApiMock().override('boardTodos.save', async (input, id) => ({ ...input, id: id ?? 'todo:new', createdAt: 1, updatedAt: 2 }));
});

it('添加 TODO 保存原文和名称，无可用 Worker/工作区也不创建会话', async () => {
  currentApiMock().override('runtimes.availability', async () => ({ runtimes: [], acpAgents: [], checkedAt: 1 }));
  const p = props(); renderTask(<NewTaskDialog {...p} workspace={undefined} runtimes={[]} />);
  const save = screen.getByRole('button', { name: '添加代办' });
  expect(save.hasAttribute('disabled')).toBe(true);
  enterTask(screen.getByRole('textbox', { name: '任务' }), '  调研一下\n第二段  ');
  fireEvent.change(screen.getByRole('textbox', { name: /会话名称/ }), { target: { value: ' 待调研 ' } });
  fireEvent.click(save);
  await waitFor(() => expect(p.onClose).toHaveBeenCalledOnce());
  expect(currentApiMock().mockOf('boardTodos.save')).toHaveBeenCalledWith(expect.objectContaining({ task: '  调研一下\n第二段  ', name: ' 待调研 ' }), undefined);
  expect(p.onDelegate).not.toHaveBeenCalled(); expect(p.onBlankSession).not.toHaveBeenCalled();
  expect(currentApiMock().mockOf('sessions.create')).not.toHaveBeenCalled();
});

it('二次编辑恢复指定源目录和权限；保存失败保留草稿，成功更新同一个 TODO', async () => {
  const p = props(); renderTask(<NewTaskDialog {...p} todo={todo} />);
  expect(screen.getByRole('dialog', { name: '编辑代办' })).toBeTruthy();
  expect(serializeComposerDom(screen.getByRole('textbox', { name: '任务' }))).toBe(todo.task);
  await waitFor(() => expect(currentApiMock().mockOf('sessions.precheck')).toHaveBeenCalledWith('ws', 'b', 1));
  enterTask(screen.getByRole('textbox', { name: '任务' }), '再次编辑');
  currentApiMock().mockOf('boardTodos.save').mockRejectedValueOnce(new Error('disk full'));
  fireEvent.click(screen.getByRole('button', { name: '保存代办' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toBe('disk full')); expect(p.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存代办' }));
  await waitFor(() => expect(p.onClose).toHaveBeenCalledOnce());
  expect(currentApiMock().mockOf('boardTodos.save')).toHaveBeenLastCalledWith(expect.objectContaining({ task: '再次编辑',
    source: todo.source, advanced: { configurePermissions: true, guiMode: 'plan' } }), todo.id);
});

it('CLI TODO 恢复模型和启动选项；取消不写入，删除不创建会话', async () => {
  const cli = { id: 'codex', label: 'Codex', enabled: true, surface: 'pty' } as AgentRuntimeEntry;
  currentApiMock().override('runtimes.availability', async () => ({ runtimes: [cli], acpAgents: [], checkedAt: 1 }));
  const p = props(); const cliTodo = { ...todo, surface: 'pty' as const, runtime: 'codex', advanced: { configurePermissions: true, cliLaunchOptions: { model: 'gpt-5', permission: 'full-auto' }, modelParameters: { reasoning: 'high' } } };
  const view = renderTask(<NewTaskDialog {...p} runtimes={[cli]} todo={cliTodo} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '保存代办' }));
  await waitFor(() => expect(p.onClose).toHaveBeenCalledOnce());
  expect(currentApiMock().mockOf('boardTodos.save')).toHaveBeenCalledWith(expect.objectContaining({ advanced: cliTodo.advanced, surface: 'pty' }), todo.id);
  view.rerender(<NewTaskDialog {...p} open={false} todo={todo} />);
  view.rerender(<NewTaskDialog {...p} todo={todo} />);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(currentApiMock().mockOf('boardTodos.save')).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '删除代办' }));
  await waitFor(() => expect(currentApiMock().mockOf('boardTodos.delete')).toHaveBeenCalledWith(todo.id));
  expect(p.onDelegate).not.toHaveBeenCalled();
});

it('开始失败保留 TODO，开始成功才移除；移除失败不能重复启动', async () => {
  const p = props(); p.onDelegate.mockRejectedValueOnce(new Error('start failed'));
  renderTask(<NewTaskDialog {...p} todo={todo} />);
  const start = screen.getByRole('button', { name: '开始任务' });
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
  fireEvent.click(start); await waitFor(() => expect(getTipSnapshot()?.text).toBe('start failed'));
  expect(currentApiMock().mockOf('boardTodos.delete')).not.toHaveBeenCalled();
  currentApiMock().mockOf('boardTodos.delete').mockRejectedValueOnce(new Error('cleanup failed'));
  fireEvent.click(start); await waitFor(() => expect(getTipSnapshot()?.text).toBe('cleanup failed'));
  expect(p.onDelegate).toHaveBeenCalledTimes(2);
  expect(start.hasAttribute('disabled')).toBe(true); fireEvent.click(start);
  expect(p.onDelegate).toHaveBeenCalledTimes(2);
  expect(currentApiMock().mockOf('boardTodos.delete')).toHaveBeenCalledWith(todo.id);
  expect(p.onClose).not.toHaveBeenCalled();
});

it('TODO 恢复隔离范围，启动仍使用已保存的源目录与仓库选择', async () => {
  currentApiMock().override('git.listRepoLocations', async () => ({ workspaceId: 'ws', rootsRevision: 1, issues: [], issueCount: 0,
    repos: [{ rootId: 'a', path: 'E:/A/sub', name: 'sub', dirty: false }, { rootId: 'b', path: 'E:/B', name: 'B', dirty: false }] }));
  const groups = [{ rootId: 'a', relativePath: 'sub', repoSet: [] }];
  const p = props(); renderTask(<NewTaskDialog {...p} todo={{ ...todo, isolate: true, isolationGroups: groups }} />);
  const start = screen.getByRole('button', { name: '开始任务' });
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(p.onClose).toHaveBeenCalledOnce());
  expect(p.onDelegate).toHaveBeenCalledWith(expect.objectContaining({ isolate: true, isolationGroups: groups,
    source: { workspaceId: 'ws', rootId: 'b', rootsRevision: 1, cwd: 'E:/B' }, advanced: { configurePermissions: true, guiMode: 'plan' } }));
  expect(currentApiMock().mockOf('boardTodos.delete')).toHaveBeenCalledWith(todo.id);
});

it('已保存仓库消失后要求重新选择，明确重选后可继续启动', async () => {
  currentApiMock().override('git.listRepoLocations', async () => ({ workspaceId: 'ws', rootsRevision: 1, issues: [], issueCount: 0,
    repos: [{ rootId: 'b', path: 'E:/B', name: 'B', dirty: false }] }));
  renderTask(<NewTaskDialog {...props()} todo={{ ...todo, isolate: true, isolationGroups: [{ rootId: 'a', relativePath: 'gone' }] }} />);
  await waitFor(() => expect(getTipSnapshot()?.text).toBe('所选仓库已失效，请重新选择隔离范围。'));
  const start = screen.getByRole('button', { name: '开始任务' }); expect(start.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '工作区隔离' }));
  const repo = await waitFor(() => {
    const checkbox = document.querySelector('.worktree-selection-row[title="E:/B"] input'); expect(checkbox).toBeTruthy(); return checkbox!;
  });
  fireEvent.click(repo);
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
});
