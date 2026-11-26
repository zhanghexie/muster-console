/**
 * FileTree 多选交互（Ctrl/⌘ 点选、Shift 范围、Ctrl+A、Esc、右键聚合批量删除）：
 * - 修饰键点击只改选区，不触发打开文件等主操作；普通点击清空选区并保持原行为
 * - 右键落在多选区内 → 菜单作用于整选区，确认后逐项 fs.remove
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
      { name: 'b.ts', isDirectory: false, relativePath: 'b.ts' },
      { name: 'c.ts', isDirectory: false, relativePath: 'c.ts' },
      { name: 'sub', isDirectory: true, relativePath: 'sub' }
    ]
  }));
});

function rowClass(path: string): string {
  return document.querySelector<HTMLElement>(`[data-file-tree-row="${path}"]`)!.className;
}

describe('FileTree 多选', () => {
  it('Ctrl+点击切换选区且不触发打开；再点已选项移除', async () => {
    const onOpenFile = vi.fn();
    render(<FileTree workspaceId="ws" onOpenFile={onOpenFile} />);
    const a = await screen.findByTitle('a.ts');
    const b = await screen.findByTitle('b.ts');

    fireEvent.click(a, { ctrlKey: true });
    expect(rowClass('a.ts')).toContain('is-multiselected');
    expect(onOpenFile).not.toHaveBeenCalled();

    fireEvent.click(b, { ctrlKey: true });
    expect(rowClass('a.ts')).toContain('is-multiselected');
    expect(rowClass('b.ts')).toContain('is-multiselected');

    fireEvent.click(a, { ctrlKey: true });
    expect(rowClass('a.ts')).not.toContain('is-multiselected');
    expect(rowClass('b.ts')).toContain('is-multiselected');
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('Shift+点击按锚点取闭区间范围', async () => {
    render(<FileTree workspaceId="ws" onOpenFile={() => {}} />);
    const a = await screen.findByTitle('a.ts');
    const c = await screen.findByTitle('c.ts');

    fireEvent.click(a, { ctrlKey: true }); // 锚点 a
    fireEvent.click(c, { shiftKey: true }); // 范围 a..c
    expect(rowClass('a.ts')).toContain('is-multiselected');
    expect(rowClass('b.ts')).toContain('is-multiselected');
    expect(rowClass('c.ts')).toContain('is-multiselected');
    expect(rowClass('sub')).not.toContain('is-multiselected');
  });

  it('普通点击清空选区并保持打开行为', async () => {
    const onOpenFile = vi.fn();
    render(<FileTree workspaceId="ws" onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByTitle('a.ts'), { ctrlKey: true });
    fireEvent.click(await screen.findByTitle('b.ts'), { ctrlKey: true });
    expect(rowClass('a.ts')).toContain('is-multiselected');

    fireEvent.click(screen.getByTitle('a.ts'));
    expect(rowClass('a.ts')).not.toContain('is-multiselected');
    expect(rowClass('b.ts')).not.toContain('is-multiselected');
    expect(onOpenFile).toHaveBeenCalledWith('a.ts');
  });

  it('容器键盘：Ctrl+A 全选可见行，Esc 清空', async () => {
    render(<FileTree workspaceId="ws" onOpenFile={() => {}} />);
    await screen.findByTitle('a.ts');
    const container = document.querySelector<HTMLElement>('.file-tree-scroll')!;

    fireEvent.keyDown(container, { key: 'a', ctrlKey: true });
    expect(rowClass('a.ts')).toContain('is-multiselected');
    expect(rowClass('sub')).toContain('is-multiselected');

    fireEvent.keyDown(container, { key: 'Escape' });
    expect(rowClass('a.ts')).not.toContain('is-multiselected');
    expect(rowClass('sub')).not.toContain('is-multiselected');
  });

  it('右键落在多选区内 → 删除 N 项，确认后逐项调用 fs.remove', async () => {
    api.override('fs.remove', async () => ({ ok: true }));
    render(<FileTree workspaceId="ws" onOpenFile={() => {}} />);
    fireEvent.click(await screen.findByTitle('a.ts'), { ctrlKey: true });
    fireEvent.click(await screen.findByTitle('b.ts'), { ctrlKey: true });

    fireEvent.contextMenu(screen.getByTitle('a.ts'));
    fireEvent.click(await screen.findByText('删除 2 项'));
    await screen.findByText('删除 2 项？');

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(api.mockOf('fs.remove')).toHaveBeenCalledWith('ws', 'a.ts');
      expect(api.mockOf('fs.remove')).toHaveBeenCalledWith('ws', 'b.ts');
    });
    // 全部成功 → 对话框关闭
    await waitFor(() => expect(screen.queryByText('删除 2 项？')).toBeNull());
  });
});
