/**
 * 调度 Agent 的 needs_you 状态通道（与 Worker SessionMeta 平行，不进看板）。
 * 缺省目标（不传 sessionId / externalSessionId / statusToken）且调用链是调度时，
 * 报到本工作区调度会话（orchestrator:<wsId>）；左栏视觉入口由未读回复气泡承载，
 * 不再计入工作区黄点数字。
 */
import { isNeedsYouPeekSession } from './boardReview';
import {
  isOrchestratorSessionId,
  orchestratorSessionId,
  parseOrchestratorWorkspaceId
} from './runtimeFacts';
import {
  capsuleForSetStatus,
  type NormalizedSetStatus
} from './setStatus';
import type { LiveStatusKind, SessionMeta, SessionPhaseKind } from './types';

export interface SchedulerStatus {
  workspaceId: string;
  /** 合成 id：orchestrator:<workspaceId>，不进 sessions.observe */
  sessionId: string;
  phase?: SessionPhaseKind;
  note?: string;
  kind?: LiveStatusKind;
  ts: number;
}

export type SetStatusChannel =
  | { channel: 'worker' }
  | { channel: 'scheduler'; workspaceId: string; sessionId: string }
  | { channel: 'missing' };

/**
 * O12 决策门：该工作区调度是否在等人（phase=needs_you）。
 * 无状态 / 已移除 → false（fail-open：状态读失败由调用方兜底为不挡）。
 */
export function isSchedulerBlockedOnHuman(status: SchedulerStatus | undefined): boolean {
  return status?.phase === 'needs_you';
}

/**
 * 解析 sessions.setStatus 落点。
 * - 显式 Worker 定位（sessionId / externalSessionId / statusToken）走 Worker；
 * - sessionId 已是 orchestrator: 合成 id → 调度通道（防呆：模型编造了合成 id 也不建 SessionMeta）；
 * - 全空且 isScheduler → 本工作区调度会话；
 * - 全空且非调度 → missing（沿用「需要 statusToken」）。
 */
export function resolveSetStatusChannel(input: {
  sessionId?: string;
  externalSessionId?: string;
  statusToken?: string;
  isScheduler: boolean;
  workspaceId?: string;
}): SetStatusChannel {
  const sid = input.sessionId?.trim() || '';
  const ext = input.externalSessionId?.trim() || '';
  const tok = input.statusToken?.trim() || '';

  if (sid && isOrchestratorSessionId(sid)) {
    const ws = parseOrchestratorWorkspaceId(sid) || input.workspaceId?.trim() || '';
    if (!ws) return { channel: 'missing' };
    return { channel: 'scheduler', workspaceId: ws, sessionId: orchestratorSessionId(ws) };
  }

  if (sid || ext || tok) return { channel: 'worker' };

  if (input.isScheduler) {
    const ws = input.workspaceId?.trim() || '';
    if (!ws) return { channel: 'missing' };
    return { channel: 'scheduler', workspaceId: ws, sessionId: orchestratorSessionId(ws) };
  }
  return { channel: 'missing' };
}

/** 调度通道写相位：复用 setStatus 状态决策，不碰 SessionMeta / 粘性 / 脏树。 */
export function applySchedulerSetStatus(
  prev: SchedulerStatus | undefined,
  input: {
    workspaceId: string;
    sessionId: string;
    phase?: SessionPhaseKind;
    note?: string;
    kind?: LiveStatusKind;
  },
  now: number
): SchedulerStatus {
  const norm: NormalizedSetStatus = {
    phase: input.phase,
    note: input.note,
    kind: input.kind
  };
  const phaseApplied = !!norm.phase;
  const capsule = capsuleForSetStatus(norm, phaseApplied);
  return {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    phase: norm.phase ?? prev?.phase,
    note: capsule?.label ?? prev?.note,
    kind: capsule?.kind ?? prev?.kind,
    ts: now
  };
}

/** 某工作区黄点数字：只计看板「需要你」口径的 Worker；调度 needs_you 不进黄点
 *  （与 Worker 状态机隔离，豁免落在 notifyDecision 对 orchestrator: 身份的拦截；
 *  调度以未读回复气泡表达）。 */
export function workspaceNeedsYouCount(input: {
  sessions: readonly SessionMeta[];
  workspaceId: string;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  const wsId = input.workspaceId.trim();
  return input.sessions.filter(
    (s) => (s.workspaceId ?? '') === wsId && isNeedsYouPeekSession(s, now)
  ).length;
}

export function parseSchedulerStatusMap(raw: unknown): Record<string, SchedulerStatus> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, SchedulerStatus> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseOneSchedulerStatus(key, val);
    if (parsed) out[parsed.workspaceId] = parsed;
  }
  return out;
}

function parseOneSchedulerStatus(key: string, raw: unknown): SchedulerStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const workspaceId =
    (typeof o.workspaceId === 'string' && o.workspaceId.trim()) || key.trim();
  if (!workspaceId) return null;
  const phase =
    o.phase === 'idle' || o.phase === 'needs_you' || o.phase === 'done' ? o.phase : undefined;
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 40) : undefined;
  const kind =
    o.kind === 'info' ||
    o.kind === 'active' ||
    o.kind === 'waiting' ||
    o.kind === 'done' ||
    o.kind === 'error'
      ? o.kind
      : undefined;
  const ts = typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : 0;
  return {
    workspaceId,
    sessionId:
      typeof o.sessionId === 'string' && isOrchestratorSessionId(o.sessionId)
        ? o.sessionId
        : orchestratorSessionId(workspaceId),
    phase,
    note: note || undefined,
    kind,
    ts
  };
}
