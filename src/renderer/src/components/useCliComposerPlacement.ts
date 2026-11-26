import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import {
  clampCliComposerDimensions, clampCliComposerPoint, cliComposerDialogPlacement, DEFAULT_CLI_COMPOSER_ANCHOR,
  parseCliComposerAnchor, parseCliComposerDimensions, pointForCliComposerAnchor, resizeCliComposerWidth, snapCliComposerPoint,
  type CliComposerAnchor, type CliComposerDimensions, type CliComposerPoint, type CliComposerResizeEdge, type CliComposerSize
} from './cliComposerPlacement';

const POSITION_KEY = 'muster.cli-composer-position:';
const SIZE_KEY = 'muster.cli-composer-size:';
const DRAG_THRESHOLD = 4;
const EMPTY_SIZE: CliComposerSize = { width: 0, height: 0, capsuleWidth: 0, capsuleHeight: 0, dialogHeight: 0 };

interface DragState {
  id: number; startX: number; startY: number; scaleX: number; scaleY: number;
  origin: CliComposerPoint; latest: CliComposerPoint; moved: boolean;
  startRightInset: number | null; latestRightInset: number | null;
}
interface ResizeState {
  id: number; startX: number; scaleX: number; edge: CliComposerResizeEdge;
  start: CliComposerDimensions; latest: CliComposerDimensions; previous: CliComposerDimensions | null; moved: boolean;
}

/** Local pointer interaction only: the PTY container never changes size. */
export function useCliComposerPlacement(args: {
  sessionId: string; visible: boolean; open: boolean;
  viewRef: React.RefObject<HTMLDivElement | null>;
  capsuleRef: React.RefObject<HTMLElement | null>;
  dialogRef: React.RefObject<HTMLElement | null>;
  onPersistenceError: () => void;
  resizable?: boolean;
  onResizePersistenceError?: () => void;
}): {
  capsuleStyle: React.CSSProperties; dialogStyle: React.CSSProperties; popupStyle: React.CSSProperties; popupBelow: boolean;
  reminderPopupStyle: React.CSSProperties; reminderPopupBelow: boolean; dragging: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: () => void;
  onResizePointerDown: (event: React.PointerEvent<HTMLButtonElement>, edge: CliComposerResizeEdge) => void;
  onResizePointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onResizePointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onResizePointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onResizeLostPointerCapture: () => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, edge: CliComposerResizeEdge) => void;
} {
  const { sessionId, visible, open, viewRef, capsuleRef, dialogRef, onPersistenceError, resizable = false,
    onResizePersistenceError = onPersistenceError } = args;
  const loadFailed = useRef(false);
  const sizeLoadFailed = useRef(false);
  const [anchor, setAnchor] = useState<CliComposerAnchor>(() => {
    try { return parseCliComposerAnchor(localStorage.getItem(POSITION_KEY + sessionId)); }
    catch { loadFailed.current = true; return DEFAULT_CLI_COMPOSER_ANCHOR; }
  });
  const [size, setSize] = useState<CliComposerSize>(EMPTY_SIZE);
  const [dimensions, setDimensions] = useState<CliComposerDimensions | null>(() => {
    if (!resizable) return null;
    try { return parseCliComposerDimensions(localStorage.getItem(SIZE_KEY + sessionId)); }
    catch { sizeLoadFailed.current = true; return null; }
  });
  const dimensionsRef = useRef(dimensions); dimensionsRef.current = dimensions;
  const [liveRightInset, setLiveRightInset] = useState<number | null>(null);
  const clamped = dimensions && size.width > 0 && size.height > 0 ? clampCliComposerDimensions(dimensions, size) : dimensions;
  const applied = clamped && liveRightInset != null ? { ...clamped, rightInset: liveRightInset } : clamped;
  const geometry: CliComposerSize = { ...size, dialogWidth: applied?.width ?? size.dialogWidth };
  const sizeRef = useRef(geometry); sizeRef.current = geometry;
  const [livePoint, setLivePoint] = useState<CliComposerPoint | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);
  const resize = useRef<ResizeState | null>(null);
  const frame = useRef<number | null>(null);
  const point = livePoint ?? pointForCliComposerAnchor(anchor, size);

  useEffect(() => {
    if (!loadFailed.current) return;
    loadFailed.current = false;
    onPersistenceError();
  }, [onPersistenceError]);
  useEffect(() => {
    if (!sizeLoadFailed.current) return;
    sizeLoadFailed.current = false;
    onResizePersistenceError();
  }, [onResizePersistenceError]);

  useLayoutEffect(() => {
    let observer: ResizeObserver | null = null;
    let pending: number | null = null;
    const measure = (): void => {
      const view = viewRef.current, capsule = capsuleRef.current, dialog = dialogRef.current;
      if (!view || !capsule || !dialog) return;
      const viewRect = view.getBoundingClientRect(), capsuleRect = capsule.getBoundingClientRect();
      const next: CliComposerSize = { width: view.clientWidth || viewRect.width, height: view.clientHeight || viewRect.height,
        capsuleWidth: capsule.offsetWidth || capsuleRect.width, capsuleHeight: capsule.offsetHeight || capsuleRect.height,
        dialogHeight: dialog.offsetHeight || dialog.getBoundingClientRect().height,
        dialogWidth: dialog.offsetWidth || dialog.getBoundingClientRect().width };
      if (!next.width || !next.height) return;
      setSize(previous => Object.keys(next).every(key => previous[key as keyof CliComposerSize] === next[key as keyof CliComposerSize]) ? previous : next);
    };
    const start = (): void => {
      const view = viewRef.current, capsule = capsuleRef.current, dialog = dialogRef.current;
      if (!view || !capsule || !dialog) return;
      measure();
      observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
      observer?.observe(view); observer?.observe(capsule); observer?.observe(dialog);
    };
    // A child layout effect can run before React attaches the parent view's ref.
    if (viewRef.current && capsuleRef.current && dialogRef.current) start();
    else pending = requestAnimationFrame(start);
    window.addEventListener('resize', measure);
    return () => { if (pending != null) cancelAnimationFrame(pending); observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [visible, viewRef, capsuleRef, dialogRef]);

  useLayoutEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
  }, []);

  const resetDrag = (): void => {
    if (frame.current != null) { cancelAnimationFrame(frame.current); frame.current = null; }
    setLivePoint(null); setLiveRightInset(null); setDragging(false); drag.current = null;
  };
  const persistDimensions = (next: CliComposerDimensions): void => {
    try { localStorage.setItem(SIZE_KEY + sessionId, JSON.stringify(next)); } catch { onResizePersistenceError(); }
  };
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || event.isPrimary === false || !viewRef.current || resize.current) return;
    event.preventDefault();
    const rect = viewRef.current.getBoundingClientRect();
    const currentSize = sizeRef.current;
    const capsulePoint = pointForCliComposerAnchor(anchor, currentSize);
    // 展开态可能因靠边而被限制位置；以实际输入区中心为拖动起点，避免初次移动出现死区。
    const dialogTop = cliComposerDialogPlacement(capsulePoint, currentSize, dimensionsRef.current?.bottomOffset).top;
    const origin = open && currentSize.dialogHeight > 0
      ? clampCliComposerPoint({ x: capsulePoint.x, y: dimensionsRef.current
          ? dialogTop + currentSize.dialogHeight - dimensionsRef.current.bottomOffset - currentSize.capsuleHeight / 2
          : dialogTop + (currentSize.dialogHeight - currentSize.capsuleHeight) / 2 }, currentSize)
      : capsulePoint;
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
      scaleX: rect.width && currentSize.width ? rect.width / currentSize.width : 1,
      scaleY: rect.height && currentSize.height ? rect.height / currentSize.height : 1,
      origin, latest: origin, moved: false, startRightInset: open && applied ? applied.rightInset : null,
      latestRightInset: open && applied ? applied.rightInset : null };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture may be unavailable */ }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = (event.clientX - current.startX) / current.scaleX, dy = (event.clientY - current.startY) / current.scaleY;
    if (!current.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
    if (!current.moved) { current.moved = true; setDragging(true); }
    current.latest = clampCliComposerPoint({ x: current.origin.x + dx, y: current.origin.y + dy }, sizeRef.current);
    if (current.startRightInset != null) {
      const maxInset = Math.max(0, sizeRef.current.width - 16 - (sizeRef.current.dialogWidth ?? 0));
      current.latestRightInset = Math.max(0, Math.min(maxInset, current.startRightInset - dx));
    }
    if (frame.current == null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (drag.current?.moved) {
        setLivePoint(drag.current.latest);
        setLiveRightInset(drag.current.latestRightInset);
      }
    });
    event.preventDefault();
  };
  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    if (current.moved) {
      const next = snapCliComposerPoint(current.latest, sizeRef.current);
      setAnchor(next);
      try { localStorage.setItem(POSITION_KEY + sessionId, JSON.stringify(next)); } catch { onPersistenceError(); }
      if (current.latestRightInset != null && dimensionsRef.current) {
        const nextDimensions = { ...dimensionsRef.current, rightInset: current.latestRightInset };
        dimensionsRef.current = nextDimensions;
        setDimensions(nextDimensions);
        persistDimensions(nextDimensions);
      }
    }
    resetDrag();
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  const onPointerCancel = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (drag.current?.id !== event.pointerId) return;
    resetDrag();
  };
  const onLostPointerCapture = (): void => {
    if (!drag.current) return;
    resetDrag();
  };
  const placement = cliComposerDialogPlacement(point, geometry, applied?.bottomOffset, applied?.rightInset);
  const resizeStart = (): CliComposerDimensions | null => {
    if (!resizable || !open || !geometry.width || !geometry.height || !geometry.dialogHeight) return null;
    const bottom = placement.top + geometry.dialogHeight;
    return { width: geometry.dialogWidth || Math.max(1, geometry.width - 16),
      bottomOffset: bottom - point.y - geometry.capsuleHeight / 2, rightInset: applied?.rightInset ?? 0 };
  };
  const onResizePointerDown = (event: React.PointerEvent<HTMLButtonElement>, edge: CliComposerResizeEdge): void => {
    if (event.button !== 0 || event.isPrimary === false || !viewRef.current || resize.current || drag.current) return;
    const start = resizeStart();
    if (!start) return;
    event.preventDefault(); event.stopPropagation();
    const rect = viewRef.current.getBoundingClientRect();
    resize.current = { id: event.pointerId, startX: event.clientX, edge,
      scaleX: rect.width && geometry.width ? rect.width / geometry.width : 1,
      start, latest: start, previous: dimensionsRef.current, moved: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture may be unavailable */ }
  };
  const onResizePointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const current = resize.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = (event.clientX - current.startX) / current.scaleX;
    if (!current.moved && Math.abs(dx) <= DRAG_THRESHOLD) return;
    current.moved = true;
    current.latest = resizeCliComposerWidth(current.start, sizeRef.current, current.edge, dx);
    dimensionsRef.current = current.latest;
    setDimensions(current.latest);
    event.preventDefault(); event.stopPropagation();
  };
  const onResizePointerUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const current = resize.current;
    if (!current || current.id !== event.pointerId) return;
    resize.current = null;
    if (current.moved) persistDimensions(current.latest);
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    event.stopPropagation();
  };
  const cancelResize = (): void => {
    const current = resize.current;
    if (!current) return;
    resize.current = null;
    dimensionsRef.current = current.previous;
    setDimensions(current.previous);
  };
  const onResizePointerCancel = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (resize.current?.id === event.pointerId) cancelResize();
  };
  const onResizeLostPointerCapture = (): void => { cancelResize(); };
  const onResizeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, edge: CliComposerResizeEdge): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const start = resizeStart();
    if (!start) return;
    const step = event.shiftKey ? 48 : 16;
    let dx: number;
    if (event.key === 'ArrowLeft') dx = -step;
    else if (event.key === 'ArrowRight') dx = step;
    else return;
    event.preventDefault(); event.stopPropagation();
    const next = resizeCliComposerWidth(start, geometry, edge, dx);
    dimensionsRef.current = next;
    setDimensions(next);
    persistDimensions(next);
  };
  useEffect(() => {
    if (!visible || !open) cancelResize();
    window.addEventListener('blur', cancelResize);
    return () => window.removeEventListener('blur', cancelResize);
  }, [visible, open]);

  const above = Math.max(0, placement.top - 8);
  const below = Math.max(0, geometry.height - placement.top - geometry.dialogHeight - 8);
  const overlap = Math.max(above, below) < 72;
  const popupBelow = overlap || (above < 180 && below > above);
  const popupTop = overlap ? 8 : popupBelow ? placement.top + geometry.dialogHeight : placement.top;
  const popupHeight = overlap ? Math.max(0, geometry.height - 16) : popupBelow ? below : above;
  // Anchor reminders near the bottom toolbar, allowing them to cover the editor.
  const reminderTop = Math.max(8, Math.min(geometry.height - 8, placement.top + geometry.dialogHeight - 38));
  const reminderAbove = Math.max(0, reminderTop - 8);
  const reminderBelow = Math.max(0, geometry.height - reminderTop - 8);
  const reminderPopupBelow = reminderAbove < 180 && reminderBelow > reminderAbove;
  const reminderHeight = reminderPopupBelow ? reminderBelow : reminderAbove;
  return {
    capsuleStyle: { transform: `translate(${point.x}px, ${point.y}px)` },
    dialogStyle: { top: placement.top, right: applied ? `${applied.rightInset + 8}px` : undefined,
      width: applied ? `${applied.width}px` : undefined,
      transformOrigin: `${placement.originX}% ${placement.originY}%`,
      '--cli-expand-scale-x': placement.scaleX, '--cli-expand-scale-y': placement.scaleY } as React.CSSProperties,
    popupStyle: { top: popupTop, left: applied ? 'auto' : undefined, right: applied ? `${applied.rightInset + 8}px` : undefined,
      width: applied ? `${applied.width}px` : undefined,
      '--cli-popup-max-height': `${popupHeight}px` } as React.CSSProperties,
    reminderPopupStyle: { top: reminderTop, left: applied ? 'auto' : undefined, right: applied ? `${applied.rightInset + 8}px` : undefined,
      width: applied ? `${applied.width}px` : undefined,
      '--cli-popup-max-height': `${reminderHeight}px` } as React.CSSProperties,
    reminderPopupBelow,
    popupBelow,
    dragging, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture,
    onResizePointerDown, onResizePointerMove, onResizePointerUp, onResizePointerCancel, onResizeLostPointerCapture, onResizeKeyDown
  };
}
