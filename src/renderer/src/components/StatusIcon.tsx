import React from 'react';
import type { BoardStatus } from '../../../shared/boardStatus';
import {
  IconClock,
  IconStatusDone,
  IconStatusIdle,
  IconStatusNeedsYou,
  IconStatusWorking,
  IconWarn
} from './icons';

/**
 * 会话状态 → 图标（环形家族）的唯一点：左栏会话行状态槽、看板卡片、画布节点共用。
 * 颜色用状态语义色（与状态胶囊/看板色调一致），工作中旋转、需要你轻呼吸。
 * 工作中 spinner 几何走 IconSpinner + base.css `--spinner-*`；相位由 IconSpinner 负 delay 对齐；状态色 class 在 left.css。
 */
export function SessionStatusIcon(props: {
  status: BoardStatus;
  size?: number;
  className?: string;
}): React.JSX.Element {
  const { status, size = 14, className } = props;
  const cls = `${STATUS_ICON_CLASS[status]}${className ? ` ${className}` : ''}`;
  const Icon = STATUS_ICON[status];
  return <Icon size={size} className={cls} />;
}

/** 状态 → 颜色 + 动画类（颜色与 board-dot 时代的语义色一致） */
const STATUS_ICON_CLASS: Record<BoardStatus, string> = {
  working: 'status-ic st-working session-state-spin',
  idle: 'status-ic st-idle',
  quiet: 'status-ic st-idle',
  blocked: 'status-ic st-needsyou session-state-attn',
  waiting: 'status-ic st-needsyou session-state-attn',
  error: 'status-ic st-error',
  no_signal: 'status-ic st-nosignal',
  done: 'status-ic st-done',
  exited: 'status-ic st-idle',
  scheduled: 'status-ic st-idle'
};

/** 状态 → 图标（无信号/已退出/定时任务沿用弱化语言：环用月牙替代会误导，故 ring 见下） */
const STATUS_ICON: Record<BoardStatus, (p: { size?: number; className?: string }) => React.JSX.Element> = {
  working: IconStatusWorking,
  idle: IconStatusIdle,
  quiet: IconClock,
  blocked: IconStatusNeedsYou,
  waiting: IconStatusNeedsYou,
  error: IconWarn,
  no_signal: StatusRingIcon,
  done: IconStatusDone,
  exited: StatusRingIcon,
  scheduled: IconClock
};

/** 无信号/已退出：细环（「无数据/结束」中性语，灰色弱化；no_signal 由调用方着紫时可覆写 color） */
function StatusRingIcon(p: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      width={p.size ?? 14}
      height={p.size ?? 14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      className={p.className}
      aria-hidden
    >
      <circle cx="8" cy="8" r="4.6" />
    </svg>
  );
}
