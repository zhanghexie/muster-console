/**
 * 排序引擎（memory-refactor §7 Lane1 排序公式 / §8 检索）——纯函数，无 db/fs 依赖：
 *
 *   finalScore = BM25 × recencyDecay × importanceMult × repoAffinity
 *
 * - BM25：词法分数按候选池归一；
 * - recencyDecay：带日期源 30 天半衰期指数衰减；MEMORY/USER 常青 1.0；
 * - importanceMult：1–10 线性映射 0.5–1.5，缺失中性 1.0；
 * - repoAffinity：活跃 repoKey 集合内 ×1.2 / 集合外有标注 ×0.8 / 无标注 ×1.0；
 * - MMR：λ=0.7、Jaccard 重叠度（token 用 CJK 二元组，tokenize.ts 同款）、贪心 O(k²n) 纯本地。
 *
 * 所有系数集中在 RANKING_CONSTANTS（调参唯一入口，方案 §14 阈值以真实数据调参并记录）。
 */
import { cjkBigramTokenize } from './tokenize';

/** 调参常量（面板/报告引用同一份；改动须同步 test/memory-retrieval.mjs 矩阵） */
export const RANKING_CONSTANTS = {
  /** 新近度半衰期（天）：journal/转录等带日期源 */
  RECENCY_HALF_LIFE_DAYS: 30,
  /** importance 1 → 乘数下限 / 10 → 上限（线性） */
  IMPORTANCE_MIN_MULT: 0.5,
  IMPORTANCE_MAX_MULT: 1.5,
  /** repoKey 亲和三态：活跃集合内 / 集合外有标注 / 无标注 */
  REPO_AFFINITY_IN: 1.2,
  REPO_AFFINITY_OUT: 0.8,
  REPO_AFFINITY_NONE: 1.0,
  /** MMR 多样性惩罚系数 */
  MMR_LAMBDA: 0.7
} as const;

/** 常青源（不参与新近度衰减）：策展 MEMORY（工作区+调度）、USER 画像与 features 功能文档 */
export function isEvergreenSource(sourceType: string): boolean {
  return sourceType === 'memory' || sourceType === 'user_md' || sourceType === 'features';
}

/**
 * 新近度衰减：`0.5 ** (ageDays / 半衰期)`。
 * 常青源恒 1.0；非常青源无日期按中性 1.0（文件名解析失败等兜底，不惩罚）。
 */
export function recencyDecayFactor(
  sourceType: string,
  observedAt: number | null | undefined,
  now: number
): number {
  if (isEvergreenSource(sourceType)) return 1.0;
  if (observedAt == null || !Number.isFinite(observedAt)) return 1.0;
  const ageDays = Math.max(0, (now - observedAt) / 86_400_000);
  return Math.pow(0.5, ageDays / RANKING_CONSTANTS.RECENCY_HALF_LIFE_DAYS);
}

/**
 * importance 1–10 线性映射乘数 [IMPORTANCE_MIN_MULT, IMPORTANCE_MAX_MULT]；
 * 缺失（null/undefined/越界）中性 1.0。写时打分（§4.3 注解），缺失不惩罚。
 */
export function importanceMultiplier(importance: number | null | undefined): number {
  if (importance == null || !Number.isFinite(importance)) return 1.0;
  const clamped = Math.min(10, Math.max(1, importance));
  const { IMPORTANCE_MIN_MULT: lo, IMPORTANCE_MAX_MULT: hi } = RANKING_CONSTANTS;
  return lo + ((hi - lo) * (clamped - 1)) / 9;
}

/**
 * repoKey 亲和三态：无标注 / 无活跃集合 → 1.0（中性）；标注在活跃集合内 → ×IN；
 * 标注在集合外（他仓记忆）→ ×OUT（降权不排除——跨仓教训仍有召回价值）。
 */
export function repoAffinityMultiplier(
  repoKey: string | null | undefined,
  activeRepoKeys: ReadonlySet<string> | ReadonlyArray<string> | null | undefined
): number {
  if (!repoKey) return RANKING_CONSTANTS.REPO_AFFINITY_NONE;
  const active =
    activeRepoKeys == null
      ? null
      : activeRepoKeys instanceof Set
        ? activeRepoKeys
        : new Set(activeRepoKeys);
  if (active == null || active.size === 0) return RANKING_CONSTANTS.REPO_AFFINITY_NONE;
  return active.has(repoKey)
    ? RANKING_CONSTANTS.REPO_AFFINITY_IN
    : RANKING_CONSTANTS.REPO_AFFINITY_OUT;
}

/**
 * BM25 归一：FTS5 bm25() 越小越相关（负值），取 rel = -bm25 后对候选池最大值归一
 * （相对分：池内最优=1）。池为空或最优 ≤0 → 0。
 */
export function normalizeBm25(bm25: number, poolMaxRel: number): number {
  const rel = -bm25;
  if (!(poolMaxRel > 0)) return 0;
  return Math.max(0, Math.min(1, rel / poolMaxRel));
}

/** 候选池的最优 BM25 相关性（rel = -bm25 的最大值；供 normalizeBm25 用） */
export function poolMaxBm25Rel(bm25Scores: ReadonlyArray<number>): number {
  let max = 0;
  for (const b of bm25Scores) {
    const rel = -b;
    if (rel > max) max = rel;
  }
  return max;
}

// ---------------------------------------------------------------------------
// MMR（§7 Lane1 去冗余）：MMR = λ·relevance − (1−λ)·max_sim(候选, 已选) 贪心
// ---------------------------------------------------------------------------

/** Jaccard 重叠度（空集对空集=0，避免除零把「双空」判成最相似） */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** MMR 相似度用的 token 集（CJK 二元组 + 拉丁词，FTS 索引同款口径） */
export function mmrTokenSet(text: string): Set<string> {
  return new Set(cjkBigramTokenize(text));
}

/**
 * 贪心 MMR 选出至多 k 项（按选择顺序返回）。
 * relevance ∈ (0,1] 建议与 finalScore 同域（调用方先归一或直接用 finalScore——
 * λ 语义是「相关 vs 冗余」的权衡比例，与分的绝对域无关，单调即可）。
 */
export function mmrSelect<T>(
  items: ReadonlyArray<T>,
  k: number,
  relevance: (item: T) => number,
  similarity: (a: T, b: T) => number,
  lambda: number = RANKING_CONSTANTS.MMR_LAMBDA
): T[] {
  const n = items.length;
  if (n === 0 || k <= 0) return [];
  const remaining = new Set<number>();
  for (let i = 0; i < n; i += 1) remaining.add(i);
  const selected: number[] = [];
  const minK = Math.min(k, n);
  // 首选纯相关性最高者
  let firstBest = -1;
  let firstRel = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const r = relevance(items[i]);
    if (r > firstRel) {
      firstRel = r;
      firstBest = i;
    }
  }
  selected.push(firstBest);
  remaining.delete(firstBest);
  while (selected.length < minK && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (const i of remaining) {
      let maxSim = 0;
      for (const j of selected) {
        const s = similarity(items[i], items[j]);
        if (s > maxSim) maxSim = s;
      }
      const score = lambda * relevance(items[i]) - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }
  return selected.map((i) => items[i]);
}
