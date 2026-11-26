import { ErrorTip } from './ErrorTip';
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { Presence } from './motion';
import { IconChevronDown, IconRefresh } from './icons';
import { useSafetySurface } from '../chatSurface/safetySurface';
import { SafetyChatView } from './SafetyChatView';
import { ChatResetDialog, type ChatResetTarget } from './ChatResetDialog';
import './safety-panel.css';

export function SafetyIcon(): React.JSX.Element {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 4.5 6v5c0 4.6 3 8.1 7.5 10 4.5-1.9 7.5-5.4 7.5-10V6L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-4.8"/>
  </svg>;
}

/** Opening reads state; resetting the shared workspace conversation requires confirmation. */
export function SafetyPanel({ workspaceId, open, presence, triggerRef, onClose }: {
  workspaceId: string; open: boolean; presence: Presence;
  triggerRef: React.RefObject<HTMLButtonElement | null>; onClose: (restoreFocus?: boolean) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const surface = useSafetySurface(workspaceId, open);
  const { snapshot, error } = useSyncExternalStore(surface.subscribe, surface.getViewState);
  const [resetTarget, setResetTarget] = useState<ChatResetTarget | null>(null);
  useEffect(() => setResetTarget(null), [workspaceId, open, surface]);
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useLayoutEffect(() => { if (open && presence.mounted) sheetRef.current?.focus({ preventScroll: true }); }, [open, presence.mounted, workspaceId]);
  useEffect(() => {
    if (!open) return;
    const consume = (event: Event): void => { event.preventDefault(); event.stopPropagation(); };
    const onKey = (event: KeyboardEvent): void => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key === 'Escape') { closeRef.current(true); consume(event); }
    };
    const onClick = (event: MouseEvent): void => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const target = event.target;
      if (!(target instanceof Node) || sheetRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // Pointer capture delivers the resize gesture's final click to the host handle.
      if (target instanceof Element && target.closest('.agent-panel-resizer') && target.closest('.agent-float-panel') === sheetRef.current?.closest('.agent-float-panel')) return;
      // Adjacent subsystem buttons own their own switch; don't consume that click.
      if (target instanceof Element && target.closest('.agent-memory-toggle,.agent-phone-toggle,.agent-phone-panel,.agent-ws-overview-btn')) return;
      if (target instanceof Element && target.closest('[role="dialog"],[role="alertdialog"]')) return;
      closeRef.current(); consume(event);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onClick, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('click', onClick, true); };
  }, [open, triggerRef]);
  if (!presence.mounted) return null;
  return <><ChatResetDialog target={open && resetTarget?.workspaceId === workspaceId && resetTarget.surface === surface ? resetTarget : null}
    onClose={() => setResetTarget(null)}/>
  <div className="agent-memory-sheet-host agent-safety-sheet-host">
    <div className="agent-memory-sheet-backdrop mp-scrim" {...presence.spread} aria-hidden="true" />
    <section ref={sheetRef} id={`agent-safety-sheet-${workspaceId}`} className="agent-memory-sheet agent-safety-sheet mp-panel"
      data-agent-purpose="safety" role="dialog" aria-label={t('安全子系统')} tabIndex={-1} aria-hidden={!open}
      {...presence.spread} {...(!open ? { inert: '' as unknown as boolean } : {})}>
      <header className="agent-memory-sheet-header">
        <button type="button" className="agent-chat-clear-btn agent-panel-icon-btn" aria-label={t('重置审批会话')} title={t('重置审批会话，保留放行规则和审批事项记录')} disabled={!open || !snapshot}
          onClick={() => setResetTarget({ workspaceId, purpose: 'safety', surface })}><IconRefresh size={18}/></button>
        <h2>{t('安全子系统')}</h2>
        <button type="button" className="agent-chat-clear-btn agent-panel-icon-btn" aria-label={t('关闭安全子系统')} title={t('收起')} disabled={!open} onClick={() => onClose(true)}><IconChevronDown size={18}/></button>
      </header>
      <SafetyChatView key={workspaceId} surface={surface} workspaceId={workspaceId} active={open} disabled={!open}/>
      {error && <ErrorTip message={error} />}
    </section>
  </div></>;
}
