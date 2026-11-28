import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import type { GitRepoStatus } from '../../src/shared/types';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { useGitRemote, REMOTE_CHECK_INTERVAL_MS } from '../../src/renderer/src/panels/gitpanel/useGitRemote';
import { GitRemoteFeedback } from '../../src/renderer/src/panels/gitpanel/GitRemoteFeedback';
import { resetGitRemoteStateForTest } from '../../src/renderer/src/panels/gitpanel/gitRemoteState';
import { currentApiMock } from './helpers/api-mock';

const status: GitRepoStatus = { branch: 'main', tracking: 'origin/main', ahead: 2, behind: 1, files: [] };
const refresh = vi.fn(async () => {});
const button = (name: string) => screen.getByRole('button', { name });
const detailsButton = () => button('Git 操作详情');
const operation = () => screen.getByRole('status').textContent;

function Harness({ path = 'E:/remote', active = true, busy = false, value = status }: {
  path?: string; active?: boolean; busy?: boolean; value?: GitRepoStatus | null;
}): React.JSX.Element {
  const remote = useGitRemote({ scopeKey: 'one:0', repoPath: path, active, busy, status: value, refreshStatus: refresh });
  return <GitRemoteFeedback remote={remote} repoPath={path} status={value} active={active} busy={busy}/>;
}
function Page(props: React.ComponentProps<typeof Harness>): React.JSX.Element {
  return <GitWorkspaceProvider scope={{ workspaceId: 'one', rootsRevision: 0 }}><Harness {...props}/></GitWorkspaceProvider>;
}
beforeEach(() => { resetGitRemoteStateForTest(); refresh.mockClear(); vi.spyOn(document, 'hasFocus').mockReturnValue(false); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('慢推送在操作按钮内显示等待，详情显示用时，切页后仍保留回执', async () => {
  let finish!: (value: unknown) => void;
  const mock = currentApiMock();
  mock.override('git.invokeScoped', () => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers();
  const view = render(<Page/>);
  const push = button('Push');
  fireEvent.click(push); fireEvent.click(push);
  expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledTimes(1);
  expect(operation()).toContain('正在推送');
  expect(push.querySelector('.brand-loader')).toBeTruthy();
  expect(view.container.querySelectorAll('.brand-loader')).toHaveLength(1);

  fireEvent.click(detailsButton());
  await act(async () => { vi.advanceTimersByTime(2200); });
  const dialog = screen.getByRole('dialog', { name: 'Git 操作详情' });
  expect(dialog.textContent).toContain('已用时 2 秒');
  expect(operation()).not.toContain('已用时');

  await act(async () => finish({ ok: true, remote: { completedAt: Date.now(), targets: ['main → main'] } }));
  expect(operation()).toContain('推送成功');
  expect(dialog.textContent).toContain('main → main');
  expect(view.container.querySelector('.brand-loader')).toBeNull();
  view.rerender(<Page active={false}/>); view.rerender(<Page/>);
  expect(detailsButton().getAttribute('aria-description')).toContain('推送成功');
  expect(view.container.querySelector('.brand-loader')).toBeNull();
});

it('推送失败保留原始原因，后续 Fetch 成功仍保留回执，成功重试后替换', async () => {
  let rejected = true;
  currentApiMock().override('git.invokeScoped', async (_scope, method) => method === 'push' && rejected ? { ok: false, message: 'PUSH_REJECTED' } : { ok: true });
  render(<Page/>);
  fireEvent.click(button('Push'));
  await waitFor(() => expect(operation()).toContain('推送失败'));
  for (let expectedRefreshes = 2; expectedRefreshes <= 6; expectedRefreshes++) {
    fireEvent.click(button('Fetch'));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(expectedRefreshes));
  }
  expect(operation()).toContain('推送失败');
  fireEvent.click(detailsButton());
  const dialog = screen.getByRole('dialog', { name: 'Git 操作详情' });
  expect(dialog.textContent).toContain('PUSH_REJECTED');
  fireEvent.click(within(dialog).getAllByRole('button', { name: '关闭' })[0]);
  rejected = false; fireEvent.click(button('Push'));
  await waitFor(() => expect(operation()).toContain('推送成功'));
  expect(detailsButton().getAttribute('aria-description')).not.toContain('推送失败');
});

it('推送成功后状态查询失败，回执仍为成功', async () => {
  refresh.mockRejectedValueOnce(new Error('STATUS_FAILURE'));
  currentApiMock().override('git.invokeScoped', async () => ({ ok: true }));
  render(<Page/>); fireEvent.click(button('Push'));
  await waitFor(() => expect(operation()).toContain('推送成功'));
  expect(detailsButton().getAttribute('aria-description')).not.toContain('推送失败');
});

it('工具栏分别在推送和拉取按钮显示待推和待拉数量', () => {
  const view = render(<Page/>);
  const push = button('Push');
  const pull = button('Pull');
  expect(within(push).getByText('2')).toBeTruthy();
  expect(within(pull).getByText('1')).toBeTruthy();
  expect(push.getAttribute('aria-description')).toContain('待推 2');
  expect(pull.getAttribute('aria-description')).toContain('待拉 1');
  expect(view.container.querySelector('.git-sync-strip')).toBeNull();

  view.rerender(<Page value={{ ...status, ahead: 0, behind: 0 }}/>);
  expect(within(push).getByText('0')).toBeTruthy();
  expect(within(pull).getByText('0')).toBeTruthy();
  expect(push.getAttribute('aria-description')).toContain('待推 0');
  expect(pull.getAttribute('aria-description')).toContain('待拉 0');

  view.rerender(<Page value={{ ...status, branch: 'feature', tracking: null }}/>);
  expect(push.getAttribute('aria-description')).toContain('未设置上游');
  expect(pull.getAttribute('aria-description')).toContain('未设置上游');
  expect(push.textContent).not.toContain('2');
  expect(pull.textContent).not.toContain('1');

  view.rerender(<Page value={null}/>);
  expect(push.getAttribute('aria-description')).toContain('同步状态未知');
  expect(pull.getAttribute('aria-description')).toContain('同步状态未知');
});

it('详情入口显示检查新鲜度和失败，弹窗保留上次成功时间及最近结果', async () => {
  let fail = false;
  currentApiMock().override('git.invokeScoped', async () => fail ? { ok: false, message: 'FETCH_OFFLINE' } : { ok: true });
  render(<Page/>);
  expect(detailsButton().getAttribute('aria-description')).toContain('尚未检查远端');
  fireEvent.click(button('Fetch'));
  await waitFor(() => expect(detailsButton().getAttribute('aria-description')).toContain('刚刚检查'));
  fail = true; fireEvent.click(button('Fetch'));
  await waitFor(() => expect(operation()).toContain('远端检查失败'));
  expect(detailsButton().getAttribute('aria-description')).toContain('远端检查失败');
  fireEvent.click(detailsButton());
  const dialog = screen.getByRole('dialog', { name: 'Git 操作详情' });
  expect(dialog.textContent).toContain('上次成功检查：');
  expect(dialog.textContent).toContain('FETCH_OFFLINE');
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭操作回执' }));
  expect(operation()).not.toContain('远端检查失败');
  expect(document.activeElement).toBe(detailsButton());
  fireEvent.click(detailsButton());
  expect(screen.getByRole('dialog', { name: 'Git 操作详情' }).textContent).toContain('FETCH_OFFLINE');
});

it('只在可见且聚焦时自动检查，按仓去重、两分钟节流、失焦与隐藏停发', async () => {
  vi.useFakeTimers(); vi.mocked(document.hasFocus).mockReturnValue(true);
  const mock = currentApiMock(); mock.override('git.invokeScoped', async () => ({ ok: true }));
  const page = (active: boolean) => <GitWorkspaceProvider scope={{ workspaceId: 'one', rootsRevision: 0 }}>
    <Harness active={active}/><Harness active={active}/></GitWorkspaceProvider>;
  const view = render(page(true));
  await act(async () => { vi.advanceTimersByTime(1001); });
  expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new Event('blur')); vi.advanceTimersByTime(REMOTE_CHECK_INTERVAL_MS * 2); });
  expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledTimes(2);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledTimes(2);
  view.rerender(page(false));
  await act(async () => { vi.advanceTimersByTime(REMOTE_CHECK_INTERVAL_MS * 3); window.dispatchEvent(new Event('focus')); });
  expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledTimes(2);
});

it('切仓后晚到的结果不进入新仓或刷新新仓，返回原仓可查看结果', async () => {
  let finish!: (value: unknown) => void;
  currentApiMock().override('git.invokeScoped', () => new Promise(resolve => { finish = resolve; }));
  const view = render(<Page/>); fireEvent.click(button('Push'));
  view.rerender(<Page path="E:/other"/>);
  await act(async () => finish({ ok: true }));
  expect(operation()).not.toContain('推送成功'); expect(refresh).not.toHaveBeenCalled();
  view.rerender(<Page/>);
  expect(operation()).toContain('推送成功');
  expect(view.container.querySelector('.brand-loader')).toBeNull();
});
