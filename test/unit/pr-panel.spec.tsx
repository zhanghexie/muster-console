import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithAppTips as render } from './helpers/app-tips';
import { currentApiMock } from './helpers/api-mock';
import { PrPanel } from '../../src/renderer/src/panels/PrPanel';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import type { GitHubConnection, PrDetail } from '../../src/shared/githubPr';

const scope = { workspaceId: 'workspace', rootsRevision: 2 };
const repository = { name: 'team/project', pushRepository: 'team/project', defaultBranch: 'main',
  url: 'https://github.com/team/project/pulls', autoReview: false };
const pr: PrDetail = {
  number: 42, title: 'Fix a missing state transition', url: 'https://github.com/team/project/pull/42',
  state: 'OPEN', isDraft: false, headRefName: 'topic', baseRefName: 'main', author: 'colleague', updatedAt: '2026-11-24T00:00:00Z',
  checks: 'failure', reviewDecision: 'CHANGES_REQUESTED', latestDiscussionAt: '2026-11-24T00:00:00Z',
  repository: repository.name, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  body: 'Check the transition during reconnect.',
  files: [{ path: 'src/state.ts', status: 'modified', additions: 1, deletions: 1, truncated: false,
    patch: '@@ -8 +8 @@\n-oldValue()\n+newValue()' }],
  filesPage: 1, filesHaveMore: false, checkEntries: [{ name: 'state tests', state: 'FAILURE', url: null }],
  checksTruncated: false, discussion: [], workerName: 'State Worker', draft: null,
  threads: [{ id: 'THREAD_1', path: 'src/state.ts', line: 8, side: 'RIGHT', resolved: false, outdated: false,
    comments: [{ id: 'C1', body: 'Reconnect should be idempotent.', author: 'colleague', url: null, createdAt: null }], commentsTruncated: false }],
  threadCursor: null
};

function renderPanel(active = true) {
  return render(<GitWorkspaceProvider scope={scope}><PrPanel repoPath="/workspace/repo" active={active} /></GitWorkspaceProvider>);
}

function connected() {
  const mock = currentApiMock();
  mock.override('pr.connection', () => ({ ok: true, value: { state: 'connected', login: 'developer' } }));
  mock.override('pr.repository', () => ({ ok: true, value: repository }));
  mock.override('pr.list', () => ({ ok: true, value: { prs: [pr], cursor: null } }));
  mock.override('pr.detail', () => ({ ok: true, value: pr }));
  return mock;
}

describe('GitHub PR panel', () => {
  it('does not request GitHub data in an inactive pane', () => {
    const mock = connected();
    renderPanel(false);
    expect(mock.mockOf('pr.connection')).not.toHaveBeenCalled();
  });

  it('configures a public App from the PR tab and starts device authorization', async () => {
    const mock = currentApiMock();
    let state: GitHubConnection = { state: 'unconfigured' };
    mock.override('pr.connection', () => ({ ok: true, value: state }));
    mock.override('pr.appSetup', () => ({ ok: true, value: { source: 'none', active: null, hasDefault: false } }));
    mock.override('pr.configureApp', () => ({ ok: true, value: state = { state: 'signedOut' } }));
    mock.override('pr.authorize', () => ({ ok: true, value: state = { state: 'pending', userCode: 'ABCD-1234',
      verificationUrl: 'https://github.com/login/device', expiresAt: Date.now() + 60_000 } }));
    renderPanel();
    const user = userEvent.setup();
    const open = await screen.findByRole('button', { name: '配置 GitHub' });
    await user.click(open);
    const dialog = within(screen.getByRole('dialog', { name: '配置 GitHub' }));
    const input = dialog.getByRole('textbox', { name: 'GitHub App 链接或名称' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.click(dialog.getByRole('button', { name: '创建 GitHub App' }));
    const registration = new URL(String(mock.mockOf('shell.openExternal').mock.calls[0]?.[0]));
    expect([registration.origin, registration.pathname, registration.searchParams.get('pull_requests')])
      .toEqual(['https://github.com', '/settings/apps/new', 'write']);
    await user.type(input, 'https://github.com/apps/team-review{Enter}');
    expect(await screen.findByText('ABCD-1234')).toBeTruthy();
    expect(mock.mockOf('pr.configureApp')).toHaveBeenCalledWith({ app: 'https://github.com/apps/team-review' });
    expect(mock.mockOf('pr.authorize')).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '复制授权码并打开 GitHub' }));
    expect(await navigator.clipboard.readText()).toBe('ABCD-1234');
    expect(await screen.findByText('授权码已复制')).toBeTruthy();
    expect(mock.mockOf('shell.openExternal')).toHaveBeenLastCalledWith('https://github.com/login/device');
  });

  it('offers manual Client ID after lookup fails for a private App', async () => {
    const mock = currentApiMock();
    let state: GitHubConnection = { state: 'unconfigured' };
    mock.override('pr.connection', () => ({ ok: true, value: state }));
    mock.override('pr.appSetup', () => ({ ok: true, value: { source: 'none', active: null, hasDefault: false } }));
    mock.override('pr.configureApp', (input: { app: string; clientId?: string }) => input.clientId
      ? { ok: true, value: state = { state: 'signedOut' } }
      : { ok: false, kind: 'appLookup', message: 'App 未公开' });
    mock.override('pr.authorize', () => ({ ok: true, value: state }));
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '配置 GitHub' }));
    const dialog = within(screen.getByRole('dialog', { name: '配置 GitHub' }));
    await user.type(dialog.getByRole('textbox', { name: 'GitHub App 链接或名称' }), 'private-app');
    await user.click(dialog.getByRole('button', { name: '保存并连接' }));
    expect(await dialog.findByText('App 未公开')).toBeTruthy();
    const clientId = await dialog.findByRole('textbox', { name: 'Client ID' });
    await waitFor(() => expect(document.activeElement).toBe(clientId));
    expect(clientId.getAttribute('aria-invalid')).toBe('true');
    await user.type(clientId, 'Iv1.1234567890abcdef');
    await user.click(dialog.getByRole('button', { name: '保存并连接' }));
    await waitFor(() => expect(mock.mockOf('pr.configureApp')).toHaveBeenLastCalledWith({ app: 'private-app', clientId: 'Iv1.1234567890abcdef' }));
  });

  it('returns focus to the configuration action on cancel and can restore a bundled App', async () => {
    const mock = connected();
    mock.override('pr.appSetup', () => ({ ok: true, value: { source: 'custom',
      active: { slug: 'team-review', clientId: 'Iv1.1234567890abcdef' }, hasDefault: true } }));
    mock.override('pr.configureApp', () => ({ ok: true, value: { state: 'connected', login: 'developer' } }));
    renderPanel();
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: '配置 GitHub' });
    await user.click(trigger);
    const dialog = within(screen.getByRole('dialog', { name: '配置 GitHub' }));
    expect((await dialog.findByRole('textbox', { name: 'GitHub App 链接或名称' }) as HTMLInputElement).value)
      .toBe('https://github.com/apps/team-review');
    await user.click(dialog.getByRole('button', { name: '取消' }));
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    await user.click(await dialog.findByRole('button', { name: '使用默认 App' }));
    expect(mock.mockOf('pr.configureApp')).toHaveBeenCalledWith(null);
  });

  it('shows the device code and opens the GitHub authorization page', async () => {
    const mock = currentApiMock();
    let state: GitHubConnection = { state: 'signedOut' };
    mock.override('pr.connection', () => ({ ok: true, value: state }));
    mock.override('pr.authorize', () => {
      state = { state: 'pending', userCode: 'ABCD-1234', verificationUrl: 'https://github.com/login/device',
        expiresAt: Date.now() + 60_000 };
      return { ok: true, value: state };
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '连接 GitHub' }));
    expect(await screen.findByText('ABCD-1234')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '打开 GitHub 授权' }));
    expect(mock.mockOf('shell.openExternal')).toHaveBeenCalledWith('https://github.com/login/device');
  });

  it('shows the repository installation action on a permission failure', async () => {
    const mock = connected();
    mock.override('pr.repository', () => ({ ok: false, kind: 'permission', message: '仓库未授权',
      installUrl: 'https://github.com/apps/muster-review/installations/new' }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole('button', { name: '在 GitHub 授权仓库' }));
    expect(mock.mockOf('shell.openExternal')).toHaveBeenCalledWith('https://github.com/apps/muster-review/installations/new');
    expect(mock.mockOf('pr.list')).not.toHaveBeenCalled();
  });

  it('offers to update insufficient App permissions without hiding readable PRs', async () => {
    const mock = connected();
    const url = 'https://github.com/organizations/team/settings/installations/1';
    mock.override('pr.repository', () => ({ ok: true, value: { ...repository,
      appAccess: { state: 'permissions', url, missing: ['pull_requests', 'checks'] } } }));
    renderPanel();
    const action = await screen.findByRole('button', { name: '在 GitHub 更新授权' });
    expect(await screen.findByText(/Pull requests, Checks/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Fix a missing state transition/ })).toBeTruthy();
    await userEvent.setup().click(action);
    expect(mock.mockOf('shell.openExternal')).toHaveBeenCalledWith(url);
  });

  it('loads the requested-review inbox and displays PR details without opening a browser', async () => {
    const mock = connected();
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '待我审' }));
    await waitFor(() => expect(mock.mockOf('pr.list')).toHaveBeenCalledWith({ ...scope, repoPath: '/workspace/repo' }, 'reviewRequested'));
    await user.click(await screen.findByRole('button', { name: /Fix a missing state transition/ }));
    expect(await screen.findByText('state tests')).toBeTruthy();
    expect(screen.getByText('Reconnect should be idempotent.')).toBeTruthy();
    expect(mock.mockOf('shell.openExternal')).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '返回 PR 列表' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Fix a missing state transition/ })).toBe(document.activeElement));
  });

  it('marks the first discussion as unread after viewing a PR with no prior discussion', async () => {
    const mock = connected();
    let snapshot = { ...pr, number: 43, latestDiscussionAt: null as string | null, discussion: [], threads: [] };
    mock.override('pr.list', () => ({ ok: true, value: { prs: [snapshot], cursor: null } }));
    mock.override('pr.detail', () => ({ ok: true, value: snapshot }));
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Fix a missing state transition/ }));
    await screen.findByText('暂无讨论');
    await user.click(screen.getByRole('button', { name: '返回 PR 列表' }));
    snapshot = { ...snapshot, latestDiscussionAt: '2026-11-24T01:00:00Z' };
    await user.click(await screen.findByRole('button', { name: '刷新' }));
    expect(await screen.findByText('新讨论')).toBeTruthy();
  });

  it('forwards selected threads to the Worker using the displayed revision', async () => {
    const mock = connected();
    mock.override('pr.forward', () => ({ ok: true, value: { workerName: 'State Worker' } }));
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Fix a missing state transition/ }));
    await user.click(await screen.findByRole('checkbox', { name: /src\/state\.ts:8/ }));
    await user.click(screen.getByRole('button', { name: /发送给 Worker/ }));
    expect(await screen.findByText('评论已发给 State Worker')).toBeTruthy();
    expect(mock.mockOf('pr.forward')).toHaveBeenCalledWith({ ...scope, repoPath: '/workspace/repo' }, {
      repository: pr.repository, number: 42, headSha: pr.headSha, baseSha: pr.baseSha
    }, ['THREAD_1']);
  });

  it('requires confirmation before publishing a summary and an inline review comment', async () => {
    const mock = connected();
    mock.override('pr.publish', () => ({ ok: true, value: { url: pr.url } }));
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Fix a missing state transition/ }));
    await user.click(await screen.findByText('src/state.ts', { exact: true }));
    const lines = await screen.findAllByRole('button', { name: '评论第 8 行' });
    await user.click(lines[1]!);
    const inlineEditor = screen.getByLabelText('src/state.ts:8 · RIGHT');
    expect(document.activeElement).toBe(inlineEditor);
    await user.click(lines[1]!);
    expect(screen.getAllByLabelText('src/state.ts:8 · RIGHT')).toEqual([inlineEditor]);
    expect(document.activeElement).toBe(inlineEditor);
    await user.type(inlineEditor, 'Guard reconnects.');
    await user.type(screen.getByLabelText('评审正文'), 'Please fix the reconnect case.');
    await user.click(screen.getByRole('button', { name: '发布评审…' }));
    const dialog = screen.getByRole('dialog', { name: '发布 GitHub 评审' });
    expect(mock.mockOf('pr.publish')).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /^发布$/ }));
    await waitFor(() => expect(mock.mockOf('pr.publish')).toHaveBeenCalledTimes(1));
    expect(mock.mockOf('pr.publish').mock.calls[0]?.[1]).toMatchObject({
      version: { headSha: pr.headSha, baseSha: pr.baseSha }, event: 'COMMENT',
      comments: [{ path: 'src/state.ts', side: 'RIGHT', line: 8, body: 'Guard reconnects.' }]
    });
  });
});
