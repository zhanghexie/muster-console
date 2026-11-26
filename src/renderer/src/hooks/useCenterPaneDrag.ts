import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { deriveCenterSplitSnapLayout, getCenterSplitPaneCells, getCenterSplitPaneRefs,
  type CenterPaneSlot, type CenterSnapTarget, type CenterSplitSnapLayout, type SplitPaneRef, type SplitSide } from '../../../shared/centerSplit';
import { centerSplitCommitSnapLayout, getCenterSplitState, type CenterSplitState } from '../centerSplitStore';

/** 长按把手出 Snap 选择条:按住不动该时长即进入条区形态,无需拖到顶缘。 */
const LONG_PRESS_MS = 400;

export interface CenterPaneRect { top: number; left: number; width: number; height: number }
export type CenterPaneEdgeAction = 'left' | 'right' | 'fullscreen' | 'close';
export function centerSnapHintAt(width: number, x: number, y: number): boolean {
  return Math.abs(x - width / 2) <= Math.min(280, Math.max(0, width / 2 - 10)) && y > 8 && y <= 40;
}
export function centerSnapRevealAt(width: number, x: number, y: number, wasOpen: boolean, bar?: CenterPaneRect): boolean {
  if (x < 0 || x > width || y <= 8) return false;
  if (centerSnapHintAt(width, x, y)) return true;
  return wasOpen && (!bar || x >= bar.left - 18 && x <= bar.left + bar.width + 18 && y <= bar.top + bar.height + 18);
}
export function canCloseCenterPane(primary: SplitPaneRef, state: CenterSplitState, slot: CenterPaneSlot): boolean {
  const refs = getCenterSplitPaneRefs(primary, state), ref = refs[slot];
  return !!ref && (ref.kind === 'utility' || state.open &&
    (ref.kind === 'empty' || refs.filter(item => item.kind !== 'empty').length > 1));
}
/** Test the displayed thumbnail bounds, not an arbitrary strip around the pointer. */
export function centerPaneEdgeAt(card: CenterPaneRect, width: number, height: number, x: number, y: number): CenterPaneEdgeAction | null {
  if (x < 0 || y < 0 || x > width || y > height) return null;
  const contacts: Array<{ action: CenterPaneEdgeAction; distance: number }> = [];
  if (card.left <= 0) contacts.push({ action: 'left', distance: x });
  if (card.left + card.width >= width) contacts.push({ action: 'right', distance: width - x });
  if (card.top <= 0) contacts.push({ action: 'fullscreen', distance: y });
  if (card.top + card.height >= height) contacts.push({ action: 'close', distance: height - y });
  return contacts.sort((a, b) => a.distance - b.distance)[0]?.action ?? null;
}
export function centerPaneRects(width: number, height: number, dir: 'row' | 'col', ratio: number): [CenterPaneRect, CenterPaneRect] {
  const full = { top: 0, left: 0, width, height };
  const cut = Math.round((dir === 'row' ? width : height) * ratio);
  return dir === 'row'
    ? [{ ...full, width: cut }, { ...full, left: cut, width: width - cut }]
    : [{ ...full, height: cut }, { ...full, top: cut, height: height - cut }];
}

interface Gesture {
  slot: CenterPaneSlot; pointerId: number; element: HTMLElement; startX: number; startY: number;
  x: number; y: number; primary: SplitPaneRef; original: CenterSplitState; source: CenterPaneRect;
  grabX: number; grabY: number; active: boolean; bar: boolean; hintArmed: boolean;
}
export interface CenterPaneDrag {
  slot: CenterPaneSlot; source: CenterPaneRect; floating: CenterPaneRect; scale: number; bar: boolean;
  side: SplitSide | null; target: CenterSnapTarget | null; candidate: CenterSplitSnapLayout | null;
  edgeAction: CenterPaneEdgeAction | null;
}

const geometryKey = (primary: SplitPaneRef, state: CenterSplitState): string => JSON.stringify({
  refs: getCenterSplitPaneRefs(primary, state), open: state.open, dir: state.dir, ratio: state.ratio, ratios: state.ratios,
  layoutId: state.layoutId, order: state.order, selectionScope: state.selectionScope
});

/** One captured handle owns the gesture; actual content remains in its original parent. */
export function useCenterPaneDrag(mainRef: RefObject<HTMLElement | null>, split: CenterSplitState, primary: SplitPaneRef, narrow: boolean,
  onEdgeAction: (action: 'fullscreen' | 'close', slot: CenterPaneSlot) => void) {
  const gesture = useRef<Gesture | null>(null);
  const suppressedClick = useRef(false);
  const [captureActive, setCaptureActive] = useState(false);
  const [drag, setDrag] = useState<CenterPaneDrag | null>(null);
  const [pickerSlot, setPickerSlot] = useState<CenterPaneSlot | null>(null);
  const pickerSlotRef = useRef(pickerSlot); pickerSlotRef.current = pickerSlot;
  const [pickerTarget, setPickerTarget] = useState<CenterSnapTarget | null>(null);
  const pickerKey = useRef<string | null>(null);
  const longPressRef = useRef<number | null>(null);
  const clearLongPress = (): void => {
    if (longPressRef.current != null) { window.clearTimeout(longPressRef.current); longPressRef.current = null; }
  };
  const focusHandle = (slot: CenterPaneSlot): void => mainRef.current?.querySelector<HTMLButtonElement>(`[data-testid="center-pane-handle-${slot}"]`)?.focus({ preventScroll: true });
  const release = (g: Gesture): void => { try { g.element.releasePointerCapture(g.pointerId); } catch { /* capture already released */ } };
  const cancel = (): void => {
    const g = gesture.current; gesture.current = null;
    clearLongPress();
    if (g) suppressedClick.current = true;
    setCaptureActive(false); setDrag(null); setPickerSlot(null); setPickerTarget(null); pickerKey.current = null; if (g) release(g);
  };
  const sample = (g: Gesture, clientX: number, clientY: number): CenterPaneDrag | null => {
    const rect = mainRef.current?.getBoundingClientRect(); if (!rect) return null;
    const x = clientX - rect.left, y = clientY - rect.top;
    const inSurface = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
    const barRect = mainRef.current?.querySelector('[data-testid="center-snap-bar"]')?.getBoundingClientRect();
    if (!centerSnapHintAt(rect.width, x, y)) g.hintArmed = true;
    const bar = inSurface && (g.bar || g.hintArmed) && centerSnapRevealAt(rect.width, x, y, g.bar,
      barRect ? { left: barRect.left - rect.left, top: barRect.top - rect.top, width: barRect.width, height: barRect.height } : undefined);
    let target: CenterSnapTarget | null = null;
    let side: SplitSide | null = null;
    let inPicker = false;
    if (bar && g.bar) for (const element of mainRef.current!.querySelectorAll<HTMLButtonElement>('[data-center-snap-layout][data-center-snap-index]')) {
      const cell = element.getBoundingClientRect();
      if (cell.width > 0 && cell.height > 0 && clientX >= cell.left && clientX <= cell.right && clientY >= cell.top && clientY <= cell.bottom) {
        inPicker = true;
        if (!element.disabled) target = { layoutId: element.dataset.centerSnapLayout as CenterSnapTarget['layoutId'], index: Number(element.dataset.centerSnapIndex) };
        break;
      }
    }
    const scale = Math.min(bar ? .32 : .78, rect.width / Math.max(1, g.source.width), rect.height / Math.max(1, g.source.height));
    const card = { left: x - g.grabX * scale, top: y - g.grabY * scale, width: g.source.width * scale, height: g.source.height * scale };
    // Picker cells (including disabled ones) own their drop region. Its gaps do
    // not accidentally become an edge action when the card overlaps an edge.
    const overPicker = inPicker || bar && !!barRect && clientX >= barRect.left && clientX <= barRect.right && clientY >= barRect.top && clientY <= barRect.bottom;
    let edgeAction = !target && !overPicker && inSurface ? centerPaneEdgeAt(card, rect.width, rect.height, x, y) : null;
    if (edgeAction === 'close' && !canCloseCenterPane(g.primary, g.original, g.slot)) edgeAction = null;
    if (edgeAction === 'left' || edgeAction === 'right') {
      side = edgeAction; target = { layoutId: 'halves', index: side === 'left' ? 0 : 1 };
    } else if (edgeAction) side = edgeAction === 'fullscreen' ? 'top' : 'bottom';
    const candidate = target ? deriveCenterSplitSnapLayout(g.primary, g.original, g.slot, target) : null;
    if ((edgeAction === 'left' || edgeAction === 'right') && !candidate) { edgeAction = null; side = null; }
    g.bar = bar;
    return { slot: g.slot, source: g.source, side, edgeAction, target: candidate ? target : null, candidate, scale, bar,
      floating: { ...g.source,
        left: Math.max(0, Math.min(rect.width - card.width, card.left)),
        top: Math.max(0, Math.min(rect.height - card.height, card.top)) } };
  };
  const down = (slot: CenterPaneSlot, e: PointerEvent<HTMLButtonElement>): void => {
    suppressedClick.current = false;
    const sourceRef = getCenterSplitPaneRefs(primary, split)[slot];
    if (e.button !== 0 || narrow || split.pendingLayout || gesture.current || !sourceRef || sourceRef.kind === 'empty') return;
    const rect = mainRef.current?.getBoundingClientRect(); if (!rect) return;
    const cell = getCenterSplitPaneCells(split)[slot] ?? { x: 0, y: 0, width: 1, height: 1 };
    const actual = mainRef.current?.querySelector(`[data-testid="center-pane-${slot}"]`)?.getBoundingClientRect();
    const source = actual && actual.width > 0 && actual.height > 0 ? { left: actual.left - rect.left, top: actual.top - rect.top, width: actual.width, height: actual.height }
      : { left: cell.x * rect.width, top: cell.y * rect.height, width: cell.width * rect.width, height: cell.height * rect.height };
    gesture.current = { slot, pointerId: e.pointerId, element: e.currentTarget, startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY, primary, original: split, source,
      grabX: e.clientX - rect.left - source.left, grabY: e.clientY - rect.top - source.top, active: false, bar: false,
      hintArmed: !centerSnapHintAt(rect.width, e.clientX - rect.left, e.clientY - rect.top) };
    setPickerSlot(null); setPickerTarget(null); pickerKey.current = null;
    // Chromium can route the first cross-frame move to the guest even while
    // hasPointerCapture is true. Shield it from pointerdown, before the 6px lift.
    setCaptureActive(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* window fallback also owns cleanup */ }
    // 长按即出 Snap 选择条:按住不动 400ms 直接进入条区形态(pane 浮起+选择条),
    // 无需先拖到顶缘;一旦拖动激活(≥6px)即取消,走常规拖拽。
    longPressRef.current = window.setTimeout(() => {
      longPressRef.current = null;
      const g = gesture.current;
      if (!g || g.active || g.pointerId !== e.pointerId) return;
      g.active = true; g.bar = true;
      suppressedClick.current = true;
      setDrag(sample(g, e.clientX, e.clientY));
    }, LONG_PRESS_MS);
  };
  const move = (e: PointerEvent<HTMLButtonElement>): void => {
    const g = gesture.current; if (!g || g.pointerId !== e.pointerId) return;
    if (e.buttons === 0) { cancel(); return; }
    if (!g.active && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 6) return;
    clearLongPress();
    e.preventDefault(); g.active = true; g.x = e.clientX; g.y = e.clientY;
    suppressedClick.current = true; setDrag(sample(g, e.clientX, e.clientY));
  };
  const up = (e: PointerEvent<HTMLButtonElement>): void => {
    const g = gesture.current; if (!g || g.pointerId !== e.pointerId) return;
    clearLongPress();
    gesture.current = null;
    if (g.active) {
      e.preventDefault(); suppressedClick.current = true;
      const final = sample(g, e.clientX, e.clientY);
      if (geometryKey(g.primary, g.original) === geometryKey(primary, getCenterSplitState())) {
        if (final?.candidate) centerSplitCommitSnapLayout(final.candidate);
        else if (final?.edgeAction === 'fullscreen' || final?.edgeAction === 'close') onEdgeAction(final.edgeAction, g.slot);
      }
    }
    setCaptureActive(false); setDrag(null); release(g);
  };
  useEffect(() => {
    const escape = (e: KeyboardEvent): void => { if (e.key === 'Escape' && (gesture.current || pickerSlotRef.current != null)) { e.preventDefault(); e.stopPropagation(); const slot = gesture.current?.slot ?? pickerSlotRef.current!; cancel(); focusHandle(slot); } };
    const released = (e: globalThis.PointerEvent): void => {
      const g = gesture.current;
      if (g && e.pointerId === g.pointerId && e.buttons === 0 && !g.element.contains(e.target as Node)) cancel();
    };
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', cancel);
    window.addEventListener('pointerup', released); window.addEventListener('pointermove', released);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', cancel);
      window.removeEventListener('pointerup', released); window.removeEventListener('pointermove', released);
      clearLongPress();
      const g = gesture.current; gesture.current = null; if (g) release(g); };
  }, []);
  const key = geometryKey(primary, split);
  useEffect(() => {
    const g = gesture.current;
    if (g && (narrow || split.pendingLayout || geometryKey(g.primary, g.original) !== key)) cancel();
    if (pickerKey.current && (pickerKey.current !== key || split.pendingLayout)) cancel();
  }, [key, narrow, split.pendingLayout]);
  const sourceSlot = drag?.slot ?? pickerSlot;
  const sourceRef = sourceSlot != null ? getCenterSplitPaneRefs(primary, split)[sourceSlot] : undefined;
  const previewFor = (target: CenterSnapTarget): CenterSplitSnapLayout | null => sourceSlot != null ? deriveCenterSplitSnapLayout(primary, split, sourceSlot, target) : null;
  const openPicker = (slot: CenterPaneSlot): void => { const ref = getCenterSplitPaneRefs(primary, split)[slot]; if (split.pendingLayout || !ref || ref.kind === 'empty') return; cancel(); pickerKey.current = key; setPickerSlot(slot); };
  const dismissPicker = (): void => { const slot = sourceSlot; cancel(); if (slot != null) focusHandle(slot); };
  const selectTarget = (target: CenterSnapTarget): void => { const candidate = previewFor(target); const slot = sourceSlot;
    cancel(); if (candidate) centerSplitCommitSnapLayout(candidate); if (slot != null) focusHandle(candidate?.focused ?? slot); };
  return { captureActive, drag, down, move, up, cancel, openPicker, dismissPicker, selectTarget, sourceSlot, sourceRef,
    barOpen: pickerSlot != null || !!drag?.bar, previewFor,
    target: drag?.target ?? pickerTarget, candidate: drag?.candidate ?? (pickerTarget ? previewFor(pickerTarget) : null),
    setTarget: (target: CenterSnapTarget | null): void => { if (!gesture.current) setPickerTarget(target); },
    consumeClick: (pointerGenerated = true): boolean => {
    const suppress = pointerGenerated && suppressedClick.current;
    suppressedClick.current = false;
    return suppress;
  } };
}
