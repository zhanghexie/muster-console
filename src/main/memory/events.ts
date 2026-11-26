/**
 * 统一记忆事件账本（记忆面板「原理可视化」条目 1A，schema v4）：
 * `memory_events` 表一行 = 记忆系统的一次真实行为（入池/晋升/取代/待审/裁决/直写/
 * 画像写/意图触发/意图取消），供总览事件流与边流量取数（M3 消费）。
 *
 * 写点纪律（对齐仓内「写入恰好一道收口」）：每条路径**恰好一处** appendEvent——
 *   staged            ← staging.ts noteStaging（memory.note / 转录摄入 / 压缩前 flush
 *                        三入口共用同一落点，故单点覆盖）
 *   promoted          ← staging.ts transitionStaging（sweep 自动晋升 / 审批批准 /
 *                        画像晋升全走此状态翻转收口，与状态迁移同事务）
 *   superseded        ← consolidation/apply.ts applyConsolidationOperations
 *                        （sweep 自动应用与审批批准共用的改写执行收口）
 *   approval_queued   ← consolidation/approval.ts enqueueConsolidationApproval（与
 *                        approvals 插入同事务）
 *   approval_decided  ← consolidation/approval.ts decideConsolidationApproval
 *   direct_write      ←（已退役 2026-10-26 F-01）旧直写门 directWriteCuratedCore 的
 *                        落账 kind；历史账本仍可能含此 kind，渲染面继续兼容只读
 *   profile_write     ← userProfile.ts writeUserProfile（观察点注入，见模块内说明）
 *   intent_fired / intent_cancelled ← intents.ts tryFireIntent / cancelIntent（与
 *                        状态推进同事务）
 * 注入**不逐条落账**（条目 1A 定稿）：bootstrap 每回合注入会淹死事件流——注入类
 * 活动从 recall_stats 投影（center 层 30 天聚合），不进本表。
 *
 * 事务与失败语义：appendEvent 可在 db.write 事务内调用（可重入——与主写入同事务，
 * 主写入回滚则事件一并回滚），也可独立调用（自带 BEGIN IMMEDIATE）。内部 try/catch：
 * 事件失败只打日志，**绝不阻塞/拖垮主写入**。summary 存 i18n key（zh 原文形态）+
 * summary_args 参数 JSON（不存翻译后文案，渲染层 t(key, args)）。
 *
 * node-only（MemoryDb 注入；.mjs 可转译直测）。
 */
import type { MemoryDb } from './db';

export type MemoryEventKind =
  | 'staged'
  | 'promoted'
  | 'superseded'
  | 'approval_queued'
  | 'approval_decided'
  | 'direct_write'
  | 'profile_write'
  | 'intent_fired'
  | 'intent_cancelled';

/** 事件 kind 全域（channel 归一/校验用，与 db CHECK 同域） */
export const MEMORY_EVENT_KINDS: readonly MemoryEventKind[] = [
  'staged',
  'promoted',
  'superseded',
  'approval_queued',
  'approval_decided',
  'direct_write',
  'profile_write',
  'intent_fired',
  'intent_cancelled'
];

/** 巩固命名空间投影（staged/promoted 按 origin 折算；写侧共享） */
export type MemoryEventNamespace = 'worker' | 'scheduler' | 'profile';

export function eventNamespaceOfOrigin(origin: string | null | undefined): MemoryEventNamespace {
  if (origin === 'scheduler') return 'scheduler';
  if (origin === 'user') return 'profile';
  return 'worker';
}

export interface MemoryEventInput {
  kind: MemoryEventKind;
  /** epoch ms */
  ts: number;
  namespace?: MemoryEventNamespace | null;
  stagingId?: number | null;
  approvalId?: number | null;
  chunkId?: number | null;
  /** 实体定位串（staging:<id> / approval:<id> / intent:<id> / 条目 id / null） */
  entryRef?: string | null;
  /** i18n key（zh 原文形态，可含 {{arg}} 占位） */
  summary: string;
  /** 参数 JSON（渲染层 t(summary, args)；不存翻译后文案） */
  summaryArgs?: Record<string, unknown> | null;
}

/**
 * 追加一条事件（best-effort）：任何失败（库未开/CHECK 拒域/IO）只打日志，
 * 不向上抛——调用方的主写入路径不受影响。已在 db.write 事务内时并入当前事务。
 */
export function appendEvent(db: MemoryDb, evt: MemoryEventInput): void {
  try {
    db.write((tx) =>
      tx
        .prepare(
          `INSERT INTO memory_events (kind, ts, namespace, staging_id, approval_id, chunk_id, entry_ref, summary, summary_args)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          evt.kind,
          evt.ts,
          evt.namespace ?? null,
          evt.stagingId ?? null,
          evt.approvalId ?? null,
          evt.chunkId ?? null,
          evt.entryRef ?? null,
          evt.summary,
          evt.summaryArgs ? JSON.stringify(evt.summaryArgs) : null
        )
    );
  } catch (err) {
    console.error('[memory-events] appendEvent 失败（不阻塞主写入）', err);
  }
}

export interface MemoryEventRow {
  id: number;
  kind: MemoryEventKind;
  ts: number;
  namespace: string | null;
  stagingId: number | null;
  approvalId: number | null;
  chunkId: number | null;
  entryRef: string | null;
  summary: string;
  summaryArgs: Record<string, unknown> | null;
}

function mapEventRow(r: Record<string, unknown>): MemoryEventRow {
  let args: Record<string, unknown> | null = null;
  if (r.summary_args != null) {
    try {
      const v = JSON.parse(String(r.summary_args)) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) args = v as Record<string, unknown>;
    } catch {
      /* 坏 JSON = 无参数（读取端宽容） */
    }
  }
  return {
    id: Number(r.id),
    kind: String(r.kind) as MemoryEventKind,
    ts: Number(r.ts),
    namespace: (r.namespace as string | null) ?? null,
    stagingId: r.staging_id == null ? null : Number(r.staging_id),
    approvalId: r.approval_id == null ? null : Number(r.approval_id),
    chunkId: r.chunk_id == null ? null : Number(r.chunk_id),
    entryRef: (r.entry_ref as string | null) ?? null,
    summary: String(r.summary ?? ''),
    summaryArgs: args
  };
}

export interface ListMemoryEventsOptions {
  /** 返回条数上限（事件流渲染上限 50 由调用方定；此处兜底 200） */
  limit?: number;
  /** kind 过滤（缺省全量） */
  kinds?: ReadonlyArray<MemoryEventKind>;
  /** 只返回该时刻之后的事件（epoch ms） */
  sinceTs?: number;
  /** 只返回该时刻之前的事件（增量读取游标；缺省不限） */
  beforeId?: number;
}

/** 事件流读取（新→旧；面板轮询取数） */
export function listMemoryEvents(db: MemoryDb, opts: ListMemoryEventsOptions = {}): MemoryEventRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const clauses: string[] = [];
  const args: Array<string | number | null> = [];
  if (opts.kinds && opts.kinds.length) {
    clauses.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
    args.push(...opts.kinds);
  }
  if (opts.sinceTs != null) {
    clauses.push('ts > ?');
    args.push(opts.sinceTs);
  }
  if (opts.beforeId != null) {
    clauses.push('id < ?');
    args.push(opts.beforeId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.handle
    .prepare(`SELECT * FROM memory_events ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as Array<Record<string, unknown>>;
  return rows.map(mapEventRow);
}

/** 按 kind 计数（时间窗聚合；总览边流量「近 24h 通过 X · 被拒 Y」取数面） */
export function countEventsByKind(
  db: MemoryDb,
  sinceTs: number,
  kinds?: ReadonlyArray<MemoryEventKind>
): Record<string, number> {
  const clauses = ['ts >= ?'];
  const args: Array<string | number | null> = [sinceTs];
  if (kinds && kinds.length) {
    clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    args.push(...kinds);
  }
  const rows = db.handle
    .prepare(
      `SELECT kind, count(*) n FROM memory_events WHERE ${clauses.join(' AND ')} GROUP BY kind`
    )
    .all(...args) as Array<Record<string, unknown>>;
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.kind)] = Number(r.n);
  return out;
}

/**
 * 滚动清理（条目 1A）：保留窗与 transcriptRetentionDays 同源（缺省 90 天），随
 * sweep 首步 piggyback（sweep.ts 调用），不另起定时子系统。返回删除条数。
 */
export function deleteEventsBefore(db: MemoryDb, cutoffMs: number): number {
  return db.write((tx) => {
    const info = tx.prepare('DELETE FROM memory_events WHERE ts < ?').run(cutoffMs);
    return Number(info.changes);
  });
}
