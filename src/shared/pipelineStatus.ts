/**
 * R2：编排视图机械判定（纯函数）。阈值由 config.pipeline 注入，不教 LLM 判。
 * 字段面保守默认：只输出调度巡检够用的机械量，不附 git 全文。
 */

import { sessionHasStalled, type SessionMonitorFacts } from './sessionActivity';

export const DEFAULT_PIPELINE_STALL_MS = 15 * 60 * 1000;
/** 停滞扫描间隔缺省：2 分钟（建议窗 1–5 分钟，避免 git 风暴） */
export const DEFAULT_PIPELINE_STALL_SCAN_MS = 2 * 60 * 1000;
export const MIN_PIPELINE_STALL_SCAN_MS = 60_000;
export const MAX_PIPELINE_STALL_SCAN_MS = 5 * 60 * 1000;
/** O6 慢回合阈值缺省：当前回合已运行 10 分钟视为 slowTurn */
export const DEFAULT_PIPELINE_SLOW_TURN_MS = 10 * 60 * 1000;

export type PipelineMergeBlockedReason =
  | 'dirty_overlap'
  | 'not_fast_forward'
  | 'uncommitted'
  | 'no_ahead'
  | 'no_worktree'
  | 'not_ready';

export type PipelineVerdictKind = 'stalled' | 'readyToMerge' | 'mergeBlocked' | 'working' | 'idle';

export interface PipelineVerdict {
  kind: PipelineVerdictKind;
  /** kind=mergeBlocked 时给出原因 */
  mergeBlocked?: PipelineMergeBlockedReason;
}

export interface PipelineWorkerFacts extends SessionMonitorFacts {
  phase?: string;
  lifecycle?: string;
  archived?: boolean;
  lastActivityAt?: number;
  uncommittedCount: number;
  aheadCount: number;
  canFastForward: boolean;
  dirtyOverlap: boolean;
  hasWorktree: boolean;
  /** 未消化排队注入条数（fromInject；sessions.queuedInjects）。>0 时 judge 取保守侧 */
  queuedInjects?: number;
}

export interface PipelineThresholds {
  stallMs: number;
}

/** 通用毫秒窗口钳制：非法值回落 fallback；缺省窗 1 分钟–24 小时 */
const MIN_PIPELINE_WINDOW_MS = 60_000;
const MAX_PIPELINE_WINDOW_MS = 24 * 60 * 60 * 1000;

function clampPipelineMs(
  raw: unknown,
  fallback: number,
  min: number = MIN_PIPELINE_WINDOW_MS,
  max: number = MAX_PIPELINE_WINDOW_MS
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function normalizePipelineStallMs(raw: unknown): number {
  return clampPipelineMs(raw, DEFAULT_PIPELINE_STALL_MS);
}

export function normalizePipelineSlowTurnMs(raw: unknown): number {
  return clampPipelineMs(raw, DEFAULT_PIPELINE_SLOW_TURN_MS);
}

/** 扫描间隔钳在 1–5 分钟：太密 git 开销大，太疏推送滞后。 */
export function normalizePipelineStallScanMs(raw: unknown): number {
  return clampPipelineMs(raw, DEFAULT_PIPELINE_STALL_SCAN_MS, MIN_PIPELINE_STALL_SCAN_MS, MAX_PIPELINE_STALL_SCAN_MS);
}

/** 与 sessions.observe 同一活跃 Worker 口径（不含 shell / 已退出 / 已归档）。 */
export function isPipelineActiveWorker(s: {
  archived?: boolean;
  type?: string;
  launchKind?: string;
  lifecycle?: string;
}): boolean {
  if (s.archived) return false;
  if (s.type !== 'terminal') return false;
  if (s.launchKind === 'shell') return false;
  if (s.lifecycle === 'exited') return false;
  return true;
}

/** 会话侧活动时间戳（不含 git lastFileWriteAt）。 */
export function sessionActivityParts(s: {
  lastUsedAt?: number;
  liveStatus?: { ts?: number };
  activity?: { ts?: number };
  phase?: { ts?: number };
  runtimeStartedAt?: number;
  lastOutputAt?: number;
}): Array<number | undefined> {
  return [s.runtimeStartedAt, s.lastOutputAt, s.lastUsedAt, s.liveStatus?.ts, s.activity?.ts, s.phase?.ts];
}

/** O6：会话级「当前回合已运行多久」快照（activeTurnMs 不在回合为 null；超阈值 slowTurn） */
export interface ActiveTurnMetrics {
  /** 不在回合中为 null；否则 now - turnStartedAt（毫秒，向下取整） */
  activeTurnMs: number | null;
  /** activeTurnMs ≥ slowTurnMs 才为 true；不在回合恒 false */
  slowTurn: boolean;
}

/**
 * O6 慢回合感知纯函数：输入 now / 回合开始时刻 / 阈值。
 * turnStartedAt 缺省/非法/晚于 now（时钟回拨）一律按「不在回合」处理（fail-open）。
 */
export function activeTurnMetrics(opts: {
  now: number;
  turnStartedAt?: number | null;
  slowTurnMs?: number;
}): ActiveTurnMetrics {
  const slowTurnMs = opts.slowTurnMs ?? DEFAULT_PIPELINE_SLOW_TURN_MS;
  const startedAt = opts.turnStartedAt;
  if (
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    startedAt > opts.now
  ) {
    return { activeTurnMs: null, slowTurn: false };
  }
  const activeTurnMs = Math.max(0, Math.floor(opts.now - startedAt));
  return { activeTurnMs, slowTurn: activeTurnMs >= slowTurnMs };
}

export function lastActivityAt(parts: Array<number | undefined>): number | undefined {
  let max = 0;
  for (const p of parts) {
    if (typeof p === 'number' && Number.isFinite(p) && p > max) max = p;
  }
  return max > 0 ? max : undefined;
}

export function judgePipelineWorker(facts: PipelineWorkerFacts, now: number, th: PipelineThresholds): PipelineVerdict {
  const phase = facts.phase ?? '';
  const exited = facts.lifecycle === 'exited' || facts.archived === true;
  if (exited) return { kind: 'idle' };

  if (sessionHasStalled(facts, now, th.stallMs)) return { kind: 'stalled' };

  if (phase === 'needs_you') {
    if (!facts.hasWorktree) return { kind: 'mergeBlocked', mergeBlocked: 'no_worktree' };
    if (facts.dirtyOverlap) return { kind: 'mergeBlocked', mergeBlocked: 'dirty_overlap' };
    if (facts.uncommittedCount > 0) return { kind: 'mergeBlocked', mergeBlocked: 'uncommitted' };
    if (facts.aheadCount <= 0) return { kind: 'mergeBlocked', mergeBlocked: 'no_ahead' };
    if (!facts.canFastForward) return { kind: 'mergeBlocked', mergeBlocked: 'not_fast_forward' };
    // 保守侧：还有未消化的排队注入 = Worker 尚未看到最新指令，「可合入」不可信。
    // 放在 git 闸之后：让更具体的阻塞原因优先暴露，只在全部通过时拦 readyToMerge
    if ((facts.queuedInjects ?? 0) > 0) {
      return { kind: 'mergeBlocked', mergeBlocked: 'not_ready' };
    }
    return { kind: 'readyToMerge' };
  }

  if (facts.hasWorktree && facts.aheadCount > 0 && facts.dirtyOverlap) {
    return { kind: 'mergeBlocked', mergeBlocked: 'dirty_overlap' };
  }

  if (phase === 'done' || phase === 'idle' || facts.runtimePresence === 'dormant' ||
      facts.lifecycle === 'idle' || facts.lifecycle === 'blocked') return { kind: 'idle' };
  return { kind: facts.lifecycle === 'working' || facts.lifecycle === 'quiet' || phase === 'working' ? 'working' : 'idle' };
}
