/**
 * 看板语义 → 视觉映射（学 AO session-presentation.ts：语义层与视觉层集中在一张表）。
 * 状态文案 / 状态图标 / 分区色调全部查这一张表；图标形与色在 StatusIcon.tsx，新增状态两处同步。
 */
import { t } from '../../../shared/i18n';
import type { BoardStatus, BoardZone } from '../../../shared/boardStatus';

export interface BoardStatusVisual {
  /** 状态图标旁的文案 */
  label: string;
  /** 卡片描边色调（board-tone-*） */
  toneClass: string;
}

/** label 用 getter 延迟到取值时才查 i18n：语言切换后下次渲染即生效（消费方仍按字符串读 .label） */
export const BOARD_STATUS_PRESENTATION: Record<BoardStatus, BoardStatusVisual> = {
  working: { get label() { return t('工作中'); }, toneClass: 'board-tone-working' },
  idle: { get label() { return t('空闲'); }, toneClass: 'board-tone-working' },
  quiet: { get label() { return t('等待输出'); }, toneClass: 'board-tone-working' },
  blocked: { get label() { return t('待确认'); }, toneClass: 'board-tone-needs-you' },
  waiting: { get label() { return t('等待输入'); }, toneClass: 'board-tone-needs-you' },
  error: { get label() { return t('出错'); }, toneClass: 'board-tone-error' },
  no_signal: { get label() { return t('无信号'); }, toneClass: 'board-tone-no-signal' },
  done: { get label() { return t('已完成'); }, toneClass: 'board-tone-done' },
  exited: { get label() { return t('已退出'); }, toneClass: 'board-tone-archived' },
  scheduled: { get label() { return t('定时任务'); }, toneClass: 'board-tone-working' }
};

export interface BoardZoneVisual {
  label: string;
  /** 列头点修饰类 */
  headClass: string;
}

export const BOARD_ZONE_PRESENTATION: Record<BoardZone, BoardZoneVisual> = {
  working: { get label() { return t('进行中'); }, headClass: 'board-head-working' },
  needsYou: { get label() { return t('需要你'); }, headClass: 'board-head-needs-you' },
  done: { get label() { return t('已完成'); }, headClass: 'board-head-done' },
  archived: { get label() { return t('归档'); }, headClass: 'board-head-archived' }
};
