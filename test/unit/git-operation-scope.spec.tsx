import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { GitPanel } from '../../src/renderer/src/panels/GitPanel';
import { GitWorkspaceProvider, useScopedGit } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { RightWorkspaceContext, type RightWorkspaceBridge } from '../../src/renderer/src/rightWorkspace';
import { defaultWorkspaceFileConfig } from '../../src/shared/metaAgent';
import type { GitOperationScope } from '../../src/shared/gitOperations';
import { initialRightWorkspace } from '../../src/shared/rightWorkspace';
import type { WorkspaceInfo } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

const a: WorkspaceInfo = { id: 'one', name: 'One', path: 'E:/A', openedAt: 0, rootsRevision: 0 };
const b: WorkspaceInfo = { id: 'two', name: 'Two', path: 'D:/B', openedAt: 0, rootsRevision: 0 };
let active = a;
let workspaces = [a, b];
beforeEach(() => {
  active = a; workspaces = [a, b];
  Element.prototype.scrollIntoView = () => {};
  const mock = currentApiMock();
  mock.override('workspaces.list', async () => ({ workspaces, activeWorkspaceId: active.id }));
  mock.override('config.get', async () => ({ workspaces, activeWorkspaceId: active.id, locale: 'zh-CN' }));
  mock.override('workspaceFile.get', async () => ({ workspaceId: active.id,
    config: { ...defaultWorkspaceFileConfig(), git: { selectedRepo: active.path } } }));
  mock.override('workspaceFile.patch', async (_patch: unknown, id: string) => ({ ok: true, workspaceId: id, config: defaultWorkspaceFileConfig() }));
  mock.override('git.listRepoLocations', async (_force: boolean, id: string) => {
    const ws = workspaces.find(w => w.id === id)!;
    return { workspaceId: id, rootsRevision: ws.rootsRevision ?? 0, issues: [], issueCount: 0,
      repos: [{ path: ws.path, workspaceId: id, name: ws.name, branch: 'main', dirty: true }] };
  });
  mock.override('git.invokeScoped', async (_scope: GitOperationScope, method: string) => {
    if (method === 'status') return { branch: 'main', tracking: null, ahead: 0, behind: 0,
      files: [{ path: 'same.txt', index: ' ', working_dir: 'M' }] };
    if (method === 'listBranches') return { current: 'main', local: [{ name: 'main', ref: 'main', current: true }], remote: [] };
    return { ok: true };
  });
});
function renderPanel(): void {
  render(<StoreProvider><PanelHistoryProvider><GitPanel active sideTab="git" /></PanelHistoryProvider></StoreProvider>);
}

it('从分支旁的 Worktree 选择器进入检出目录', async () => {
  const mock = currentApiMock();
  const checkout = `${a.path}/checkouts/topic`;
  mock.override('git.listRepoLocations', async () => ({ workspaceId: a.id, rootsRevision: 0, issues: [], issueCount: 0,
    repos: [{ path: a.path, name: 'A' }, { path: checkout, name: 'topic', worktree: true }] }));
  const invoke = mock.mockOf('git.invokeScoped').getMockImplementation()!;
  mock.override('git.invokeScoped', (scope: GitOperationScope, method: string, ...args: unknown[]) => method === 'worktreeList'
    ? Promise.resolve([{ path: a.path, main: true }, { path: checkout, branch: 'topic' }])
    : invoke(scope, method, ...args));
  renderPanel();
  const branch = await screen.findByTitle('点击切换 / 新建分支');
  const switcher = within(branch.parentElement!).getByRole('button', { name: '切换 Worktree' });
  expect(branch.nextElementSibling).toBe(switcher);
  fireEvent.click(switcher);
  fireEvent.click(await screen.findByRole('option', { name: 'topic · topic' }));
  await waitFor(() => expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: a.id, rootsRevision: 0 }, 'status', checkout));
});

it('只发现 Worktree 时可从资源区打开 Git 详情', async () => {
  const checkout = `${a.path}/linked`;
  currentApiMock().override('git.listRepoLocations', async () => ({ workspaceId: a.id, rootsRevision: 0, issues: [], issueCount: 0,
    repos: [{ path: checkout, name: 'linked', worktree: true }] }));
  const host = document.createElement('div');
  const open = vi.fn();
  const bridge: RightWorkspaceBridge = {
    model: initialRightWorkspace(a.id, ''), current: undefined, open, dispatch: vi.fn(), toolbar: null, location: null,
    resourceHosts: { files: null, git: host, browser: null }, registerFile() {}
  };
  render(<StoreProvider><PanelHistoryProvider><RightWorkspaceContext.Provider value={bridge}>
    <GitPanel active layout="resources" />
  </RightWorkspaceContext.Provider></PanelHistoryProvider></StoreProvider>);
  fireEvent.click(await within(host).findByRole('button', { name: '打开 Git 详情' }));
  expect(within(host).queryByRole('treeitem')).toBeNull();
  expect(open).toHaveBeenCalledWith({ kind: 'git', repoPath: checkout });
});

it('切走再激活 Git 保留选中的 Diff 和提交草稿', async () => {
  currentApiMock().override('git.invokeScoped', async (_scope: GitOperationScope, method: string) => {
    if (method === 'status') return { branch: 'main', tracking: null, ahead: 0, behind: 0, files: [{ path: 'same.txt', index: ' ', working_dir: 'M' }] };
    if (method === 'diff') return { diff: 'diff --git a/same.txt b/same.txt\n--- a/same.txt\n+++ b/same.txt\n@@ -1 +1 @@\n-before\n+after\n' };
    return { ok: true };
  });
  const page = (active: boolean) => <StoreProvider><PanelHistoryProvider><GitPanel active={active} sideTab="git" /></PanelHistoryProvider></StoreProvider>;
  const view = render(page(true));
  fireEvent.click(await screen.findByText('same.txt'));
  await screen.findByText('after');
  fireEvent.change(view.container.querySelector('.git-commit-input')!, { target: { value: 'commit draft' } });
  view.rerender(page(false)); view.rerender(page(true));
  await waitFor(() => expect(view.container.querySelector('.git-diff-pane .git-col-title')?.textContent).toContain('same.txt'));
  await screen.findByText('after');
  expect((view.container.querySelector('.git-commit-input') as HTMLTextAreaElement).value).toBe('commit draft');
});

it('切换已列出的仓库只查询该仓状态，不重新查询全仓摘要', async () => {
  const mock = currentApiMock();
  mock.override('git.listRepoLocations', async () => ({ workspaceId: a.id, rootsRevision: 0, issues: [], issueCount: 0,
    repos: [{ path: a.path, name: 'One', dirty: false }, { path: a.path + '/child', name: 'Child', dirty: false }] }));
  renderPanel();
  fireEvent.click(within(await screen.findByRole('tree', { name: '仓库' })).getByTitle(a.path));
  const child = await screen.findByTitle('E:/A/child');
  await act(async () => {});
  mock.mockOf('git.listRepoLocations').mockClear();
  fireEvent.click(child);
  await waitFor(() => expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: a.id, rootsRevision: 0 }, 'status', a.path + '/child'));
  expect(mock.mockOf('git.listRepoLocations')).not.toHaveBeenCalled();
});

it('实际 Git 面板带入全部任务组和同名嵌套仓，快捷入口指向会话 cwd 所在第二组', async () => {
  const mock = currentApiMock();
  const group = (id: string) => ({ id, path: `C:/tasks/${id}`, branch: 'ao/shared',
    sourceRoot: { rootId: id, path: `E:/sources/${id}`, cwd: `E:/sources/${id}` },
    source: { mainRepo: `E:/sources/${id}`, commonDir: `E:/sources/${id}/.git` },
    repos: [{ path: 'Plugins/Same', branch: 'ao/shared' }] });
  const session = { id: 'task', type: 'terminal', workspaceId: a.id, name: 'task', cwd: 'C:/tasks/b/Plugins/Same/src',
    worktreePath: 'C:/tasks/a', worktreeBranch: 'ao/shared', worktreeGroups: { version: 1, primaryGroupId: 'a', groups: [group('a'), group('b')] } };
  mock.override('sessions.list', async () => ({ sessions: [session], activeId: session.id }));
  mock.override('git.listRepoLocations', async (_force: boolean, _id: string, paths: string[]) => ({ workspaceId: a.id, rootsRevision: 0,
    issues: [], issueCount: 0, repos: [...new Set([a.path, ...paths])].map(path => ({ path, name: path.split('/').pop(),
      workspaceId: a.id, branch: 'ao/shared', dirty: false, worktree: path.startsWith('C:/tasks/') })) }));
  renderPanel();
  await waitFor(() => expect(mock.mockOf('git.listRepoLocations')).toHaveBeenCalledWith(false, a.id,
    expect.arrayContaining(['C:/tasks/a', 'C:/tasks/a/Plugins/Same', 'C:/tasks/b', 'C:/tasks/b/Plugins/Same'])));
  const shortcut = await screen.findByTitle(/会话「task」的隔离 worktree：C:\/tasks\/b\/Plugins\/Same/);
  fireEvent.click(shortcut);
  await waitFor(() => expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: a.id, rootsRevision: 0 },
    'status', 'C:/tasks/b/Plugins/Same'));
});
async function switchTo(ws: WorkspaceInfo): Promise<void> {
  active = ws; workspaces = workspaces.map(w => w.id === ws.id ? ws : w);
  await act(async () => currentApiMock().emit('workspaces:changed', { workspaces, activeWorkspaceId: ws.id }));
}

it('真实面板的 status、全部暂存和分支菜单携带当前工作区及版本', async () => {
  renderPanel();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stage All' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Stage All' }));
  const mock = currentApiMock();
  await waitFor(() => expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: 'one', rootsRevision: 0 }, 'stageAll', a.path));
  await switchTo({ ...b, rootsRevision: 3 });
  await waitFor(() => expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: 'two', rootsRevision: 3 }, 'status', b.path));
  fireEvent.click(screen.getByTitle('点击切换 / 新建分支'));
  await waitFor(() => expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: 'two', rootsRevision: 3 }, 'listBranches', b.path));
  expect(mock.mockOf('git.stageAll')).not.toHaveBeenCalled();
});

it('根版本变化后释放旧 busy，慢动作回调不触发新范围刷新/错误', async () => {
  let finish!: (value: unknown) => void;
  const mock = currentApiMock(); const defaultInvoke = mock.mockOf('git.invokeScoped').getMockImplementation()!;
  mock.override('git.invokeScoped', (scope: GitOperationScope, method: string, ...args: unknown[]) => method === 'stageAll'
    ? new Promise(resolve => { finish = resolve; }) : defaultInvoke(scope, method, ...args));
  renderPanel();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stage All' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Stage All' }));
  await switchTo({ ...a, rootsRevision: 1 });
  await waitFor(() => expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: 'one', rootsRevision: 1 }, 'status', a.path));
  mock.mockOf('git.invokeScoped').mockClear();
  await act(async () => finish({ ok: false, message: 'old action failed' }));
  expect(screen.queryByText('old action failed')).toBeNull();
  expect(mock.mockOf('git.invokeScoped')).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Stage All' }).hasAttribute('disabled')).toBe(false);
});

it('A→B→A 同路径时旧请求也不能成为本次范围的结果', async () => {
  let finish!: (value: unknown) => void;
  const mock = currentApiMock(); mock.override('git.invokeScoped', () => new Promise(resolve => { finish = resolve; }));
  const errors = vi.fn(); const success = vi.fn();
  function Probe(): React.JSX.Element {
    const git = useScopedGit();
    return <button onClick={() => void git.status(a.path).then(success, errors)}>probe</button>;
  }
  const view = render(<GitWorkspaceProvider scope={{ workspaceId: 'one', rootsRevision: 0 }}><Probe /></GitWorkspaceProvider>);
  fireEvent.click(screen.getByText('probe'));
  view.rerender(<GitWorkspaceProvider scope={{ workspaceId: 'two', rootsRevision: 0 }}><Probe /></GitWorkspaceProvider>);
  view.rerender(<GitWorkspaceProvider scope={{ workspaceId: 'one', rootsRevision: 0 }}><Probe /></GitWorkspaceProvider>);
  await act(async () => finish({ branch: 'OLD' }));
  expect(success).not.toHaveBeenCalled();
  expect(String(errors.mock.calls[0][0])).toContain('Git panel scope changed');
});
