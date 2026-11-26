import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { currentApiMock } from './helpers/api-mock';

const state = vi.hoisted(() => ({ workspaceId: 'a', flash: vi.fn() }));
vi.mock('../../src/renderer/src/store', () => ({ useWorkspaceStore: () => ({ activeWorkspaceId: state.workspaceId }), useUiStore: () => ({ flashTip: (...args: unknown[]) => state.flash(...args) }) }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useOverlayDismiss: vi.fn() }));
import { ExtensionChromeActions } from '../../src/renderer/src/components/ExtensionChromeActions';

beforeEach(() => state.flash.mockClear());

it('runs the selected menu command with its workspace and project revision', async () => {
  let root = 'one', revision = 0;
  const toolbar = vi.fn(async () => ({ workspaceId: 'a', sourceRootId: root, selectionRevision: revision, items: [{ id: 'dev', name: root === 'one' ? '项目一动作' : '项目二动作', scope: 'project', menu: [{ id: 'start', label: '启动' }] }] }));
  const run = vi.fn(async () => ({ status: 'completed', result: undefined }));
  currentApiMock().override('extensions.toolbar', toolbar);
  currentApiMock().override('extensions.runToolbar', run);
  render(<ExtensionChromeActions/>);
  fireEvent.click(await screen.findByRole('button', { name: '项目一动作' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /启动/ }));
  await waitFor(() => expect(run).toHaveBeenCalledWith({ workspaceId: 'a', sourceRootId: 'one', selectionRevision: 0, extensionId: 'dev', menuId: 'start', scope: 'project' }));
  root = 'two'; revision = 1;
  await act(async () => currentApiMock().emit('extensions:changed', {}));
  await screen.findByRole('button', { name: '项目二动作' });
  expect(screen.queryByRole('button', { name: '项目一动作' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '项目二动作' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /启动/ }));
  await waitFor(() => expect(run).toHaveBeenLastCalledWith({ workspaceId: 'a', sourceRootId: 'two', selectionRevision: 1, extensionId: 'dev', menuId: 'start', scope: 'project' }));
});

it('keeps additional actions in the overflow menu', async () => {
  currentApiMock().override('extensions.toolbar', async () => ({ workspaceId: 'a', sourceRootId: 'one', selectionRevision: 0, items: Array.from({ length: 6 }, (_, index) => ({ id: `tool-${index}`, name: `动作 ${index}`, scope: 'global' })) }));
  render(<ExtensionChromeActions/>);
  const overflow = await screen.findByTitle('还有 1 个扩展动作');
  fireEvent.click(overflow);
  expect(screen.getByRole('button', { name: '动作 5' })).toBeTruthy();
});

it('does not refetch repeatedly when the notification callback changes identity', async () => {
  const toolbar = vi.fn(async () => ({ workspaceId: 'a', sourceRootId: 'one', selectionRevision: 0, items: [{ id: 'one', name: '动作', scope: 'global' }] }));
  currentApiMock().override('extensions.toolbar', toolbar);
  const view = render(<ExtensionChromeActions/>);
  await screen.findByRole('button', { name: '动作' });
  view.rerender(<ExtensionChromeActions/>);
  await act(async () => {});
  expect(toolbar).toHaveBeenCalledTimes(1);
});

it('passes the toolbar scope through the shared chrome action', async () => {
  const run = vi.fn(async () => ({ status: 'completed', result: undefined }));
  currentApiMock().override('extensions.toolbar', async () => ({ workspaceId: 'a', sourceRootId: 'one', selectionRevision: 0, items: [{ id: 'quick-note', name: '快速记录', scope: 'global' }] }));
  currentApiMock().override('extensions.runToolbar', run);
  render(<ExtensionChromeActions/>);
  fireEvent.click(await screen.findByRole('button', { name: '快速记录' }));
  await waitFor(() => expect(run).toHaveBeenCalledWith({ workspaceId: 'a', sourceRootId: 'one', selectionRevision: 0, extensionId: 'quick-note', scope: 'global' }));
});

it('reports an unavailable extension without opening a dialog or retrying the command', async () => {
  const error = new Error('请在扩展管理中启用此扩展');
  const api = currentApiMock();
  api.override('extensions.toolbar', async () => ({
    workspaceId: 'a', sourceRootId: 'one', selectionRevision: 3,
    items: [{ id: 'build-package', name: '一键打包', scope: 'project' }]
  }));
  const run = api.mockOf('extensions.runToolbar').mockRejectedValueOnce(error);
  render(<ExtensionChromeActions />);
  const button = await screen.findByRole('button', { name: '一键打包' });
  fireEvent.click(button);
  await waitFor(() => expect(state.flash).toHaveBeenCalledExactlyOnceWith(`一键打包：${error}`));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(run).toHaveBeenCalledOnce();
  expect(button.hasAttribute('disabled')).toBe(false);
});
