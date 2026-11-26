import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePanelCenterFocus } from '../../src/renderer/src/hooks/usePanelCenterFocus';
import { createApiMock } from './helpers/api-mock';
import { canFocusCenterTarget, focusCenterPaneElement } from '../../src/renderer/src/panelCenterFocus';
import { registerAgentCenterFileRead } from '../../src/renderer/src/rightPanelState';

it('checks the exact center file identity before and during asynchronous focus', async () => {
  const api = createApiMock(); window.api = api.api;
  const content = { kind: 'file' as const, path: 'a.txt', fileRef: { workspaceId: 'ws', rootId: 'root', relativePath: 'a.txt' } };
  const fileState = { tabId: 'right-7', centerOnly: true, pinned: false, content };
  const unregister = registerAgentCenterFileRead((workspace, id) => workspace === 'ws' && id === fileState.tabId ? fileState : null);
  let resolve!: (slot: 0) => void, stillCurrent!: () => boolean;
  const focus = vi.fn((_target: unknown, current: () => boolean) => { stillCurrent = current; return new Promise<0>(done => { resolve = done; }); });
  const navigation = { workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 0, revision: 0, nodes: [], libraryExpanded: false };
  const state = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, visible: true, navigation, focus, canFocus: () => true };
  const hook = renderHook(() => usePanelCenterFocus(() => state));
  try {
    const target = { kind: 'utility' as const, sel: 'center-file:right-7' };
    const file = { sel: target.sel, tabId: 'right-7', centerOnly: true, pinned: false, content: JSON.stringify(content) };
    act(() => api.emit('panel:focus-center-request', { requestId: 'missing-file', workspaceId: 'ws', rootsRevision: 1, target }));
    expect(api.mockOf('panel.replyFocusCenter')).toHaveBeenLastCalledWith('missing-file', { ok: false, error: 'Center file changed' });
    expect(focus).not.toHaveBeenCalled();
    act(() => api.emit('panel:focus-center-request', { requestId: 'file-focus', workspaceId: 'ws', rootsRevision: 1, target, file }));
    expect(stillCurrent()).toBe(true);
    fileState.pinned = true;
    expect(stillCurrent()).toBe(false);
    await act(async () => { resolve(0); await Promise.resolve(); });
    expect(api.mockOf('panel.replyFocusCenter')).toHaveBeenLastCalledWith('file-focus', { ok: false, outcome: 'unknown', error: expect.stringContaining('changed') });
  } finally { hook.unmount(); unregister(); }
});

it('focuses only the navigation instance verified by the host', () => {
  const api = createApiMock(); window.api = api.api;
  const node = { id: 'ext', title: 'Extension', parentId: null, kind: 'extension' as const, extensionId: 'ext', viewId: 'main', placement: 'center' as const };
  const navigation = { workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 2, revision: 4, nodes: [node], libraryExpanded: false };
  const focus = vi.fn(() => 1 as const);
  const state = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, visible: true, navigation, focus, canFocus: () => true };
  const hook = renderHook(() => usePanelCenterFocus(() => state));
  const target = { kind: 'utility' as const, sel: 'nav:ext' };
  const identity = { sourceRootId: 'root', selectionRevision: 2, revision: 4, node: JSON.stringify(node) };
  act(() => api.emit('panel:focus-center-request', { requestId: 'ok', workspaceId: 'ws', rootsRevision: 1, target, navigation: identity }));
  expect(focus).toHaveBeenCalledOnce();
  expect(api.mockOf('panel.replyFocusCenter')).toHaveBeenLastCalledWith('ok', { ok: true, target, slot: 1 });
  act(() => api.emit('panel:focus-center-request', { requestId: 'stale', workspaceId: 'ws', rootsRevision: 1, target, navigation: { ...identity, revision: 3 } }));
  expect(focus).toHaveBeenCalledOnce();
  expect(api.mockOf('panel.replyFocusCenter')).toHaveBeenLastCalledWith('stale', { ok: false, error: 'Center navigation changed' });
  act(() => api.emit('panel:focus-center-request', { requestId: 'missing', workspaceId: 'ws', rootsRevision: 1, target }));
  expect(focus).toHaveBeenCalledOnce();
  expect(api.mockOf('panel.replyFocusCenter')).toHaveBeenLastCalledWith('missing', { ok: false, error: 'Center navigation changed' });
  hook.unmount();
});

it('does not report focus when the center is hidden or the target is not safe to focus', () => {
  const api = createApiMock(); window.api = api.api;
  const navigation = { workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 1, revision: 1, nodes: [], libraryExpanded: false };
  const focus = vi.fn(() => 0 as const);
  const state = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, visible: false, navigation, focus, canFocus: () => true };
  const hook = renderHook(() => usePanelCenterFocus(() => state));
  const target = { kind: 'session' as const, sessionId: 's' };
  act(() => api.emit('panel:focus-center-request', { requestId: 'hidden', workspaceId: 'ws', rootsRevision: 1, target }));
  expect(api.mockOf('panel.replyFocusCenter')).toHaveBeenLastCalledWith('hidden', { ok: false, error: expect.stringContaining('not safely visible') });
  state.visible = true; state.canFocus = () => false;
  act(() => api.emit('panel:focus-center-request', { requestId: 'blocked', workspaceId: 'ws', rootsRevision: 1, target }));
  expect(api.mockOf('panel.replyFocusCenter')).toHaveBeenLastCalledWith('blocked', { ok: false, error: expect.stringContaining('not safely visible') });
  expect(focus).not.toHaveBeenCalled();
  hook.unmount();
});

it('rejects docked placeholders and protects dirty settings before focusing', () => {
  const target = { kind: 'utility' as const, sel: 'nav:ext' };
  const node = { id: 'ext', title: 'Extension', parentId: null, kind: 'extension' as const, extensionId: 'ext', viewId: 'main', placement: 'tab' as const };
  const state = { docked: false, navigation: [node], settingsModal: false, settingsDirty: false, settingsVisible: false, settingsDocked: false };
  expect(canFocusCenterTarget(target, state)).toBe(false);
  expect(canFocusCenterTarget(target, { ...state, navigation: [{ ...node, placement: 'window' }] })).toBe(false);
  expect(canFocusCenterTarget(target, { ...state, navigation: [{ ...node, placement: undefined }] })).toBe(true);
  expect(canFocusCenterTarget({ kind: 'session', sessionId: 's' }, { ...state, docked: true })).toBe(false);
  expect(canFocusCenterTarget({ kind: 'session', sessionId: 's' }, { ...state, settingsDirty: true, settingsVisible: true })).toBe(false);
  expect(canFocusCenterTarget({ kind: 'utility', sel: 'settings' }, { ...state, settingsDirty: true, settingsVisible: true })).toBe(true);
  expect(canFocusCenterTarget({ kind: 'utility', sel: 'settings' }, { ...state, settingsModal: true })).toBe(false);
});

it('focuses a painted pane and verifies the actual active element', async () => {
  const pane = document.createElement('div'); pane.className = 'center-split-pane'; pane.dataset.pane = '0'; pane.tabIndex = -1;
  document.body.appendChild(pane);
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
  await expect(focusCenterPaneElement(0, () => true)).resolves.toBeUndefined();
  expect(document.activeElement).toBe(pane);
  await expect(focusCenterPaneElement(0, () => false)).rejects.toThrow(/changed or request closed/);
  let current = true;
  pane.blur(); pane.addEventListener('focus', () => { current = false; }, { once: true });
  await expect(focusCenterPaneElement(0, () => current)).rejects.toThrow(/changed while focusing/);
  pane.remove();
});

it('does not acknowledge an asynchronous focus after the host closes its request', async () => {
  const api = createApiMock(); window.api = api.api;
  let complete!: (slot: 0) => void;
  const focus = vi.fn(() => new Promise<0>(resolve => { complete = resolve; }));
  const state = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, visible: true,
    navigation: { workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 1, revision: 1, nodes: [], libraryExpanded: false },
    focus, canFocus: () => true };
  const hook = renderHook(() => usePanelCenterFocus(() => state));
  act(() => api.emit('panel:focus-center-request', { requestId: 'cancelled', workspaceId: 'ws', rootsRevision: 1, target: { kind: 'session', sessionId: 's' } }));
  act(() => api.emit('panel:focus-center-closed', { requestId: 'cancelled' }));
  await act(async () => { complete(0); await Promise.resolve(); });
  expect(api.mockOf('panel.replyFocusCenter')).not.toHaveBeenCalled();
  hook.unmount();
});
