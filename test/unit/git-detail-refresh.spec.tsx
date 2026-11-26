import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GitDetailTopBar } from '../../src/renderer/src/panels/gitpanel/GitDetailTopBar';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';

const EXTERNAL = 'D:/MetaAgent/worktrees/task';
vi.mock('../../src/renderer/src/panels/GitBranchPopover', () => ({
  GitBranchPopover: ({ onChanged }: { onChanged: (path: string) => void }) =>
    <button onClick={() => onChanged(EXTERNAL)}>fixture: worktree created</button>
}));

it('分支菜单新建外置树后刷新摘要并定位，复用源仓发现快照', async () => {
  const refreshStatus = vi.fn(async () => {});
  const refreshList = vi.fn(async () => {});
  const select = vi.fn();
  render(<GitWorkspaceProvider scope={{ workspaceId: 'one', rootsRevision: 0 }}><GitDetailTopBar branchPopOpen setBranchPopOpen={vi.fn()}
    status={{ branch: 'main', tracking: null, ahead: 0, behind: 0, files: [] }}
    selectedSummary={null} busy={false} selectedPath="E:/source"
    refreshStatus={refreshStatus} refreshList={refreshList} commitSelectedPath={select}
    detailTab="work" setDetailTab={vi.fn()} runAction={vi.fn(async () => {})}
    selectedIsWorktree={false} prDetecting={false} openPrFlow={vi.fn()}/></GitWorkspaceProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'fixture: worktree created' }));
  expect(refreshStatus).toHaveBeenCalledWith('E:/source');
  expect(refreshList).toHaveBeenCalledWith(true, false);
  await waitFor(() => expect(select).toHaveBeenCalledWith(EXTERNAL));
});
