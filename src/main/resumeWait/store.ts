import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import type { DeliveryPriority } from '../agentSession/delivery';

export type WaitCondition =
  | { kind: 'mail'; from?: string; replyTo?: string }
  | { kind: 'event'; source: string; types: string[]; scope: string }
  | { kind: 'session'; sessionId: string; phase: 'needs_you' | 'idle' }
  | { kind: 'time'; at: string };

export interface ResumeWait {
  id: string;
  owner: string;
  workspaceId: string;
  /** Host-owned epoch captured when this wait was armed, not model input. */
  desktopEpoch: string | null;
  desktopEpochGeneration: number | null;
  desktopEpochUnknown: boolean;
  condition: WaitCondition;
  note: string;
  priority: DeliveryPriority;
  createdAt: number;
  deadlineAt: number | null;
  eventCursor: number;
  state: 'armed' | 'ready' | 'delivering' | 'uncertain' | 'consumed' | 'cancelled';
  trigger: string | null;
  triggerId: string | null;
  fireInstanceId: string | null;
  deliveryId: string | null;
  attempts: number;
  failures: number;
  waitingForBoundary: boolean;
  lastAttemptAt: number | null;
  uncertainAt: number | null;
  error: string | null;
  consumedAt: number | null;
  snapshot: string | null;
}

/** The wait record and event cursor share the durable event database. */
export class ResumeWaitStore {
  private readonly db: DatabaseSync;

  constructor(userDataDir: string) {
    mkdirSync(userDataDir, { recursive: true });
    this.db = new DatabaseSync(sqliteFilePath(userDataStorage(userDataDir).file('event-log')));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS resume_waits (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL,
        condition_json TEXT NOT NULL, note TEXT NOT NULL, priority TEXT NOT NULL,
        created_at INTEGER NOT NULL, deadline_at INTEGER, event_cursor INTEGER NOT NULL,
        state TEXT NOT NULL, trigger TEXT, trigger_id TEXT, fire_instance_id TEXT, delivery_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER, uncertain_at INTEGER, waiting_boundary INTEGER NOT NULL DEFAULT 0, error TEXT, consumed_at INTEGER, snapshot TEXT, desktop_epoch TEXT,
        desktop_epoch_unknown INTEGER NOT NULL DEFAULT 0, desktop_epoch_generation INTEGER
      );
      CREATE INDEX IF NOT EXISTS resume_waits_state ON resume_waits(state, owner);
      CREATE TABLE IF NOT EXISTS resume_wait_delivery_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, wait_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        status TEXT NOT NULL, recorded_at INTEGER NOT NULL, detail TEXT,
        UNIQUE(wait_id, delivery_id, status)
      );
      CREATE INDEX IF NOT EXISTS resume_wait_delivery_lookup ON resume_wait_delivery_history(delivery_id, wait_id);`);
    const columns = this.db.prepare('PRAGMA table_info(resume_waits)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'snapshot')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN snapshot TEXT');
    if (!columns.some(column => column.name === 'failures')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN failures INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(column => column.name === 'delivery_id')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN delivery_id TEXT');
    if (!columns.some(column => column.name === 'fire_instance_id')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN fire_instance_id TEXT');
    if (!columns.some(column => column.name === 'uncertain_at')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN uncertain_at INTEGER');
    if (!columns.some(column => column.name === 'waiting_boundary')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN waiting_boundary INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(column => column.name === 'desktop_epoch')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN desktop_epoch TEXT');
    if (!columns.some(column => column.name === 'desktop_epoch_unknown')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN desktop_epoch_unknown INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(column => column.name === 'desktop_epoch_generation')) this.db.exec('ALTER TABLE resume_waits ADD COLUMN desktop_epoch_generation INTEGER');
    this.db.exec("UPDATE resume_waits SET fire_instance_id = 'fire-' || id WHERE state <> 'armed' AND fire_instance_id IS NULL");
    this.db.exec("UPDATE resume_waits SET delivery_id = id WHERE state = 'uncertain' AND delivery_id IS NULL");
    const restartedAt = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO resume_wait_delivery_history (wait_id, delivery_id, status, recorded_at)
        SELECT id, COALESCE(delivery_id, id), 'attempted', COALESCE(last_attempt_at, ?) FROM resume_waits
        WHERE state IN ('delivering', 'uncertain') AND NOT EXISTS (
          SELECT 1 FROM resume_wait_delivery_history h WHERE h.wait_id = resume_waits.id AND h.delivery_id = COALESCE(resume_waits.delivery_id, resume_waits.id)
            AND h.status IN ('attempted', 'redelivered'))`).run(restartedAt);
      this.db.prepare(`INSERT OR IGNORE INTO resume_wait_delivery_history (wait_id, delivery_id, status, recorded_at, detail)
        SELECT id, COALESCE(delivery_id, id), 'uncertain', ?, 'Host restarted before delivery was confirmed'
        FROM resume_waits WHERE state = 'delivering'`).run(restartedAt);
      this.db.prepare(`UPDATE resume_waits SET state = 'uncertain', delivery_id = COALESCE(delivery_id, id),
        uncertain_at = ?, error = 'Host restarted before delivery was confirmed' WHERE state = 'delivering'`).run(restartedAt);
      this.db.prepare("UPDATE resume_waits SET uncertain_at = ? WHERE state = 'uncertain' AND uncertain_at IS NULL").run(restartedAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  arm(input: Pick<ResumeWait, 'owner' | 'workspaceId' | 'condition' | 'note' | 'priority' | 'deadlineAt'> & { desktopEpoch?: string | null; desktopEpochGeneration?: number | null; desktopEpochUnknown?: boolean }, now = Date.now()): ResumeWait {
    if (input.desktopEpoch != null && (typeof input.desktopEpoch !== 'string' || !input.desktopEpoch.trim() || input.desktopEpoch.length > 256)) throw new Error('Invalid wait desktop epoch');
    if (input.desktopEpochUnknown !== undefined && typeof input.desktopEpochUnknown !== 'boolean' || input.desktopEpochUnknown && input.desktopEpoch != null) throw new Error('Invalid wait desktop epoch status');
    if (input.desktopEpoch == null ? input.desktopEpochGeneration != null : !Number.isSafeInteger(input.desktopEpochGeneration) || input.desktopEpochGeneration! < 0) throw new Error('Invalid wait desktop epoch generation');
    const id = `wait-${randomUUID()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const hasEvents = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
      const cursor = hasEvents ? Number((this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM events').get() as { n: number }).n) : 0;
      this.db.prepare(`INSERT INTO resume_waits
        (id, owner, workspace_id, condition_json, note, priority, created_at, deadline_at, event_cursor, state, desktop_epoch, desktop_epoch_unknown, desktop_epoch_generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?, ?)`)
        .run(id, input.owner, input.workspaceId, JSON.stringify(input.condition), input.note, input.priority, now, input.deadlineAt, cursor, input.desktopEpoch ?? null, input.desktopEpochUnknown ? 1 : 0, input.desktopEpochGeneration ?? null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id)!;
  }

  get(id: string): ResumeWait | undefined {
    const row = this.db.prepare('SELECT * FROM resume_waits WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.read(row) : undefined;
  }

  pending(owner?: string): ResumeWait[] {
    const rows = this.db.prepare("SELECT * FROM resume_waits WHERE state IN ('armed', 'ready', 'delivering', 'uncertain') AND (? IS NULL OR owner = ?) ORDER BY created_at, id")
      .all(owner ?? null, owner ?? null) as Record<string, unknown>[];
    return rows.map(row => this.read(row));
  }

  /** Permanently stop a wait whose owner can no longer receive it. */
  cancel(id: string, reason: string, now = Date.now()): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare(`UPDATE resume_waits SET state = 'cancelled', error = ?, consumed_at = ?,
        uncertain_at = NULL, waiting_boundary = 0 WHERE id = ? AND state IN ('armed', 'ready', 'delivering', 'uncertain')`)
        .run(reason, now, id);
      if (!Number(changed.changes)) { this.db.exec('ROLLBACK'); return false; }
      this.db.prepare(`INSERT OR IGNORE INTO resume_wait_delivery_history (wait_id, delivery_id, status, recorded_at, detail)
        SELECT id, COALESCE(delivery_id, id), 'cancelled', ?, ? FROM resume_waits WHERE id = ?`)
        .run(now, reason, id);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** A conditional update makes competing event, deadline and replay triggers one-shot. */
  fire(id: string, triggerId: string, trigger: string): boolean {
    return Number(this.db.prepare("UPDATE resume_waits SET state = 'ready', trigger_id = ?, trigger = ?, fire_instance_id = ? WHERE id = ? AND state = 'armed'")
      .run(triggerId, trigger, `fire-${randomUUID()}`, id).changes) === 1;
  }

  advanceEventCursor(id: string, from: number, to: number): boolean {
    return Number(this.db.prepare("UPDATE resume_waits SET event_cursor = ? WHERE id = ? AND state = 'armed' AND event_cursor = ?")
      .run(to, id, from).changes) === 1;
  }

  attempted(id: string, now = Date.now()): string | null {
    return this.attemptBatch([id], now);
  }

  attemptBatch(ids: string[], now = Date.now()): string | null {
    if (!ids.length || new Set(ids).size !== ids.length) return null;
    const deliveryId = `delivery-${randomUUID()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.db.prepare("UPDATE resume_waits SET state = 'delivering', delivery_id = ?, attempts = attempts + 1, last_attempt_at = ?, uncertain_at = NULL, waiting_boundary = 0, error = NULL WHERE id = ? AND state = 'ready'");
      const history = this.db.prepare(`INSERT INTO resume_wait_delivery_history (wait_id, delivery_id, status, recorded_at)
        SELECT id, ?, CASE WHEN attempts = 1 THEN 'attempted' ELSE 'redelivered' END, ? FROM resume_waits WHERE id = ?`);
      for (const id of ids) {
        if (Number(statement.run(deliveryId, now, id).changes) !== 1) {
          this.db.exec('ROLLBACK'); return null;
        }
        history.run(deliveryId, now, id);
      }
      this.db.exec('COMMIT'); return deliveryId;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  saveSnapshot(id: string, deliveryId: string, snapshot: string): void {
    const changed = this.db.prepare("UPDATE resume_waits SET snapshot = ? WHERE id = ? AND delivery_id = ? AND state = 'delivering'").run(snapshot, id, deliveryId);
    if (!changed.changes) throw new Error('Wait delivery is no longer active; interruption was not sent');
  }

  defer(id: string, error: string, failed = true, now = Date.now()): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO resume_wait_delivery_history (wait_id, delivery_id, status, recorded_at, detail)
        SELECT id, ?, ?, ?, ? FROM resume_waits WHERE delivery_id = ? AND state = 'delivering'`)
        .run(id, failed ? 'deferred' : 'queued', now, error, id);
      this.db.prepare("UPDATE resume_waits SET state = 'ready', delivery_id = NULL, error = ?, failures = failures + ?, waiting_boundary = ? WHERE delivery_id = ? AND state = 'delivering'")
        .run(error, failed ? 1 : 0, failed ? 0 : 1, id);
      this.db.exec('COMMIT');
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }

  uncertain(id: string, error: string, now = Date.now()): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO resume_wait_delivery_history (wait_id, delivery_id, status, recorded_at, detail)
        SELECT id, ?, 'uncertain', ?, ? FROM resume_waits WHERE delivery_id = ? AND state = 'delivering'`).run(id, now, error, id);
      this.db.prepare("UPDATE resume_waits SET state = 'uncertain', uncertain_at = ?, error = ? WHERE delivery_id = ? AND state = 'delivering'").run(now, error, id);
      this.db.exec('COMMIT');
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }

  /** Requeue only after the uncertainty grace period; the old attempt remains receipt-addressable. */
  retryUncertain(id: string, now = Date.now()): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO resume_wait_delivery_history (wait_id, delivery_id, status, recorded_at)
        SELECT id, ?, 'retry-due', ? FROM resume_waits WHERE delivery_id = ? AND state = 'uncertain'`).run(id, now, id);
      this.db.prepare("UPDATE resume_waits SET state = 'ready', delivery_id = NULL, uncertain_at = NULL, failures = failures + 1 WHERE delivery_id = ? AND state = 'uncertain'").run(id);
      this.db.exec('COMMIT');
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }

  /** A receipt for any attempt closes its logical waits, including after a retry was dispatched. */
  confirm(deliveryId: string, now = Date.now(), owner?: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT DISTINCT w.id, w.state, w.delivery_id FROM resume_waits w
        JOIN resume_wait_delivery_history h ON h.wait_id = w.id
        WHERE h.delivery_id = ? AND h.status IN ('attempted', 'redelivered') AND (? IS NULL OR w.owner = ?)`)
        .all(deliveryId, owner ?? null, owner ?? null) as Array<{ id: string; state: string; delivery_id: string | null }>;
      let recorded = false;
      for (const row of rows) {
        if (row.state === 'consumed' && this.db.prepare(`SELECT 1 FROM resume_wait_delivery_history
          WHERE wait_id = ? AND delivery_id = ? AND status IN ('confirmed', 'confirmed-late')`).get(row.id, deliveryId)) continue;
        if (row.state === 'cancelled') continue;
        const status = row.state === 'delivering' && row.delivery_id === deliveryId ? 'confirmed' : 'confirmed-late';
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO resume_wait_delivery_history (wait_id, delivery_id, status, recorded_at)
          VALUES (?, ?, ?, ?)`).run(row.id, deliveryId, status, now);
        recorded ||= Number(inserted.changes) > 0;
        this.db.prepare("UPDATE resume_waits SET state = 'consumed', consumed_at = ?, uncertain_at = NULL, error = NULL WHERE id = ? AND state <> 'consumed'")
          .run(now, row.id);
      }
      this.db.exec('COMMIT'); return recorded;
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }

  history(waitId: string): Array<{ deliveryId: string; status: string; recordedAt: number; detail: string | null }> {
    const rows = this.db.prepare('SELECT delivery_id, status, recorded_at, detail FROM resume_wait_delivery_history WHERE wait_id = ? ORDER BY sequence')
      .all(waitId) as Array<{ delivery_id: string; status: string; recorded_at: number; detail: string | null }>;
    return rows.map(row => ({ deliveryId: row.delivery_id, status: row.status, recordedAt: Number(row.recorded_at), detail: row.detail }));
  }

  prune(now = Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000): number {
    return Number(this.db.prepare("DELETE FROM resume_waits WHERE state IN ('consumed', 'cancelled') AND consumed_at < ?").run(now - retentionMs).changes);
  }

  removeExpired(id: string, now = Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000): boolean {
    return Number(this.db.prepare("DELETE FROM resume_waits WHERE id = ? AND state <> 'consumed' AND deadline_at IS NOT NULL AND deadline_at < ?")
      .run(id, now - retentionMs).changes) === 1;
  }

  close(): void { this.db.close(); }

  private read(row: Record<string, unknown>): ResumeWait {
    if ((row.desktop_epoch_unknown !== 0 && row.desktop_epoch_unknown !== 1) || row.desktop_epoch_unknown === 1 && row.desktop_epoch !== null ||
        row.desktop_epoch !== null && (typeof row.desktop_epoch !== 'string' || !row.desktop_epoch.trim() || row.desktop_epoch.length > 256)) {
      throw new Error('Invalid wait desktop epoch status');
    }
    const legacyUnboundGeneration = row.desktop_epoch !== null && row.desktop_epoch_generation === null;
    if (row.desktop_epoch === null && row.desktop_epoch_generation !== null || row.desktop_epoch_generation !== null &&
        (typeof row.desktop_epoch_generation !== 'number' || !Number.isSafeInteger(row.desktop_epoch_generation) || row.desktop_epoch_generation < 0)) throw new Error('Invalid wait desktop epoch generation');
    return { id: String(row.id), owner: String(row.owner), workspaceId: String(row.workspace_id), desktopEpoch: legacyUnboundGeneration || row.desktop_epoch === null ? null : String(row.desktop_epoch),
      desktopEpochGeneration: legacyUnboundGeneration || row.desktop_epoch_generation === null ? null : Number(row.desktop_epoch_generation),
      desktopEpochUnknown: Number(row.desktop_epoch_unknown) === 1 || legacyUnboundGeneration,
      condition: JSON.parse(String(row.condition_json)) as WaitCondition, note: String(row.note),
      priority: row.priority as DeliveryPriority, createdAt: Number(row.created_at),
      deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at), eventCursor: Number(row.event_cursor),
      state: row.state as ResumeWait['state'], trigger: row.trigger === null ? null : String(row.trigger),
      triggerId: row.trigger_id === null ? null : String(row.trigger_id), fireInstanceId: row.fire_instance_id === null ? null : String(row.fire_instance_id),
      deliveryId: row.delivery_id === null ? null : String(row.delivery_id),
      attempts: Number(row.attempts), failures: Number(row.failures), waitingForBoundary: Number(row.waiting_boundary) === 1,
      lastAttemptAt: row.last_attempt_at === null ? null : Number(row.last_attempt_at), uncertainAt: row.uncertain_at === null ? null : Number(row.uncertain_at),
      error: row.error === null ? null : String(row.error), consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
      snapshot: row.snapshot === null ? null : String(row.snapshot) };
  }
}
