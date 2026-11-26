import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresence } from './motion';

/** 验收打回：简报正文。进出场走 usePresence + mp-scrim/mp-panel。 */
export function BoardReviewDialog({
  open,
  title,
  confirmLabel,
  defaultNote,
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  defaultNote: string;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(open);
  const [note, setNote] = useState(defaultNote);
  useEffect(() => {
    if (open) setNote(defaultNote);
  }, [open, defaultNote]);
  useOverlayDismiss(presence.mounted && presence.stage !== 'out', onCancel);
  if (!presence.mounted) return null;
  return createPortal(
    <div
      className="modal-mask app-confirm-mask mp-scrim"
      data-mp-stage={presence.stage}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="modal confirm-modal mp-panel"
        data-mp-stage={presence.stage}
        role="dialog"
        aria-modal="true"
        aria-labelledby="board-review-title"
      >
        <div className="modal-head">
          <h3 id="board-review-title">{title}</h3>
          <button type="button" className="modal-close" aria-label={t('关闭')} onClick={onCancel}>
            ×
          </button>
        </div>
        <label className="board-review-note-label" htmlFor="board-review-note">
          {t('打回说明')}
        </label>
        <textarea
          id="board-review-note"
          className="board-review-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
        />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t('取消')}
          </button>
          <button type="button" className="btn primary" onClick={() => onConfirm(note)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
