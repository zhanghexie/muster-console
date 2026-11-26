import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { usePresence } from '../motion';
import './settings-section-jump.css';

type Entry = { label: string; button: HTMLButtonElement };
const JumpContext = createContext<((button: HTMLButtonElement) => void) | null>(null);

/** Resource details use compact, non-interactive section headings. */
export function SettingsDetailHeadingScope({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <JumpContext.Provider value={null}>{children}</JumpContext.Provider>;
}

function scrollContainer(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.classList.contains('settings-tabpane') || /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

function isVisible(element: HTMLElement, boundary: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node && node !== boundary; node = node.parentElement) {
    if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/** A heading remains a heading; its native button opens the current scroll region's index. */
export function SettingsJumpTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  const open = useContext(JumpContext);
  const { t } = useTranslation();
  if (!open) return <>{children}</>;
  return <button type="button" className="settings-jump-title" data-settings-jump-title title={t('快速跳转')}
    onClick={event => open(event.currentTarget)}>{children}</button>;
}

export function SettingsSectionJumpProvider({ children, activeTab }: { children: React.ReactNode; activeTab: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<{ entries: Entry[]; trigger: HTMLButtonElement; container: HTMLElement; host: HTMLElement } | null>(null);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const dialog = useRef<HTMLDivElement | null>(null);
  const destination = useRef<HTMLButtonElement | null>(null);
  const close = (): void => setOpen(false);
  useOverlayDismiss(open, close);
  useEffect(() => { setOpen(false); }, [activeTab]);
  useEffect(() => {
    if (!open || !state || !presence.mounted) return;
    const background = state.host.querySelector<HTMLElement>('.settings-tabpanes');
    const wasInert = background?.inert ?? false;
    if (background) background.inert = true;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (background) background.inert = wasInert;
      const target = destination.current ?? state.trigger;
      destination.current = null;
      if (target.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, state, presence.mounted]);

  const show = (trigger: HTMLButtonElement): void => {
    const container = scrollContainer(trigger);
    const host = trigger.closest<HTMLElement>('.settings-sheet');
    if (!container || !host) return;
    const entries = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-settings-jump-title]'))
      .filter(button => scrollContainer(button) === container && isVisible(button, container))
      .map(button => ({ label: button.textContent?.trim() ?? '', button }));
    setState({ entries, trigger, container, host });
    setOpen(true);
  };
  const jump = (entry: Entry): void => {
    if (!state || !entry.button.isConnected) { close(); return; }
    const header = state.container.classList.contains('settings-tabpane')
      ? state.container.querySelector<HTMLElement>('.settings-pane-title') : null;
    const top = state.container.scrollTop + entry.button.getBoundingClientRect().top - state.container.getBoundingClientRect().top - (header?.offsetHeight ?? 0) - 12;
    state.container.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    destination.current = entry.button;
    close();
  };
  return <JumpContext.Provider value={show}>{children}{presence.mounted && state && createPortal(
    <div className="settings-jump-scrim mp-scrim" {...presence.spread} aria-hidden={!open} data-overlay-root
      onClick={event => { if (!(event.target as HTMLElement).closest('button')) close(); }}>
      <div ref={node => { dialog.current = node; if (node) node.inert = !open; }} className="settings-jump-panel mp-panel" {...presence.spread}
        role="dialog" aria-modal="true" aria-label={t('快速跳转')} onKeyDown={event => {
          if (event.key !== 'Tab') return;
          const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
          if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
        }}>
        <div className="settings-jump-header"><h2>{t('快速跳转')}</h2></div>
        <div className="settings-jump-list">{state.entries.map((entry, index) => <button type="button" key={index}
          className="settings-jump-item" onClick={() => jump(entry)}>{entry.label}</button>)}</div>
      </div>
    </div>, state.host)}</JumpContext.Provider>;
}
