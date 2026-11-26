import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import type { SessionReminder } from '../../shared/sessionReminders';

type Row = {
  id: string; text: string; created_at: number; completed_at: number | null;
  completed_by: 'user' | 'ai' | null; source_message_id: string | null;
};

function mapRow(row: Row): SessionReminder {
  return { id: row.id, text: row.text, createdAt: row.created_at, completedAt: row.completed_at,
    completedBy: row.completed_by, sourceMessageId: row.source_message_id };
}

function validScope(scope: string): void {
  if (typeof scope !== 'string' || !scope || scope.length > 400) throw new Error('Invalid reminder scope.');
}

/** Single-writer SQLite store. Each query and update is scoped by the host identity. */
export class SessionReminderStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(sqliteFilePath(file));
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS session_reminders (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL,
        created_at INTEGER NOT NULL, completed_at INTEGER, completed_by TEXT,
        source_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS session_reminders_scope ON session_reminders(scope, created_at);`);
  }

  list(scope: string): SessionReminder[] {
    validScope(scope);
    return (this.db.prepare('SELECT id,text,created_at,completed_at,completed_by,source_message_id FROM session_reminders WHERE scope=? ORDER BY created_at ASC, rowid ASC').all(scope) as Row[]).map(mapRow);
  }

  add(scope: string, input: unknown, sourceMessageId: string | null): { item: SessionReminder; created: boolean } {
    validScope(scope);
    if (typeof input !== 'string' || !input.trim() || input.trim().length > 300) throw new Error('Reminder text must contain 1–300 characters.');
    if (sourceMessageId !== null && (typeof sourceMessageId !== 'string' || sourceMessageId.length > 300)) throw new Error('Invalid reminder source.');
    const text = input.trim();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT id,text,created_at,completed_at,completed_by,source_message_id FROM session_reminders WHERE scope=? AND text=? AND completed_at IS NULL LIMIT 1').get(scope, text) as Row | undefined;
      if (existing) {
        this.db.exec('COMMIT');
        return { item: mapRow(existing), created: false };
      }
      const item: SessionReminder = { id: randomUUID(), text, createdAt: Date.now(), completedAt: null, completedBy: null, sourceMessageId };
      this.db.prepare('INSERT INTO session_reminders(id,scope,text,created_at,completed_at,completed_by,source_message_id) VALUES(?,?,?,?,NULL,NULL,?)')
        .run(item.id, scope, item.text, item.createdAt, item.sourceMessageId);
      this.db.exec('COMMIT');
      return { item, created: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setCompleted(scope: string, id: string, done: boolean, by: 'user' | 'ai'): SessionReminder {
    validScope(scope);
    if (typeof id !== 'string' || !id || id.length > 100 || typeof done !== 'boolean' || (by !== 'user' && by !== 'ai')) throw new Error('Invalid reminder update.');
    const current = this.db.prepare('SELECT id,text,created_at,completed_at,completed_by,source_message_id FROM session_reminders WHERE scope=? AND id=?').get(scope, id) as Row | undefined;
    if (!current) throw new Error('Reminder does not exist in this conversation.');
    if ((current.completed_at !== null) === done) return mapRow(current);
    const completedAt = done ? Date.now() : null;
    this.db.prepare('UPDATE session_reminders SET completed_at=?,completed_by=? WHERE scope=? AND id=?')
      .run(completedAt, done ? by : null, scope, id);
    return mapRow({ ...current, completed_at: completedAt, completed_by: done ? by : null });
  }

  delete(scope: string, id: string): void {
    validScope(scope);
    if (typeof id !== 'string' || !id || id.length > 100) throw new Error('Invalid reminder id.');
    const result = this.db.prepare('DELETE FROM session_reminders WHERE scope=? AND id=?').run(scope, id);
    if (result.changes === 0) throw new Error('Reminder does not exist in this conversation.');
  }

  deleteScope(scope: string): void {
    validScope(scope);
    this.db.prepare('DELETE FROM session_reminders WHERE scope=?').run(scope);
  }

  deleteScopes(scopes: readonly string[]): void {
    if (!scopes.length) return;
    for (const scope of scopes) validScope(scope);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.prepare('DELETE FROM session_reminders WHERE scope=?');
      for (const scope of scopes) remove.run(scope);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
