import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CENTER_SNAP_LAYOUTS, samePaneRef,
  type CenterSnapTarget, type CenterSplitSnapLayout, type SnapPaneRef, type SplitPaneRef
} from '../../../shared/centerSplit';
import { AppLogo } from './AppLogo';
import { IconPuzzle, IconTerminal } from './icons';
import type { Presence } from './motion';

type SnapLayout = (typeof CENTER_SNAP_LAYOUTS)[number];
export interface CenterSnapBarProps<Ref extends SnapPaneRef = SplitPaneRef> {
  layouts?: readonly SnapLayout[];
  currentRefs: readonly Ref[];
  sourceRef: Ref;
  target: CenterSnapTarget | null;
  previewFor: (target: CenterSnapTarget) => CenterSplitSnapLayout<Ref> | null;
  labelFor: (ref: Ref) => string;
  iconFor?: (ref: Ref) => 'chat' | 'terminal' | 'tool';
  renderIcon?: (ref: Ref) => React.ReactNode;
  onDropTarget?: (target: CenterSnapTarget) => void;
  testIdPrefix?: string;
  presenceSpread: Presence['spread'];
  peek?: boolean;
  onPreview: (target: CenterSnapTarget | null) => void;
  onSelect: (target: CenterSnapTarget) => void;
  /** Parent owns dismissal and returns focus to the original pane handle. */
  onDismiss: () => void;
}

const targetKey = (target: CenterSnapTarget): string => `${target.layoutId}:${target.index}`;

/** Miniature destinations only; actual pane contents stay in their existing DOM. */
export function CenterSnapBar<Ref extends SnapPaneRef>({
  layouts = CENTER_SNAP_LAYOUTS, currentRefs, sourceRef, target, previewFor, labelFor,
  iconFor, renderIcon, onDropTarget, testIdPrefix = 'center-snap', presenceSpread, peek = false, onPreview, onSelect, onDismiss
}: CenterSnapBarProps<Ref>): React.JSX.Element {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(target ? targetKey(target) : null);
  const exiting = presenceSpread['data-mp-stage'] === 'out' || peek;
  const occupied = currentRefs.filter((ref, index) => ref.kind !== 'empty' &&
    !currentRefs.slice(0, index).some(previous => samePaneRef(previous, ref)));
  const sourceIndex = Math.max(0, currentRefs.findIndex(ref => samePaneRef(ref, sourceRef)));
  const names: Record<SnapLayout['id'], string> = {
    halves: t('左右均分'), wide: t('左宽右窄'), stack: t('上下均分'),
    focus: t('一大两小'), 'focus-mirror': t('两小一大'), thirds: t('三列均分')
  };
  const groups = layouts.map(layout => {
    const selected = target?.layoutId === layout.id;
    const sample: CenterSnapTarget = selected && target ? target
      : { layoutId: layout.id, index: Math.min(sourceIndex, layout.cells.length - 1) };
    let preview = previewFor(sample);
    // A logical slot keeps content identity through reordering. The current
    // preset's idle thumbnail should show its original physical placement.
    if (!selected && preview?.originalState.layoutId === layout.id) {
      const originalIndex = preview.original.findIndex(ref => samePaneRef(ref, sourceRef));
      const physicalIndex = preview.originalState.order[originalIndex];
      if (Number.isInteger(physicalIndex) && physicalIndex >= 0 && physicalIndex < layout.cells.length && physicalIndex !== sample.index) {
        preview = previewFor({ layoutId: layout.id, index: physicalIndex });
      }
    }
    const disabled = occupied.length > layout.cells.length || !preview;
    return { layout, preview, disabled };
  });
  const enabledTargets = groups.flatMap(({ layout, disabled }) => disabled || exiting ? []
    : layout.cells.map((_, index) => ({ layoutId: layout.id, index })));
  const tabKey = enabledTargets.some(item => targetKey(item) === focusKey) ? focusKey
    : enabledTargets[0] ? targetKey(enabledTargets[0]) : null;
  const focusTarget = (next: CenterSnapTarget): void => {
    const key = targetKey(next);
    setFocusKey(key);
    root.current?.querySelector<HTMLButtonElement>(`[data-center-snap-key="${key}"]`)?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (exiting) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onPreview(null); onDismiss(); return;
    }
    if (!enabledTargets.length) return;
    const currentKey = (event.target as HTMLElement).closest('[data-center-snap-key]')?.getAttribute('data-center-snap-key');
    const current = Math.max(0, enabledTargets.findIndex(item => targetKey(item) === currentKey));
    let next: CenterSnapTarget | undefined;
    if (event.key === 'Home') next = enabledTargets[0];
    else if (event.key === 'End') next = enabledTargets.at(-1);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = enabledTargets[(current + 1) % enabledTargets.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = enabledTargets[(current - 1 + enabledTargets.length) % enabledTargets.length];
    if (next) { event.preventDefault(); event.stopPropagation(); focusTarget(next); }
  };

  return <div ref={element => {
    root.current = element;
    if (exiting) element?.setAttribute('inert', '');
    else element?.removeAttribute('inert');
  }} className="center-snap-bar mp-pop" data-testid={`${testIdPrefix}-${peek ? 'peek' : 'bar'}`}
    role="toolbar" aria-hidden={peek || undefined} aria-label={t('选择分屏布局')} {...presenceSpread}
    onKeyDown={onKeyDown}
    onPointerLeave={() => { if (!exiting) onPreview(null); }}
    onBlurCapture={event => {
      if (!exiting && !event.currentTarget.contains(event.relatedTarget as Node | null)) onPreview(null);
    }}>
    {groups.map(({ layout, preview, disabled }) => <div key={layout.id}
      className={`center-snap-layout${disabled ? ' is-disabled' : ''}`}
      role="group" aria-label={names[layout.id]} aria-disabled={disabled || undefined} data-snap-layout={layout.id}>
      {layout.cells.map((cell, index) => {
        const cellTarget = { layoutId: layout.id, index };
        const logical = preview?.order.indexOf(index) ?? -1;
        const ref = logical >= 0 ? preview!.panes[logical] : undefined;
        const filled = !!ref && ref.kind !== 'empty';
        const source = filled && samePaneRef(ref, sourceRef);
        const active = target?.layoutId === layout.id && target.index === index;
        const kind = ref ? iconFor?.(ref) ?? (ref.kind === 'session' ? 'chat' : 'tool') : 'tool';
        const name = filled ? labelFor(ref) : t('空面板');
        const tooltip = disabled ? t('此布局无法保留所有已打开面板') : name;
        return <button key={index} type="button"
          className={`center-snap-cell${source ? ' is-source' : ''}${filled && !source ? ' is-occupied' : ''}${active ? ' is-active' : ''}`}
          data-testid={`${testIdPrefix}-cell-${layout.id}-${index}`}
          data-center-snap-layout={layout.id} data-center-snap-index={index} data-center-snap-key={targetKey(cellTarget)}
          data-snap-ref-kind={filled ? ref.kind : 'empty'}
          data-snap-ref-id={ref?.kind === 'session' ? ref.sessionId : ref?.kind === 'utility' ? ref.sel : ref?.kind === 'tab' ? ref.tabId : undefined}
          data-tooltip={tooltip} disabled={disabled || exiting}
          aria-label={t('{{layout}}，位置 {{index}}：{{name}}', { layout: names[layout.id], index: index + 1, name })}
          aria-pressed={active} tabIndex={!disabled && !exiting && targetKey(cellTarget) === tabKey ? 0 : -1}
          style={{ left: `${cell.x * 100}%`, top: `${cell.y * 100}%`, width: `${cell.width * 100}%`, height: `${cell.height * 100}%` }}
          onPointerEnter={() => { if (!disabled && !exiting) onPreview(cellTarget); }}
          onPointerLeave={() => { if (!disabled && !exiting) onPreview(null); }}
          onFocus={() => { setFocusKey(targetKey(cellTarget)); if (!disabled && !exiting) onPreview(cellTarget); }}
          onDragOver={onDropTarget && !disabled && !exiting ? event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            onPreview(cellTarget);
          } : undefined}
          onDrop={onDropTarget && !disabled && !exiting ? event => {
            event.preventDefault();
            event.stopPropagation();
            onDropTarget(cellTarget);
          } : undefined}
          onClick={() => { if (!disabled && !exiting) onSelect(cellTarget); }}>
          {filled && <span className="center-snap-ref-icon" aria-hidden>
            {renderIcon ? renderIcon(ref) : kind === 'chat' ? <AppLogo size={16} /> : kind === 'terminal' ? <IconTerminal size={16} /> : <IconPuzzle size={16} />}
          </span>}
        </button>;
      })}
    </div>)}
  </div>;
}
