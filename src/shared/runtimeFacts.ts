/**
 * 运行时状态流纯函数：内置字段种类 / 查询过滤 / 状态共享栏校验。
 * 不碰 process（renderer-safe）。
 *
 * 两层严格分开：
 * - 内置字段：程序传感器写入，Agent 走对应 API（setStatus / git / integrate），无自由发事实
 * - 状态共享：每会话 ≤500 字公示栏（share.set 只写自己）
 */

export const SHARE_TEXT_MAX = 500;

export const FACTS_QUERY_LIMIT_DEFAULT = 200;
export const FACTS_QUERY_LIMIT_MAX = 500;

/** 事件账本上限：按条数 + 字节双闸（单条可以很大时条数形同虚设） */
export const FACT_EVENT_MAX_COUNT = 400;
export const FACT_EVENT_MAX_BYTES = 128_000;

export const RUNTIME_FACT_KINDS = [
  'session.phase',
  'session.note',
  'session.activity',
  'session.lifecycle',
  'pipeline.verdict',
  'git.dirty',
  'git.commit',
  'git.integrate'
] as const;

export type BuiltinFactKind = (typeof RUNTIME_FACT_KINDS)[number];

/** 已批准自定义事件的 kind：`event.<id>`，与内置种类并列可订可查 */
export const CUSTOM_EVENT_KIND_PREFIX = 'event.';

export type CustomEventKind = `${typeof CUSTOM_EVENT_KIND_PREFIX}${string}`;

export type RuntimeFactKind = BuiltinFactKind | CustomEventKind;

export type RuntimeFactSource = 'live' | 'event';

export interface RuntimeFact {
  id: string;
  kind: RuntimeFactKind;
  ts: number;
  sessionId?: string;
  workspaceId?: string;
  paths?: string[];
  summary: string;
  data: Record<string, unknown>;
  source: RuntimeFactSource;
}

export interface FactQuery {
  kinds?: RuntimeFactKind[];
  sessionId?: string;
  workspaceId?: string;
  path?: string;
  q?: string;
  limit?: number;
}

export interface SessionShareEntry {
  sessionId: string;
  workspaceId?: string;
  sessionName?: string;
  text: string;
  updatedAt: number;
}

export function isBuiltinFactKind(v: unknown): v is BuiltinFactKind {
  return typeof v === 'string' && (RUNTIME_FACT_KINDS as readonly string[]).includes(v);
}

/** 自定义 kind：`event.` + 小写字母开头的 id（与 runtimeEvents EVENT_ID_RE 对齐） */
export function isCustomEventKind(v: unknown): v is CustomEventKind {
  return (
    typeof v === 'string' &&
    v.startsWith(CUSTOM_EVENT_KIND_PREFIX) &&
    /^[a-z][a-z0-9-]{0,47}$/.test(v.slice(CUSTOM_EVENT_KIND_PREFIX.length))
  );
}

export function isRuntimeFactKind(v: unknown): v is RuntimeFactKind {
  return isBuiltinFactKind(v) || isCustomEventKind(v);
}

export function parseFactKinds(raw: unknown): RuntimeFactKind[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const kinds: RuntimeFactKind[] = [];
  for (const item of list) {
    if (isRuntimeFactKind(item)) {
      kinds.push(item);
      continue;
    }
    // 已注册事件可用裸 id（build-done）或 event.build-done
    if (typeof item === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(item)) {
      kinds.push(`${CUSTOM_EVENT_KIND_PREFIX}${item}`);
    }
  }
  return kinds.length ? kinds : undefined;
}

export function normalizeFactQuery(raw: Record<string, unknown> | undefined): FactQuery {
  const kinds = parseFactKinds(raw?.kinds ?? raw?.type ?? raw?.types);
  const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId.trim() : '';
  const workspaceId = typeof raw?.workspaceId === 'string' ? raw.workspaceId.trim() : '';
  const path = typeof raw?.path === 'string' ? raw.path.trim() : '';
  const q = typeof raw?.q === 'string' ? raw.q.trim() : typeof raw?.keyword === 'string' ? raw.keyword.trim() : '';
  let limit = FACTS_QUERY_LIMIT_DEFAULT;
  if (typeof raw?.limit === 'number' && Number.isFinite(raw.limit)) {
    limit = Math.min(FACTS_QUERY_LIMIT_MAX, Math.max(1, Math.floor(raw.limit)));
  }
  return {
    ...(kinds ? { kinds } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(path ? { path } : {}),
    ...(q ? { q } : {}),
    limit
  };
}

export function matchFact(fact: RuntimeFact, query: FactQuery): boolean {
  if (query.kinds?.length && !query.kinds.includes(fact.kind)) return false;
  if (query.sessionId && fact.sessionId !== query.sessionId) return false;
  if (query.workspaceId && (fact.workspaceId ?? '') !== query.workspaceId) return false;
  if (query.path) {
    const needle = query.path.toLowerCase();
    const paths = fact.paths ?? [];
    const hitPath = paths.some((p) => p.toLowerCase().includes(needle));
    const hitSummary = fact.summary.toLowerCase().includes(needle);
    if (!hitPath && !hitSummary) return false;
  }
  if (query.q) {
    const needle = query.q.toLowerCase();
    if (!fact.summary.toLowerCase().includes(needle)) {
      try {
        if (!JSON.stringify(fact.data).toLowerCase().includes(needle)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

export function queryFacts(facts: readonly RuntimeFact[], query: FactQuery): RuntimeFact[] {
  const limit = query.limit ?? FACTS_QUERY_LIMIT_DEFAULT;
  const hit: RuntimeFact[] = [];
  for (const fact of facts) {
    if (!matchFact(fact, query)) continue;
    hit.push(fact);
    if (hit.length >= limit) break;
  }
  return hit;
}

export type ShareTextResult =
  | { ok: true; text: string }
  | { ok: false; code: 'too_long' | 'not_string' };

/** 空串表示清空本会话公示栏。超 500 字拒绝（不截断）。 */
export function normalizeShareText(raw: unknown): ShareTextResult {
  if (typeof raw !== 'string') return { ok: false, code: 'not_string' };
  if (raw.length > SHARE_TEXT_MAX) return { ok: false, code: 'too_long' };
  return { ok: true, text: raw };
}

export type ShareWriterResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: 'not_actor' | 'not_own' };

/**
 * 状态共享只写自己：必须有 actor；若传了 sessionId 且不是自己则拒。
 * 无身份的宿主/UI 直调不能写。调度调用链解析出的 `orchestrator:<wsId>` 算自己的会话。
 */
export function resolveShareWriter(actorSessionId?: string, requestedSessionId?: string): ShareWriterResult {
  const actor = actorSessionId?.trim() ?? '';
  if (!actor) return { ok: false, code: 'not_actor' };
  const requested = requestedSessionId?.trim() ?? '';
  if (requested && requested !== actor) return { ok: false, code: 'not_own' };
  return { ok: true, sessionId: actor };
}

const ORCHESTRATOR_SESSION_PREFIX = 'orchestrator:';

/** 每工作区调度 Agent 的合成会话 id（不进 sessions.observe，但感知面写/订阅认它）。 */
export function orchestratorSessionId(workspaceId: string): string {
  const ws = workspaceId.trim();
  return ws ? `${ORCHESTRATOR_SESSION_PREFIX}${ws}` : '';
}

export function isOrchestratorSessionId(sessionId: string | undefined | null): boolean {
  return (sessionId?.trim() ?? '').startsWith(ORCHESTRATOR_SESSION_PREFIX);
}

export function parseOrchestratorWorkspaceId(sessionId: string | undefined | null): string {
  const sid = sessionId?.trim() ?? '';
  if (!sid.startsWith(ORCHESTRATOR_SESSION_PREFIX)) return '';
  return sid.slice(ORCHESTRATOR_SESSION_PREFIX.length);
}

/**
 * 感知面写/订阅身份：注入的 Worker 会话优先；调度调用链落到 `orchestrator:<wsId>`。
 * 无注入且非调度 → 空串（UI/宿主直调仍无身份）。
 */
export function resolveAwarenessActorId(opts: {
  injectedSessionId?: string;
  isScheduler?: boolean;
  workspaceId?: string;
}): string {
  const injected = opts.injectedSessionId?.trim() ?? '';
  if (injected) return injected;
  if (opts.isScheduler) return orchestratorSessionId(opts.workspaceId ?? '');
  return '';
}

/** 感知面存活集合：真实会话 + 各工作区调度合成 id。prune 必须带上后者，否则调度公示/订阅会被清掉。 */
export function listAliveAwarenessSessionIds(
  sessionIds: readonly string[],
  workspaceIds: readonly string[]
): string[] {
  const alive: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const s = id.trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    alive.push(s);
  };
  for (const id of sessionIds) add(id);
  for (const ws of workspaceIds) add(orchestratorSessionId(ws));
  return alive;
}

export function liveFactId(kind: RuntimeFactKind, sessionId?: string, workspaceId?: string): string {
  return `live:${kind}:${sessionId || workspaceId || '_'}`;
}

export function estimateFactBytes(fact: RuntimeFact): number {
  try {
    return JSON.stringify(fact).length;
  } catch {
    return 256;
  }
}

/** 淘汰最旧事件，使条数与字节同时落在预算内；保底至少留下最新 1 条（单条超字节也不丢）。 */
export function evictFactEvents(facts: RuntimeFact[]): RuntimeFact[] {
  if (facts.length <= FACT_EVENT_MAX_COUNT) {
    let bytes = 0;
    for (const f of facts) bytes += estimateFactBytes(f);
    if (bytes <= FACT_EVENT_MAX_BYTES) return facts;
  }
  const sorted = facts.slice().sort((a, b) => a.ts - b.ts);
  const kept: RuntimeFact[] = [];
  let bytes = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const f = sorted[i];
    const n = estimateFactBytes(f);
    // 保底：最新 1 条无条件保留——连最新事实都查不到，比账本超预算更糟；
    // 其余照旧按条数/字节预算淘汰（单条超字节的旧事实照丢）
    const isNewest = i === sorted.length - 1;
    if (!isNewest && (kept.length >= FACT_EVENT_MAX_COUNT || bytes + n > FACT_EVENT_MAX_BYTES)) {
      continue;
    }
    kept.push(f);
    bytes += n;
  }
  return kept.sort((a, b) => a.ts - b.ts);
}
