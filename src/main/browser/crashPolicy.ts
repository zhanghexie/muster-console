/**
 * 浏览器 guest 崩溃恢复策略（纯逻辑，可单测）。
 *
 * 行为（交接文档任务 A）：连续崩溃按退避序列自动原地 reload（webview 元素与
 * guest webContents 存活，spike 验证可复活）；超过次数上限进入可见错误态并停止
 * 自动恢复，等待用户手动重试。未达上限时距上次崩溃超过稳定窗口才重置计数；
 * dom-ready 与 guest 换代不清零，防止「恢复即崩」绕过上限。定时器由调用方持有并按 tab/generation 取消，
 * 本模块不做任何 I/O。
 */

export interface CrashState {
  /** 窗口内连续崩溃次数（含本次） */
  attempts: number;
  /** 上次崩溃时间（ms epoch） */
  lastCrashAt: number;
  /** 已达上限：停止自动恢复，等待手动重试 */
  gaveUp: boolean;
}

export interface CrashDecision {
  action: 'reload' | 'give-up';
  /** reload 前的等待毫秒（0 = 立即） */
  delayMs: number;
}

/** 第 N 次连续崩溃的自动恢复退避（index = attempts-1）。 */
export const CRASH_BACKOFF_DELAYS_MS = [0, 1000, 3000, 8000] as const;
/** 连续崩溃上限：第 5 次崩溃放弃自动恢复（此前共 4 次 reload 机会）。 */
export const CRASH_MAX_ATTEMPTS = CRASH_BACKOFF_DELAYS_MS.length + 1;
/** 稳定窗口：距上次崩溃超过该时长的新崩溃重新计数（页面已恢复过）。 */
export const CRASH_RESET_WINDOW_MS = 60_000;

/**
 * 记录一次崩溃并给出恢复决策。
 * - prev 为 null（从未崩溃）或距上次崩溃超过稳定窗口 → 计为第 1 次，立即 reload。
 * - 未达上限 → 递增计数，按退避序列 reload。
 * - 达到上限 → give-up（不再自动 reload）。
 */
export function nextCrashRecovery(prev: CrashState | null, now: number): { state: CrashState; decision: CrashDecision } {
  const stale = !prev || prev.gaveUp === false && now - prev.lastCrashAt > CRASH_RESET_WINDOW_MS;
  const attempts = stale ? 1 : prev.attempts + 1;
  if (attempts >= CRASH_MAX_ATTEMPTS) {
    const state: CrashState = { attempts, lastCrashAt: now, gaveUp: true };
    return { state, decision: { action: 'give-up', delayMs: 0 } };
  }
  const delayMs = CRASH_BACKOFF_DELAYS_MS[Math.min(attempts - 1, CRASH_BACKOFF_DELAYS_MS.length - 1)];
  const state: CrashState = { attempts, lastCrashAt: now, gaveUp: false };
  return { state, decision: { action: 'reload', delayMs } };
}
