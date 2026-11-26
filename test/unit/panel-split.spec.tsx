import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SplitPaneRef } from '../../src/shared/centerSplit';
import { __resetCenterSplitForTest, attachCenterSplitBridge, centerSplitReconcilePrimary, centerSplitSelectAgentRef, getCenterSplitState } from '../../src/renderer/src/centerSplitStore';
import { registerFileEditorState } from '../../src/renderer/src/fileEditorState';
import { registerAgentCenterFileRead } from '../../src/renderer/src/rightPanelState';
import { usePanelSplit } from '../../src/renderer/src/hooks/usePanelSplit';
import { createApiMock } from './helpers/api-mock';
import { isWorkspaceFileClosePending, prepareWorkspaceFileClose, registerWorkspaceFileClose } from '../../src/renderer/src/workspaceFileClose';

const session = (sessionId: string): SplitPaneRef => ({ kind: 'session', sessionId });
describe('panel split request', () => {
  let primary: SplitPaneRef;
  beforeEach(() => { __resetCenterSplitForTest(); primary = session('a'); });
  afterEach(() => __resetCenterSplitForTest());
  it('cancels an in-flight split when workspace close preparation begins', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void;
    let selecting = false;
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws',
      selectRef: ref => { if (selecting) { primary = ref; return; } selecting = true; return new Promise<void>(resolve => { finish = resolve; }); },
      getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    const options = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
      page: 'terminal' as const, virtualScreen: true, focusMode: false, primary: () => primary, ensureWorkspaceVisible: vi.fn() };
    const unregister = registerWorkspaceFileClose(async () => ({ commit() {}, rollback() {} }));
    const hook = renderHook(() => usePanelSplit(options));
    let transaction: Awaited<ReturnType<typeof prepareWorkspaceFileClose>> | undefined;
    try {
      act(() => api.emit('panel:split-request', { requestId: 'close-race', workspaceId: 'ws', rootsRevision: 1,
        panes: [session('b'), session('c')], layoutId: 'halves' }));
      transaction = await prepareWorkspaceFileClose('ws');
      await act(async () => { primary = session('b'); centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
      expect(getCenterSplitState().open).toBe(false);
      expect(primary).toEqual(session('a'));
      expect(api.mockOf('panel.replySplit')).toHaveBeenCalledWith('close-race', expect.objectContaining({ ok: false, outcome: 'unknown' }));
      transaction.rollback();
    } finally { if (transaction && isWorkspaceFileClosePending('ws')) transaction.rollback(); hook.unmount(); unregister(); }
  });
  it('does not leave a cancelled background selection applied when its acknowledgement arrives late', async () => {
    let finish!: () => void, requested = false, allowed = true;
    const target = { kind: 'utility' as const, sel: 'tasks' };
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws',
      selectRef: ref => {
        if (!requested) { requested = true; return new Promise<void>(resolve => { finish = resolve; }); }
        primary = ref;
      }, getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    const selection = centerSplitSelectAgentRef('ws', target, () => allowed);
    allowed = false;
    await act(async () => { primary = target; centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
    expect(await selection).toBe('cancelled');
    expect(primary).toEqual(session('a'));
    expect(getCenterSplitState().pendingLayout).toBeNull();
  });
  it('restores an empty center after a cancelled selection arrives late', async () => {
    primary = { kind: 'empty' };
    let finish!: () => void, requested = false, allowed = true;
    const target = { kind: 'utility' as const, sel: 'tasks' };
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws',
      selectRef: ref => {
        if (!requested) { requested = true; return new Promise<void>(resolve => { finish = resolve; }); }
        primary = ref;
      }, getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    const selection = centerSplitSelectAgentRef('ws', target, () => allowed);
    allowed = false;
    await act(async () => { primary = target; centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
    expect(await selection).toBe('cancelled');
    expect(primary).toEqual({ kind: 'empty' });
    expect(getCenterSplitState().pendingLayout).toBeNull();
  });
  it('does not commit navigation after its bound snapshot changes during selection', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void;
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws',
      selectRef: () => new Promise<void>(resolve => { finish = resolve; }),
      getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    const node = { id: 'ext', title: 'ext', parentId: null, kind: 'extension' as const, extensionId: 'e', viewId: 'v', placement: 'center' as const };
    const navigation = { workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 1, revision: 1, nodes: [node], libraryExpanded: false };
    const options = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, navigation,
      page: 'terminal' as const, virtualScreen: true, focusMode: false, primary: () => primary, ensureWorkspaceVisible: vi.fn() };
    const hook = renderHook(() => usePanelSplit(options));
    const panes = [session('b'), { kind: 'utility' as const, sel: 'nav:ext' }];
    act(() => api.emit('panel:split-request', { requestId: 'nav', workspaceId: 'ws', rootsRevision: 1, panes, layoutId: 'halves',
      navigation: [{ sel: 'nav:ext', sourceRootId: 'root', selectionRevision: 1, revision: 1, node: JSON.stringify(node) }] }));
    navigation.revision = 2;
    await act(async () => { primary = session('b'); centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
    expect(getCenterSplitState().open).toBe(false);
    expect(api.mockOf('panel.replySplit')).toHaveBeenLastCalledWith('nav', expect.objectContaining({ ok: false, outcome: 'unknown' }));
    hook.unmount();
  });
  it('does not commit a file pane after its identity changes during selection', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void, selecting = false;
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws',
      selectRef: ref => { if (selecting) { primary = ref; return; } selecting = true; return new Promise<void>(resolve => { finish = resolve; }); },
      getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    const content = { kind: 'file' as const, path: 'a.txt', fileRef: { workspaceId: 'ws', rootId: 'root', relativePath: 'a.txt' } };
    const fileState = { tabId: 'right-7', centerOnly: true, pinned: false, content };
    const stop = registerAgentCenterFileRead((workspace, id) => workspace === 'ws' && id === fileState.tabId ? fileState : null);
    const options = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
      page: 'terminal' as const, virtualScreen: true, focusMode: false, primary: () => primary, ensureWorkspaceVisible: vi.fn() };
    const hook = renderHook(() => usePanelSplit(options));
    try {
      const target = { kind: 'utility' as const, sel: 'center-file:right-7' };
      const panes = [session('b'), target];
      const files = [{ sel: target.sel, tabId: 'right-7', centerOnly: true, pinned: false, content: JSON.stringify(content) }];
      act(() => api.emit('panel:split-request', { requestId: 'missing-file', workspaceId: 'ws', rootsRevision: 1, panes, layoutId: 'halves' }));
      expect(api.mockOf('panel.replySplit')).toHaveBeenLastCalledWith('missing-file', { ok: false, error: 'Center file changed' });
      act(() => api.emit('panel:split-request', { requestId: 'file', workspaceId: 'ws', rootsRevision: 1, panes, layoutId: 'halves', files }));
      fileState.pinned = true;
      await act(async () => { primary = session('b'); centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
      expect(getCenterSplitState().open).toBe(false);
      expect(primary).toEqual(session('a'));
      expect(api.mockOf('panel.replySplit')).toHaveBeenLastCalledWith('file', expect.objectContaining({ ok: false, outcome: 'unknown' }));
    } finally { hook.unmount(); stop(); }
  });
  it('does not commit if an editor becomes dirty while selection is pending', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void;
    let selecting = false;
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws',
      selectRef: ref => { if (selecting) { primary = ref; return; } selecting = true; return new Promise<void>(resolve => { finish = resolve; }); },
      getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    let unsaved = false;
    const stop = registerFileEditorState(() => ({ workspaceId: 'ws', path: 'a', active: true, editing: true, unsaved }));
    const options = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
      page: 'terminal' as const, virtualScreen: true, focusMode: false, primary: () => primary, ensureWorkspaceVisible: vi.fn() };
    const hook = renderHook(() => usePanelSplit(options));
    act(() => api.emit('panel:split-request', { requestId: 'dirty', workspaceId: 'ws', rootsRevision: 1,
      panes: [session('b'), session('c')], layoutId: 'halves' }));
    unsaved = true;
    await act(async () => { primary = session('b'); centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
    expect(getCenterSplitState().open).toBe(false);
    expect(primary).toEqual(session('a'));
    expect(api.mockOf('panel.replySplit')).toHaveBeenCalledWith('dirty', expect.objectContaining({ ok: false, outcome: 'unknown' }));
    expect(options.ensureWorkspaceVisible).not.toHaveBeenCalled();
    stop(); hook.unmount();
  });
  it('waits for the primary selection before acknowledging and protects dirty editors', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void;
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws',
      selectRef: () => new Promise<void>(resolve => { finish = resolve; }),
      getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    const options = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
      page: 'terminal' as const, virtualScreen: true, focusMode: false, primary: () => primary, ensureWorkspaceVisible: vi.fn() };
    const hook = renderHook(() => usePanelSplit(options));
    const panes = [session('b'), session('c')];
    act(() => api.emit('panel:split-request', { requestId: '1', workspaceId: 'ws', rootsRevision: 1, panes, layoutId: 'halves' }));
    expect(getCenterSplitState().pendingLayout).not.toBeNull();
    expect(api.mockOf('panel.replySplit')).not.toHaveBeenCalled();
    await act(async () => { primary = session('b'); centerSplitReconcilePrimary(); finish(); await Promise.resolve(); });
    expect(api.mockOf('panel.replySplit')).toHaveBeenLastCalledWith('1', { ok: true, panes, layoutId: 'halves' });
    const stop = registerFileEditorState(() => ({ workspaceId: 'ws', path: 'a', active: true, editing: true, unsaved: true }));
    act(() => api.emit('panel:split-request', { requestId: '2', workspaceId: 'ws', rootsRevision: 1, panes, layoutId: 'halves' }));
    expect(api.mockOf('panel.replySplit')).toHaveBeenLastCalledWith('2', expect.objectContaining({ ok: false, error: expect.stringMatching(/unsaved/) }));
    stop(); hook.unmount();
  });
  it('does not acknowledge the split until the actual target surfaces are visible', async () => {
    const api = createApiMock(); window.api = api.api;
    attachCenterSplitBridge({ getPrimary: () => primary, getSelectionScope: () => 'ws', selectRef: ref => { primary = ref; },
      getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}, supportsRef: () => true, canSelectRef: () => true });
    const initial = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
      page: 'terminal' as const, virtualScreen: true, focusMode: false, primary: () => primary, ensureWorkspaceVisible: vi.fn(), targetsVisible: () => false };
    const hook = renderHook(props => usePanelSplit(props), { initialProps: initial });
    const panes = [session('a'), session('b')];
    await act(async () => { api.emit('panel:split-request', { requestId: 'surface', workspaceId: 'ws', rootsRevision: 1, panes, layoutId: 'halves' }); await Promise.resolve(); });
    expect(api.mockOf('panel.replySplit')).not.toHaveBeenCalled();
    hook.rerender({ ...initial, targetsVisible: () => true });
    expect(api.mockOf('panel.replySplit')).toHaveBeenLastCalledWith('surface', { ok: true, panes, layoutId: 'halves' });
    hook.unmount();
  });
});
