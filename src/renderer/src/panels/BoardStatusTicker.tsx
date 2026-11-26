import React from 'react';
import { useTranslation } from 'react-i18next';

/** 普通态与探出态共用的底栏数量摘要；不轮播、不跳会话、不标记已读。 */
export function StatusTicker({
  unreadCount,
  needsCount
}: {
  unreadCount: number;
  /** 当前处于需要你区的条目总数（含已读） */
  needsCount: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <div className="board-ticker" aria-live="polite">
    <span className="board-ticker-line is-empty">
      {needsCount
        ? t('{{n}} 个需要处理 · {{unread}} 未读', { n: needsCount, unread: unreadCount })
        : t('暂无需要处理的项目')}
    </span>
  </div>;
}
