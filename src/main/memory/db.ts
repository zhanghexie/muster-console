/**
 * 记忆派生态库（memory-refactor §4.2）：`<工作区根>/.muster/memory/runtime/state.sqlite`。
 *
 * 只存派生态（chunks 索引/staging/recall_stats/preimages/approvals/intents/
 * consolidation_log/memory_events），markdown canonical + 转录是真源——删库可重建。工作区根
 * 定位照 taskStore/schedulerMemoryStore 惯例（root/.muster/...），路径解析
 * 由调用方（service.init(workspaceRoot)）传入。
 *
 * 写路径纪律：DatabaseSync 同步执行 + write() 单入口 BEGIN IMMEDIATE 事务，
 * 进程内天然不交错；跨进程（多工作台实例）由 SQLite 写锁 + busy_timeout 兜底。
 * schema 版本存 meta 表（迁移骨架：MIGRATIONS 顺序应用，v1→后续可扩展）。
 *
 * CJK 全文：node:sqlite 的 FTS5 可用且 trigram 分词器在册，但 trigram 的 MATCH
 * 要求 ≥3 字符——二字中文词（最常见词长）不命中（B1 冒烟实测）。按方案 §4.2
 * 「fts(FTS5, CJK 二元组)」采用预分词方案：cjkBigramTokenize() 把文本切成
 * 空格分隔 token 写入 chunks.fts（unicode61 分词的普通 FTS5 索引）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import { ftsColumnText, ftsMatchExpr, ftsMatchExprAny } from './tokenize';
import {ensureMemoryLayout,RUNTIME_HOME_REL,memoryPath} from './layout';

export { cjkBigramTokenize, ftsColumnText, ftsMatchExpr, ftsMatchExprAny } from './tokenize';

export const MEMORY_STATE_DIR_REL = RUNTIME_HOME_REL;
export const MEMORY_DB_FILE_NAME = 'state.sqlite';
export const MEMORY_DB_SCHEMA_VERSION = 5;

export function memoryDbFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, MEMORY_STATE_DIR_REL, MEMORY_DB_FILE_NAME);
}

// ---------------------------------------------------------------------------
// CJK 二元组预分词：见 tokenize.ts（B2 抽出为独立模块；此处 re-export 保持 B1 API）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// schema：meta 存版本；MIGRATIONS 顺序应用（同事务原子）
// ---------------------------------------------------------------------------

interface MigrationStep {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

/** §4.2 八表 v1（列按 sketch；细节出入见 progress.md 偏差记录）。meta 表由 migrate 引导创建，不属迁移内容。
 *  导出仅供 v1→v2 迁移测试构造真 v1 老库（test/memory-consolidation.mjs 老库升级路径）。 */
export function createV1Schema(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE chunks (
  id                  INTEGER PRIMARY KEY,
  source_type         TEXT NOT NULL CHECK (source_type IN ('memory','journal','transcript','user_md','features')),
  source_path         TEXT,
  line_start          INTEGER,
  line_end            INTEGER,
  text                TEXT NOT NULL,
  fts                 TEXT NOT NULL,
  origin              TEXT NOT NULL CHECK (origin IN ('user','scheduler','worker','untrusted','system')),
  session_kind        TEXT,
  writer_agent        TEXT,
  task_id             TEXT,
  repo_key            TEXT,
  observed_at         INTEGER,
  supersession_key    TEXT,
  importance          INTEGER,
  triggers            TEXT,
  recalled_count      INTEGER NOT NULL DEFAULT 0,
  last_recalled_at    INTEGER,
  ingested_session_id TEXT
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  fts,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE INDEX idx_chunks_source       ON chunks(source_type, source_path);
CREATE INDEX idx_chunks_origin       ON chunks(origin);
CREATE INDEX idx_chunks_task         ON chunks(task_id);
CREATE INDEX idx_chunks_repo         ON chunks(repo_key);
CREATE INDEX idx_chunks_supersession ON chunks(supersession_key);

CREATE TABLE staging (
  id            INTEGER PRIMARY KEY,
  text          TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('user','scheduler','worker','untrusted','system')),
  session_kind  TEXT,
  task_id       TEXT,
  repo_key      TEXT,
  observed_at   INTEGER,
  evidence_path TEXT,
  signals_json  TEXT,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','promoted','rejected','expired')),
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_staging_state ON staging(state);

CREATE TABLE recall_stats (
  id          INTEGER PRIMARY KEY,
  chunk_id    INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('brief_injected','search_hit','trigger_injected','escalation_hit')),
  query_text  TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX idx_recall_chunk ON recall_stats(chunk_id);

CREATE TABLE preimages (
  id           INTEGER PRIMARY KEY,
  file_path    TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cause        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE approvals (
  id         INTEGER PRIMARY KEY,
  action     TEXT NOT NULL CHECK (action IN ('promote','supersede','delete','user_md_change')),
  payload    TEXT NOT NULL,
  confidence REAL,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX idx_approvals_state ON approvals(state);

CREATE TABLE intents (
  id                    INTEGER PRIMARY KEY,
  description           TEXT NOT NULL,
  trigger_keywords      TEXT,
  event_predicates_json TEXT,
  channel_scope         TEXT,
  sender_scope          TEXT,
  expiry                INTEGER,
  cooldown_ms           INTEGER,
  fire_budget           INTEGER,
  fire_count            INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','armed','fired','done','cancelled','expired')),
  created_by            TEXT,
  created_at            INTEGER NOT NULL,
  last_fired_at         INTEGER
);
CREATE INDEX idx_intents_state ON intents(state);

CREATE TABLE consolidation_log (
  id               INTEGER PRIMARY KEY,
  trigger_source   TEXT,
  added_count      INTEGER NOT NULL DEFAULT 0,
  merged_count     INTEGER NOT NULL DEFAULT 0,
  superseded_count INTEGER NOT NULL DEFAULT 0,
  diff_summary     TEXT,
  rejected_counts  TEXT,
  started_at       INTEGER,
  finished_at      INTEGER NOT NULL
);
`);
}

/**
 * v2（B4 巩固批）：
 * - `chunks.source_type` CHECK 增加 `'staging'`（pending staging 落库同步进 chunks，
 *   可检索、参与判重对照——progress B3-MINOR-6 钉死的 B4 交付物）。SQLite CHECK
 *   约束不可 ALTER——建新表搬数据，FTS5 外部内容表随 chunks 重建并重灌索引行。
 * - `chunks.staging_id` 列：staging 行 ↔ 其镜像 chunk 的生命周期联动键
 *   （promoted/rejected/expired 时删 chunk）。
 * - `recall_stats.relevance` 列：检索命中时落的相关分（信号门 Relevance 均值数据源；
 *   老行为 NULL=未记录，门按中性 0.5 处理）。
 */
function migrateV1ToV2(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE chunks_v2 (
  id                  INTEGER PRIMARY KEY,
  source_type         TEXT NOT NULL CHECK (source_type IN ('memory','journal','transcript','user_md','features','staging')),
  source_path         TEXT,
  line_start          INTEGER,
  line_end            INTEGER,
  text                TEXT NOT NULL,
  fts                 TEXT NOT NULL,
  origin              TEXT NOT NULL CHECK (origin IN ('user','scheduler','worker','untrusted','system')),
  session_kind        TEXT,
  writer_agent        TEXT,
  task_id             TEXT,
  repo_key            TEXT,
  observed_at         INTEGER,
  supersession_key    TEXT,
  importance          INTEGER,
  triggers            TEXT,
  recalled_count      INTEGER NOT NULL DEFAULT 0,
  last_recalled_at    INTEGER,
  ingested_session_id TEXT,
  staging_id          INTEGER
);
INSERT INTO chunks_v2 (
  id, source_type, source_path, line_start, line_end, text, fts,
  origin, session_kind, writer_agent, task_id, repo_key, observed_at, supersession_key,
  importance, triggers, recalled_count, last_recalled_at, ingested_session_id
)
SELECT
  id, source_type, source_path, line_start, line_end, text, fts,
  origin, session_kind, writer_agent, task_id, repo_key, observed_at, supersession_key,
  importance, triggers, recalled_count, last_recalled_at, ingested_session_id
FROM chunks;
DROP TABLE chunks_fts;
DROP TABLE chunks;
ALTER TABLE chunks_v2 RENAME TO chunks;
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  fts,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);
INSERT INTO chunks_fts(rowid, fts) SELECT id, fts FROM chunks;
CREATE INDEX idx_chunks_source       ON chunks(source_type, source_path);
CREATE INDEX idx_chunks_origin       ON chunks(origin);
CREATE INDEX idx_chunks_task         ON chunks(task_id);
CREATE INDEX idx_chunks_repo         ON chunks(repo_key);
CREATE INDEX idx_chunks_supersession ON chunks(supersession_key);
CREATE INDEX idx_chunks_staging      ON chunks(staging_id);
ALTER TABLE recall_stats ADD COLUMN relevance REAL;
`);
}

const MIGRATIONS: MigrationStep[] = [
  { version: 1, description: '八表初始 schema（§4.2）', up: createV1Schema },
  { version: 2, description: 'chunks CHECK 增 staging + staging_id 键；recall_stats 增 relevance（B4 巩固）', up: migrateV1ToV2 },
  { version: 3, description: 'recall_stats CHECK 增 bootstrap（B5 读路径：bootstrap 注入落账）', up: migrateV2ToV3 },
  {
    version: 4,
    description:
      'memory_events 事件账本 + staging CHECK 增 user_discarded + consolidation_log 增 payload 明细（记忆面板 M1）',
    up: migrateV3ToV4
  },
  {
    version: 5,
    description: 'approval_exec 审批执行日志（2026-10-02 审计 M1：审批跨存储操作的幂等恢复协议）',
    up: migrateV4ToV5
  }
];

/**
 * v5（2026-10-02 审计 M1）：新表 `approval_exec`——审批批准的持久化执行日志。
 *
 * 旧序「先写文件、再翻转审批状态」在两个存储间没有事务：文件写成功后审批状态
 * 更新失败（或进程崩溃），同一审批重试会重复应用正文。v5 起每次批准在派生库内
 * 留执行凭据（claim → file_applied → 由 approvals.state 翻转收尾），重试/重启后按
 * 哈希比对识别「已写/未写/外部收动」三种恢复分支，文件效果恰好一次。详见
 * consolidation/approvalExec.ts 与 docs/features/memory-system.md「审批执行恢复协议」。
 */
function migrateV4ToV5(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE approval_exec (
  approval_id     INTEGER PRIMARY KEY,
  phase           TEXT NOT NULL CHECK (phase IN ('claimed','file_applied','failed')),
  attempt         INTEGER NOT NULL,
  base_hash       TEXT NOT NULL,
  planned_hash    TEXT NOT NULL,
  planned_content TEXT NOT NULL,
  settle_json     TEXT NOT NULL,
  error           TEXT,
  claimed_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_approval_exec_phase ON approval_exec(phase);
`);
}

/**
 * v3（B5 读路径）：`recall_stats.kind` CHECK 增加 `'bootstrap'`——§7 Lane1 bootstrap
 * 注入（调度前缀 / Worker 系统提示 / pi 逐轮 / 简报基底）按「首次/刷新」落账，
 * 喂 B4 信号门的召回频次。CHECK 不可 ALTER，建新表搬数据（列不变，纯域扩展）。
 */
function migrateV2ToV3(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE recall_stats_v3 (
  id          INTEGER PRIMARY KEY,
  chunk_id    INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('bootstrap','brief_injected','search_hit','trigger_injected','escalation_hit')),
  query_text  TEXT,
  ts          INTEGER NOT NULL,
  relevance   REAL
);
INSERT INTO recall_stats_v3 (id, chunk_id, kind, query_text, ts, relevance)
  SELECT id, chunk_id, kind, query_text, ts, relevance FROM recall_stats;
DROP TABLE recall_stats;
ALTER TABLE recall_stats_v3 RENAME TO recall_stats;
CREATE INDEX idx_recall_chunk ON recall_stats(chunk_id);
`);
}

/**
 * v4（记忆面板「原理可视化」M1 数据地基）：
 * - 新表 `memory_events`：统一记忆事件账本（条目 1A）——写点收口见 events.ts；
 *   summary 存 i18n key（zh 原文形态），summary_args 存参数 JSON（不存翻译后文案，
 *   渲染层 t(key, args)）；namespace ∈ worker/scheduler/profile/null。事件不做全文
 *   检索（无 FTS）；滚动清理随 sweep（保留窗与 transcriptRetentionDays 同源）。
 * - `staging.state` CHECK 增加 `'user_discarded'`（条目 6A：面板丢弃标记；随下次
 *   sweep 物理出池）。CHECK 不可 ALTER，建新表搬数据。
 * - `consolidation_log` 增 `payload` 列（条目 2A：applied/supersededPairs/rejected
 *   明细 JSON；历史行 NULL=无明细，读取端宽容）。纯加列，ALTER 即可（无 CHECK）。
 */
function migrateV3ToV4(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE memory_events (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN (
    'staged','promoted','superseded','approval_queued','approval_decided',
    'direct_write','profile_write','intent_fired','intent_cancelled')),
  ts           INTEGER NOT NULL,
  namespace    TEXT,
  staging_id   INTEGER,
  approval_id  INTEGER,
  chunk_id     INTEGER,
  entry_ref    TEXT,
  summary      TEXT NOT NULL,
  summary_args TEXT
);
CREATE INDEX idx_events_ts ON memory_events(ts);
CREATE TABLE staging_v4 (
  id            INTEGER PRIMARY KEY,
  text          TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('user','scheduler','worker','untrusted','system')),
  session_kind  TEXT,
  task_id       TEXT,
  repo_key      TEXT,
  observed_at   INTEGER,
  evidence_path TEXT,
  signals_json  TEXT,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','promoted','rejected','expired','user_discarded')),
  created_at    INTEGER NOT NULL
);
INSERT INTO staging_v4 (id, text, origin, session_kind, task_id, repo_key, observed_at, evidence_path, signals_json, state, created_at)
  SELECT id, text, origin, session_kind, task_id, repo_key, observed_at, evidence_path, signals_json, state, created_at FROM staging;
DROP TABLE staging;
ALTER TABLE staging_v4 RENAME TO staging;
CREATE INDEX idx_staging_state ON staging(state);
ALTER TABLE consolidation_log ADD COLUMN payload TEXT;
`);
}

function readMetaString(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? String(row.value) : null;
}

function writeMetaString(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  const raw = readMetaString(db, 'schema_version');
  const current = raw === null ? 0 : Number(raw);
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`[memory-db] 非法的 schema_version：${raw}`);
  }
  if (current > MEMORY_DB_SCHEMA_VERSION) {
    throw new Error(
      `[memory-db] 库由更高版本写入（v${current} > v${MEMORY_DB_SCHEMA_VERSION}），请升级应用后重试`
    );
  }
  for (const step of MIGRATIONS) {
    if (current >= step.version) continue;
    step.up(db);
    writeMetaString(db, 'schema_version', String(step.version));
  }
}

// ---------------------------------------------------------------------------
// 句柄：打开/关闭 + 写单入口
// ---------------------------------------------------------------------------

export class MemoryDb {
  private inWrite = false;
  private closed = false;

  constructor(
    /** 库文件绝对路径（诊断用） */
    readonly filePath: string,
    private readonly raw: DatabaseSync
  ) {}

  /** 底层句柄（读路径直用；写路径必须经 write()） */
  get handle(): DatabaseSync {
    return this.raw;
  }

  schemaVersion(): number {
    const v = readMetaString(this.raw, 'schema_version');
    return v === null ? 0 : Number(v);
  }

  metaGet(key: string): string | null {
    return readMetaString(this.raw, key);
  }

  metaSet(key: string, value: string): void {
    this.write((db) => writeMetaString(db, key, value));
  }

  /**
   * 所有写操作的单入口：BEGIN IMMEDIATE 事务内串行执行 fn，异常整体回滚。
   * DatabaseSync 同步执行 → 进程内天然不交错；可重入（嵌套调用直接在当前事务跑）。
   */
  write<T>(fn: (db: DatabaseSync) => T): T {
    if (this.closed) throw new Error('[memory-db] 库已关闭');
    if (this.inWrite) return fn(this.raw);
    this.inWrite = true;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(this.raw);
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* 连接已断/事务已结束：不掩盖原错误 */
      }
      throw err;
    } finally {
      this.inWrite = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** 打开（不存在则创建）工作区记忆派生库并迁到当前 schema 版本 */
export function openMemoryDb(workspaceRoot: string): MemoryDb {
  ensureMemoryLayout(workspaceRoot);
  const file = memoryDbFilePath(workspaceRoot);
  memoryPath(workspaceRoot,path.relative(workspaceRoot,file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(sqliteFilePath(file));
  try {
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
    const db = new MemoryDb(file, raw);
    db.write(migrate);
    return db;
  } catch (err) {
    try {
      raw.close();
    } catch {
      /* 打开失败的清理不掩盖原错误 */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// chunks 读写助手（P0 最小面 + P1 检索扩展：FTS 全字段命中/按源删除/
// recall_stats 落账；外部内容表 FTS 索引行始终与 chunks 同事务维护）
// ---------------------------------------------------------------------------

export type ChunkSourceType = 'memory' | 'journal' | 'transcript' | 'user_md' | 'features' | 'staging';
export type MemoryOrigin = 'user' | 'scheduler' | 'worker' | 'untrusted' | 'system';

export interface ChunkInsert {
  sourceType: ChunkSourceType;
  sourcePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  text: string;
  origin: MemoryOrigin;
  sessionKind?: string | null;
  writerAgent?: string | null;
  taskId?: string | null;
  repoKey?: string | null;
  observedAt?: number | null;
  supersessionKey?: string | null;
  /** 1–10；缺省=中性（NULL） */
  importance?: number | null;
  triggers?: string[] | null;
  ingestedSessionId?: string | null;
  /** staging 镜像 chunk 的源 staging 行 id（source_type='staging' 时填；生命周期联动键） */
  stagingId?: number | null;
}

export interface ChunkRow {
  id: number;
  sourceType: string;
  sourcePath: string | null;
  text: string;
  origin: string;
  taskId: string | null;
  repoKey: string | null;
  importance: number | null;
}

/** 插入一条 chunk（含 FTS 索引行，同事务）；返回新 id */
export function insertChunk(db: MemoryDb, rec: ChunkInsert): number {
  if (rec.importance != null && (!Number.isInteger(rec.importance) || rec.importance < 1 || rec.importance > 10)) {
    throw new Error(`[memory-db] importance 须为 1–10 整数，得到 ${rec.importance}`);
  }
  const text = String(rec.text ?? '');
  if (!text.trim()) throw new Error('[memory-db] chunk 文本不能为空');
  return db.write((tx) => {
    const info = tx
      .prepare(
        `INSERT INTO chunks (
           source_type, source_path, line_start, line_end, text, fts,
           origin, session_kind, writer_agent, task_id, repo_key,
           observed_at, supersession_key, importance, triggers, ingested_session_id, staging_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.sourceType,
        rec.sourcePath ?? null,
        rec.lineStart ?? null,
        rec.lineEnd ?? null,
        text,
        ftsColumnText(text),
        rec.origin,
        rec.sessionKind ?? null,
        rec.writerAgent ?? null,
        rec.taskId ?? null,
        rec.repoKey ?? null,
        rec.observedAt ?? null,
        rec.supersessionKey ?? null,
        rec.importance ?? null,
        rec.triggers ? JSON.stringify(rec.triggers) : null,
        rec.ingestedSessionId ?? null,
        rec.stagingId ?? null
      );
    const id = Number(info.lastInsertRowid);
    tx.prepare('INSERT INTO chunks_fts(rowid, fts) VALUES (?, ?)').run(id, ftsColumnText(text));
    return id;
  });
}

/** 删 chunk 行 + FTS 影子 + 其 recall_stats（同事务；防孤儿账）。返回删了几条 */
function purgeChunkRows(
  tx: DatabaseSync,
  rows: Array<{ id: number; fts: string }>
): number {
  const delFts = tx.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, fts) VALUES ('delete', ?, ?)");
  const rm = tx.prepare('DELETE FROM chunks WHERE id = ?');
  const rmStats = tx.prepare('DELETE FROM recall_stats WHERE chunk_id = ?');
  for (const r of rows) {
    delFts.run(r.id, r.fts);
    rm.run(r.id);
    rmStats.run(r.id);
  }
  return rows.length;
}

/** 删除一条 chunk（连同 FTS 索引行与其 recall_stats，同事务）；返回是否存在 */
export function deleteChunk(db: MemoryDb, id: number): boolean {
  return db.write((tx) => {
    const row = tx.prepare('SELECT id, fts FROM chunks WHERE id = ?').get(id) as
      | { id: number; fts: string }
      | undefined;
    if (!row) return false;
    purgeChunkRows(tx, [row]);
    return true;
  });
}

export interface ChunkFtsHit extends ChunkRow {
  /** FTS5 bm25 相关性（越小越相关） */
  bm25: number;
  /** 行区间（命中定位/展示） */
  lineStart: number | null;
  lineEnd: number | null;
  /** 观测时间（epoch ms；排序引擎新近度衰减用） */
  observedAt: number | null;
}

/** 中文/英文词法全文查询（预分词 MATCH；排序 bm25 升序）。空查询返回 []。
 *  matchMode：'and'（默认，全 token 命中——短关键词查询精确）/ 'or'（任一命中，
 *  bm25 排序——长自然语言问句由检索门面做 AND→OR 两段式兜底）。 */
export function searchChunksByFts(
  db: MemoryDb,
  queryText: string,
  limit = 20,
  matchMode: 'and' | 'or' = 'and'
): ChunkFtsHit[] {
  const expr = matchMode === 'or' ? ftsMatchExprAny(queryText) : ftsMatchExpr(queryText);
  if (!expr) return [];
  const rows = db.handle
    .prepare(
      `SELECT c.id, c.source_type, c.source_path, c.line_start, c.line_end, c.text, c.origin, c.task_id, c.repo_key, c.importance,
              c.observed_at, bm25(chunks_fts) AS bm25
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY bm25
       LIMIT ?`
    )
    .all(expr, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    sourceType: String(r.source_type),
    sourcePath: (r.source_path as string | null) ?? null,
    lineStart: r.line_start == null ? null : Number(r.line_start),
    lineEnd: r.line_end == null ? null : Number(r.line_end),
    text: String(r.text),
    origin: String(r.origin),
    taskId: (r.task_id as string | null) ?? null,
    repoKey: (r.repo_key as string | null) ?? null,
    importance: r.importance == null ? null : Number(r.importance),
    observedAt: r.observed_at == null ? null : Number(r.observed_at),
    bm25: Number(r.bm25)
  }));
}

/** 删除一个源文件的全部 chunk（重索引整文件替换用）；返回删除条数（含 FTS 索引行） */
export function deleteChunksBySource(
  db: MemoryDb,
  sourceType: ChunkSourceType,
  sourcePath: string
): number {
  return db.write((tx) => {
    const rows = tx
      .prepare(
        'SELECT id, fts FROM chunks WHERE source_type = ? AND source_path = ?'
      )
      .all(sourceType, sourcePath) as Array<{ id: number; fts: string }>;
    return purgeChunkRows(tx, rows);
  });
}

/** (lineStart, lineEnd, text) 迁移键：重索引整文件替换时对齐新旧 chunk */
function chunkMatchKey(lineStart: number | null, lineEnd: number | null, text: string): string {
  return `${lineStart ?? ''}|${lineEnd ?? ''}|${text}`;
}

/**
 * 整源替换（增量重索引）：删旧插新，并把 recall_stats / recalled_count /
 * last_recalled_at 按 (lineStart, lineEnd, text) 迁到新 chunk id；匹配不上的旧账同事务
 * 清掉（不堆孤儿）。信号门计数不因文件微调被清零。
 */
export function replaceChunksForSource(
  db: MemoryDb,
  sourceType: ChunkSourceType,
  sourcePath: string,
  inserts: Array<Omit<ChunkInsert, 'sourceType' | 'sourcePath'>>
): number[] {
  return db.write((tx) => {
    const oldRows = tx
      .prepare(
        `SELECT id, line_start, line_end, text, fts, recalled_count, last_recalled_at
         FROM chunks WHERE source_type = ? AND source_path = ?`
      )
      .all(sourceType, sourcePath) as Array<{
        id: number;
        line_start: number | null;
        line_end: number | null;
        text: string;
        fts: string;
        recalled_count: number;
        last_recalled_at: number | null;
      }>;
    const oldByKey = new Map<string, (typeof oldRows)[number]>();
    for (const r of oldRows) {
      const k = chunkMatchKey(r.line_start, r.line_end, r.text);
      if (!oldByKey.has(k)) oldByKey.set(k, r);
    }

    // 先删旧（recall_stats 暂留等迁移）；FTS 影子须带原文 token 回填 delete
    const delFts = tx.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, fts) VALUES ('delete', ?, ?)");
    const rm = tx.prepare('DELETE FROM chunks WHERE id = ?');
    for (const r of oldRows) {
      delFts.run(r.id, r.fts);
      rm.run(r.id);
    }

    const newIds: number[] = [];
    const matchedOldIds = new Set<number>();
    for (const rec of inserts) {
      const id = insertChunk(db, { ...rec, sourceType, sourcePath });
      newIds.push(id);
      const k = chunkMatchKey(rec.lineStart ?? null, rec.lineEnd ?? null, String(rec.text ?? ''));
      const old = oldByKey.get(k);
      if (old && !matchedOldIds.has(old.id)) {
        matchedOldIds.add(old.id);
        tx.prepare('UPDATE recall_stats SET chunk_id = ? WHERE chunk_id = ?').run(id, old.id);
        if (old.recalled_count > 0 || old.last_recalled_at != null) {
          tx.prepare('UPDATE chunks SET recalled_count = ?, last_recalled_at = ? WHERE id = ?').run(
            old.recalled_count,
            old.last_recalled_at,
            id
          );
        }
      }
    }
    const rmStats = tx.prepare('DELETE FROM recall_stats WHERE chunk_id = ?');
    for (const r of oldRows) {
      if (!matchedOldIds.has(r.id)) rmStats.run(r.id);
    }
    return newIds;
  });
}

/**
 * transcript chunk 滚动淘汰（memory-refactor B8 收尾：按 observed_at 保留窗清理）。
 * 只动 source_type='transcript'（策展/情景 markdown 是 canonical，永不淘汰）；
 * FTS 影子行随删（external content 表须显式 delete 指令）。返回删除条数。
 */
export function deleteTranscriptChunksBefore(db: MemoryDb, cutoffMs: number): number {
  return db.write((tx) => {
    const rows = tx
      .prepare(
        "SELECT id, fts FROM chunks WHERE source_type = 'transcript' AND observed_at IS NOT NULL AND observed_at < ?"
      )
      .all(cutoffMs) as Array<{ id: number; fts: string }>;
    return purgeChunkRows(tx, rows);
  });
}

/**
 * 库内已索引的**文件型**源集合（删除文件的 chunk 清理用）。
 * 只含 syncMemoryIndex 管理的 memory/journal/user_md/features；不含 transcript
 * （scheduler-session:*，滚动淘汰另管）与 staging（生命周期联动另管）——残留清理
 * 若把这两类当「文件残留」会每次 sync 误删（Lane2 转录面集成路径恒空）。
 */
export function listIndexedSourcePaths(db: MemoryDb): Array<{ sourceType: string; sourcePath: string }> {
  const rows = db.handle
    .prepare(
      `SELECT DISTINCT source_type, source_path FROM chunks
       WHERE source_path IS NOT NULL
         AND source_type IN ('memory','journal','user_md','features')`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    sourceType: String(r.source_type),
    sourcePath: String(r.source_path)
  }));
}

export function countChunks(db: MemoryDb): number {
  return Number((db.handle.prepare('SELECT count(*) n FROM chunks').get() as { n: number }).n);
}

// ---------------------------------------------------------------------------
// recall_stats（§5 溯源）：search_hit 落账 + chunk 召回计数（B3/B4 信号门消费）
// ---------------------------------------------------------------------------

export type RecallStatKind =
  | 'bootstrap'
  | 'brief_injected'
  | 'search_hit'
  | 'trigger_injected'
  | 'escalation_hit';

/** 记一笔召回并抬该 chunk 的召回计数（同事务）。relevance：该次命中的相关分
 *  （0–1；检索侧 finalScore 钳位——B4 信号门 Relevance 均值数据源；缺省 NULL=未记录）。 */
export function recordRecallStat(
  db: MemoryDb,
  chunkId: number,
  kind: RecallStatKind,
  queryText: string,
  ts: number,
  relevance?: number | null
): void {
  const rel =
    relevance != null && Number.isFinite(relevance)
      ? Math.max(0, Math.min(1, relevance))
      : null;
  db.write((tx) => {
    tx.prepare(
      'INSERT INTO recall_stats (chunk_id, kind, query_text, ts, relevance) VALUES (?, ?, ?, ?, ?)'
    ).run(chunkId, kind, queryText, ts, rel);
    tx.prepare(
      'UPDATE chunks SET recalled_count = recalled_count + 1, last_recalled_at = ? WHERE id = ?'
    ).run(ts, chunkId);
  });
}

/** 删除一条 staging 镜像 chunk（连 FTS 索引行与其 recall_stats 账目，同事务）；
 *  staging 生命周期联动（promoted/rejected/expired）与过期清扫的消费面。返回是否存在。 */
export function deleteStagingChunkByStagingId(db: MemoryDb, stagingId: number): boolean {
  return db.write((tx) => {
    const rows = tx
      .prepare('SELECT id, fts FROM chunks WHERE staging_id = ?')
      .all(stagingId) as Array<{ id: number; fts: string }>;
    if (!rows.length) return false;
    purgeChunkRows(tx, rows);
    return true;
  });
}

// ---------------------------------------------------------------------------
// recall_stats 聚合（记忆面板条目 4A：召回热度上条目卡的数据面）
// ---------------------------------------------------------------------------

export interface RecallStatAggregateRow {
  chunkId: number;
  kind: RecallStatKind;
  /** 窗口内该 kind 的次数 */
  count: number;
  /** 窗口内该 kind 最近一次时间（epoch ms） */
  lastTs: number;
}

/**
 * 召回按 chunk×kind 聚合（只扫时间窗，不扫全表；条目 4A「近 30 天注入/命中」）。
 * chunk↔条目映射沿继 indexer 整源替换的既有 recall_stats 迁移机制
 * （replaceChunksForSource 内 UPDATE recall_stats SET chunk_id=?，正文编辑换行不断账），
 * 本函数只出聚合；条目归并在 center 层做。
 */
export function aggregateRecallStats(
  db: MemoryDb,
  sinceTs: number,
  kinds?: ReadonlyArray<RecallStatKind>
): RecallStatAggregateRow[] {
  const clauses = ['ts > ?'];
  const args: Array<string | number | null> = [sinceTs];
  if (kinds && kinds.length) {
    clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    args.push(...kinds);
  }
  const rows = db.handle
    .prepare(
      `SELECT chunk_id, kind, count(*) n, max(ts) last_ts
       FROM recall_stats WHERE ${clauses.join(' AND ')}
       GROUP BY chunk_id, kind`
    )
    .all(...args) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    chunkId: Number(r.chunk_id),
    kind: String(r.kind) as RecallStatKind,
    count: Number(r.n),
    lastTs: Number(r.last_ts)
  }));
}

/** 测试/诊断辅助：列出库内全部用户表名（含 FTS5 虚拟表本体，滤掉其影子表/内部表） */
export function listTableNames(db: MemoryDb): string[] {
  const rows = db.handle
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows
    .map((r) => r.name)
    .filter((n) => !n.startsWith('chunks_fts_') && !n.startsWith('sqlite_'));
}

// ---------------------------------------------------------------------------
// preimages / approvals / consolidation_log（§4.2 P3 巩固批访问器）
// ---------------------------------------------------------------------------

export interface PreimageInsert {
  filePath: string;
  content: string;
  contentHash: string;
  cause?: string | null;
  now: number;
}

/** 策展核心改写前全文镜像（面板回收站/回滚用；cause 记发起来源） */
export function insertPreimage(db: MemoryDb, rec: PreimageInsert): number {
  const info = db.write((tx) =>
    tx
      .prepare(
        'INSERT INTO preimages (file_path, content, content_hash, cause, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(rec.filePath, rec.content, rec.contentHash, rec.cause ?? null, rec.now)
  );
  return Number(info.lastInsertRowid);
}

export interface ApprovalRow {
  id: number;
  action: string;
  payload: string;
  confidence: number | null;
  state: string;
  createdAt: number;
  decidedAt: number | null;
}

function mapApprovalRow(r: Record<string, unknown>): ApprovalRow {
  return {
    id: Number(r.id),
    action: String(r.action),
    payload: String(r.payload ?? ''),
    confidence: r.confidence == null ? null : Number(r.confidence),
    state: String(r.state),
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at == null ? null : Number(r.decided_at)
  };
}

export function insertApproval(
  db: MemoryDb,
  rec: { action: 'promote' | 'supersede' | 'delete' | 'user_md_change'; payload: string; confidence?: number | null; now: number }
): number {
  const info = db.write((tx) =>
    tx
      .prepare('INSERT INTO approvals (action, payload, confidence, state, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(rec.action, rec.payload, rec.confidence ?? null, 'pending', rec.now)
  );
  return Number(info.lastInsertRowid);
}

export function getApproval(db: MemoryDb, id: number): ApprovalRow | null {
  const row = db.handle.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapApprovalRow(row) : null;
}

export function listApprovals(db: MemoryDb, state?: string): ApprovalRow[] {
  const rows = (
    state
      ? db.handle.prepare('SELECT * FROM approvals WHERE state = ? ORDER BY id').all(state)
      : db.handle.prepare('SELECT * FROM approvals ORDER BY id').all()
  ) as Array<Record<string, unknown>>;
  return rows.map(mapApprovalRow);
}

/** 审批裁决落库（pending → approved/rejected；非 pending 或不存在返回 false） */
export function decideApprovalRow(
  db: MemoryDb,
  id: number,
  state: 'approved' | 'rejected',
  now: number
): boolean {
  const info = db.write((tx) =>
    tx
      .prepare("UPDATE approvals SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'")
      .run(state, now, id)
  );
  return Number(info.changes) > 0;
}

// ---------------------------------------------------------------------------
// approval_exec（2026-10-02 审计 M1：审批执行日志——claim/file_applied 恢复协议）
// ---------------------------------------------------------------------------

export type ApprovalExecPhase = 'claimed' | 'file_applied' | 'failed';

export interface ApprovalExecRow {
  approvalId: number;
  phase: ApprovalExecPhase;
  attempt: number;
  baseHash: string;
  plannedHash: string;
  plannedContent: string;
  settleJson: string;
  error: string | null;
  claimedAt: number;
  updatedAt: number;
}

function mapApprovalExecRow(r: Record<string, unknown>): ApprovalExecRow {
  return {
    approvalId: Number(r.approval_id),
    phase: String(r.phase) as ApprovalExecPhase,
    attempt: Number(r.attempt),
    baseHash: String(r.base_hash ?? ''),
    plannedHash: String(r.planned_hash ?? ''),
    plannedContent: String(r.planned_content ?? ''),
    settleJson: String(r.settle_json ?? ''),
    error: r.error == null ? null : String(r.error),
    claimedAt: Number(r.claimed_at),
    updatedAt: Number(r.updated_at)
  };
}

export function getApprovalExec(db: MemoryDb, approvalId: number): ApprovalExecRow | null {
  const row = db.handle.prepare('SELECT * FROM approval_exec WHERE approval_id = ?').get(approvalId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapApprovalExecRow(row) : null;
}

/** 领取执行（首次 claim 或 attempt+1 续领；整体替换日志行）。仅供协调器在同事务内调用 */
export function upsertApprovalExecClaim(
  db: MemoryDb,
  rec: {
    approvalId: number;
    attempt: number;
    baseHash: string;
    plannedHash: string;
    plannedContent: string;
    settleJson: string;
    now: number;
  }
): void {
  db.write((tx) => {
    tx.prepare(
      `INSERT INTO approval_exec (approval_id, phase, attempt, base_hash, planned_hash, planned_content, settle_json, error, claimed_at, updated_at)
       VALUES (?, 'claimed', ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(approval_id) DO UPDATE SET
         phase = 'claimed', attempt = excluded.attempt, base_hash = excluded.base_hash,
         planned_hash = excluded.planned_hash, planned_content = excluded.planned_content,
         settle_json = excluded.settle_json, error = NULL,
         claimed_at = excluded.claimed_at, updated_at = excluded.updated_at`
    ).run(
      rec.approvalId,
      rec.attempt,
      rec.baseHash,
      rec.plannedHash,
      rec.plannedContent,
      rec.settleJson,
      rec.now,
      rec.now
    );
  });
}

/**
 * **原子领取（CAS，生产唯一入口；r1 审查 P1-1 / r2 审查 P1-①）**：检查与写入同一条
 * upsert，且**同一事务内核验审批仍 pending**（EXISTS 子查询）——两连接初检 pending 后
 * 一方驳回、另一方 approve 时，后者领取必然失败，不会再写正文。只有以下情况可领取，
 * 否则 0 变更（返回 false）：
 * - 无既有行（首次）且审批 pending；
 * - phase='failed'（上次已释放）且审批 pending；
 * - phase='claimed' 且 claimed_at 早于 staleBefore（过期接管）且审批 pending；
 * - 且新 attempt **严格大于**既有 attempt（两进程同时领取只成一方）。
 * phase='file_applied' 永不可领取（只允许恢复收尾）。
 */
export function claimApprovalExecRow(
  db: MemoryDb,
  rec: {
    approvalId: number;
    attempt: number;
    baseHash: string;
    plannedHash: string;
    plannedContent: string;
    settleJson: string;
    /** 过期接管判定线（= now - APPROVAL_EXEC_STALE_MS）：claimed_at 早于该值可接管 */
    staleBefore: number;
    now: number;
  }
): boolean {
  // BEGIN IMMEDIATE 写事务内核验审批 pending + CAS 领取（两语句同事务 = 原子；
  // 不用 INSERT...SELECT...ON CONFLICT 的单语句形态——该组合在 SQLite 有解析歧义）
  return db.write((tx) => {
    const pending = tx
      .prepare("SELECT 1 FROM approvals WHERE id = ? AND state = 'pending'")
      .get(rec.approvalId);
    if (!pending) return false;
    const info = tx
      .prepare(
        `INSERT INTO approval_exec (approval_id, phase, attempt, base_hash, planned_hash, planned_content, settle_json, error, claimed_at, updated_at)
         VALUES (?, 'claimed', ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(approval_id) DO UPDATE SET
           phase = 'claimed', attempt = excluded.attempt, base_hash = excluded.base_hash,
           planned_hash = excluded.planned_hash, planned_content = excluded.planned_content,
           settle_json = excluded.settle_json, error = NULL,
           claimed_at = excluded.claimed_at, updated_at = excluded.updated_at
         WHERE approval_exec.attempt < ?
           AND (approval_exec.phase = 'failed'
                OR (approval_exec.phase = 'claimed' AND approval_exec.claimed_at <= ?))`
      )
      .run(
        rec.approvalId,
        rec.attempt,
        rec.baseHash,
        rec.plannedHash,
        rec.plannedContent,
        rec.settleJson,
        rec.now,
        rec.now,
        rec.attempt,
        rec.staleBefore
      );
    return Number(info.changes) > 0;
  });
}

export function markApprovalExecFileApplied(
  db: MemoryDb,
  approvalId: number,
  settleJson: string,
  now: number,
  opts?: { attempt?: number }
): boolean {
  const info = db.write((tx) =>
    tx.prepare(
      opts?.attempt != null
        ? `UPDATE approval_exec SET phase = 'file_applied', settle_json = ?, updated_at = ?
           WHERE approval_id = ? AND attempt = ? AND phase = 'claimed'`
        : `UPDATE approval_exec SET phase = 'file_applied', settle_json = ?, updated_at = ? WHERE approval_id = ?`
    ).run(
      ...(opts?.attempt != null ? [settleJson, now, approvalId, opts.attempt] : [settleJson, now, approvalId])
    )
  );
  return Number(info.changes) > 0;
}

/** 执行失败释放（审批保持 pending，可重试重规划）；error 留诊断 */
/** 执行失败释放（审批保持 pending，可重试重规划）；error 留诊断。opts.attempt 带上时
 *  只释放自己领取的那一行（防误释放接管者的新领取）。 */
export function markApprovalExecFailed(
  db: MemoryDb,
  approvalId: number,
  error: string,
  now: number,
  opts?: { attempt?: number }
): void {
  db.write((tx) =>
    tx.prepare(
      opts?.attempt != null
        ? `UPDATE approval_exec SET phase = 'failed', error = ?, updated_at = ?
           WHERE approval_id = ? AND attempt = ? AND phase = 'claimed'`
        : `UPDATE approval_exec SET phase = 'failed', error = ?, updated_at = ? WHERE approval_id = ?`
    ).run(
      ...(opts?.attempt != null ? [error, now, approvalId, opts.attempt] : [error, now, approvalId])
    )
  );
}

export interface ConsolidationLogInsert {
  triggerSource: string | null;
  addedCount: number;
  mergedCount: number;
  supersededCount: number;
  diffSummary?: string | null;
  /** 拒绝分类计数（{ambiguous:2, over_budget:1, …}；JSON 字符串） */
  rejectedCounts?: string | null;
  /** 条目 2A 明细 payload（applied/supersededPairs/rejected；JSON 字符串；缺省 NULL=无明细，
   *  旧记录/错误兜底路径兼容——读取端宽容形状，写入端收口见 apply.buildConsolidationLogPayload） */
  payload?: string | null;
  startedAt?: number | null;
  now: number;
}

export function insertConsolidationLog(db: MemoryDb, rec: ConsolidationLogInsert): number {
  const info = db.write((tx) =>
    tx
      .prepare(
        `INSERT INTO consolidation_log (trigger_source, added_count, merged_count, superseded_count, diff_summary, rejected_counts, payload, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.triggerSource ?? null,
        rec.addedCount,
        rec.mergedCount,
        rec.supersededCount,
        rec.diffSummary ?? null,
        rec.rejectedCounts ?? null,
        rec.payload ?? null,
        rec.startedAt ?? rec.now,
        rec.now
      )
  );
  return Number(info.lastInsertRowid);
}

export interface ConsolidationLogRow {
  id: number;
  triggerSource: string | null;
  addedCount: number;
  mergedCount: number;
  supersededCount: number;
  diffSummary: string | null;
  rejectedCounts: string | null;
  /** 明细 payload 原文（JSON 字符串；v4 前的旧行/兜底行为 null） */
  payload: string | null;
  startedAt: number | null;
  finishedAt: number;
}

/** 巩固历史（面板「晋升审阅」读；新→旧） */
export function listConsolidationLog(db: MemoryDb, limit = 50): ConsolidationLogRow[] {
  const rows = db.handle
    .prepare('SELECT * FROM consolidation_log ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    triggerSource: (r.trigger_source as string | null) ?? null,
    addedCount: Number(r.added_count),
    mergedCount: Number(r.merged_count),
    supersededCount: Number(r.superseded_count),
    diffSummary: (r.diff_summary as string | null) ?? null,
    rejectedCounts: (r.rejected_counts as string | null) ?? null,
    payload: (r.payload as string | null) ?? null,
    startedAt: r.started_at == null ? null : Number(r.started_at),
    finishedAt: Number(r.finished_at)
  }));
}
