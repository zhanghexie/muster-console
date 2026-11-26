import type { TaskSchedule } from '../../shared/types';
import { t } from '../../shared/i18n';

const MINUTE = 60_000;
/** 30 天：再大 setInterval 的 delay 会超过 setTimeout 的 2^31ms 上限 */
export const MAX_INTERVAL_MINUTES = 43_200;

function atLocal(base: Date, hours: number, minutes: number): Date {
  const d = new Date(base);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function nextLocalDay(base: Date, hours: number, minutes: number): Date {
  // 用 setDate 而非 +24h：夏令时切换日仍落在本地时制的次日 HH:mm
  const d = new Date(base);
  d.setDate(d.getDate() + 1);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function parseTime(time: string): [number, number] {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(t('时间格式应为 HH:mm，收到: {{time}}', { time }));
  return [Number(m[1]), Number(m[2])];
}

/** once.at（ISODateTime）解析为 epoch ms（T6/A4） */
function parseOnceAt(at: string): number {
  if (typeof at !== 'string' || !at.trim()) {
    throw new Error(t('once.at 必须是 ISODateTime 字符串'));
  }
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) {
    throw new Error(t('once.at 不是合法的 ISODateTime: {{at}}', { at }));
  }
  return ms;
}

export function getNextRunAt(schedule: TaskSchedule, from = new Date()): number {
  // once：唯一触发点就是 at 本身（可能已过期——由 missedPolicy 决定补跑/跳过，见 T6）
  if (schedule.kind === 'once') return parseOnceAt(schedule.at);

  if (schedule.kind === 'interval') {
    if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes <= 0) {
      throw new Error(t('intervalMinutes 必须是正整数'));
    }
    if (schedule.intervalMinutes > MAX_INTERVAL_MINUTES) {
      throw new Error(t('intervalMinutes 过大，上限 {{n}} 分钟（30 天）', { n: MAX_INTERVAL_MINUTES }));
    }
    return from.getTime() + schedule.intervalMinutes * MINUTE;
  }

  const [hours, minutes] = parseTime(schedule.time);
  if (schedule.kind === 'daily') {
    const today = atLocal(from, hours, minutes);
    return today.getTime() > from.getTime() ? today.getTime() : nextLocalDay(from, hours, minutes).getTime();
  }

  const weekdays = [...new Set(schedule.weekdays)].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  if (!weekdays.length) throw new Error(t('weekly.weekdays 不能为空'));
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (weekdays.includes(candidate.getDay()) && candidate.getTime() > from.getTime()) {
      return candidate.getTime();
    }
  }
  throw new Error(t('无法计算下一次执行时间'));
}

// ---------- T6/A4：delayMinutes / once / maxRuns ----------

/**
 * delayMinutes → once 调度（host 真实时钟换算触发点）。
 * now 参数是给测试注入的时钟缝；生产调用不传 = Date.now()（真实时钟），
 * 禁止模型/调用方自行把相对延迟编成 interval/daily。
 */
export function scheduleFromDelayMinutes(delayMinutes: number, now: number = Date.now()): TaskSchedule {
  if (!Number.isInteger(delayMinutes) || delayMinutes <= 0) {
    throw new Error(t('delayMinutes 必须是正整数（分钟）'));
  }
  if (delayMinutes > MAX_INTERVAL_MINUTES) {
    throw new Error(t('delayMinutes 过大，上限 {{n}} 分钟（30 天）', { n: MAX_INTERVAL_MINUTES }));
  }
  return { kind: 'once', at: new Date(now + delayMinutes * MINUTE).toISOString() };
}

/**
 * 创建入参归一：schedule 与 delayMinutes 二选一（互斥）。
 * 给 delayMinutes 就用 host 真实时钟换算成 once；两者都给或都不给都拒绝。
 */
export function resolveScheduleInput(
  input: { schedule?: TaskSchedule; delayMinutes?: number },
  now: number = Date.now()
): TaskSchedule {
  const hasSchedule = input.schedule != null;
  const hasDelay = input.delayMinutes != null;
  if (hasSchedule && hasDelay) {
    throw new Error(t('delayMinutes 与 schedule 二选一，不能同时提供'));
  }
  if (!hasSchedule && !hasDelay) {
    throw new Error(t('schedule 与 delayMinutes 必须提供一个'));
  }
  if (hasDelay) return scheduleFromDelayMinutes(input.delayMinutes as number, now);
  // 顺手走一遍 getNextRunAt 校验 schedule 自身合法性（含 once.at 解析）
  getNextRunAt(input.schedule as TaskSchedule, new Date(now));
  return input.schedule as TaskSchedule;
}

/** maxRuns 校验（T6）：缺省不限次；给了必须是正整数 */
export function validateMaxRuns(maxRuns: number | undefined): number | undefined {
  if (maxRuns === undefined) return undefined;
  if (!Number.isInteger(maxRuns) || maxRuns <= 0) {
    throw new Error(t('maxRuns 必须是正整数'));
  }
  return maxRuns;
}

/** once 槽位已消费（已跑/已跳过/等待确认补跑）后：任务自停且不再挂定时器 */
export function consumeOnceSlot(task: { schedule: TaskSchedule; enabled: boolean; nextRunAt?: number }): void {
  if (task.schedule.kind !== 'once') return;
  task.enabled = false;
  task.nextRunAt = undefined;
}

/**
 * 成功触发一次后是否自动停用（T6）：
 * - once：触发一次成功后停用（终态，保留历史运行记录由 manager 负责）
 * - maxRuns：interval/daily/weekly 成功次数达到上限后停用（runCount 含本次）
 */
export function shouldAutoDisableAfterRun(input: {
  schedule: TaskSchedule;
  maxRuns?: number;
  /** 本次成功后的累计成功次数（含本次） */
  runCount: number;
}): boolean {
  if (input.schedule.kind === 'once') return true;
  if (input.maxRuns !== undefined && input.runCount >= input.maxRuns) return true;
  return false;
}
