import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GitGraphCommit, GitLogPage } from '../../src/shared/types';
import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { GitHistory } from '../../src/renderer/src/panels/GitHistory';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import { installApiMock } from './helpers/api-mock';

afterEach(() => act(() => dismissTip()));

it('reports a history query failure in the window tip and leaves the history pane clear', async () => {
  const message = 'Git history is unavailable';
  installApiMock().override('git.invokeScoped', async (_scope, method) => {
    if (method === 'log') throw new Error(message);
    return { local: [] };
  });
  const view = render(<><GitWorkspaceProvider scope={{ workspaceId: 'workspace', rootsRevision: 0 }}>
    <GitHistory active repoPath="/repo" currentBranch="main" />
  </GitWorkspaceProvider><AppTipHost /></>);
  await waitFor(() => expect(view.container.querySelector('.git-error')).toBeNull());
  const tip = await screen.findByText(message, { exact: false });
  expect(tip.closest('.app-tip')?.classList.contains('is-error')).toBe(true);
  expect(within(view.container).queryByText(message, { exact: false })).toBeNull();
  expect(screen.queryByText('暂无提交')).toBeNull();
});

it('leaves an empty history quiet and ignores a failed request from a pane that was hidden', async () => {
  let rejectHistory!: (error: Error) => void;
  const pending = new Promise((_resolve, reject) => { rejectHistory = reject; });
  const log = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ commits: [], branchHeads: [], hasMore: false });
  installApiMock().override('git.invokeScoped', (_scope, method) => method === 'log' ? log() : { local: [] });
  const panel = (active: boolean) => <GitWorkspaceProvider scope={{ workspaceId: 'workspace', rootsRevision: 0 }}>
    <GitHistory active={active} repoPath="/repo" currentBranch="main" />
  </GitWorkspaceProvider>;
  const view = render(panel(true));
  view.rerender(panel(false));
  await act(async () => rejectHistory(new Error('old request failed')));
  view.rerender(panel(true));
  await screen.findByText('暂无提交');
  expect(getTipSnapshot()).toBeNull();
});

it('keeps the paged history, scroll position and commit diff through a warm activation', async () => {
  const commits = Array.from({ length: 82 }, (_, index): GitGraphCommit => ({
    sha: (index + 1).toString(16).padStart(40, '0'),
    commit: { author: { name: 'Author', date: '2026-11-28T00:00:00Z' }, message: `Commit ${index}` },
    parents: []
  }));
  const firstPage = { commits: commits.slice(0, 80), branchHeads: [], hasMore: true };
  const lastPage = { commits: commits.slice(80), branchHeads: [], hasMore: false };
  let resolveRefresh!: (page: GitLogPage) => void;
  const refresh = new Promise<GitLogPage>(resolve => { resolveRefresh = resolve; });
  const log = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(lastPage).mockReturnValueOnce(refresh);
  const files = vi.fn().mockResolvedValue({ files: [{ path: 'notes.txt', status: 'M' }] });
  const diff = vi.fn().mockResolvedValue({ diff: [
    'diff --git a/notes.txt b/notes.txt',
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1 +1 @@',
    '-old',
    '+retained patch',
    ''
  ].join('\n') });
  installApiMock().override('git.invokeScoped', (_scope, method, ...args) => {
    switch (method) {
      case 'log': return log(...args);
      case 'commitFiles': return files(...args);
      case 'commitDiff': return diff(...args);
      default: return { local: [] };
    }
  });
  const panel = (active: boolean) => <GitWorkspaceProvider scope={{ workspaceId: 'workspace', rootsRevision: 0 }}>
    <GitHistory active={active} repoPath="/repo" currentBranch="main" />
  </GitWorkspaceProvider>;
  const view = render(panel(true));
  await screen.findByText('Commit 0');
  const scrollList = () => view.container.querySelector<HTMLElement>('.git-history-scroll')!;
  scrollList().scrollTop = 2390;
  fireEvent.scroll(scrollList());
  await waitFor(() => expect(log).toHaveBeenNthCalledWith(2, '/repo', 80, 80, 'HEAD'));
  fireEvent.click(await screen.findByText('Commit 81'));
  const patch = await screen.findByText('retained patch');
  const list = scrollList();
  list.scrollTop = 2390;
  fireEvent.scroll(list);

  view.rerender(panel(false));
  expect(scrollList()).toBe(list);
  expect(list.scrollTop).toBe(2390);
  expect(view.container.contains(patch)).toBe(true);
  expect(log).toHaveBeenCalledTimes(2);

  view.rerender(panel(true));
  expect(screen.getByText('retained patch')).toBe(patch);
  expect(list.scrollTop).toBe(2390);
  expect(log).toHaveBeenNthCalledWith(3, '/repo', 0, 80, 'HEAD');
  await act(async () => resolveRefresh(firstPage));
  expect(list.querySelector('.git-hist-row.is-selected')?.textContent).toContain('Commit 81');
  expect(screen.getByText('retained patch')).toBe(patch);
  expect(files).toHaveBeenCalledTimes(1);
  expect(diff).toHaveBeenCalledTimes(1);
});
