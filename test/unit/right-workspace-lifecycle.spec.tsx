import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { browserPanelReplaySrcPrefix, type BrowserTabInfo } from '../../src/shared/browser';
import { currentApiMock } from './helpers/api-mock';

const state = vi.hoisted(() => ({
  workspaceId: 'ws', sessionId: 'current', sessions: [] as Array<{ id: string; name: string; archived?: boolean }>,
  cfg: {} as Record<string, any>, flash: vi.fn(), show: vi.fn()
}));
vi.mock('../../src/renderer/src/store', () => ({
  useSessionStore: () => ({ activeId: state.sessionId, sessions: state.sessions, visibleSessions: [] }),
  useRuntimesStore: () => ({ runtimes: [] }),
  useWorkspaceStore: () => ({ activeWorkspaceId: state.workspaceId, workspaces: ['ws', 'other'].map(id => ({
    id, name: id, path: `E:/${id}`, controlRoot: `E:/${id}`, defaultRootId: id, rootsRevision: 0,
    roots: [{ id, path: `E:/${id}` }], openedAt: 0
  })) }),
  useUiStore: () => ({ flashTip: state.flash, requestShowWorkspace: state.show, requestComposerInsert: vi.fn(),
    openCommandPalette: vi.fn(), openWorkspaceFile: null, openTurnReview: null, clearOpenWorkspaceFile: vi.fn(), clearTurnReview: vi.fn() })
}));
vi.mock('../../src/renderer/src/hooks/useWorkspaceFile', () => ({
  useWorkspaceFile: () => ({ cfg: state.cfg[state.workspaceId] ?? {}, ready: true, workspaceId: state.workspaceId,
    patch: async (value: unknown, workspaceId: string) => {
      state.cfg[workspaceId] = { ...(state.cfg[workspaceId] ?? {}), ...(value as object) };
      return { ok: true, config: state.cfg[workspaceId] };
    } })
}));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useKeybinding: () => {}, useChordLabel: () => '', useOverlayDismiss: () => {} }));
vi.mock('../../src/renderer/src/panels/GitPanel', () => ({ GitPanel: () => null }));
vi.mock('../../src/renderer/src/panels/FilesPanel', async () => {
  const React = await import('react');
  return { FilesPanel: React.forwardRef(() => null) };
});
import { SideToolsPanel } from '../../src/renderer/src/panels/SideToolsPanel';

const tree = (active: boolean) => <PanelHistoryProvider><SideToolsPanel active={active} gitEverActive pageVisible/></PanelHistoryProvider>;
const remote = { id: 'remote-web', workspaceId: 'other', sessionId: 'remote-session', scope: 'session' as const,
  openInBackground: true, title: 'Remote', url: 'https://remote.test/', favicon: null, loading: false, canGoBack: false, canGoForward: false };

beforeEach(() => {
  localStorage.removeItem('muster.right-workspace.archived-tabs.v1');
  state.workspaceId = 'ws'; state.sessionId = 'current'; state.sessions = [{ id: 'remote-session', name: 'Remote' }];
  state.cfg = {}; state.flash.mockClear(); state.show.mockClear();
  const api = currentApiMock();
  api.override('browser.preloadPath', async () => ({ path: '' }));
  api.override('browser.restore', async () => ({ tabs: [remote], activeId: null }));
  api.override('browser.close', async () => { api.emit('browser:tabs', { tabs: [], activeId: null }); return { ok: true }; });
  api.override('browser.open', async () => ({ id: 'restored-web' }));
});

it('archives and restores a background page from an unopened workspace across a remount', async () => {
  const api = currentApiMock();
  let view = render(tree(true));
  await waitFor(() => expect(api.mockOf('browser.restore')).toHaveBeenCalled(), { timeout: 10000 });
  await act(async () => api.emit('browser:mount-request', { tabId: remote.id }));
  await waitFor(() => expect(view.container.querySelector('webview[data-tab-id="remote-web"]')).toBeTruthy());
  state.sessions = [{ id: 'remote-session', name: 'Remote', archived: true }];
  view.rerender(tree(false));
  await waitFor(() => expect(api.mockOf('browser.close')).toHaveBeenCalledWith({ id: 'remote-web' }));
  await waitFor(() => expect(view.container.querySelector('webview[data-tab-id="remote-web"]')).toBeNull());
  await waitFor(() => expect(JSON.parse(localStorage.getItem('muster.right-workspace.archived-tabs.v1')!).tabs).toEqual([
    expect.objectContaining({ workspaceId: 'other', sessionId: 'remote-session', suspended: true, content: expect.objectContaining({ browserId: '', url: remote.url }) })
  ]));
  view.unmount();
  api.override('browser.restore', async () => ({ tabs: [], activeId: null }));
  view = render(tree(true));
  state.sessions = [{ id: 'remote-session', name: 'Remote' }];
  view.rerender(tree(false));
  await waitFor(() => expect(JSON.parse(localStorage.getItem('muster.right-workspace.archived-tabs.v1')!).tabs[0].suspended).toBeUndefined());
  expect(api.mockOf('browser.open')).not.toHaveBeenCalled();
  state.workspaceId = 'other'; state.sessionId = 'remote-session'; view.rerender(tree(true));
  await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledWith({ url: remote.url, workspaceId: 'other', sessionId: 'remote-session', scope: 'session', background: true, restoreShell: true }));
}, 15000);

it('waits for close before undo and binds exactly the replay response with a same-URL tab present', async () => {
  const api = currentApiMock();
  const first = { ...remote, id: 'peer', title: 'Peer', workspaceId: 'ws', sessionId: 'current', scope: 'workspace' as const };
  const old = { ...first, id: 'old', title: 'Restore me', panelHistoryKey: 'first' };
  const closed = { ...old, panelHistoryKey: 'detail' };
  const restored = { ...closed, id: 'restored' };
  api.override('browser.restore', async () => ({ tabs: [first, old], activeId: old.id }));
  let finishClose!: (result: { ok: boolean; tab: BrowserTabInfo }) => void;
  api.override('browser.close', () => {
    api.emit('browser:tabs', { tabs: [first], activeId: first.id });
    return new Promise(resolve => { finishClose = resolve; });
  });
  let finishReplay!: (value: typeof restored) => void;
  let replayRequestId = '';
  api.override('browser.replayPanelHistory', ({ requestId }: { requestId: string }) => {
    replayRequestId = requestId;
    api.emit('browser:tabs', { tabs: [first, { ...restored, panelReplayRequest: requestId, panelRestorePending: true }], activeId: first.id });
    api.emit('browser:mount-request', { tabId: restored.id });
    return new Promise(resolve => { finishReplay = resolve; });
  });
  const view = render(tree(true));
  fireEvent.click(await screen.findByRole('tab', { name: /Restore me/ }));
  const undo = screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement;
  fireEvent.click(screen.getByRole('button', { name: '关闭标签页 Restore me' }));
  await waitFor(() => expect(api.mockOf('browser.close')).toHaveBeenCalledWith({ id: old.id }));
  expect(undo.disabled).toBe(true);
  expect(screen.getByRole('tab', { name: /Restore me/ })).toBeTruthy();
  await act(async () => finishClose({ ok: true, tab: closed }));
  await waitFor(() => expect(screen.queryByRole('tab', { name: /Restore me/ })).toBeNull());
  fireEvent.click(undo);
  await waitFor(() => expect(api.mockOf('browser.replayPanelHistory')).toHaveBeenCalledWith(expect.objectContaining({
    historyKey: 'detail', workspaceId: 'ws', url: old.url, browserId: undefined
  })));
  expect(screen.queryByRole('tab', { name: /Restore me/ })).toBeNull();
  const guest = () => view.container.querySelector('webview[data-tab-id="restored"]');
  expect(guest()?.getAttribute('src')).toBe(browserPanelReplaySrcPrefix + replayRequestId);
  view.rerender(tree(false));
  view.rerender(tree(true));
  await act(async () => finishReplay(restored));
  await waitFor(() => expect(guest()?.getAttribute('data-browser-presentation')).toBe('foreground'));
  expect(screen.getAllByRole('tab', { name: /Restore me/ })).toHaveLength(1);
  expect(screen.getByRole('tab', { name: /Peer/ })).toBeTruthy();
  expect(api.mockOf('browser.replayPanelHistory')).toHaveBeenCalledTimes(1);
  expect(api.mockOf('browser.open')).not.toHaveBeenCalled();
});

it('keeps the command available when native replay fails, then retries it against the same guest', async () => {
  const api = currentApiMock();
  const home = { ...remote, id: 'live', title: 'Home', workspaceId: 'ws', sessionId: 'current', scope: 'workspace' as const, panelHistoryKey: 'home' };
  const detail = { ...home, title: 'Detail', url: 'https://remote.test/detail', panelHistoryKey: 'detail', panelHistoryUserNavigation: true };
  api.override('browser.restore', async () => ({ tabs: [home], activeId: home.id }));
  render(tree(true));
  fireEvent.click(await screen.findByRole('tab', { name: /Home/ }));
  await act(async () => api.emit('browser:tabs', { tabs: [detail], activeId: home.id }));
  const undo = screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement;
  const redo = screen.getByRole('button', { name: '重做' }) as HTMLButtonElement;
  api.override('browser.replayPanelHistory', async () => { throw new Error('replay failed'); });
  fireEvent.click(undo);
  await waitFor(() => expect(state.flash).toHaveBeenCalledWith('replay failed'));
  expect(undo.disabled).toBe(false); expect(redo.disabled).toBe(true);
  expect(screen.getByRole('tab', { name: /Detail/ }).getAttribute('aria-selected')).toBe('true');
  api.override('browser.replayPanelHistory', async () => {
    api.emit('browser:tabs', { tabs: [home], activeId: home.id });
    return home;
  });
  fireEvent.click(undo);
  await waitFor(() => expect(screen.getByRole('tab', { name: /Home/ }).getAttribute('aria-selected')).toBe('true'));
  expect(api.mockOf('browser.replayPanelHistory')).toHaveBeenCalledWith(expect.objectContaining({ browserId: home.id, historyKey: 'home' }));
  expect(redo.disabled).toBe(false);
  expect(api.mockOf('browser.open')).not.toHaveBeenCalled();
  expect(api.mockOf('browser.navigate')).not.toHaveBeenCalled();
});
