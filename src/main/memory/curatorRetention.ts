import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeEvidence, KnowledgeRecord } from '../../shared/knowledge';
import type { KnowledgeStore } from './knowledgeStore';

const DAY = 86_400_000;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const table = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const exists = (db: DatabaseSync, sql: string, ...args: Array<string | number>): boolean => !!db.prepare(sql).get(...args);
const bounded = (value: number | undefined, fallback: number, maximum: number): number => Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value!))) : fallback;

export interface CuratorRetentionOptions {
  now?: number;
  /** Mutation and scan limits per call; zero disables that domain. */
  maxRecords?: number;
  maxEvents?: number;
  maxDurationMs?: number;
  /** Durable retention receipts are append-only audit identities. Cap their
   * physical footprint instead of deleting rows that may be needed for
   * replay/idempotency checks. A full budget stops this batch and is visible
   * to the caller so an operator can inspect or raise the bound. */
  maxRetentionBytes?: number;
  maxRetentionEntries?: number;
  /** Maximum old activity rows to drop from the disposable event stream. */
  maxActivityEventRows?: number;
  /** Caller supplies all live queue/knowledge DBs in a consistent order. Guards are locked, never mutated. */
  guardDatabases?: readonly DatabaseSync[];
  /** Host lifecycle/generation guard. Throwing at any point rolls back the whole maintenance batch. */
  assertIdle?: () => void;
}
export interface CuratorRetentionResult {
  blocked?: string;
  records: string[];
  events: string[];
  skipped: Array<{ domain: 'record' | 'event'; id: string; reason: string }>;
  scannedRecords: number;
  scannedEvents: number;
  retentionBytes?: number;
  retentionEntries?: number;
  compactedActivityEvents?: number;
}

function idleReason(db: DatabaseSync, now: number): string | undefined {
  if (table(db, 'leases') && exists(db, 'SELECT 1 FROM leases WHERE expires>? LIMIT 1', now)) return 'active-lease';
  if (table(db, 'source_events') && exists(db, "SELECT 1 FROM source_events WHERE state='running' AND lease_until>? LIMIT 1", now)) return 'active-source-claim';
  if (table(db, 'candidates') && exists(db, "SELECT 1 FROM candidates WHERE state='running' AND lease_until>? LIMIT 1", now)) return 'active-curator-claim';
  if (table(db, 'outbox') && exists(db, 'SELECT 1 FROM outbox LIMIT 1')) return 'projection-recovery';
  if (table(db, 'approval_exec') && exists(db, "SELECT 1 FROM approval_exec WHERE phase IN ('claimed','file_applied') LIMIT 1")) return 'legacy-recovery';
  return undefined;
}

/** Unknown references are retained conservatively. No version, deletion or governance row is removed. */
function recoveryReference(db: DatabaseSync, id: string, domain: 'record' | 'event'): string | undefined {
  if (table(db, 'knowledge_deleted') && exists(db, 'SELECT 1 FROM knowledge_deleted WHERE id=? LIMIT 1', id)) return 'user-deletion';
  if (table(db, 'versions') && exists(db, 'SELECT 1 FROM versions v,json_tree(v.payload) j WHERE j.type=\'text\' AND j.value=? LIMIT 1', id)) return 'restorable-version';
  if (table(db, 'governance') && exists(db, `SELECT 1 FROM governance g WHERE
    EXISTS(SELECT 1 FROM json_tree(g.receipt) WHERE type='text' AND value=?) OR
    EXISTS(SELECT 1 FROM json_tree(g.before_json) WHERE type='text' AND value=?) OR
    EXISTS(SELECT 1 FROM json_tree(g.after_json) WHERE type='text' AND value=?) LIMIT 1`, id, id, id)) return 'governance-audit';
  if (table(db, 'curator_receipts') && exists(db, `SELECT 1 FROM curator_receipts r WHERE
    EXISTS(SELECT 1 FROM json_tree(r.receipt) WHERE type='text' AND value=?) OR
    EXISTS(SELECT 1 FROM json_tree(r.before_json) WHERE type='text' AND value=?) OR
    EXISTS(SELECT 1 FROM json_tree(r.after_json) WHERE type='text' AND value=?) LIMIT 1`, id, id, id)) return 'curator-audit';
  if (table(db, 'candidates') && exists(db, "SELECT 1 FROM candidates c,json_tree(c.payload) j WHERE c.state!='done' AND j.type='text' AND j.value=? LIMIT 1", id)) return 'unfinished-candidate';
  if (table(db, 'checkpoints') && exists(db, 'SELECT 1 FROM checkpoints WHERE id!=? AND instr(value,?)>0 LIMIT 1', `review:${id}`, id)) return 'checkpoint-recovery';
  if (domain === 'record') {
    if (table(db, 'relations') && exists(db, 'SELECT 1 FROM relations WHERE source_id=? OR target_id=? LIMIT 1', id, id)) return 'relationship';
    if (table(db, 'records') && exists(db, "SELECT 1 FROM records r,json_tree(r.payload) j WHERE r.id!=? AND j.type='text' AND j.value=? LIMIT 1", id, id)) return 'knowledge-reference';
    if (table(db, 'source_events') && exists(db, "SELECT 1 FROM source_events s,json_tree(s.payload) j WHERE s.state!='done' AND j.type='text' AND j.value=? LIMIT 1", id)) return 'unfinished-source';
  }
  return undefined;
}

function evidenceIdentity(evidence: KnowledgeEvidence): Record<string, unknown> {
  const keys = ['id', 'source', 'eventTime', 'sessionId', 'turnId', 'snapshotId', 'repoKey', 'branch', 'path', 'verification', 'observation', 'contentHash'] as const;
  return Object.fromEntries(keys.filter(key => evidence[key] !== undefined).map(key => [key, evidence[key]]));
}

function sourceReferences(databases: readonly DatabaseSync[], id: string): KnowledgeRecord[] {
  const records: KnowledgeRecord[] = [];
  for (const db of databases) {
    if (!table(db, 'records')) continue;
    const rows = db.prepare("SELECT r.payload FROM records r WHERE EXISTS(SELECT 1 FROM json_each(json_extract(r.payload,'$.evidence')) e WHERE json_extract(e.value,'$.id')=?) LIMIT 33").all(id) as Array<{ payload: string }>;
    for (const row of rows) records.push(JSON.parse(row.payload) as KnowledgeRecord);
    if (records.length > 32) break;
  }
  return records;
}

/**
 * Bounded safe TTL maintenance with explicit audit and activity budgets.
 * Only unreferenced ledger-only history is removed. Historical versions, governance/curator
 * receipts and deletion tombstones remain intact and protect their dependencies.
 * Completed legacy source bodies are replaced by an identity stub; their original id/hash/state
 * remain in source_events so the old enqueue path still rejects/reuses the same event identity.
 * Live curator/other namespace DBs must be included in guardDatabases by the host caller.
 */
export function pruneCuratorRetention(store: Pick<KnowledgeStore, 'db'>, options: CuratorRetentionOptions = {}): CuratorRetentionResult {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Invalid memory retention time');
  const maxRecords = bounded(options.maxRecords, 25, 100), maxEvents = bounded(options.maxEvents, 25, 100);
  const maxRetentionBytes = bounded(options.maxRetentionBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
  const maxRetentionEntries = bounded(options.maxRetentionEntries, 10_000, 100_000);
  const maxActivityEventRows = bounded(options.maxActivityEventRows, 500, 5_000);
  const duration = Math.max(1, bounded(options.maxDurationMs, 50, 1000)), started = Date.now();
  const db = store.db, databases = [...new Set([...(options.guardDatabases ?? []), db])];
  const locked: DatabaseSync[] = [];
  const timeouts=new Map<DatabaseSync,number>();
  let failed = false, originalError: unknown;
  const result: CuratorRetentionResult = { records: [], events: [], skipped: [], scannedRecords: 0, scannedEvents: 0 };
  const assertIdle = (): void => { options.assertIdle?.(); };
  const skip = (domain: 'record' | 'event', id: string, reason: string): void => { result.skipped.push({ domain, id, reason }); };
  try {
    // A caller must not invoke this within another transaction. Guard write locks prevent a
    // different process from claiming queue work between the idle check and the ledger commit.
    for (const database of databases) {
      const timeout=Number((database.prepare('PRAGMA busy_timeout').get() as {timeout:number}).timeout);
      timeouts.set(database,Number.isFinite(timeout)?timeout:5000);database.exec('PRAGMA busy_timeout=0');
      try{database.exec('BEGIN IMMEDIATE');locked.push(database);}
      catch(error){if(/database (?:is )?(?:locked|busy)|SQLITE_BUSY/i.test(String(error))){result.blocked='database-busy';return result;}throw error;}
    }
    assertIdle();
    for (const database of databases) { const reason = idleReason(database, now); if (reason) { result.blocked = reason; return result; } }
    db.exec(`CREATE TABLE IF NOT EXISTS curator_retention(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,retired_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS curator_retention_progress(kind TEXT PRIMARY KEY,cursor TEXT NOT NULL);`);
    const progress = (kind: string): string => (db.prepare('SELECT cursor FROM curator_retention_progress WHERE kind=?').get(kind) as { cursor: string } | undefined)?.cursor ?? '';
    const saveProgress = (kind: string, cursor: string): void => { db.prepare('INSERT OR REPLACE INTO curator_retention_progress VALUES(?,?)').run(kind, cursor); };
    let retentionBytes = Number((db.prepare("SELECT COALESCE(SUM(length(CAST(payload AS BLOB)) + length(CAST(id AS BLOB)) + 32),0) AS bytes FROM curator_retention").get() as { bytes: number }).bytes);
    let retentionEntries = Number((db.prepare('SELECT COUNT(*) AS count FROM curator_retention').get() as { count: number }).count);
    const remember = (kind: string, id: string, payload: unknown): boolean => {
      const encoded = JSON.stringify(payload), bytes = Buffer.byteLength(encoded, 'utf8') + Buffer.byteLength(id, 'utf8') + 32;
      if (retentionEntries >= maxRetentionEntries || retentionBytes + bytes > maxRetentionBytes) return false;
      db.prepare('INSERT INTO curator_retention VALUES(?,?,?,?)').run(kind, id, encoded, now);
      retentionEntries++; retentionBytes += bytes; return true;
    };
    let budgetReached = false;
    if (maxRecords) {
      const rows = db.prepare(`SELECT id,payload FROM records WHERE id>? AND json_extract(payload,'$.kind')='task_fact'
        AND json_extract(payload,'$.status')='archived' AND json_extract(payload,'$.expiresAt')<=? ORDER BY id LIMIT ?`).all(progress('record'), now, maxRecords) as Array<{ id: string; payload: string }>;
      let cursor = '', scanned = 0;
      for (const row of rows) {
        if (Date.now() - started >= duration) break;
        assertIdle();
        const previousCursor = cursor, previousScanned = scanned;
        cursor = row.id; scanned++; result.scannedRecords++;
        const record = JSON.parse(row.payload) as KnowledgeRecord;
        const storage = db.prepare('SELECT mode FROM record_storage WHERE id=?').get(row.id) as { mode: string } | undefined;
        if (storage?.mode !== 'ledger-only') { skip('record', row.id, 'projected-record'); continue; }
        if (record.history?.length) { skip('record', row.id, 'revision-history'); continue; }
        const dependency = databases.map(database => recoveryReference(database, row.id, 'record')).find(Boolean);
        if (dependency) { skip('record', row.id, dependency); continue; }
        if (!remember('record', row.id, { id: row.id, revision: record.revision, namespace: record.namespace, kind: record.kind,
          repoKey: record.repoKey, branch: record.branch, taskId: record.taskId, expiresAt: record.expiresAt,
          createdAt: record.createdAt, updatedAt: record.updatedAt, payloadHash: hash(row.payload), evidence: record.evidence.map(evidenceIdentity) })) {
          cursor = previousCursor; scanned = previousScanned; result.scannedRecords--; budgetReached = true; break;
        }
        db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(row.id);
        db.prepare('DELETE FROM relations WHERE source_id=? OR target_id=?').run(row.id, row.id);
        db.prepare('DELETE FROM records WHERE id=?').run(row.id);
        if (table(db, 'knowledge_hot')) db.prepare('DELETE FROM knowledge_hot WHERE id=?').run(row.id);
        db.prepare('DELETE FROM record_storage WHERE id=?').run(row.id);
        result.records.push(row.id);
      }
      if (scanned) saveProgress('record', scanned === rows.length && rows.length < maxRecords ? '' : cursor);
      else if (!rows.length) saveProgress('record', '');
    }
    if (!budgetReached && maxEvents && table(db, 'source_events') && Date.now() - started < duration) {
      const columns = new Set((db.prepare('PRAGMA table_info(source_events)').all() as Array<{ name: string }>).map(column => column.name));
      const optional = ['prepared', 'extracted', 'timings'].filter(column => columns.has(column));
      const rows = db.prepare(`SELECT id,payload,hash,created_at${optional.map(column => `,${column}`).join('')} FROM source_events
        WHERE id>? AND state='done' AND claim IS NULL AND lease_until IS NULL AND created_at<=? AND NOT EXISTS(SELECT 1 FROM curator_retention t WHERE t.kind='event' AND t.id=source_events.id)
        ORDER BY id LIMIT ?`).all(progress('event'), now - 90 * DAY, maxEvents) as Array<{ id: string; payload: string; hash: string; created_at: number; prepared?: string | null; extracted?: string | null; timings?: string | null }>;
      let cursor = '', scanned = 0;
      for (const row of rows) {
        if (Date.now() - started >= duration) break;
        assertIdle();
        const previousCursor = cursor, previousScanned = scanned;
        cursor = row.id; scanned++; result.scannedEvents++;
        const dependency = databases.map(database => recoveryReference(database, row.id, 'event')).find(Boolean);
        if (dependency) { skip('event', row.id, dependency); continue; }
        const references = sourceReferences(databases, row.id);
        if (references.length > 32 || references.some(record => record.status !== 'active' || record.kind === 'task_fact')) { skip('event', row.id, 'knowledge-recovery'); continue; }
        const source = JSON.parse(row.payload) as { id: string; namespace?: string; origin?: string; text?: string; evidence?: KnowledgeEvidence; repoKey?: string; branch?: string; taskId?: string };
        if (source.id !== row.id || typeof source.text !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)) { skip('event', row.id, 'unknown-source-format'); continue; }
        const review = (db.prepare('SELECT value FROM checkpoints WHERE id=?').get(`review:${row.id}`) as { value: string } | undefined)?.value;
        const decisions = review ? JSON.parse(review) as Array<{ index: number; verdict: string; sourceQuote: string; reason: string; existingId?: string }> : [];
        if (!Array.isArray(decisions) || decisions.length > 4 || decisions.some(decision => typeof decision.sourceQuote !== 'string' || decision.sourceQuote.length > 2048)) { skip('event', row.id, 'review-evidence-budget'); continue; }
        const excerpts = references.flatMap(record => record.evidence.filter(evidence => evidence.id === row.id && evidence.excerpt).map(evidence => ({ recordId: record.id, revision: record.revision, ...evidenceIdentity(evidence), excerpt: evidence.excerpt })));
        if (references.length && !excerpts.length && !decisions.some(decision => !!decision.sourceQuote)) { skip('event', row.id, 'missing-source-excerpt'); continue; }
        if (JSON.stringify(excerpts).length + JSON.stringify(decisions).length > 16_384) { skip('event', row.id, 'source-evidence-budget'); continue; }
        if (!remember('event', row.id, { id: row.id, hash: row.hash, payloadHash: hash(row.payload), createdAt: row.created_at,
          namespace: source.namespace, origin: source.origin, evidence: source.evidence ? evidenceIdentity(source.evidence) : undefined,
          references: references.map(record => ({ id: record.id, revision: record.revision })), excerpts, review: decisions,
          reviewHash: review ? hash(review) : undefined,
          ...Object.fromEntries(optional.map(column => [column + 'Hash', row[column as 'prepared' | 'extracted' | 'timings'] ? hash(row[column as 'prepared' | 'extracted' | 'timings']!) : null])) })) {
          cursor = previousCursor; scanned = previousScanned; result.scannedEvents--; budgetReached = true; break;
        }
        const payload = JSON.stringify({ id: row.id, text: '', namespace: source.namespace, origin: source.origin,
          repoKey: source.repoKey, branch: source.branch, taskId: source.taskId,
          evidence: source.evidence ? evidenceIdentity(source.evidence) : undefined, retention: { payloadHash: hash(row.payload), retiredAt: now } });
        db.prepare(`UPDATE source_events SET payload=?${optional.map(column => `,${column}=NULL`).join('')} WHERE id=? AND state='done' AND hash=?`).run(payload, row.id, row.hash);
        db.prepare('DELETE FROM checkpoints WHERE id=?').run(`review:${row.id}`);
        result.events.push(row.id);
      }
      if (scanned) saveProgress('event', scanned === rows.length && rows.length < maxEvents ? '' : cursor);
      else if (!rows.length) saveProgress('event', '');
    }
    if (maxActivityEventRows && table(db, 'events') && Date.now() - started < duration) {
      // Activity is a disposable projection used for the recent activity panel
      // and seven-day counters. Governance, versions, deletion markers and
      // curator receipts remain untouched and continue to carry audit history.
      const cutoff = now - 90 * DAY;
      const old = db.prepare('SELECT id FROM events WHERE at<? ORDER BY at ASC,id ASC LIMIT ?').all(cutoff, maxActivityEventRows) as Array<{ id: number }>;
      let compacted = 0;
      for (const row of old) {
        if (Date.now() - started >= duration) break;
        assertIdle();
        compacted += Number(db.prepare('DELETE FROM events WHERE id=? AND at<?').run(row.id, cutoff).changes);
      }
      result.compactedActivityEvents = compacted;
    }
    if (budgetReached) result.blocked = 'retention-budget';
    result.retentionBytes = retentionBytes; result.retentionEntries = retentionEntries;
    assertIdle();
    for (const database of databases) { const reason = idleReason(database, now); if (reason) throw new Error(`Memory retention lost its idle window: ${reason}`); }
    db.exec('COMMIT'); locked.splice(locked.indexOf(db), 1);
    // A maintenance batch is the only writer window. Checkpoint opportunistically
    // after commit so the WAL cannot grow with every bounded batch. A concurrent
    // reader may keep the WAL live, which is safe and reported as a best effort.
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (error) {
      if (!/SQLITE_BUSY|database .*?(?:locked|busy)/i.test(String(error))) throw error;
    }
    return result;
  } catch (error) {
    failed = true; originalError = error; throw error;
  } finally {
    // Guard DBs contain no writes. A blocked/throwing batch also rolls back payloads, tombstones
    // and cursors together, so retry after interruption starts from the same durable boundary.
    const cleanupErrors: unknown[] = [];
    for (const database of locked.reverse()) { try { database.exec('ROLLBACK'); } catch (error) { cleanupErrors.push(error); } }
    for(const [database,timeout] of timeouts){try{database.exec(`PRAGMA busy_timeout=${timeout}`);}catch(error){cleanupErrors.push(error);}}
    if (cleanupErrors.length) throw new AggregateError(failed ? [originalError, ...cleanupErrors] : cleanupErrors, 'Memory retention transaction cleanup failed');
  }
}
