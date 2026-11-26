/** Central split geometry/secondary store. App remains the sole source of pane0 selection. */
import { useSyncExternalStore } from 'react';
import type { LeftNavigationSplit } from '../../shared/leftNavigation';
import {
  CENTER_SNAP_LAYOUTS, clampRatio, deriveCenterSplitDockLayout, deriveCenterSplitSnapLayout,
  getCenterSplitPaneCells, getCenterSplitPaneRefs, getCenterSplitRatios, getCenterSplitDividers, samePaneRef, sideToSlot,
  type CenterPaneSlot, type CenterSnapLayoutId, type CenterSplitDockLayout, type CenterSplitIncomingSnapLayout,
  type CenterSplitPresentationLayout, type CenterSplitSnapLayout, type SplitDir, type SplitPaneRef, type SplitSide
} from '../../shared/centerSplit';

export interface CenterSplitState {
  open: boolean;
  secondary: SplitPaneRef;
  tertiary?: SplitPaneRef;
  layoutId?: CenterSnapLayoutId;
  order?: number[];
  selectionScope?: string | null;
  dir: SplitDir;
  ratio: number;
  ratios?: [number, number];
  focused: CenterPaneSlot;
  /** Requested geometry while App confirms primary selection, never a second primary authority. */
  pendingLayout?: CenterSplitPresentationLayout | null;
}
export interface CenterSplitBridge {
  getPrimary: () => SplitPaneRef;
  selectRef: (ref: SplitPaneRef, options?: { deferReveal?: boolean }) => void | Promise<void>;
  getPrefs: () => { dir: SplitDir; ratio: number };
  savePrefs: (prefs: { dir?: SplitDir; ratio?: number }) => void;
  /** Empty selectors are supported; App filters unsupported sessions/utility references. */
  supportsRef?: (ref: SplitPaneRef) => boolean;
  /** Navigation can restore existing scheduled selections without making them splittable. */
  canSelectRef?: (ref: SplitPaneRef) => boolean;
  /** Late selections from another workspace must never trigger a corrective navigation. */
  getSelectionScope?: () => string | null;
  /** A utility can close before its selected session is reflected by the App render. */
  getUnderlyingPrimary?: () => SplitPaneRef;
}
const initial: CenterSplitState = {
  open: false, secondary: { kind: 'empty' }, dir: 'row', ratio: 0.5, focused: 0
};
let state: CenterSplitState = initial;
const listeners = new Set<() => void>();
let bridge: CenterSplitBridge | null = null;
type PrefsPatch = { dir?: SplitDir; ratio?: number };
interface PrimaryIntent {
  sequence: number;
  primary: SplitPaneRef;
  bridge: CenterSplitBridge;
  scope: string | null | undefined;
  externalFrom?: SplitPaneRef;
}
interface PendingSelection {
  from: SplitPaneRef;
  underlying?: SplitPaneRef;
  primary: SplitPaneRef;
  next: CenterSplitState;
  prefs?: PrefsPatch;
  settled: boolean;
  observed: boolean;
  intent: PrimaryIntent;
  complete?: (result: 'applied' | 'cancelled' | 'failed') => void;
  canCommit?: () => boolean;
}
let pendingSelection: PendingSelection | null = null;
let intentSequence = 0;
let latestIntent: PrimaryIntent | null = null;
const selectionRequests = new Set<PendingSelection>();

function set(next: CenterSplitState): void {
  state = { ...next, selectionScope: bridge?.getSelectionScope?.() };
  for (const listener of listeners) listener();
}
function supports(ref: SplitPaneRef): boolean {
  return bridge?.supportsRef?.(ref) ?? true;
}
function paneRefs(current = state, primary = bridge?.getPrimary() ?? { kind: 'empty' } as SplitPaneRef): SplitPaneRef[] {
  return getCenterSplitPaneRefs(primary, current);
}
function presentationRefs(layout: CenterSplitPresentationLayout): SplitPaneRef[] {
  return layout.panes ?? (layout.pane2 ? [layout.pane0, layout.pane1, layout.pane2] : [layout.pane0, layout.pane1]);
}
function desiredLayout(): { current: CenterSplitState; primary: SplitPaneRef } {
  const request = pendingSelection;
  return request && request.intent === latestIntent && isCurrentIntent(request.intent)
    ? { current: request.next, primary: request.primary }
    : { current: state, primary: bridge?.getPrimary() ?? { kind: 'empty' } };
}
/** Buttons retain their confirmed DOM slot; map its content into the latest requested layout. */
function desiredPaneAction(slot: CenterPaneSlot): { current: CenterSplitState; primary: SplitPaneRef; slot: CenterPaneSlot } | null {
  const ref = paneRefs()[slot];
  if (!ref) return null;
  const desired = desiredLayout(), refs = paneRefs(desired.current, desired.primary);
  const mapped = ref.kind === 'empty'
    ? refs[slot]?.kind === 'empty' ? slot : refs.findIndex(other => other.kind === 'empty')
    : refs.findIndex(other => samePaneRef(ref, other));
  return mapped < 0 ? null : { ...desired, slot: mapped as CenterPaneSlot };
}
function focusDesiredSlot(slot: CenterPaneSlot): void {
  const desired = desiredLayout(), ref = paneRefs(desired.current, desired.primary)[slot];
  if (!ref) return;
  const actual = paneRefs().findIndex(other => samePaneRef(ref, other));
  if (actual >= 0) { centerSplitSetFocused(actual as CenterPaneSlot); return; }
  if (pendingSelection && state.pendingLayout) {
    pendingSelection.next = { ...pendingSelection.next, focused: slot };
    set({ ...state, pendingLayout: { ...state.pendingLayout, focused: slot } });
  }
}
function extraRef(current: CenterSplitState, slot: CenterPaneSlot, ref: SplitPaneRef): CenterSplitState {
  return slot === 1 ? { ...current, secondary: ref } : slot === 2 ? { ...current, tertiary: ref } : current;
}
function clearDuplicates(primary: SplitPaneRef): void {
  if (!state.open) return;
  const refs = paneRefs(state, primary), seen: SplitPaneRef[] = [];
  let next = state;
  refs.forEach((ref, index) => {
    if (ref.kind === 'empty') return;
    if (seen.some(other => samePaneRef(other, ref)) && index > 0) next = extraRef(next, index as CenterPaneSlot, { kind: 'empty' });
    else seen.push(ref);
  });
  if (next !== state) set({ ...next, focused: 0 });
}
function physicalOrder(current = state): number[] {
  const count = getCenterSplitPaneCells(current).length;
  return current.order?.length === count && new Set(current.order).size === count && current.order.every(index => Number.isInteger(index) && index >= 0 && index < count)
    ? [...current.order] : Array.from({ length: count }, (_, index) => index);
}
function sideSlot(side: SplitSide, current = state): CenterPaneSlot {
  const cells = getCenterSplitPaneCells(current), positive = side === 'right' || side === 'bottom';
  const axis = side === 'left' || side === 'right' ? 'x' : 'y';
  const extent = axis === 'x' ? 'width' : 'height';
  const indices = cells.map((cell, index) => ({ index, value: cell[axis] + cell[extent] / 2 }));
  indices.sort((a, b) => positive ? b.value - a.value || b.index - a.index : a.value - b.value || a.index - b.index);
  return indices[0].index as CenterPaneSlot;
}
function isCurrentIntent(intent: PrimaryIntent): boolean {
  return bridge === intent.bridge && bridge.getSelectionScope?.() === intent.scope;
}
function recordIntent(primary: SplitPaneRef, externalFrom?: SplitPaneRef): PrimaryIntent | null {
  if (!bridge) return null;
  return latestIntent = { sequence: ++intentSequence, primary, bridge,
    scope: bridge.getSelectionScope?.(), externalFrom };
}
function pruneSelectionRequests(): void {
  const primary = bridge?.getPrimary();
  for (const request of selectionRequests) {
    if (!isCurrentIntent(request.intent) || (request.settled && request.observed &&
        (!primary || !samePaneRef(primary, request.primary) ||
          (latestIntent && samePaneRef(latestIntent.primary, request.primary))))) selectionRequests.delete(request);
  }
}
function discardPending(result: 'cancelled' | 'failed' = 'cancelled'): void {
  const complete = pendingSelection?.complete;
  pendingSelection = null;
  if (state.pendingLayout) set({ ...state, pendingLayout: null });
  complete?.(result);
}
function applyConfirmed(next: CenterSplitState, prefs?: PrefsPatch): void {
  const complete = pendingSelection?.complete;
  pendingSelection = null;
  set({ ...next, pendingLayout: null });
  if (prefs) bridge?.savePrefs(prefs);
  complete?.('applied');
}

/** Publish secondary/geometry/preferences together only after App acknowledges primary selection. */
function selectAndApply(primary: SplitPaneRef, next: CenterSplitState, prefs?: PrefsPatch, reuseIntent?: PrimaryIntent, complete?: (result: 'applied' | 'cancelled' | 'failed') => void, canCommit?: () => boolean, deferReveal = !!canCommit): void {
  if (!bridge) return;
  const currentBridge = bridge;
  const intent = reuseIntent ?? recordIntent(primary)!;
  discardPending();
  const from = currentBridge.getPrimary();
  if (samePaneRef(from, primary)) {
    if (canCommit && !canCommit()) { complete?.('cancelled'); return; }
    applyConfirmed(next, prefs); complete?.('applied'); return;
  }
  const request: PendingSelection = { from, underlying: currentBridge.getUnderlyingPrimary?.(), primary,
    next, prefs, intent, settled: false, observed: false, complete, canCommit };
  selectionRequests.add(request);
  pendingSelection = request;
  if (next.open) {
    set({ ...state, pendingLayout: { pane0: primary, pane1: next.secondary,
      dir: next.dir, ratio: next.ratio, ratios: next.ratios, focused: next.focused,
      ...(next.tertiary ? { pane2: next.tertiary } : {}),
      ...(next.layoutId || next.order ? { layoutId: next.layoutId, order: next.order, panes: paneRefs(next, primary) } : {}) } });
  } else {
    // Lock controls while App selects the retained full-width content. This is an
    // acknowledgement marker, not another authority for the current primary.
    set({ ...state, pendingLayout: { pane0: primary, pane1: { kind: 'empty' },
      dir: next.dir, ratio: next.ratio, focused: 0, panes: [primary], order: [0] } });
  }
  try {
    const result = currentBridge.selectRef(primary, deferReveal ? { deferReveal: true } : undefined);
    if (pendingSelection === request && samePaneRef(currentBridge.getPrimary(), primary)) {
      request.observed = true;
      if (request.canCommit && !request.canCommit()) cancelGuardedSelection(request);
      else applyConfirmed(request.next, request.prefs);
    }
    if (result) {
      void result.then(() => {
        request.settled = true;
        if (isCurrentIntent(request.intent)) {
          if (latestIntent !== request.intent) restoreLatestIntent(request);
          centerSplitReconcilePrimary();
        }
        pruneSelectionRequests();
      }, () => {
        request.settled = true; selectionRequests.delete(request);
        // App reports selection failure; preserve the last confirmed pair and geometry.
        if (bridge === currentBridge && pendingSelection === request) {
          discardPending('failed'); recordIntent(currentBridge.getPrimary());
        }
      });
    } else {
      request.settled = true;
      pruneSelectionRequests();
    }
  } catch (error) {
    selectionRequests.delete(request);
    if (pendingSelection === request) discardPending('failed');
    if (latestIntent === intent) recordIntent(currentBridge.getPrimary());
    throw error;
  }
}

function cancelGuardedSelection(request: PendingSelection): void {
  if (latestIntent === request.intent) recordIntent(request.from);
  discardPending();
  restoreLatestIntent(request);
}

/** IPC cannot be cancelled. Correct only our obsolete target, never a different current selection. */
function restoreLatestIntent(obsolete: PendingSelection): void {
  const intent = latestIntent;
  if (!bridge || !intent || !isCurrentIntent(obsolete.intent) || !isCurrentIntent(intent) ||
      samePaneRef(intent.primary, obsolete.primary) || !samePaneRef(bridge.getPrimary(), obsolete.primary)) return;
  if (!(bridge.canSelectRef?.(intent.primary) ?? supports(intent.primary))) {
    // A deleted/archived selection cannot be resurrected to undo an IPC response.
    recordIntent(bridge.getPrimary()); return;
  }
  // A newer request is already selecting this target; its own acknowledgement will finish the layout.
  if (pendingSelection?.intent === intent) return;
  const next = supports(intent.primary) ? { ...state, pendingLayout: null }
    : { ...initial, dir: state.dir, ratio: state.ratio, pendingLayout: null };
  if (!next.open && state.open) applyConfirmed(next);
  selectAndApply(intent.primary, next, undefined, intent, undefined, undefined, !!obsolete.canCommit);
}

export function attachCenterSplitBridge(next: CenterSplitBridge | null): void {
  if (bridge !== next) { discardPending(); selectionRequests.clear(); latestIntent = null; }
  bridge = next;
  if (state.selectionScope !== bridge?.getSelectionScope?.()) set({ ...state });
}
export function getCenterSplitState(): CenterSplitState {
  const selectionScope = bridge?.getSelectionScope?.();
  // App can change its scope while closed, without a geometry mutation. Replace the snapshot,
  // rather than mutating a captured old state/candidate into the new workspace.
  if (state.selectionScope !== selectionScope) state = { ...state, selectionScope };
  return state;
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useCenterSplit(): CenterSplitState {
  return useSyncExternalStore(subscribe, getCenterSplitState);
}

export function centerSplitCanRestoreHistory(primary: SplitPaneRef): boolean {
  return !!bridge && primary.kind !== 'empty' && (bridge.canSelectRef?.(primary) ?? supports(primary));
}

/** Replay exact logical slots, bypassing the ordinary "fill focused pane" navigation. */
export function centerSplitRestoreHistory(primary: SplitPaneRef, split: LeftNavigationSplit | undefined, complete: (result: 'applied' | 'cancelled' | 'failed') => void): void {
  if (!centerSplitCanRestoreHistory(primary)) { complete('failed'); return; }
  const seen = [primary];
  const sanitize = (ref: SplitPaneRef): SplitPaneRef => {
    if (!supports(ref) || !(bridge?.canSelectRef?.(ref) ?? true) ||
        (ref.kind !== 'empty' && seen.some(other => samePaneRef(other, ref)))) return { kind: 'empty' };
    seen.push(ref);
    return { ...ref };
  };
  const next: CenterSplitState = split && supports(primary)
    ? { ...split, open: true, secondary: sanitize(split.secondary),
      ...(split.tertiary ? { tertiary: sanitize(split.tertiary) } : {}),
      order: split.order ? [...split.order] : undefined, ratios: split.ratios ? [...split.ratios] : undefined }
    : { ...initial, dir: state.dir, ratio: state.ratio };
  selectAndApply(primary, next, undefined, undefined, complete);
}
export function centerSplitTree(): import('../../shared/centerSplit').SplitNode | null {
  if (!state.open || !bridge) return null;
  const refs = paneRefs(), order = physicalOrder();
  const sorted = order.map((_, index) => refs[order.indexOf(index)]);
  const leaf = (ref: SplitPaneRef): import('../../shared/centerSplit').SplitNode => ({ type: 'pane', ref });
  return { type: 'split', dir: state.dir, ratio: sorted.length === 3 ? state.layoutId === 'focus' ? .5 : 1 / 3 : state.ratio,
    children: [leaf(sorted[0]), sorted.length === 2 ? leaf(sorted[1])
      : { type: 'split', dir: state.layoutId === 'focus' ? 'col' : 'row', ratio: .5,
        children: [leaf(sorted[1]), leaf(sorted[2])] }] };
}

/** App calls this in a layout effect after primary changes, including archive fallback/reveal. */
export function centerSplitReconcilePrimary(
  primary = bridge?.getPrimary(), unsupportedPrimary = false
): void {
  if (!primary) return;
  if (pendingSelection && !isCurrentIntent(pendingSelection.intent)) discardPending();
  if (latestIntent && !isCurrentIntent(latestIntent)) latestIntent = null;
  const ownAck = [...selectionRequests].reverse().find(request => !request.observed &&
    isCurrentIntent(request.intent) && samePaneRef(primary!, request.primary)) ??
    [...selectionRequests].reverse().find(request => latestIntent !== request.intent &&
      isCurrentIntent(request.intent) && samePaneRef(primary!, request.primary));
  if (ownAck) {
    ownAck.observed = true;
    if (latestIntent !== ownAck.intent) {
      restoreLatestIntent(ownAck);
      primary = bridge?.getPrimary() ?? primary;
      if (latestIntent && !samePaneRef(primary, latestIntent.primary)) {
        // Keep any newer transaction, but never render the obsolete primary in both slots.
        clearDuplicates(primary);
        pruneSelectionRequests(); return;
      }
    }
  }
  const request = pendingSelection;
  if (request && samePaneRef(primary, request.primary)) {
    if (request.canCommit && !request.canCommit()) cancelGuardedSelection(request);
    else if (paneRefs(request.next, request.primary).every(supports)) applyConfirmed(request.next, request.prefs);
    else discardPending();
  } else if (request) {
    // Only the original utility's known backing session is a temporary reveal frame.
    // A different actual selection is an external navigation, even while our IPC awaits.
    if (primary.kind === 'empty' || samePaneRef(primary, request.from) ||
        (request.from.kind === 'utility' && request.underlying && samePaneRef(primary, request.underlying))) return;
    discardPending();
    recordIntent(primary);
  } else if (latestIntent?.externalFrom && samePaneRef(primary, latestIntent.externalFrom)) {
    return;
  } else if (!latestIntent || !samePaneRef(primary, latestIntent.primary)) {
    recordIntent(primary);
  }
  if (latestIntent && samePaneRef(primary, latestIntent.primary)) latestIntent.externalFrom = undefined;
  pruneSelectionRequests();
  if (!state.open) return;
  if (unsupportedPrimary || !supports(primary)) { centerSplitClose(); return; }
  if (primary.kind !== 'empty' && paneRefs(state, primary).slice(1).some(ref => samePaneRef(primary, ref))) {
    discardPending();
    clearDuplicates(primary);
  }
}
/** A lost secondary becomes an empty selector; lost content invalidates any pending selection. */
export function pruneCenterSplit(alive: (ref: SplitPaneRef) => boolean): void {
  const valid = (ref: SplitPaneRef): boolean => ref.kind === 'empty' || (supports(ref) && alive(ref));
  if (pendingSelection && !paneRefs(pendingSelection.next, pendingSelection.primary).every(valid)) {
    recordIntent(bridge?.getPrimary() ?? { kind: 'empty' }); discardPending();
  }
  if (state.open && !paneRefs().slice(1).every(valid)) {
    if (pendingSelection) recordIntent(bridge?.getPrimary() ?? { kind: 'empty' });
    discardPending();
    set({ ...state, secondary: valid(state.secondary) ? state.secondary : { kind: 'empty' },
      ...(state.tertiary ? { tertiary: valid(state.tertiary) ? state.tertiary : { kind: 'empty' } } : {}) });
  }
  centerSplitReconcilePrimary();
}

/** Commit the displayed candidate only while the two original content references still exist. */
export function centerSplitCommitDockLayout(layout: CenterSplitDockLayout): boolean {
  if (!bridge || !state.open || paneRefs().length !== 2 || !supports(layout.pane0) || !supports(layout.pane1) ||
      layout.pane0.kind === 'empty' || layout.pane1.kind === 'empty' || samePaneRef(layout.pane0, layout.pane1)) return false;
  const primary = bridge.getPrimary();
  const samePair = (samePaneRef(primary, layout.pane0) && samePaneRef(state.secondary, layout.pane1)) ||
    (samePaneRef(primary, layout.pane1) && samePaneRef(state.secondary, layout.pane0));
  if (!samePair) return false;
  selectAndApply(layout.pane0, { ...state, open: true, secondary: layout.pane1,
    tertiary: undefined, layoutId: undefined, order: undefined, ratios: undefined,
    dir: layout.dir, ratio: clampRatio(layout.ratio), focused: layout.focused },
  { dir: layout.dir, ratio: clampRatio(layout.ratio) });
  return true;
}
/** Commit a capacity-preserving Snap candidate only against its exact source bindings/layout/scope. */
export function centerSplitCommitSnapLayout(layout: CenterSplitSnapLayout): boolean {
  return commitSnapLayout(layout);
}
/** Native sidebar Snap adds its source once, retaining every currently displayed reference. */
export function centerSplitCommitIncomingSnapLayout(layout: CenterSplitIncomingSnapLayout): boolean {
  if (!layout.incoming || layout.incoming.kind === 'empty' || !supports(layout.incoming) ||
      bridge?.canSelectRef?.(layout.incoming) === false ||
      !layout.panes[layout.focused] || !samePaneRef(layout.panes[layout.focused], layout.incoming)) return false;
  return commitSnapLayout(layout, layout.incoming);
}

/** Explicit agent layout uses the same primary-selection transaction and never stops sessions. */
export function centerSplitApplyAgentLayout(
  workspaceId: string,
  panes: SplitPaneRef[],
  layoutId: CenterSnapLayoutId,
  canCommit?: () => boolean
): Promise<'applied' | 'cancelled' | 'failed'> {
  const currentBridge = bridge;
  const preset = CENTER_SNAP_LAYOUTS.find(item => item.id === layoutId);
  if (!currentBridge || currentBridge.getSelectionScope?.() !== workspaceId || state.pendingLayout || !preset || !Array.isArray(panes) ||
      panes.length !== preset.cells.length || panes.some(ref => !ref || ref.kind === 'empty' || !supports(ref) || currentBridge.canSelectRef?.(ref) === false) ||
      panes.some((ref, index) => panes.slice(0, index).some(other => samePaneRef(ref, other)))) {
    return Promise.reject(new Error('Center layout is invalid, unavailable, or still changing'));
  }
  const dir = layoutId === 'stack' ? 'col' as const : 'row' as const;
  const ratio = layoutId === 'wide' ? 2 / 3 : .5;
  const next: CenterSplitState = { ...state, open: true, secondary: { ...panes[1] },
    tertiary: panes[2] ? { ...panes[2] } : undefined, layoutId, order: panes.map((_, index) => index),
    dir, ratio, ratios: undefined, focused: 0 };
  return new Promise((resolve, reject) => {
    try { selectAndApply({ ...panes[0] }, next, { dir, ratio }, undefined, resolve, canCommit); }
    catch (error) { reject(error); }
  });
}
function commitSnapLayout(layout: CenterSplitSnapLayout, incoming?: SplitPaneRef): boolean {
  if (!bridge || layout.selectionScope !== bridge.getSelectionScope?.()) return false;
  const original = paneRefs(), snapshot = layout.originalState, order = physicalOrder();
  const preset = CENTER_SNAP_LAYOUTS.find(item => item.id === layout.layoutId);
  if (!snapshot || !preset || original.length !== layout.original.length || original.some((ref, index) => !samePaneRef(ref, layout.original[index])) ||
      snapshot.open !== state.open || snapshot.layoutId !== state.layoutId || snapshot.dir !== state.dir || snapshot.ratio !== state.ratio ||
      JSON.stringify(snapshot.ratios) !== JSON.stringify(state.ratios) ||
      snapshot.order.length !== order.length || snapshot.order.some((index, slot) => index !== order[slot]) ||
      layout.panes.length !== preset.cells.length || layout.order.length !== preset.cells.length ||
      new Set(layout.order).size !== preset.cells.length || layout.order.some(index => !Number.isInteger(index) || index < 0 || index >= preset.cells.length) ||
      !layout.panes.every(supports) || layout.panes[0].kind === 'empty' ||
      layout.dir !== (layout.layoutId === 'stack' ? 'col' : 'row') || layout.ratio !== (layout.layoutId === 'wide' ? 2 / 3 : .5) ||
      !layout.panes[layout.focused] || layout.panes[layout.focused].kind === 'empty') return false;
  const occupied = original.filter(ref => ref.kind !== 'empty'), nextOccupied = layout.panes.filter(ref => ref.kind !== 'empty');
  if (incoming && incoming.kind !== 'empty' && !occupied.some(ref => samePaneRef(ref, incoming))) occupied.push(incoming);
  if (occupied.length !== nextOccupied.length || nextOccupied.some((ref, index) => nextOccupied.slice(0, index).some(other => samePaneRef(other, ref))) ||
      occupied.some(ref => !nextOccupied.some(other => samePaneRef(ref, other))) ||
      !samePaneRef(layout.pane0, layout.panes[0]) || !samePaneRef(layout.pane1, layout.panes[1]) ||
      (layout.panes.length === 3 && (!layout.pane2 || !samePaneRef(layout.pane2, layout.panes[2])))) return false;
  selectAndApply(layout.panes[0], { ...state, open: true, secondary: layout.panes[1], tertiary: layout.panes[2],
    layoutId: layout.layoutId, order: [...layout.order], dir: layout.dir, ratio: clampRatio(layout.ratio), ratios: undefined, focused: layout.focused },
  { dir: layout.dir, ratio: clampRatio(layout.ratio) });
  return true;
}
export function centerSplitDockPane(slot: CenterPaneSlot, side: SplitSide): boolean {
  if (!bridge) return false;
  if (paneRefs().length === 3) {
    const target = { layoutId: state.layoutId ?? 'thirds' as CenterSnapLayoutId, index: physicalOrder()[sideSlot(side)] };
    const candidate = deriveCenterSplitSnapLayout(bridge.getPrimary(), state, slot, target);
    return candidate ? centerSplitCommitSnapLayout(candidate) : false;
  }
  if (slot === 2) return false;
  const layout = deriveCenterSplitDockLayout(bridge.getPrimary(), state, slot, side);
  return layout ? centerSplitCommitDockLayout(layout) : false;
}

/** Incoming drag/menu refs share equality and edge reordering with existing-pane docking. */
export function centerSplitIncoming(ref: SplitPaneRef, side: SplitSide): void {
  if (!bridge || !supports(ref) || ref.kind === 'empty') return;
  const { current, primary } = desiredLayout();
  if (!supports(primary)) return;
  const { slot, dir } = sideToSlot(side);
  if (!current.open) {
    if (samePaneRef(primary, ref)) return;
    if (primary.kind === 'empty') {
      selectAndApply(ref, { ...initial, dir: current.dir, ratio: current.ratio });
      return;
    }
    const prefs = bridge.getPrefs();
    const next = { ...current, open: true, secondary: slot === 0 ? primary : ref,
      tertiary: undefined, layoutId: undefined, order: undefined,
      dir, ratio: clampRatio(prefs.dir === dir ? prefs.ratio : 0.5), focused: slot };
    selectAndApply(slot === 0 ? ref : primary, next, { dir });
    return;
  }
  const refs = paneRefs(current, primary), existing = refs.findIndex(other => samePaneRef(other, ref));
  if (existing >= 0) {
    if (current === state) {
      if (!centerSplitDockPane(existing as CenterPaneSlot, side)) centerSplitSetFocused(existing as CenterPaneSlot);
    } else if (refs.length === 3) {
      const candidate = deriveCenterSplitSnapLayout(primary, current, existing as CenterPaneSlot,
        { layoutId: current.layoutId ?? 'thirds', index: physicalOrder(current)[sideSlot(side, current)] });
      if (candidate) selectAndApply(candidate.pane0, { ...current, secondary: candidate.pane1, tertiary: candidate.pane2,
        layoutId: candidate.layoutId, order: candidate.order, dir: candidate.dir, ratio: candidate.ratio, ratios: undefined, focused: candidate.focused },
      { dir: candidate.dir, ratio: candidate.ratio });
      else focusDesiredSlot(existing as CenterPaneSlot);
    } else {
      const candidate = deriveCenterSplitDockLayout(primary, current, existing as CenterPaneSlot, side);
      if (candidate) selectAndApply(candidate.pane0, { ...current, secondary: candidate.pane1, tertiary: undefined,
        layoutId: undefined, order: undefined, dir: candidate.dir, ratio: candidate.ratio, focused: candidate.focused },
      { dir: candidate.dir, ratio: candidate.ratio });
      else focusDesiredSlot(existing as CenterPaneSlot);
    }
    return;
  }
  if (refs.length === 3) {
    const target = sideSlot(side, current);
    selectAndApply(target === 0 ? ref : primary, { ...extraRef(current, target, ref), focused: target }, pendingSelection?.prefs);
    return;
  }
  const targetSlot = current.order ? physicalOrder(current).indexOf(slot) as CenterPaneSlot : slot;
  const next = { ...extraRef(current, targetSlot, ref), layoutId: undefined, dir, focused: targetSlot };
  selectAndApply(targetSlot === 0 ? ref : primary, next, { ...pendingSelection?.prefs, dir });
}
export function centerSplitToggleShortcut(): void {
  if (!bridge) return;
  const primary = bridge.getPrimary();
  if (primary.kind === 'empty' || !supports(primary)) return;
  if (state.open) {
    const empty = paneRefs(state, primary).findIndex(ref => ref.kind === 'empty');
    centerSplitSetFocused(empty >= 0 ? empty as CenterPaneSlot : state.focused);
    return;
  }
  const prefs = bridge.getPrefs();
  recordIntent(primary);
  applyConfirmed({ ...state, open: true, secondary: { kind: 'empty' }, dir: prefs.dir,
    ratio: clampRatio(prefs.ratio), focused: 1 });
}
/** Slot-aware folder navigation. Existing contents are focused rather than duplicated. */
export function centerSplitSelectInPane(slot: CenterPaneSlot, ref: SplitPaneRef): boolean {
  if (!bridge || !state.open || !supports(ref)) return false;
  if (slot >= paneRefs().length) return false;
  const action = desiredPaneAction(slot);
  if (!action) return true; // Consume an old callback from content already removed by latest intent.
  const { current, primary } = action;
  slot = action.slot;
  if (slot === 0 && ref.kind === 'empty') return current.open ? false : true;
  const refs = paneRefs(current, primary);
  const existing = ref.kind === 'empty' ? -1 : refs.findIndex(other => samePaneRef(other, ref));
  if (existing >= 0) { focusDesiredSlot(existing as CenterPaneSlot); return true; }
  selectAndApply(slot === 0 ? ref : primary, { ...extraRef(current, slot, ref), focused: slot }, pendingSelection?.prefs);
  return true;
}

/** Agent selection must retain its request guard until App acknowledges the primary. */
export function centerSplitSelectAgentRef(workspaceId: string, ref: Exclude<SplitPaneRef, { kind: 'empty' }>,
  canCommit: () => boolean): Promise<'applied' | 'cancelled' | 'failed'> {
  if (!bridge || bridge.getSelectionScope?.() !== workspaceId || pendingSelection ||
      typeof canCommit !== 'function' || !canCommit() || !supports(ref) || bridge.canSelectRef?.(ref) === false) return Promise.resolve('cancelled');
  const primary = bridge.getPrimary(), refs = paneRefs(state, primary);
  const existing = refs.findIndex(item => samePaneRef(item, ref));
  if (existing >= 0) {
    if (!canCommit()) return Promise.resolve('cancelled');
    centerSplitSetFocused(existing as CenterPaneSlot);
    return Promise.resolve('applied');
  }
  const slot = state.open ? state.focused : 0;
  if (!refs[slot]) return Promise.resolve('cancelled');
  const next = state.open ? { ...extraRef(state, slot, ref), focused: slot } : { ...state, focused: 0 as const };
  return new Promise(resolve => {
    try { selectAndApply(slot === 0 ? ref : primary, next, undefined, undefined, resolve, canCommit); }
    catch { resolve('failed'); }
  });
}
/** Rail clicks keep normal App navigation for new primary refs and focus any already-visible ref. */
export function centerSplitTryFill(ref: SplitPaneRef): boolean {
  if (!bridge) return false;
  const primary = bridge.getPrimary();
  const desired = desiredLayout();
  if (pendingSelection && !desired.current.open) {
    if (ref.kind !== 'empty' && samePaneRef(ref, desired.primary)) { focusDesiredSlot(0); return true; }
    // Finish only the requested geometry, keeping App as primary authority for normal rail navigation.
    recordIntent(ref, primary); discardPending(); applyConfirmed(desired.current); return false;
  }
  if (!state.open || !supports(ref)) {
    // Main navigation still expresses a new intent after a split was closed.
    recordIntent(ref, primary); discardPending(); return false;
  }
  const refs = paneRefs(), desiredRefs = paneRefs(desired.current, desired.primary);
  const existing = ref.kind === 'empty' ? -1 : desiredRefs.findIndex(other => samePaneRef(other, ref));
  if (existing >= 0) { focusDesiredSlot(existing as CenterPaneSlot); return true; }
  const pendingFocusedRef = state.pendingLayout
    ? presentationRefs(state.pendingLayout)[state.pendingLayout.focused]
    : null;
  const mapped = pendingFocusedRef?.kind !== 'empty' && pendingFocusedRef ? refs.findIndex(other => samePaneRef(other, pendingFocusedRef)) : -1;
  const actualFocused = mapped >= 0 ? mapped as CenterPaneSlot : state.focused;
  if (actualFocused === 0) { recordIntent(ref, primary); discardPending(); return false; }
  return centerSplitSelectInPane(actualFocused, ref);
}
export function centerSplitSetFocused(focused: CenterPaneSlot): void {
  const refs = paneRefs();
  if (focused >= refs.length) return;
  if (pendingSelection && state.pendingLayout) {
    // DOM slots remain tied to their confirmed content while candidate geometry can exchange them.
    const ref = refs[focused], candidateFocused = presentationRefs(state.pendingLayout).findIndex(other => samePaneRef(ref, other));
    if (candidateFocused < 0 || (state.pendingLayout.focused === candidateFocused && state.focused === focused)) return;
    pendingSelection.next = { ...pendingSelection.next, focused: candidateFocused as CenterPaneSlot };
    set({ ...state, focused, pendingLayout: { ...state.pendingLayout, focused: candidateFocused as CenterPaneSlot } });
  } else if (state.focused !== focused) set({ ...state, focused });
}
export function centerSplitSetRatio(ratio: number): void {
  if (pendingSelection && !desiredLayout().current.open) return;
  if ((state.pendingLayout ? presentationRefs(state.pendingLayout) : paneRefs()).length > 2) return;
  const next = clampRatio(ratio);
  if (Math.abs(next - (state.pendingLayout?.ratio ?? state.ratio)) < 0.001) return;
  if (pendingSelection && state.pendingLayout) {
    pendingSelection.next = { ...pendingSelection.next, ratio: next, layoutId: undefined };
    pendingSelection.prefs = { ...pendingSelection.prefs, ratio: next };
    set({ ...state, pendingLayout: { ...state.pendingLayout, ratio: next, layoutId: undefined } });
    return;
  }
  set({ ...state, ratio: next, layoutId: undefined }); bridge?.savePrefs({ ratio: next });
}
/** Resize only the confirmed three-pane layout; pending selections and closures own their geometry. */
export function centerSplitSetRatios(ratios: [number, number]): void {
  if (!state.open || state.pendingLayout || paneRefs().length !== 3) return;
  const next = getCenterSplitRatios({ ...state, ratios });
  const previous = getCenterSplitRatios(state);
  if (next.every((value, index) => Math.abs(value - previous[index]) < .000001)) return;
  set({ ...state, ratios: next });
}
export function centerSplitSetDividerRatio(index: 0 | 1, ratio: number): void {
  if (!Number.isFinite(ratio)) return;
  if (paneRefs().length === 2) { if (index === 0) centerSplitSetRatio(ratio); return; }
  const divider = getCenterSplitDividers(state).find(item => item.index === index);
  if (!divider) return;
  const next = getCenterSplitRatios(state);
  next[index] = Math.min(divider.max, Math.max(divider.min, ratio));
  centerSplitSetRatios(next);
}
export function centerSplitResetRatio(): void {
  if (paneRefs().length === 3) centerSplitSetRatios(getCenterSplitRatios({ ...state, ratios: undefined }));
  else centerSplitSetRatio(0.5);
}
export function centerSplitSwap(): void {
  if (!state.open || !bridge) return;
  const { current, primary } = desiredLayout();
  if (!current.open || current.secondary.kind === 'empty') return;
  if (samePaneRef(primary, current.secondary)) { centerSplitReconcilePrimary(); return; }
  selectAndApply(current.secondary, { ...current, secondary: primary,
    focused: current.focused === 0 ? 1 : current.focused === 1 ? 0 : 2 });
}
export function centerSplitFlip(): void {
  if (!state.open) return;
  const { current, primary } = desiredLayout();
  if (!current.open) return;
  if (paneRefs(current, primary).length === 3) {
    const layoutId = current.layoutId === 'focus' ? 'thirds' : 'focus';
    selectAndApply(primary, { ...current, layoutId, dir: 'row', ratio: .5, ratios: undefined }, { dir: 'row', ratio: .5 });
    return;
  }
  const dir = (state.pendingLayout?.dir ?? state.dir) === 'row' ? 'col' : 'row';
  if (pendingSelection && state.pendingLayout) {
    pendingSelection.next = { ...pendingSelection.next, dir, layoutId: undefined };
    pendingSelection.prefs = { ...pendingSelection.prefs, dir };
    set({ ...state, pendingLayout: { ...state.pendingLayout, dir, layoutId: undefined } });
    return;
  }
  set({ ...state, dir, layoutId: undefined }); bridge?.savePrefs({ dir });
}
export function centerSplitClosePane(slot: CenterPaneSlot): void {
  closePane(slot);
}

/** Agent requests can be cancelled while the primary selection is in flight. */
export function centerSplitCloseAgentPane(slot: CenterPaneSlot, canCommit: () => boolean): Promise<'applied' | 'cancelled' | 'failed'> {
  const refs = paneRefs();
  if (!state.open || !bridge || pendingSelection || typeof canCommit !== 'function' || !canCommit() ||
      !refs[slot] || refs[slot].kind === 'empty' || refs.filter(ref => ref.kind !== 'empty').length < 2) return Promise.resolve('cancelled');
  return new Promise(resolve => closePane(slot, resolve, canCommit));
}

function closePane(slot: CenterPaneSlot, complete?: (result: 'applied' | 'cancelled' | 'failed') => void, canCommit?: () => boolean): void {
  if (!state.open || !bridge || (canCommit && !canCommit())) { complete?.('cancelled'); return; }
  const action = desiredPaneAction(slot);
  // A pending close can already have reduced this reference to the final single pane.
  // Its old split button is then equivalent to the single-pane UI, which has no close action.
  if (!action || !action.current.open) { complete?.('cancelled'); return; }
  const current = action.current, primary = action.primary;
  slot = action.slot;
  const refs = paneRefs(current, primary), cells = getCenterSplitPaneCells(current);
  if (refs.length === 3) {
    const survivors = refs.map((ref, index) => ({ ref, cell: cells[index] })).filter((item, index) => index !== slot && item.ref.kind !== 'empty');
    if (survivors.length === 0) { centerSplitClose(); complete?.('applied'); return; }
    survivors.sort((a, b) => a.cell.x - b.cell.x || a.cell.y - b.cell.y);
    const kept = slot !== 0 && refs[0].kind !== 'empty' ? refs[0] : survivors[0].ref;
    if (survivors.length === 1) {
      selectAndApply(kept, { ...initial, dir: current.dir, ratio: current.ratio }, undefined, undefined, complete, canCommit); return;
    }
    const stacked = Math.abs(survivors[0].cell.x - survivors[1].cell.x) < .001;
    const panes = [kept, survivors.find(item => !samePaneRef(item.ref, kept))!.ref];
    const order = panes.map(ref => survivors.findIndex(item => samePaneRef(item.ref, ref)));
    const focusedRef = refs[current.focused], focused = Math.max(0, panes.findIndex(ref => samePaneRef(ref, focusedRef))) as CenterPaneSlot;
    const dir = stacked ? 'col' : 'row';
    selectAndApply(kept, { ...current, secondary: panes[1], tertiary: undefined,
      layoutId: stacked ? 'stack' : 'halves', order, dir, ratio: .5, ratios: undefined, focused }, { dir, ratio: .5 }, undefined, complete, canCommit);
    return;
  }
  const secondary = current.secondary;
  const closed = { ...initial, dir: current.dir, ratio: current.ratio };
  if (secondary.kind !== 'empty') { selectAndApply(slot === 0 ? secondary : primary, closed, undefined, undefined, complete, canCommit); return; }
  discardPending();
  // There is no independent empty-primary session selection.
  recordIntent(slot === 0 ? bridge.getUnderlyingPrimary?.() ?? bridge.getPrimary() : primary);
  applyConfirmed(closed);
  if (slot === 0) bridge.selectRef(secondary);
  complete?.('applied');
}
export function centerSplitDissolve(keep: CenterPaneSlot): void {
  if (!state.open || !bridge) return;
  const action = desiredPaneAction(keep);
  if (!action || !action.current.open) return;
  const ref = paneRefs(action.current, action.primary)[action.slot];
  if (!ref) return;
  if (ref.kind === 'empty') {
    // Preserve the existing empty-selector behavior: clear a tool and expose its backing
    // primary, rather than pretending the bridge can deselect an active terminal.
    recordIntent(bridge.getUnderlyingPrimary?.() ?? bridge.getPrimary()); discardPending();
    applyConfirmed({ ...initial, dir: action.current.dir, ratio: action.current.ratio });
    bridge.selectRef(ref); return;
  }
  selectAndApply(ref, { ...initial, dir: action.current.dir, ratio: action.current.ratio });
}
export function centerSplitClose(): void {
  if (bridge) recordIntent(bridge.getPrimary());
  discardPending();
  if (state.open) applyConfirmed({ ...initial, dir: state.dir, ratio: state.ratio });
}
export function __resetCenterSplitForTest(): void {
  pendingSelection = null; state = initial; bridge = null; latestIntent = null;
  intentSequence = 0; selectionRequests.clear();
  for (const listener of listeners) listener();
}
export function useCenterSplitController(): CenterSplitState & {
  incoming: typeof centerSplitIncoming; tryFill: typeof centerSplitTryFill;
  selectInPane: typeof centerSplitSelectInPane; dockPane: typeof centerSplitDockPane;
  commitDockLayout: typeof centerSplitCommitDockLayout;
  commitSnapLayout: typeof centerSplitCommitSnapLayout;
  commitIncomingSnapLayout: typeof centerSplitCommitIncomingSnapLayout;
  setFocused: typeof centerSplitSetFocused; setRatio: typeof centerSplitSetRatio;
  resetRatio: typeof centerSplitResetRatio; swap: typeof centerSplitSwap;
  flip: typeof centerSplitFlip; closePane: typeof centerSplitClosePane; dissolve: typeof centerSplitDissolve;
} {
  return { ...useCenterSplit(), incoming: centerSplitIncoming, tryFill: centerSplitTryFill,
    selectInPane: centerSplitSelectInPane, dockPane: centerSplitDockPane,
    commitDockLayout: centerSplitCommitDockLayout, commitSnapLayout: centerSplitCommitSnapLayout,
    commitIncomingSnapLayout: centerSplitCommitIncomingSnapLayout, setFocused: centerSplitSetFocused,
    setRatio: centerSplitSetRatio, resetRatio: centerSplitResetRatio, swap: centerSplitSwap,
    flip: centerSplitFlip, closePane: centerSplitClosePane, dissolve: centerSplitDissolve };
}
