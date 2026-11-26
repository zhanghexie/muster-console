/**
 * Standing intents（前瞻记忆，memory-refactor §9，B7）：服务层 + 双触发面纯函数。
 *
 * 表：intents（B1 schema v1 已建，列见 db.ts）。状态机：
 *   pending → armed → fired → done（发射预算耗尽）
 *   cancelled / expired 为终态。创建即 armed（立即可触发）；fire 后 fire_count < 预算
 *   回 'fired' 态继续可触发，预算耗尽 → 'done'。
 *
 * **取消是持久状态，永不从对话推断**：只有 intent 工具（用户当回合明示）与面板
 * 手动取消能把意图置 cancelled；消息面/事件面扫描永不改写 cancelled。
 *
 * 防骚扰默认（§9）：冷却 24h / 发射预算 3 次 / 90 天过期 / 每回合注入 ≤3 条。
 * 过期与冷却推进 piggyback 在消息面/事件面扫描与面板读取上（sweepIntentExpiry），
 * 不加新定时子系统。
 *
 * 双触发面（决策 #6，超越点 #4）：
 * - 消息面：调度收到的用户消息跑**确定性全词预筛**（候选条目的每个关键词都出现才
 *   命中；每回合扫 ≤256 条 scoped 候选），纯函数 matchIntentKeywords；
 * - 事件面：任务事件总线结构化谓词（kind + 字段确定性匹配，零模型调用），
 *   纯函数 matchIntentEvent；事件源真实字段见 shared/memoryCenterIpc.IntentEventPredicate。
 *
 * 命中后单事务复查（tryFireIntent，BEGIN IMMEDIATE）：作用域（状态）→ 过期 → 冷却 →
 * 预算，全过才 fire_count+1/last_fired_at 更新/状态推进。
 *
 * node-only（MemoryDb + shared 类型；.mjs 可转译直测）。
 */
import { MemoryDb } from './db';
import { appendEvent } from './events';
import {
  normalizeIntentEventPredicate,
  type IntentEventPredicate
} from '../../shared/memoryCenterIpc';

export const INTENT_CONSTANTS = {
  /** 默认冷却（§9：24h） */
  DEFAULT_COOLDOWN_MS: 24 * 3_600_000,
  /** 默认发射预算（§9：最多 3 次） */
  DEFAULT_FIRE_BUDGET: 3,
  /** 默认过期（§9：90 天，epoch ms） */
  DEFAULT_EXPIRY_MS: 90 * 86_400_000,
  /** 每回合注入上限（§9：≤3 条） */
  MAX_INJECT_PER_TURN: 3,
  /** 每回合扫描候选上限（§9：≤256 条 scoped 候选） */
  MAX_SCAN_CANDIDATES: 256,
  /** 注入块单条描述截断 */
  DESCRIPTION_SNIPPET_CHARS: 120
} as const;

export type IntentState = 'pending' | 'armed' | 'fired' | 'done' | 'cancelled' | 'expired';

export interface IntentRecord {
  id: number;
  description: string;
  keywords: string[];
  eventPredicates: IntentEventPredicate[];
  state: IntentState;
  fireCount: number;
  fireBudget: number | null;
  cooldownMs: number | null;
  expiry: number | null;
  lastFiredAt: number | null;
  createdAt: number;
  createdBy: string | null;
}

function rowToRecord(r: Record<string, unknown>): IntentRecord {
  let keywords: string[] = [];
  try {
    const v = JSON.parse(String(r.trigger_keywords ?? '[]')) as unknown;
    if (Array.isArray(v)) keywords = v.filter((x): x is string => typeof x === 'string' && !!x.trim());
  } catch {
    /* 坏 JSON = 无关键词 */
  }
  let predicates: IntentEventPredicate[] = [];
  try {
    const v = JSON.parse(String(r.event_predicates_json ?? '[]')) as unknown;
    if (Array.isArray(v)) {
      predicates = v
        .map((p) => normalizeIntentEventPredicate(p))
        .filter((p): p is IntentEventPredicate => p !== null);
    }
  } catch {
    /* 坏 JSON = 无事件谓词 */
  }
  return {
    id: Number(r.id),
    description: String(r.description ?? ''),
    keywords,
    eventPredicates: predicates,
    state: String(r.state) as IntentState,
    fireCount: Number(r.fire_count ?? 0),
    fireBudget: r.fire_budget == null ? null : Number(r.fire_budget),
    cooldownMs: r.cooldown_ms == null ? null : Number(r.cooldown_ms),
    expiry: r.expiry == null ? null : Number(r.expiry),
    lastFiredAt: r.last_fired_at == null ? null : Number(r.last_fired_at),
    createdAt: Number(r.created_at),
    createdBy: (r.created_by as string | null) ?? null
  };
}

// ---------------------------------------------------------------------------
// 创建 / 列出 / 取消 / 重新武装 / 过期清扫
// ---------------------------------------------------------------------------

export interface IntentCreateInput {
  description: string;
  /** 消息面触发关键词（全词预筛；可空） */
  triggerKeywords?: string[];
  /** 事件面谓词（可空；与关键词至少其一非空——纯时间型意图不收） */
  eventPredicates?: unknown[];
  /** 冷却 ms（缺省 24h；显式 0=每次命中即发；负值/非数字回落缺省——工具层负值先钳 0） */
  cooldownMs?: number | null;
  /** 发射预算（缺省 3） */
  fireBudget?: number | null;
  /** 过期 epoch ms（缺省 now+90d） */
  expiry?: number | null;
  createdBy?: string;
  now: number;
}

export function insertIntent(db: MemoryDb, input: IntentCreateInput): IntentRecord {
  const description = String(input.description ?? '').trim();
  if (!description) throw new Error('[memory-intents] description 不能为空');
  const keywords = (input.triggerKeywords ?? [])
    .map((k) => String(k).trim())
    .filter(Boolean);
  const predicates = (input.eventPredicates ?? [])
    .map((p) => normalizeIntentEventPredicate(p))
    .filter((p): p is IntentEventPredicate => p !== null);
  if (keywords.length === 0 && predicates.length === 0) {
    throw new Error('[memory-intents] 意图缺少触发面（关键词/事件谓词至少其一）');
  }
  const budgetRaw = input.fireBudget ?? INTENT_CONSTANTS.DEFAULT_FIRE_BUDGET;
  const budget = Number.isInteger(budgetRaw) && budgetRaw > 0 ? budgetRaw : INTENT_CONSTANTS.DEFAULT_FIRE_BUDGET;
  const cooldown =
    input.cooldownMs != null && Number.isFinite(input.cooldownMs) && input.cooldownMs >= 0
      ? Math.round(input.cooldownMs)
      : INTENT_CONSTANTS.DEFAULT_COOLDOWN_MS;
  const expiry = input.expiry != null && Number.isFinite(input.expiry) ? Math.round(input.expiry) : input.now + INTENT_CONSTANTS.DEFAULT_EXPIRY_MS;
  return db.write((tx) => {
    const info = tx
      .prepare(
        `INSERT INTO intents (description, trigger_keywords, event_predicates_json, channel_scope, sender_scope,
                              expiry, cooldown_ms, fire_budget, fire_count, state, created_by, created_at, last_fired_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 0, 'armed', ?, ?, NULL)`
      )
      .run(description, JSON.stringify(keywords), JSON.stringify(predicates), expiry, cooldown, budget, input.createdBy ?? 'intent-tool', input.now);
    const id = Number(info.lastInsertRowid);
    const row = tx.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Record<string, unknown>;
    return rowToRecord(row);
  });
}

/** 全量列出（面板生命周期表；created_at 降序） */
export function listIntents(db: MemoryDb): IntentRecord[] {
  const rows = db.handle.prepare('SELECT * FROM intents ORDER BY id DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToRecord);
}

export function getIntent(db: MemoryDb, id: number): IntentRecord | null {
  const row = db.handle.prepare('SELECT * FROM intents WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * 手动取消（intent 工具 cancel / 面板按钮）：**持久终态**，任何非 cancelled 态都可取消
 * （幂等）。取消后永不从对话/事件推断恢复——恢复只有面板「重新武装」显式入口。
 * `intent_cancelled` 事件（条目 1A 写点收口）：与状态翻转同事务，恰好一行。
 */
export function cancelIntent(db: MemoryDb, id: number, now: number): boolean {
  return db.write((tx) => {
    const row = tx.prepare('SELECT description FROM intents WHERE id = ?').get(id) as
      | { description: string }
      | undefined;
    const info = tx
      .prepare("UPDATE intents SET state = 'cancelled' WHERE id = ? AND state != 'cancelled'")
      .run(id);
    if (Number(info.changes) === 0) return false;
    appendEvent(db, {
      kind: 'intent_cancelled',
      ts: now,
      entryRef: `intent:${id}`,
      summary: '前瞻意图已取消：{{description}}',
      summaryArgs: { description: snippetForEvent(row?.description ?? '') }
    });
    return true;
  });
}

export interface IntentRearmResult {
  ok: boolean;
  error?: string;
  record?: IntentRecord;
}

/**
 * 面板「重新武装」：发射计数/上次发射清零（冷却即刻解除），状态回 armed；
 * 已过期的过期时间续期为 now+90d。cancelled 也可重武装——这是人点按钮的显式操作，
 * 与「取消是持久状态，永不从对话推断」不冲突（推断面永不触碰 cancelled）。
 */
export function rearmIntent(db: MemoryDb, id: number, now: number): IntentRearmResult {
  return db.write((tx) => {
    const row = tx.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: '意图不存在' };
    const rec = rowToRecord(row);
    const expiry = rec.expiry != null && rec.expiry < now ? now + INTENT_CONSTANTS.DEFAULT_EXPIRY_MS : rec.expiry;
    tx.prepare(
      "UPDATE intents SET state = 'armed', fire_count = 0, last_fired_at = NULL, expiry = ? WHERE id = ?"
    ).run(expiry, id);
    return { ok: true, record: getIntent(db, id) ?? undefined };
  });
}

/** 过期清扫：pending/armed/fired 且 expiry 已过 → expired（返回条数；终态不动） */
export function sweepIntentExpiry(db: MemoryDb, now: number): number {
  return db.write((tx) => {
    const info = tx
      .prepare(
        "UPDATE intents SET state = 'expired' WHERE state IN ('pending','armed','fired') AND expiry IS NOT NULL AND expiry < ?"
      )
      .run(now);
    return Number(info.changes);
  });
}

// ---------------------------------------------------------------------------
// 消息面：确定性全词预筛（纯函数）
// ---------------------------------------------------------------------------

/**
 * 全词预筛（§9）：候选的**每个关键词都出现**于消息才命中（大小写不敏感的包含判定，
 * 与 trigger 词法同口径）；关键词表为空 → 消息面永不命中。
 */
export function matchIntentKeywords(keywords: ReadonlyArray<string>, message: string): boolean {
  const kws = (keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kws.length === 0) return false;
  const hay = (message ?? '').toLowerCase();
  if (!hay.trim()) return false;
  return kws.every((k) => hay.includes(k));
}

// ---------------------------------------------------------------------------
// 事件面：结构化谓词确定性匹配（纯函数，零模型调用）
// ---------------------------------------------------------------------------

/** 事件输入（宿主从任务事件/通知总线/合入缝/PR watch 归一后传入） */
export interface IntentEventInput {
  kind: IntentEventPredicate['kind'];
  /** notify_flip */
  trigger?: string;
  /** merge_blocked / pr_merged */
  branch?: string;
  repo?: string;
}

const includesCI = (hay: string | null | undefined, needle: string | undefined): boolean => {
  if (!needle) return true; // 谓词未设该字段=不约束
  return (hay ?? '').toLowerCase().includes(needle.toLowerCase());
};
const equalsCI = (val: string | null | undefined, want: string | undefined): boolean => {
  if (!want) return true;
  return (val ?? '').trim().toLowerCase() === want.trim().toLowerCase();
};

/** 单谓词匹配（确定性字段匹配；required 字段缺失的谓词在 normalize 侧已拒） */
export function matchIntentPredicate(p: IntentEventPredicate, evt: IntentEventInput): boolean {
  if (!['notify_flip','merge_blocked','pr_merged'].includes(p.kind) || p.kind !== evt.kind) return false;
  if (p.kind === 'notify_flip') {
    return equalsCI(evt.trigger, p.trigger);
  }
  // merge_blocked / pr_merged：至少一个匹配面（normalize 保证），全部已设面须命中
  if (p.repoIncludes && !includesCI(evt.repo, p.repoIncludes)) return false;
  if (p.branchIncludes && !includesCI(evt.branch, p.branchIncludes)) return false;
  return true;
}

/** 一条意图的全部谓词任一命中即命中（谓词间 OR） */
export function matchIntentEvent(predicates: ReadonlyArray<IntentEventPredicate>, evt: IntentEventInput): boolean {
  return (predicates ?? []).some((p) => matchIntentPredicate(p, evt));
}

// ---------------------------------------------------------------------------
// 发射（单事务复查：状态 → 过期 → 冷却 → 预算）
// ---------------------------------------------------------------------------

export type IntentFireReason = 'state' | 'expired' | 'cooldown' | 'budget';

/** 事件参数摘要（80 字截断；与事件账本参数口径一致） */
function snippetForEvent(text: string): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

export type IntentFireOutcome =
  | { fired: true; record: IntentRecord }
  | { fired: false; reason: IntentFireReason; record: IntentRecord };

/**
 * 命中后的单事务复查与发射（BEGIN IMMEDIATE——并发命中同条不超发）：
 * 状态域（armed/fired 可发射；pending 未武装；done/cancelled/expired 终态）→
 * 过期复查（已过即刻 expired）→ 冷却（now - last_fired_at ≥ cooldown_ms）→
 * 预算（fire_count < fire_budget）。发射 = fire_count+1 + last_fired_at=now +
 * 状态推进（预算耗尽 → done，否则 → fired）。
 * `intent_fired` 事件（条目 1A 写点收口）：与发射同事务，恰好一行。
 */
export function tryFireIntent(db: MemoryDb, id: number, now: number): IntentFireOutcome | null {
  return db.write((tx) => {
    const row = tx.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const rec = rowToRecord(row);
    const fail = (reason: IntentFireReason): IntentFireOutcome => ({ fired: false, reason, record: rec });
    if (rec.state !== 'armed' && rec.state !== 'fired') return fail('state');
    if (rec.expiry != null && rec.expiry < now) {
      tx.prepare("UPDATE intents SET state = 'expired' WHERE id = ?").run(id);
      return { fired: false, reason: 'expired', record: { ...rec, state: 'expired' } };
    }
    const cooldown = rec.cooldownMs ?? INTENT_CONSTANTS.DEFAULT_COOLDOWN_MS;
    if (rec.lastFiredAt != null && now - rec.lastFiredAt < cooldown) return fail('cooldown');
    const budget = rec.fireBudget ?? INTENT_CONSTANTS.DEFAULT_FIRE_BUDGET;
    if (rec.fireCount >= budget) {
      tx.prepare("UPDATE intents SET state = 'done' WHERE id = ?").run(id);
      return { fired: false, reason: 'budget', record: { ...rec, state: 'done' } };
    }
    const fireCount = rec.fireCount + 1;
    const state = fireCount >= budget ? 'done' : 'fired';
    tx.prepare('UPDATE intents SET fire_count = ?, last_fired_at = ?, state = ? WHERE id = ?').run(
      fireCount,
      now,
      state,
      id
    );
    appendEvent(db, {
      kind: 'intent_fired',
      ts: now,
      entryRef: `intent:${id}`,
      summary: '前瞻意图触发：{{description}}',
      summaryArgs: { description: snippetForEvent(rec.description), fireCount, fireBudget: rec.fireBudget }
    });
    return { fired: true, record: { ...rec, fireCount, lastFiredAt: now, state } };
  });
}

// ---------------------------------------------------------------------------
// 扫描入口（宿主调用；内部先搭过期清扫 piggyback）
// ---------------------------------------------------------------------------

/** 消息/事件面共用的候选装载（scoped：可发射态 + 未过期 + 有对应触发面；≤256 条） */
function listScanCandidates(db: MemoryDb, face: 'message' | 'event', now: number): IntentRecord[] {
  const hasColumn = face === 'message' ? 'trigger_keywords' : 'event_predicates_json';
  const rows = db.handle
    .prepare(
      `SELECT * FROM intents
       WHERE state IN ('armed','fired')
         AND ${hasColumn} IS NOT NULL
         AND ${hasColumn} != '[]'
         AND (expiry IS NULL OR expiry >= ?)
       ORDER BY id
       LIMIT ?`
    )
    .all(now, INTENT_CONSTANTS.MAX_SCAN_CANDIDATES) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

export interface IntentMessageHit {
  intent: IntentRecord;
  /** 发射后的最新记录（fireCount/state 已推进） */
  fired: IntentRecord;
}

export interface IntentMessageScanResult {
  hits: IntentMessageHit[];
  /** 注入块文本（无命中=空串；≤MAX_INJECT_PER_TURN 条） */
  block: string;
  expiredSwept: number;
}

function snippet(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > INTENT_CONSTANTS.DESCRIPTION_SNIPPET_CHARS ? `${s.slice(0, INTENT_CONSTANTS.DESCRIPTION_SNIPPET_CHARS)}…` : s;
}

/**
 * 消息面扫描（调度回合前缀组装时调用；确定性，零模型调用）：
 * 过期清扫 piggyback → 全词预筛（≤256 候选）→ 逐条单事务发射复查 → 组装有界隐藏块。
 *
 * 预算语义（B7 评审 m3 收口）：**只对实际注入的意图推进 fire_count**——本回合注入
 * 注满 MAX_INJECT_PER_TURN 即停，其后命中者不发射、不耗预算、不推冷却（若先发射后
 * 截断，未注入者会白耗一次预算还进冷却——防骚扰预算被命中数而非提醒数消耗）。
 */
export function runIntentMessageScan(db: MemoryDb, message: string, now: number = Date.now()): IntentMessageScanResult {
  const expiredSwept = sweepIntentExpiry(db, now);
  const candidates = listScanCandidates(db, 'message', now);
  const hits: IntentMessageHit[] = [];
  for (const c of candidates) {
    if (hits.length >= INTENT_CONSTANTS.MAX_INJECT_PER_TURN) break;
    if (!matchIntentKeywords(c.keywords, message)) continue;
    const r = tryFireIntent(db, c.id, now);
    if (r?.fired) hits.push({ intent: c, fired: r.record });
  }
  const block = hits.length
    ? [
        '### 前瞻意图提醒（standing intent 触发，背景参考）',
        ...hits.map((h) => `- ${snippet(h.intent.description)}（第 ${h.fired.fireCount}/${h.fired.fireBudget ?? INTENT_CONSTANTS.DEFAULT_FIRE_BUDGET} 次）`)
      ].join('\n')
    : '';
  return { hits, block, expiredSwept };
}

export interface IntentEventHit {
  intent: IntentRecord;
  fired: IntentRecord;
  /** 命中的谓词（通知文案用） */
  predicate: IntentEventPredicate;
}

export interface IntentEventScanResult {
  hits: IntentEventHit[];
  expiredSwept: number;
}

/**
 * 事件面扫描（任务事件/通知相位/合入受阻/PR 合并事件源调用）：过期清扫 piggyback →
 * 谓词确定性匹配（≤256 候选）→ 逐条单事务发射复查。返回命中列表（宿主据此发通知——
 * 事件面没有「对应回合」可注入，注入形态=系统通知）。
 */
export function runIntentEventScan(db: MemoryDb, evt: IntentEventInput, now: number = Date.now()): IntentEventScanResult {
  const expiredSwept = sweepIntentExpiry(db, now);
  const candidates = listScanCandidates(db, 'event', now);
  const hits: IntentEventHit[] = [];
  for (const c of candidates) {
    const predicate = c.eventPredicates.find((p) => matchIntentPredicate(p, evt));
    if (!predicate) continue;
    const r = tryFireIntent(db, c.id, now);
    if (r?.fired) hits.push({ intent: c, fired: r.record, predicate });
  }
  return { hits, expiredSwept };
}

/** 事件命中 → 通知正文（宿主通知通道组装用；有界。文案随 notify 通道口径，非渲染层 UI） */
export function formatIntentEventNotice(hit: IntentEventHit): string {
  return `「${snippet(hit.intent.description)}」触发（${predicateLabel(hit.predicate)}；第 ${hit.fired.fireCount}/${hit.fired.fireBudget ?? INTENT_CONSTANTS.DEFAULT_FIRE_BUDGET} 次）`;
}

/** 谓词 → 通知用简述（仅供事件面通知正文/日志；面板渲染走 renderer 侧 t() 形态） */
function predicateLabel(p: IntentEventPredicate): string {
  switch (p.kind) {
    case 'notify_flip':
      return `phase:${p.trigger ?? ''}`;
    case 'merge_blocked':
      return `merge_blocked${p.branchIncludes ? `~${p.branchIncludes}` : ''}`;
    case 'pr_merged':
      return `pr_merged${p.branchIncludes ? `~${p.branchIncludes}` : ''}`;
    default:
      return p.kind;
  }
}
