import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';

type Context = Readonly<{ sessionId: string; taskId: string; source: string; action: string; target: string }>;
type Result = { outcome: 'known'; value: unknown } | { outcome: 'unknown' };
type Row = { sequence: number; id: string; task_id: string; source: string; action: string; target: string;
  created_at: number; state: 'pending' | 'dispatched' | 'result' | 'delivered'; result: string | null };
const retention = 24 * 60 * 60 * 1000;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Reject values JSON would silently coerce, omit or detach from their original structure. */
function assertJsonResult(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 100000 || depth > 128) throw new Error('Invalid outbox result');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) continue;
    if (typeof value !== 'object' || seen.has(value)) throw new Error('Invalid outbox result');
    seen.add(value);
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('Invalid outbox result');
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
    if (array && (keys.length !== value.length + 1 || !keys.includes('length'))) throw new Error('Invalid outbox result');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error('Invalid outbox result');
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid outbox result');
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

/** Host-only durable primitives. This class does not itself dispatch or deliver a tool call. */
export class WriteOutbox {
  private readonly db: DatabaseSync;
  constructor(file: string, private readonly now: () => number = Date.now) {
    if (file !== ':memory:' && !path.isAbsolute(file)) throw new Error('Outbox path must be absolute');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(sqliteFilePath(file));
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS write_outbox (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL,
          task_id TEXT NOT NULL, source TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
          created_at INTEGER NOT NULL, state TEXT NOT NULL, result TEXT, delivered_at INTEGER,
          resolution TEXT, resolution_audit TEXT);
        CREATE INDEX IF NOT EXISTS write_outbox_session ON write_outbox(session_hash, sequence);
        CREATE INDEX IF NOT EXISTS write_outbox_task ON write_outbox(session_hash, task_id);
        CREATE TABLE IF NOT EXISTS write_outbox_receipts (
          receipt_hash TEXT PRIMARY KEY, invocation_id TEXT NOT NULL REFERENCES write_outbox(id) ON DELETE CASCADE);`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const columns = this.db.prepare('PRAGMA table_info(write_outbox)').all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === 'resolution')) this.db.exec('ALTER TABLE write_outbox ADD COLUMN resolution TEXT');
        if (!columns.some(column => column.name === 'resolution_audit')) this.db.exec('ALTER TABLE write_outbox ADD COLUMN resolution_audit TEXT');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }

  private identity(value: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('Invalid outbox identity');
  }
  private time(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid outbox time');
    return value;
  }
  private row(sessionId: string, id: string): Row | undefined {
    this.identity(sessionId); this.identity(id);
    return this.db.prepare('SELECT sequence, id, task_id, source, action, target, created_at, state, result FROM write_outbox WHERE session_hash = ? AND id = ?')
      .get(digest(sessionId), id) as Row | undefined;
  }
  private view(row: Row) {
    if (!['pending', 'dispatched', 'result', 'delivered'].includes(row.state)) throw new Error('Invalid outbox state');
    if ((row.state === 'result' || row.state === 'delivered') !== (row.result !== null)) throw new Error('Invalid outbox result state');
    let result: Result | undefined;
    if (row.result !== null) {
      result = JSON.parse(row.result) as Result;
      if (!result || (result.outcome !== 'known' && result.outcome !== 'unknown') ||
          (result.outcome === 'known' && !Object.hasOwn(result, 'value')) ||
          (result.outcome === 'unknown' && Object.hasOwn(result, 'value')) ||
          Object.keys(result).some(key => !['outcome', 'value'].includes(key))) throw new Error('Invalid outbox result');
    }
    return { sequence: row.sequence, id: row.id, taskId: row.task_id, source: row.source, action: row.action,
      target: row.target, createdAt: row.created_at, state: row.state,
      ...(result === undefined ? {} : { result }) };
  }

  /** Mint an ID at the host boundary. Context must be supplied by the host, not the model. */
  create(context: Context): string {
    if (!context || Object.keys(context).sort().join(',') !== 'action,sessionId,source,target,taskId') throw new Error('Invalid outbox context');
    for (const value of Object.values(context)) this.identity(value);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO write_outbox(id, session_hash, task_id, source, action, target, created_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, digest(context.sessionId), context.taskId, context.source, context.action, context.target, this.time());
    return id;
  }
  markDispatched(sessionId: string, id: string): void {
    this.identity(sessionId); this.identity(id);
    const result = this.db.prepare("UPDATE write_outbox SET state = 'dispatched' WHERE session_hash = ? AND id = ? AND state = 'pending'")
      .run(digest(sessionId), id);
    if (Number(result.changes) !== 1) throw new Error('Outbox state does not permit dispatch');
  }
  complete(sessionId: string, id: string, result: Result): void {
    this.identity(sessionId); this.identity(id);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid outbox result');
    assertJsonResult(result);
    if ((result.outcome !== 'known' && result.outcome !== 'unknown') ||
        (result.outcome === 'known' && !Object.hasOwn(result, 'value')) ||
        Object.keys(result).some(key => !['outcome', 'value'].includes(key)) ||
        (result.outcome === 'unknown' && Object.hasOwn(result, 'value'))) throw new Error('Invalid outbox result');
    const encoded = JSON.stringify(result);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 65536 || (result.outcome === 'known' && !Object.hasOwn(JSON.parse(encoded), 'value'))) throw new Error('Invalid outbox result');
    const updated = this.db.prepare("UPDATE write_outbox SET state = 'result', result = ? WHERE session_hash = ? AND id = ? AND state = 'dispatched'")
      .run(encoded, digest(sessionId), id);
    if (Number(updated.changes) !== 1) {
      const row = this.row(sessionId, id);
      if (!row || (row.state !== 'result' && row.state !== 'delivered') || row.result !== encoded) throw new Error('Outbox state does not permit result');
    }
  }
  get(sessionId: string, id: string) {
    const row = this.row(sessionId, id);
    return row ? this.view(row) : undefined;
  }

  /** Host-only: original executor must be confirmed stopped before settling an interrupted invocation. */
  settleInterrupted(sessionId: string, id: string): void {
    this.identity(sessionId); this.identity(id);
    const updated = this.db.prepare(`UPDATE write_outbox SET state = 'result', result = ?
      WHERE session_hash = ? AND id = ? AND state IN ('pending', 'dispatched')`)
      .run('{"outcome":"unknown"}', digest(sessionId), id);
    if (Number(updated.changes) !== 1) throw new Error('Outbox state does not permit interruption settlement');
  }

  /** The caller must first independently verify or obtain a human decision and write its audit receipt. */
  resolveUnknown(sessionId: string, id: string, resolution: 'confirmed-applied' | 'confirmed-not-applied' | 'abandoned', auditId: string): void {
    this.identity(sessionId); this.identity(id); this.identity(auditId);
    if (!['confirmed-applied', 'confirmed-not-applied', 'abandoned'].includes(resolution)) throw new Error('Invalid outbox resolution');
    const updated = this.db.prepare(`UPDATE write_outbox SET resolution = ?, resolution_audit = ?
      WHERE session_hash = ? AND id = ? AND state IN ('result', 'delivered') AND result = ? AND resolution IS NULL`)
      .run(resolution, auditId, digest(sessionId), id, '{"outcome":"unknown"}');
    if (Number(updated.changes) !== 1) throw new Error('Outbox state does not permit resolution');
  }

  /** Must be checked while holding the shared task lock, immediately before dispatch. */
  isTaskBlocked(sessionId: string, taskId: string): boolean {
    this.identity(sessionId); this.identity(taskId);
    const rows = this.db.prepare(`SELECT sequence, id, task_id, source, action, target, created_at, state, result, resolution, resolution_audit
      FROM write_outbox WHERE session_hash = ? AND task_id = ?`).all(digest(sessionId), taskId) as Array<Row & { resolution: string | null; resolution_audit: string | null }>;
    for (const row of rows) {
      const entry = this.view(row);
      if ((row.resolution === null && row.resolution_audit !== null) || row.resolution !== null && (!['confirmed-applied', 'confirmed-not-applied', 'abandoned'].includes(row.resolution) ||
          !row.resolution_audit || entry.result?.outcome !== 'unknown')) throw new Error('Invalid outbox resolution');
      if (entry.state === 'pending' || entry.state === 'dispatched' || entry.state === 'result' ||
          (entry.result?.outcome === 'unknown' && row.resolution === null)) return true;
    }
    return false;
  }

  /** Only after the host establishes that the original executor is stopped. Never dispatch recovered rows. */
  recover(sessionId: string, after = 0, limit = 100) {
    this.identity(sessionId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid outbox cursor');
    const rows = this.db.prepare(`SELECT sequence, id, task_id, source, action, target, created_at, state, result FROM write_outbox
      WHERE session_hash = ? AND sequence > ? AND state != 'delivered' ORDER BY sequence LIMIT ?`).all(digest(sessionId), after, limit) as Row[];
    return rows.map(row => row.state === 'dispatched' || row.state === 'pending'
      ? { ...this.view(row), state: 'unknown' as const } : this.view(row));
  }
  acknowledge(sessionId: string, id: string, requestId: string): void {
    this.identity(sessionId); this.identity(id); this.identity(requestId);
    const receipt = digest(JSON.stringify([sessionId, requestId]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT invocation_id FROM write_outbox_receipts WHERE receipt_hash = ?').get(receipt);
      if (previous) {
        if (previous.invocation_id !== id || this.row(sessionId, id)?.state !== 'delivered') throw new Error('Outbox receipt already used');
      } else {
        const updated = this.db.prepare("UPDATE write_outbox SET state = 'delivered', delivered_at = ? WHERE session_hash = ? AND id = ? AND state = 'result'")
          .run(this.time(), digest(sessionId), id);
        if (Number(updated.changes) !== 1) throw new Error('Outbox state does not permit receipt');
        this.db.prepare('INSERT INTO write_outbox_receipts(receipt_hash, invocation_id) VALUES (?, ?)').run(receipt, id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prune(): number {
    const cutoff = this.time() - retention;
    if (cutoff < 0) return 0;
    return Number(this.db.prepare(`DELETE FROM write_outbox WHERE state = 'delivered' AND delivered_at <= ? AND
      CASE WHEN json_valid(result) THEN
        (json_extract(result, '$.outcome') = 'known' AND json_type(result, '$.value') IS NOT NULL AND (SELECT COUNT(*) FROM json_each(result)) = 2) OR
        (json_extract(result, '$.outcome') = 'unknown' AND (SELECT COUNT(*) FROM json_each(result)) = 1 AND resolution IN ('confirmed-applied', 'confirmed-not-applied', 'abandoned') AND resolution_audit IS NOT NULL)
      ELSE 0 END`).run(cutoff).changes);
  }
  close(): void { this.db.close(); }
}
