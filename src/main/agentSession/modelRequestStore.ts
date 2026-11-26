import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { sqliteFilePath } from '../sqliteFilePath';
import { modelRequestSchedulerWorkspace, type ModelRequestRow, type RequestCompression } from '../../shared/modelRequest';
import type { CompressionTrace } from './drivers/pi/requestCompression';

const LIMIT = 50_000_000;
type RequestInfo = Pick<ModelRequestRow, 'at' | 'model' | 'protocol' | 'complete'>;

function directory(root: string): string {
  return userDataStorage(root).resolve('app', 'agent-inputs');
}

function database<T>(root: string, create: boolean, absent: T, use: (db: DatabaseSync) => T): T {
  const file = path.join(directory(root), 'model-requests.sqlite');
  if (!create && !fs.existsSync(file)) return absent;
  if (create) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(sqliteFilePath(file));
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    if (create) {
      db.exec(`PRAGMA auto_vacuum=FULL;
        CREATE TABLE IF NOT EXISTS recording(session TEXT PRIMARY KEY, token TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, at INTEGER NOT NULL,
          model TEXT NOT NULL, protocol TEXT NOT NULL, bytes INTEGER NOT NULL, complete INTEGER NOT NULL, digest BLOB);
        CREATE INDEX IF NOT EXISTS session_calls ON calls(session,id);
        CREATE INDEX IF NOT EXISTS oldest_calls ON calls(at,id);
        CREATE TABLE IF NOT EXISTS blocks(hash BLOB PRIMARY KEY, compressed BLOB NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS parts(call INTEGER REFERENCES calls ON DELETE CASCADE, ordinal INTEGER,
          hash BLOB NOT NULL REFERENCES blocks, PRIMARY KEY(call,ordinal)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS block_users ON parts(hash);
        CREATE TRIGGER IF NOT EXISTS reclaim AFTER DELETE ON parts BEGIN
          DELETE FROM blocks WHERE hash=OLD.hash AND NOT EXISTS (SELECT 1 FROM parts WHERE hash=OLD.hash);
        END;`);
    }
    return use(db);
  } finally { db.close(); }
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function token(db: DatabaseSync, session: string): string | null {
  const value = db.prepare('SELECT token FROM recording WHERE session=?').get(session)?.token;
  return typeof value === 'string' ? value : null;
}

export function recordingToken(root: string, session: string): string | null {
  return database(root, false, null, db => token(db, session));
}

export function setModelRequestRecording(root: string, session: string, enabled: boolean): boolean {
  if (enabled && modelRequestSchedulerWorkspace(session) === null) {
    // The GUI orphan sweep includes session directories even before the first call.
    // Scheduler keys are workspace-scoped SQLite keys, never filesystem components.
    fs.mkdirSync(userDataStorage(root).scopedPath('session', 'agent-inputs', session, id => id), { recursive: true, mode: 0o700 });
  }
  return database(root, enabled, false, db => transaction(db, () => {
    if (enabled) db.prepare('INSERT OR IGNORE INTO recording VALUES(?,?)').run(session, randomUUID());
    else db.prepare('DELETE FROM recording WHERE session=?').run(session);
    if (!enforceLimit(db)) throw new Error('Model request index exceeds capacity');
    return enabled;
  }));
}

export function clearModelRequests(root: string, session: string): void {
  database(root, false, undefined, db => transaction(db, () => {
    db.prepare('DELETE FROM recording WHERE session=?').run(session);
    db.prepare('DELETE FROM calls WHERE session=?').run(session);
  }));
}

function hash(bytes: Buffer): Buffer { return createHash('sha256').update(bytes).digest(); }

// A rolling byte hash lets block boundaries converge again after an insertion in the prompt.
function* split(body: Buffer): Generator<Buffer> {
  let start = 0;
  let rolling = 0;
  for (let i = 0; i < body.length; i++) {
    rolling = ((rolling << 1) + Math.imul(body[i]! + 1, 0x9e3779b1)) | 0;
    const length = i + 1 - start;
    if (length >= 32768 || (length >= 4096 && (rolling & 8191) === 0)) {
      yield body.subarray(start, i + 1);
      start = i + 1;
    }
  }
  if (start < body.length) yield body.subarray(start);
}

// FULL auto-vacuum truncates free pages at commit. Count indexes and manifests as well as bodies.
function enforceLimit(db: DatabaseSync, protect?: number | bigint): boolean {
  const size = db.prepare('SELECT (page_count-freelist_count)*page_size AS bytes FROM pragma_page_count,pragma_freelist_count,pragma_page_size');
  const oldest = db.prepare('SELECT id FROM calls ORDER BY at,id LIMIT 1');
  const remove = db.prepare('DELETE FROM calls WHERE id=?');
  while (Number(size.get()?.bytes) > LIMIT) {
    const first = oldest.get()?.id;
    if (first === undefined || Number(first) === Number(protect)) return false;
    remove.run(first);
  }
  return true;
}

function insert(db: DatabaseSync, session: string, row: RequestInfo, body: Buffer, trace?: CompressionTrace): void {
  const add = db.prepare('INSERT INTO calls(session,at,model,protocol,bytes,complete,digest) VALUES(?,?,?,?,?,?,?)');
  const args = [session, row.at, row.model, row.protocol, body.length, Number(row.complete)] as const;
  db.exec('SAVEPOINT with_body');
  const id = add.run(...args, hash(body)).lastInsertRowid;
  if (trace) {
    db.exec('CREATE TABLE IF NOT EXISTS compression(call INTEGER PRIMARY KEY REFERENCES calls ON DELETE CASCADE, count INTEGER NOT NULL, data TEXT)');
    db.prepare('INSERT INTO compression VALUES(?,?,?)').run(id, trace.items.length, trace.items.length ? JSON.stringify(trace) : null);
  }
  const exists = db.prepare('SELECT 1 FROM blocks WHERE hash=?');
  const block = db.prepare('INSERT INTO blocks VALUES(?,?)');
  const part = db.prepare('INSERT INTO parts VALUES(?,?,?)');
  let index = 0;
  for (const bytes of split(body)) {
    const digest = hash(bytes);
    if (!exists.get(digest)) block.run(digest, gzipSync(bytes, { level: 1 }));
    part.run(id, index++, digest);
  }
  if (!enforceLimit(db, id)) {
    // Never sacrifice the rest of the archive for a body we cannot retain.
    db.exec('ROLLBACK TO with_body');
    add.run(...args, null);
    if (!enforceLimit(db)) throw new Error('Model request index exceeds capacity');
  }
  db.exec('RELEASE with_body');
}

export function saveModelRequest(root: string, session: string, epoch: string, row: RequestInfo, body: Buffer, trace?: CompressionTrace): void {
  database(root, false, undefined, db => transaction(db, () => {
    if (token(db, session) === epoch) insert(db, session, row, body, trace);
  }));
}

function hasCompression(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compression'").get();
}

export function readCompressionTrace(root: string, session: string, id: number): CompressionTrace | null {
  return database<CompressionTrace | null>(root, false, null, db => {
    if (!hasCompression(db)) return null;
    const data = db.prepare('SELECT data FROM compression JOIN calls ON calls.id=compression.call WHERE session=? AND id=?').get(session, id)?.data;
    return typeof data === 'string' ? JSON.parse(data) : null;
  });
}

export function listModelRequests(root: string, session: string, before?: number): ModelRequestRow[] {
  return database<ModelRequestRow[]>(root, false, [], db => db.prepare(
    'SELECT id,at,model,protocol,bytes,complete,digest IS NULL AS omitted,' +
    (hasCompression(db) ? '(SELECT count FROM compression WHERE call=id)' : 'NULL') +
    ' AS compressionCount FROM calls WHERE session=? AND id<? ORDER BY id DESC LIMIT 50'
  ).all(session, before ?? Number.MAX_SAFE_INTEGER).map(r => ({
    id: Number(r.id), at: Number(r.at), model: String(r.model), protocol: String(r.protocol),
    bytes: Number(r.bytes), complete: !!r.complete, omitted: !!r.omitted,
    ...(typeof r.compressionCount === 'number' ? { compressionCount: r.compressionCount } : {})
  })));
}

export function readModelRequest(root: string, session: string, id: number): string | null {
  return database<string | null>(root, false, null, db => {
    // Both queries must see the same snapshot during concurrent eviction.
    db.exec('BEGIN');
    const call = db.prepare('SELECT bytes,digest FROM calls WHERE session=? AND id=?').get(session, id);
    if (!(call?.digest instanceof Uint8Array)) return null;
    return readBody(db, id, Number(call.bytes), call.digest).toString('utf8');
  });
}

function readBody(db: DatabaseSync, id: number, bytes: number, digest: Uint8Array): Buffer {
  const chunks = db.prepare('SELECT compressed FROM parts JOIN blocks USING(hash) WHERE call=? ORDER BY ordinal').iterate(id);
  const body = Buffer.concat(Array.from(chunks, r => gunzipSync(r.compressed as Uint8Array)));
  if (body.length !== bytes || !hash(body).equals(digest)) throw new Error('Model request integrity check failed');
  return body;
}

/** One read snapshot, independent of the viewer's pagination. Bodies stay byte-exact. */
export function visitModelRequests(root: string, session: string, id: number | undefined,
  visit: (row: ModelRequestRow, body: Buffer | null, compression: RequestCompression[]) => void): void {
  database(root, false, undefined, db => {
    db.exec('BEGIN');
    const compressed = hasCompression(db);
    const rows = db.prepare('SELECT * FROM calls WHERE session=?' + (id === undefined ? '' : ' AND id=?') + ' ORDER BY id');
    for (const r of rows.iterate(...(id === undefined ? [session] : [session, id]))) {
      const call = Number(r.id);
      const data = compressed ? db.prepare('SELECT data FROM compression WHERE call=?').get(call)?.data : null;
      const items: RequestCompression[] = typeof data === 'string' ? (JSON.parse(data) as CompressionTrace).items : [];
      const body = r.digest instanceof Uint8Array ? readBody(db, call, Number(r.bytes), r.digest) : null;
      visit({ id: call, at: Number(r.at), model: String(r.model), protocol: String(r.protocol), bytes: Number(r.bytes),
        complete: !!r.complete, omitted: body === null, ...(compressed ? { compressionCount: items.length } : {}) }, body, items);
    }
  });
}

// Upgrade pre-quota session archives. SQLite commits changes to both attached rollback-journal
// databases atomically; a restart can resume with precisely the remaining legacy rows.
export function migrateModelRequests(root: string): void {
  const dir = directory(root);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'model-requests.sqlite');
    if (!fs.existsSync(file)) continue;
    database(root, true, undefined, db => {
      db.prepare('ATTACH DATABASE ? AS legacy').run(sqliteFilePath(file));
      const next = db.prepare('SELECT * FROM legacy.requests ORDER BY id LIMIT 1');
      const remove = db.prepare('DELETE FROM legacy.requests WHERE id=?');
      while (transaction(db, () => {
        const row = next.get();
        if (!row) return false;
        insert(db, entry.name, { at: Number(row.at), model: String(row.model), protocol: String(row.protocol), complete: !!row.complete },
          gunzipSync(row.body as Uint8Array));
        remove.run(row.id!);
        return true;
      })) { /* bound each transaction to one call */ }
    });
    fs.rmSync(file, { force: true });
  }
}
