import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';

export const EVENT_RETENTION_MS = 72 * 60 * 60 * 1000;

export interface EventLogInput {
  source: string;
  deliveryId?: string;
  type: string;
  scope: string;
  workspaceId?: string;
  receivedAt: number;
  summary: string;
  payload: string;
}

export interface EventEnvelope {
  id: string;
  sequence: number;
  source: string;
  deliveryId: string | null;
  type: string;
  scope: string;
  workspaceId: string | null;
  receivedAt: number;
  summary: string;
}

export interface EventSubscription {
  id: string;
  subject: string;
  workspaceId: string;
  source: string;
  types: string[];
  scope: string;
  pathPattern?: string;
  mode: 'instant' | 'digest';
  rateLimit: number;
  createdAt: number;
  expiresAt: number | null;
  startCursor: number;
  cursor: number;
  launchTaskId?: string;
  configKey?: string;
}

/** Durable append-only input log. Delivery and authorization are owned by the router. */
export class EventLog {
  private readonly db: DatabaseSync;

  constructor(userDataDir: string) {
    mkdirSync(userDataDir, { recursive: true });
    this.db = new DatabaseSync(sqliteFilePath(userDataStorage(userDataDir).file('event-log')));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        delivery_id TEXT,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        received_at INTEGER NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(source, delivery_id)
      );
      CREATE INDEX IF NOT EXISTS events_received_at ON events(received_at);
      CREATE INDEX IF NOT EXISTS events_source_sequence ON events(source, sequence);
      CREATE INDEX IF NOT EXISTS events_scope ON events(source, workspace_id, scope, sequence);
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, workspace_id TEXT NOT NULL,
        source TEXT NOT NULL, types TEXT NOT NULL, scope TEXT NOT NULL,
        mode TEXT NOT NULL, rate_limit INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, start_cursor INTEGER NOT NULL, cursor INTEGER NOT NULL,
        launch_task_id TEXT, config_key TEXT
      );
      CREATE INDEX IF NOT EXISTS subscriptions_subject ON subscriptions(subject);
      CREATE TABLE IF NOT EXISTS deliveries (
        subscription_id TEXT NOT NULL, event_sequence INTEGER NOT NULL, source TEXT NOT NULL, subject TEXT NOT NULL,
        delivered_at INTEGER NOT NULL, PRIMARY KEY(subscription_id, event_sequence)
      );
      CREATE INDEX IF NOT EXISTS deliveries_time ON deliveries(delivered_at);`);
    const subscriptionColumns = this.db.prepare('PRAGMA table_info(subscriptions)').all() as Array<{ name: string }>;
    if (!subscriptionColumns.some(column => column.name === 'path_pattern')) this.db.exec('ALTER TABLE subscriptions ADD COLUMN path_pattern TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS launch_claims (
      subscription_id TEXT NOT NULL, event_sequence INTEGER NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(subscription_id, event_sequence)
    );
    CREATE TABLE IF NOT EXISTS phase_latest (
      workspace_id TEXT NOT NULL, scope TEXT NOT NULL, event_sequence INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, scope)
    );
    CREATE TABLE IF NOT EXISTS phase_pending (
      subscription_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, event_sequence INTEGER NOT NULL,
      due_at INTEGER NOT NULL, event_json TEXT NOT NULL
    );`);
    // Older event logs duplicated the full event payload in phase_pending. Keep
    // the envelope for restart recovery, while retaining the canonical payload
    // in events. Existing databases are rebuilt in-place before any writes.
    const pendingColumns = this.db.prepare('PRAGMA table_info(phase_pending)').all() as Array<{ name: string }>;
    if (pendingColumns.some(column => column.name === 'payload')) {
      const legacyPending = this.db.prepare('SELECT subscription_id, event_id, event_sequence, due_at, event_json, payload FROM phase_pending').all() as Array<{
        subscription_id: string; event_id: string; event_sequence: number; due_at: number; event_json: string; payload: string;
      }>;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // A pre-v2 database may already have pruned the canonical event while
        // a pending row still retained its payload. Restore that event before
        // dropping the duplicate column so the migration remains lossless.
        const restore = this.db.prepare(`INSERT OR IGNORE INTO events
          (sequence, id, source, delivery_id, type, scope, workspace_id, received_at, summary, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const row of legacyPending) {
          if (this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(row.event_id)) continue;
          const envelope = JSON.parse(row.event_json) as EventEnvelope;
          restore.run(row.event_sequence, row.event_id, envelope.source, envelope.deliveryId, envelope.type, envelope.scope,
            envelope.workspaceId, envelope.receivedAt, envelope.summary, row.payload);
        }
        this.db.exec(`DROP TABLE IF EXISTS phase_pending_v2;
          CREATE TABLE phase_pending_v2 (
            subscription_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, event_sequence INTEGER NOT NULL,
            due_at INTEGER NOT NULL, event_json TEXT NOT NULL
          );
          INSERT INTO phase_pending_v2 (subscription_id, event_id, event_sequence, due_at, event_json)
            SELECT subscription_id, event_id, event_sequence, due_at, event_json FROM phase_pending;
          DROP TABLE phase_pending;
          ALTER TABLE phase_pending_v2 RENAME TO phase_pending;`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    // Retire task-backed event subscriptions; ordinary session and system subscriptions remain.
    this.db.exec(`BEGIN IMMEDIATE;
      DELETE FROM phase_pending WHERE subscription_id IN (SELECT id FROM subscriptions WHERE launch_task_id IS NOT NULL OR subject LIKE 'task:%');
      DELETE FROM launch_claims WHERE subscription_id IN (SELECT id FROM subscriptions WHERE launch_task_id IS NOT NULL OR subject LIKE 'task:%');
      DELETE FROM subscriptions WHERE launch_task_id IS NOT NULL OR subject LIKE 'task:%';
      COMMIT;`);
  }

  append(input: EventLogInput): { inserted: boolean; event: EventEnvelope } {
    if (!input.source || !input.type || !Number.isSafeInteger(input.receivedAt)) throw new Error('Invalid event');
    const id = randomUUID();
    const deliveryId = input.deliveryId?.trim() || null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`INSERT INTO events (id, source, delivery_id, type, scope, workspace_id, received_at, summary, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, delivery_id) DO NOTHING`)
        .run(id, input.source, deliveryId, input.type, input.scope, input.workspaceId ?? null, input.receivedAt, input.summary, input.payload);
      const row = (result.changes
        ? this.db.prepare('SELECT * FROM events WHERE id = ?').get(id)
        : this.db.prepare('SELECT * FROM events WHERE source = ? AND delivery_id = ?').get(input.source, deliveryId)) as Record<string, unknown>;
      if (!result.changes && (row.payload !== input.payload || row.type !== input.type || row.scope !== input.scope ||
        row.workspace_id !== (input.workspaceId ?? null))) throw new Error('Conflicting event delivery ID');
      if (result.changes && input.source === 'phase' && input.workspaceId) this.db.prepare(`INSERT INTO phase_latest (workspace_id, scope, event_sequence, received_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, scope) DO UPDATE SET event_sequence = excluded.event_sequence, received_at = excluded.received_at`)
        .run(input.workspaceId, input.scope, Number(row.sequence), input.receivedAt);
      this.db.exec('COMMIT');
      return { inserted: result.changes === 1, event: this.envelope(row) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  list(options: { after?: number; limit?: number; source?: string; since?: number; until?: number } = {}): EventEnvelope[] {
    const after = options.after ?? 0;
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
        (options.since !== undefined && !Number.isSafeInteger(options.since)) || (options.until !== undefined && !Number.isSafeInteger(options.until)) ||
        (options.since !== undefined && options.until !== undefined && options.since > options.until)) throw new Error('Invalid event page');
    const columns = 'sequence, id, source, delivery_id, type, scope, workspace_id, received_at, summary';
    const rows = (options.source === undefined
      ? this.db.prepare(`SELECT ${columns} FROM events WHERE sequence > ? AND (? IS NULL OR received_at >= ?) AND (? IS NULL OR received_at <= ?) ORDER BY sequence LIMIT ?`)
        .all(after, options.since ?? null, options.since ?? null, options.until ?? null, options.until ?? null, limit)
      : this.db.prepare(`SELECT ${columns} FROM events WHERE source = ? AND sequence > ? AND (? IS NULL OR received_at >= ?) AND (? IS NULL OR received_at <= ?) ORDER BY sequence LIMIT ?`)
        .all(options.source, after, options.since ?? null, options.since ?? null, options.until ?? null, options.until ?? null, limit)) as Record<string, unknown>[];
    return rows.map(row => this.envelope(row));
  }

  get(id: string): EventEnvelope | undefined {
    const row = this.db.prepare('SELECT sequence, id, source, delivery_id, type, scope, workspace_id, received_at, summary FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.envelope(row) : undefined;
  }

  latestSequence(source: string, workspaceId: string, scope: string): number | null {
    if (source === 'phase') {
      const latest = this.db.prepare('SELECT event_sequence FROM phase_latest WHERE workspace_id = ? AND scope = ?').get(workspaceId, scope) as { event_sequence: number } | undefined;
      return latest ? Number(latest.event_sequence) : null;
    }
    const row = this.db.prepare('SELECT MAX(sequence) AS sequence FROM events WHERE source = ? AND workspace_id = ? AND scope = ?')
      .get(source, workspaceId, scope) as { sequence: number | null };
    return row.sequence === null ? null : Number(row.sequence);
  }

  subscribe(input: Omit<EventSubscription, 'id' | 'cursor' | 'startCursor' | 'rateLimit'> & { rateLimit?: number }): EventSubscription {
    const id = `sub-${randomUUID()}`;
    const cursor = Number((this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM events').get() as { n: number }).n);
    const rateLimit = input.rateLimit ?? 20;
    if (!Number.isSafeInteger(rateLimit) || rateLimit < 1 || rateLimit > 20) throw new Error('Invalid subscription rate limit');
    this.db.prepare(`INSERT INTO subscriptions (id, subject, workspace_id, source, types, scope, mode, rate_limit, created_at, expires_at, start_cursor, cursor, launch_task_id, config_key, path_pattern)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.subject, input.workspaceId, input.source,
      JSON.stringify(input.types), input.scope, input.mode, rateLimit, input.createdAt, input.expiresAt, cursor, cursor, input.launchTaskId ?? null, input.configKey ?? null, input.pathPattern ?? null);
    return { ...input, rateLimit, id, startCursor: cursor, cursor };
  }

  subscriptions(subject?: string): EventSubscription[] {
    const rows = this.db.prepare('SELECT * FROM subscriptions WHERE (? IS NULL OR subject = ?) ORDER BY created_at, id')
      .all(subject ?? null, subject ?? null) as Record<string, unknown>[];
    return rows.map(row => ({ id: String(row.id), subject: String(row.subject), workspaceId: String(row.workspace_id),
      source: String(row.source), types: JSON.parse(String(row.types)) as string[], scope: String(row.scope),
      mode: row.mode === 'digest' ? 'digest' : 'instant', rateLimit: Number(row.rate_limit), createdAt: Number(row.created_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at), startCursor: Number(row.start_cursor), cursor: Number(row.cursor),
      ...(row.launch_task_id ? { launchTaskId: String(row.launch_task_id) } : {}), ...(row.config_key ? { configKey: String(row.config_key) } : {}),
      ...(row.path_pattern ? { pathPattern: String(row.path_pattern) } : {}) }));
  }

  unsubscribe(id: string, subject: string): boolean {
    const removed = Number(this.db.prepare('DELETE FROM subscriptions WHERE id = ? AND subject = ?').run(id, subject).changes) > 0;
    if (removed) this.db.prepare('DELETE FROM phase_pending WHERE subscription_id = ?').run(id);
    return removed;
  }

  rememberPhase(id: string, event: EventEnvelope, _payload: string, dueAt: number): void {
    this.db.prepare(`INSERT INTO phase_pending (subscription_id, event_id, event_sequence, due_at, event_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(subscription_id) DO UPDATE SET event_id = excluded.event_id,
      event_sequence = excluded.event_sequence, due_at = excluded.due_at, event_json = excluded.event_json`)
      .run(id, event.id, event.sequence, dueAt, JSON.stringify(event));
  }

  pendingPhase(id: string): { event: EventEnvelope; dueAt: number } | undefined {
    const row = this.db.prepare('SELECT event_json, due_at FROM phase_pending WHERE subscription_id = ?').get(id) as { event_json: string; due_at: number } | undefined;
    return row ? { event: JSON.parse(row.event_json) as EventEnvelope, dueAt: Number(row.due_at) } : undefined;
  }

  clearPendingPhase(id: string): void { this.db.prepare('DELETE FROM phase_pending WHERE subscription_id = ?').run(id); }

  advance(id: string, from: number, to: number): boolean {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error('Invalid event cursor');
    return Number(this.db.prepare('UPDATE subscriptions SET cursor = ? WHERE id = ? AND cursor = ?').run(to, id, from).changes) > 0;
  }

  mayDeliver(id: string, source: string, now: number): boolean {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN subscription_id = ? THEN 1 ELSE 0 END) AS sub_count,
      SUM(CASE WHEN source = ? THEN 1 ELSE 0 END) AS source_count,
      SUM(CASE WHEN subject = (SELECT subject FROM subscriptions WHERE id = ?) THEN 1 ELSE 0 END) AS subject_count
      FROM deliveries WHERE delivered_at > ?`).get(id, source, id, now - 3600000) as { sub_count: number | null; source_count: number | null; subject_count: number | null };
    const sub = this.db.prepare('SELECT rate_limit FROM subscriptions WHERE id = ?').get(id) as { rate_limit: number } | undefined;
    return !!sub && (row.sub_count ?? 0) < sub.rate_limit && (row.subject_count ?? 0) < 20 && (row.source_count ?? 0) < 1000;
  }

  claimLaunch(id: string, sequence: number): 'claimed' | 'done' | 'uncertain' {
    const result = this.db.prepare('INSERT OR IGNORE INTO launch_claims (subscription_id, event_sequence, state, created_at) VALUES (?, ?, ?, ?)')
      .run(id, sequence, 'claimed', Date.now());
    if (result.changes) return 'claimed';
    const row = this.db.prepare('SELECT state FROM launch_claims WHERE subscription_id = ? AND event_sequence = ?').get(id, sequence) as { state: string };
    return row.state === 'done' ? 'done' : 'uncertain';
  }

  launchState(id: string, sequence: number): 'claimed' | 'done' | undefined {
    const row = this.db.prepare('SELECT state FROM launch_claims WHERE subscription_id = ? AND event_sequence = ?').get(id, sequence) as { state: 'claimed' | 'done' } | undefined;
    return row?.state;
  }

  hasUncertainLaunch(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM launch_claims WHERE subscription_id = ? AND state = 'claimed' LIMIT 1").get(id);
  }

  finishLaunch(id: string, sequence: number): void {
    this.db.prepare("UPDATE launch_claims SET state = 'done' WHERE subscription_id = ? AND event_sequence = ?").run(id, sequence);
  }

  launchClaims(id: string, after = 0): Array<{ sequence: number; state: string; createdAt: number }> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid claims cursor');
    const rows = this.db.prepare('SELECT event_sequence, state, created_at FROM launch_claims WHERE subscription_id = ? AND event_sequence > ? ORDER BY event_sequence LIMIT 21')
      .all(id, after) as Array<{ event_sequence: number; state: string; created_at: number }>;
    return rows.map(row => ({ sequence: Number(row.event_sequence), state: row.state, createdAt: Number(row.created_at) }));
  }

  resolveLaunch(id: string, sequence: number, action: 'retry' | 'complete'): boolean {
    const result = action === 'retry'
      ? this.db.prepare("DELETE FROM launch_claims WHERE subscription_id = ? AND event_sequence = ? AND state = 'claimed'").run(id, sequence)
      : this.db.prepare("UPDATE launch_claims SET state = 'done' WHERE subscription_id = ? AND event_sequence = ? AND state = 'claimed'").run(id, sequence);
    return Number(result.changes) === 1;
  }

  finishDelivery(id: string, source: string, from: number, to: number, now: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.advance(id, from, to)) throw new Error('Subscription cursor changed during delivery');
      this.db.prepare('INSERT OR IGNORE INTO deliveries (subscription_id, event_sequence, source, subject, delivered_at) SELECT ?, ?, ?, subject, ? FROM subscriptions WHERE id = ?')
        .run(id, to, source, now, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  filePath(id: string): string | undefined {
    const row = this.db.prepare("SELECT payload FROM events WHERE id = ? AND source = 'file'").get(id) as { payload: string } | undefined;
    if (!row || row.payload.length > 100_000) return undefined;
    try { const data: unknown = JSON.parse(row.payload); return data && typeof data === 'object' && 'path' in data && typeof data.path === 'string' ? data.path : undefined; }
    catch { return undefined; }
  }

  payload(id: string, offset = 0, length = 16000): { text: string; nextOffset: number | null } | undefined {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 32000) throw new Error('Invalid payload page');
    const row = this.db.prepare('SELECT payload FROM events WHERE id = ?').get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const text = row.payload.slice(offset, offset + length);
    return { text, nextOffset: offset + text.length < row.payload.length ? offset + text.length : null };
  }

  prune(now = Date.now()): number {
    this.db.prepare('DELETE FROM deliveries WHERE delivered_at < ?').run(now - EVENT_RETENTION_MS);
    this.db.prepare('DELETE FROM launch_claims WHERE created_at < ?').run(now - EVENT_RETENTION_MS);
    this.db.prepare('DELETE FROM subscriptions WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM phase_pending WHERE subscription_id NOT IN (SELECT id FROM subscriptions)').run();
    this.db.prepare('DELETE FROM phase_latest WHERE received_at < ? AND NOT EXISTS (SELECT 1 FROM phase_pending WHERE event_sequence = phase_latest.event_sequence)').run(now - EVENT_RETENTION_MS);
    return Number(this.db.prepare('DELETE FROM events WHERE received_at < ? AND NOT EXISTS (SELECT 1 FROM phase_pending WHERE event_sequence = events.sequence)').run(now - EVENT_RETENTION_MS).changes);
  }

  close(): void { this.db.close(); }

  private envelope(row: Record<string, unknown>): EventEnvelope {
    return { id: String(row.id), sequence: Number(row.sequence), source: String(row.source),
      deliveryId: row.delivery_id === null ? null : String(row.delivery_id), type: String(row.type),
      scope: String(row.scope), workspaceId: row.workspace_id === null ? null : String(row.workspace_id), receivedAt: Number(row.received_at), summary: String(row.summary) };
  }
}
