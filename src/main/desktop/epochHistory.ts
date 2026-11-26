import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';

/** Only host-owned session identity and host confirmation receipts may be recorded. */
export interface DesktopEpochHistory {
  generation(sessionId: string): number;
  record(sessionId: string, generation: number, taskId: string): void;
  owns(sessionId: string, generation: number, taskId: string): boolean;
  findByHash(sessionId: string, generation: number, taskHash: string): string | undefined;
  endSession(sessionId: string): void;
  endSessions?(sessionIds: readonly string[]): void;
}

export class SqliteDesktopEpochHistory implements DesktopEpochHistory {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:' && !path.isAbsolute(file)) throw new Error('Epoch history path must be absolute');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(sqliteFilePath(file));
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS desktop_epoch_sessions (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS desktop_epoch_history (
          session_id TEXT NOT NULL, generation INTEGER NOT NULL, task_id TEXT NOT NULL UNIQUE, task_hash TEXT,
          PRIMARY KEY(session_id, generation, task_id), FOREIGN KEY(session_id) REFERENCES desktop_epoch_sessions(session_id));`);
      const columns = this.db.prepare('PRAGMA table_info(desktop_epoch_history)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'task_hash')) this.db.exec('ALTER TABLE desktop_epoch_history ADD COLUMN task_hash TEXT');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const pending = this.db.prepare('SELECT task_id FROM desktop_epoch_history WHERE task_hash IS NULL').all() as Array<{ task_id: string }>;
        const update = this.db.prepare('UPDATE desktop_epoch_history SET task_hash = ? WHERE task_id = ?');
        for (const row of pending) update.run(createHash('sha256').update(row.task_id).digest('hex'), row.task_id);
        this.db.exec('CREATE INDEX IF NOT EXISTS desktop_epoch_hash ON desktop_epoch_history(session_id, generation, task_hash); COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }

  private validate(value: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid desktop epoch identity');
  }

  generation(sessionId: string): number {
    this.validate(sessionId);
    const select = this.db.prepare('SELECT generation FROM desktop_epoch_sessions WHERE session_id = ?');
    let value = select.get(sessionId)?.generation;
    if (value === undefined) {
      this.db.prepare('INSERT OR IGNORE INTO desktop_epoch_sessions(session_id, generation) VALUES (?, 0)').run(sessionId);
      value = select.get(sessionId)?.generation;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid desktop session generation');
    return value;
  }

  record(sessionId: string, generation: number, taskId: string): void {
    this.validate(sessionId); this.validate(taskId);
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid desktop session generation');
    const hash = createHash('sha256').update(taskId).digest('hex');
    const result = this.db.prepare(`INSERT INTO desktop_epoch_history(session_id, generation, task_id, task_hash)
      SELECT session_id, generation, ?, ? FROM desktop_epoch_sessions WHERE session_id = ? AND generation = ?`).run(taskId, hash, sessionId, generation);
    if (Number(result.changes) !== 1) throw new Error('Desktop session generation changed');
  }

  owns(sessionId: string, generation: number, taskId: string): boolean {
    this.validate(sessionId); this.validate(taskId);
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    return !!this.db.prepare(`SELECT 1 FROM desktop_epoch_history h JOIN desktop_epoch_sessions s
      ON s.session_id = h.session_id AND s.generation = h.generation
      WHERE h.session_id = ? AND h.generation = ? AND h.task_id = ?`).get(sessionId, generation, taskId);
  }

  findByHash(sessionId: string, generation: number, taskHash: string): string | undefined {
    this.validate(sessionId);
    if (!Number.isSafeInteger(generation) || generation < 0 || typeof taskHash !== 'string' || !/^[a-f0-9]{64}$/.test(taskHash)) throw new Error('Invalid desktop task hash');
    const rows = this.db.prepare(`SELECT h.task_id FROM desktop_epoch_history h JOIN desktop_epoch_sessions s
      ON s.session_id = h.session_id AND s.generation = h.generation
      WHERE h.session_id = ? AND h.generation = ? AND h.task_hash = ? LIMIT 2`).all(sessionId, generation, taskHash) as Array<{ task_id: string }>;
    if (rows.length > 1) throw new Error('Ambiguous desktop capture ownership');
    if (rows[0] && (typeof rows[0].task_id !== 'string' || createHash('sha256').update(rows[0].task_id).digest('hex') !== taskHash)) throw new Error('Invalid desktop capture ownership');
    return rows[0]?.task_id;
  }

  endSession(sessionId: string): void {
    this.endSessions([sessionId]);
  }

  /** Revoke a subtree as one transaction before any session is archived. */
  endSessions(sessionIds: readonly string[]): void {
    if (!Array.isArray(sessionIds) || !sessionIds.length || new Set(sessionIds).size !== sessionIds.length) throw new Error('Invalid desktop session batch');
    for (const id of sessionIds) this.validate(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const sessionId of sessionIds) {
        const generation = this.generation(sessionId);
        if (generation >= Number.MAX_SAFE_INTEGER) throw new Error('Desktop session generation exhausted');
        const result = this.db.prepare('UPDATE desktop_epoch_sessions SET generation = generation + 1 WHERE session_id = ? AND generation = ?').run(sessionId, generation);
        if (Number(result.changes) !== 1) throw new Error('Desktop session generation changed');
        this.db.prepare('DELETE FROM desktop_epoch_history WHERE session_id = ?').run(sessionId);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void { this.db.close(); }
}
