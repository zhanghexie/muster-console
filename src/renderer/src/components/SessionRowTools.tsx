import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatRelativeTimeShort } from '../../../shared/relativeTime';
import { getResolvedLocale } from '../../../shared/i18n';
import { IconTrash } from './icons';

export function SessionArchiveIcon({ restore = false }: { restore?: boolean }): React.JSX.Element {
  return <svg width={12} height={12} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"
    stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" aria-hidden focusable={false}>
    <path d="M3.5 6.35v6.4h9v-6.4" />
    <path d="M2.5 4.25h11v2.1H2.5z" transform={restore ? 'translate(-0.65 0.2) rotate(-21 2.5 6.35)' : undefined} />
    <path d="M6.25 9.1h3.5" />
    {restore && <path d="M3.5 6.35h9" />}
  </svg>;
}

/** Shared time/hover action for the session list and board. */
export function SessionRowTools({ ts, now, archived = false, onArchive, onDelete }: {
  ts: number; now?: number; archived?: boolean; onArchive?: () => void; onDelete?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <span className={`session-row-tools${archived && onDelete ? ' has-delete' : ''}`}>
    <span className="session-reltime" title={t('最近使用 {{time}}', { time: new Date(ts).toLocaleString(getResolvedLocale()) })}>
      {formatRelativeTimeShort(ts, { now })}
    </span>
    {onArchive ? <button type="button" className="session-action session-archive-btn"
      aria-label={archived ? t('取消归档') : t('归档')} title={archived ? t('取消归档') : t('归档')}
      onClick={event => { event.preventDefault(); event.stopPropagation(); onArchive(); }}>
      <SessionArchiveIcon restore={archived} />
    </button> : null}
    {archived && onDelete && <button type="button" className="session-action session-archive-btn session-delete-btn"
      aria-label={t('永久删除')} title={t('永久删除')}
      onClick={event => { event.preventDefault(); event.stopPropagation(); onDelete(); }}><IconTrash size={13} /></button>}
  </span>;
}
