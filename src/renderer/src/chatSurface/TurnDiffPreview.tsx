import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { TURN_DIFF_OMITTED, type TurnChangeTarget } from '../../../shared/turnChanges';
import { MOTION, usePresenceValue } from '../components/motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { pageForOverlay, useDismissOnPagePeek } from '../hooks/useDismissOnPagePeek';
import { TurnDiffView } from './TurnDiffView';
import { openTurnReview } from './turnReviewNavigation';

export interface TurnDiffAnchor { file: string; diffOmitted?: boolean; element: HTMLElement }
export function TurnDiffPreview({ anchor, target, onClose, onEnter, onLeave, onDiffError }: {
  anchor: TurnDiffAnchor | null; target: TurnChangeTarget; onClose: () => void; onEnter: () => void; onLeave: () => void; onDiffError?: () => void;
}) {
  const { t } = useTranslation();
  const { value, presence } = usePresenceValue(anchor, MOTION.microMs);
  const strip = value && pageForOverlay(value.element)?.closest<HTMLElement>('.h-strip');
  const panel = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ anchor: TurnDiffAnchor; style: CSSProperties } | null>(null);
  useDismissOnPagePeek(!!anchor, anchor?.element ?? null, onClose);
  useOverlayDismiss(!!anchor, onClose);
  useLayoutEffect(() => {
    if (!value || !panel.current) return;
    const place = () => {
      if (!value.element.isConnected) { onClose(); return; }
      if (pageForOverlay(value.element)?.hasAttribute('data-h-peek')) return;
      const rect = value.element.getBoundingClientRect();
      const bounds = strip?.getBoundingClientRect();
      const card = value.element.closest('.turn-changes-card') ?? value.element;
      const cardRect = card.getBoundingClientRect();
      const width = Math.min(cardRect.width, Math.max(0, window.innerWidth - 24));
      const top = bounds?.top ?? 0;
      const bottom = bounds?.bottom ?? window.innerHeight;
      const below = Math.min(window.innerHeight, bottom) - rect.bottom - 18;
      const above = rect.top - Math.max(0, top) - 18;
      const useBelow = below >= above, maxHeight = Math.max(0, Math.min(500, useBelow ? below : above));
      // Anchor the near edge: asynchronous Diff/font layout must grow away from
      // the row, never measure a zero-width/loading panel and correct a frame later.
      setPlacement({ anchor: value, style: {
        left: Math.max(12, Math.min(cardRect.left, window.innerWidth - width - 12)) - (bounds?.left ?? 0),
        width, maxHeight,
        ...(useBelow ? { top: rect.bottom - top + 6 } : { bottom: bottom - rect.top + 6 })
      } });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(value.element.closest('.turn-changes-card') ?? value.element);
    return () => observer.disconnect();
  }, [value, presence.mounted, onClose, strip]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node) && !anchor.element.contains(event.target as Node)) onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('scroll', outside, true); window.removeEventListener('resize', onClose); };
  }, [anchor, onClose]);
  if (!value || !presence.mounted) return null;
  return createPortal(<div ref={panel} className="turn-diff-preview mp-pop" {...presence.spread} data-h-strip-overlay=""
    style={{ ...placement?.style, visibility: placement?.anchor === value ? undefined : 'hidden' }}
    aria-hidden={!anchor || undefined} {...(!anchor ? { inert: '' } : {})}
    role="region" aria-label={`${value.file} Diff`} onMouseEnter={onEnter} onMouseLeave={onLeave}
    onFocus={onEnter} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) onLeave(); }}>
    <div className="turn-diff-preview-head chat-card-header"><strong>{value.file}</strong><button type="button" className="btn small" onClick={() => { onClose(); openTurnReview(target, value.file); }}>{t('在右侧审阅')}</button></div>
    <div className="turn-diff-preview-body">{value.diffOmitted ? <p className="turn-changes-note">{t(TURN_DIFF_OMITTED)}</p> :
      <TurnDiffView key={value.file} target={target} file={value.file} onError={onDiffError}/>}</div>
  </div>, strip || document.body);
}
