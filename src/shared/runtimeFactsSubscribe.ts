/**
 * 内置事实订阅：持续查询 + 防抖/限频判定 + 注入文案。
 * 纯函数，不碰 process（renderer-safe）。
 *
 * Worker 默认谁都不订。调度合成 id 首次出现时由宿主挂默认集（可退订）。
 * 命中后由宿主保存事件邮件；本文件不发消息。
 */
import {
  matchFact,
  normalizeFactQuery,
  type BuiltinFactKind,
  type FactQuery,
  type RuntimeFact
} from './runtimeFacts';

/** 同一订阅方 + 同一发射方 + 同一 kind 的推送间隔 */
export const FACT_SUBSCRIBE_DEBOUNCE_MS = 2000;

/** 每订阅方 / 每发射方 每小时上限（独立计数） */
export const FACT_SUBSCRIBE_HOURLY_LIMIT = 20;

export const FACT_SUBSCRIBE_HOURLY_WINDOW_MS = 60 * 60 * 1000;

/** 单会话最多挂几条持续查询 */
export const FACT_SUBSCRIBE_MAX_PER_SESSION = 20;

export type SubscribeSkipReason = 'self' | 'debounce' | 'subscriber_limit' | 'emitter_limit';

/**
 * 事件面收敛（2026-10-25 用户拍板）：空闲/运行中等常规状态翻转不再对订阅方产生事件邮件，
 * 订阅投递面只保留「需要你（session.phase）」「停滞（pipeline.verdict）」这类有意义事件。
 * 查询面（sessions.observe / queryRuntimeState）不受影响：完整状态流照常可查。
 * 触发过频交给既有防抖（2s）与每小时限额（20 条），不做新的抑制机制。
 */
export const SUBSCRIBE_SUPPRESSED_KINDS = [
  'session.activity',
  'session.lifecycle'
] as const satisfies readonly BuiltinFactKind[];

export function isSuppressedFactKind(kind: RuntimeFact['kind'] | string): boolean {
  return (SUBSCRIBE_SUPPRESSED_KINDS as readonly string[]).includes(kind);
}

export interface FactSubscription {
  id: string;
  subscriberSessionId: string;
  query: FactQuery;
  createdAt: number;
}

export interface SubscribeRateLedger {
  /** `sub:${sessionId}` / `emit:${sessionId|workspaceId}` → 成功投递时间戳 */
  hits: Record<string, number[]>;
  /** `${subscriptionId}:${kind}:${emitter}` → 上次成功投递 */
  lastFire: Record<string, number>;
}

export function emptySubscribeLedger(): SubscribeRateLedger {
  return { hits: {}, lastFire: {} };
}

export function normalizeSubscribeQuery(raw: Record<string, unknown> | undefined): FactQuery {
  const q = normalizeFactQuery(raw ?? {});
  const rawKinds = raw?.kinds ?? raw?.type ?? raw?.types;
  if (rawKinds !== undefined && rawKinds !== null && rawKinds !== '') {
    const list = Array.isArray(rawKinds) ? rawKinds : [rawKinds];
    if (!list.length || q.kinds?.length !== list.length) throw new Error('事件种类无效；请选择内置变化或已批准的 event.<id>');
  }
  const { limit: _limit, ...rest } = q;
  return rest;
}

export function matchSubscriptions(
  subs: readonly FactSubscription[],
  fact: RuntimeFact
): FactSubscription[] {
  return subs.filter((s) => matchFact(fact, s.query));
}

export function subscribeDebounceKey(sub: FactSubscription, fact: RuntimeFact): string {
  return `${sub.id}:${fact.kind}:${fact.sessionId || fact.workspaceId || '_'}`;
}

export function subscribeEmitterKey(fact: RuntimeFact): string {
  return `emit:${fact.sessionId || fact.workspaceId || '_'}`;
}

export function subscribeSubscriberKey(subscriberSessionId: string): string {
  return `sub:${subscriberSessionId}`;
}

function pruneHits(hits: number[], now: number, windowMs: number): number[] {
  const from = now - windowMs;
  return hits.filter((t) => t > from);
}

export function decideSubscribeDelivery(
  sub: FactSubscription,
  fact: RuntimeFact,
  ledger: SubscribeRateLedger,
  now: number,
  opts?: { debounceMs?: number; hourlyLimit?: number; windowMs?: number }
): { ok: true } | { ok: false; reason: SubscribeSkipReason } {
  if (fact.sessionId && fact.sessionId === sub.subscriberSessionId) {
    return { ok: false, reason: 'self' };
  }
  const debounceMs = opts?.debounceMs ?? FACT_SUBSCRIBE_DEBOUNCE_MS;
  const hourlyLimit = opts?.hourlyLimit ?? FACT_SUBSCRIBE_HOURLY_LIMIT;
  const windowMs = opts?.windowMs ?? FACT_SUBSCRIBE_HOURLY_WINDOW_MS;
  const dKey = subscribeDebounceKey(sub, fact);
  const last = ledger.lastFire[dKey] ?? 0;
  if (last && now - last < debounceMs) {
    return { ok: false, reason: 'debounce' };
  }
  const subKey = subscribeSubscriberKey(sub.subscriberSessionId);
  const emitKey = subscribeEmitterKey(fact);
  const subHits = pruneHits(ledger.hits[subKey] ?? [], now, windowMs);
  if (subHits.length >= hourlyLimit) {
    return { ok: false, reason: 'subscriber_limit' };
  }
  const emitHits = pruneHits(ledger.hits[emitKey] ?? [], now, windowMs);
  if (emitHits.length >= hourlyLimit) {
    return { ok: false, reason: 'emitter_limit' };
  }
  ledger.lastFire[dKey] = now;
  ledger.hits[subKey] = [...subHits, now];
  ledger.hits[emitKey] = [...emitHits, now];
  return { ok: true };
}

/**
 * 调度角色默认订阅集（用户拍板）：停滞推送与 needs_you 相位。
 * Worker 仍默认空表。相位只订 needs_you，避免 idle/done 刷屏。
 */
export const ORCHESTRATOR_DEFAULT_SUBSCRIBE_KINDS = [
  'pipeline.verdict',
  'session.phase'
] as const satisfies readonly BuiltinFactKind[];

export type OrchestratorDefaultSubscribeKind = (typeof ORCHESTRATOR_DEFAULT_SUBSCRIBE_KINDS)[number];

/** session.phase 默认查询关键词：摘要形如 `name phase=needs_you` */
export const ORCHESTRATOR_DEFAULT_PHASE_Q = 'phase=needs_you';

export function buildOrchestratorDefaultQuery(
  kind: OrchestratorDefaultSubscribeKind,
  workspaceId: string
): FactQuery {
  return normalizeSubscribeQuery({
    kinds: kind,
    workspaceId,
    ...(kind === 'session.phase' ? { q: ORCHESTRATOR_DEFAULT_PHASE_Q } : {})
  });
}

/** 已有订阅是否覆盖某条默认查询（更宽的查询也算覆盖，避免重复挂）。 */
export function subscriptionCoversDefault(
  sub: Pick<FactSubscription, 'query'>,
  kind: OrchestratorDefaultSubscribeKind,
  workspaceId: string
): boolean {
  const q = sub.query;
  if (q.kinds?.length && !q.kinds.includes(kind)) return false;
  if (q.workspaceId && q.workspaceId !== workspaceId) return false;
  if (q.sessionId) return false;
  if (q.path) return false;
  if (kind === 'session.phase') {
    if (q.q && !q.q.toLowerCase().includes('needs_you')) return false;
  } else if (q.q) {
    return false;
  }
  return true;
}

export type OrchestratorDefaultPlanReason = 'already_seeded' | 'already_covered' | 'add';

export function planOrchestratorDefaultSubscriptions(input: {
  subscriberSessionId: string;
  workspaceId: string;
  existing: readonly FactSubscription[];
  seeded: boolean;
}): { kindsToAdd: OrchestratorDefaultSubscribeKind[]; reason: OrchestratorDefaultPlanReason } {
  if (input.seeded) return { kindsToAdd: [], reason: 'already_seeded' };
  const mine = input.existing.filter((s) => s.subscriberSessionId === input.subscriberSessionId);
  const kindsToAdd = ORCHESTRATOR_DEFAULT_SUBSCRIBE_KINDS.filter(
    (kind) => !mine.some((s) => subscriptionCoversDefault(s, kind, input.workspaceId))
  );
  if (!kindsToAdd.length) return { kindsToAdd: [], reason: 'already_covered' };
  return { kindsToAdd, reason: 'add' };
}
