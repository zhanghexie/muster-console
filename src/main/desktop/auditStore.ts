import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';

const SOURCES = ['desktop', 'browser', 'extension', 'cdp'] as const;
const ACTIONS = ['list', 'look', 'read-capture', 'focus', 'launch', 'click', 'type', 'key', 'scroll', 'move', 'hover', 'drag',
  'tabs', 'snapshot', 'console', 'network', 'wait', 'downloads', 'screenshot', 'evaluate', 'open', 'activate', 'close', 'navigate',
  'fill', 'select-option', 'press-key', 'upload', 'set-viewport', 'dialog-read', 'dialog-write', 'cookies-read', 'cookies-write',
  'storage-read', 'storage-write', 'recording-start', 'recording-stop', 'recording-cancel', 'recording-status', 'cleanup'] as const;
const STAGES = ['approval', 'dispatch-intent', 'dispatch-result', 'capture-start', 'capture-result', 'read', 'reconciliation', 'reconsideration'] as const;
const RESULTS = ['allowed', 'denied', 'dispatched', 'unknown', 'failed', 'revoked'] as const;
const REFUSAL_REASONS = ['confirmation-unavailable', 'confirmation-interrupted', 'user-declined', 'invalid-response'] as const;
const RESOLUTIONS = ['confirmed-applied', 'confirmed-not-applied', 'abandoned'] as const;
export interface DesktopAuditEntry {
  sessionId: string;
  taskId: string;
  source: typeof SOURCES[number];
  action: typeof ACTIONS[number];
  stage: typeof STAGES[number];
  result: typeof RESULTS[number];
  appId?: string;
  surfaceId?: string;
  evidenceSha256?: string;
  objectFingerprint?: string;
  resolution?: typeof RESOLUTIONS[number];
  refusalReason?: typeof REFUSAL_REASONS[number];
}

const KEYS = new Set(['sessionId', 'taskId', 'source', 'action', 'stage', 'result', 'appId', 'surfaceId', 'evidenceSha256', 'objectFingerprint', 'resolution', 'refusalReason']);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function isDesktopAuditAction(value: unknown): value is DesktopAuditEntry['action'] {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

/** Durable audit of host-derived classifications only; no input text, URLs or paths. */
export class DesktopAuditStore {
  private readonly db: DatabaseSync;
  constructor(file: string, private readonly now: () => number = Date.now) {
    if (file !== ':memory:' && !path.isAbsolute(file)) throw new Error('Desktop audit path must be absolute');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(sqliteFilePath(file));
    try { this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS desktop_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, session_hash TEXT NOT NULL, task_hash TEXT NOT NULL, source TEXT NOT NULL,
        action TEXT NOT NULL, stage TEXT NOT NULL, result TEXT NOT NULL, app_hash TEXT, surface_hash TEXT,
        evidence_hash TEXT, object_hash TEXT, resolution TEXT, refusal_reason TEXT);
      CREATE INDEX IF NOT EXISTS desktop_audit_session ON desktop_audit(session_hash, sequence);`); }
    catch (error) { this.db.close(); throw error; }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const columns = this.db.prepare('PRAGMA table_info(desktop_audit)').all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === 'resolution')) this.db.exec('ALTER TABLE desktop_audit ADD COLUMN resolution TEXT');
        if (!columns.some(column => column.name === 'refusal_reason')) this.db.exec('ALTER TABLE desktop_audit ADD COLUMN refusal_reason TEXT');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }

  append(entry: DesktopAuditEntry): { id: string; sequence: number } {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !KEYS.has(key)) ||
        ![entry.sessionId, entry.taskId].every(value => typeof value === 'string' && !!value.trim() && value.length <= 256) ||
        !SOURCES.includes(entry.source) || !isDesktopAuditAction(entry.action) || !STAGES.includes(entry.stage) || !RESULTS.includes(entry.result) ||
        [entry.appId, entry.surfaceId].some(value => value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 1024)) ||
        [entry.evidenceSha256, entry.objectFingerprint].some(value => value !== undefined && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) ||
        (entry.resolution !== undefined && (!RESOLUTIONS.includes(entry.resolution) || entry.stage !== 'reconciliation')) ||
        (entry.refusalReason !== undefined && (!REFUSAL_REASONS.includes(entry.refusalReason) || entry.stage !== 'approval' || entry.result !== 'denied'))) {
      throw new Error('Invalid desktop audit entry');
    }
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid desktop audit time');
    const id = randomUUID();
    const result = this.db.prepare(`INSERT INTO desktop_audit(id, created_at, session_hash, task_hash, source, action, stage, result,
      app_hash, surface_hash, evidence_hash, object_hash, resolution, refusal_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, timestamp,
      hash(entry.sessionId), hash(entry.taskId), entry.source, entry.action, entry.stage, entry.result,
      entry.appId === undefined ? null : hash(entry.appId), entry.surfaceId === undefined ? null : hash(entry.surfaceId),
      entry.evidenceSha256 ?? null, entry.objectFingerprint ?? null, entry.resolution ?? null, entry.refusalReason ?? null);
    const sequence = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid desktop audit receipt');
    return { id, sequence };
  }

  /** Caller must bind sessionId from host context. Rows contain only fixed labels and hashes. */
  list(sessionId: string, after = 0, limit = 100): Record<string, unknown>[] {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || !Number.isSafeInteger(after) || after < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid desktop audit query');
    return this.db.prepare(`SELECT sequence, id, created_at, task_hash, source, action, stage, result, app_hash, surface_hash, evidence_hash, object_hash, resolution, refusal_reason
      FROM desktop_audit WHERE session_hash = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(hash(sessionId), after, limit) as Record<string, unknown>[];
  }

  close(): void { this.db.close(); }
}
