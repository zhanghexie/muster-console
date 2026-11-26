/**
 * 巩固信号门 + 污点门（memory-refactor §6.3，确定性、零模型调用）：
 *
 * 六信号加权（权重和=1）：
 *   score = 0.30×Relevance + 0.24×Frequency + 0.15×QueryDiversity
 *         + 0.15×Recency + 0.10×Consolidation(多日复现) + 0.06×ConceptualRichness
 *
 * - Relevance：pending staging 镜像 chunk 在 recall_stats.relevance 的均值（检索
 *   命中相关分；NULL=未记录按中性 0.5）。
 * - Frequency：进入上下文的事件数（brief_injected/trigger_injected/escalation_hit
 *   等；普通 search_hit 只是检索曝光），min(1, n/FREQ_SATURATION) 饱和归一。
 * - QueryDiversity：distinct query_text 数，饱和归一。
 * - Recency：0.5^(ageDays/RECENCY_HALF_LIFE_DAYS) 衰减（基准=staging.observed_at，
 *   缺省 created_at）。
 * - Consolidation（多日复现）：召回事件落在的 distinct 自然日数，3 天饱和。
 * - ConceptualRichness（#tag 密度）：正文 #tag 数（shared/memoryFormat 提取），3 个饱和。
 *
 * 三配置门槛 minScore / minRecallCount / minUniqueQueries 与 search_only 硬门全过才进门
 *（阈值进配置，§14 以保守缺省起步）。污点门：origin ∈ {untrusted, system} 在**构建提示词前**
 * 结构性剔除（§5 定不了按 untrusted/system 的保守分类永不见策展核心）。
 *
 * 纯函数 + 只读 db 查询（MemoryDb 注入；.mjs 可转译直测）。
 */
import { MemoryDb } from '../db';
import type { MemoryOrigin } from '../db';
import { extractTags } from '../../../shared/memoryFormat';

/** 权重（§6.3 字面；调参唯一入口，改动须同步 test/memory-consolidation.mjs 矩阵） */
export const GATE_WEIGHTS = {
  relevance: 0.3,
  frequency: 0.24,
  queryDiversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  richness: 0.06
} as const;

/** 信号归一常量（饱和点；Recency 半衰期对齐排序引擎 30 天口径的一半——候选窗口短） */
export const GATE_CONSTANTS = {
  /** relevance 无样本时的中性值（NULL=未记录，不奖不罚） */
  RELEVANCE_NEUTRAL: 0.5,
  /** Frequency 饱和召回事件数 */
  FREQ_SATURATION: 5,
  /** QueryDiversity 饱和 distinct 查询数 */
  DIVERSITY_SATURATION: 4,
  /** Recency 半衰期（天） */
  RECENCY_HALF_LIFE_DAYS: 14,
  /** 多日复现饱和天数 */
  MULTI_DAY_SATURATION: 3,
  /** #tag 密度饱和个数 */
  RICHNESS_SATURATION: 3
} as const;

/** 三硬门槛（缺省保守值；进配置 memoryConsolidation.{minScore,minRecallCount,minUniqueQueries}） */
export interface GateThresholds {
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  minScore: 0.55,
  minRecallCount: 2,
  minUniqueQueries: 2
};

/** 巩固命名空间：调度候选 → 调度策展；worker 候选 → Worker 共享策展；
 *  user（用户亲述）候选 → USER.md 画像命名空间（B7 §10：画像写入素材） */
export type ConsolidationNamespace = 'scheduler' | 'worker' | 'profile';

export function namespaceOfOrigin(origin: string): ConsolidationNamespace {
  if (origin === 'scheduler') return 'scheduler';
  if (origin === 'user') return 'profile';
  return 'worker';
}

/** 污点门（§6.3）：untrusted/system 候选构建提示词前结构性剔除 */
export function isTaintedOrigin(origin: string): boolean {
  return origin === 'untrusted' || origin === 'system';
}

// ---------------------------------------------------------------------------
// 候选装载（staging pending + 镜像 chunk 召回统计联查）
// ---------------------------------------------------------------------------

export interface StagingCandidate {
  stagingId: number;
  text: string;
  origin: MemoryOrigin;
  sessionKind: string | null;
  taskId: string | null;
  repoKey: string | null;
  observedAt: number | null;
  evidencePath: string | null;
  createdAt: number;
  /** staging 行状态（缺省装载只含 pending；面板暂存池另载 user_discarded——条目 6A） */
  state: StagingRowState;
  /** 镜像 chunk id（无镜像=老数据/被清理；召回统计恒 0） */
  chunkId: number | null;
  /** recall_stats 事件总数（检索命中只是曝光，不等于采纳） */
  recallEvents: number;
  /** 排除普通 search_hit 后的上下文注入或主动检索事件。旧测试构造可省略。 */
  contextEvents?: number;
  /** distinct query_text 数 */
  uniqueQueries: number;
  /** relevance 均值（无样本 NULL） */
  relevanceMean: number | null;
  /** 召回事件落在的 distinct 自然日数（多日复现信号；本地时区） */
  distinctDays: number;
}

/** staging 行状态域（与 db CHECK 同域） */
export type StagingRowState = 'pending' | 'promoted' | 'rejected' | 'expired' | 'user_discarded';

/** local YYYY-MM-DD（SQLite 无 localtime 注入面时在 JS 侧折算——时区随宿主） */
function localDayKey(ts: number): string {
  const d = new Date(ts);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 全部 pending staging 候选（含镜像 chunk 的召回统计；只读）。
 *  states：面板暂存池（条目 6A）传 ['pending','user_discarded'] 载入灰显丢弃行；
 *  巩固 sweep 保持缺省（只吃 pending——user_discarded 永不进巩固）。 */
export function listStagingCandidates(
  db: MemoryDb,
  states: ReadonlyArray<StagingRowState> = ['pending'],
  excludeProposed = false
): StagingCandidate[] {
  const stateList = states.length ? states : (['pending'] as const);
  const placeholders = stateList.map(() => '?').join(',');
  const rows = db.handle
    .prepare(
      `SELECT s.id AS sid, s.text AS text, s.origin AS origin, s.session_kind AS session_kind,
              s.task_id AS task_id, s.repo_key AS repo_key, s.observed_at AS observed_at,
              s.evidence_path AS evidence_path, s.created_at AS created_at, s.state AS state,
              c.id AS chunk_id
       FROM staging s
       LEFT JOIN chunks c ON c.staging_id = s.id AND c.source_type = 'staging'
       WHERE s.state IN (${placeholders})
         ${excludeProposed ? `AND NOT EXISTS (
           SELECT 1 FROM approvals a, json_each(a.payload, '$.operations') op
           WHERE a.state = 'pending' AND json_extract(op.value, '$.stagingId') = s.id
         )` : ''}
       ORDER BY s.id`
    )
    .all(...stateList) as Array<Record<string, unknown>>;
  const chunkIds = rows.map((r) => Number(r.chunk_id)).filter((id) => Number.isFinite(id) && id > 0);
  const stats = new Map<
    number,
    { n: number; context: number; uniqQueries: Set<string>; relSum: number; relN: number; days: Set<string> }
  >();
  if (chunkIds.length) {
    const placeholders = chunkIds.map(() => '?').join(',');
    const statRows = db.handle
      .prepare(
        `SELECT chunk_id, kind, query_text, relevance, ts FROM recall_stats WHERE chunk_id IN (${placeholders})`
      )
      .all(...chunkIds) as Array<Record<string, unknown>>;
    for (const r of statRows) {
      const cid = Number(r.chunk_id);
      let s = stats.get(cid);
      if (!s) {
        s = { n: 0, context: 0, uniqQueries: new Set<string>(), relSum: 0, relN: 0, days: new Set<string>() };
        stats.set(cid, s);
      }
      s.n += 1;
      if (r.kind !== 'search_hit') s.context += 1;
      const q = r.query_text == null ? '' : String(r.query_text);
      // 归一化（trim+小写+空白折叠）——否则 Deploy/deploy 算两种，硬门槛可刷
      const qn = q.replace(/\s+/g, ' ').trim().toLowerCase();
      if (qn) s.uniqQueries.add(qn);
      const rel = r.relevance == null ? NaN : Number(r.relevance);
      if (Number.isFinite(rel)) {
        s.relSum += rel;
        s.relN += 1;
      }
      s.days.add(localDayKey(Number(r.ts)));
    }
  }
  return rows.map((r) => {
    const cid = r.chunk_id == null ? null : Number(r.chunk_id);
    const st = cid != null ? stats.get(cid) : undefined;
    return {
      stagingId: Number(r.sid),
      text: String(r.text),
      origin: String(r.origin) as MemoryOrigin,
      sessionKind: (r.session_kind as string | null) ?? null,
      taskId: (r.task_id as string | null) ?? null,
      repoKey: (r.repo_key as string | null) ?? null,
      observedAt: r.observed_at == null ? null : Number(r.observed_at),
      evidencePath: (r.evidence_path as string | null) ?? null,
      createdAt: Number(r.created_at),
      state: String(r.state ?? 'pending') as StagingRowState,
      chunkId: cid,
      recallEvents: st?.n ?? 0,
      contextEvents: st?.context ?? 0,
      uniqueQueries: st?.uniqQueries.size ?? 0,
      relevanceMean: st && st.relN > 0 ? st.relSum / st.relN : null,
      distinctDays: st?.days.size ?? 0
    };
  });
}

// ---------------------------------------------------------------------------
// 信号计算与门槛判定（纯函数）
// ---------------------------------------------------------------------------

export interface GateSignalBreakdown {
  relevance: number;
  frequency: number;
  queryDiversity: number;
  recency: number;
  consolidation: number;
  richness: number;
  score: number;
}

/** 六信号加权（公式见模块头；候选缺观测时间按 created_at 兜底） */
export function computeGateSignals(c: StagingCandidate, now: number): GateSignalBreakdown {
  const relevance = c.relevanceMean ?? GATE_CONSTANTS.RELEVANCE_NEUTRAL;
  const frequency = Math.min(1, (c.contextEvents ?? c.recallEvents) / GATE_CONSTANTS.FREQ_SATURATION);
  const queryDiversity = Math.min(1, c.uniqueQueries / GATE_CONSTANTS.DIVERSITY_SATURATION);
  const baseTs = c.observedAt ?? c.createdAt;
  const ageDays = Math.max(0, (now - baseTs) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / GATE_CONSTANTS.RECENCY_HALF_LIFE_DAYS);
  const consolidation = Math.min(1, c.distinctDays / GATE_CONSTANTS.MULTI_DAY_SATURATION);
  const tagCount = extractTags(c.text).length;
  const richness = Math.min(1, tagCount / GATE_CONSTANTS.RICHNESS_SATURATION);
  const score =
    GATE_WEIGHTS.relevance * relevance +
    GATE_WEIGHTS.frequency * frequency +
    GATE_WEIGHTS.queryDiversity * queryDiversity +
    GATE_WEIGHTS.recency * recency +
    GATE_WEIGHTS.consolidation * consolidation +
    GATE_WEIGHTS.richness * richness;
  return { relevance, frequency, queryDiversity, recency, consolidation, richness, score };
}

export type GateFailureKind = 'score' | 'recall_count' | 'unique_queries' | 'search_only';

export interface GateDecision {
  passed: boolean;
  signals: GateSignalBreakdown;
  /** 未达标项（passed=true 时空） */
  failures: GateFailureKind[];
}

/** 三硬门槛判定（minScore/minRecallCount/minUniqueQueries 全过） */
export function evaluateCandidateGate(
  c: StagingCandidate,
  thresholds: GateThresholds,
  now: number
): GateDecision {
  const signals = computeGateSignals(c, now);
  const failures: GateFailureKind[] = [];
  if (signals.score < thresholds.minScore) failures.push('score');
  if (c.recallEvents < thresholds.minRecallCount) failures.push('recall_count');
  if (c.uniqueQueries < thresholds.minUniqueQueries) failures.push('unique_queries');
  if (c.contextEvents === 0) failures.push('search_only');
  return { passed: failures.length === 0, signals, failures };
}

export interface GateRejectionDetail {
  stagingId: number;
  text: string;
  evidencePath: string | null;
  /** taint=来源不可信 / low_signal=召回信号未达标（otherNamespace 不在此列——归另一
   *  命名空间的 sweep 处理，不算本空间拒绝） */
  reasonKey: 'taint' | 'low_signal';
  /** 人话拒因参数（渲染层 t(key, args)；相似度/阈值/信号读数） */
  reasonArgs: Record<string, unknown>;
}

export interface GateSiftResult {
  /** 污点门剔除数（构建提示词前结构性剔除，不进任何候选列表） */
  tainted: number;
  /** 命名空间不符剔除数 */
  otherNamespace: number;
  /** 门槛未过数 */
  gateFailed: number;
  /** 进门候选（signals 已附） */
  passed: Array<StagingCandidate & { signals: GateSignalBreakdown }>;
  /** 逐候选拒绝明细（条目 2A log payload 的 rejected 数据源；不含 otherNamespace） */
  rejected: GateRejectionDetail[];
}

/**
 * 污点门 + 命名空间分拣 + 信号门（sweep 第一步的纯函数汇编）：
 * 顺序=污点剔除 → 命名空间 → 三硬门槛；passed 按分数降序（模型回合取头部）。
 */
export function siftCandidates(
  candidates: ReadonlyArray<StagingCandidate>,
  namespace: ConsolidationNamespace,
  thresholds: GateThresholds,
  now: number
): GateSiftResult {
  const result: GateSiftResult = { tainted: 0, otherNamespace: 0, gateFailed: 0, passed: [], rejected: [] };
  for (const c of candidates) {
    if (isTaintedOrigin(c.origin)) {
      result.tainted += 1;
      result.rejected.push({
        stagingId: c.stagingId,
        text: c.text,
        evidencePath: c.evidencePath,
        reasonKey: 'taint',
        reasonArgs: { origin: c.origin }
      });
      continue;
    }
    if (namespaceOfOrigin(c.origin) !== namespace) {
      result.otherNamespace += 1;
      continue;
    }
    const decision = evaluateCandidateGate(c, thresholds, now);
    if (!decision.passed) {
      result.gateFailed += 1;
      result.rejected.push({
        stagingId: c.stagingId,
        text: c.text,
        evidencePath: c.evidencePath,
        reasonKey: 'low_signal',
        reasonArgs: {
          score: Math.round(decision.signals.score * 1000) / 1000,
          minScore: thresholds.minScore,
          recallCount: c.recallEvents,
          minRecallCount: thresholds.minRecallCount,
          uniqueQueries: c.uniqueQueries,
          minUniqueQueries: thresholds.minUniqueQueries,
          failures: decision.failures
        }
      });
      continue;
    }
    result.passed.push({ ...c, signals: decision.signals });
  }
  result.passed.sort((a, b) => b.signals.score - a.signals.score || a.stagingId - b.stagingId);
  return result;
}
