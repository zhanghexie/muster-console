import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionDeleteFlow } from '../../src/renderer/src/components/sessionDeleteFlow';
import { WorktreeCleanupErrorDialog } from '../../src/renderer/src/components/WorktreeCleanupErrorDialog';
import { ArchivedSessionView } from '../../src/renderer/src/components/ArchivedSessionView';
import { useSessionWorktreeFlow } from '../../src/renderer/src/components/sessionWorktreeFlow';
import type { SessionMeta } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

afterEach(() => vi.unstubAllGlobals());

function Harness() {
  const { requestDelete, deleteFlowNode } = useSessionDeleteFlow(vi.fn());
  return <><button onClick={() => requestDelete(['parent'])}>delete parent</button>{deleteFlowNode}</>;
}

it('retries retained worktree cleanup without trying to delete the session', async () => {
  const api = currentApiMock();
  const retained: SessionMeta = { id: 'parent', name: '归档会话', type: 'terminal', archived: true, createdAt: 1,
    worktreePath: 'task-tree', meta: { worktreeCleanupIssue: 'ignored files' } };
  api.override('sessions.cleanupArchivedWorktree', async () => ({ ok: false, message: 'still retained' }));
  function RetainedWorktree() {
    const flow = useSessionWorktreeFlow([retained], vi.fn());
    return <><button onClick={() => flow.showWorktree(retained.id)}>retained</button>{flow.worktreeFlowNode}</>;
  }
  render(<RetainedWorktree />);
  fireEvent.click(screen.getByText('retained'));
  const dialog = screen.getByRole('dialog', { name: 'worktree 清理详情' });
  expect(within(dialog).getByText(/ignored files/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '重试安全清理' }));
  expect(await within(dialog).findByText(/still retained/)).toBeTruthy();
  expect(api.mockOf('sessions.cleanupArchivedWorktree')).toHaveBeenCalledWith('parent');
  expect(api.mockOf('sessions.close')).not.toHaveBeenCalled();
});

it('previews descendants and Git effects, and can delete history while retaining the checkout', async () => {
  const api = currentApiMock();
  api.override('sessions.deletePreview', async () => ({ name: 'Parent', fingerprint: 'scope', descendants: 2, active: 0,
    worktrees: [{ path: 'task-tree', branch: 'ao/task', disposition: 'remove-directory' }] }));
  render(<Harness />);
  fireEvent.click(screen.getByText('delete parent'));
  let dialog = await screen.findByRole('dialog', { name: '永久删除' });
  expect(within(dialog).getByText(/2 个子会话/)).toBeTruthy();
  expect(within(dialog).getByText(/task-tree.*预计删除目录并保留分支/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(api.mockOf('sessions.close')).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByText('delete parent'));
  dialog = await screen.findByRole('dialog', { name: '永久删除' });
  fireEvent.click(within(dialog).getByRole('button', { name: '删除会话，保留 worktree' }));
  expect(api.mockOf('sessions.close')).toHaveBeenCalledWith('parent', { fingerprint: 'scope', keepWorktrees: true });
  expect(await screen.findByRole('dialog', { name: '删除结果' })).toBeTruthy();
});

it('keeps the delete dialog open and reports worktree progress until close resolves', async () => {
  const api = currentApiMock();
  let finish!: () => void;
  api.override('sessions.deletePreview', async () => ({ name: 'Parent', fingerprint: 'scope', descendants: 0, active: 0,
    worktrees: [{ path: 'task-tree', branch: 'ao/task', disposition: 'remove-directory' }] }));
  api.override('sessions.close', () => new Promise<void>(resolve => { finish = resolve; }));
  render(<Harness />);
  fireEvent.click(screen.getByText('delete parent'));
  const dialog = await screen.findByRole('dialog', { name: '永久删除' });
  fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }));
  expect(await within(dialog).findByText(/正在删除会话并清理 worktree/)).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: '永久删除' }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '永久删除' })).toBeNull());
});

it('confirms the native history scope and keeps a native writer conflict out of the force worktree flow', async () => {
  const api = currentApiMock();
  api.override('sessions.deletePreview', async () => ({
    name: 'Parent', fingerprint: 'scope', descendants: 0, active: 0,
    worktrees: [{ path: 'task-tree', branch: 'ao/task' }],
    nativeHistory: [{ provider: 'Codex', count: 3, permanent: true, deletesNativeChildSessions: true }]
  }));
  api.override('sessions.close', async () => {
    throw new Error("Error invoking remote method 'sessions:close': NativeSessionHistoryError: Codex 线程正在使用中");
  });
  render(<Harness />);
  fireEvent.click(screen.getByText('delete parent'));
  const dialog = await screen.findByRole('dialog', { name: '永久删除' });
  expect(within(dialog).getByText(/同时永久删除 Codex 中的 3 条会话记录/)).toBeTruthy();
  expect(within(dialog).getByText(/关联的原生子会话也会删除。/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }));
  const failure = await screen.findByRole('dialog', { name: '删除失败' });
  expect(within(failure).getByText(/Codex 线程正在使用中/)).toBeTruthy();
  expect(within(failure).queryByRole('button', { name: '强制删除 worktree 和分支' })).toBeNull();
});

it('shows the exact cleanup failure and offers force removal of the worktree and branch', async () => {
  const api = currentApiMock();
  api.override('sessions.deletePreview', async () => ({ name: 'Parent', fingerprint: 'scope', descendants: 0, active: 0,
    worktrees: [{ path: 'task-tree', branch: 'ao/task', disposition: 'verify' }] }));
  api.override('sessions.close', async (...args: any[]) => {
    if (args[1]?.forceWorktrees) return undefined;
    throw new Error('worktree 被进程锁定：task-tree');
  });
  render(<Harness />);
  fireEvent.click(screen.getByText('delete parent'));
  const dialog = await screen.findByRole('dialog', { name: '永久删除' });
  fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }));
  const failure = await screen.findByRole('dialog', { name: '删除失败' });
  expect(within(failure).getByText(/worktree 被进程锁定/)).toBeTruthy();
  expect(document.activeElement).toBe(within(failure).getAllByRole('button', { name: '关闭' }).at(-1));
  fireEvent.click(within(failure).getByRole('button', { name: '强制删除 worktree 和分支' }));
  await waitFor(() => expect(api.mockOf('sessions.close')).toHaveBeenLastCalledWith('parent', { fingerprint: 'scope', forceWorktrees: true }));
  expect(await screen.findByRole('dialog', { name: '删除结果' })).toBeTruthy();
});

it.each([undefined, 'delete'] as const)('force cleanup respects the originating intent %s', async intent => {
  const api = currentApiMock();
  const retry = vi.fn();
  const props = { onClose: vi.fn(), onFailure: vi.fn(), onRetryDelete: retry };
  api.override('sessions.previewForceRemoveUnregistered', async () => ({ token: 'confirmed-directory', path: 'task-tree', branch: 'ao/task' }));
  api.override('sessions.forceRemoveUnregistered', async () => ({ ok: true }));
  const { rerender } = render(<WorktreeCleanupErrorDialog {...props} failure={{ message: 'not registered', sessionId: 'parent', path: 'task-tree', intent }} />);
  fireEvent.click(within(screen.getByRole('dialog', { name: '删除或清理失败' })).getByRole('button', { name: '强制删除目录' }));
  rerender(<WorktreeCleanupErrorDialog {...props} failure={null} />);
  const force = await screen.findByRole('dialog', { name: '强制删除遗留目录' });
  fireEvent.click(within(force).getByRole('button', { name: '强制删除目录' }));
  await waitFor(() => expect(api.mockOf('sessions.forceRemoveUnregistered')).toHaveBeenCalledWith('parent', 'confirmed-directory'));
  expect(api.mockOf('sessions.close')).not.toHaveBeenCalled();
  if (intent === 'delete') await waitFor(() => expect(retry).toHaveBeenCalledWith('parent'));
  else expect(retry).not.toHaveBeenCalled();
});

it('reads an archived GUI transcript without starting a runtime until Continue is clicked', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  await import('../../src/renderer/src/components/ArchivedGuiTranscript');
  const api = currentApiMock();
  api.override('agentSession.historyRange', async () => ({ mode: 'auto', before: 0, total: 1, hasEarlier: false, busy: false,
    messages: [{ id: 'msg1', role: 'user', parts: [{ kind: 'text', text: '归档里留下的消息' }], ts: Date.now() }] }));
  render(<ArchivedSessionView chat session={{ id: 'parent', name: '归档会话', type: 'terminal', archived: true, createdAt: 1 }} />);
  expect(await screen.findByText('归档里留下的消息', undefined, { timeout: 5_000 })).toBeTruthy();
  expect(api.mockOf('sessions.continueArchived')).not.toHaveBeenCalled();
  expect(api.mockOf('sessions.select')).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续会话' })); });
  expect(api.mockOf('sessions.continueArchived')).toHaveBeenCalledWith('parent');
}, 15_000);
