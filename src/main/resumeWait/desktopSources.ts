import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HostDesktopContinuation, HostDesktopContinuationOrigin } from '../../shared/hostNotification';
import { sqliteFilePath } from '../sqliteFilePath';
import type { ResumeWait, ResumeWaitStore } from './store';

type WaitSource = Pick<ResumeWait, 'id' | 'owner' | 'workspaceId' | 'condition' | 'note' | 'priority' |
  'createdAt' | 'deadlineAt' | 'desktopEpoch' | 'desktopEpochGeneration' | 'desktopEpochUnknown'>;

/** Values supplied by the authenticated host turn, never by a model or wait body. */
export type DesktopContinuationOrigin = HostDesktopContinuationOrigin;

/** Opaque to the engine; checked only by the host's desktop turn guard. */
export type DesktopContinuationDelivery = HostDesktopContinuation;

/** Immutable, host-created parts of a wait; trigger and delivery state are intentionally excluded. */
function fingerprint(wait: WaitSource): string {
  if (!wait || typeof wait.id !== 'string' || !wait.id.startsWith('wait-') || wait.id.length > 128 ||
      typeof wait.owner !== 'string' || !wait.owner.trim() || wait.owner.length > 1024 ||
      typeof wait.workspaceId !== 'string' || !wait.workspaceId.trim() || wait.workspaceId.length > 1024 ||
      typeof wait.note !== 'string' || Array.from(wait.note).length > 2000 ||
      (wait.priority !== 'normal' && wait.priority !== 'preempt') ||
      !Number.isSafeInteger(wait.createdAt) || wait.createdAt < 0 ||
      (wait.deadlineAt !== null && (!Number.isSafeInteger(wait.deadlineAt) || wait.deadlineAt < 0)) ||
      typeof wait.desktopEpochUnknown !== 'boolean') throw new Error('Invalid desktop continuation source');
  if (wait.desktopEpoch !== null && (typeof wait.desktopEpoch !== 'string' || !wait.desktopEpoch.trim() || wait.desktopEpoch.length > 256)) {
    throw new Error('Invalid desktop continuation epoch');
  }
  if (wait.desktopEpoch === null ? wait.desktopEpochGeneration !== null :
      !Number.isSafeInteger(wait.desktopEpochGeneration) || wait.desktopEpochGeneration! < 0) {
    throw new Error('Invalid desktop continuation epoch generation');
  }
  if (wait.desktopEpochUnknown && wait.desktopEpoch !== null) throw new Error('Invalid desktop continuation epoch status');
  const condition = wait.condition;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error('Invalid desktop continuation condition');
  const keys = Object.keys(condition);
  const only = (...allowed: string[]): boolean => keys.every(key => allowed.includes(key));
  const optionalText = (value: unknown, limit: number): boolean => value === undefined ||
    typeof value === 'string' && !!value.trim() && value.length <= limit;
  let serializedCondition: unknown[];
  if (condition.kind === 'mail' && only('kind', 'from', 'replyTo') && optionalText(condition.from, 100) && optionalText(condition.replyTo, 100)) {
    serializedCondition = ['mail', condition.from ?? null, condition.replyTo ?? null];
  } else if (condition.kind === 'event' && only('kind', 'source', 'types', 'scope') &&
      typeof condition.source === 'string' && !!condition.source.trim() && condition.source.length <= 100 &&
      Array.isArray(condition.types) && condition.types.length <= 20 && condition.types.every(type => typeof type === 'string' && !!type.trim() && type.length <= 100) &&
      typeof condition.scope === 'string' && condition.scope.length <= 300) {
    serializedCondition = ['event', condition.source, condition.types, condition.scope];
  } else if (condition.kind === 'session' && only('kind', 'sessionId', 'phase') &&
      typeof condition.sessionId === 'string' && !!condition.sessionId.trim() && condition.sessionId.length <= 100 &&
      (condition.phase === 'idle' || condition.phase === 'needs_you')) {
    serializedCondition = ['session', condition.sessionId, condition.phase];
  } else if (condition.kind === 'time' && only('kind', 'at') && typeof condition.at === 'string' &&
      condition.at.length <= 100 && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(condition.at) && Number.isFinite(Date.parse(condition.at))) {
    serializedCondition = ['time', condition.at];
  }
  else throw new Error('Invalid desktop continuation condition');
  const serialized = JSON.stringify([wait.id, wait.owner, wait.workspaceId, serializedCondition, wait.note,
    wait.priority, wait.createdAt, wait.deadlineAt, wait.desktopEpoch, wait.desktopEpochGeneration, wait.desktopEpochUnknown]);
  // UTF-16 preserves distinct JavaScript strings, including unpaired surrogates.
  return createHash('sha256').update(serialized, 'utf16le').digest('hex');
}

function checkGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid desktop stop generation');
}

/**
 * Host-private source ledger, separate from the wait delivery queue.
 *
 * Call record only after a host-authenticated current turn has captured the
 * durable stop generation. Queue content, IDs in prompts and tool parameters
 * are not a source of authority. The caller must compare the same durable
 * generation again at delivery and desktop use.
 */
export class DesktopContinuationSources {
  private readonly db: DatabaseSync;
  private closed = false;
  private pruneCursor = '';

  constructor(file: string) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Desktop continuation source path must be absolute');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let created = false;
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      created = true;
      fs.closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Desktop continuation source is not a regular file');
    }
    this.db = new DatabaseSync(sqliteFilePath(file));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000');
      if (created) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE desktop_continuation_sources (
          wait_id TEXT PRIMARY KEY, wait_hash TEXT NOT NULL, stop_generation INTEGER NOT NULL CHECK(stop_generation >= 0)
        );
        PRAGMA user_version=1; COMMIT;`);
      const check = this.db.prepare('PRAGMA quick_check(1)').get();
      if (!check || Object.values(check)[0] !== 'ok') throw new Error('Desktop continuation source integrity check failed');
      const version = this.db.prepare('PRAGMA user_version').get();
      if (!version || Object.values(version)[0] !== 1) throw new Error('Desktop continuation source was not fully initialized');
      this.db.prepare('SELECT wait_id,wait_hash,stop_generation FROM desktop_continuation_sources LIMIT 0').all();
    } catch (error) { this.db.close(); throw error; }
  }

  record(wait: WaitSource, origin: DesktopContinuationOrigin): void {
    this.assertOpen();
    checkGeneration(origin.stopGeneration);
    if (wait.owner !== origin.owner || wait.workspaceId !== origin.workspaceId) throw new Error('Desktop continuation owner changed');
    if (wait.desktopEpochUnknown) throw new Error('Desktop continuation task identity is unknown');
    const hash = fingerprint(wait);
    // Never overwrite a previous source for the same logical wait.
    this.db.prepare('INSERT INTO desktop_continuation_sources(wait_id,wait_hash,stop_generation) VALUES(?,?,?)')
      .run(wait.id, hash, origin.stopGeneration);
  }

  matches(wait: WaitSource, origin: DesktopContinuationOrigin): boolean {
    this.assertOpen();
    checkGeneration(origin.stopGeneration);
    if (wait.owner !== origin.owner || wait.workspaceId !== origin.workspaceId) return false;
    if (wait.desktopEpochUnknown) return false;
    const hash = fingerprint(wait);
    const row = this.db.prepare('SELECT wait_hash,stop_generation FROM desktop_continuation_sources WHERE wait_id=?').get(wait.id);
    if (!row) return false;
    if (typeof row.wait_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.wait_hash) ||
        typeof row.stop_generation !== 'number' || !Number.isSafeInteger(row.stop_generation) || row.stop_generation < 0) {
      throw new Error('Invalid desktop continuation source record');
    }
    return row.stop_generation === origin.stopGeneration && row.wait_hash === hash;
  }

  /** The caller must first remove the corresponding wait from the durable queue. */
  forget(waitId: string): void {
    this.assertOpen();
    if (typeof waitId !== 'string' || !waitId.startsWith('wait-') || waitId.length > 128) throw new Error('Invalid desktop continuation source');
    this.db.prepare('DELETE FROM desktop_continuation_sources WHERE wait_id=?').run(waitId);
  }

  /** Bounded cleanup after the queue has already removed its retained waits. */
  pruneRemoved(queue: Pick<ResumeWaitStore, 'get'>, limit = 128): void {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new Error('Invalid source cleanup limit');
    const rows = this.db.prepare('SELECT wait_id FROM desktop_continuation_sources WHERE wait_id > ? ORDER BY wait_id LIMIT ?')
      .all(this.pruneCursor, limit);
    for (const row of rows) {
      if (typeof row.wait_id !== 'string') throw new Error('Invalid desktop continuation source record');
      if (!queue.get(row.wait_id)) this.forget(row.wait_id);
      this.pruneCursor = row.wait_id;
    }
    if (rows.length < limit) this.pruneCursor = '';
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
  private assertOpen(): void { if (this.closed) throw new Error('Desktop continuation source is closed'); }
}

/** Bind every actual wait in a delivered batch; one missing or stale source denies the batch. */
export function bindDesktopContinuationDelivery(sources: DesktopContinuationSources,
  waits: readonly ResumeWait[], queue: Pick<ResumeWaitStore, 'get'>, owner: string, workspaceId: string,
  readiness?: { pending(): boolean; ready(): Promise<void>;
    currentBinding?(): { epoch: string; generation: number } | null }): DesktopContinuationDelivery {
  let snapshots: ResumeWait[];
  try { snapshots = waits.map(wait => ({ ...wait, condition: structuredClone(wait.condition) })); }
  catch (error) {
    console.error('[resume-wait] desktop continuation binding failed; desktop use remains frozen:', error);
    return Object.freeze({ allows: () => false });
  }
  return Object.freeze({ pending: () => readiness?.pending() === true,
    ready: () => readiness?.ready() ?? Promise.resolve(),
    allows(origin: DesktopContinuationOrigin): boolean {
    try {
      if (!snapshots.length || origin.owner !== owner || origin.workspaceId !== workspaceId ||
          snapshots.some(wait => wait.owner !== owner || wait.workspaceId !== workspaceId)) return false;
      const active = readiness?.currentBinding?.();
      if (readiness?.currentBinding && active !== null && (!active || typeof active.epoch !== 'string' ||
          !active.epoch.trim() || !Number.isSafeInteger(active.generation) || active.generation < 0)) return false;
      return snapshots.every(wait => {
        const current = queue.get(wait.id);
        const matchesTask = !readiness?.currentBinding || wait.desktopEpoch === null ||
          (!!active && wait.desktopEpoch === active.epoch && wait.desktopEpochGeneration === active.generation);
        return matchesTask && !!current && sources.matches(wait, origin) && sources.matches(current, origin);
      });
    } catch (error) {
      console.error('[resume-wait] desktop continuation validation failed; desktop use remains frozen:', error);
      return false;
    }
  } });
}
