/**
 * 自定义事件注册/审核/发射：纯函数，不碰 process（renderer-safe）。
 *
 * 内置事实免注册。新事件名 events.register → pending；人或调度审过才 approved。
 * Worker 不能自审（也不能审别人的）。拒了即关。通过后他人可订、登记发射方可 emit。
 */
import {
  CUSTOM_EVENT_KIND_PREFIX,
  isBuiltinFactKind,
  isCustomEventKind,
  isOrchestratorSessionId,
  type RuntimeFact
} from './runtimeFacts';
import {
  emptySubscribeLedger,
  FACT_SUBSCRIBE_DEBOUNCE_MS,
  FACT_SUBSCRIBE_HOURLY_LIMIT,
  FACT_SUBSCRIBE_HOURLY_WINDOW_MS,
  type SubscribeRateLedger
} from './runtimeFactsSubscribe';

/** 与扩展 id 同口径：小写字母开头，字母数字连字符 */
export const EVENT_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

export const EVENT_TEXT_MAX = 500;

export { CUSTOM_EVENT_KIND_PREFIX, isCustomEventKind };

export type EventRegStatus = 'pending' | 'approved' | 'rejected';

export type EventReviewerRole = 'human' | 'scheduler';

export type EventReviewDecision = 'approve' | 'reject';

export interface EventRegistration {
  id: string;
  description: string;
  why: string;
  status: EventRegStatus;
  proposerSessionId: string;
  /** 允许 emit 的会话 id；缺省含提出方 */
  emitters: string[];
  createdAt: number;
  reviewedAt?: number;
  reviewedBy?: EventReviewerRole;
  reviewerSessionId?: string;
  workspaceId?: string;
}

export type EventIdResult =
  | { ok: true; id: string }
  | { ok: false; code: 'empty' | 'invalid' | 'reserved' };

export type EventTextResult =
  | { ok: true; text: string }
  | { ok: false; code: 'empty' | 'too_long' | 'not_string' };

export type EventReviewAuth =
  | { ok: true; role: EventReviewerRole }
  | { ok: false; code: 'worker' | 'self' };

export type EventEmitAuth =
  | { ok: true }
  | { ok: false; code: 'not_approved' | 'rejected' | 'pending' | 'not_emitter' | 'missing' };

export type EventEmitSkipReason = 'debounce' | 'emitter_limit';

export function customEventKind(id: string): string {
  return `${CUSTOM_EVENT_KIND_PREFIX}${id}`;
}

export function parseEventIdFromKind(kind: string): string {
  if (!kind.startsWith(CUSTOM_EVENT_KIND_PREFIX)) return kind;
  return kind.slice(CUSTOM_EVENT_KIND_PREFIX.length);
}

export function normalizeEventId(raw: unknown): EventIdResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'empty' };
  const id = raw.trim().toLowerCase();
  if (!EVENT_ID_RE.test(id)) return { ok: false, code: 'invalid' };
  if (isBuiltinFactKind(id) || isBuiltinFactKind(customEventKind(id))) {
    return { ok: false, code: 'reserved' };
  }
  return { ok: true, id };
}

export function normalizeEventText(raw: unknown): EventTextResult {
  if (typeof raw !== 'string') return { ok: false, code: 'not_string' };
  const text = raw.trim();
  if (!text) return { ok: false, code: 'empty' };
  if (text.length > EVENT_TEXT_MAX) return { ok: false, code: 'too_long' };
  return { ok: true, text };
}

export function isEventReviewDecision(v: unknown): v is EventReviewDecision {
  return v === 'approve' || v === 'reject';
}

/**
 * 审核身份：Worker 一律拒（含自审）。人（host / UI 确认框）与调度均可审。
 * scheduler 调用链标 role=scheduler；其余无 Worker 身份的 host 算人审。
 */
export function authorizeEventReview(opts: {
  actorRole: 'worker' | 'host';
  actorId?: string;
  proposerSessionId: string;
  isScheduler?: boolean;
}): EventReviewAuth {
  if (opts.actorRole === 'worker') {
    return { ok: false, code: opts.actorId === opts.proposerSessionId ? 'self' : 'worker' };
  }
  return { ok: true, role: opts.isScheduler ? 'scheduler' : 'human' };
}

export function authorizeEventEmit(
  reg: EventRegistration | undefined,
  actorSessionId: string
): EventEmitAuth {
  if (!reg) return { ok: false, code: 'missing' };
  if (reg.status === 'pending') return { ok: false, code: 'pending' };
  if (reg.status === 'rejected') return { ok: false, code: 'rejected' };
  if (reg.status !== 'approved') return { ok: false, code: 'not_approved' };
  if (!reg.emitters.includes(actorSessionId)) return { ok: false, code: 'not_emitter' };
  return { ok: true };
}

export function applyEventReview(
  reg: EventRegistration,
  decision: EventReviewDecision,
  reviewer: { role: EventReviewerRole; sessionId?: string },
  now: number
): EventRegistration {
  return {
    ...reg,
    status: decision === 'approve' ? 'approved' : 'rejected',
    reviewedAt: now,
    reviewedBy: reviewer.role,
    ...(reviewer.sessionId ? { reviewerSessionId: reviewer.sessionId } : {})
  };
}

export function eventEmitDebounceKey(eventId: string, emitterSessionId: string): string {
  return `event:${eventId}:${emitterSessionId}`;
}

export function eventEmitterHourlyKey(emitterSessionId: string): string {
  return `event-emit:${emitterSessionId}`;
}

/**
 * R-16：清 emitters 列表里的悬空会话 id。alive 集按 listAliveAwarenessSessionIds
 * 口径（在册会话 + 各工作区 `orchestrator:<wsId>` 合成 id），调度合成 id 因此天然保留。
 * 清到空也无妨：事件仍可订，只是无人能发（悬空 id 本就无害，清掉只为不误导）。
 */
export function pruneStaleEventEmitters(
  emitters: readonly string[],
  aliveSessionIds: ReadonlySet<string>
): string[] {
  return emitters.filter((id) => aliveSessionIds.has(id) || isOrchestratorSessionId(id));
}

function pruneHits(hits: number[], now: number, windowMs: number): number[] {
  const from = now - windowMs;
  return hits.filter((t) => t > from);
}

/** 发射方防抖 + 每小时上限（与订阅投递同口径）。 */
export function decideEventEmit(
  eventId: string,
  emitterSessionId: string,
  ledger: SubscribeRateLedger,
  now: number,
  opts?: { debounceMs?: number; hourlyLimit?: number; windowMs?: number }
): { ok: true } | { ok: false; reason: EventEmitSkipReason } {
  const debounceMs = opts?.debounceMs ?? FACT_SUBSCRIBE_DEBOUNCE_MS;
  const hourlyLimit = opts?.hourlyLimit ?? FACT_SUBSCRIBE_HOURLY_LIMIT;
  const windowMs = opts?.windowMs ?? FACT_SUBSCRIBE_HOURLY_WINDOW_MS;
  const dKey = eventEmitDebounceKey(eventId, emitterSessionId);
  const last = ledger.lastFire[dKey] ?? 0;
  if (last && now - last < debounceMs) {
    return { ok: false, reason: 'debounce' };
  }
  const emitKey = eventEmitterHourlyKey(emitterSessionId);
  const hits = pruneHits(ledger.hits[emitKey] ?? [], now, windowMs);
  if (hits.length >= hourlyLimit) {
    return { ok: false, reason: 'emitter_limit' };
  }
  ledger.lastFire[dKey] = now;
  ledger.hits[emitKey] = [...hits, now];
  return { ok: true };
}

export function emptyEventEmitLedger(): SubscribeRateLedger {
  return emptySubscribeLedger();
}

export function projectCustomEventFact(input: {
  id: string;
  description: string;
  summary?: string;
  sessionId: string;
  workspaceId?: string;
  paths?: string[];
  data?: Record<string, unknown>;
  now?: number;
}): RuntimeFact {
  const now = input.now ?? Date.now();
  const kind = customEventKind(input.id);
  const summary = (input.summary?.trim() || input.description).slice(0, 200);
  return {
    id: `event:${input.id}:${now}:${Math.random().toString(36).slice(2, 10)}`,
    kind: kind as RuntimeFact['kind'],
    ts: now,
    sessionId: input.sessionId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.paths?.length ? { paths: input.paths } : {}),
    summary,
    data: {
      eventId: input.id,
      description: input.description,
      ...(input.data ?? {})
    },
    source: 'event'
  };
}

export function isEventRegistrationShape(v: unknown): v is EventRegistration {
  if (!v || typeof v !== 'object') return false;
  const e = v as EventRegistration;
  return (
    typeof e.id === 'string' &&
    typeof e.description === 'string' &&
    typeof e.why === 'string' &&
    (e.status === 'pending' || e.status === 'approved' || e.status === 'rejected') &&
    typeof e.proposerSessionId === 'string' &&
    Array.isArray(e.emitters) &&
    typeof e.createdAt === 'number'
  );
}
