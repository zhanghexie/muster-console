import { useCallback, useLayoutEffect, useRef, type JSX, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

export type SchedulerOverviewSize = { w?: number; h?: number };
type PixelSize = Required<SchedulerOverviewSize>;

type ResizeDrag = {
  handle: HTMLButtonElement;
  slot: HTMLElement;
  scroller: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  startSize: PixelSize;
  startScroll: number;
  fitWidth: number;
  pending: SchedulerOverviewSize;
  frame: number | null;
};

const KEY_STEP = 16;
const KEY_RESIZE: Record<string, SchedulerOverviewSize> = {
  ArrowLeft: { w: -KEY_STEP },
  ArrowRight: { w: KEY_STEP },
  ArrowUp: { h: KEY_STEP },
  ArrowDown: { h: -KEY_STEP }
};

function readSize(slot: HTMLElement): PixelSize {
  return { w: slot.offsetWidth, h: slot.offsetHeight };
}

function previewSize(slot: HTMLElement, size: SchedulerOverviewSize): void {
  for (const axis of ['w', 'h'] as const) {
    const value = size[axis];
    const property = `--scheduler-resize-${axis}`;
    if (value === undefined) slot.style.removeProperty(property);
    else slot.style.setProperty(property, `${Math.max(0, Math.round(value))}px`);
  }
}

function requestedSize(drag: ResizeDrag, event: PointerEvent<HTMLButtonElement>): SchedulerOverviewSize {
  const dx = event.clientX - drag.x + drag.scroller.scrollLeft - drag.startScroll;
  const dy = event.clientY - drag.y;
  const size: SchedulerOverviewSize = {};
  if (dx) {
    // 整排居中时，轨道左侧余量会随列宽改变一半，抵消这段位移可让右上角跟随指针。
    const startEdge = drag.startSize.w + Math.max(0, (drag.fitWidth - drag.startSize.w) / 2);
    const edge = startEdge + dx;
    size.w = edge < drag.fitWidth ? 2 * edge - drag.fitWidth : edge;
  }
  if (dy) size.h = drag.startSize.h - dy;
  return size;
}

export function SchedulerOverviewResize({ workspaceId, name, active, size, onResize }: {
  workspaceId: string;
  name: string;
  active: boolean;
  size?: SchedulerOverviewSize;
  onResize: (workspaceId: string, size: SchedulerOverviewSize) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const drag = useRef<ResizeDrag | null>(null);
  const cancelDrag = useCallback(function cancelDrag(): void {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    window.removeEventListener('blur', cancelDrag);
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    previewSize(current.slot, {});
    delete current.slot.dataset.resizing;
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
  }, []);

  useLayoutEffect(() => cancelDrag, [active, cancelDrag, size]);

  function commit(slot: HTMLElement, start: PixelSize, pending: SchedulerOverviewSize): void {
    previewSize(slot, pending);
    const actual = readSize(slot);
    const next = { ...size };
    let changed = false;
    for (const axis of ['w', 'h'] as const) {
      if (pending[axis] === undefined || actual[axis] === start[axis]) continue;
      next[axis] = actual[axis];
      changed = true;
    }
    previewSize(slot, {});
    if (changed) onResize(workspaceId, next);
  }

  return (
    <button type="button" className="agent-panel-resizer scheduler-overview-resizer" disabled={!active}
      aria-label={t('调整 {{name}} 面板大小', { name })} title={t('拖动调整大小（方向键微调）')}
      onPointerDown={event => {
        if (!active || drag.current || event.button !== 0 || event.isPrimary === false) return;
        const handle = event.currentTarget;
        const slot = handle.closest<HTMLElement>('[data-scheduler-workspace]');
        const track = slot?.parentElement;
        const scroller = track?.parentElement;
        if (!slot || !track || !scroller) return;
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
        handle.focus({ preventScroll: true });
        const startSize = readSize(slot);
        drag.current = {
          handle, slot, scroller, startSize, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          startScroll: scroller.scrollLeft, fitWidth: scroller.clientWidth - track.offsetWidth + startSize.w,
          pending: {}, frame: null
        };
        slot.dataset.resizing = '';
        window.addEventListener('blur', cancelDrag);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || event.pointerId !== current.pointerId) return;
        current.pending = requestedSize(current, event);
        current.frame ??= requestAnimationFrame(() => {
          current.frame = null;
          previewSize(current.slot, current.pending);
        });
      }}
      onPointerUp={event => {
        const current = drag.current;
        if (!current || event.pointerId !== current.pointerId) return;
        commit(current.slot, current.startSize, requestedSize(current, event));
        cancelDrag();
      }}
      onPointerCancel={event => { if (event.pointerId === drag.current?.pointerId) cancelDrag(); }}
      onLostPointerCapture={event => { if (event.pointerId === drag.current?.pointerId) cancelDrag(); }}
      onBlur={cancelDrag}
      onKeyDown={event => {
        if (!Object.hasOwn(KEY_RESIZE, event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const slot = event.currentTarget.closest<HTMLElement>('[data-scheduler-workspace]');
        if (!slot || drag.current) return;
        event.preventDefault();
        const step = KEY_RESIZE[event.key];
        const start = readSize(slot);
        commit(slot, start, {
          w: step.w === undefined ? undefined : start.w + step.w,
          h: step.h === undefined ? undefined : start.h + step.h
        });
      }} />
  );
}
