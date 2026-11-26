import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';

/** Host-owned resume state. A user instruction is the only way to resume an owner. */
export interface DesktopResumeState {
  hasStopped(): boolean;
  isResumed(owner: string): boolean;
  markStopped(): void;
  markResumed(owner: string): void;
  /** Only a durable state implementation can authorize a continuation across restart. */
  currentGeneration?(): number;
}

/** Durable stop generation for the workbench's own data directory. */
export class DesktopResumeStateLedger implements DesktopResumeState {
  private readonly db: DatabaseSync;
  private closed = false;
  private runPhase: 'unstarted' | 'active' | 'cleaned' | 'faulted' = 'unstarted';
  private runNonce?: string;

  constructor(file: string) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Desktop stop state path must be absolute');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let created = false;
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      created = true;
      fs.closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Desktop stop state is not a regular file');
    }
    this.db = new DatabaseSync(sqliteFilePath(file));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000');
      if (created) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE desktop_stop_generation (slot INTEGER PRIMARY KEY CHECK(slot=1), generation INTEGER NOT NULL CHECK(generation>=0));
        INSERT INTO desktop_stop_generation(slot,generation) VALUES(1,0);
        CREATE TABLE desktop_resume_owners (owner_hash TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>=1));
        CREATE TABLE desktop_host_run (slot INTEGER PRIMARY KEY CHECK(slot=1), dirty INTEGER NOT NULL CHECK(dirty IN (0,1)), nonce TEXT,
          CHECK((dirty=0 AND nonce IS NULL) OR (dirty=1 AND (nonce IS NULL OR length(nonce)=64))));
        INSERT INTO desktop_host_run(slot,dirty,nonce) VALUES(1,0,NULL);
        PRAGMA user_version=2; COMMIT;`);
      const check = this.db.prepare('PRAGMA quick_check(1)').get();
      if (!check || Object.values(check)[0] !== 'ok') throw new Error('Desktop stop state integrity check failed');
      const version = this.db.prepare('PRAGMA user_version').get();
      const number = version && Object.values(version)[0];
      if (number !== 1 && number !== 2) throw new Error('Desktop stop state was not fully initialized');
      this.db.prepare('SELECT owner_hash,generation FROM desktop_resume_owners LIMIT 0').all();
      this.generation();
      if (number === 1) this.transaction(() => {
        // An old database has no proof that its last host reclaimed every
        // backend. Keep it dirty until beginRun revokes its old authorizations.
        const current = this.db.prepare('PRAGMA user_version').get();
        if (!current || Object.values(current)[0] !== 1) throw new Error('Desktop stop state version changed');
        this.db.exec(`CREATE TABLE desktop_host_run (slot INTEGER PRIMARY KEY CHECK(slot=1), dirty INTEGER NOT NULL CHECK(dirty IN (0,1)), nonce TEXT,
          CHECK((dirty=0 AND nonce IS NULL) OR (dirty=1 AND (nonce IS NULL OR length(nonce)=64))));
          INSERT INTO desktop_host_run(slot,dirty,nonce) VALUES(1,1,NULL);
          PRAGMA user_version=2;`);
      });
      this.runState();
    } catch (error) { this.db.close(); throw error; }
  }

  /** Call only after obtaining the host's exclusive data-directory instance lock,
   * before any desktop or continuation entry can run. */
  beginRun(): { recoveredFromDirtyRun: boolean } {
    try {
      if (this.closed || this.runPhase !== 'unstarted') throw new Error('Desktop host run cannot be started');
      const nonce = randomBytes(32).toString('hex');
      let recoveredFromDirtyRun = false;
      this.transaction(() => {
        const previous = this.runState();
        recoveredFromDirtyRun = previous.dirty === 1;
        if (recoveredFromDirtyRun) this.advanceStopGeneration();
        const changed = this.db.prepare('UPDATE desktop_host_run SET dirty=1,nonce=? WHERE slot=1 AND dirty=? AND nonce IS ?')
          .run(nonce, previous.dirty, previous.nonce);
        if (Number(changed.changes) !== 1) throw new Error('Desktop host run changed');
      });
      this.runNonce = nonce;
      this.runPhase = 'active';
      return { recoveredFromDirtyRun };
    } catch (error) { this.runPhase = 'faulted'; throw error; }
  }

  /** Call only after closing all desktop entrances and confirming every backend
   * has stopped and released its input. A render flush is not that proof. */
  cleanRun(): void {
    try {
      const nonce = this.runNonce;
      if (this.closed || this.runPhase !== 'active' || !nonce) throw new Error('Desktop host run cannot be cleaned');
      this.transaction(() => {
        this.runState();
        const changed = this.db.prepare('UPDATE desktop_host_run SET dirty=0,nonce=NULL WHERE slot=1 AND dirty=1 AND nonce=?').run(nonce);
        if (Number(changed.changes) !== 1) throw new Error('Desktop host run changed');
      });
      this.runNonce = undefined;
      this.runPhase = 'cleaned';
    } catch (error) { this.runPhase = 'faulted'; throw error; }
  }

  hasStopped(): boolean { return this.generation() > 0; }
  currentGeneration(): number { return this.generation(); }

  isResumed(owner: string): boolean {
    const generation = this.generation();
    if (!generation) return false;
    const row = this.db.prepare('SELECT generation FROM desktop_resume_owners WHERE owner_hash=?').get(this.ownerHash(owner));
    if (!row) return false;
    if (!Number.isSafeInteger(row.generation) || (row.generation as number) < 1 || (row.generation as number) > generation) {
      throw new Error('Invalid desktop resume state');
    }
    return row.generation === generation;
  }

  markStopped(): void {
    this.transaction(() => this.advanceStopGeneration());
  }

  markResumed(owner: string): void {
    const hash = this.ownerHash(owner);
    this.transaction(() => {
      const generation = this.generation();
      if (!generation) return;
      this.db.prepare(`INSERT INTO desktop_resume_owners(owner_hash,generation) VALUES(?,?)
        ON CONFLICT(owner_hash) DO UPDATE SET generation=excluded.generation`).run(hash, generation);
    });
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

  private generation(): number {
    if (this.closed) throw new Error('Desktop stop state is closed');
    if (this.runPhase === 'faulted') throw new Error('Desktop stop state is unavailable');
    if (this.runPhase === 'cleaned') throw new Error('Desktop host run is closed');
    const rows = this.db.prepare('SELECT slot,generation FROM desktop_stop_generation').all();
    if (rows.length !== 1 || rows[0].slot !== 1 || !Number.isSafeInteger(rows[0].generation) || (rows[0].generation as number) < 0) {
      throw new Error('Invalid desktop stop generation');
    }
    return rows[0].generation as number;
  }

  private runState(): { dirty: number; nonce: string | null } {
    const rows = this.db.prepare('SELECT slot,dirty,nonce FROM desktop_host_run').all();
    if (rows.length !== 1 || rows[0].slot !== 1 || (rows[0].dirty !== 0 && rows[0].dirty !== 1)
      || (rows[0].dirty === 0 && rows[0].nonce !== null)
      || (rows[0].dirty === 1 && rows[0].nonce !== null
        && (typeof rows[0].nonce !== 'string' || !/^[0-9a-f]{64}$/.test(rows[0].nonce)))) {
      throw new Error('Invalid desktop host run state');
    }
    return { dirty: rows[0].dirty as number, nonce: rows[0].nonce as string | null };
  }

  /** Must be called with the SQLite write transaction held. */
  private advanceStopGeneration(): void {
    const generation = this.generation();
    if (generation >= Number.MAX_SAFE_INTEGER) throw new Error('Desktop stop generation exhausted');
    const result = this.db.prepare('UPDATE desktop_stop_generation SET generation=? WHERE slot=1 AND generation=?')
      .run(generation + 1, generation);
    if (Number(result.changes) !== 1) throw new Error('Desktop stop generation changed');
    this.db.exec('DELETE FROM desktop_resume_owners');
  }

  private ownerHash(owner: string): string {
    if (typeof owner !== 'string' || !owner.trim() || owner.length > 1024) throw new Error('Invalid desktop resume owner');
    // Hash JS code units losslessly: distinct unpaired surrogates must not
    // collapse to the same UTF-8 replacement character.
    return createHash('sha256').update(owner, 'utf16le').digest('hex');
  }

  private transaction(operation: () => void): void {
    if (this.closed) throw new Error('Desktop stop state is closed');
    this.db.exec('BEGIN IMMEDIATE');
    try { operation(); this.db.exec('COMMIT'); }
    catch (error) {
      try { this.db.exec('ROLLBACK'); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Desktop stop state transaction outcome is unknown'); }
      throw error;
    }
  }
}
