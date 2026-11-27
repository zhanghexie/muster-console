import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MOTION, usePresence } from '../components/motion';
import '../styles/setup-coachmark.css';

export interface SetupCoachmarkProps {
  target: string;
  fallbackTarget?: string;
  title: string;
  children: ReactNode;
  progress?: string;
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Workbench tours allow only the highlighted live control and this card. */
  lockOutside?: boolean;
  /** The board tour also permits its global keyboard/middle-button toggle. */
  allowBoardToggle?: boolean;
  /** Focus the anchor or a specific control inside a highlighted group. */
  focusTarget?: boolean | string;
}

type Geometry = { left: number; top: number; width: number; height: number; x: number; y: number; arrow: number; side: 'above' | 'below' | 'left' | 'right' };

function visibleRect(element: HTMLElement): DOMRect | null {
  if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return null;
  if (element.matches(':disabled, [aria-disabled="true"]')) return null;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent);
    if (css.display === 'none' || css.visibility === 'hidden') return null;
    const box = parent.getBoundingClientRect();
    if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
    if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
  }
  return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null;
}

/** Supplemental, nonmodal guidance: the highlighted control is the original live DOM. */
export function SetupCoachmark({ target, fallbackTarget, title, children, progress, actions, onDismiss, dismissLabel, focusTarget = false, lockOutside = false, allowBoardToggle = false }: SetupCoachmarkProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyId = useId();
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const focusedTarget = useRef<HTMLElement | null>(null);
  const activeAnchor = useRef<HTMLElement | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const lastGeometry = useRef<Geometry | null>(null);
  if (geometry) lastGeometry.current = geometry;
  const presence = usePresence(geometry !== null, MOTION.microMs);

  useLayoutEffect(() => {
    let frame = 0;
    let observed: HTMLElement | null = null;
    const unbindAnchor = () => {
      if (!observed) return;
      observer.unobserve(observed);
      const ids = (observed.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== bodyId);
      if (ids.length) observed.setAttribute('aria-describedby', ids.join(' '));
      else observed.removeAttribute('aria-describedby');
      observed.removeEventListener('keydown', anchorKeyDown);
    };
    const anchorKeyDown = (event: KeyboardEvent) => {
      // A forward Tab from the highlighted control leads directly to its guidance.
      // Descendant text fields keep their ordinary editing and navigation behavior.
      if (event.key !== 'Tab' || event.shiftKey || event.isComposing || event.target !== observed) return;
      const first = card.current?.querySelector<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]');
      if (first) { event.preventDefault(); first.focus(); }
    };
    const observer = new ResizeObserver(() => schedule());
    const measure = () => {
      frame = 0;
      let anchor: HTMLElement | null = null;
      let rect: DOMRect | null = null;
      for (const selector of [target, fallbackTarget]) {
        if (!selector) continue;
        for (const candidate of document.querySelectorAll<HTMLElement>(selector)) {
          const candidateRect = visibleRect(candidate);
          if (candidateRect) { anchor = candidate; rect = candidateRect; break; }
        }
        if (anchor) break;
      }
      if (observed !== anchor) {
        unbindAnchor();
        observed = anchor;
        activeAnchor.current = anchor;
        if (anchor) {
          observer.observe(anchor);
          anchor.setAttribute('aria-describedby', `${anchor.getAttribute('aria-describedby') ?? ''} ${bodyId}`.trim());
          anchor.addEventListener('keydown', anchorKeyDown);
        }
      }
      if (!anchor || !rect) { setGeometry(null); return; }
      if (focusTarget && focusedTarget.current !== anchor) {
        focusedTarget.current = anchor;
        const control = typeof focusTarget === 'string' ? anchor.querySelector<HTMLElement>(focusTarget) : anchor;
        control?.focus({ preventScroll: true });
      }
      const width = card.current?.getBoundingClientRect().width || Math.min(304, innerWidth - 24);
      const height = card.current?.getBoundingClientRect().height || 180;
      let x = Math.max(12, Math.min(innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
      const above = innerHeight - rect.bottom < height + 24 && rect.top > height + 24;
      let y = Math.max(12, Math.min(innerHeight - height - 12, above ? rect.top - height - 16 : rect.bottom + 16));
      let side: Geometry['side'] = above ? 'above' : 'below';
      let arrow = Math.max(18, Math.min(width - 18, rect.left + rect.width / 2 - x));
      if (rect.height > rect.width && (rect.left >= width + 28 || innerWidth - rect.right >= width + 28)) {
        side = rect.left >= width + 28 ? 'left' : 'right';
        x = side === 'left' ? rect.left - width - 16 : rect.right + 16;
        y = Math.max(12, Math.min(innerHeight - height - 12, rect.top + rect.height / 2 - height / 2));
        arrow = Math.max(18, Math.min(height - 18, rect.top + rect.height / 2 - y));
      }
      const next = { left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10, x, y, side, arrow };
      setGeometry(old => old && Object.keys(next).every(key => old[key as keyof Geometry] === next[key as keyof Geometry]) ? old : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const mutations = new MutationObserver(records => {
      if (records.some(record => !root.current?.contains(record.target))) schedule();
    });
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'aria-disabled', 'open', 'disabled', 'data-setup-target'] });
    observer.observe(document.documentElement);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    // Folding transitions change geometry without necessarily resizing the anchor.
    document.addEventListener('transitionend', schedule, true);
    measure();
    if (card.current) observer.observe(card.current);
    return () => {
      cancelAnimationFrame(frame);
      unbindAnchor();
      observer.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('transitionend', schedule, true);
    };
  }, [target, fallbackTarget, focusTarget, title, children, presence.mounted, bodyId]);

  useLayoutEffect(() => {
    if (!lockOutside || !geometry) return;
    const isLocked = () => {
      const anchor = activeAnchor.current;
      return !!anchor?.isConnected && (anchor.matches(target) || !!fallbackTarget && anchor.matches(fallbackTarget));
    };
    const allowed = (node: EventTarget | null) => node instanceof Node && (activeAnchor.current?.contains(node) || card.current?.contains(node));
    const controls = () => {
      const selector = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]';
      const anchor = activeAnchor.current;
      return [...(anchor?.matches(selector) ? [anchor] : []), ...Array.from(anchor?.querySelectorAll<HTMLElement>(selector) ?? []), ...Array.from(card.current?.querySelectorAll<HTMLElement>(selector) ?? [])]
        .filter(node => !node.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
    };
    const focusFirst = () => controls()[0]?.focus({ preventScroll: true });
    const blockOutside = (event: Event) => {
      if (!isLocked() || allowed(event.target)) return;
      if (allowBoardToggle && event instanceof MouseEvent && event.button === 1) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const onFocus = (event: FocusEvent) => { if (isLocked() && !allowed(event.target)) { event.stopImmediatePropagation(); focusFirst(); } };
    const onKey = (event: KeyboardEvent) => {
      if (!isLocked() || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && onDismiss) {
        event.preventDefault(); event.stopImmediatePropagation();
        onDismiss();
      } else if (event.key === 'Tab') {
        const list = controls();
        const index = list.indexOf(document.activeElement as HTMLElement);
        event.preventDefault(); event.stopImmediatePropagation();
        const next = index < 0 ? (event.shiftKey ? list.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + list.length) % list.length;
        list[next]?.focus({ preventScroll: true });
      } else if (!allowed(event.target)) {
        event.preventDefault(); event.stopImmediatePropagation(); focusFirst();
      }
    };
    const pointerEvents = ['pointerdown', 'pointerup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'mousedown', 'mouseup', 'wheel', 'touchmove'] as const;
    pointerEvents.forEach(name => document.addEventListener(name, blockOutside, { capture: true, passive: false }));
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      pointerEvents.forEach(name => document.removeEventListener(name, blockOutside, true));
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [lockOutside, allowBoardToggle, geometry !== null, target, fallbackTarget, onDismiss]);

  const box = geometry ?? lastGeometry.current;
  if (!presence.mounted || !box) return null;
  return createPortal(<div ref={root} className="setup-coachmark-layer" data-setup-coachmark="" data-setup-target={target}
    data-setup-lock={lockOutside && geometry !== null ? 'true' : undefined} data-setup-allow-board={allowBoardToggle ? 'true' : undefined} {...presence.spread}>
    {lockOutside && geometry && <div className="setup-coachmark-blockers" aria-hidden="true">
      <div style={{ left: 0, top: 0, right: 0, height: Math.max(0, box.top) }} />
      <div style={{ left: 0, top: Math.max(0, box.top + box.height), right: 0, bottom: 0 }} />
      <div style={{ left: 0, top: Math.max(0, box.top), width: Math.max(0, box.left), height: box.height }} />
      <div style={{ left: Math.max(0, box.left + box.width), top: Math.max(0, box.top), right: 0, height: box.height }} />
    </div>}
    <div className="setup-coachmark-shade mp-scrim" {...presence.spread} aria-hidden="true" style={{
      '--setup-spot-left': `${box.left}px`, '--setup-spot-right': `${box.left + box.width}px`,
      '--setup-spot-top': `${box.top}px`, '--setup-spot-bottom': `${box.top + box.height}px`
    } as CSSProperties} />
    <div className="setup-coachmark-spotlight mp-scrim" data-setup-spotlight="" {...presence.spread} aria-hidden="true"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
    <div ref={card} className="setup-coachmark-card mp-pop" {...presence.spread} data-overlay-root="" role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={bodyId}
      data-side={box.side} style={{ left: box.x, top: box.y, '--setup-arrow-x': `${box.arrow}px` } as CSSProperties}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && onDismiss) { event.stopPropagation(); onDismiss(); } }}>
      <div className="setup-coachmark-header">
        {progress && <span className="setup-coachmark-progress">{progress}</span>}
        {onDismiss && <button type="button" className="setup-coachmark-dismiss" aria-label={dismissLabel ?? t('关闭引导')} onClick={onDismiss}>×</button>}
      </div>
      <h2 id={titleId}>{title}</h2>
      <div id={bodyId} className="setup-coachmark-body">{children}</div>
      {actions && <div className="setup-coachmark-actions">{actions}</div>}
    </div>
  </div>, document.body);
}
