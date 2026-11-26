import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithAppTips as render } from './helpers/app-tips';
import { currentApiMock } from './helpers/api-mock';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { PrCreateDialog } from '../../src/renderer/src/panels/PrCreateDialog';

const scope = { workspaceId: 'one', rootsRevision: 2 };
const repository = { name: 'team/repo', pushRepository: 'user/repo', url: 'https://github.com/team/repo/pulls',
  defaultBranch: 'main', autoReview: false };

function renderDialog(open = true) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(<GitWorkspaceProvider scope={scope}><PrCreateDialog open={open} repoPath="/repo" branch="topic"
    repository={repository} onCreated={onCreated} onClose={onClose} /></GitWorkspaceProvider>);
  return { onCreated, onClose };
}

describe('Create GitHub PR', () => {
  it('renders no modal when closed', () => {
    renderDialog(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('submits the frozen push and base destinations through scoped IPC', async () => {
    const mock = currentApiMock();
    const pr = { number: 7, url: 'https://github.com/team/repo/pull/7' };
    mock.override('pr.create', async () => ({ ok: true, value: pr }));
    const { onCreated } = renderDialog();
    expect(screen.getByText('从 user/repo:topic 推送分支并向 team/repo:main 创建 PR')).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('PR 标题'), 'Open PR');
    await user.click(screen.getByLabelText('创建为草稿'));
    await user.click(screen.getByRole('button', { name: '创建 PR' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(pr));
    expect(mock.mockOf('pr.create')).toHaveBeenCalledWith({ ...scope, repoPath: '/repo' }, {
      branch: 'topic', title: 'Open PR', body: '', base: undefined, draft: true, repository: 'team/repo', pushRepository: 'user/repo'
    });
    expect(mock.mockOf('git.pushBranch')).not.toHaveBeenCalled();
  });

  it('rejects a blank title and displays a push or create failure without completing the dialog', async () => {
    const mock = currentApiMock();
    mock.override('pr.create', async () => ({ ok: false, kind: 'permission', message: '分支已推送。当前账号权限不足' }));
    const { onCreated } = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '创建 PR' }));
    expect(await screen.findByText('标题不能为空')).toBeTruthy();
    expect(mock.mockOf('pr.create')).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('PR 标题'), 'Open PR');
    await user.click(screen.getByRole('button', { name: '创建 PR' }));
    expect(await screen.findByText('分支已推送。当前账号权限不足')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('cancels without sending a create request', async () => {
    const { onClose } = renderDialog();
    await userEvent.setup().click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(currentApiMock().mockOf('pr.create')).not.toHaveBeenCalled();
  });
});
