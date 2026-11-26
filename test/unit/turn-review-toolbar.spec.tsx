import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { GitDetailTopBar } from '../../src/renderer/src/panels/gitpanel/GitDetailTopBar';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { RightWorkspaceContext, type RightWorkspaceBridge } from '../../src/renderer/src/rightWorkspace';
import { activeRightTab, initialRightWorkspace, reduceRightWorkspace } from '../../src/shared/rightWorkspace';
const state = vi.hoisted(() => ({ surface: 'chat' }));
vi.mock('../../src/renderer/src/store', () => ({
  useSessionStore: () => ({ activeId: 's', sessions: [{ id: 's', runtime: 'r' }] }),
  useRuntimesStore: () => ({ runtimes: [{ id: 'r', surface: state.surface }] })
}));
vi.mock('../../src/renderer/src/panels/GitBranchPopover', () => ({ GitBranchPopover: () => null }));
it.each([
  { surface: 'chat', scope: 'session' as const }, { surface: 'chat', scope: 'workspace' as const },
  { surface: 'pty', scope: 'session' as const }, { surface: 'pty', scope: 'workspace' as const }
])('Git review entry uses $surface ownership and inherits $scope scope', ({ surface, scope }) => {
  state.surface = surface;
  const open = vi.fn(), host = document.createElement('div'), location = document.createElement('div');
  document.body.append(host, location);
  const model = reduceRightWorkspace(initialRightWorkspace('ws', 's'), { type: 'open', content: { kind: 'git', repoPath: 'E:/repo' }, scope });
  const bridge: RightWorkspaceBridge = { model, current: activeRightTab(model), toolbar: host, location, open, dispatch: vi.fn(), resourceHosts: { files: null, git: null, browser: null }, registerFile() {} };
  const { unmount } = render(<RightWorkspaceContext.Provider value={bridge}><GitWorkspaceProvider scope={{ workspaceId: 'ws', rootsRevision: 0 }}><GitDetailTopBar toolbarHost={host} branchPopOpen={false} setBranchPopOpen={vi.fn()} status={null} selectedSummary={null} busy={false} selectedPath="E:/repo" refreshStatus={vi.fn()} refreshList={vi.fn()} commitSelectedPath={vi.fn()} detailTab="work" setDetailTab={vi.fn()} runAction={vi.fn()} selectedIsWorktree={false} prDetecting={false} openPrFlow={vi.fn()}/></GitWorkspaceProvider></RightWorkspaceContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: '审阅' }));
  expect(open).toHaveBeenCalledWith({ kind: 'review', owner: surface === 'chat' ? { kind: 'gui', id: 's' } : { kind: 'dispatch', id: 'ws' }, repoPath: 'E:/repo' }, 'keep', scope);
  unmount(); host.remove(); location.remove();
});
