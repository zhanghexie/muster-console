import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
