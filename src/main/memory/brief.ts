/**
 * 派活简报定向召回（memory-refactor §7 Worker 面，B5）：简报的记忆段从旧
 * memorySearch 裸 BM25 top-K 切到 searchMemory（trigger/importance/repoKey 排序 +
 * MMR 去冗余），按简报预算取 K；命中落 recall_stats kind=brief_injected（喂 B4 信号门）。
 *
 * searchMemory 内部的 search_hit 落账经 recordStats:false 关闭——简报注入按
 * brief_injected 单一 kind 记账，避免同一次暴露双计。
 *
 * 检索函数依赖注入（service.search 或测试桩），node-only——test/*.mjs 直测。
 */
import { MemoryDb, recordRecallStat } from './db';
import type { Lane2SearchHit } from './lane2';

export const BRIEF_RECALL_CONSTANTS = {
  /** 简报检索命中条数（与旧 buildSearchSection limit=3 同档） */
  TOP_K: 3,
  /** 单条 snippet 截断（与旧 memorySearch.SNIPPET_CHARS 同档） */
  SNIPPET_CHARS: 220,
  /** 落账 query_text 截断 */
  QUERY_SNIPPET_CHARS: 200
} as const;

export interface BriefRecallHit extends Lane2SearchHit {
  lineStart: number | null;
}

export interface BriefRecallResult {
  /** 检索段文本（空命中=空串，调用方整节省略） */
  text: string;
  hits: BriefRecallHit[];
  /** 落账的 chunk id（与 hits 一一对应） */
  accountedChunkIds: number[];
}

/** snippet 净化（压平 + 截断；与旧 memorySearch.snippetFor 同口径） */
export function briefSnippet(text: string): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > BRIEF_RECALL_CONSTANTS.SNIPPET_CHARS
    ? `${flat.slice(0, BRIEF_RECALL_CONSTANTS.SNIPPET_CHARS)}…`
    : flat;
}

/**
 * 简报定向召回段组装：检索（调用方给的 search——通常 service.search 已关内部落账）
 * → snippet 行组装 → brief_injected 落账。检索异常由调用方兜底（简报不能被记忆拖垮）。
 */
export async function buildBriefRecallSection(
  db: MemoryDb,
  search: (query: string, topK: number) => Promise<BriefRecallHit[]>,
  task: string,
  now: number = Date.now()
): Promise<BriefRecallResult> {
  const q = (task ?? '').trim();
  if (!q) return { text: '', hits: [], accountedChunkIds: [] };
  const hits = await search(q, BRIEF_RECALL_CONSTANTS.TOP_K);
  if (hits.length === 0) return { text: '', hits: [], accountedChunkIds: [] };
  const lines = hits.map((h) => `- [${h.sourcePath ?? h.sourceType}] ${briefSnippet(h.text)}`);
  const qs = q.slice(0, BRIEF_RECALL_CONSTANTS.QUERY_SNIPPET_CHARS);
  for (const h of hits) {
    recordRecallStat(db, h.chunkId, 'brief_injected', qs, now, Math.max(0, Math.min(1, h.finalScore)));
  }
  return {
    text: `### 相关历史（检索命中）\n${lines.join('\n')}`,
    hits,
    accountedChunkIds: hits.map((h) => h.chunkId)
  };
}
