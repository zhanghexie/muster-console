import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import { legacyReceiptPreview, type GlobalLegacyReceipt } from './globalDesktopLegacy';

export type GlobalWritePhase = 'prepared' | 'known' | 'unknown';
export interface GlobalWriteMarker {
  readonly operationId: string;
  readonly requestHash: string;
  readonly contextHash: string;
  readonly fingerprintHash: string;
  readonly phase: GlobalWritePhase;
  readonly resultHash: string | null;
  readonly tokenHash: string | null;
}

export interface GlobalLegacyEpoch {
  readonly manifestHash: string;
  readonly receiptCount: number;
  readonly dispatchCount: number;
  readonly launchCount: number;
  readonly delivery: 'unverified';
}

export const globalWriteDigest = (value: string): string => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const phases = ['prepared', 'known', 'unknown'];
const CREATE_CONTROL_V2 = `CREATE TABLE global_desktop_control (
  slot INTEGER PRIMARY KEY CHECK(slot=1), version INTEGER NOT NULL CHECK(version=2), instance TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK(ready IN (0,1)), history_count INTEGER NOT NULL CHECK(history_count>=0),
  history_hash TEXT NOT NULL CHECK(length(history_hash)=64 AND history_hash NOT GLOB '*[^0-9a-f]*'))`;
const CREATE_HISTORY_V2 = `CREATE TABLE global_desktop_history (
  request_hash TEXT PRIMARY KEY, context_hash TEXT NOT NULL, fingerprint_hash TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL, result_hash TEXT, token_hash TEXT, audit_hash TEXT, resolution TEXT,
  CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(context_hash)=64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(fingerprint_hash)=64 AND fingerprint_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(result_hash IS NULL OR (length(result_hash)=64 AND result_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(token_hash IS NULL OR (length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK(audit_hash IS NULL OR (length(audit_hash)=64 AND audit_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK((phase IN ('prepared','unknown') AND result_hash IS NULL AND token_hash IS NULL AND audit_hash IS NULL AND resolution IS NULL) OR
        (phase='known' AND result_hash IS NOT NULL AND token_hash IS NOT NULL AND audit_hash IS NULL AND resolution IS NULL) OR
        (phase='confirmed' AND result_hash IS NOT NULL AND token_hash IS NOT NULL AND audit_hash IS NOT NULL AND resolution IS NULL) OR
        (phase='resolved' AND audit_hash IS NOT NULL AND resolution IS NOT NULL AND resolution IN ('confirmed-applied','confirmed-not-applied') AND
          ((result_hash IS NULL AND token_hash IS NULL) OR (result_hash IS NOT NULL AND token_hash IS NOT NULL))) OR
        (phase='acknowledged-unknown' AND audit_hash IS NOT NULL AND resolution IS NULL AND
          ((result_hash IS NULL AND token_hash IS NULL) OR (result_hash IS NOT NULL AND token_hash IS NOT NULL)))))`;
const CREATE_MARKER = `CREATE TABLE global_desktop_marker (
  slot INTEGER PRIMARY KEY CHECK(slot=1), request_hash TEXT NOT NULL UNIQUE REFERENCES global_desktop_history(request_hash), operation_id TEXT NOT NULL UNIQUE)`;
const CREATE_HISTORY_INDEXES = `CREATE INDEX global_desktop_history_phase ON global_desktop_history(phase);
  CREATE UNIQUE INDEX global_desktop_unknown_event ON global_desktop_history(audit_hash) WHERE phase='acknowledged-unknown'`;

/** A transaction rejected a request before writing any part of that request. */
export class GlobalDesktopWriteRejected extends Error {
  constructor(message: string) { super(message); this.name = 'GlobalDesktopWriteRejected'; }
}

/** The same host-owned request identity was used with different parameters. */
export class GlobalDesktopWriteConflict extends GlobalDesktopWriteRejected {
  constructor() { super('Desktop request ID was already used for a different operation'); this.name = 'GlobalDesktopWriteConflict'; }
}

type RecordedRequest = Readonly<{ operationId: string }>;
type BeginResult = { kind: 'recorded'; request: RecordedRequest } | { kind: 'started'; marker: GlobalWriteMarker };

function transaction<T>(db: DatabaseSync, fn: () => T, readOnly = false): T {
  db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) {
    try { db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Global desktop barrier transaction outcome is unknown'); }
    throw error;
  }
}

/** Private, shared SQLite store; never create a missing store during ordinary open. */
export class GlobalDesktopWriteStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private schemaVersion: 1 | 2 = 2;
  private expectedReady: 0 | 1;

  constructor(file: string, create: boolean, private readonly assertMigration?: () => void) {
    if (!path.isAbsolute(file)) throw new Error('Global desktop barrier database path must be absolute');
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Global desktop barrier database is not a regular file');
    this.db = new DatabaseSync(sqliteFilePath(file));
    this.expectedReady = create ? 0 : 1;
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON');
      if (create) this.db.exec(`
        ${CREATE_CONTROL_V2};
        INSERT INTO global_desktop_control(slot,version,instance,ready,history_count,history_hash)
          VALUES (1,2,'${randomUUID()}',0,0,'${globalWriteDigest('')}');
        ${CREATE_HISTORY_V2};
        ${CREATE_HISTORY_INDEXES};
        ${CREATE_MARKER};
        CREATE TABLE global_desktop_legacy_control (
          slot INTEGER PRIMARY KEY CHECK(slot=1), receipt_count INTEGER NOT NULL CHECK(receipt_count>=0),
          manifest_hash TEXT NOT NULL);
        INSERT INTO global_desktop_legacy_control VALUES (1,0,'${globalWriteDigest('[]')}');
        CREATE TABLE global_desktop_legacy_receipts (
          root_hash TEXT NOT NULL, request_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, result_hash TEXT NOT NULL,
          format TEXT NOT NULL, delivery_state TEXT NOT NULL CHECK(delivery_state='unverified'),
          PRIMARY KEY(root_hash,request_hash));
        CREATE INDEX global_desktop_legacy_request ON global_desktop_legacy_receipts(request_hash);`);
      const checked = this.db.prepare('PRAGMA quick_check(1)').get();
      if (!checked || Object.values(checked)[0] !== 'ok') throw new Error('Global desktop barrier integrity check failed');
      const control = this.db.prepare('SELECT slot,version,instance,ready FROM global_desktop_control').all();
      if (control.length !== 1 || control[0].slot !== 1 || ![1, 2].includes(control[0].version as number) ||
          (create && control[0].version !== 2) || typeof control[0].instance !== 'string' ||
          !uuidPattern.test(control[0].instance) || control[0].ready !== this.expectedReady) {
        throw new Error('Global desktop barrier is not fully activated');
      }
      this.schemaVersion = control[0].version as 1 | 2;
      if (this.schemaVersion === 1) this.migrateV1();
      else this.read();
    } catch (error) { this.db.close(); throw error; }
  }

  /** Upgrade the CHECK-constrained history and marker atomically; preserve every request identity. */
  private migrateV1(): void {
    transaction(this.db, () => {
      const control = this.db.prepare('SELECT slot,version,instance,ready FROM global_desktop_control').all();
      if (control.length !== 1 || control[0].slot !== 1 || ![1, 2].includes(control[0].version as number) ||
          typeof control[0].instance !== 'string' || !uuidPattern.test(control[0].instance) || control[0].ready !== 1) {
        throw new Error('Global desktop barrier is not fully activated');
      }
      // Another opener may have committed the same migration while we waited.
      this.schemaVersion = control[0].version as 1 | 2;
      this.read();
      if (this.schemaVersion === 2) return;
      if (typeof this.assertMigration !== 'function') throw new Error('A trusted exclusive storage migration fence is required');
      this.assertMigration();
      if (this.db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Global desktop barrier foreign keys are invalid');
      if (this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='trigger' AND
          tbl_name IN ('global_desktop_control','global_desktop_history','global_desktop_marker') LIMIT 1`).get()) {
        throw new Error('Unexpected global desktop trigger prevents schema migration');
      }
      this.db.exec(`
        ALTER TABLE global_desktop_marker RENAME TO global_desktop_marker_v1;
        ALTER TABLE global_desktop_history RENAME TO global_desktop_history_v1;
        ALTER TABLE global_desktop_control RENAME TO global_desktop_control_v1;
        DROP INDEX global_desktop_history_phase;
        ${CREATE_CONTROL_V2};
        INSERT INTO global_desktop_control(slot,version,instance,ready,history_count,history_hash)
          SELECT slot,2,instance,ready,0,'${globalWriteDigest('')}' FROM global_desktop_control_v1;
        ${CREATE_HISTORY_V2};
        INSERT INTO global_desktop_history(request_hash,context_hash,fingerprint_hash,operation_id,phase,result_hash,token_hash,audit_hash,resolution)
          SELECT request_hash,context_hash,fingerprint_hash,operation_id,phase,result_hash,token_hash,audit_hash,resolution FROM global_desktop_history_v1;
        ${CREATE_HISTORY_INDEXES};
        ${CREATE_MARKER};
        INSERT INTO global_desktop_marker(slot,request_hash,operation_id)
          SELECT slot,request_hash,operation_id FROM global_desktop_marker_v1;
        DROP TABLE global_desktop_marker_v1;
        DROP TABLE global_desktop_history_v1;
        DROP TABLE global_desktop_control_v1;`);
      this.schemaVersion = 2;
      this.updateHistoryManifest();
      if (this.db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Migrated global desktop foreign keys are invalid');
      const checked = this.db.prepare('PRAGMA quick_check(1)').get();
      if (!checked || Object.values(checked)[0] !== 'ok') throw new Error('Migrated global desktop integrity check failed');
      this.read();
      this.assertMigration();
    });
  }

  /** Detect lost or altered request history; this is not a signature against a privileged DB editor. */
  private historyManifest(): { count: number; hash: string } {
    const digest = createHash('sha256');
    let count = 0;
    const rows = this.db.prepare(`SELECT request_hash,context_hash,fingerprint_hash,operation_id,phase,result_hash,token_hash,audit_hash,resolution
      FROM global_desktop_history ORDER BY request_hash`).iterate();
    for (const row of rows) {
      if (!Number.isSafeInteger(++count)) throw new Error('Global desktop history is too large');
      digest.update(JSON.stringify([row.request_hash, row.context_hash, row.fingerprint_hash, row.operation_id, row.phase,
        row.result_hash, row.token_hash, row.audit_hash, row.resolution]));
      digest.update('\n');
    }
    return { count, hash: digest.digest('hex') };
  }

  private updateHistoryManifest(): void {
    const manifest = this.historyManifest();
    const changed = this.db.prepare('UPDATE global_desktop_control SET history_count=?,history_hash=? WHERE slot=1 AND version=2 AND ready=?')
      .run(manifest.count, manifest.hash, this.expectedReady);
    if (Number(changed.changes) !== 1) throw new Error('Global desktop history manifest was not persisted');
  }

  /** Install the inspected legacy ledger before sealing; never mark it delivered. */
  importLegacyReceipts(receipts: readonly GlobalLegacyReceipt[], assertAuthorized: () => void): void {
    const preview = legacyReceiptPreview(receipts);
    if (typeof assertAuthorized !== 'function') throw new Error('A host-owned legacy transition fence is required');
    transaction(this.db, () => {
      assertAuthorized();
      const control = this.db.prepare('SELECT ready FROM global_desktop_control WHERE slot=1').get();
      if (!control || control.ready !== 0 || this.db.prepare('SELECT 1 FROM global_desktop_legacy_receipts LIMIT 1').get()) {
        throw new Error('Legacy desktop receipt import was already started');
      }
      const insert = this.db.prepare(`INSERT INTO global_desktop_legacy_receipts
        (root_hash,request_hash,fingerprint,result_hash,format,delivery_state) VALUES (?,?,?,?,?,'unverified')`);
      for (const row of receipts) insert.run(row.rootHash, row.requestHash, row.fingerprint, row.resultHash, row.format);
      const updated = this.db.prepare('UPDATE global_desktop_legacy_control SET receipt_count=?,manifest_hash=? WHERE slot=1')
        .run(preview.receiptCount, preview.manifestHash);
      if (Number(updated.changes) !== 1) throw new Error('Legacy desktop receipt import was not persisted');
      this.legacyEpoch();
      assertAuthorized();
    });
  }

  /** Validate the entire bounded ledger on every use; missing or changed rows fail closed. */
  legacyEpoch(): GlobalLegacyEpoch | null {
    const control = this.db.prepare('SELECT slot,receipt_count,manifest_hash FROM global_desktop_legacy_control').all();
    if (control.length !== 1 || control[0].slot !== 1 || !Number.isSafeInteger(control[0].receipt_count) ||
        typeof control[0].manifest_hash !== 'string' || !hashPattern.test(control[0].manifest_hash)) {
      throw new Error('Invalid legacy desktop epoch');
    }
    const rows = this.db.prepare(`SELECT root_hash AS rootHash,request_hash AS requestHash,fingerprint,result_hash AS resultHash,format,delivery_state AS deliveryState
      FROM global_desktop_legacy_receipts LIMIT 10001`).all();
    if (rows.some(row => row.deliveryState !== 'unverified')) throw new Error('Invalid legacy desktop delivery state');
    const receipts = rows.map(row => ({ rootHash: row.rootHash as string, requestHash: row.requestHash as string,
      fingerprint: row.fingerprint as string, resultHash: row.resultHash as string, format: row.format as GlobalLegacyReceipt['format'] }));
    const preview = legacyReceiptPreview(receipts);
    if (preview.receiptCount !== control[0].receipt_count || preview.manifestHash !== control[0].manifest_hash) {
      throw new Error('Legacy desktop epoch does not match its receipt ledger');
    }
    return preview.receiptCount ? Object.freeze({ manifestHash: preview.manifestHash, receiptCount: preview.receiptCount,
      dispatchCount: preview.dispatchCount, launchCount: preview.launchCount, delivery: 'unverified' as const }) : null;
  }

  /** Finish activation only while the host still holds its transition fence. */
  seal(assertAuthorized: () => void): void {
    if (typeof assertAuthorized !== 'function') throw new Error('A global desktop activation proof is required');
    transaction(this.db, () => {
      assertAuthorized();
      const updated = this.db.prepare('UPDATE global_desktop_control SET ready=1 WHERE slot=1 AND version=2 AND ready=0').run();
      if (Number(updated.changes) !== 1) throw new Error('Global desktop barrier activation changed');
      assertAuthorized();
    });
    this.expectedReady = 1;
  }

  /** A missing marker with an unresolved history row is also corruption and blocks writes. */
  read(): GlobalWriteMarker | null {
    // Inspection must see the control manifest and history from the same
    // SQLite snapshot even while another process commits a write.
    return this.db.isTransaction ? this.readSnapshot() : transaction(this.db, () => this.readSnapshot(), true);
  }

  private readSnapshot(): GlobalWriteMarker | null {
    const control = this.db.prepare('SELECT slot,version,instance,ready FROM global_desktop_control').all();
    if (control.length !== 1 || control[0].slot !== 1 || control[0].version !== this.schemaVersion || control[0].ready !== this.expectedReady ||
        typeof control[0].instance !== 'string' || !uuidPattern.test(control[0].instance)) {
      throw new Error('Global desktop barrier control changed');
    }
    this.legacyEpoch();
    if (this.schemaVersion === 2) {
      const indexes = this.db.prepare("PRAGMA index_list('global_desktop_history')").all();
      const index = indexes.find(row => row.name === 'global_desktop_unknown_event');
      const columns = this.db.prepare("PRAGMA index_info('global_desktop_unknown_event')").all();
      if (!index || index.unique !== 1 || index.partial !== 1 || columns.length !== 1 || columns[0].name !== 'audit_hash' ||
          this.db.prepare(`SELECT 1 FROM global_desktop_history WHERE phase='acknowledged-unknown'
            GROUP BY audit_hash HAVING count(*)>1 LIMIT 1`).get()) throw new Error('Invalid global desktop continuation event index');
    }
    const invalid = this.db.prepare(`SELECT 1 FROM global_desktop_history WHERE
      typeof(request_hash)!='text' OR length(request_hash)!=64 OR request_hash GLOB '*[^0-9a-f]*' OR
      typeof(context_hash)!='text' OR length(context_hash)!=64 OR context_hash GLOB '*[^0-9a-f]*' OR
      typeof(fingerprint_hash)!='text' OR length(fingerprint_hash)!=64 OR fingerprint_hash GLOB '*[^0-9a-f]*' OR
      typeof(operation_id)!='text' OR length(operation_id)!=36 OR operation_id NOT GLOB '????????-????-4???-[89ab]???-????????????' OR
      length(replace(operation_id,'-',''))!=32 OR replace(operation_id,'-','') GLOB '*[^0-9a-f]*' OR typeof(phase)!='text' OR
      phase NOT IN ('prepared','known','unknown','confirmed','resolved'${this.schemaVersion === 2 ? ",'acknowledged-unknown'" : ''}) OR
      (phase='confirmed' AND (typeof(result_hash)!='text' OR length(result_hash)!=64 OR result_hash GLOB '*[^0-9a-f]*' OR
        typeof(token_hash)!='text' OR length(token_hash)!=64 OR token_hash GLOB '*[^0-9a-f]*' OR
        typeof(audit_hash)!='text' OR length(audit_hash)!=64 OR audit_hash GLOB '*[^0-9a-f]*' OR resolution IS NOT NULL)) OR
      (phase='resolved' AND (typeof(audit_hash)!='text' OR length(audit_hash)!=64 OR audit_hash GLOB '*[^0-9a-f]*' OR
        typeof(resolution)!='text' OR resolution NOT IN ('confirmed-applied','confirmed-not-applied') OR
        NOT ((result_hash IS NULL AND token_hash IS NULL) OR
          (typeof(result_hash)='text' AND length(result_hash)=64 AND result_hash NOT GLOB '*[^0-9a-f]*' AND
           typeof(token_hash)='text' AND length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*')))) OR
      (phase='acknowledged-unknown' AND (typeof(audit_hash)!='text' OR length(audit_hash)!=64 OR audit_hash GLOB '*[^0-9a-f]*' OR resolution IS NOT NULL OR
        NOT ((result_hash IS NULL AND token_hash IS NULL) OR
          (typeof(result_hash)='text' AND length(result_hash)=64 AND result_hash NOT GLOB '*[^0-9a-f]*' AND
           typeof(token_hash)='text' AND length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*')))) LIMIT 1`).get();
    if (invalid) throw new Error('Invalid global desktop action history');
    if (this.schemaVersion === 2) {
      const recorded = this.db.prepare('SELECT history_count,history_hash FROM global_desktop_control WHERE slot=1').get();
      if (!recorded || !Number.isSafeInteger(recorded.history_count) || typeof recorded.history_hash !== 'string' ||
          !hashPattern.test(recorded.history_hash)) throw new Error('Invalid global desktop action history manifest');
      const actual = this.historyManifest();
      if (actual.count !== recorded.history_count || actual.hash !== recorded.history_hash) throw new Error('Invalid global desktop action history integrity');
    }
    const pending = this.db.prepare(`SELECT request_hash,context_hash,fingerprint_hash,operation_id,phase,result_hash,token_hash,audit_hash,resolution
      FROM global_desktop_history WHERE phase IN ('prepared','known','unknown') LIMIT 2`).all();
    const markers = this.db.prepare('SELECT slot,request_hash,operation_id FROM global_desktop_marker LIMIT 2').all();
    if (!pending.length && !markers.length) return null;
    if (pending.length !== 1 || markers.length !== 1) throw new Error('Global desktop barrier is inconsistent; independent recovery is required');
    const row = pending[0], marker = markers[0];
    const hashes = [row.request_hash, row.context_hash, row.fingerprint_hash];
    if (marker.slot !== 1 || marker.request_hash !== row.request_hash || marker.operation_id !== row.operation_id ||
        hashes.some(value => typeof value !== 'string' || !hashPattern.test(value)) ||
        typeof row.operation_id !== 'string' || !uuidPattern.test(row.operation_id) ||
        typeof row.phase !== 'string' || !phases.includes(row.phase) || row.audit_hash !== null || row.resolution !== null ||
        (row.phase === 'known' ? typeof row.result_hash !== 'string' || !hashPattern.test(row.result_hash) ||
          typeof row.token_hash !== 'string' || !hashPattern.test(row.token_hash) : row.result_hash !== null || row.token_hash !== null)) {
      throw new Error('Invalid global desktop barrier; independent recovery is required');
    }
    return Object.freeze({ operationId: row.operation_id, requestHash: row.request_hash as string, contextHash: row.context_hash as string,
      fingerprintHash: row.fingerprint_hash as string, phase: row.phase as GlobalWritePhase,
      resultHash: row.result_hash as string | null, tokenHash: row.token_hash as string | null });
  }

  private candidate(requestHash: string, contextHash: string, fingerprintHash: string, legacyRequestHash: string | undefined):
    { marker: GlobalWriteMarker | null; request: RecordedRequest | null } {
    const marker = this.read(); // Includes the complete history and legacy-integrity checks.
    if (this.legacyEpoch()) {
      if (typeof legacyRequestHash !== 'string' || !hashPattern.test(legacyRequestHash)) throw new Error('A legacy request identity is required');
      // Older Win32 receipts use a different fingerprint format. Their identity
      // remains a replay guard, but cannot prove these new parameters match.
      if (this.db.prepare('SELECT 1 FROM global_desktop_legacy_receipts WHERE request_hash=? LIMIT 1').get(legacyRequestHash)) {
        throw new GlobalDesktopWriteRejected('Legacy desktop request was already used; automatic replay is forbidden');
      }
    }
    const prior = this.db.prepare('SELECT context_hash,fingerprint_hash,operation_id FROM global_desktop_history WHERE request_hash=?').get(requestHash);
    if (!prior) return { marker, request: null };
    if (prior.context_hash !== contextHash || prior.fingerprint_hash !== fingerprintHash) throw new GlobalDesktopWriteConflict();
    if (typeof prior.operation_id !== 'string' || !uuidPattern.test(prior.operation_id)) throw new Error('Invalid global desktop action history');
    return { marker, request: Object.freeze({ operationId: prior.operation_id }) };
  }

  /** A read-only SQLite snapshot is safe while another executor holds the write lock. */
  lookup(requestHash: string, contextHash: string, fingerprintHash: string, legacyRequestHash: string | undefined): RecordedRequest | null {
    if (![requestHash, contextHash, fingerprintHash].every(value => hashPattern.test(value))) throw new Error('Invalid global desktop request');
    return transaction(this.db, () => this.candidate(requestHash, contextHash, fingerprintHash, legacyRequestHash).request, true);
  }

  begin(requestHash: string, contextHash: string, fingerprintHash: string, legacyRequestHash: string | undefined,
    assertCurrent: () => void): BeginResult {
    if (![requestHash, contextHash, fingerprintHash].every(value => hashPattern.test(value)) || typeof assertCurrent !== 'function') throw new Error('Invalid global desktop request');
    return transaction(this.db, () => {
      // The lock may have been acquired after a concurrent request completed;
      // repeat the lookup in the same transaction that would insert our marker.
      const candidate = this.candidate(requestHash, contextHash, fingerprintHash, legacyRequestHash);
      if (candidate.request) return { kind: 'recorded', request: candidate.request };
      if (candidate.marker) throw new GlobalDesktopWriteRejected('Previous desktop write requires delivery or independent recovery');
      const operationId = randomUUID();
      this.db.prepare(`INSERT INTO global_desktop_history(request_hash,context_hash,fingerprint_hash,operation_id,phase)
        VALUES(?,?,?,?, 'prepared')`).run(requestHash, contextHash, fingerprintHash, operationId);
      this.db.prepare('INSERT INTO global_desktop_marker(slot,request_hash,operation_id) VALUES(1,?,?)').run(requestHash, operationId);
      this.updateHistoryManifest();
      assertCurrent();
      const result = this.read();
      if (!result || result.operationId !== operationId) throw new Error('Global desktop barrier was not persisted');
      return { kind: 'started', marker: result };
    });
  }

  outcome(marker: GlobalWriteMarker, phase: 'known' | 'unknown', resultHash: string | null, tokenHash: string | null): GlobalWriteMarker {
    if (phase === 'known' ? !resultHash || !hashPattern.test(resultHash) || !tokenHash || !hashPattern.test(tokenHash)
      : resultHash !== null || tokenHash !== null) throw new Error('Invalid global desktop outcome');
    return transaction(this.db, () => {
      const current = this.read();
      if (!current || current.operationId !== marker.operationId || current.requestHash !== marker.requestHash || current.phase !== 'prepared') {
        throw new Error('Global desktop barrier changed');
      }
      const updated = this.db.prepare(`UPDATE global_desktop_history SET phase=?,result_hash=?,token_hash=?
        WHERE request_hash=? AND operation_id=? AND phase='prepared'`).run(phase, resultHash, tokenHash, marker.requestHash, marker.operationId);
      if (Number(updated.changes) !== 1) throw new Error('Global desktop outcome was not persisted');
      this.updateHistoryManifest();
      const result = this.read();
      if (!result || result.phase !== phase || result.operationId !== marker.operationId) throw new Error('Global desktop outcome was not persisted');
      return result;
    });
  }

  /** Called only after the shared lock was released successfully. */
  finish(marker: GlobalWriteMarker, kind: 'confirmed' | 'resolved' | 'acknowledged-unknown', auditHash: string,
    resolution: 'confirmed-applied' | 'confirmed-not-applied' | null, assertAuthorized: () => void): void {
    if (!hashPattern.test(auditHash) || typeof assertAuthorized !== 'function' ||
        !['confirmed', 'resolved', 'acknowledged-unknown'].includes(kind) ||
        (kind === 'confirmed' ? resolution !== null || marker.phase !== 'known' :
          kind === 'acknowledged-unknown' ? resolution !== null : !['confirmed-applied', 'confirmed-not-applied'].includes(String(resolution)))) {
      throw new Error('Invalid global desktop recovery or delivery');
    }
    transaction(this.db, () => {
      const current = this.read();
      if (!current || JSON.stringify(current) !== JSON.stringify(marker)) throw new Error('Global desktop barrier changed');
      assertAuthorized();
      const updated = this.db.prepare(`UPDATE global_desktop_history SET phase=?,audit_hash=?,resolution=?
        WHERE request_hash=? AND operation_id=? AND phase=?`).run(kind, auditHash, resolution, marker.requestHash, marker.operationId, marker.phase);
      const removed = this.db.prepare('DELETE FROM global_desktop_marker WHERE slot=1 AND request_hash=? AND operation_id=?')
        .run(marker.requestHash, marker.operationId);
      if (Number(updated.changes) !== 1 || Number(removed.changes) !== 1) throw new Error('Global desktop barrier could not be finalized');
      this.updateHistoryManifest();
      if (this.read() !== null) throw new Error('Global desktop barrier remained active after finalization');
      assertAuthorized(); // Synchronous check before COMMIT; failures roll back the deletion.
    });
  }

  static tokenHash(marker: GlobalWriteMarker, token: string, resultHash: string): string {
    return globalWriteDigest(JSON.stringify([marker.operationId, marker.requestHash, token, resultHash]));
  }

  static tokenMatches(marker: GlobalWriteMarker, token: string): boolean {
    if (marker.phase !== 'known' || !marker.tokenHash || !marker.resultHash || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const supplied = GlobalDesktopWriteStore.tokenHash(marker, token, marker.resultHash);
    return timingSafeEqual(Buffer.from(marker.tokenHash, 'hex'), Buffer.from(supplied, 'hex'));
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
