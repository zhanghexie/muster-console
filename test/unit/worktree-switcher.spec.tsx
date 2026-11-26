import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { GitRepoLocation, GitRepoLocationListResult, SessionMeta } from '../../src/shared/types';
import { WorktreeSwitcher } from '../../src/renderer/src/panels/gitpanel/WorktreeSwitcher';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { currentApiMock } from './helpers/api-mock';

const main = { path: '/workspace/main', name: 'main' };
const linked = { path: '/workspace/local/linked', name: 'linked', worktree: true };
const task = { path: '/tasks/checkouts/Plugins/Kit', name: 'Kit', worktree: true };
const scope = { workspaceId: 'work', rootsRevision: 2 };
const listed = (...repos: GitRepoLocation[]): GitRepoLocationListResult => ({ ...scope, repos, issues: [], issueCount: 0 });
const session: SessionMeta = { id: 'task', name: 'Task', type: 'terminal', createdAt: 0, worktreePath: '/tasks/checkouts', worktreeBranch: 'ao/task',
  worktreeSource: { mainRepo: main.path, commonDir: `${main.path}/.git` }, worktreeRepoSet: [{ path: 'Plugins/Kit', branch: 'ao/task', baseBranch: 'main' }] };

function Picker(props: React.ComponentProps<typeof WorktreeSwitcher>): React.JSX.Element {
  return <GitWorkspaceProvider scope={{ workspaceId: props.workspaceId, rootsRevision: props.rootsRevision }}><WorktreeSwitcher {...props} /></GitWorkspaceProvider>;
}

it('按需列出当前任务与仓库的检出，选择时复核真实路径后导航', async () => {
  const api = currentApiMock();
  api.override('git.listRepoLocations', async (_force, _workspaceId, requested) => requested ? listed(main, linked, task) : listed(main, linked));
  api.override('git.invokeScoped', async () => [{ path: main.path, main: true }, { path: linked.path, branch: 'feature' }]);
  const select = vi.fn();
  render(<Picker {...scope} session={session} repoPath={main.path} enabled onSelect={select} onError={vi.fn()} />);
  expect(api.mockOf('git.listRepoLocations')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '切换 Worktree' }));
  expect(api.mockOf('git.invokeScoped')).toHaveBeenCalledWith(scope, 'worktreeList', main.path);
  expect((await screen.findByRole('option', { name: '主检出 · main' })).getAttribute('aria-selected')).toBe('true');
  expect(screen.getAllByRole('option', { name: /linked/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('option', { name: 'main/Plugins/Kit · ao/task' }));
  await waitFor(() => expect(select).toHaveBeenCalledWith(task.path));
  expect(screen.getByRole('button', { name: '切换 Worktree' }).textContent).toBe('Worktree');
  expect(api.mockOf('git.listRepoLocations')).toHaveBeenLastCalledWith(false, scope.workspaceId, [task.path]);
});

it('选中的 Worktree 已消失时反馈错误，过期工作区请求不会打开标签', async () => {
  const api = currentApiMock();
  let finish!: (value: GitRepoLocationListResult) => void;
  api.override('git.listRepoLocations', (_force, _workspaceId, requested) => requested ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(listed(linked)));
  api.override('git.invokeScoped', async () => []);
  const select = vi.fn(), onError = vi.fn();
  const element = (key: string, enabled = true) => <Picker key={key} {...scope} workspaceId={key} repoPath={main.path} enabled={enabled} onSelect={select} onError={onError} />;
  const view = render(element(scope.workspaceId));
  const open = () => fireEvent.click(screen.getByRole('button', { name: '切换 Worktree' }));
  open();
  fireEvent.click(await screen.findByRole('option', { name: 'linked' }));
  await act(async () => finish(listed(main)));
  expect(onError).toHaveBeenCalledWith(`Worktree 已不可用：${linked.path}`);
  expect(select).not.toHaveBeenCalled();
  open();
  fireEvent.click(await screen.findByRole('option', { name: 'linked' }));
  view.rerender(element(scope.workspaceId, false));
  view.rerender(element(scope.workspaceId));
  await act(async () => finish(listed(linked)));
  expect(select).not.toHaveBeenCalled();
  open();
  fireEvent.click(await screen.findByRole('option', { name: 'linked' }));
  view.rerender(element('another-workspace'));
  await act(async () => finish(listed(linked)));
  expect(select).not.toHaveBeenCalled();
});
