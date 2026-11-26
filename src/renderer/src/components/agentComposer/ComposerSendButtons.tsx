import React from 'react';
import { useTranslation } from 'react-i18next';
import { BrandLoader } from '../BrandLoader';

interface Props {
  busy: boolean;
  submitting?: boolean;
  onStop?: () => void;
  inputLocked: boolean;
  hasText: boolean;
  imagesCount: number;
  manualCount?: number;
  pendingQuestion?: boolean;
  onSubmit: () => void;
}

/** 发送/停止按钮（纯展示）：busy 且可停时切换为停止钮（排队消息保留）。 */
export function ComposerSendButtons({
  busy,
  submitting = false,
  onStop,
  inputLocked,
  hasText,
  imagesCount,
  onSubmit,
  manualCount = 0,
  pendingQuestion = false
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const route = pendingQuestion && !imagesCount ? t('Enter 发送消息') : !busy ? t('Enter 发送') : manualCount ? t('Enter 留待确认') : t('Enter 加入自动队列');
  return (
    <>
      {submitting ? (
        <button type="button" className="send-btn send-btn-icon brand-loading-button"
          disabled aria-busy="true" aria-label={t('发送中')} title={t('发送中')}>
          <BrandLoader size={24} />
        </button>
      ) : busy && onStop ? (
        <button
          type="button"
          className="send-btn send-btn-icon stop-btn"
          title={`${t('停止当前回合（排队消息保留）')} · ${route}`}
          aria-label={t('停止')}
          onClick={onStop}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          className="send-btn send-btn-icon"
          title={route}
          aria-label={t('发送')}
          disabled={inputLocked || (!hasText && imagesCount === 0)}
          onClick={onSubmit}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M7.25 13.25a.75.75 0 0 0 1.5 0V4.56l2.72 2.72a.75.75 0 1 0 1.06-1.06l-4-4a.75.75 0 0 0-1.06 0l-4 4a.75.75 0 0 0 1.06 1.06l2.72-2.72v8.69Z"
            />
          </svg>
        </button>
      )}
    </>
  );
}
