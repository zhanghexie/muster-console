import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const trustRequired = {
  status: 'development-trust-required',
  error: 'Error: extension development trust is required before running this package'
} as const;
const runInput = { workspaceId: 'a', sourceRootId: 'one', selectionRevision: 3, extensionId: 'build-package' };
const dialogName = '允许运行「一键打包」？';

async function clickBuildAction(scope: 'project' | 'global' = 'project'): Promise<HTMLElement> {
  const { workspaceId, sourceRootId, selectionRevision, extensionId } = runInput;
  currentApiMock().override('extensions.toolbar', async () => ({
    workspaceId, sourceRootId, selectionRevision, items: [{ id: extensionId, name: '一键打包', scope }]
  }));
  render(<ExtensionChromeActions />);
  const button = await screen.findByRole('button', { name: '一键打包' });
  await act(async () => { fireEvent.click(button); });
  return button;
}

it.each(['project', 'global'] as const)('grants persistent development trust and retries the original %s action once', async scope => {
  const api = currentApiMock();
  const run = api.mockOf('extensions.runToolbar').mockResolvedValueOnce(trustRequired).mockResolvedValueOnce({ status: 'completed', result: undefined });
  const trust = api.mockOf('extensionCatalog.trust');
  let grant!: (result: { trusted: boolean }) => void;
  trust.mockReturnValue(new Promise<{ trusted: boolean }>(resolve => { grant = resolve; }));
  const button = await clickBuildAction(scope);
  const dialog = within(await screen.findByRole('dialog', { name: dialogName }));
  expect(document.activeElement).toBe(dialog.getByRole('button', { name: '取消' }));
  expect(trust).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: '信任并运行' })); });
  expect(trust).toHaveBeenCalledExactlyOnceWith({
    scope, extensionId: runInput.extensionId, mode: 'trusted-persistent',
    ...(scope === 'project' ? { workspaceId: runInput.workspaceId, sourceRootId: runInput.sourceRootId } : {})
  });
  expect(run).toHaveBeenCalledOnce();
  await act(async () => { grant({ trusted: true }); });
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(run.mock.calls).toEqual([[{ ...runInput, scope }], [{ ...runInput, scope }]]);
  expect(state.flash).not.toHaveBeenCalled();
});

it('cancels the trust prompt without granting trust or retrying', async () => {
  const api = currentApiMock();
  const run = api.mockOf('extensions.runToolbar').mockResolvedValueOnce(trustRequired);
  await clickBuildAction();
  const dialog = within(await screen.findByRole('dialog', { name: dialogName }));
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: '取消' })); });
  expect(state.flash).toHaveBeenCalledExactlyOnceWith('已取消授权');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull());
  expect(api.mockOf('extensionCatalog.trust')).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledOnce();
});

it('keeps the existing toast for ordinary errors, even with the same text as the trust gate', async () => {
  const api = currentApiMock();
  api.mockOf('extensions.runToolbar').mockRejectedValueOnce(new Error(trustRequired.error.slice('Error: '.length)));
  await clickBuildAction();
  await waitFor(() => expect(state.flash).toHaveBeenCalledExactlyOnceWith(`一键打包：${trustRequired.error}`));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.mockOf('extensionCatalog.trust')).not.toHaveBeenCalled();
});

it.each([
  ['an action error', new Error('绑定项目缺少打包脚本')],
  ['another trust requirement', trustRequired]
] as const)('reports %s on retry without reopening the trust prompt', async (_label, failure) => {
  const api = currentApiMock();
  const run = api.mockOf('extensions.runToolbar').mockResolvedValueOnce(trustRequired);
  if (failure instanceof Error) run.mockRejectedValueOnce(failure);
  else run.mockResolvedValueOnce(failure);
  const trust = api.mockOf('extensionCatalog.trust').mockResolvedValue({ trusted: true });
  await clickBuildAction();
  const dialog = within(await screen.findByRole('dialog', { name: dialogName }));
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: '信任并运行' })); });
  const error = failure instanceof Error ? String(failure) : failure.error;
  expect(state.flash).toHaveBeenCalledExactlyOnceWith(`一键打包：${error}`);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull());
  expect(trust).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledTimes(2);
});

it('reports a failed trust write and leaves the command blocked', async () => {
  const api = currentApiMock();
  const run = api.mockOf('extensions.runToolbar').mockResolvedValueOnce(trustRequired);
  api.mockOf('extensionCatalog.trust').mockRejectedValueOnce(new Error('Could not save trust settings'));
  await clickBuildAction();
  const dialog = within(await screen.findByRole('dialog', { name: dialogName }));
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: '信任并运行' })); });
  expect(state.flash).toHaveBeenCalledExactlyOnceWith('一键打包：Error: Could not save trust settings');
  expect(run).toHaveBeenCalledOnce();
});
