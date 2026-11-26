import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RightContent } from '../../../shared/rightWorkspace';
import { useSessionStore, useUiStore, useWorkspaceStore } from '../store';
import { usePresenceValue } from '../components/motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { TurnReviewPanel } from '../panels/TurnReviewPanel';

type Review = Extract<RightContent, { kind: 'review' }>;

/** The mobile shell consumes the same review request without depending on a desktop dock. */
export function MobileTurnReview({ navigationKey }: { navigationKey: string }) {
  const { t } = useTranslation();
  const { openTurnReview, clearTurnReview } = useUiStore();
  const { activeWorkspaceId } = useWorkspaceStore();
  const { activeId } = useSessionStore();
  const scope = JSON.stringify([activeWorkspaceId, activeId, navigationKey]);
  const [review, setReview] = useState<{ scope: string; content: Review } | null>(null);
  const current = review?.scope === scope ? review.content : null;
  const { value, presence } = usePresenceValue(current);
  const close = useCallback(() => setReview(null), []);
  useOverlayDismiss(!!current, close);
  useEffect(() => {
    if (!openTurnReview) return;
    clearTurnReview();
    if (openTurnReview.workspaceId !== activeWorkspaceId || openTurnReview.sessionId !== (activeId ?? '')) return;
    setReview({ scope, content: openTurnReview.content });
  }, [openTurnReview, clearTurnReview, activeWorkspaceId, activeId, scope]);
  // Do not let a closed page's selection reappear if the user navigates back later.
  useEffect(() => { setReview(previous => previous && previous.scope !== scope ? null : previous); }, [scope]);
  if (!value || !presence.mounted) return null;
  return <div className="ma-files-layer" {...presence.spread}>
    <div className="mp-scrim ma-files-scrim" {...presence.spread} onClick={close} aria-hidden />
    <div className="mp-panel mfiles" {...presence.spread} role="dialog" aria-modal="true" aria-label={t('轮次审阅')}>
      <header className="ma-files-head">
        <div className="ma-files-head-info"><div className="ma-files-head-title">{t('轮次审阅')}</div></div>
        <button type="button" className="ma-topbar-btn ma-files-close" aria-label={t('关闭')} onClick={close}><span className="ma-files-icon-close" aria-hidden /></button>
      </header>
      <div className="mobile-turn-review-body"><TurnReviewPanel content={value} active={!!current} onSelect={content => setReview(previous => previous?.scope === scope ? { scope, content } : previous)} /></div>
    </div>
  </div>;
}
