import type { AppContext } from '../context';
import { handle } from './handle';
import {
  MAX_USAGE_RANGE_DAYS,
  USAGE_LLM_PAGE_MAX,
  USAGE_PAGE_DEFAULT,
  addUsageDays,
  mergeUsageDaysInRange,
  rangeUsageDays,
  usageDayKey,
  type UsageSummary,
  type UsageSummaryQuery
} from '../../shared/usageStats';

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 两日 key 的跨度（天，含端点）；取正午差值再取整，DST 边界不漂移 */
function spanDays(fromKey: string, toKey: string): number {
  const from = new Date(`${fromKey}T12:00:00`).getTime();
  const to = new Date(`${toKey}T12:00:00`).getTime();
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

/** 查询范围归一：非法值回落今日、不许未来、跨度封顶；历法非法日（如 02-30）按非法处理 */
function normalizeRange(
  query: UsageSummaryQuery | undefined,
  todayKey: string
): { fromKey: string; toKey: string } {
  const q = query && typeof query === 'object' ? query : ({} as UsageSummaryQuery);
  const isDayKey = (k: unknown): k is string =>
    typeof k === 'string' && DAY_KEY_RE.test(k) && addUsageDays(k, 0) === k;
  const toKey = isDayKey(q.toKey) && q.toKey <= todayKey ? q.toKey : todayKey;
  let fromKey = isDayKey(q.fromKey) && q.fromKey <= toKey ? q.fromKey : toKey;
  if (spanDays(fromKey, toKey) > MAX_USAGE_RANGE_DAYS) {
    fromKey = addUsageDays(toKey, -(MAX_USAGE_RANGE_DAYS - 1));
  }
  return { fromKey, toKey };
}

function pageArg(value: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, n);
}

function offsetArg(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function buildUsageSummary(ctx: AppContext, query?: UsageSummaryQuery): UsageSummary {
  const now = Date.now();
  const days = ctx.usage.getDays();
  const todayKey = usageDayKey(now);
  const { fromKey, toKey } = normalizeRange(query, todayKey);

  const llm = ctx.usage.getLlmCallsRange(
    fromKey,
    toKey,
    offsetArg(query?.llmOffset),
    pageArg(query?.llmLimit, USAGE_PAGE_DEFAULT, USAGE_LLM_PAGE_MAX)
  );

  const span = spanDays(fromKey, toKey);
  const prevTo = addUsageDays(fromKey, -1);
  const prevFrom = addUsageDays(prevTo, -(span - 1));

  return {
    generatedAt: now,
    todayKey,
    fromKey,
    toKey,
    rangeDays: rangeUsageDays(days, fromKey, toKey),
    rangeTotal: mergeUsageDaysInRange(days, fromKey, toKey),
    prevTotal: mergeUsageDaysInRange(days, prevFrom, prevTo),
    // 兼容旧客户端字段；不再查询已退役的无头任务。
    headlessRuns: [], headlessTotal: 0, headlessRunningTotal: 0, headlessByTask: [],
    toolFailures: ctx.usage.getToolFailures(fromKey, toKey),
    llmCalls: llm.rows,
    llmCallsTotal: llm.total,
    llmByExt: ctx.usage.getLlmByExtRange(fromKey, toKey)
  };
}

export function registerUsageIpc(ctx: AppContext): void {
  // X4-F07：改走统一 handle() 封装——失败有 `[ipc] <channel> failed` 日志、进通道
  // 注册表（重复注册守卫）。web 网关侧对两通道显式拒绝（见 webAccess/server.ts
  // INVOKE_DENYLIST）：usage-stats F-03 的权限分级诉求按现状归档备案，不随本改动放开。
  handle('usage:summary', (_e, query?: UsageSummaryQuery) => buildUsageSummary(ctx, query));
  handle('usage:llm-call', (_e, id?: string) =>
    typeof id === 'string' ? ctx.usage.getLlmCall(id) : null
  );
}
