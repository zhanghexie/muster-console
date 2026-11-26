import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import { boundedVisibleActionResult } from './visibleActionJson';

export type VisibleActionMarker = Readonly<{
  version: 1; id: string; sessionHash: string; invocationId: string; receiptHash: string | null;
}>;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function identity(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('Invalid visible action identity');
}

/**
 * One durable marker per task, including across sessions. Every coordinator
 * for a task must use the same private outbox database and shared task lock.
 */
export class VisibleActionBarrier {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (!path.isAbsolute(file)) throw new Error('Visible action barrier database path must be absolute');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(sqliteFilePath(file));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      // Refuse a separate or uninitialized database: legacy outbox rows must
      // participate in the same task-wide block across all sessions.
      this.db.prepare('SELECT state, result, resolution, resolution_audit FROM write_outbox LIMIT 0').all();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS visible_action_barriers (
          task_hash TEXT PRIMARY KEY, version INTEGER NOT NULL, id TEXT NOT NULL,
          session_hash TEXT NOT NULL, invocation_id TEXT NOT NULL, receipt_hash TEXT)`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const columns = this.db.prepare('PRAGMA table_info(visible_action_barriers)').all();
        if (!columns.some(column => column.name === 'receipt_hash')) this.db.exec('ALTER TABLE visible_action_barriers ADD COLUMN receipt_hash TEXT');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }

  /** Include older outbox writers that did not create a visible-action marker. */
  isTaskBlocked(taskId: string): boolean {
    identity(taskId);
    const rows = this.db.prepare('SELECT state, result, resolution, resolution_audit FROM write_outbox WHERE task_id = ?').all(taskId);
    for (const row of rows) {
      if (!['pending', 'dispatched', 'result', 'delivered'].includes(String(row.state))) throw new Error('Invalid outbox state');
      if (row.state !== 'delivered') return true;
      if (typeof row.result !== 'string' || Buffer.byteLength(row.result) > 65536) throw new Error('Invalid outbox result');
      const result: unknown = JSON.parse(row.result);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid outbox result');
      const item = result as { outcome?: unknown; value?: unknown };
      if (item.outcome === 'known') {
        if (Object.keys(item).sort().join(',') !== 'outcome,value' || row.resolution !== null || row.resolution_audit !== null) {
          throw new Error('Invalid outbox result');
        }
        boundedVisibleActionResult(item.value);
      } else if (item.outcome === 'unknown') {
        if (Object.keys(item).join(',') !== 'outcome') throw new Error('Invalid outbox result');
        if (row.resolution === null && row.resolution_audit === null) return true;
        if (!['confirmed-applied', 'confirmed-not-applied', 'abandoned'].includes(String(row.resolution)) ||
            typeof row.resolution_audit !== 'string' || !row.resolution_audit.trim() || row.resolution_audit.length > 1024) throw new Error('Invalid outbox resolution');
      } else throw new Error('Invalid outbox result');
    }
    return false;
  }

  read(taskId: string): VisibleActionMarker | null {
    identity(taskId);
    const row = this.db.prepare('SELECT version, id, session_hash, invocation_id, receipt_hash FROM visible_action_barriers WHERE task_hash = ?')
      .get(digest(taskId));
    if (!row) return null;
    if (row.version !== 1 || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id) ||
        typeof row.session_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.session_hash) ||
        typeof row.invocation_id !== 'string' || !row.invocation_id.trim() || row.invocation_id.length > 1024 ||
        (row.receipt_hash !== null && (typeof row.receipt_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.receipt_hash)))) {
      throw new Error('Invalid visible action barrier; independent recovery is required');
    }
    return Object.freeze({ version: 1 as const, id: row.id, sessionHash: row.session_hash,
      invocationId: row.invocation_id, receiptHash: row.receipt_hash as string | null });
  }

  begin(taskId: string, sessionId: string, invocationId: string): VisibleActionMarker {
    identity(taskId); identity(sessionId); identity(invocationId);
    const marker: VisibleActionMarker = Object.freeze({ version: 1, id: randomUUID(), sessionHash: digest(sessionId), invocationId, receiptHash: null });
    this.db.prepare('INSERT INTO visible_action_barriers(task_hash, version, id, session_hash, invocation_id) VALUES (?, 1, ?, ?, ?)')
      .run(digest(taskId), marker.id, marker.sessionHash, marker.invocationId);
    return marker;
  }

  prepareDelivery(taskId: string, marker: VisibleActionMarker, token: string, value: unknown): void {
    identity(taskId);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid visible action delivery token');
    const receiptHash = digest(JSON.stringify([token, boundedVisibleActionResult(value)]));
    const updated = this.db.prepare(`UPDATE visible_action_barriers SET receipt_hash = ?
      WHERE task_hash = ? AND version = 1 AND id = ? AND session_hash = ? AND invocation_id = ? AND receipt_hash IS NULL`)
      .run(receiptHash, digest(taskId), marker.id, marker.sessionHash, marker.invocationId);
    if (Number(updated.changes) !== 1) throw new Error('Visible action barrier changed; independent recovery is required');
  }

  matches(marker: VisibleActionMarker, sessionId: string, invocationId: string, token: string, value: unknown): boolean {
    identity(sessionId); identity(invocationId);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !marker.receiptHash) return false;
    const receiptHash = digest(JSON.stringify([token, boundedVisibleActionResult(value)]));
    return marker.sessionHash === digest(sessionId) && marker.invocationId === invocationId &&
      timingSafeEqual(Buffer.from(marker.receiptHash, 'hex'), Buffer.from(receiptHash, 'hex'));
  }

  finish(taskId: string, marker: VisibleActionMarker, assertCurrent: () => void): void {
    if (typeof assertCurrent !== 'function') throw new Error('Visible action validity check is required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read(taskId);
      if (!current || current.id !== marker.id || current.sessionHash !== marker.sessionHash ||
          current.invocationId !== marker.invocationId || current.receiptHash !== marker.receiptHash) {
        throw new Error('Visible action barrier changed; independent recovery is required');
      }
      const deleted = this.db.prepare('DELETE FROM visible_action_barriers WHERE task_hash = ? AND version = 1 AND id = ? AND session_hash = ? AND invocation_id = ? AND receipt_hash = ?')
        .run(digest(taskId), marker.id, marker.sessionHash, marker.invocationId, marker.receiptHash);
      if (Number(deleted.changes) !== 1) throw new Error('Visible action barrier changed; independent recovery is required');
      // A synchronous validity failure rolls back before other connections can
      // observe the deletion. Never await between this check and COMMIT.
      assertCurrent();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Visible action barrier finalization is unknown'); }
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
