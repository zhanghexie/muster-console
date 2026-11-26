/**
 * 聊天消息时间标签（飞书/微信式）：用于消息悬浮时间与时间分隔条。
 * 纯函数，不碰 process。日期/时间组合走 Intl（跟随应用界面语言，
 * 见 shared/i18n），「昨天」等词走词条表。
 */

import { getResolvedLocale, t } from './i18n';

/** 相邻消息时间间隔超过此值则插入一条时间分隔（5 分钟） */
export const CHAT_TIME_GAP_MS = 5 * 60_000;

/** Intl formatter 按语言缓存（构造有成本，消息列表逐条调用） */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtFor(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = locale + JSON.stringify(options);
  let f = fmtCache.get(cacheKey);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    fmtCache.set(cacheKey, f);
  }
  return f;
}

function hm(d: Date, locale: string): string {
  // zh 保持旧版零填充（09:05）；en 用本地习惯（2:30 PM）
  const options: Intl.DateTimeFormatOptions =
    locale === 'zh-CN'
      ? { hour: '2-digit', minute: '2-digit' }
      : { hour: 'numeric', minute: '2-digit' };
  return fmtFor(locale, options).format(d);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 格式化消息时间标签：
 * - 今天：HH:mm
 * - 昨天：昨天 HH:mm（en: Yesterday 3:45 PM）
 * - 今年其它：M月D日 HH:mm（en: 8/29 3:45 PM）
 * - 跨年：YYYY年M月D日 HH:mm（en: 8/29/2025 3:45 PM）
 * 中文分支保留原「M月D日」手写格式：Intl 的 zh month/day 输出是「8/29」，
 * 与产品既有习惯（及既有测试断言）不符。
 */
export function formatChatTimeLabel(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return '';
  const locale = getResolvedLocale();
  const d = new Date(ts);
  const n = new Date(now);
  if (sameDay(d, n)) return hm(d, locale);
  // 昨天：now 减一天再比 sameDay
  const y = new Date(now - 24 * 60 * 60_000);
  if (sameDay(d, y)) return `${t('昨天')} ${hm(d, locale)}`;
  if (locale === 'zh-CN') {
    if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm(d, locale)}`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm(d, locale)}`;
  }
  if (d.getFullYear() === n.getFullYear()) {
    return `${fmtFor(locale, { month: 'numeric', day: 'numeric' }).format(d)} ${hm(d, locale)}`;
  }
  return `${fmtFor(locale, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d)} ${hm(d, locale)}`;
}

/**
 * 判断在消息序列中第 i 条之前是否需要插入时间分隔条。
 * 第 0 条总是插入；其后与前一条间隔超过 CHAT_TIME_GAP_MS 则插入。
 */
export function shouldShowTimeSeparator(
  prevTs: number | null,
  ts: number
): boolean {
  if (prevTs === null) return true;
  return ts - prevTs > CHAT_TIME_GAP_MS;
}
