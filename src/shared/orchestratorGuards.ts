/**
 * 调度机械规则守卫（R3）：纯函数，只提醒不决策。
 * 默认阈值（保守，可改）：心跳 15min、needs_you 30min、needs_review 悬挂 2h（R-04）。
 */
import type { OrchEventKind } from './notifyQueue';
import { orchEventKey } from './notifyQueue';
import { sessionHasStalled, type SessionMonitorFacts } from './sessionActivity';

export const ORCH_GUARD_DEFAULTS = {
  enabled: true,
  heartbeatMs: 15 * 60_000,
  needsYouMs: 30 * 60_000,
  tickMs: 60_000
} as const;

export type GuardWorkerSnapshot = SessionMonitorFacts & {
  sessionId: string;
  sessionName: string;
  workspaceId: string;
  /** 会话类型；心跳只对 terminal 工作会话有意义，scheduled 执行器不适用 */
  type?: 'terminal' | 'scheduled';
  /** shell 会话不参与心跳（无任务语义） */
  launchKind?: string;
  /** agent 生命周期；(a) working 的会话才进入心跳监控 */
  lifecycle?: 'starting' | 'working' | 'quiet' | 'idle' | 'blocked' | 'exited';
  /** 历史派活标记，仅兼容旧快照；不再作为当前运行资格。 */
  hasAssignedTask?: boolean;
  /** 看板 phase 字面量；无则不算 needs_you */
  phase?: 'idle' | 'needs_you' | 'done';
  /** 编排关联性：orchestrated===true（调度拉起/派活）的会话才进守卫；手工会话的停滞
   *  由人自己盯着，报给调度纯属自噪声。必填 + 运行时缺省即跳过（fail-closed），防漏设回流。 */
  orchestrated: boolean;
  /** 当前实例自己的启动/输入/输出/hook/回合/上报；告警不属于活动。 */
  lastActivityAt: number;
  /** 进入 needs_you 的时刻；phase 不是 needs_you 时应省略 */
  needsYouSince?: number;
  /** 回合进行中：跳过心跳超时（人还在跑） */
  busy?: boolean;
  archived?: boolean;
  hidden?: boolean;
};

export type GuardEvalInput = {
  now: number;
  workers: readonly GuardWorkerSnapshot[];
  queuedDelegateCount: number;
  activeWorkers: number;
  maxConcurrent: number;
  workspaceId: string;
  /** 已提醒过的去重键（心跳在活动刷新后删除；needs_you 在离相位后删除） */
  alreadyFired: ReadonlySet<string>;
  heartbeatMs?: number;
  needsYouMs?: number;
};

export type GuardAlert = {
  kind: Extract<
    OrchEventKind,
    'heartbeat_stale' | 'needs_you_stale' | 'slot_free'
  >;
  key: string;
  workspaceId: string;
  sessionId?: string;
  sessionName?: string;
  detail: string;
};

export function evaluateOrchGuards(input: GuardEvalInput): GuardAlert[] {
  const heartbeatMs = input.heartbeatMs ?? ORCH_GUARD_DEFAULTS.heartbeatMs;
  const needsYouMs = input.needsYouMs ?? ORCH_GUARD_DEFAULTS.needsYouMs;
  const out: GuardAlert[] = [];
  const fired = input.alreadyFired;

  for (const w of input.workers) {
    if (w.archived || w.hidden) continue;
    // 编排关联性：守卫只盯被派过活的会话——手工会话心跳/needs_you 停滞归人管。
    if (!w.orchestrated) continue;

    if (sessionHasStalled(w, input.now, heartbeatMs)) {
      const key = orchEventKey('heartbeat_stale', w.workspaceId, w.sessionId);
      if (!fired.has(key)) {
        const mins = Math.round(heartbeatMs / 60_000);
        out.push({
          kind: 'heartbeat_stale',
          key,
          workspaceId: w.workspaceId,
          sessionId: w.sessionId,
          sessionName: w.sessionName,
          detail: `${mins} 分钟无会话活动/输出（lastActivity=${w.lastActivityAt || 0}）`
        });
      }
    }

    if (w.phase === 'needs_you' && w.needsYouSince != null && input.now - w.needsYouSince >= needsYouMs) {
      const key = orchEventKey('needs_you_stale', w.workspaceId, w.sessionId);
      if (!fired.has(key)) {
        const mins = Math.round(needsYouMs / 60_000);
        out.push({
          kind: 'needs_you_stale',
          key,
          workspaceId: w.workspaceId,
          sessionId: w.sessionId,
          sessionName: w.sessionName,
          detail: `needs_you 已超过 ${mins} 分钟无人处理`
        });
      }
    }
  }

  const max = input.maxConcurrent;
  if (max > 0 && input.queuedDelegateCount > 0 && input.activeWorkers < max) {
    const key = orchEventKey('slot_free', input.workspaceId);
    if (!fired.has(key)) {
      out.push({
        kind: 'slot_free',
        key,
        workspaceId: input.workspaceId,
        detail: `并发位空闲可补位（排队 ${input.queuedDelegateCount} / 活跃 ${input.activeWorkers} / 上限 ${max}）`
      });
    }
  }

  return out;
}

/** 活动刷新后应清掉的心跳键；离 needs_you 后清超时键。 */
export function guardKeysToClearOnActivity(workspaceId: string, sessionId: string): string[] {
  return [orchEventKey('heartbeat_stale', workspaceId, sessionId)];
}

export function guardKeysToClearOnPhase(
  workspaceId: string,
  sessionId: string,
  phase: GuardWorkerSnapshot['phase']
): string[] {
  if (phase === 'needs_you') return [];
  return [orchEventKey('needs_you_stale', workspaceId, sessionId)];
}

export function slotFreeKey(workspaceId: string): string {
  return orchEventKey('slot_free', workspaceId);
}

/** 编排关联性：所有按会话的编排上报（相位翻转、回合结束、R3 守卫）只报
 *  `orchestrated === true` 的会话——调度 Agent 拉起/派活时自动置位，调度也可经
 *  sessions.setOrchestrated 动态改（收编用户会话 / 放出 Worker）。用户手工拉起的
 *  会话缺省无标记，其状态由通知系统推给人，不唤醒调度。 */
export function isOrchestratedWorker(s: { orchestrated?: boolean }): boolean {
  return s.orchestrated === true;
}

/** 读入迁移（一次性）：旧版用 briefCount 计数当编排标记（且只在 pty 注入分支 +1），
 *  换成 orchestrated 后，缺省标记但计数>0 的存量会话回填 true 保持跟踪不中断；
 *  显式 false 不复活（调度/人已明确放出的会话以新标记为准）。 */
export function migrateOrchestratedFlag(s: {
  orchestrated?: boolean;
  briefCount?: number;
}): boolean | undefined {
  if (s.orchestrated !== undefined) return s.orchestrated;
  return (s.briefCount ?? 0) > 0 ? true : undefined;
}

// ---------------------------------------------------------------------------
// 守卫状态持久化（O3）：alreadyFired / lastActivity 落 userData JSON，重启不丢。
// 损坏/不可读 → 空对象起步（宁可重报不漏报）；读入按在册会话/工作区 prune 无主 key。
// ---------------------------------------------------------------------------

/** 落盘形态：{ fired: {key: ts}, lastActivity: {sessionId: ts}} */
export interface GuardPersistState {
  fired: Record<string, number>;
  lastActivity: Record<string, number>;
}

export function emptyGuardPersistState(): GuardPersistState {
  return { fired: {}, lastActivity: {} };
}

function coerceTsMap(v: unknown): Record<string, number> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, ts] of Object.entries(v as Record<string, unknown>)) {
    if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) out[k] = ts;
  }
  return out;
}

/** 容错解析：整体不可读/字段坏 → 空对象（调用方宁可重报起步） */
export function parseGuardPersistState(raw: unknown): GuardPersistState {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return emptyGuardPersistState();
    }
  }
  if (typeof raw !== 'object' || raw === null) return emptyGuardPersistState();
  const o = raw as Record<string, unknown>;
  const fired = coerceTsMap(o.fired);
  const lastActivity = coerceTsMap(o.lastActivity);
  if (!fired || !lastActivity) return emptyGuardPersistState();
  return { fired, lastActivity };
}

/** 守卫 key（`kind:workspaceId:sessionId[:extra]`）拆出归属；'-' = 工作区级（无会话） */
export function guardKeyScope(key: string): { workspaceId?: string; sessionId?: string } {
  const parts = key.split(':');
  if (parts.length < 3) return {};
  const [, workspaceId, sessionId] = parts;
  const sid = sessionId && sessionId !== '-' ? sessionId : undefined;
  return { workspaceId: workspaceId || undefined, sessionId: sid };
}

/**
 * 按在册工作区/会话 prune：fired 里工作区已删（或按会话键的会话已删）、
 * lastActivity 里会话已删的条目移除，防状态文件无限膨胀。
 */
export function pruneGuardPersistState(
  state: GuardPersistState,
  aliveWorkspaceIds: ReadonlySet<string>,
  aliveSessionIds: ReadonlySet<string>
): GuardPersistState {
  const fired: Record<string, number> = {};
  for (const [key, ts] of Object.entries(state.fired)) {
    const scope = guardKeyScope(key);
    if (scope.workspaceId && !aliveWorkspaceIds.has(scope.workspaceId)) continue;
    if (scope.sessionId && !aliveSessionIds.has(scope.sessionId)) continue;
    fired[key] = ts;
  }
  const lastActivity: Record<string, number> = {};
  for (const [sid, ts] of Object.entries(state.lastActivity)) {
    if (!aliveSessionIds.has(sid)) continue;
    lastActivity[sid] = ts;
  }
  return { fired, lastActivity };
}

/** 读入合并：同 key 取 max(盘上, 内存) 防回退（load 前已有内存活动时） */
export function mergeLastActivityOnLoad(
  disk: Record<string, number>,
  mem: ReadonlyMap<string, number>
): Record<string, number> {
  const out: Record<string, number> = { ...disk };
  for (const [sid, ts] of mem) {
    out[sid] = Math.max(out[sid] ?? 0, ts);
  }
  return out;
}
