/**
 * 情景暂存写入（memory-refactor §6.2）：memory.note / 压缩前 flush / 会话结束转录
 * 摄入共用的**唯一**落点——staging 表 state=pending，带完整溯源（origin/sessionKind/
 * taskId/repoKey/evidencePath）。
 *
 * 写入门（按序，先命中先拒）：
 * 1. 空文本 / 超长 → 拒（调用方自查）；
 * 2. 会话种类门（§5）：heartbeat/auto/headless 不产生晋升候选；
 * 3. 精确判重：与 pending staging 或任一 chunk 文本归一后相同 → 拒；
 * 4. 高重叠判重：CJK 二元组 Jaccard ≥ 阈值 → 拒（与既有 chunk/staging）；
 * 5. 召回回路防护（§5）：候选与 recall_stats 里被注入过的 chunk 高重叠 → 拒并记原因
 *   （注入过上下文的内容永不再被提取为新候选——防「检索结果→再入库」的自我强化回路）。
 *
 * 纯 db 操作（MemoryDb 句柄注入），service.noteStaging 是运行时入口。
 */
import { MemoryDb, deleteStagingChunkByStagingId, insertChunk } from './db';
import { isPromotableSessionKind } from './provenance';
import { mmrTokenSet } from './ranking';
import { appendEvent, eventNamespaceOfOrigin } from './events';
import type { MemoryOrigin } from './db';
import type { MemorySessionKind } from './service';

/** 判重/防护阈值（调参唯一入口；改动须同步 test/memory-write-path.mjs 矩阵） */
export const STAGING_CONSTANTS = {
  /** 单条候选文本上限（与 memory.* 工具 text 上限同档） */
  TEXT_MAX_CHARS: 4_000,
  /** 高重叠判重阈值（与既有 chunk / pending staging 比；Jaccard on CJK 二元组） */
  DUPLICATE_JACCARD: 0.75,
  /** 召回回路防护阈值（与被注入过的 chunk 比；略低于判重——注入污染宁可误拒） */
  RECALL_LOOP_JACCARD: 0.6,
  /** 判重比较的长度桶窗口因子（B3 评审 MINOR-5 收窄；口径修正 B4 评审 MINOR-4）：
   *  Jaccard ≥ 0.6 要求两侧 token 规模比 ≤ 1/0.6≈1.67，但 SQL 侧可比的是**原始
   *  字符长度**——它不是 token 数的严格上界：一侧被大量空白/标点撑长时（填充不
   *  对称），真高重叠行可能落在窗外，存在**理论假阴性边界**。4 倍窗是实用保守值
   *  （边界罕见），预筛为性能收窄、非严格等价。 */
  DUP_LENGTH_BUCKET_FACTOR: 4,
  /** 判重扫描行数上限（兜底防极端大库） */
  DUP_SCAN_LIMIT: 4_000,
  /** pending staging 未晋升的过期天数（默认 14；巩固配置 memoryConsolidation.stagingPendingTtlDays 可调） */
  PENDING_TTL_DAYS: 14
} as const;

export type NoteStagingRejectReason =
  | 'empty'
  | 'too_long'
  | 'session_kind_gate'
  | 'duplicate_exact'
  | 'duplicate_overlap'
  | 'recall_loop';

export interface NoteStagingInput {
  text: string;
  origin: MemoryOrigin;
  sessionKind: MemorySessionKind;
  taskId?: string | null;
  repoKey?: string | null;
  evidencePath?: string | null;
  writerAgent?: string | null;
  observedAt?: number | null;
  /** 附加信号（进 signals_json；如 { redactionHits: [...], source: 'memory.note' }） */
  signals?: Record<string, unknown>;
}

export type NoteStagingResult =
  | { ok: true; stagingId: number }
  | { ok: false; reason: NoteStagingRejectReason; detail?: string };

/** 归一比较基线：trim + 折叠空白（精确判重与展示都基于原文，仅比较时归一） */
function normalizeForCompare(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

interface TextRow {
  id: number;
  text: string;
}

/** B3 评审 MINOR-5：判重扫描先按长度桶 SQL 预筛（全表 Jaccard 收窄）——只取
 *  length(text) ∈ [len/F, len×F] 的行再算重叠。口径（B4 评审 MINOR-4 修正）：
 *  同窗行的 token 规模比通常满足阈值必要条件（阈值 ≥0.6 时 4 倍窗远宽于 1/0.6≈
 *  1.67），但字符长度受空白/标点填充影响、非 token 数的严格上界——填充不对称的
 *  真高重叠行理论上可落在窗外（假阴性边界）；预筛是性能收窄，非严格等价。 */
function dupScanLengthBounds(normLen: number): { lo: number; hi: number } {
  const f = STAGING_CONSTANTS.DUP_LENGTH_BUCKET_FACTOR;
  return { lo: Math.max(1, Math.floor(normLen / f)), hi: Math.ceil(normLen * f) };
}

function listPendingStagingTextsForDup(db: MemoryDb, normLen: number): TextRow[] {
  const { lo, hi } = dupScanLengthBounds(normLen);
  const rows = db.handle
    .prepare(
      'SELECT id, text FROM staging WHERE state = ? AND length(text) BETWEEN ? AND ? ORDER BY id LIMIT ?'
    )
    .all('pending', lo, hi, STAGING_CONSTANTS.DUP_SCAN_LIMIT) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), text: String(r.text) }));
}

function listChunkTextsForDup(db: MemoryDb, normLen: number): TextRow[] {
  const { lo, hi } = dupScanLengthBounds(normLen);
  const rows = db.handle
    .prepare(
      'SELECT id, text FROM chunks WHERE length(text) BETWEEN ? AND ? ORDER BY id LIMIT ?'
    )
    .all(lo, hi, STAGING_CONSTANTS.DUP_SCAN_LIMIT) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), text: String(r.text) }));
}

/** recall_stats 里被注入过的 chunk（全部 kind：brief_injected/search_hit/trigger_injected/escalation_hit）；
 *  同长度桶预筛（MINOR-5）。 */
function listRecalledChunkTextsForDup(db: MemoryDb, normLen: number): Array<TextRow & { kinds: string[] }> {
  const { lo, hi } = dupScanLengthBounds(normLen);
  const rows = db.handle
    .prepare(
      `SELECT c.id AS id, c.text AS text, GROUP_CONCAT(DISTINCT r.kind) AS kinds
       FROM recall_stats r JOIN chunks c ON c.id = r.chunk_id
       WHERE length(c.text) BETWEEN ? AND ?
       GROUP BY c.id ORDER BY c.id LIMIT ?`
    )
    .all(lo, hi, STAGING_CONSTANTS.DUP_SCAN_LIMIT) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    text: String(r.text),
    kinds: String(r.kinds ?? '')
      .split(',')
      .filter(Boolean)
  }));
}

/**
 * staging 写入唯一通道（见模块头部门序）。同步执行（DatabaseSync）；拒收一律返回
 * {ok:false, reason} 不抛错——调用方（工具 handler/摄入循环）按 reason 决定日志与回执。
 */
export function noteStaging(db: MemoryDb, input: NoteStagingInput): NoteStagingResult {
  const text = (input.text ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > STAGING_CONSTANTS.TEXT_MAX_CHARS) {
    return { ok: false, reason: 'too_long', detail: `${text.length} > ${STAGING_CONSTANTS.TEXT_MAX_CHARS}` };
  }
  if (!isPromotableSessionKind(input.sessionKind)) {
    return {
      ok: false,
      reason: 'session_kind_gate',
      detail: `会话种类 ${input.sessionKind} 不产生晋升候选（§5 种类门）`
    };
  }

  // —— 精确判重（pending staging + 全部 chunk）——
  const norm = normalizeForCompare(text);
  const pending = listPendingStagingTextsForDup(db, norm.length);
  const hitPending = pending.find((r) => normalizeForCompare(r.text) === norm);
  if (hitPending) {
    return { ok: false, reason: 'duplicate_exact', detail: `与 staging#${hitPending.id} 相同` };
  }
  const chunks = listChunkTextsForDup(db, norm.length);
  const hitChunk = chunks.find((r) => normalizeForCompare(r.text) === norm);
  if (hitChunk) {
    return { ok: false, reason: 'duplicate_exact', detail: `与 chunk#${hitChunk.id} 相同` };
  }

  // —— 召回回路防护（先于普通高重叠：被注入过的 chunk 单独低门槛）——
  const tokens = mmrTokenSet(norm);
  for (const r of listRecalledChunkTextsForDup(db, norm.length)) {
    const sim = jaccard(tokens, mmrTokenSet(r.text));
    if (sim >= STAGING_CONSTANTS.RECALL_LOOP_JACCARD) {
      return {
        ok: false,
        reason: 'recall_loop',
        detail: `与被注入过的 chunk#${r.id}（${r.kinds.join('+')}）Jaccard=${sim.toFixed(2)} ≥ ${STAGING_CONSTANTS.RECALL_LOOP_JACCARD}`
      };
    }
  }

  // —— 高重叠判重（pending staging + 全部 chunk）——
  for (const r of pending) {
    const sim = jaccard(tokens, mmrTokenSet(r.text));
    if (sim >= STAGING_CONSTANTS.DUPLICATE_JACCARD) {
      return {
        ok: false,
        reason: 'duplicate_overlap',
        detail: `与 staging#${r.id} Jaccard=${sim.toFixed(2)} ≥ ${STAGING_CONSTANTS.DUPLICATE_JACCARD}`
      };
    }
  }
  for (const r of chunks) {
    const sim = jaccard(tokens, mmrTokenSet(r.text));
    if (sim >= STAGING_CONSTANTS.DUPLICATE_JACCARD) {
      return {
        ok: false,
        reason: 'duplicate_overlap',
        detail: `与 chunk#${r.id} Jaccard=${sim.toFixed(2)} ≥ ${STAGING_CONSTANTS.DUPLICATE_JACCARD}`
      };
    }
  }

  const now = Date.now();
  const signals = {
    ...(input.signals ?? {}),
    dupChecked: { pendingStaging: pending.length, chunks: chunks.length, lengthBucket: dupScanLengthBounds(norm.length) }
  };
  const observedAt = input.observedAt ?? now;
  // staging 行 + 镜像 chunk（source_type='staging'，可检索、参与判重对照）同事务落库
  // （db.write 可重入：insertChunk 在本事务内执行，崩溃不留孤儿 staging/chunk 半对）
  // + `staged` 事件（条目 1A 写点收口：memory.note / 转录摄入 / 压缩前 flush 三入口
  // 共用本落点，恰好一行事件；appendEvent 失败只打日志不阻塞主写入，主写回滚则事件一并回滚）
  const id = db.write((tx) => {
    const info = tx
      .prepare(
        `INSERT INTO staging (text, origin, session_kind, task_id, repo_key, observed_at, evidence_path, signals_json, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        text,
        input.origin,
        input.sessionKind,
        input.taskId ?? null,
        input.repoKey ?? null,
        observedAt,
        input.evidencePath ?? null,
        JSON.stringify(signals),
        now
      );
    const stagingId = Number(info.lastInsertRowid);
    insertChunk(db, {
      sourceType: 'staging',
      text,
      origin: input.origin,
      sessionKind: input.sessionKind,
      writerAgent: input.writerAgent ?? null,
      taskId: input.taskId ?? null,
      repoKey: input.repoKey ?? null,
      observedAt,
      stagingId
    });
    appendEvent(db, {
      kind: 'staged',
      ts: now,
      namespace: eventNamespaceOfOrigin(input.origin),
      stagingId,
      entryRef: `staging:${stagingId}`,
      summary: '新记忆候选入池：{{text}}',
      summaryArgs: { text: stagingSnippet(text) }
    });
    return stagingId;
  });
  return { ok: true, stagingId: id };
}

/** 事件参数里的正文摘要（人话一句不整段入库；80 字截断） */
function stagingSnippet(text: string): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

// ---------------------------------------------------------------------------
// 生命周期联动（B4 巩固批）：staging 行状态迁移 ↔ 镜像 chunk 清理
// ---------------------------------------------------------------------------

export type StagingTransitionState = 'promoted' | 'rejected' | 'expired';

/**
 * staging 行状态迁移 + 镜像 chunk 删除（promoted→晋升后策展文件由 indexer 吸收；
 * rejected/expired→候选退场）。幂等：行不存在/已迁移时 no-op 返回 false。
 *
 * `promoted` 事件（条目 1A 写点收口）：sweep 自动晋升 / 审批批准 / 画像晋升全走本
 * 状态翻转，恰好一行事件、与状态迁移同事务（主写回滚则事件一并回滚）。
 */
export function transitionStaging(
  db: MemoryDb,
  stagingId: number,
  state: StagingTransitionState
): boolean {
  // 状态迁移与镜像 chunk 删除同一事务（db.write 可重入；避免崩溃留下已迁移行的孤儿 chunk）
  return db.write((tx) => {
    const row = tx.prepare('SELECT origin FROM staging WHERE id = ?').get(stagingId) as
      | { origin: string }
      | undefined;
    const info = tx
      .prepare("UPDATE staging SET state = ? WHERE id = ? AND state = 'pending'")
      .run(state, stagingId);
    if (Number(info.changes) === 0) return false;
    deleteStagingChunkByStagingId(db, stagingId);
    if (state === 'promoted') {
      appendEvent(db, {
        kind: 'promoted',
        ts: Date.now(),
        namespace: eventNamespaceOfOrigin(row?.origin),
        stagingId,
        entryRef: `staging:${stagingId}`,
        summary: '一条记忆通过巩固晋升入库（候选 #{{stagingId}}）',
        summaryArgs: { stagingId }
      });
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// 面板丢弃标记（条目 6A，schema v4）：user_discarded 是独立状态而非 transition 终态
// ——丢弃可撤销（清标记回 pending），随下次 sweep 物理出池（sweepDiscardedStaging）。
// ---------------------------------------------------------------------------

/** 面板丢弃：pending → user_discarded（灰显保留，5s 内可撤销）。幂等 no-op 返回 false */
export function discardStaging(db: MemoryDb, stagingId: number): boolean {
  return db.write((tx) => {
    const info = tx
      .prepare("UPDATE staging SET state = 'user_discarded' WHERE id = ? AND state = 'pending'")
      .run(stagingId);
    return Number(info.changes) > 0;
  });
}

/** 撤销丢弃：user_discarded → pending（信号/镜像 chunk 均未动，状态无损恢复） */
export function undiscardStaging(db: MemoryDb, stagingId: number): boolean {
  return db.write((tx) => {
    const info = tx
      .prepare("UPDATE staging SET state = 'pending' WHERE id = ? AND state = 'user_discarded'")
      .run(stagingId);
    return Number(info.changes) > 0;
  });
}

/**
 * 物理出池（sweep piggyback）：user_discarded 行整行删除（镜像 chunk 与其 recall_stats
 * 经 deleteStagingChunkByStagingId 一并清理）。出池后不可恢复（暂存是派生态，非 canonical）。
 * 返回清理条数。
 */
export function sweepDiscardedStaging(db: MemoryDb): number {
  return db.write((tx) => {
    const ids = (
      tx.prepare("SELECT id FROM staging WHERE state = 'user_discarded' ORDER BY id").all() as Array<{
        id: number;
      }>
    ).map((r) => Number(r.id));
    let n = 0;
    for (const id of ids) {
      deleteStagingChunkByStagingId(db, id);
      const info = tx.prepare("DELETE FROM staging WHERE id = ? AND state = 'user_discarded'").run(id);
      if (Number(info.changes) > 0) n += 1;
    }
    return n;
  });
}

/**
 * 过期清扫：pending 超过 TTL 天未晋升 → expired（镜像 chunk 一并删除）。
 * 每次巩固 sweep 的第一步；返回迁移条数。
 */
export function sweepExpiredStaging(db: MemoryDb, now: number, ttlDays: number = STAGING_CONSTANTS.PENDING_TTL_DAYS): number {
  const cutoff = now - ttlDays * 86_400_000;
  const ids = (
    db.handle
      .prepare('SELECT id FROM staging WHERE state = ? AND created_at < ? ORDER BY id')
      .all('pending', cutoff) as Array<{ id: number }>
  ).map((r) => Number(r.id));
  let n = 0;
  for (const id of ids) {
    if (transitionStaging(db, id, 'expired')) n += 1;
  }
  return n;
}

/** 摄入检查点（防重放）：meta 键（每会话一条） */
export const INGEST_CHECKPOINT_META_PREFIX = 'ingest_checkpoint:';

export interface IngestCheckpoint {
  /** 摄入时的消息数（再触发时消息更多才增量摄入） */
  messageCount: number;
  /** 已摄入到的消息 id（截断重放保护） */
  lastMessageId: string;
  ingestedCount: number;
  ts: number;
}

export function readIngestCheckpoint(db: MemoryDb, sessionId: string): IngestCheckpoint | null {
  try {
    const raw = db.metaGet(INGEST_CHECKPOINT_META_PREFIX + sessionId);
    if (!raw) return null;
    const v = JSON.parse(raw) as IngestCheckpoint;
    return typeof v.messageCount === 'number' && typeof v.lastMessageId === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function writeIngestCheckpoint(db: MemoryDb, sessionId: string, cp: IngestCheckpoint): void {
  db.metaSet(INGEST_CHECKPOINT_META_PREFIX + sessionId, JSON.stringify(cp));
}
