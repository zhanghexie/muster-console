import { PreDispatchFailure } from './preDispatchFailure';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import { DesktopTaskLock } from './taskLock';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error('Invalid desktop request');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item, depth + 1)]));
  }
  throw new Error('Invalid desktop request');
}

/** Durable, session-bound receipts. Pending after a crash is unknown and never replayed. */
export class DesktopActionIdempotency {
  private readonly db: DatabaseSync;
  private readonly lock: DesktopTaskLock;
  constructor(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Desktop receipt directory must be absolute');
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(sqliteFilePath(path.join(directory, 'action-receipts.sqlite')));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS desktop_action_receipts (
        request_hash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT);`);
    this.lock = new DesktopTaskLock(path.join(directory, 'receipt-locks'));
  }

  async run<T extends { outcome: 'dispatched' | 'unknown' }>(sessionId: string, taskId: string, requestId: string,
    request: unknown, isCurrent: () => boolean, execute: (markDispatch: () => void) => Promise<T>, signal?: AbortSignal): Promise<T | { outcome: 'unknown' }> {
    if (![sessionId, taskId].every(value => typeof value === 'string' && !!value.trim()) ||
        typeof requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(requestId) ||
        typeof isCurrent !== 'function' || typeof execute !== 'function') throw new Error('Invalid desktop request identity');
    const input = JSON.stringify(canonical(request));
    if (typeof input !== 'string' || Buffer.byteLength(input) > 65536) throw new Error('Invalid desktop request');
    const key = hash(JSON.stringify([sessionId, taskId, requestId])), fingerprint = hash(input);
    const current = () => { signal?.throwIfAborted(); if (!isCurrent()) throw new Error('Desktop caller is no longer current'); };
    const read = (): T | { outcome: 'unknown' } | undefined => {
      current();
      const old = this.db.prepare('SELECT fingerprint, state, result FROM desktop_action_receipts WHERE request_hash = ?').get(key) as
        { fingerprint: string; state: string; result: string | null } | undefined;
      if (!old) return undefined;
      if (old.fingerprint !== fingerprint) throw new Error('Desktop request ID was already used for a different operation');
      if (old.state === 'pending') return { outcome: 'unknown' as const };
      if (old.state !== 'completed' || !old.result) throw new Error('Invalid desktop action receipt');
      const result = JSON.parse(old.result) as T;
      if (!result || (result.outcome !== 'dispatched' && result.outcome !== 'unknown')) throw new Error('Invalid desktop action receipt');
      current(); return result;
    };
    const known = read();
    if (known) return known;
    return this.lock.run(key, async () => {
      const previous = read();
      if (previous) return previous;
      let marked = false;
      const markDispatch = () => {
        if (marked) throw new Error('Desktop dispatch already marked');
        try { current(); } catch (error) { throw new PreDispatchFailure(error); }
        this.db.prepare("INSERT INTO desktop_action_receipts(request_hash, fingerprint, state) VALUES (?, ?, 'pending')").run(key, fingerprint);
        marked = true;
      };
      let result: T;
      try { result = await execute(markDispatch); }
      catch (error) {
        if (error instanceof PreDispatchFailure && marked) {
          // The authority has durably cleared its journal and proved OS dispatch was not entered.
          this.db.prepare("DELETE FROM desktop_action_receipts WHERE request_hash = ? AND fingerprint = ? AND state = 'pending'").run(key, fingerprint);
        }
        throw error;
      }
      if (!marked) {
        if (result?.outcome !== 'unknown') throw new Error('Desktop dispatch was not marked');
        // A failed journal cleanup cannot prove a safe retry even though OS dispatch was not entered.
        try {
          this.db.prepare("INSERT OR IGNORE INTO desktop_action_receipts(request_hash, fingerprint, state) VALUES (?, ?, 'pending')").run(key, fingerprint);
        } catch { throw new Error('Desktop dispatch outcome unknown; receipt could not be persisted'); }
      }
      if (!result || (result.outcome !== 'dispatched' && result.outcome !== 'unknown')) throw new Error('Invalid desktop action result');
      // execute() can settle after the originating turn was stopped. Check at
      // the synchronous persistence boundary as well as at the adapter: the
      // await above gives cancellation a chance to run between those checks.
      // Never turn an interrupted result into a later known receipt.
      let recorded: T | { outcome: 'unknown' } = result;
      try { current(); } catch { recorded = { outcome: 'unknown' }; }
      const encoded = JSON.stringify(recorded);
      if (Buffer.byteLength(encoded) > 65536) throw new Error('Desktop action result is too large');
      const updated = this.db.prepare("UPDATE desktop_action_receipts SET state = 'completed', result = ? WHERE request_hash = ? AND state = 'pending'")
        .run(encoded, key);
      if (Number(updated.changes) !== 1) throw new Error('Desktop action receipt could not be persisted; outcome is unknown');
      current();
      return recorded;
    });
  }
  close(): void { this.db.close(); }
}
