import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { useGitAdoptComments } from '../../src/renderer/src/panels/gitpanel/useGitAdoptComments';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { DiffCommentPanel } from '../../src/renderer/src/panels/DiffCommentPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

const group = (id: string) => ({ id, path: `C:/tasks/${id}`, branch: 'ao/shared',
  sourceRoot: { rootId: id, path: `E:/source/${id}`, cwd: `E:/source/${id}` },
  source: { mainRepo: `E:/source/${id}`, commonDir: `E:/source/${id}/.git` },
  repos: [{ path: 'Plugins/Same', branch: 'ao/shared' }] });
const sessions = [{ id: 'owner', name: 'owner', type: 'terminal', cwd: 'C:/tasks/a', worktreePath: 'C:/tasks/a',
  worktreeGroups: { version: 1 as const, primaryGroupId: 'a', groups: [group('a'), group('b')] } }];
const errors = vi.fn(), refresh = vi.fn(async () => {}), selection = vi.fn();
const key = { file: 'same.txt', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 };
function Probe({ path }: { path: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const api = useGitAdoptComments({ selectedPath: path, visibleSessions: sessions, status: null,
    busy, setBusy, setError: errors, refreshList: refresh, setSelectedPath: selection, setDetailTab: () => {} });
  return <><button onClick={() => api.pickDiffLine({ file: 'same.txt', line: 1, original: 'old' })}>pick</button>
    <button onClick={api.toggleAdoptMode}>preview</button><button onClick={() => api.toggleAdoptHunk(key, true)}>hunk</button>
    <button onClick={api.doAdopt}>adopt</button><output>{api.adoptPreview?.targetRepo}</output>
    <DiffCommentPanel comments={api.diffComments} onSend={api.sendDiffComments}
      onChangeBody={(id, body) => api.setDiffComments(prev => prev.map(comment => comment.id === id ? { ...comment, body } : comment))}
      onRemove={id => api.setDiffComments(prev => prev.filter(comment => comment.id !== id))}
      sending={api.commentSending} workerName={api.commentWorker?.name ?? null} /></>;
}
function Tree({ path }: { path: string }): React.JSX.Element {
  return <StoreProvider><GitWorkspaceProvider scope={{ workspaceId: 'ws', rootsRevision: 0 }}><Probe path={path} /></GitWorkspaceProvider></StoreProvider>;
}
beforeEach(() => { errors.mockClear(); refresh.mockClear(); selection.mockClear(); });

it('第二组同名嵌套仓评论通过生产 Hook 发给唯一任务所有者，正文限定所选仓', async () => {
  const mock = currentApiMock(); mock.override('sessions.sendMessage', async () => ({ ok: true }));
  render(<Tree path="C:/tasks/b/Plugins/Same" />);
  fireEvent.click(screen.getByRole('button', { name: 'pick' }));
  fireEvent.change(screen.getByPlaceholderText('写评论…'), { target: { value: 'fix selected B' } });
  fireEvent.click(screen.getByRole('button', { name: '发送给 Worker' }));
  await waitFor(() => expect(mock.mockOf('sessions.sendMessage')).toHaveBeenCalledWith({ sessionId: 'owner',
    text: expect.stringContaining('仓库目录：C:/tasks/b/Plugins/Same') }));
  const brief = mock.mockOf('sessions.sendMessage').mock.calls[0]![0].text;
  expect(brief).toContain('E:/source/b/Plugins/Same'); expect(brief).toContain('fix selected B'); expect(brief).not.toContain('重新 push');
});

it('采纳请求完成前换仓，不清新仓草稿也不跳到旧仓来源', async () => {
  let finish!: (value: unknown) => void;
  currentApiMock().override('git.invokeScoped', async (_scope: unknown, method: string) => method === 'adoptPreview'
    ? { ok: true, targetRepo: 'E:/source/b', diff: '' } : new Promise(resolve => { finish = resolve; }));
  const view = render(<Tree path="C:/tasks/b" />);
  fireEvent.click(screen.getByRole('button', { name: 'preview' }));
  await screen.findByText('E:/source/b'); fireEvent.click(screen.getByRole('button', { name: 'hunk' }));
  fireEvent.click(screen.getByRole('button', { name: 'adopt' })); await waitFor(() => expect(finish).toBeTypeOf('function'));
  errors.mockClear();
  view.rerender(<Tree path="C:/tasks/a" />);
  await act(async () => finish({ ok: true, targetRepo: 'E:/source/b' }));
  expect(selection).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
});

it('评论旧回执不能将另一仓新评论标成已发送', async () => {
  const finishes: Array<(value: unknown) => void> = [];
  currentApiMock().override('sessions.sendMessage', () => new Promise(resolve => { finishes.push(resolve); }));
  const view = render(<Tree path="C:/tasks/b" />);
  fireEvent.click(screen.getByRole('button', { name: 'pick' }));
  fireEvent.change(screen.getByPlaceholderText('写评论…'), { target: { value: 'B comment' } });
  fireEvent.click(screen.getByRole('button', { name: '发送给 Worker' }));
  view.rerender(<Tree path="C:/tasks/a" />); fireEvent.click(screen.getByRole('button', { name: 'pick' }));
  fireEvent.change(screen.getByPlaceholderText('写评论…'), { target: { value: 'A draft' } });
  fireEvent.click(screen.getByRole('button', { name: '发送给 Worker' }));
  await act(async () => finishes[0]!({ ok: true }));
  expect((screen.getByPlaceholderText('写评论…') as HTMLTextAreaElement).value).toBe('A draft'); expect(screen.queryByText('已发送')).toBeNull();
  expect((screen.getByRole('button', { name: '发送中…' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finishes[1]!({ ok: true }));
  expect(screen.getByText('已发送')).toBeTruthy();
});
