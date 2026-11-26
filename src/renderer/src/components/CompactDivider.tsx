import React from 'react';
import { useTranslation } from 'react-i18next';
import { MOTION, usePresence } from './motion';
import { CompactionActivityIcon } from './ActivityIcons';
import { IconClock } from './icons';
import type { ChatCompactionStatus } from '../../../shared/chatCompaction';

/**
 * 会话流通栏压缩分割线（Cursor 式：细线横贯、文字/图标嵌在线中央、两侧渐隐）。
 * 进行中 → 完成用 usePresence + token 交叉淡化，禁止 keyframes 进出场。
 * 进行中显示单色压缩图标（仅循环装饰使用 keyframes）。
 */
export function CompactDivider(props: { status: ChatCompactionStatus; streamIndex?: number }): React.JSX.Element {
  const { t } = useTranslation();
  const running = usePresence(props.status === 'running', MOTION.exitMs);
  const done = usePresence(props.status === 'complete', MOTION.exitMs);

  return (
    <div
      className="chat-compact-sep"
      data-stream-index={props.streamIndex}
      role="status"
      aria-live="polite"
      aria-label={props.status === 'running' ? t('正在压缩上下文') : t('上下文已压缩')}
    >
      <span className="chat-compact-sep-line" aria-hidden />
      <span className="chat-compact-sep-label">
        {running.mounted ? (
          <span className="chat-compact-sep-state" {...running.spread}>
            <CompactionActivityIcon />
            <span className="chat-compact-sep-text">{t('正在压缩上下文')}</span>
          </span>
        ) : null}
        {done.mounted ? (
          <span className="chat-compact-sep-state" {...done.spread}>
            <IconClock size={12} className="chat-compact-sep-icon" />
            <span className="chat-compact-sep-text">{t('上下文已压缩')}</span>
          </span>
        ) : null}
      </span>
      <span className="chat-compact-sep-line is-end" aria-hidden />
    </div>
  );
}
