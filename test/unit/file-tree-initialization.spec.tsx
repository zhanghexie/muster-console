import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/store', () => ({ useWorkspaceStore: () => ({ activeWorkspaceId: 'ws', workspaces: [
  { id: 'ws', name: 'Workspace', path: 'E:/A', controlRoot: 'E:/A', rootsRevision: 0, defaultRootId: 'main', roots: [{ id: 'main', path: 'E:/A' }] }
] }) }));
import { FileTree } from '../../src/renderer/src/components/FileTree';

it('首次挂载先初始化选择状态，随后多选拖拽和右键均可用', async () => {
  const api = currentApiMock();
  const listing = async () => ({ entries: ['a.ts', 'b.ts'].map(name => ({ name, relativePath: name, isDirectory: false })) });
  api.override('fs.listTreeDirRef', listing); api.override('fs.listTreeDir', listing);
  Element.prototype.scrollIntoView = vi.fn();
  render(<FileTree workspaceId="ws" rootId="main" onOpenFile={() => {}}/>);
  const a = await screen.findByTitle('a.ts'), b = await screen.findByTitle('b.ts');
  fireEvent.click(a, { ctrlKey: true }); fireEvent.click(b, { ctrlKey: true });
  expect(a.getAttribute('aria-selected')).toBe('true');
  expect(b.getAttribute('aria-selected')).toBe('true');
  fireEvent.dragStart(a, { dataTransfer: { setData: vi.fn() } });
  expect(api.mockOf('shell.startPathDrag')).toHaveBeenCalledWith(['E:/A/a.ts', 'E:/A/b.ts']);
  fireEvent.contextMenu(a);
  expect(await screen.findByText(/删除\s*2\s*项/)).toBeTruthy();
});

it('源根行左右键可以折叠再展开', async () => {
  const api = currentApiMock();
  const listing = async () => ({ entries: [{ name: 'src', relativePath: 'src', isDirectory: true }] });
  api.override('fs.listTreeDirRef', listing); api.override('fs.listTreeDir', listing);
  Element.prototype.scrollIntoView = vi.fn();
  render(<FileTree workspaceId="ws" rootId="main" onOpenFile={() => {}}/>);
  await screen.findByText('src');
  const tree = screen.getByRole('tree', { name: 'A' });
  const root = () => tree.querySelector<HTMLElement>('[data-file-tree-row=""]')!;
  expect(root().getAttribute('aria-expanded')).toBe('true');
  act(() => { fireEvent.click(root()); });
  expect(root().getAttribute('aria-expanded')).toBe('false');
  act(() => { fireEvent.keyDown(tree, { key: 'ArrowRight' }); });
  expect(root().getAttribute('aria-expanded')).toBe('true');
  act(() => { fireEvent.keyDown(tree, { key: 'ArrowLeft' }); });
  expect(root().getAttribute('aria-expanded')).toBe('false');
});
