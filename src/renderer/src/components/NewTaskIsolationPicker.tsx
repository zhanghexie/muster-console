import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { IconChevronDown } from './icons';
import { MOTION, usePresence } from './motion';
import type { useWorktreeSelection } from './useWorktreeSelection';
import { WorktreeSelectionFields } from './WorktreeSelectionFields';

/** Isolation and repository selection live in a popup, never in the dialog's layout. */
export function NewTaskIsolationPicker({
  dialogOpen, disabled, isolate, hasUncommittedChanges, onChange, selection, scopeLabel
}: {
  dialogOpen: boolean;
  disabled: boolean;
  isolate: boolean;
  hasUncommittedChanges?: boolean;
  onChange: (value: boolean) => void;
  selection: ReturnType<typeof useWorktreeSelection>;
  scopeLabel: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const visible = open && dialogOpen && !disabled;
  const presence = usePresence(visible, MOTION.menuMs);
  const details = usePresence(visible && isolate);
  const id = React.useId();

  const close = useCallback((restoreFocus = true): void => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  useOverlayDismiss(visible, () => close());
  useEffect(() => { if (!dialogOpen || disabled) setOpen(false); }, [dialogOpen, disabled]);
  useLayoutEffect(() => { if (panel.current) panel.current.inert = !visible; }, [visible, presence.mounted]);

  const place = useCallback((): void => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(0, Math.min(440, window.innerWidth - 24));
    const below = Math.max(0, window.innerHeight - rect.bottom - 16);
    const above = Math.max(0, rect.top - 16);
    const showBelow = below >= Math.min(260, window.innerHeight - 24) || below >= above;
    const maxHeight = Math.max(0, Math.min(440, showBelow ? below : above));
    const height = Math.min(maxHeight, panel.current?.offsetHeight ?? 180);
    const next = {
      width,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: showBelow ? rect.bottom + 4 : Math.max(12, rect.top - height - 4),
      maxHeight
    };
    setPosition(previous => previous && previous.left === next.left && previous.top === next.top &&
      previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next);
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    place();
    const dismiss = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target && (panel.current?.contains(target) || trigger.current?.contains(target))) return;
      close(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [visible, place, close]);

  useLayoutEffect(() => {
    if (!visible || !position || !panel.current) return;
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(panel.current);
    panel.current.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
    return () => observer?.disconnect();
  }, [visible, presence.mounted, !!position, place]);

  return <div className="new-task-field">
    <span>{t('工作区隔离')}</span>
    <button ref={trigger} type="button" className="c-select-trigger" disabled={disabled || !dialogOpen}
      aria-label={t('工作区隔离')} aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? id : undefined}
      onClick={() => setOpen(value => !value)}>
      <span className="c-select-value">{isolate ? `${t('隔离运行')} · ${scopeLabel}` : t('共享检出')}</span>
      <IconChevronDown size={12} className={`c-select-caret${visible ? ' is-open' : ''}`}/>
    </button>
    {presence.mounted && position ? createPortal(<div id={id} ref={panel} role="dialog" data-overlay-root="" aria-label={t('工作区隔离')}
      aria-hidden={!visible || undefined} className="c-select-menu new-task-isolation-menu mp-pop" data-mp-stage={presence.stage}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="new-task-isolation-options" role="radiogroup" aria-label={t('工作区隔离')}
        onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          const next = !isolate;
          onChange(next);
          panel.current?.querySelector<HTMLButtonElement>(`[role="radio"][data-isolate="${next}"]`)?.focus({ preventScroll: true });
        }}>
        {[false, true].map(value => <button key={String(value)} type="button" role="radio" data-isolate={String(value)} disabled={!visible}
          aria-checked={isolate === value} className={`new-task-isolation-option${isolate === value ? ' is-selected' : ''}`}
          onClick={() => onChange(value)}>{value ? <>{t('隔离运行')}{hasUncommittedChanges
            ? <span className="new-task-isolation-option-description">{t('不包含主仓未提交的改动')}</span> : null}</> : t('共享检出')}</button>)}
      </div>
      {details.mounted ? <div className={`acc${details.stage === 'in' ? ' is-open' : ''}`} {...details.spread}>
        <div className="acc-body" aria-hidden={!visible || !isolate} ref={node => { if (node) node.inert = !visible || !isolate; }}>
          <div className="new-task-isolation-repositories"><WorktreeSelectionFields selection={selection} disabled={!visible || !isolate} /></div>
        </div>
      </div> : null}
    </div>, document.body) : null}
  </div>;
}
