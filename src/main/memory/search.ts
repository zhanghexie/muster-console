/** 词法检索：BM25 候选、排序因子与 MMR 去重。 */
import { MemoryDb, type ChunkFtsHit, recordRecallStat, searchChunksByFts } from './db';
import {
  RANKING_CONSTANTS,
  importanceMultiplier,
  mmrSelect,
  mmrTokenSet,
  normalizeBm25,
  poolMaxBm25Rel,
  recencyDecayFactor,
  repoAffinityMultiplier
} from './ranking';
export interface MemorySearchOptions {
  /** 返回条数上限（MMR 之后；缺省 8） */
  topK?: number;
  /** 活跃 repoKey 集合（repo 亲和因子；缺省无亲和加成） */
  activeRepoKeys?: ReadonlyArray<string>;
  now?: number;
  /** BM25 候选池大小（缺省 40） */
  bm25CandidateLimit?: number;
  /**
   * 是否落 recall_stats(kind=search_hit)（缺省 true）。调用方自带注入语义时置 false
   * 并自行落账（B5：简报=brief_injected、Lane2=escalation_hit——同一次暴露不双计）。
   * 检索试验台（记忆面板条目 5）恒传 false——只读试玩不污染巩固信号门真实数据。
   */
  recordStats?: boolean;
  /**
   * 附带得分分项镜像（条目 5 试验台）：hit.debug 与最终分**同一次计算**取值，
   * 防面板另算一套口径。缺省 false（工具/简报等主路不多传这份数据）。
   */
  debug?: boolean;
}

/**
 * 得分分项镜像（条目 5「为什么是这条 / 得分条」数据面）。数值全部来自与
 * finalScore 同一次排序计算（search.ts ③ 融合步），渲染层只做展示不再造公式。
 */
export interface MemorySearchDebug {
  /** BM25 池内归一分 [0,1]（词法分项；未走 BM25 命中为 null） */
  lexNorm: number | null;
  /** 新近度衰减（0–1] */
  recency: number;
  /** 重要度乘数（0.5–1.5） */
  importance: number;
  /** repo 亲和乘数（0.8–1.2） */
  affinity: number;
  /** 综合分（== MemorySearchHit.finalScore 的镜像，同源防两套口径） */
  final: number;
  /** 查询与命中正文的分词交集（「为什么是这条」的字面命中词；cjkBigramTokenize 口径） */
  matchedTerms: string[];
}

export interface MemorySearchHit {
  chunkId: number;
  sourceType: string;
  sourcePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  text: string;
  /** 最终分 = BM25 × recency × importanceMult × repoMult（跨查询不可比） */
  finalScore: number;
  /** BM25 池内归一分 [0,1]；未走 BM25 命中为 null */
  bm25Norm: number | null;
  recency: number;
  importanceMult: number;
  repoMult: number;
  rank: number;
  /** 得分分项镜像（opts.debug=true 时在场；与 finalScore 同一次计算） */
  debug?: MemorySearchDebug;
}

interface Candidate {
  row: Pick<ChunkFtsHit, 'id' | 'sourceType' | 'sourcePath' | 'lineStart' | 'lineEnd' | 'text' | 'repoKey' | 'importance' | 'observedAt'>;
  bm25: number | null;
  bm25Norm: number | null;
  finalScore: number;
  tokens: Set<string>;
}

/** 一次词法排序检索，空查询或无命中返回 []。 */
export async function searchMemory(
  db: MemoryDb,
  query: string,
  opts: MemorySearchOptions = {}
): Promise<MemorySearchHit[]> {
  const q = (query ?? '').trim();
  if (!q) return [];
  const topK = Math.max(1, opts.topK ?? 8);
  const now = opts.now ?? Date.now();
  const activeRepoKeys = opts.activeRepoKeys ? new Set(opts.activeRepoKeys) : null;

  // ① BM25 候选（FTS 真跑）：AND 全命中优先；长问句某二元组不在语料会 0 命中
  // （B2 评测实测），退 OR 兜底、bm25 排序（评测驱动引入的两段式）
  const ftsLimit = Math.max(topK, opts.bm25CandidateLimit ?? 40);
  let bm25Rows = searchChunksByFts(db, q, ftsLimit, 'and');
  if (bm25Rows.length === 0) bm25Rows = searchChunksByFts(db, q, ftsLimit, 'or');
  const byId = new Map<number, Candidate>();
  const bm25PoolMax = poolMaxBm25Rel(bm25Rows.map((r) => r.bm25));
  for (const r of bm25Rows) {
    byId.set(r.id, {
      row: r,
      bm25: r.bm25,
      bm25Norm: normalizeBm25(r.bm25, bm25PoolMax),
      finalScore: 0,
      tokens: mmrTokenSet(r.text)
    });
  }

  // ② 词法评分与排序因子
  const wantDebug = opts.debug === true;
  const qTokens = wantDebug ? mmrTokenSet(q) : null;
  const candidates = [...byId.values()];
  for (const c of candidates) {
    c.finalScore =
      (c.bm25Norm ?? 0) *
      recencyDecayFactor(c.row.sourceType, c.row.observedAt, now) *
      importanceMultiplier(c.row.importance) *
      repoAffinityMultiplier(c.row.repoKey, activeRepoKeys);
  }

  // ④ MMR 去冗余（λ=0.7、Jaccard；相关性按池内最高分归一，保 λ 权衡语义稳定）
  const maxFinal = candidates.reduce((m, c) => Math.max(m, c.finalScore), 0);
  const denom = maxFinal > 0 ? maxFinal : 1;
  const selected = mmrSelect(
    candidates,
    topK,
    (c) => c.finalScore / denom,
    (a, b) => {
      let inter = 0;
      for (const t of a.tokens) if (b.tokens.has(t)) inter += 1;
      const union = a.tokens.size + b.tokens.size - inter;
      return union > 0 ? inter / union : 0;
    },
    RANKING_CONSTANTS.MMR_LAMBDA
  );

  // ⑤ 召回落账（search_hit）+ 计数抬升（同事务逐条）；relevance=该次命中融合分钳位
  // （B4 信号门 Relevance 均值数据源——finalScore 域理论上限 bm25Norm×1.4，钳 1）。
  // recordStats=false 时不落账（B5：简报/Lane2 等自带注入 kind 的调用面）。
  const recordStats = opts.recordStats !== false;
  const hits: MemorySearchHit[] = selected.map((c, i) => {
    if (recordStats) {
      recordRecallStat(db, c.row.id, 'search_hit', q, now, Math.max(0, Math.min(1, c.finalScore)));
    }
    const recency = recencyDecayFactor(c.row.sourceType, c.row.observedAt, now);
    const importanceMult = importanceMultiplier(c.row.importance);
    const repoMult = repoAffinityMultiplier(c.row.repoKey, activeRepoKeys);
    const debug: MemorySearchDebug | undefined = wantDebug
      ? {
          lexNorm: c.bm25Norm,
          recency,
          importance: importanceMult,
          affinity: repoMult,
          final: c.finalScore,
          matchedTerms: qTokens
            ? [...qTokens].filter((tok) => c.tokens.has(tok))
            : []
        }
      : undefined;
    return {
      chunkId: c.row.id,
      sourceType: c.row.sourceType,
      sourcePath: c.row.sourcePath,
      lineStart: c.row.lineStart,
      lineEnd: c.row.lineEnd,
      text: c.row.text,
      finalScore: c.finalScore,
      bm25Norm: c.bm25Norm,
      recency,
      importanceMult,
      repoMult,
      rank: i + 1,
      debug
    };
  });
  return hits;
}
