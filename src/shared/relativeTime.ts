/**
 * 相对时间格式化（纯函数，不碰 process）。
 * 越近精度越高：<1分钟「刚刚」、<1小时「x分钟前」、<1天「x小时前」、
 * <30天「x天前」、<12个月「x个月前」、更久「x年前」。
 * 文案走 Intl.RelativeTimeFormat（跟随应用界面语言，见 shared/i18n）；
 * 中文输出与旧版硬编码一致（「5分钟前」），<1分钟用词条（「刚刚」/「just now」）。
 */

import { getResolvedLocale, t } from './i18n';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY; // 粗略月（30 天）
const YEAR = 365 * DAY;

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtfFor(locale: string): Intl.RelativeTimeFormat {
  let r = rtfCache.get(locale);
  if (!r) {
    // numeric:'always' 保持旧版「1天前」而非「昨天」
    r = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
    rtfCache.set(locale, r);
  }
  return r;
}

export interface RelativeTimeOptions {
  /** 当前时间戳（毫秒）；缺省 = Date.now()（测试可注入） */
  now?: number;
}

export function formatRelativeTime(
  ts: number,
  opts: RelativeTimeOptions = {}
): string {
  const now = opts.now ?? Date.now();
  const diff = now - ts;
  if (!Number.isFinite(diff)) return '';
  if (diff < MIN) return t('刚刚'); // 含未来时间兜底
  const rtf = rtfFor(getResolvedLocale());
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MIN), 'minute');
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), 'hour');
  if (diff < MONTH) return rtf.format(-Math.floor(diff / DAY), 'day');
  if (diff < YEAR) return rtf.format(-Math.floor(diff / MONTH), 'month');
  return rtf.format(-Math.floor(diff / YEAR), 'year');
}

/**
 * 紧凑相对时间：列表行尾常驻显示用，占位尽量小（语言中性，不随界面语言变）。
 * <1分钟「now」、<1小时「5m」、<1天「3h」、<30天「2d」、<12个月「2mo」、更久「1y」。
 */
export function formatRelativeTimeShort(
  ts: number,
  opts: RelativeTimeOptions = {}
): string {
  const now = opts.now ?? Date.now();
  const diff = now - ts;
  if (!Number.isFinite(diff)) return '';
  if (diff < MIN) return 'now'; // 含未来时间兜底
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < MONTH) return `${Math.floor(diff / DAY)}d`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo`;
  return `${Math.floor(diff / YEAR)}y`;
}
