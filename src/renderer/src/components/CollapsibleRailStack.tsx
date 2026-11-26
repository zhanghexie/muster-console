import React, { Children, useLayoutEffect, useRef, useState } from 'react';
import { usePresence } from './motion';

type RailGeometry = { full: number; folded: number; anchor: number; x: number; y: number; width: number; height: number;
  offsets: { x: number; y: number }[] };
type LayoutInputs = { keyOrder: string; anchor: number; collapsed: boolean; className: string; keepFirstRow: boolean };
const GEOMETRY_FIELDS = ['full', 'folded', 'anchor', 'x', 'y', 'width', 'height'] as const;
function geometryEqual(a: RailGeometry, b: RailGeometry): boolean {
  return GEOMETRY_FIELDS.every(key => a[key] === b[key]) && a.offsets.length === b.offsets.length &&
    a.offsets.every((offset, index) => offset.x === b.offsets[index]!.x && offset.y === b.offsets[index]!.y);
}
function stackKey(node: React.ReactNode, index: number): string {
  return React.isValidElement(node) ? String(node.key ?? index).replace(/^\.\$/, '') : String(index);
}
function selectedIndex(body: HTMLElement, items: HTMLElement[], activeKey?: string | null): number {
  const active = activeKey ? items.findIndex(item => item.dataset.stackKey === activeKey) : -1;
  if (active >= 0) return active;
  // Fallback selection is an attribute query only; it does not resolve style/layout.
  let selected = body.querySelector<HTMLElement>('.is-pane-focused, [data-pane-focused="true"], [aria-pressed="true"]');
  while (selected && selected.parentElement !== body) selected = selected.parentElement;
  return Math.max(0, selected ? items.indexOf(selected) : -1);
}

/** Retain each item's DOM and natural layout; collapse only the viewport and transforms. */
export function CollapsibleRailStack({ collapsed, activeKey, children, className, onKeyDown, tabIndex, paused = false, keepFirstRow = false }:
  { collapsed: boolean; activeKey?: string | null; children?: React.ReactNode; className: string;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>; tabIndex?: number; paused?: boolean; keepFirstRow?: boolean }): React.JSX.Element {
  const presence = usePresence(!collapsed);
  const layout = useRef<HTMLDivElement>(null);
  const nodes = Children.toArray(children);
  const keyOrder = JSON.stringify(nodes.map(stackKey));
  const measuredInputs = useRef<LayoutInputs | null>(null);
  const wasPaused = useRef(false);
  const [geometry, setGeometry] = useState<RailGeometry>({ full: 0, folded: 0, anchor: 0, x: 0, y: 0, width: 0, height: 0, offsets: [] });
  const measure = useRef<(items?: HTMLElement[], anchor?: number) => void>(() => {});
  measure.current = (knownItems, knownAnchor) => {
    if (paused) return;
    const body = layout.current;
    if (!body) return;
    const items = knownItems ?? [...body.children] as HTMLElement[];
    const anchor = keepFirstRow ? 0 : knownAnchor ?? selectedIndex(body, items, activeKey);
    const first = items[0], chosen = items[anchor];
    const x = first?.offsetLeft ?? 0, y = first?.offsetTop ?? 0;
    const width = chosen?.offsetWidth ?? 0, height = chosen?.offsetHeight ?? 0;
    const offsets = items.map(item => ({ x: x - item.offsetLeft, y: y - item.offsetTop }));
    let folded = chosen ? y + height + 8 : 0;
    if (keepFirstRow && first) {
      const rowHeight = items.reduce((max, item, index) => offsets[index]?.y === 0 ? Math.max(max, item.offsetHeight) : max, 0);
      const paddingEnd = Number.parseFloat(getComputedStyle(body).paddingBlockEnd) || 0;
      folded = y + rowHeight + paddingEnd;
    }
    const next = { full: body.offsetHeight, folded, anchor, x, y, width, height, offsets };
    measuredInputs.current = { keyOrder, anchor, collapsed, className, keepFirstRow };
    setGeometry(previous => geometryEqual(previous, next) ? previous : next);
  };
  useLayoutEffect(() => {
    const body = layout.current;
    if (!body) return;
    if (paused) {
      wasPaused.current = true;
      return;
    }
    const items = [...body.children] as HTMLElement[];
    const anchor = keepFirstRow ? 0 : selectedIndex(body, items, activeKey);
    const previous = measuredInputs.current;
    // JSX is recreated by parent state ticks. Only actual row identity/order, selection
    // or layout mode needs a synchronous measurement; size changes arrive before paint via RO.
    const resumed = wasPaused.current;
    wasPaused.current = false;
    if (resumed || !previous || previous.keyOrder !== keyOrder || previous.anchor !== anchor ||
        previous.collapsed !== collapsed || previous.className !== className || previous.keepFirstRow !== keepFirstRow) measure.current(items, anchor);
  }, [paused, keyOrder, activeKey, collapsed, className, keepFirstRow]);
  useLayoutEffect(() => {
    if (!layout.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(layout.current, { box: 'border-box' });
    // A row may resize/reflow within a multi-column grid without changing total body size.
    for (const item of layout.current.children) observer.observe(item, { box: 'border-box' });
    return () => observer.disconnect();
  }, [keyOrder]);
  const style = { '--rail-full': `${geometry.full}px`, '--rail-folded': `${geometry.folded}px`,
    '--rail-preview-x': `${geometry.x}px`, '--rail-preview-y': `${geometry.y}px`,
    '--rail-preview-w': `${geometry.width}px`, '--rail-preview-h': `${geometry.height}px` } as React.CSSProperties;
  const previewClass = keepFirstRow ? ' rail-stack-first-row' : nodes.length > 1 ? ' has-rest' : '';
  return <div className={`rail-stack acc${!collapsed && presence.stage === 'in' ? ' is-open' : ''}${collapsed ? ' is-collapsed' : ''}${previewClass}`}
    {...presence.spread} style={style} data-preview-index={geometry.anchor}>
    <div className="acc-body">
      <div ref={layout} className={`rail-stack-layout ${className}`} tabIndex={tabIndex} onKeyDown={collapsed ? undefined : onKeyDown}>
        {nodes.map((node, index) => {
          const key = stackKey(node, index);
          const offset = geometry.offsets[index];
          const retained = keepFirstRow ? offset?.y === 0 : index === geometry.anchor;
          return <div key={key} className={`rail-stack-item${retained ? ' is-preview' : ''}`} data-stack-key={key}
            aria-hidden={collapsed && !retained ? true : undefined}
            ref={element => { if (element) { if (collapsed && !retained) element.setAttribute('inert', ''); else element.removeAttribute('inert'); } }}
            style={{ '--rail-shift-x': `${offset?.x ?? 0}px`, '--rail-shift-y': `${offset?.y ?? 0}px` } as React.CSSProperties}>
            {node}
          </div>;
        })}
      </div>
    </div>
  </div>;
}
