import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { WorkspaceInfo } from '../../../shared/types';
import { MOTION, prefersReducedMotion } from '../components/motion';
import { subscribeInteractionPreferences } from '../interactionPreferences';

export const WORKSPACE_ORDER_KEY = 'muster.workspaceOrder.v1';
export const WORKSPACE_SORT_HOLD_MS = 450;
function readOrder(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WORKSPACE_ORDER_KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];
  } catch { return []; }
}

/** 本机列表偏好，不改变工作区登记/激活；Pointer Events 共用鼠标、触控与触笔路径。 */
export function useWorkspaceReorder(workspaces: WorkspaceInfo[], disabled: boolean, expand: () => void) {
  const [saved, setSaved] = useState(readOrder);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [pressing, setPressing] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const order = useMemo(() => {
    const ids = new Set(workspaces.map(w => w.id));
    const known = (draft ?? saved).filter(id => ids.has(id));
    return [...known, ...workspaces.filter(w => !known.includes(w.id)).map(w => w.id)];
  }, [workspaces, saved, draft]);
  const ordered = useMemo(() => order.map(id => workspaces.find(workspace => workspace.id === id)!), [order, workspaces]);
  const current = useRef({ order, disabled, expand });
  current.current = { order, disabled, expand };
  const cleanup = useRef<(() => void) | null>(null);
  const prepare = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);
  function save(ids: string[]) {
    setSaved(ids);
    try { localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify(ids)); setSaveFailed(false); }
    catch { setSaveFailed(true); }
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === WORKSPACE_ORDER_KEY) setSaved(readOrder()); };
    window.addEventListener('storage', sync);
    return () => { cleanup.current?.(); window.removeEventListener('storage', sync); };
  }, []);
  useEffect(() => {
    if (disabled || (dragging && !workspaces.some(w => w.id === dragging))) cleanup.current?.();
  }, [disabled, dragging, workspaces]);
  const membership = workspaces.map(w => w.id).join('\0');
  useEffect(() => () => cleanup.current?.(), [membership]);
  useLayoutEffect(() => { prepare.current?.(); }, [dragging]);
  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || current.current.disabled || workspaces.length < 2) return;
    // A fresh intentional press is not the synthetic click emitted by a drag.
    suppressClickUntil.current = 0;
    if (!(event.target instanceof Element) || event.target.closest('input,textarea,[contenteditable=true]')) return;
    const row = event.target.closest<HTMLElement>('[data-workspace-sort-id]');
    if (!row) return;
    cleanup.current?.();
    suppressClickUntil.current = 0;
    const root = event.currentTarget;
    const id = row.dataset.workspaceSortId!;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    // Capture the pressed row before expanding: the active row may live elsewhere
    // in the saved order. Its grab point must stay under the pointer.
    const pressedRect = row.getBoundingClientRect();
    const grabY = start.y - pressedRect.top;
    let active = false;
    let settling = false;
    let next = current.current.order;
    let slots: { id: string; element: HTMLElement; top: number; height: number }[] = [];
    let dragged: typeof slots[number] | undefined;
    let latestY = start.y;
    let moved = false;
    let frame = 0;
    let timer: number | undefined;
    let settleTimer: number | undefined;
    let stopMotionWatch = () => {};
    setPressing(id);
    const clearListeners = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('scroll', scroll, true);
      root.removeEventListener('lostpointercapture', lostCapture);
    };
    const reset = () => {
      clearListeners();
      window.clearTimeout(settleTimer);
      stopMotionWatch();
      cancelAnimationFrame(frame);
      prepare.current = null;
      if (active) suppressClickUntil.current = Date.now() + 500;
      // Reset transforms before React moves keyed rows to the committed DOM order.
      // Without this, a transition from the old translation produces a second jump.
      for (const slot of slots) {
        slot.element.style.transition = 'none';
        slot.element.style.removeProperty('transform');
      }
      if (slots.length) root.getBoundingClientRect();
      for (const slot of slots) slot.element.style.removeProperty('transition');
      root.removeAttribute('data-sort-settling');
      for (const name of ['top', 'left', 'width', 'height']) root.style.removeProperty(`--ws-drop-${name}`);
      setPressing(null); setDragging(null); setDraft(null); cleanup.current = null;
      if (root.hasPointerCapture?.(pointerId)) root.releasePointerCapture(pointerId);
    };
    const finish = (commit = false) => {
      if (settling) { reset(); return; }
      clearListeners();
      cancelAnimationFrame(frame);
      if (active) {
        suppressClickUntil.current = Date.now() + 500;
        if (commit) save(next);
        if (dragged && !prefersReducedMotion()) {
          settling = true;
          root.dataset.sortSettling = 'true';
          const target = commit ? next.indexOf(id) : slots.findIndex(slot => slot.id === id);
          for (const slot of slots) {
            const to = commit ? next.indexOf(slot.id) : slots.indexOf(slot);
            slot.element.style.transform = `translateY(${slots[to].top - slot.top}px)`;
          }
          root.style.setProperty('--ws-drop-top', `${slots[target].top - root.getBoundingClientRect().top}px`);
          settleTimer = window.setTimeout(reset, MOTION.panelMs);
          stopMotionWatch = subscribeInteractionPreferences(() => { if (prefersReducedMotion()) reset(); });
          return;
        }
      }
      reset();
    };
    const paint = () => {
      cancelAnimationFrame(frame); // pointerup may flush before the queued RAF runs
      frame = 0;
      if (!dragged || settling) return;
      const top = Math.max(slots[0].top, Math.min(latestY - grabY, slots[slots.length - 1].top));
      const center = top + dragged.height / 2;
      const others = slots.filter(slot => slot.id !== id);
      const index = slots.findIndex((slot, i) => i === slots.length - 1 ||
        center < (slot.top + slot.height / 2 + slots[i + 1].top + slots[i + 1].height / 2) / 2);
      next = others.map(slot => slot.id); next.splice(index, 0, id);
      setPosition(index + 1);
      for (const slot of slots) {
        const y = slot.id === id ? top : slots[next.indexOf(slot.id)].top;
        slot.element.style.transform = `translateY(${y - slot.top}px)`;
      }
      root.style.setProperty('--ws-drop-top', `${slots[index].top - root.getBoundingClientRect().top}px`);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) finish();
        return;
      }
      e.preventDefault();
      latestY = e.clientY;
      moved = true;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const up = (e: PointerEvent) => { if (e.pointerId === pointerId) { if (active && moved) paint(); finish(active); } };
    const cancel = (e?: Event) => {
      if (e instanceof PointerEvent && e.pointerId !== pointerId) return;
      finish();
    };
    const lostCapture = (e: PointerEvent) => { if (!settling && e.pointerId === pointerId) finish(); };
    const scroll = (e: Event) => {
      if (e.target === document || (e.target instanceof Element && e.target.contains(root))) finish();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); } };
    timer = window.setTimeout(() => {
      active = true;
      // Freeze DOM order for the gesture: only transforms move rows. Crossing the
      // first-row/rest boundary must not remount the grabbed button or jitter targets.
      next = [...current.current.order];
      prepare.current = () => {
        prepare.current = null;
        const rows = [...root.querySelectorAll<HTMLElement>('[data-workspace-sort-id]')];
        for (const item of rows) { item.style.transition = 'none'; item.style.transform = 'none'; }
        slots = rows.map(element => {
          const rect = element.getBoundingClientRect();
          return { id: element.dataset.workspaceSortId!, element, top: rect.top, height: rect.height };
        });
        dragged = slots.find(slot => slot.id === id);
        for (const item of rows) item.style.removeProperty('transition');
        if (!dragged) { reset(); return; }
        const rect = dragged.element.getBoundingClientRect(), rootRect = root.getBoundingClientRect();
        root.style.setProperty('--ws-drop-left', `${rect.left - rootRect.left}px`);
        root.style.setProperty('--ws-drop-width', `${rect.width}px`);
        root.style.setProperty('--ws-drop-height', `${rect.height}px`);
        setPosition(next.indexOf(id) + 1);
        // Follow the original grab point, but don't reorder until the user moves.
        dragged.element.style.transform = `translateY(${pressedRect.top - dragged.top}px)`;
        root.style.setProperty('--ws-drop-top', `${dragged.top - rootRect.top}px`);
      };
      current.current.expand();
      setPressing(null); setDragging(id); setDraft(next);
      root.setPointerCapture?.(pointerId);
    }, WORKSPACE_SORT_HOLD_MS);
    cleanup.current = reset;
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('scroll', scroll, true);
    root.addEventListener('lostpointercapture', lostCapture);
  };
  return {
    ordered, dragging, pressing, position, saveFailed,
    props: {
      onPointerDownCapture,
      onClickCapture: (event: ReactMouseEvent) => {
        if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); }
      },
      onContextMenuCapture: (event: ReactMouseEvent) => {
        if (dragging) { event.preventDefault(); event.stopPropagation(); }
        else cleanup.current?.();
      },
      onDragStartCapture: (event: React.DragEvent) => { if (dragging) event.preventDefault(); else cleanup.current?.(); },
      onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (dragging) return;
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || disabled || !(event.target instanceof Element)) return;
        const id = event.target.closest<HTMLElement>('[data-workspace-sort-id]')?.dataset.workspaceSortId;
        if (!id) return;
        const from = order.indexOf(id), to = from + (event.key === 'ArrowUp' ? -1 : 1);
        if (to < 0 || to >= order.length) return;
        event.preventDefault(); event.stopPropagation();
        const next = [...order]; next.splice(from, 1); next.splice(to, 0, id); save(next);
      }
    }
  };
}
