/**
 * FileTree 删除链路（P3 files-panel F-01 回归）：
 * - 确认删除后 fs.remove **通道级 reject**（主进程 handler 整体 try/catch 之外的窗口）
 *   → 确认框带「错误：…」滞留、删除态复位，且不产生 unhandled rejection
 *   （此前 confirmDelete 只有 try/finally，`void confirmDelete()` 直接抛未处理拒绝、
 *   界面无任何提示）。与 {ok:false} 业务失败路径同一呈现（对齐 loadDir 口径）。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, type ApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';

const state = vi.hoisted(() => ({ workspaces: [] as WorkspaceInfo[] }));
vi.mock('../../src/renderer/src/store', () => ({
  useWorkspaceStore: () => ({ activeWorkspaceId: 'ws', workspaces: state.workspaces })
}));
import { FileTree } from '../../src/renderer/src/components/FileTree';

let api: ApiMock;
beforeEach(() => {
  state.workspaces = [
    {
      id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, defaultRootId: 'main',
      controlRoot: 'E:/A', rootsRevision: 0, roots: [{ id: 'main', path: 'E:/A', label: '工程' }]
    }
  ];
  api = createApiMock();
  window.api = api.api;
  Element.prototype.scrollIntoView = vi.fn();
  api.override('fs.listTreeDir', async () => ({
    entries: [
      { name: 'a.ts', isDirectory: false, relativePath: 'a.ts' },
      { name: 'sub', isDirectory: true, relativePath: 'sub' }
    ]
  }));
});

async function openDeleteDialog(): Promise<void> {
  const row = await screen.findByTitle('a.ts');
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByText('删除'));
  await screen.findByText('删除文件？');
}

describe('FileTree 删除失败反馈', () => {
  it('fs.remove 通道级 reject → 确认框带错误滞留，且无 unhandled rejection', async () => {
    api.override('fs.remove', () => Promise.reject(new Error('通道序列化炸了')));
    render(<FileTree workspaceId="ws" onOpenFile={() => {}} />);
    await openDeleteDialog();

    const unhandled: string[] = [];
    const onRej = (e: PromiseRejectionEvent): void => { unhandled.push(String(e.reason)); };
    window.addEventListener('unhandledrejection', onRej);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(screen.getByText(/通道序列化炸了/)).toBeTruthy());
    window.removeEventListener('unhandledrejection', onRej);
    expect(unhandled).toEqual([]);
    // 删除态复位：按钮不再是「删除中…」，可再次提交
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除中…' })).toBeNull();
  });

  it('fs.remove 业务失败（{ok:false}）→ 同一呈现口径：确认框带错误，树保留条目', async () => {
    api.override('fs.remove', () => Promise.resolve({ ok: false, error: '文件被占用' }));
    render(<FileTree workspaceId="ws" onOpenFile={() => {}} />);
    await openDeleteDialog();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.getByText(/文件被占用/)).toBeTruthy());
    expect(screen.getByTitle('a.ts')).toBeTruthy();
    expect(api.mockOf('fs.remove')).toHaveBeenCalledWith('ws', 'a.ts');
  });
});
