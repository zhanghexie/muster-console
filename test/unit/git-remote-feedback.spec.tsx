import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { GitRepoStatus } from '../../src/shared/types';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { useGitRemote, REMOTE_CHECK_INTERVAL_MS } from '../../src/renderer/src/panels/gitpanel/useGitRemote';
import { GitRemoteFeedback } from '../../src/renderer/src/panels/gitpanel/GitRemoteFeedback';
import { resetGitRemoteStateForTest } from '../../src/renderer/src/panels/gitpanel/gitRemoteState';
import { currentApiMock } from './helpers/api-mock';

const status: GitRepoStatus = { branch: 'main', tracking: 'origin/main', ahead: 2, behind: 1, files: [] };
const refresh = vi.fn(async () => {});
function Harness({ path = 'E:/remote', active = true, busy = false, value = status }: {
  path?: string; active?: boolean; busy?: boolean; value?: GitRepoStatus;
}): React.JSX.Element {
  const remote = useGitRemote({ scopeKey: 'one:0', repoPath: path, active, busy, status: value, refreshStatus: refresh });
  return <><button onClick={() => void remote.run('push')}>push</button><button onClick={() => void remote.run('fetch')}>fetch</button>
    <GitRemoteFeedback remote={remote} repoPath={path} status={value} active={active}/></>;
}
function Page(props: React.ComponentProps<typeof Harness>): React.JSX.Element {
  return <GitWorkspaceProvider scope={{ workspaceId: 'one', rootsRevision: 0 }}><Harness {...props}/></GitWorkspaceProvider>;
}
beforeEach(() => { resetGitRemoteStateForTest(); refresh.mockClear(); vi.spyOn(document, 'hasFocus').mockReturnValue(false); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('慢推送显示开始和用时，重复点击不重发，完成回执切页后仍在', async () => {
  let finish!: (value: unknown) => void;
  const mock = currentApiMock(); mock.override('git.invokeScoped', () => new Promise(resolve => { finish = resolve; }));
  const view = render(<Page/>);
  vi.useFakeTimers();
  fireEvent.click(screen.getByText('push')); fireEvent.click(screen.getByText('push'));
  expect(mock.mockOf('git.invokeScoped')).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/正在推送 · main/)).toBeTruthy();
  expect(view.container.querySelectorAll('.brand-loader')).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(2200); });
  expect(screen.getByText(/已用时 2 秒/)).toBeTruthy();
  await act(async () => finish({ ok: true, remote: { completedAt: Date.now(), targets: ['main → main'] } }));
  expect(screen.getByText(/推送成功 · main/)).toBeTruthy();
  expect(view.container.querySelector('.brand-loader')).toBeNull();
  view.rerender(<Page active={false}/>); view.rerender(<Page/>);
  expect(screen.getByText(/推送成功 · main/)).toBeTruthy();
  expect(view.container.querySelector('.brand-loader')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '详情' }));
  expect(screen.getByRole('dialog').textContent).toContain('main → main');
});

it('推送失败保留原始原因，本地刷新与后台 Fetch 成功都不清除；成功重试后替换', async () => {
  let rejected = true;
  currentApiMock().override('git.invokeScoped', async (_scope, method) => method === 'push' && rejected ? { ok: false, message: 'PUSH_REJECTED' } : { ok: true });
  render(<Page/>);
  fireEvent.click(screen.getByText('push'));
  await screen.findByText(/推送失败 · main/);
  fireEvent.click(screen.getByText('fetch'));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/推送失败 · main/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '详情' }));
  expect(screen.getByRole('dialog').textContent).toContain('PUSH_REJECTED');
  fireEvent.click(screen.getAllByRole('button', { name: '关闭' })[0]);
  rejected = false; fireEvent.click(screen.getByText('push'));
  await screen.findByText(/推送成功 · main/);
  expect(screen.queryByText(/推送失败 · main/)).toBeNull();
});

it('推送成功后状态查询失败，回执仍为成功', async () => {
  refresh.mockRejectedValueOnce(new Error('STATUS_FAILURE'));
  currentApiMock().override('git.invokeScoped', async () => ({ ok: true }));
  render(<Page/>); fireEvent.click(screen.getByText('push'));
  await screen.findByText(/推送成功 · main/);
  expect(screen.queryByText(/推送失败/)).toBeNull();
});

it('远端检查显示未知、新鲜、失败并保留上次成功时间，无上游不显示零计数', async () => {
  let fail = false;
  currentApiMock().override('git.invokeScoped', async () => fail ? { ok: false, message: 'FETCH_OFFLINE' } : { ok: true });
  const view = render(<Page/>); expect(screen.getByText('尚未检查远端')).toBeTruthy();
  expect(screen.getByText('待推 2 · 待拉 1')).toBeTruthy();
  fireEvent.click(screen.getByText('fetch')); await screen.findByText('刚刚检查');
  fail = true; fireEvent.click(screen.getByText('fetch'));
  await waitFor(() => expect(screen.getAllByText(/远端检查失败/).length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('button', { name: '详情' }));
  expect(screen.getByRole('dialog').textContent).toContain('上次成功检查：');
  expect(screen.getByRole('dialog').textContent).toContain('FETCH_OFFLINE');
  view.rerender(<Page value={{ ...status, branch: 'feature', tracking: null, ahead: 0, behind: 0 }}/>);
  expect(screen.getByText('未设置上游')).toBeTruthy();
  expect(screen.queryByText('待推 0 · 待拉 0')).toBeNull();
  expect(screen.getByText('尚未检查远端')).toBeTruthy();
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

it('切仓后晚到的结果不进入新仓或刷新新仓；返回原仓可查看结果', async () => {
  let finish!: (value: unknown) => void;
  currentApiMock().override('git.invokeScoped', () => new Promise(resolve => { finish = resolve; }));
  const view = render(<Page/>); fireEvent.click(screen.getByText('push'));
  view.rerender(<Page path="E:/other"/>);
  await act(async () => finish({ ok: true }));
  expect(screen.queryByText(/推送成功/)).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  view.rerender(<Page/>); expect(screen.getByText(/推送成功 · main/)).toBeTruthy();
  expect(view.container.querySelector('.brand-loader')).toBeNull();
});
