import { renderTask, enterTask } from './helpers/task-editor';
import { pickerCatalog } from './helpers/picker-catalog';
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { AgentRuntimeEntry, GitRepoListResult, WorkspaceInfo } from '../../src/shared/types';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { currentApiMock } from './helpers/api-mock';

const workspace: WorkspaceInfo = { id: 'ws', name: 'Workspace', path: 'E:/A', controlRoot: 'E:/A', openedAt: 0,
  roots: [{ id: 'a', path: 'E:/A', label: 'Same' }, { id: 'b', path: 'D:/B', label: 'Same' }], defaultRootId: 'b', rootsRevision: 2 };
const runtimes: AgentRuntimeEntry[] = [{ id: 'cli', label: 'CLI', enabled: true, surface: 'pty' } as AgentRuntimeEntry];
const list = (): GitRepoListResult => ({ workspaceId: 'ws', rootsRevision: 2, issues: [], issueCount: 0,
  repos: workspace.roots!.flatMap(root => [{ path: root.path, rootId: root.id, name: 'Same', dirty: false },
    { path: root.path + '/Plugins/Same', rootId: root.id, name: 'Same', dirty: false }]) });
const props = () => ({ open: true, workspace, runtimes, onClose: vi.fn(), onDelegate: vi.fn(async () => ({ notified: false, session: { id: 'new', name: 'new', type: 'terminal' as const, createdAt: 0 } })), onBlankSession: vi.fn(async () => {}) });
const repo = (path: string) => document.querySelector(`.worktree-selection-row[title="${path}"] input`) as HTMLInputElement;
const isolate = async () => {
  fireEvent.click(screen.getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认配置' });
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: '工作区隔离' }));
  fireEvent.click(await screen.findByRole('radio', { name: /隔离运行/ }));
};
const expand = async () => {
  const refresh = await screen.findByRole('button', { name: '刷新仓库' });
  await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
};
const submit = () => screen.getByRole('button', { name: '开始任务' }) as HTMLButtonElement;
beforeEach(() => {
  currentApiMock().override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices: [
    { harnessId: 'cli', runtimeId: 'cli', label: 'Fixture CLI', surface: 'cli', available: true, status: 'available' }
  ] }));
  currentApiMock().override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request));
  localStorage.clear(); currentApiMock().override('sessions.precheck', async () => ({ isolate: false, dirty: false }));
  currentApiMock().override('agentSession.getHarnessModelSelections', async () => ({}));
  currentApiMock().override('git.listRepoLocations', async () => list());
  currentApiMock().override('runtimes.availability', async () => ({ runtimes, acpAgents: [], checkedAt: 1 }));
});

it('默认仅选择当前目标仓，子仓与其他根不自动包含，保留原 cwd', async () => {
  const p = props(); renderTask(<NewTaskDialog {...p} />); await isolate(); await expand();
  expect(repo('D:/B').checked).toBe(true);
  for (const path of ['E:/A', 'E:/A/Plugins/Same', 'D:/B/Plugins/Same']) expect(repo(path).checked).toBe(false);
  expect(screen.queryByRole('button', { name: '任务运行仓库' })).toBeNull();
  fireEvent.click(repo('E:/A/Plugins/Same'));
  enterTask(screen.getByRole('textbox', { name: '任务' }), 'task');
  await waitFor(() => expect(submit().disabled).toBe(false)); fireEvent.click(submit());
  await waitFor(() => expect(p.onDelegate).toHaveBeenCalledOnce());
  expect(p.onDelegate).toHaveBeenCalledWith(expect.objectContaining({
    source: { workspaceId: 'ws', rootId: 'b', rootsRevision: 2, cwd: 'D:/B' }, isolate: true,
    isolationGroups: [{ rootId: 'b', relativePath: '', repoSet: [] }, { rootId: 'a', relativePath: 'Plugins/Same', repoSet: [] }]
  }));
});

it('父仓与独立子仓分别选择，刷新保留人工选择，不把空选择重置为默认', async () => {
  renderTask(<NewTaskDialog {...props()} />); await isolate(); await expand();
  fireEvent.click(repo('D:/B/Plugins/Same')); expect(repo('D:/B/Plugins/Same').checked).toBe(true);
  fireEvent.click(repo('D:/B/Plugins/Same')); expect(repo('D:/B/Plugins/Same').checked).toBe(false);
  fireEvent.click(repo('D:/B')); fireEvent.click(screen.getByRole('button', { name: '刷新仓库' }));
  await waitFor(() => expect(currentApiMock().mockOf('git.listRepoLocations')).toHaveBeenLastCalledWith(true, 'ws'));
  await waitFor(() => expect(repo('D:/B').checked).toBe(false));
  expect((screen.getByRole('button', { name: '新建空白' }) as HTMLButtonElement).disabled).toBe(true);
});

it('聚合根只需选择实际隔离仓，跨根选择不改变聚合 cwd', async () => {
  currentApiMock().override('git.listRepoLocations', async () => ({ ...list(), repos: [
    { rootId: 'b', path: 'D:/B/one', name: 'one', dirty: false }, { rootId: 'b', path: 'D:/B/two', name: 'two', dirty: false }
  ] }));
  const p = props(); renderTask(<NewTaskDialog {...p} />); await isolate(); await expand();
  const blank = screen.getByRole('button', { name: '新建空白' }) as HTMLButtonElement; expect(blank.disabled).toBe(true);
  fireEvent.click(repo('D:/B/two')); await waitFor(() => expect(blank.disabled).toBe(false)); fireEvent.click(blank);
  await waitFor(() => expect(p.onBlankSession).toHaveBeenCalledOnce());
  expect(p.onBlankSession).toHaveBeenCalledWith('cli', '', { configurePermissions: false }, { workspaceId: 'ws', rootId: 'b', rootsRevision: 2, cwd: 'D:/B' },
    { isolate: true, isolationGroups: [{ rootId: 'b', relativePath: 'two', repoSet: [] }] });
});

it('仓库有改动时默认共享，迟到预检不覆盖手动选择', async () => {
  let resolveCheck!: (value: { isolate: boolean; dirty: boolean | null }) => void;
  currentApiMock().override('sessions.precheck', () => new Promise(resolve => { resolveCheck = resolve; }));
  renderTask(<NewTaskDialog {...props()} />);
  await waitFor(() => expect(resolveCheck).toBeTypeOf('function'));
  expect(screen.getByRole('button', { name: '工作区隔离' }).textContent).toContain('共享检出');
  fireEvent.click(screen.getByRole('button', { name: '工作区隔离' }));
  fireEvent.click(await screen.findByRole('radio', { name: /隔离运行/ }));
  await act(async () => resolveCheck({ isolate: true, dirty: true }));
  expect(screen.getByRole('button', { name: '工作区隔离' }).textContent).toContain('隔离运行');
});

it('仓库有改动且未手选时预检完成仍默认共享', async () => {
  currentApiMock().override('sessions.precheck', async () => ({ isolate: true, dirty: true }));
  renderTask(<NewTaskDialog {...props()} />);
  await waitFor(() => expect(screen.queryByText('正在检查所选目录…')).toBeNull());
  expect(screen.getByRole('button', { name: '工作区隔离' }).textContent).toContain('共享检出');
});

it('状态未知时不显示 Git 状态提示', async () => {
  currentApiMock().override('sessions.precheck', async () => ({ isolate: false, dirty: null }));
  renderTask(<NewTaskDialog {...props()} />);
  await waitFor(() => expect(currentApiMock().mockOf('sessions.precheck')).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('正在检查所选目录…')).toBeNull());
  expect(screen.queryByText('尚未确认目标仓 Git 状态；可重试检查或明确选择隔离范围。')).toBeNull();
});
