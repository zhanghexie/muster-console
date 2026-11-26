import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { formatRelativeTime } from '../../../../shared/relativeTime';
import type { Presence } from '../motion';

/** 上下文用量圆环：r=6.5 的周长（dasharray 用） */
const CTX_RING_C = 2 * Math.PI * 6.5;

interface Props {
  usage: { frac: number | null; label: string };
  statusTitle?: string;
  rawUsage: { tokens: number | null; contextWindow: number; ts?: number; stale?: boolean } | null;
  showCtxMenu: boolean;
  setShowCtxMenu: Dispatch<SetStateAction<boolean>>;
  ctxMenuPresence: Presence;
  ctxMenuRef: MutableRefObject<HTMLDivElement | null>;
}

/** 用量环 + 纯展示详情菜单（纯展示）：数据只有 ChatUsageInfo，无操作项。 */
export function ComposerContextUsage({
  usage,
  statusTitle,
  rawUsage,
  showCtxMenu,
  setShowCtxMenu,
  ctxMenuPresence,
  ctxMenuRef
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="agent-ctx-wrap" ref={ctxMenuRef}>
      <button
        type="button"
        className="agent-ctx-ring"
        title={statusTitle}
        aria-label={t('上下文用量')}
        aria-expanded={showCtxMenu}
        onClick={() => setShowCtxMenu((v) => !v)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="agent-ctx-ring-track" cx="8" cy="8" r="6.5" strokeWidth="2" />
          {usage.frac != null ? (
            <circle
              className={`agent-ctx-ring-val${usage.frac >= 0.9 ? ' is-high' : usage.frac >= 0.75 ? ' is-warn' : ''}`}
              cx="8"
              cy="8"
              r="6.5"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={CTX_RING_C}
              strokeDashoffset={CTX_RING_C * (1 - Math.min(1, usage.frac))}
              transform="rotate(-90 8 8)"
            />
          ) : null}
        </svg>
        {/* 引擎未提供上限时显示已用量，未知占用显示空环。 */}
        {usage.label ? <span className="agent-ctx-ring-label">{usage.label}</span> : null}
      </button>
      {ctxMenuPresence.mounted && (
        <div
          className="agent-ctx-menu mp-pop mp-pop-up"
          data-mp-stage={ctxMenuPresence.stage}
          role="menu"
        >
          <div className="agent-ctx-menu-heading">{t('上下文用量')}</div>
          <div className="agent-ctx-menu-pct">
            {usage.frac != null ? `${Math.round(usage.frac * 100)}%` : '—'}
          </div>
          <div className="agent-ctx-menu-rows">
            <span>{t('已用')}</span>
            <span>{rawUsage?.tokens != null ? rawUsage.tokens.toLocaleString() : '—'}</span>
            <span>{t('上限')}</span>
            <span>
              {rawUsage?.contextWindow ? rawUsage.contextWindow.toLocaleString() : '—'}
            </span>
          </div>
          {rawUsage?.tokens == null ? (
            <div className="agent-ctx-menu-note">{t('用量暂未知')}</div>
          ) : null}
          {rawUsage?.stale && rawUsage.ts ? (
            <div className="agent-ctx-menu-note">
              {t('最后更新 {{time}}', { time: formatRelativeTime(rawUsage.ts) })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
