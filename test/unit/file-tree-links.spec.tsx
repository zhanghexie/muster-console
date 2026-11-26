import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, type ApiMock } from './helpers/api-mock';
import type { WorkspaceFileRef, WorkspaceInfo } from '../../src/shared/types';

const state = vi.hoisted(() => ({ workspaces: [] as WorkspaceInfo[] }));
vi.mock('../../src/renderer/src/store', () => ({ useWorkspaceStore: () => ({ workspaces: state.workspaces }) }));
import { FileTree } from '../../src/renderer/src/components/FileTree';

let api: ApiMock;
beforeEach(() => {
  state.workspaces = [{ id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, defaultRootId: 'a',
    controlRoot: 'E:/A', rootsRevision: 0, roots: [{ id: 'a', path: 'E:/A' }] }];
  api = createApiMock(); window.api = api.api;
  Element.prototype.scrollIntoView = vi.fn();
  api.override('fs.listTreeDirRef', async (ref: WorkspaceFileRef) => ({ entries: ref.relativePath === '' ? [
    { name: 'skills', relativePath: 'skills', isDirectory: true, isSymbolicLink: true, externalPath: 'C:/skills' },
    { name: 'broken', relativePath: 'broken', isDirectory: false, isSymbolicLink: true, linkError: 'ENOENT' },
    { name: 'parent', relativePath: 'parent', isDirectory: true },
    { name: 'regular.txt', relativePath: 'regular.txt', isDirectory: false }
  ] : ref.relativePath === 'parent' ? [
    { name: 'child-link', relativePath: 'parent/child-link', isDirectory: false, isSymbolicLink: true }
  ] : [{ name: 'SKILL.md', relativePath: 'skills/SKILL.md', isDirectory: false,
    viaSymbolicLink: true, externalPath: 'C:/skills/SKILL.md' }] }));
});

describe('文件树链接', () => {
  it('展开目录链接并通过鼠标与键盘打开目标，失效链接不能打开', async () => {
    const open = vi.fn(); const keep = vi.fn();
    render(<FileTree workspaceId="ws" rootId="a" onOpenFile={open} onKeepFile={keep} />);
    fireEvent.click(await screen.findByText('skills'));
    const skill = await screen.findByText('SKILL.md');
    expect(api.mockOf('fs.listTreeDirRef')).toHaveBeenCalledWith({ workspaceId: 'ws', rootId: 'a', relativePath: 'skills' });
    fireEvent.click(skill);
    expect(open).toHaveBeenCalledWith('skills/SKILL.md', 'C:/skills/SKILL.md');
    fireEvent.doubleClick(skill);
    expect(keep).toHaveBeenCalledWith('skills/SKILL.md', 'C:/skills/SKILL.md');
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' });
    expect(keep).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('broken'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('ENOENT')).toBeTruthy();
  });

  it('链接本身、链接内文件和包含链接的多选不提供删除', async () => {
    render(<FileTree workspaceId="ws" rootId="a" onOpenFile={() => {}} />);
    fireEvent.contextMenu(await screen.findByText('skills'));
    expect(screen.queryByText('删除')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('skills'));
    const skill = await screen.findByText('SKILL.md');
    fireEvent.contextMenu(skill);
    expect(screen.queryByText('删除')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(skill, { ctrlKey: true });
    fireEvent.click(screen.getByText('regular.txt'), { ctrlKey: true });
    fireEvent.contextMenu(skill);
    await waitFor(() => expect(screen.queryByText('删除 2 项')).toBeNull());
    expect(api.mockOf('fs.removeRef')).not.toHaveBeenCalled();
  });

  it('普通父目录和其链接子项同时选中时，合并路径后也不提供删除', async () => {
    render(<FileTree workspaceId="ws" rootId="a" onOpenFile={() => {}} />);
    const parent = await screen.findByText('parent');
    fireEvent.click(parent);
    const child = await screen.findByText('child-link');
    fireEvent.click(parent, { ctrlKey: true });
    fireEvent.click(child, { ctrlKey: true });
    fireEvent.contextMenu(parent);
    expect(screen.queryByText('删除')).toBeNull();
    expect(api.mockOf('fs.removeRef')).not.toHaveBeenCalled();
  });
});
