/** Exercise the actual renderer store, including delayed App selection acknowledgements. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { deriveCenterSplitDockLayout, deriveCenterSplitSnapLayout, deriveCenterSplitIncomingSnapLayout, getCenterSplitPaneRefs, getCenterSplitPaneCells,
  type CenterSnapLayoutId, type CenterPaneSlot, type SplitPaneRef, type SplitSide } from '../../src/shared/centerSplit';
import {
  __resetCenterSplitForTest, attachCenterSplitBridge, centerSplitApplyAgentLayout, centerSplitClose, centerSplitClosePane, centerSplitDissolve,
  centerSplitCommitDockLayout, centerSplitCommitSnapLayout, centerSplitCommitIncomingSnapLayout, centerSplitDockPane, centerSplitIncoming,
  centerSplitReconcilePrimary, centerSplitSelectInPane, centerSplitSetFocused,
  centerSplitSetRatio, centerSplitSetDividerRatio, centerSplitRestoreHistory, centerSplitResetRatio, centerSplitFlip, centerSplitSwap, centerSplitToggleShortcut, centerSplitTryFill,
  getCenterSplitState, pruneCenterSplit, useCenterSplit, type CenterSplitBridge
} from '../../src/renderer/src/centerSplitStore';
import { focusVisibleCenterPane } from '../../src/renderer/src/panelCenterFocus';

const session = (sessionId: string): SplitPaneRef => ({ kind: 'session', sessionId });
const utility = (sel: string): SplitPaneRef => ({ kind: 'utility', sel });
let primary: SplitPaneRef;
let bridge: CenterSplitBridge;
let selected: SplitPaneRef[];
let saved: Array<{ dir?: 'row' | 'col'; ratio?: number }>;

beforeEach(() => {
  __resetCenterSplitForTest(); primary = session('a'); selected = []; saved = [];
  bridge = {
    getPrimary: () => primary,
    selectRef: ref => { selected.push(ref); primary = ref; },
    getPrefs: () => ({ dir: 'row', ratio: 0.65 }),
    savePrefs: prefs => { saved.push(prefs); },
    supportsRef: ref => ref.kind !== 'session' || ref.sessionId !== 'scheduled',
    canSelectRef: () => true,
    getUnderlyingPrimary: () => session('a')
  };
  attachCenterSplitBridge(bridge);
});

describe('three-slot Snap controller', () => {
  const refs = () => getCenterSplitPaneRefs(primary, getCenterSplitState());
  const snap = (layoutId: CenterSnapLayoutId, index = 0, source: CenterPaneSlot = 0) => {
    const candidate = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), source, { layoutId, index });
    expect(candidate).not.toBeNull(); expect(centerSplitCommitSnapLayout(candidate!)).toBe(true);
    return candidate!;
  };
  const three = () => { open(); snap('focus'); centerSplitSelectInPane(2, session('c')); };
  it('commits explicit agent panes only after the real primary selection is confirmed', async () => {
    bridge.getSelectionScope = () => 'ws';
    const delayed = deferSelection();
    const result = centerSplitApplyAgentLayout('ws', [session('b'), session('c')], 'halves');
    expect(primary).toEqual(session('a'));
    expect(getCenterSplitState().pendingLayout?.panes).toEqual([session('b'), session('c')]);
    await delayed.acknowledge();
    expect(await result).toBe('applied');
    expect(refs()).toEqual([session('b'), session('c')]);
    expect(getCenterSplitState()).toMatchObject({ open: true, layoutId: 'halves', order: [0, 1], focused: 0 });
  });
  it('cancels a delayed agent layout when its commit guard becomes false', async () => {
    bridge.getSelectionScope = () => 'ws';
    const delayed = deferSelection();
    let allowed = true;
    const result = centerSplitApplyAgentLayout('ws', [session('b'), session('c')], 'halves', () => allowed);
    allowed = false;
    await delayed.acknowledge();
    expect(await result).toBe('cancelled');
    expect(getCenterSplitState().open).toBe(false);
    expect(primary).toEqual(session('a'));
  });
  it('rejects duplicate, unsupported, stale or over-capacity agent layouts before mutation', async () => {
    bridge.getSelectionScope = () => 'ws';
    const before = getCenterSplitState();
    await expect(centerSplitApplyAgentLayout('other', [session('a'), session('b')], 'halves')).rejects.toThrow(/invalid/);
    await expect(centerSplitApplyAgentLayout('ws', [session('a'), session('a')], 'halves')).rejects.toThrow(/invalid/);
    await expect(centerSplitApplyAgentLayout('ws', [session('a'), session('scheduled')], 'halves')).rejects.toThrow(/invalid/);
    await expect(centerSplitApplyAgentLayout('ws', [session('a'), session('b'), session('c')], 'halves')).rejects.toThrow(/invalid/);
    expect(getCenterSplitState()).toEqual(before);
    expect(selected).toEqual([]);
  });
  it('cancels an agent layout when the user closes it during a delayed selection', async () => {
    bridge.getSelectionScope = () => 'ws';
    const delayed = deferSelection();
    const result = centerSplitApplyAgentLayout('ws', [session('b'), session('c')], 'halves');
    centerSplitClose();
    expect(await result).toBe('cancelled');
    await delayed.acknowledge();
    expect(getCenterSplitState().open).toBe(false);
    expect(primary).toEqual(session('a'));
  });
  it('focuses only a confirmed visible center pane and never invents a target', () => {
    three();
    const observer = renderHook(() => useCenterSplit());
    act(() => expect(focusVisibleCenterPane(primary, session('b'))).toBe(1));
    expect(observer.result.current.focused).toBe(1);
    expect(getCenterSplitState().focused).toBe(1);
    expect(() => focusVisibleCenterPane(primary, session('missing'))).toThrow(/not visible/);
    expect(getCenterSplitState().focused).toBe(1);
    expect(() => focusVisibleCenterPane(primary, { kind: 'empty' })).toThrow(/empty/);
    observer.unmount();
  });
  it('三分屏调宽使旧Snap候选失效，导航回放保留比例，新布局回到默认比例', () => {
    three(); const candidate = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'thirds', index: 1 })!;
    centerSplitSetDividerRatio(0, .65); centerSplitSetDividerRatio(1, .3);
    expect(getCenterSplitState().ratios).toEqual([.65, .3]);
    expect(centerSplitCommitSnapLayout(candidate)).toBe(false);
    const current = getCenterSplitState();
    const snapshot = { secondary: current.secondary, tertiary: current.tertiary, dir: current.dir, ratio: current.ratio, ratios: current.ratios,
      focused: current.focused, layoutId: current.layoutId, order: current.order };
    centerSplitClose(); centerSplitRestoreHistory(primary, snapshot, () => {});
    expect(getCenterSplitState().ratios).toEqual([.65, .3]);
    centerSplitResetRatio(); expect(getCenterSplitState().ratios).toEqual([.5, .5]);
    centerSplitSetDividerRatio(0, .7); snap('thirds'); expect(getCenterSplitState().ratios).toBeUndefined();
    centerSplitSetDividerRatio(0, .9); expect(getCenterSplitState().ratios![0]).toBeCloseTo(2 / 3 - .2);
    centerSplitSetDividerRatio(1, -.3); expect(getCenterSplitState().ratios![1]).toBeCloseTo(2 / 3);
  });
  it('single content snaps into three cells with selectors and shortcut focuses an empty third slot', () => {
    snap('focus', 2); expect(refs()).toEqual([session('a'), { kind: 'empty' }, { kind: 'empty' }]);
    centerSplitSelectInPane(1, session('b')); centerSplitSetFocused(0); centerSplitToggleShortcut();
    expect(getCenterSplitState().focused).toBe(2); expect(primary).toEqual(session('a'));
    expect(centerSplitTryFill(session('c'))).toBe(true); expect(refs()).toEqual([session('a'), session('b'), session('c')]);
  });
  it.each([0, 1, 2] as const)('moving slot %i to each three-cell target keeps all original sessions', source => {
    three();
    for (const layoutId of ['focus', 'thirds'] as const) for (const index of [0, 1, 2]) {
      const candidate = snap(layoutId, index, source);
      expect(refs()).toEqual([session('a'), session('b'), session('c')]);
      expect(getCenterSplitState().order).toEqual(candidate.order); expect(getCenterSplitState().focused).toBe(source);
      expect(primary).toEqual(session('a'));
    }
    expect(deriveCenterSplitSnapLayout(primary, getCenterSplitState(), source, { layoutId: 'halves', index: 0 })).toBeNull();
  });
  it('assist/folder/rail selection never duplicates content from the third logical slot', () => {
    three(); centerSplitSetFocused(0); expect(centerSplitTryFill(session('c'))).toBe(true);
    expect(getCenterSplitState().focused).toBe(2); expect(selected).toEqual([]);
    expect(centerSplitSelectInPane(1, session('c'))).toBe(true); expect(refs()).toEqual([session('a'), session('b'), session('c')]);
    centerSplitSetFocused(2); expect(centerSplitTryFill(utility('nav:child'))).toBe(true);
    expect(refs()).toEqual([session('a'), session('b'), utility('nav:child')]);
    expect(centerSplitSelectInPane(2, session('scheduled'))).toBe(false);
  });
  it('native direction insertion and swapping keep the third content rather than collapsing to a pair', () => {
    three(); centerSplitIncoming(session('c'), 'left'); expect(refs()).toEqual([session('a'), session('b'), session('c')]);
    centerSplitIncoming(session('d'), 'bottom'); expect(refs().filter(ref => ref.kind !== 'empty')).toHaveLength(3);
    expect(refs()).toContainEqual(session('c')); expect(refs()).toContainEqual(session('d'));
    const third = getCenterSplitState().tertiary; centerSplitSwap(); expect(getCenterSplitState().tertiary).toEqual(third);
  });
  it.each([0, 1, 2] as const)('closing one of three panes compacts the two remaining references: slot %i', slot => {
    three(); centerSplitClosePane(slot);
    const remaining = ['a', 'b', 'c'].filter((_, index) => index !== slot).map(session);
    expect(refs()).toHaveLength(2); expect(refs()).toEqual(expect.arrayContaining(remaining));
    expect(getCenterSplitState().open).toBe(true); expect(getCenterSplitState().tertiary).toBeUndefined();
    expect(getCenterSplitPaneCells(getCenterSplitState()).reduce((area, cell) => area + cell.width * cell.height, 0)).toBe(1);
  });
  it('explicit dissolve keep-third produces one selected pane; other sessions are not closed', () => {
    three(); centerSplitDissolve(2); expect(primary).toEqual(session('c')); expect(refs()).toEqual([session('c')]);
    expect(getCenterSplitState().open).toBe(false); expect(getCenterSplitState().tertiary).toBeUndefined();
  });
  it('external primary selecting the third instance clears only its duplicate and lost third stays an empty selector', () => {
    three(); primary = session('c'); centerSplitReconcilePrimary();
    expect(refs()).toEqual([session('c'), session('b'), { kind: 'empty' }]);
    centerSplitSelectInPane(2, utility('nav:gone')); pruneCenterSplit(ref => ref.kind !== 'utility');
    expect(refs()).toEqual([session('c'), session('b'), { kind: 'empty' }]);
    centerSplitToggleShortcut(); expect(getCenterSplitState().focused).toBe(2);
  });
  it('rejects stale candidate refs, empty-slot filling, changed geometry/order and a changed workspace scope', () => {
    let scope = 'workspace-a'; bridge.getSelectionScope = () => scope;
    centerSplitClose(); open();
    const old = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'focus', index: 0 })!;
    centerSplitSelectInPane(1, session('c')); expect(centerSplitCommitSnapLayout(old)).toBe(false);
    const geometry = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'focus', index: 0 })!;
    centerSplitSetRatio(.6); expect(centerSplitCommitSnapLayout(geometry)).toBe(false);
    const moved = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'focus', index: 0 })!;
    snap('wide', 1); expect(centerSplitCommitSnapLayout(moved)).toBe(false);
    const scoped = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'thirds', index: 0 })!;
    scope = 'workspace-b'; expect(centerSplitCommitSnapLayout(scoped)).toBe(false);
    scope = 'workspace-a'; snap('focus');
    const empty = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'thirds', index: 0 })!;
    centerSplitSelectInPane(2, session('d')); expect(centerSplitCommitSnapLayout(empty)).toBe(false);
  });
  it('initial closed scope refresh produces a usable candidate while an earlier scoped snapshot remains stale', () => {
    let scope: string | null = null; bridge.getSelectionScope = () => scope;
    const oldState = getCenterSplitState();
    const old = deriveCenterSplitSnapLayout(primary, oldState, 0, { layoutId: 'halves', index: 0 })!;
    scope = 'workspace-a';
    const nextState = getCenterSplitState(); expect(nextState.selectionScope).toBe('workspace-a');
    expect(oldState.selectionScope).toBeNull(); expect(centerSplitCommitSnapLayout(old)).toBe(false);
    snap('halves'); expect(getCenterSplitState().open).toBe(true);
  });
  it('wide initial ratio is 2/3 and later manual ratio uses legacy geometry without dropping its reversed order', () => {
    open(); snap('wide', 1); expect(getCenterSplitState().ratio).toBe(2 / 3);
    expect(getCenterSplitPaneCells(getCenterSplitState())[0].width).toBeCloseTo(1 / 3);
    centerSplitSetRatio(.6); expect(getCenterSplitState().layoutId).toBeUndefined();
    expect(getCenterSplitState().order).toEqual([1, 0]); expect(getCenterSplitPaneCells(getCenterSplitState())[0].width).toBe(.4);
  });
  it('primary promotion publishes all three bindings/order, maps focus, and waits to save until acknowledgement', async () => {
    three(); primary = { kind: 'empty' }; centerSplitReconcilePrimary(); saved = [];
    const delayed = deferSelection(); const candidate = snap('focus', 2, 2);
    expect(refs()).toEqual([{ kind: 'empty' }, session('b'), session('c')]);
    expect(getCenterSplitState().pendingLayout).toMatchObject({ panes: candidate.panes, order: candidate.order, pane2: { kind: 'empty' } });
    expect(saved).toEqual([]); centerSplitSetFocused(2); expect(getCenterSplitState().pendingLayout?.focused).toBe(1);
    await delayed.acknowledge();
    expect(primary).toEqual(session('b')); expect(refs()).toEqual([session('b'), session('c'), { kind: 'empty' }]);
    expect(getCenterSplitState().focused).toBe(1); expect(getCenterSplitState().pendingLayout).toBeNull();
    expect(saved).toEqual([{ dir: 'row', ratio: .5 }]);
  });
  it('closing the third pane continues the pending swap without losing either remaining session', async () => {
    three(); saved = []; const delayed = deferSelection(); centerSplitSwap(); centerSplitClosePane(2);
    await delayed.acknowledge(); expect(primary).toEqual(session('b')); expect(refs()).toEqual([session('b'), session('a')]);
    expect(getCenterSplitState().pendingLayout).toBeNull(); expect(saved).toEqual([{ dir: 'row', ratio: .5 }]);
  });
  it('a newer Snap order wins over an obsolete async swap while preserving all three contents', async () => {
    three(); saved = []; const delayed = deferSelection(); centerSplitSwap();
    const candidate = snap('thirds', 2, 2); await delayed.acknowledge();
    expect(primary).toEqual(session('a')); expect(refs()).toEqual([session('a'), session('b'), session('c')]);
    expect(getCenterSplitState()).toMatchObject({ layoutId: 'thirds', order: candidate.order, focused: 2, pendingLayout: null });
    expect(saved).toEqual([{ dir: 'row', ratio: .5 }]);
  });
  it('a third-side replacement or disappearance invalidates pending selection and cannot be restored by its late acknowledgement', async () => {
    three(); saved = []; const delayed = deferSelection(); centerSplitSwap();
    pruneCenterSplit(ref => ref.kind !== 'session' || ref.sessionId !== 'c');
    await delayed.acknowledge(); expect(primary).toEqual(session('a'));
    expect(refs()).toEqual([session('a'), session('b'), { kind: 'empty' }]); expect(saved).toEqual([]);
  });
  it.each([[0, 1], [1, 0]] as const)('held close-primary then close-original-secondary accumulates to C for ack order %j', async (first, second) => {
    three(); saved = []; const delayed = deferSelections(2);
    centerSplitClosePane(0); // A removed in desired [B,C], select B still held.
    centerSplitClosePane(1); // The still-mounted slot1 is B: remove it from [B,C], select C.
    expect(primary).toEqual(session('a'));
    expect(delayed.requests.map(request => request.ref)).toEqual([session('b'), session('c')]);
    expect(saved).toEqual([]);
    await delayed.acknowledge(first); await delayed.acknowledge(second);
    expect(primary).toEqual(session('c')); expect(refs()).toEqual([session('c')]);
    expect(getCenterSplitState()).toMatchObject({ open: false, secondary: { kind: 'empty' }, focused: 0, pendingLayout: null });
    expect(getCenterSplitState().tertiary).toBeUndefined(); expect(saved).toEqual([]);
  });
  it('closing removed confirmed slots is idempotent; an old final-C button follows single-pane no-close semantics', async () => {
    three(); const delayed = deferSelections(2); selected = [];
    centerSplitClosePane(0); centerSplitClosePane(0);
    expect(delayed.requests).toHaveLength(1);
    centerSplitClosePane(1); centerSplitClosePane(0); centerSplitClosePane(1); centerSplitClosePane(2);
    // Empty only clears the tool bridge, not App's active terminal. The final C stays selected.
    expect(delayed.requests.map(request => request.ref)).toEqual([session('b'), session('c')]);
    expect(selected).not.toContainEqual({ kind: 'empty' });
    await delayed.acknowledge(0); await delayed.acknowledge(1);
    expect(primary).toEqual(session('c')); expect(refs()).toEqual([session('c')]);
  });
  it.each([[0, 1], [1, 0]] as const)('dissolve the retained C supersedes a held close-A for ack order %j', async (first, second) => {
    three(); saved = []; const delayed = deferSelections(2);
    centerSplitClosePane(0); centerSplitDissolve(2);
    await delayed.acknowledge(first); await delayed.acknowledge(second);
    expect(primary).toEqual(session('c')); expect(refs()).toEqual([session('c')]); expect(saved).toEqual([]);
  });
  it('dissolve cannot resurrect a ref removed by a newer pending close intent', async () => {
    three(); const delayed = deferSelections(2);
    centerSplitClosePane(0); centerSplitDissolve(0);
    expect(delayed.requests.map(request => request.ref)).toEqual([session('b')]);
    centerSplitDissolve(1); // Keep B, already in the desired [B,C].
    expect(delayed.requests.map(request => request.ref)).toEqual([session('b'), session('b')]);
    await delayed.acknowledge(0); await delayed.acknowledge(1);
    expect(primary).toEqual(session('b')); expect(refs()).toEqual([session('b')]);
  });
  it('dissolve keeping an empty selector retains the existing tool-close/backing-session bridge behavior', () => {
    primary = utility('memory');
    bridge.selectRef = ref => { selected.push(ref); primary = ref.kind === 'empty' ? session('a') : ref; };
    centerSplitToggleShortcut(); centerSplitDissolve(1);
    expect(primary).toEqual(session('a')); expect(getCenterSplitState().open).toBe(false);
    expect(selected).toEqual([{ kind: 'empty' }]);
  });
  it.each(['two', 'three'] as const)('two swaps while the first primary selection is held restore %s refs, physical order and focus', async mode => {
    if (mode === 'three') three(); else { open(); snap('wide', 1); }
    const before = getCenterSplitState(), original = refs(), cells = getCenterSplitPaneCells(before);
    saved = []; const delayed = deferSelection();
    centerSplitSwap(); centerSplitSwap(); await delayed.acknowledge();
    expect(primary).toEqual(session('a')); expect(refs()).toEqual(original);
    expect(getCenterSplitState()).toMatchObject({ layoutId: before.layoutId, order: before.order, focused: before.focused, pendingLayout: null });
    expect(getCenterSplitPaneCells(getCenterSplitState())).toEqual(cells); expect(saved).toEqual([]);
  });
  it.each(['close', 'dissolve'] as const)('held %s to a retained full pane exposes a control-lock marker and ignores ratio/reset/flip', async action => {
    open(); saved = []; const before = getCenterSplitState(); const delayed = deferSelection();
    if (action === 'close') centerSplitClosePane(0); else centerSplitDissolve(1);
    expect(primary).toEqual(session('a'));
    expect(getCenterSplitState().pendingLayout).toMatchObject({ pane0: session('b'), pane1: { kind: 'empty' }, panes: [session('b')], focused: 0, order: [0] });
    centerSplitSetRatio(.6); centerSplitResetRatio(); centerSplitFlip();
    expect(getCenterSplitState()).toMatchObject({ dir: before.dir, ratio: before.ratio }); expect(saved).toEqual([]);
    await delayed.acknowledge();
    expect(primary).toEqual(session('b'));
    expect(getCenterSplitState()).toMatchObject({ open: false, dir: before.dir, ratio: before.ratio, pendingLayout: null });
    expect(saved).toEqual([]);
  });
  it('rejected closed selection removes its control-lock marker and keeps the confirmed pair/geometry', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitClosePane(0);
    expect(getCenterSplitState().pendingLayout?.panes).toEqual([session('b')]);
    await delayed.reject();
    expect(primary).toEqual(session('a')); expect(refs()).toEqual([session('a'), session('b')]);
    expect(getCenterSplitState()).toMatchObject({ open: true, dir: 'row', ratio: .65, pendingLayout: null }); expect(saved).toEqual([]);
  });
  it('explicit close-all supersedes and clears a held closed-selection marker without late revival', async () => {
    open(); const delayed = deferSelection(); centerSplitClosePane(0); centerSplitClose();
    expect(getCenterSplitState()).toMatchObject({ open: false, pendingLayout: null });
    await delayed.acknowledge(); expect(primary).toEqual(session('a'));
    expect(getCenterSplitState()).toMatchObject({ open: false, pendingLayout: null });
  });
  it('rail click on the retained full pane preserves the pending closed intent rather than reviving the old split', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitClosePane(0);
    expect(centerSplitTryFill(session('b'))).toBe(true);
    expect(selected).toEqual([session('b')]);
    expect(getCenterSplitState().pendingLayout?.panes).toEqual([session('b')]);
    await delayed.acknowledge();
    expect(primary).toEqual(session('b')); expect(refs()).toEqual([session('b')]);
    expect(getCenterSplitState()).toMatchObject({ open: false, pendingLayout: null }); expect(saved).toEqual([]);
  });
  it.each([
    ['d', 0, 1], ['d', 1, 0], ['scheduled', 0, 1], ['scheduled', 1, 0]
  ] as const)('normal rail navigation to %s after held close remains single for ack order %i,%i', async (id, first, second) => {
    open(); saved = []; const delayed = deferSelections(2); centerSplitClosePane(0);
    expect(centerSplitTryFill(session(id))).toBe(false);
    expect(getCenterSplitState()).toMatchObject({ open: false, pendingLayout: null });
    // A false return uses the real App main-navigation bridge, independently of the split transaction.
    void bridge.selectRef(session(id));
    await delayed.acknowledge(first); await delayed.acknowledge(second);
    expect(primary).toEqual(session(id)); expect(refs()).toEqual([session(id)]);
    expect(getCenterSplitState()).toMatchObject({ open: false, secondary: { kind: 'empty' }, pendingLayout: null });
    expect(saved).toEqual([]);
  });
  it.each([[0, 1], [1, 0]] as const)('removed-slot navigation is consumed while the retained pane can navigate singly for ack order %j', async (first, second) => {
    open(); saved = []; const delayed = deferSelections(2); centerSplitClosePane(0);
    expect(centerSplitSelectInPane(0, session('e'))).toBe(true);
    expect(delayed.requests.map(request => request.ref)).toEqual([session('b')]);
    expect(centerSplitSelectInPane(1, session('d'))).toBe(true);
    expect(delayed.requests.map(request => request.ref)).toEqual([session('b'), session('d')]);
    expect(getCenterSplitState().pendingLayout?.panes).toEqual([session('d')]);
    await delayed.acknowledge(first); await delayed.acknowledge(second);
    expect(primary).toEqual(session('d')); expect(refs()).toEqual([session('d')]);
    expect(getCenterSplitState()).toMatchObject({ open: false, pendingLayout: null }); expect(saved).toEqual([]);
  });
  it.each(['explicit', 'rail'] as const)('a %s navigation in retained C maps its old slot2 into pending two-pane [B,C]', async entry => {
    three(); saved = []; const delayed = deferSelections(2); centerSplitClosePane(0);
    if (entry === 'explicit') expect(centerSplitSelectInPane(2, session('d'))).toBe(true);
    else {
      centerSplitSetFocused(2); expect(centerSplitTryFill(session('d'))).toBe(true);
    }
    expect(getCenterSplitState().pendingLayout).toMatchObject({ pane0: session('b'), pane1: session('d') });
    await delayed.acknowledge(1); await delayed.acknowledge(0);
    expect(primary).toEqual(session('b')); expect(refs()).toEqual([session('b'), session('d')]);
    expect(getCenterSplitState()).toMatchObject({ open: true, tertiary: undefined, pendingLayout: null });
    expect(saved).toEqual([{ dir: 'col', ratio: .5 }]);
  });
  it.each([[0, 1], [1, 0]] as const)('native insertion after pending final C reopens only [C,D] for ack order %j', async (first, second) => {
    three(); saved = []; const delayed = deferSelections(2);
    centerSplitClosePane(0); centerSplitClosePane(1); centerSplitIncoming(session('d'), 'right');
    expect(primary).toEqual(session('c')); expect(refs()).toEqual([session('c'), session('d')]);
    await delayed.acknowledge(first); await delayed.acknowledge(second);
    expect(primary).toEqual(session('c')); expect(refs()).toEqual([session('c'), session('d')]);
    expect(getCenterSplitState()).toMatchObject({ open: true, tertiary: undefined, pendingLayout: null });
    expect(saved).toEqual([{ dir: 'row' }]);
  });
  it.each([[0, 1], [1, 0]] as const)('native replacement during held close-A uses only retained [B,C] for ack order %j', async (first, second) => {
    three(); saved = []; const delayed = deferSelections(2); centerSplitClosePane(0);
    centerSplitIncoming(session('d'), 'bottom');
    expect(getCenterSplitState().pendingLayout).toMatchObject({ pane0: session('b'), pane1: session('d') });
    await delayed.acknowledge(first); await delayed.acknowledge(second);
    expect(primary).toEqual(session('b')); expect(refs()).toEqual([session('b'), session('d')]);
    expect(getCenterSplitState()).toMatchObject({ open: true, tertiary: undefined, pendingLayout: null });
    expect(saved).toEqual([{ dir: 'col', ratio: .5 }]);
  });
  it.each([[0, 1], [1, 0]] as const)('docking an existing retained ref during held close-A reorders [B,C] for ack order %j', async (first, second) => {
    three(); saved = []; const delayed = deferSelections(2); centerSplitClosePane(0);
    centerSplitIncoming(session('b'), 'right');
    expect(getCenterSplitState().pendingLayout).toMatchObject({ pane0: session('c'), pane1: session('b'), dir: 'row' });
    await delayed.acknowledge(first); await delayed.acknowledge(second);
    expect(primary).toEqual(session('c')); expect(refs()).toEqual([session('c'), session('b')]);
    expect(getCenterSplitState()).toMatchObject({ open: true, tertiary: undefined, pendingLayout: null });
    expect(saved).toEqual([{ dir: 'row', ratio: .5 }]);
  });
  it('flip after held three-to-two close changes the requested pair geometry without resurrecting A', async () => {
    three(); saved = []; const delayed = deferSelection(); centerSplitClosePane(0); centerSplitFlip();
    expect(getCenterSplitState().pendingLayout).toMatchObject({ panes: [session('b'), session('c')], dir: 'row' });
    await delayed.acknowledge();
    expect(primary).toEqual(session('b')); expect(refs()).toEqual([session('b'), session('c')]);
    expect(getCenterSplitState()).toMatchObject({ dir: 'row', layoutId: undefined, tertiary: undefined, pendingLayout: null });
    expect(saved).toEqual([{ dir: 'row', ratio: .5 }]);
  });
  it('three-pane flip preserves the latest held swap references rather than discarding that intent', async () => {
    three(); saved = []; const delayed = deferSelections(2); centerSplitSwap(); centerSplitFlip();
    expect(getCenterSplitState().pendingLayout).toMatchObject({ panes: [session('b'), session('a'), session('c')], layoutId: 'thirds' });
    await delayed.acknowledge(1); await delayed.acknowledge(0);
    expect(primary).toEqual(session('b')); expect(refs()).toEqual([session('b'), session('a'), session('c')]);
    expect(getCenterSplitState()).toMatchObject({ layoutId: 'thirds', pendingLayout: null });
    expect(saved).toEqual([{ dir: 'row', ratio: .5 }]);
  });
  it('an absent confirmed third slot is invalid rather than treated as a removed-slot callback', () => {
    open(); expect(centerSplitSelectInPane(2, session('d'))).toBe(false);
    expect(refs()).toEqual([session('a'), session('b')]); expect(selected).toEqual([]);
  });
});
afterEach(() => __resetCenterSplitForTest());

describe('native sidebar Snap controller', () => {
  const refs = () => getCenterSplitPaneRefs(primary, getCenterSplitState());
  const incoming = (ref: SplitPaneRef, layoutId: CenterSnapLayoutId = 'focus', index = 2) =>
    deriveCenterSplitIncomingSnapLayout(primary, getCenterSplitState(), ref, { layoutId, index });
  it('commits a sidebar source to the chosen Snap cell without changing the current primary', () => {
    const candidate = incoming(utility('memory'), 'wide', 0)!;
    expect(centerSplitCommitIncomingSnapLayout(candidate)).toBe(true);
    expect(refs()).toEqual([session('a'), utility('memory')]); expect(primary).toEqual(session('a'));
    expect(getCenterSplitState()).toMatchObject({ layoutId: 'wide', order: candidate.order, focused: 1, ratio: 2 / 3 });
    expect(candidate.order[1]).toBe(0); expect(selected).toEqual([]); expect(saved).toEqual([{ dir: 'row', ratio: 2 / 3 }]);
  });
  it('adds a third sidebar content instead of replacing either existing pane', () => {
    open(); saved = [];
    expect(incoming(session('c'), 'halves', 0)).toBeNull();
    const candidate = incoming(session('c'))!; expect(centerSplitCommitIncomingSnapLayout(candidate)).toBe(true);
    expect(refs()).toEqual([session('a'), session('b'), session('c')]);
    expect(getCenterSplitState()).toMatchObject({ layoutId: 'focus', focused: 2, order: candidate.order });
    expect(selected).toEqual([]); expect(saved).toEqual([{ dir: 'row', ratio: .5 }]);
    const before = getCenterSplitState(); expect(incoming(session('d'), 'thirds', 0)).toBeNull();
    expect(getCenterSplitState()).toBe(before);
  });
  it('reorders an already displayed sidebar source exactly once', () => {
    open(); const third = incoming(session('c'))!; centerSplitCommitIncomingSnapLayout(third);
    const candidate = incoming(session('b'), 'thirds', 2)!; expect(centerSplitCommitIncomingSnapLayout(candidate)).toBe(true);
    expect(refs()).toEqual([session('a'), session('b'), session('c')]);
    expect(getCenterSplitState()).toMatchObject({ layoutId: 'thirds', focused: 1 }); expect(candidate.order[1]).toBe(2);
    expect(selected).toEqual([]);
  });
  it('empty-primary promotion waits for App acknowledgement before adding the source or saving preferences', async () => {
    open(); primary = { kind: 'empty' }; centerSplitReconcilePrimary(); saved = [];
    const delayed = deferSelection(), candidate = incoming(session('c'))!;
    expect(centerSplitCommitIncomingSnapLayout(candidate)).toBe(true);
    expect(refs()).toEqual([{ kind: 'empty' }, session('b')]);
    expect(getCenterSplitState().pendingLayout).toMatchObject({ panes: [session('b'), session('c'), { kind: 'empty' }], order: candidate.order });
    expect(saved).toEqual([]);
    await delayed.acknowledge();
    expect(primary).toEqual(session('b')); expect(refs()).toEqual(candidate.panes);
    expect(getCenterSplitState()).toMatchObject({ pendingLayout: null, focused: 1, layoutId: 'focus' });
    expect(saved).toEqual([{ dir: 'row', ratio: .5 }]);
  });
  it('an empty workspace can snap its first source with empty assist slots', () => {
    primary = { kind: 'empty' }; const candidate = incoming(session('c'))!;
    expect(centerSplitCommitIncomingSnapLayout(candidate)).toBe(true);
    expect(primary).toEqual(session('c')); expect(refs()).toEqual([session('c'), { kind: 'empty' }, { kind: 'empty' }]);
    expect(getCenterSplitState().order).toEqual(candidate.order);
  });
  it('rejects stale bindings, changed layout/order/ratio, closing and workspace changes', () => {
    let scope = 'workspace-a'; bridge.getSelectionScope = () => scope;
    open(); const replaced = incoming(session('c'))!;
    centerSplitSelectInPane(1, session('d')); expect(centerSplitCommitIncomingSnapLayout(replaced)).toBe(false);
    const ratio = incoming(session('c'))!; centerSplitSetRatio(.6); expect(centerSplitCommitIncomingSnapLayout(ratio)).toBe(false);
    const reordered = incoming(session('c'))!;
    const snap = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'wide', index: 1 })!;
    centerSplitCommitSnapLayout(snap); expect(centerSplitCommitIncomingSnapLayout(reordered)).toBe(false);
    const scoped = incoming(session('c'))!; scope = 'workspace-b'; expect(centerSplitCommitIncomingSnapLayout(scoped)).toBe(false);
    scope = 'workspace-a'; const closed = incoming(session('c'))!; centerSplitClose(); expect(centerSplitCommitIncomingSnapLayout(closed)).toBe(false);
  });
  it('rejects unsupported/lost sources and candidates that would drop or duplicate content', () => {
    expect(centerSplitCommitIncomingSnapLayout(incoming(session('scheduled'))!)).toBe(false);
    const removed = incoming(utility('nav:gone'))!; bridge.canSelectRef = ref => ref.kind !== 'utility' || ref.sel !== 'nav:gone';
    expect(centerSplitCommitIncomingSnapLayout(removed)).toBe(false);
    open(); const candidate = incoming(session('c'))!;
    const dropped = { ...candidate, panes: [session('a'), { kind: 'empty' } as SplitPaneRef, session('c')], pane1: { kind: 'empty' } as SplitPaneRef };
    expect(centerSplitCommitIncomingSnapLayout(dropped)).toBe(false);
    const duplicate = { ...candidate, panes: [session('a'), session('c'), session('c')], pane1: session('c') };
    expect(centerSplitCommitIncomingSnapLayout(duplicate)).toBe(false);
    expect(refs()).toEqual([session('a'), session('b')]);
  });
});

function open(secondary = session('b')): void { centerSplitIncoming(secondary, 'right'); }
function deferSelection(): { acknowledge: () => Promise<void>; reject: () => Promise<void> } {
  let selectedRef: SplitPaneRef | null = null;
  let resolve!: () => void, reject!: (error: Error) => void;
  bridge.selectRef = vi.fn(ref => {
    selected.push(ref);
    // The obsolete request is deferred; a corrective request uses the normal synchronous bridge.
    if (selectedRef) { primary = ref; return; }
    selectedRef = ref;
    return new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  });
  return {
    acknowledge: async () => {
      if (!selectedRef) throw new Error('no selection requested');
      primary = selectedRef; centerSplitReconcilePrimary(); resolve(); await Promise.resolve();
    },
    reject: async () => { reject(new Error('selection rejected')); await Promise.resolve(); }
  };
}
function deferSelections(count: number) {
  const requests: Array<{ ref: SplitPaneRef; resolve: () => void }> = [];
  bridge.selectRef = vi.fn(ref => {
    selected.push(ref);
    if (requests.length >= count) { primary = ref; return; }
    return new Promise<void>(resolve => { requests.push({ ref, resolve }); });
  });
  return {
    requests,
    acknowledge: async (index: number, reflect = true) => {
      const request = requests[index];
      if (reflect) { primary = request.ref; centerSplitReconcilePrimary(); }
      request.resolve(); await Promise.resolve();
    }
  };
}

describe('renderer split reference uniqueness', () => {
  it.each(['left', 'right', 'top', 'bottom'] as SplitSide[])('single session self insertion at %s does not split', side => {
    centerSplitIncoming(session('a'), side);
    expect(getCenterSplitState().open).toBe(false); expect(selected).toEqual([]); expect(saved).toEqual([]);
  });
  it('single utility self insertion also preserves one instance', () => {
    primary = utility('memory'); centerSplitIncoming(utility('memory'), 'left');
    expect(getCenterSplitState().open).toBe(false); expect(selected).toEqual([]);
  });
  it.each([session('b'), utility('memory')])('primary-focused rail navigation to existing secondary focuses it: %j', ref => {
    open(ref); centerSplitSetFocused(0);
    expect(centerSplitTryFill({ ...ref })).toBe(true);
    expect(primary).toEqual(session('a')); expect(getCenterSplitState().secondary).toEqual(ref);
    expect(getCenterSplitState().focused).toBe(1); expect(selected).toEqual([]);
  });
  it('secondary-focused click of primary focuses primary without replacing secondary', () => {
    open(); expect(centerSplitTryFill(session('a'))).toBe(true);
    expect(getCenterSplitState().focused).toBe(0); expect(getCenterSplitState().secondary).toEqual(session('b'));
  });
  it('new primary rail choice remains App navigation; a new secondary choice fills only secondary', () => {
    open(); centerSplitSetFocused(0); expect(centerSplitTryFill(session('c'))).toBe(false);
    centerSplitSetFocused(1); expect(centerSplitTryFill(session('c'))).toBe(true);
    expect(primary).toEqual(session('a')); expect(getCenterSplitState().secondary).toEqual(session('c'));
  });
  it('folder navigation is bound to its explicit slot and does not duplicate existing content', () => {
    open(utility('nav:folder'));
    expect(centerSplitSelectInPane(0, utility('nav:child'))).toBe(true);
    expect(primary).toEqual(utility('nav:child')); expect(getCenterSplitState().secondary).toEqual(utility('nav:folder'));
    expect(centerSplitSelectInPane(0, utility('nav:folder'))).toBe(true);
    expect(primary).toEqual(utility('nav:child')); expect(getCenterSplitState().focused).toBe(1);
  });
  it('external primary fallback to secondary drops the duplicate reference and retains an empty selector', () => {
    open(); primary = session('b'); centerSplitReconcilePrimary();
    expect(getCenterSplitState()).toMatchObject({ open: true, secondary: { kind: 'empty' }, focused: 0 });
  });
  it('prunes lost sessions and removed navigation nodes to empty without dismantling layout', () => {
    open(utility('nav:removed')); pruneCenterSplit(ref => ref.kind !== 'utility');
    expect(getCenterSplitState()).toMatchObject({ open: true, secondary: { kind: 'empty' } });
    centerSplitIncoming(session('b'), 'right'); pruneCenterSplit(ref => ref.kind !== 'session' || ref.sessionId !== 'b');
    expect(getCenterSplitState().secondary).toEqual({ kind: 'empty' });
  });
  it('unsupported session shortcuts/incoming are blocked and external unsupported primary dissolves', () => {
    primary = session('scheduled'); centerSplitToggleShortcut(); centerSplitIncoming(session('b'), 'right');
    expect(getCenterSplitState().open).toBe(false);
    primary = session('a'); open(); centerSplitIncoming(session('scheduled'), 'right');
    expect(getCenterSplitState().secondary).toEqual(session('b'));
    primary = { kind: 'empty' }; centerSplitReconcilePrimary(undefined, true);
    expect(getCenterSplitState().open).toBe(false);
  });
});

describe('atomic edge candidates and primary acknowledgement', () => {
  it.each([session('b'), utility('memory')])('incoming existing secondary to top swaps content and updates direction/focus/preferences together: %j', ref => {
    open(ref); centerSplitIncoming({ ...ref }, 'top');
    expect(primary).toEqual(ref);
    expect(getCenterSplitState()).toMatchObject({ secondary: session('a'), dir: 'col', ratio: 0.5, focused: 0 });
    expect(saved.at(-1)).toEqual({ dir: 'col', ratio: 0.5 });
  });
  it.each([0, 1] as const)('both sources commit exactly the displayed four-edge candidate: %i', source => {
    open(utility('memory'));
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const candidate = deriveCenterSplitDockLayout(primary, getCenterSplitState(), source, side);
      expect(candidate).not.toBeNull(); expect(centerSplitCommitDockLayout(candidate!)).toBe(true);
      expect(primary).toEqual(candidate!.pane0);
      expect(getCenterSplitState()).toMatchObject({ secondary: candidate!.pane1, dir: candidate!.dir,
        ratio: candidate!.ratio, focused: candidate!.focused, pendingLayout: null });
      expect(saved.at(-1)).toEqual({ dir: candidate!.dir, ratio: candidate!.ratio });
    }
  });
  it('does not commit a stale candidate after either content was replaced', () => {
    open(); const candidate = deriveCenterSplitDockLayout(primary, getCenterSplitState(), 0, 'right')!;
    centerSplitIncoming(session('c'), 'right'); expect(centerSplitCommitDockLayout(candidate)).toBe(false);
    expect(primary).toEqual(session('a')); expect(getCenterSplitState().secondary).toEqual(session('c'));
  });
  it('empty counterpart cannot create an impossible empty-primary docking candidate', () => {
    centerSplitToggleShortcut(); expect(centerSplitDockPane(0, 'right')).toBe(false);
    expect(primary).toEqual(session('a')); expect(getCenterSplitState().secondary).toEqual({ kind: 'empty' });
  });
  it('async primary change preserves confirmed refs and exposes final geometry until one atomic acknowledgement', async () => {
    open(); saved = []; const delayed = deferSelection();
    const candidate = deriveCenterSplitDockLayout(primary, getCenterSplitState(), 0, 'bottom')!;
    expect(centerSplitCommitDockLayout(candidate)).toBe(true);
    expect(primary).toEqual(session('a'));
    expect(getCenterSplitState()).toMatchObject({ secondary: session('b'), dir: 'row', ratio: 0.65, pendingLayout: candidate });
    expect(saved).toEqual([]);
    await delayed.acknowledge();
    expect(primary).toEqual(session('b'));
    expect(getCenterSplitState()).toMatchObject({ secondary: session('a'), dir: 'col', ratio: 0.5, focused: 1, pendingLayout: null });
    expect(saved).toEqual([{ dir: 'col', ratio: 0.5 }]);
  });
  it('temporary empty/scheduled primary while closing a utility layer does not dissolve its pending terminal selection', async () => {
    primary = utility('memory'); open(); const delayed = deferSelection();
    centerSplitDockPane(1, 'top'); primary = { kind: 'empty' };
    centerSplitReconcilePrimary(undefined, true);
    expect(getCenterSplitState().open).toBe(true); expect(getCenterSplitState().pendingLayout).toBeTruthy();
    await delayed.acknowledge();
    expect(primary).toEqual(session('b')); expect(getCenterSplitState().secondary).toEqual(utility('memory'));
  });
  it('temporary underlying terminal while closing a utility layer also preserves the pending pair', async () => {
    primary = utility('memory'); open(); const delayed = deferSelection();
    centerSplitDockPane(1, 'top'); primary = session('a'); centerSplitReconcilePrimary();
    expect(getCenterSplitState().pendingLayout).toMatchObject({ pane0: session('b'), pane1: utility('memory') });
    await delayed.acknowledge();
    expect(primary).toEqual(session('b')); expect(getCenterSplitState().secondary).toEqual(utility('memory'));
  });
  it('rejected primary selection clears presentation candidate without applying geometry or preferences', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    await delayed.reject();
    expect(primary).toEqual(session('a'));
    expect(getCenterSplitState()).toMatchObject({ secondary: session('b'), dir: 'row', ratio: 0.65, pendingLayout: null });
    expect(saved).toEqual([]);
  });
  it('closing a split prevents a late acknowledgement from reopening it', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right'); centerSplitClose();
    await delayed.acknowledge();
    expect(getCenterSplitState()).toMatchObject({ open: false, secondary: { kind: 'empty' }, pendingLayout: null });
    expect(primary).toEqual(session('a'));
    expect(saved).toEqual([]);
  });
  it('lost source invalidates pending layout before a late selection acknowledgement', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    pruneCenterSplit(ref => ref.kind !== 'session' || ref.sessionId !== 'b');
    expect(getCenterSplitState().pendingLayout).toBeNull(); expect(getCenterSplitState().secondary).toEqual({ kind: 'empty' });
    await delayed.acknowledge(); expect(primary).toEqual(session('a'));
    expect(getCenterSplitState().secondary).toEqual({ kind: 'empty' }); expect(saved).toEqual([]);
  });
  it('ratio changes during pending selection update the transaction rather than leaving a duplicate pair', async () => {
    open(); const delayed = deferSelection(); centerSplitDockPane(0, 'right'); centerSplitSetRatio(0.6);
    expect(getCenterSplitState().pendingLayout?.ratio).toBe(0.6);
    await delayed.acknowledge();
    expect(primary).toEqual(session('b')); expect(getCenterSplitState().secondary).toEqual(session('a'));
    expect(getCenterSplitState().ratio).toBe(0.6); expect(saved.at(-1)).toEqual({ dir: 'row', ratio: 0.6 });
  });
  it.each([
    ['close secondary', () => centerSplitClosePane(1), 'a'],
    ['close primary', () => centerSplitClosePane(0), 'b'],
    ['dissolve keep primary', () => centerSplitDissolve(0), 'a'],
    ['dissolve keep secondary', () => centerSplitDissolve(1), 'b'],
    ['close all', centerSplitClose, 'a']
  ] as const)('%s wins over an older primary acknowledgement', async (_name, close, kept) => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    close(); await delayed.acknowledge();
    expect(primary).toEqual(session(kept));
    expect(getCenterSplitState()).toMatchObject({ open: false, secondary: { kind: 'empty' }, pendingLayout: null });
    expect(saved).toEqual([]);
  });
  it.each([[1, 0], [0, 1]] as const)('latest layout wins for acknowledgement order %j', async (first, second) => {
    open(); saved = []; const delayed = deferSelections(2);
    centerSplitDockPane(0, 'right'); // Older [B,A] row candidate.
    centerSplitIncoming(session('c'), 'top'); // The top candidate B is replaced: latest [C,A], keeping A.
    await delayed.acknowledge(first); await delayed.acknowledge(second);
    expect(primary).toEqual(session('c'));
    expect(getCenterSplitState()).toMatchObject({ open: true, secondary: session('a'), dir: 'col',
      ratio: .5, focused: 0, pendingLayout: null });
    expect(saved).toEqual([{ dir: 'col', ratio: .5 }]);
  });
  it('a new main rail selection supersedes the pending layout and remains selected after its obsolete acknowledgement', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    centerSplitSetFocused(0); // Actual A is visually candidate slot1.
    expect(centerSplitTryFill(session('c'))).toBe(false);
    primary = session('c'); centerSplitReconcilePrimary();
    await delayed.acknowledge();
    expect(primary).toEqual(session('c')); expect(getCenterSplitState().secondary).toEqual(session('b'));
    expect(getCenterSplitState().pendingLayout).toBeNull(); expect(saved).toEqual([]);
  });
  it('external navigation to a different actual primary supersedes an in-flight selection', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    primary = session('c'); centerSplitReconcilePrimary();
    expect(getCenterSplitState().pendingLayout).toBeNull();
    await delayed.acknowledge();
    expect(primary).toEqual(session('c')); expect(saved).toEqual([]);
  });
  it('a real scheduled primary supersedes a pending terminal layout and is restored after the obsolete acknowledgement', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    primary = session('scheduled'); centerSplitReconcilePrimary(undefined, true);
    expect(getCenterSplitState().open).toBe(false);
    await delayed.acknowledge();
    expect(primary).toEqual(session('scheduled')); expect(saved).toEqual([]);
    expect(getCenterSplitState()).toMatchObject({ open: false, secondary: { kind: 'empty' }, pendingLayout: null });
  });
  it('main rail navigation to scheduled wins even if the obsolete terminal acknowledgement arrives first', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    expect(centerSplitTryFill(session('scheduled'))).toBe(false);
    await delayed.acknowledge();
    expect(primary).toEqual(session('scheduled')); expect(getCenterSplitState().open).toBe(false); expect(saved).toEqual([]);
  });
  it.each(['deleted', 'archived'])('late selection correction never resurrects a %s kept reference', async () => {
    open(); saved = []; const delayed = deferSelection(); centerSplitDockPane(0, 'right'); centerSplitClosePane(1);
    bridge.canSelectRef = ref => ref.kind !== 'session' || ref.sessionId !== 'a';
    selected = []; await delayed.acknowledge();
    expect(selected).not.toContainEqual(session('a'));
    expect(getCenterSplitState().open).toBe(false); expect(saved).toEqual([]);
  });
  it('an obsolete promise completion does not navigate when the user is already on a different actual primary', async () => {
    open(); const delayed = deferSelections(1); centerSplitDockPane(0, 'right');
    primary = session('c'); centerSplitReconcilePrimary(); selected = [];
    await delayed.acknowledge(0, false);
    expect(primary).toEqual(session('c')); expect(selected).toEqual([]);
  });
  it('normal navigation after close may explicitly select the obsolete target without being corrected back', async () => {
    open(); const delayed = deferSelections(1); centerSplitDockPane(0, 'right'); centerSplitClose();
    await delayed.acknowledge(0, false);
    expect(centerSplitTryFill(session('b'))).toBe(false);
    primary = session('b'); selected = []; centerSplitReconcilePrimary();
    expect(primary).toEqual(session('b')); expect(selected).toEqual([]); expect(getCenterSplitState().open).toBe(false);
  });
  it('workspace changes prevent an old request from issuing corrective navigation in the new scope', async () => {
    let scope = 'workspace-a'; bridge.getSelectionScope = () => scope;
    open(); const delayed = deferSelections(1); centerSplitDockPane(0, 'right');
    scope = 'workspace-b'; primary = session('c'); centerSplitClose(); selected = [];
    await delayed.acknowledge(0, false);
    expect(primary).toEqual(session('c')); expect(selected).toEqual([]);
    expect(getCenterSplitState().open).toBe(false);
  });
  it('a utility close retains that utility after the obsolete terminal selection acknowledges', async () => {
    primary = utility('memory'); open(); saved = []; const delayed = deferSelection();
    centerSplitDockPane(1, 'top'); centerSplitClosePane(1); await delayed.acknowledge();
    expect(primary).toEqual(utility('memory')); expect(getCenterSplitState().open).toBe(false); expect(saved).toEqual([]);
  });
  it('external terminal navigation from a utility is not confused with its original backing terminal', async () => {
    primary = utility('memory'); open(); const delayed = deferSelection(); centerSplitDockPane(1, 'top');
    primary = session('c'); centerSplitReconcilePrimary(); await delayed.acknowledge();
    expect(primary).toEqual(session('c')); expect(getCenterSplitState().pendingLayout).toBeNull();
  });
  it.each([0, 1] as const)('pending focus follows confirmed content slot%s through the candidate exchange', async slot => {
    open(); const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    centerSplitSetFocused(slot);
    expect(getCenterSplitState().pendingLayout?.focused).toBe(slot === 0 ? 1 : 0);
    await delayed.acknowledge();
    expect(getCenterSplitState().focused).toBe(slot === 0 ? 1 : 0);
    expect(primary).toEqual(session('b')); expect(getCenterSplitState().secondary).toEqual(session('a'));
  });
  it('new rail content uses pending focus identity rather than the confirmed focus number', async () => {
    open(); const delayed = deferSelection(); centerSplitDockPane(0, 'right');
    centerSplitSetFocused(1); // Actual B, candidate slot0; original focused was also1.
    expect(centerSplitTryFill(session('c'))).toBe(true);
    expect(primary).toEqual(session('c')); expect(getCenterSplitState().secondary).toEqual(session('a'));
    await delayed.acknowledge();
    expect(primary).toEqual(session('c')); expect(getCenterSplitState().secondary).toEqual(session('a'));
  });
});
