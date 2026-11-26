/**
 * trigger 注入（memory-refactor §7 Lane1-③，B5）：入站用户消息（**仅调度面**）对
 * 策展层 chunk 的 triggers 词组跑词法匹配，强匹配（阈值 0.72）作为紧凑隐藏块注入，
 * 每回合 ≤3 条；命中落 recall_stats kind=trigger_injected。
 *
 * 合格面：**仅策展层**——source_type ∈ {memory, user_md}（staging/transcript/
 * journal/features 不参与：情景与转录没有人工策展的触发词语义）。
 *
 * 打分（确定性词法）：
 * - 词组按空白切关键词（CJK 词组无空格=单关键词）；词组得分 = 出现的关键词占比，
 *   全词现=1.0（§9 intents「每词都现才命中」的全词预筛口径作为满分形态）；
 * - chunk 得分 = 其全部词组中的最高分；≥ TRIGGER_STRONG_THRESHOLD 视为强匹配。
 *
 * 纯函数 + MemoryDb 句柄注入（test/*.mjs 直跑）。
 */
import { MemoryDb, recordRecallStat } from './db';

export const TRIGGER_CONSTANTS = {
  /** 强匹配阈值（方案 §7：0.72，P4 调参面） */
  STRONG_MATCH_THRESHOLD: 0.72,
  /** 每回合注入上限（§7：≤3 条） */
  MAX_PER_TURN: 3,
  /** recall_stats 落账的 query_text 截断（消息原文可能很长；溯源只需可读前缀） */
  QUERY_SNIPPET_CHARS: 200
} as const;

/** 词组按空白切关键词（CJK 连续串=单关键词；ASCII 大小写不敏感比对） */
function phraseKeywords(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 单词组得分：出现的关键词占比（全词现=1；消息空=0） */
export function scoreTriggerPhrase(phrase: string, message: string): number {
  const kws = phraseKeywords(phrase);
  if (kws.length === 0) return 0;
  const hay = (message ?? '').toLowerCase();
  if (!hay.trim()) return 0;
  let hit = 0;
  for (const kw of kws) {
    if (hay.includes(kw.toLowerCase())) hit += 1;
  }
  return hit / kws.length;
}

/** chunk 得分 = 全部词组最高分（triggers 解析失败/空 = 不合格 0） */
export function scoreTriggerChunk(triggers: string[] | null | undefined, message: string): number {
  if (!triggers || triggers.length === 0) return 0;
  let best = 0;
  for (const phrase of triggers) {
    const s = scoreTriggerPhrase(phrase, message);
    if (s > best) best = s;
  }
  return best;
}

function parseTriggers(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && !!x.trim());
  } catch {
    return [];
  }
}

/** trigger 注入合格 chunk（策展层限定：memory/user_md 且 triggers 非空） */
export interface TriggerEligibleChunk {
  chunkId: number;
  sourceType: string;
  sourcePath: string | null;
  text: string;
  triggers: string[];
  importance: number | null;
  observedAt: number | null;
}

export function listTriggerEligibleChunks(db: MemoryDb): TriggerEligibleChunk[] {
  const rows = db.handle
    .prepare(
      `SELECT id, source_type, source_path, text, triggers, importance, observed_at
       FROM chunks
       WHERE source_type IN ('memory', 'user_md') AND triggers IS NOT NULL`
    )
    .all() as Array<Record<string, unknown>>;
  const out: TriggerEligibleChunk[] = [];
  for (const r of rows) {
    const triggers = parseTriggers(r.triggers as string | null);
    if (triggers.length === 0) continue;
    out.push({
      chunkId: Number(r.id),
      sourceType: String(r.source_type),
      sourcePath: (r.source_path as string | null) ?? null,
      text: String(r.text),
      triggers,
      importance: r.importance == null ? null : Number(r.importance),
      observedAt: r.observed_at == null ? null : Number(r.observed_at)
    });
  }
  return out;
}

export interface TriggerInjectionHit {
  chunkId: number;
  score: number;
  text: string;
  sourceType: string;
  sourcePath: string | null;
}

export interface TriggerInjectionResult {
  /** 强匹配命中（≤MAX_PER_TURN，按分降序） */
  hits: TriggerInjectionHit[];
  /** 紧凑隐藏块文本（无强匹配=空串） */
  block: string;
}

/**
 * 选出强匹配（纯函数；排序：得分降序 → importance 降序 → 新近优先）并截 ≤3 条。
 */
export function selectTriggerHits(
  chunks: ReadonlyArray<TriggerEligibleChunk>,
  message: string,
  threshold: number = TRIGGER_CONSTANTS.STRONG_MATCH_THRESHOLD
): TriggerInjectionHit[] {
  const scored: Array<TriggerInjectionHit & { importance: number; observedAt: number }> = [];
  for (const c of chunks) {
    const score = scoreTriggerChunk(c.triggers, message);
    if (score < threshold) continue;
    scored.push({
      chunkId: c.chunkId,
      score,
      text: c.text,
      sourceType: c.sourceType,
      sourcePath: c.sourcePath,
      importance: c.importance ?? 0,
      observedAt: c.observedAt ?? 0
    });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.observedAt - a.observedAt;
  });
  return scored.slice(0, TRIGGER_CONSTANTS.MAX_PER_TURN);
}

/** 单条触发块的展示截断（紧凑隐藏块；正文过长只给前缀） */
const HIT_TEXT_CHARS = 240;

/**
 * 调度回合 trigger 注入入口（宿主在用户消息回合调用；host 自治回合不调）：
 * 策展层词法匹配 → 强匹配组装紧凑隐藏块 + recall_stats 落账（kind=trigger_injected）。
 * 任何 db 异常向上抛由调用方兜底（注入失败不挡回合）。
 */
export function runTriggerInjection(
  db: MemoryDb,
  message: string,
  now: number = Date.now()
): TriggerInjectionResult {
  const hits = selectTriggerHits(listTriggerEligibleChunks(db), message);
  if (hits.length === 0) return { hits, block: '' };
  const snippet = (s: string): string =>
    s.length > HIT_TEXT_CHARS ? `${s.slice(0, HIT_TEXT_CHARS)}…` : s;
  const lines = hits.map(
    (h) => `- [${h.sourcePath ?? h.sourceType}]（相关度 ${h.score.toFixed(2)}）${snippet(h.text)}`
  );
  const block = [`### 相关记忆提醒（trigger 命中，背景参考）`, ...lines].join('\n');
  const qs = (message ?? '').slice(0, TRIGGER_CONSTANTS.QUERY_SNIPPET_CHARS);
  for (const h of hits) {
    recordRecallStat(db, h.chunkId, 'trigger_injected', qs, now, h.score);
  }
  return { hits, block };
}

/** Lane1 强命中判定复用面（Lane2 条件：trigger 无强命中；hits>0 即强命中在场） */
export function hasStrongTriggerHit(r: TriggerInjectionResult): boolean {
  return r.hits.length > 0;
}
