import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import type { WorkspaceInfo, WorkspaceFileEntry } from '../../src/shared/types';

const ws: WorkspaceInfo = { id: 'files-ws', name: 'Files', path: 'E:/roots-a', openedAt: 1,
  defaultRootId: 'a', controlRoot: 'E:/roots-a', rootsRevision: 0,
  roots: [{ id: 'a', path: 'E:/roots-a', label: 'Alpha' }, { id: 'b', path: 'E:/roots-b', label: 'Beta' }] };
const entries: WorkspaceFileEntry[] = ['a', 'b'].map(rootId => ({ path: 'same.ts', absolutePath: `E:/roots-${rootId}/same.ts`,
  fileRef: { workspaceId: ws.id, rootId, relativePath: 'same.ts' } }));
function props() { return { workspaceId: ws.id, busy: false, surfaceKind: 'gui-session' as const,
  onSend: vi.fn(async (_text: string) => true), onClear: vi.fn(async () => undefined) }; }
function type(text: string): void {
  const editor = screen.getByRole('textbox'); editor.focus(); editor.textContent = text;
  const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  fireEvent.input(editor);
}
async function mount(componentProps = props()) {
  const mock = currentApiMock();
  mock.override('workspaces.list', async () => ({ workspaces: [ws], activeWorkspaceId: ws.id }));
  mock.override('config.get', async () => ({ workspaces: [ws], activeWorkspaceId: ws.id, locale: 'zh-CN' }));
  mock.override('fs.cancelQuery', async () => ({ cancelled: true }));
  Element.prototype.scrollIntoView = () => {};
  document.execCommand = () => false;
  render(<StoreProvider><AgentComposer {...componentProps} /></StoreProvider>);
  await act(async () => { await Promise.resolve(); });
  return mock;
}

describe('Composer 多源根文件引用', () => {
  it('同名候选显示根，药丸显示短路径，发送为第二根绝对路径', async () => {
    const mock = currentApiMock();
    mock.override('workspaces.listFiles', async () => ({ files: entries, rootsRevision: 0 }));
    const inputProps = props(); await mount(inputProps);
    type('@same');
    expect(await screen.findByRole('option', { name: /@Alpha\/same.ts/ })).toBeTruthy();
    const beta = await screen.findByRole('option', { name: /@Beta\/same.ts/ });
    fireEvent.mouseDown(beta);
    const editor = screen.getByRole('textbox');
    expect(editor.querySelector('.composer-token-label')?.textContent).toBe('@Beta/same.ts');
    expect(editor.querySelector('.composer-token')?.getAttribute('data-token')).toBe('@E:/roots-b/same.ts');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(inputProps.onSend).toHaveBeenCalledTimes(1));
    expect(inputProps.onSend.mock.calls[0][0]).toBe('@E:/roots-b/same.ts');
    expect(mock.mockOf('fs.cancelQuery')).toHaveBeenCalledWith(ws.id, expect.any(String));
  });

  it('根版本变更取消旧请求；旧结果和多根裸路径候选不回填', async () => {
    const mock = currentApiMock();
    let completeOld: (value: unknown) => void = () => {};
    let calls = 0;
    mock.override('workspaces.listFiles', () => ++calls === 1 ? new Promise(resolve => { completeOld = resolve; })
      : Promise.resolve({ files: [entries[0], { path: 'unscoped.ts' }], rootsRevision: 1 }));
    await mount(); type('@same');
    await waitFor(() => expect(calls).toBe(1));
    await act(async () => mock.emit('workspaces:changed', { workspaces: [{ ...ws, rootsRevision: 1 }], activeWorkspaceId: ws.id }));
    expect(await screen.findByRole('option', { name: /@Alpha\/same.ts/ })).toBeTruthy();
    await act(async () => completeOld({ files: [entries[1]], rootsRevision: 0 }));
    expect(screen.queryByRole('option', { name: /Beta|unscoped/ })).toBeNull();
    expect(mock.mockOf('fs.cancelQuery')).toHaveBeenCalled();
  });

  it('部分根失败仍保留可用候选，过期失败不再弹新通知', async () => {
    const mock = currentApiMock();
    mock.override('workspaces.listFiles', async () => ({ files: entries, rootsRevision: 0, roots: [{ rootId: 'b', error: 'offline', truncated: false, timedOut: false }] }));
    await mount(); type('@same');
    // 输入框上方 hint 条已移除：部分根失败改弹桌面通知，候选照常保留
    await waitFor(() =>
      expect(mock.mockOf('notify.toast')).toHaveBeenCalledWith({
        text: expect.stringMatching(/部分文件夹搜索失败：Beta/)
      })
    );
    expect(screen.queryByText(/部分文件夹搜索失败/)).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    type('plain text');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(mock.mockOf('fs.cancelQuery')).toHaveBeenCalled();
    let complete: (value: unknown) => void = () => {};
    mock.override('workspaces.listFiles', () => new Promise(resolve => { complete = resolve; }));
    type('@other');
    await waitFor(() => expect(mock.mockOf('workspaces.listFiles')).toHaveBeenCalledTimes(1));
    type('plain again');
    const toastMock = mock.mockOf('notify.toast');
    const before = toastMock.mock.calls.length;
    await act(async () => complete({ files: [], error: 'late error' }));
    // 过期结果的失败被 gen 守卫丢弃：不弹新通知（旧失败不会追着新状态刷屏）
    expect(toastMock.mock.calls.length).toBe(before);
    expect(screen.queryByText('late error')).toBeNull();
  });
});
