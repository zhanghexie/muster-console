/**
 * C1 跨日 date-change reminder（zcode-adoption-plan C1）：判定纯函数。
 *
 * 调度会话常活数天，pi 的 system prompt 不含日期（spike：system-prompt.js 无任何
 * 日期注入），模型对「今天」的感知会过期，影响定时任务与「今天/明天/本周」的时间
 * 推理。跨自然日时在回合前缀注入一行日期提醒（复用现有回合前缀通道，不改 system
 * ——保前缀缓存，ZCode turn.ts injectDateChangeReminderIntoMessageHistory 同思路）。
 */

/** 本地时区日期键 YYYY-MM-DD（跨日判定与「今天」展示同源） */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** M月D日（提醒文案里的「上次交互」展示；本地时区） */
export function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[d.getMonth()]} ${d.getDate()}`;
}

export const DATE_CHANGE_REMINDER_TAG = '<system-reminder>';

export interface DateChangeReminderDecision {
  /** 本次回合开始时的日期键（调用方记录为上次注入日期） */
  dateKey: string;
  /** true=本次回合应注入 line（首次锚定或跨日） */
  changed: boolean;
  /** 注入行；changed=false 时为 undefined */
  line?: string;
}

/**
 * 跨日判定（给定时钟，纯函数）：
 * - 无上次记录（新桶/进程重启）：首次锚定，注入一行让模型拿到「今天」；
 * - 同一自然日：不注入（每回合都注会污染前缀缓存语义）；
 * - 跨自然日（含年末 12-31→01-01、闰年 02-29→03-01，走本地日历自然日）：注入。
 */
export function decideDateChangeReminder(input: {
  nowMs: number;
  /** 上次注入的日期键（YYYY-MM-DD）；缺省=无记录 */
  lastInjectedDate?: string | null;
}): DateChangeReminderDecision {
  const dateKey = localDateKey(input.nowMs);
  if (input.lastInjectedDate === dateKey) {
    return { dateKey, changed: false };
  }
  const last = input.lastInjectedDate?.trim();
  const lastMs = last ? Date.parse(`${last}T00:00:00`) : NaN;
  // 无记录或上次记录不可解析（损坏）：退化为不带「上次交互」的纯锚定行
  const lastBit = Number.isFinite(lastMs) ? ` (last interaction ${formatMonthDay(lastMs)})` : '';
  const line = `${DATE_CHANGE_REMINDER_TAG}Today is ${dateKey}${lastBit}. Time reasoning about "today/tomorrow/this week" must use this date.${DATE_CHANGE_REMINDER_TAG}`;
  return { dateKey, changed: true, line };
}
