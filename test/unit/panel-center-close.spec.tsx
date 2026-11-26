import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SplitPaneRef } from '../../src/shared/centerSplit';
import { __resetCenterSplitForTest, attachCenterSplitBridge, centerSplitApplyAgentLayout,
  centerSplitReconcilePrimary, getCenterSplitState } from '../../src/renderer/src/centerSplitStore';
import { registerFileEditorState } from '../../src/renderer/src/fileEditorState';
import { registerAgentCenterFileRead } from '../../src/renderer/src/rightPanelState';
import { usePanelCenterClose } from '../../src/renderer/src/hooks/usePanelCenterClose';
import { createApiMock } from './helpers/api-mock';

const session = (sessionId: string): SplitPaneRef => ({ kind: 'session', sessionId });
describe('agent center close', () => {
  let primary: SplitPaneRef;
  beforeEach(() => { __resetCenterSplitForTest(); primary = session('a'); });
  afterEach(() => __resetCenterSplitForTest());
  it('refuses a stale navigation identity before closing a pane', async () => {
    const api = createApiMock(); window.api = api.api;
    const node = { id: 'ext', title: 'ext', parentId: null, kind: 'extension' as const, extensionId: 'e', viewId: 'v', placement: 'center' as const };
    const navigation = { workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 1, revision: 2, nodes: [node], libraryExpanded: false };
    const navPane = { kind: 'utility' as const, sel: 'nav:ext' };
    const hook = renderHook(() => usePanelCenterClose({ workspaceId: 'ws', rootsRevision: 1, switching: false,
      transitioning: false, settingsBlocked: false, navigation, primary: () => primary }));
    act(() => api.emit('panel:close-center-request', { requestId: 'nav', workspaceId: 'ws', rootsRevision: 1, slot: 1,
      panes: [session('a'), navPane], navigation: [{ sel: 'nav:ext', sourceRootId: 'root', selectionRevision: 1, revision: 1, node: JSON.stringify(node) }] }));
    expect(api.mockOf('panel.replyCloseCenter')).toHaveBeenCalledWith('nav', { ok: false, error: 'Center navigation changed' });
    expect(getCenterSplitState().open).toBe(false); hook.unmount();
  });
  it('confirms a closed view without ending its session and rejects stale or dirty targets', async () => {
    const api = createApiMock(); window.api = api.api;
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws', selectRef: ref => { primary = ref; },
      getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    await act(async () => { expect(await centerSplitApplyAgentLayout('ws', [session('a'), session('b')], 'halves')).toBe('applied'); });
    const options = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, settingsBlocked: false, primary: () => primary };
    const hook = renderHook(() => usePanelCenterClose(options));
    const request = { requestId: 'close', workspaceId: 'ws', rootsRevision: 1, slot: 1, panes: [session('a'), session('b')] };
    act(() => api.emit('panel:close-center-request', { ...request, panes: [session('a'), session('stale')] }));
    expect(api.mockOf('panel.replyCloseCenter')).toHaveBeenLastCalledWith('close', expect.objectContaining({ ok: false, error: expect.stringMatching(/changed/) }));
    options.settingsBlocked = true; hook.rerender();
    act(() => api.emit('panel:close-center-request', request));
    expect(api.mockOf('panel.replyCloseCenter')).toHaveBeenLastCalledWith('close', expect.objectContaining({ ok: false, error: expect.stringMatching(/settings/) }));
    options.settingsBlocked = false; hook.rerender();
    const unregister = registerFileEditorState(() => ({ workspaceId: 'ws', path: 'a', active: true, editing: true, unsaved: true }));
    act(() => api.emit('panel:close-center-request', request));
    expect(api.mockOf('panel.replyCloseCenter')).toHaveBeenLastCalledWith('close', expect.objectContaining({ ok: false, error: expect.stringMatching(/unsaved/) }));
    unregister();
    await act(async () => { api.emit('panel:close-center-request', request); await Promise.resolve(); });
    expect(api.mockOf('panel.replyCloseCenter')).toHaveBeenLastCalledWith('close', { ok: true, target: session('b'), closed: true });
    expect(getCenterSplitState().open).toBe(false); expect(primary).toEqual(session('a'));
    expect(api.mockOf('sessions.delete')).not.toHaveBeenCalled(); hook.unmount();
  });
  it('does not commit a delayed close after cancellation', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void, delayed = false;
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws', selectRef: ref => {
      if (delayed && ref.kind === 'session' && ref.sessionId === 'b') return new Promise<void>(resolve => { finish = resolve; });
      primary = ref;
    }, getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    await act(async () => { expect(await centerSplitApplyAgentLayout('ws', [session('a'), session('b')], 'halves')).toBe('applied'); });
    const hook = renderHook(() => usePanelCenterClose({ workspaceId: 'ws', rootsRevision: 1, switching: false,
      transitioning: false, settingsBlocked: false, primary: () => primary }));
    delayed = true;
    act(() => api.emit('panel:close-center-request', { requestId: 'cancel', workspaceId: 'ws', rootsRevision: 1, slot: 0, panes: [session('a'), session('b')] }));
    act(() => api.emit('panel:close-center-closed', { requestId: 'cancel' }));
    await act(async () => { primary = session('b'); centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
    expect(getCenterSplitState().open).toBe(true); expect(primary).toEqual(session('a'));
    expect(api.mockOf('panel.replyCloseCenter')).not.toHaveBeenCalled(); hook.unmount();
  });
  it('rejects an unbound file and cancels a close if the file identity changes in flight', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void, delayed = false;
    const target = { kind: 'utility' as const, sel: 'center-file:right-7' };
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws', selectRef: ref => {
      if (delayed && ref.kind === 'utility' && ref.sel === target.sel) return new Promise<void>(resolve => { finish = resolve; });
      primary = ref;
    }, getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    await act(async () => { expect(await centerSplitApplyAgentLayout('ws', [session('a'), target], 'halves')).toBe('applied'); });
    const content = { kind: 'file' as const, path: 'a.txt', fileRef: { workspaceId: 'ws', rootId: 'root', relativePath: 'a.txt' } };
    const fileState = { tabId: 'right-7', centerOnly: true, pinned: false, content };
    const stop = registerAgentCenterFileRead((workspace, id) => workspace === 'ws' && id === fileState.tabId ? fileState : null);
    const hook = renderHook(() => usePanelCenterClose({ workspaceId: 'ws', rootsRevision: 1, switching: false,
      transitioning: false, settingsBlocked: false, primary: () => primary }));
    try {
      const panes = [session('a'), target];
      act(() => api.emit('panel:close-center-request', { requestId: 'missing-file', workspaceId: 'ws', rootsRevision: 1, slot: 0, panes }));
      expect(api.mockOf('panel.replyCloseCenter')).toHaveBeenLastCalledWith('missing-file', { ok: false, error: 'Center file changed' });
      delayed = true;
      const files = [{ sel: target.sel, tabId: 'right-7', centerOnly: true, pinned: false, content: JSON.stringify(content) }];
      act(() => api.emit('panel:close-center-request', { requestId: 'file-close', workspaceId: 'ws', rootsRevision: 1, slot: 0, panes, files }));
      fileState.pinned = true;
      await act(async () => { primary = target; centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
      expect(primary).toEqual(session('a'));
      expect(getCenterSplitState().open).toBe(true);
      expect(api.mockOf('panel.replyCloseCenter')).toHaveBeenLastCalledWith('file-close', expect.objectContaining({ ok: false, outcome: 'unknown' }));
    } finally { hook.unmount(); stop(); }
  });
});
