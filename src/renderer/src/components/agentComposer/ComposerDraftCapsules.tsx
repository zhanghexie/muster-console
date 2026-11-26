/**
 * 发送旁的 24px 草稿动作：自动入队 / 留待确认。
 * 空草稿只禁用按钮，避免首字输入/清空时改变输入区高度。
 * 纯展示 + 两个动作回调（AgentComposer 注入）；推导见 deriveDraftQueueCapsules。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  deriveDraftQueueCapsules,
  type DraftQueueCapsuleId
} from './composerHelpers';

interface Props {
  hasText: boolean;
  hasImages: boolean;
  busy: boolean;
  queuedCount: number;
  manualCount?: number;
  disabled?: boolean;
  /** 当前草稿送入手动确认清单（文+图；调用方负责清输入） */
  onToManual: () => void;
  /** 当前草稿走普通发送（忙时入排队自动发送；调用方负责清输入） */
  onToQueue: () => void;
}

export function ComposerDraftCapsules(props: Props): React.JSX.Element {
  const { t } = useTranslation();
  const actions = deriveDraftQueueCapsules({
    // 按会话上下文确定占位按钮；实际文图是否为空只控制 disabled。
    hasText: true,
    hasImages: props.hasImages,
    busy: props.busy,
    queuedCount: props.queuedCount
  });
  const disabled = props.disabled || (!props.hasText && !props.hasImages);

  const run = (id: DraftQueueCapsuleId): void => {
    if (id === 'to-manual') props.onToManual();
    else props.onToQueue();
  };

  return (
    <div
      className="composer-draft-capsules"
      role="toolbar"
      aria-label={t('入队建议')}
    >
      <div className="composer-draft-actions">{[...actions].reverse().map((id) => (
        <button
          key={id}
          type="button"
          className="composer-draft-action"
          aria-label={id === 'to-manual' ? t('留待确认') : t('加入自动队列')}
          disabled={disabled}
          title={
            id === 'to-manual'
              ? t('把当前输入放进手动确认清单（不自动发送）')
              : t('把当前输入加入排队自动发送（Agent 空闲后按序发出）')
          }
          onClick={() => run(id)}
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {id === 'to-manual'
              ? <path d="M3 10v6h14v-6M3 10h4l1 3h4l1-3h4M8 3v4M12 3v4"/>
              : <><path d="M7 4h10M7 10h10M7 16h6"/><path d="M3 4h.01M3 10h.01M3 16h.01"/></>}
          </svg>
        </button>
      ))}</div>
    </div>
  );
}
