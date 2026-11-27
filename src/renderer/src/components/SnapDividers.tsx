import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { getCenterSplitRatios, type CenterSplitDivider, type CenterSplitPaneState, type SnapPaneRef } from '../../../shared/centerSplit';

interface DividerDrag {
  divider: CenterSplitDivider;
  pointerId: number;
  element: HTMLElement;
  container: HTMLElement;
  base: number;
  size: number;
  ratio: number;
  ratios?: [number, number];
  layoutKey: string;
}

export function SnapDividers({ container, dividers, state, layoutKey, enabled, testId, onChange, onRestore }: {
  container: RefObject<HTMLElement | null>;
  dividers: CenterSplitDivider[];
  state: CenterSplitPaneState<SnapPaneRef>;
  layoutKey: string;
  enabled: boolean;
  testId: string;
  onChange: (index: 0 | 1, ratio: number) => void;
  onRestore: (ratio: number, ratios?: [number, number]) => void;
}) {
  const { t } = useTranslation();
  const drag = useRef<DividerDrag | null>(null);
  const owner = useRef({ layoutKey, enabled, onRestore });
  owner.current = { layoutKey, enabled, onRestore };
  const release = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    current?.container.removeAttribute('data-snap-resizing');
    current?.element.removeAttribute('data-resizing');
    try { current?.element.releasePointerCapture(current.pointerId); } catch { /* The capture may already have ended. */ }
    return current;
  }, []);
  const cancel = useCallback(() => {
    const current = release();
    if (current && owner.current.enabled && owner.current.layoutKey === current.layoutKey) owner.current.onRestore(current.ratio, current.ratios);
  }, [release]);
  useLayoutEffect(() => {
    if (drag.current && (!enabled || drag.current.layoutKey !== layoutKey)) release();
  }, [layoutKey, enabled, release]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const outsideRelease = (event: globalThis.PointerEvent) => {
      const current = drag.current;
      if (current && event.pointerId === current.pointerId && event.buttons === 0 && !current.element.contains(event.target as Node)) cancel();
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('pointerup', outsideRelease);
    window.addEventListener('pointermove', outsideRelease);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pointerup', outsideRelease);
      window.removeEventListener('pointermove', outsideRelease);
      release();
    };
  }, [cancel, release]);

  const start = (event: PointerEvent<HTMLDivElement>, divider: CenterSplitDivider) => {
    if (event.button !== 0 || drag.current || !container.current) return;
    const host = container.current;
    const rect = host.getBoundingClientRect();
    const row = divider.dir === 'row';
    event.preventDefault();
    drag.current = {
      divider, pointerId: event.pointerId, element: event.currentTarget, container: host,
      base: row ? rect.left : rect.top, size: row ? rect.width : rect.height,
      ratio: state.ratio ?? divider.ratio, ratios: dividers.length === 2 ? getCenterSplitRatios(state) : undefined, layoutKey
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.setAttribute('data-resizing', '');
    host.setAttribute('data-snap-resizing', divider.dir);
  };
  return enabled && dividers.map(divider => {
    const row = divider.dir === 'row';
    const decrease = row ? 'ArrowLeft' : 'ArrowUp';
    const increase = row ? 'ArrowRight' : 'ArrowDown';
    return <div key={divider.index} className="center-split-divider" role="separator" tabIndex={0}
      data-testid={divider.index === 0 ? testId : `${testId}-1`}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={`${t('调整分屏比例')}${dividers.length === 2 ? ` ${divider.index + 1}` : ''}`}
      aria-valuemin={Math.round(divider.min * 100)} aria-valuemax={Math.round(divider.max * 100)} aria-valuenow={Math.round(divider.ratio * 100)}
      style={{ left: row ? `calc(${divider.x * 100}% - 4px)` : `${divider.x * 100}%`, top: row ? `${divider.y * 100}%` : `calc(${divider.y * 100}% - 4px)`,
        width: row ? 8 : `${divider.width * 100}%`, height: row ? `${divider.height * 100}%` : 8 }}
      onPointerDown={event => start(event, divider)} onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) release(); }}
      onPointerCancel={cancel} onLostPointerCapture={cancel}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId || current.size <= 0) return;
        if (event.buttons === 0) { cancel(); return; }
        const point = current.divider.dir === 'row' ? event.clientX : event.clientY;
        onChange(current.divider.index, (point - current.base) / current.size);
      }}
      onDoubleClick={() => onChange(divider.index, (divider.min + divider.max) / 2)}
      onKeyDown={event => {
        const value = event.key === 'Home' ? divider.min : event.key === 'End' ? divider.max
          : event.key === decrease ? divider.ratio - .02 : event.key === increase ? divider.ratio + .02 : null;
        if (value == null) return;
        event.preventDefault();
        onChange(divider.index, value);
      }}><span className={row ? 'resize-divider-line' : undefined}/></div>;
  });
}
