import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { usePresence } from '../motion';

export function SteerFallbackDialog({
  text,
  onMail,
  onInterrupt,
  onCancel
}: {
  text: string | null;
  onMail: () => void;
  onInterrupt: () => void;
  onCancel: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(text !== null);
  useOverlayDismiss(presence.mounted && presence.stage !== 'out', onCancel);
  if (!presence.mounted) return null;
  return createPortal(
    <div className="modal-mask app-confirm-mask mp-scrim" data-overlay-root data-mp-stage={presence.stage} onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal confirm-modal mp-panel" data-mp-stage={presence.stage} role="dialog" aria-modal="true" aria-labelledby="steer-fallback-title">
        <div className="modal-head"><h3 id="steer-fallback-title">{t('当前引擎不支持立即插话')}</h3><button type="button" className="modal-close" aria-label={t('关闭')} onClick={onCancel}>×</button></div>
        <pre className="confirm-detail">{t('可以把这条消息先存入 AI 的邮箱，或先中断当前回合再发送。')}</pre>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>{t('取消')}</button>
          <button type="button" className="btn" onClick={onMail}>{t('发到 AI 邮箱')}</button>
          <button type="button" className="btn primary" onClick={onInterrupt}>{t('中断后发送')}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
