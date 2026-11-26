import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import { MAX_APP_RECORD_EXTENSION_BYTES, normalizeAppQueryWindow, type AppImageAsset, type AppInstallation, type AppOperation, type AppQuery, type AppRecord } from '../../shared/agentApps';
import type { AppJob, AppOutboxEvent, AppReceipt, StoredConnection } from './store';

export type AppSqliteChange =
  | { type: 'putRecordGroup'; appId: string }
  | { type: 'deleteRecordGroup'; appId: string }
  | { type: 'putRecord'; appId: string; record: AppRecord; assetIds?: string[] }
  | { type: 'deleteRecord'; appId: string; id: string }
  | { type: 'putImageAsset'; value: AppImageAsset }
  | { type: 'markImageDeleting'; appId: string; id: string }
  | { type: 'deleteImageAsset'; appId: string; id: string }
  | { type: 'putInstallation'; value: AppInstallation }
  | { type: 'deleteInstallation'; id: string }
  | { type: 'putJob'; value: AppJob }
  | { type: 'deleteJob'; id: string }
  | { type: 'putOutbox'; value: AppOutboxEvent }
  | { type: 'deleteOutbox'; id: string }
  | { type: 'putReceipt'; value: AppReceipt }
  | { type: 'deleteReceipt'; id: string }
  | { type: 'putConnection'; value: StoredConnection }
  | { type: 'deleteConnection'; id: string }
  | { type: 'putOperation'; value: AppOperation }
  | { type: 'deleteOperation'; id: string }
  | { type: 'putExtra'; id: 'feishuChats' | 'feedSyncedAt' | 'deletions' | 'uninstalledApps' | 'channelCursors'; value: unknown }
  | { type: 'deleteExtra'; id: 'feishuChats' | 'feedSyncedAt' | 'deletions' | 'uninstalledApps' | 'channelCursors' };
export type AppSqliteTable = 'installations' | 'jobs' | 'outbox' | 'receipts' | 'connections' | 'operations' | 'extras';

const schema = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE installations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE record_groups (id TEXT PRIMARY KEY);
  CREATE TABLE records (app_id TEXT NOT NULL, id TEXT NOT NULL, collection_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, record_revision INTEGER NOT NULL, status TEXT, external_id TEXT, due_at TEXT, value TEXT NOT NULL, PRIMARY KEY(app_id,id));
  CREATE INDEX records_collection_time ON records(app_id,collection_id,updated_at DESC,id);
  CREATE INDEX records_status ON records(app_id,collection_id,status,updated_at DESC,id);
  CREATE INDEX records_external_id ON records(app_id,collection_id,external_id);
  CREATE INDEX records_due_at ON records(app_id,collection_id,due_at,updated_at DESC,id);
  CREATE INDEX records_revision ON records(app_id,collection_id,record_revision);
  CREATE VIRTUAL TABLE records_fts USING fts5(app_id UNINDEXED, record_id UNINDEXED, collection_id UNINDEXED, search_text, tokenize='trigram');
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, deleting INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL);
  CREATE INDEX image_assets_owner ON image_assets(app_id);
  CREATE TABLE image_references (app_id TEXT NOT NULL, record_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(app_id,record_id,asset_id), FOREIGN KEY(app_id,record_id) REFERENCES records(app_id,id) ON DELETE CASCADE, FOREIGN KEY(asset_id) REFERENCES image_assets(id) ON DELETE RESTRICT);
  CREATE INDEX image_references_asset ON image_references(asset_id);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL, enabled INTEGER NOT NULL, value TEXT NOT NULL);
  CREATE INDEX jobs_due ON jobs(enabled,kind,due_at);
  CREATE TABLE outbox (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, next_attempt_at INTEGER NOT NULL, delivered_at INTEGER, value TEXT NOT NULL);
  CREATE INDEX outbox_due ON outbox(delivered_at,next_attempt_at);
  CREATE TABLE receipts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE connections (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE operations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE extras (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta(key,value) VALUES ('revision','0'),('records_fts_version','0');
  PRAGMA user_version=1;
`;
const tables = new Set<AppSqliteTable>(['installations', 'jobs', 'outbox', 'receipts', 'connections', 'operations', 'extras']);
const encoded = (value: unknown): string => { const result = JSON.stringify(value); if (result === undefined) throw new Error('Invalid SQLite value'); return result; };
const requiredId = (value: string): string => { if (typeof value !== 'string' || !value || value.length > 500) throw new Error('Invalid SQLite identity'); return value; };
const hotText = (value: unknown): string | null => typeof value === 'string' ? value : null;
const hotDueAt = (value: unknown): string | null => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const searchText = (values: Record<string, unknown>): string => Object.values(values).map(value => String(value ?? '')).join(' ').toLocaleLowerCase();
const rowSearchText = (row: { value: string; status: string | null; external_id: string | null; due_at: string | null }): string => {
  const payload = JSON.parse(row.value) as { values?: Record<string, unknown> };
  const values = { ...(payload.values ?? {}) };
  if (row.status !== null) values.status = row.status;
  if (row.external_id !== null) values.externalId = row.external_id;
  if (row.due_at !== null) values.dueAt = row.due_at;
  return searchText(values);
};
const ftsQuery = (value: string): string => value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
const storedRecord = (record: AppRecord): Record<string, unknown> => {
  const { id: _id, collection: _collection, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, values, ...extensions } = record;
  const extensionBytes = Buffer.byteLength(encoded(extensions), 'utf8');
  if (extensionBytes > MAX_APP_RECORD_EXTENSION_BYTES) throw new Error('Record extension fields exceed 64 KB');
  const extensionValues = { ...values };
  delete extensionValues.status;
  delete extensionValues.externalId;
  delete extensionValues.dueAt;
  return { ...extensions, values: extensionValues };
};
const loadedRecord = (row: { id: string; collection_id: string; created_at: number; updated_at: number; record_revision: number; status: string | null; external_id: string | null; due_at: string | null; value: string }): AppRecord => {
  const payload = JSON.parse(row.value) as Omit<AppRecord, 'id' | 'collection' | 'revision' | 'createdAt' | 'updatedAt' | 'values'> & { values?: Record<string, unknown> };
  const values = { ...(payload.values ?? {}) } as AppRecord['values'];
  if (row.status !== null) values.status = row.status;
  if (row.external_id !== null) values.externalId = row.external_id;
  if (row.due_at !== null) values.dueAt = row.due_at;
  return { ...payload, id: row.id, collection: row.collection_id, revision: row.record_revision, createdAt: row.created_at, updatedAt: row.updated_at, values };
};

/** Lives inside the storage worker. SQLite and row-level filtering never run on the main thread. */
export class AgentAppsSqliteRepository {
  private readonly databases = new Map<string, DatabaseSync>();
  constructor(private readonly root: string) {}
  private database(workspaceId: string): DatabaseSync {
    requiredId(workspaceId);
    const cached = this.databases.get(workspaceId); if (cached) return cached;
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, `${createHash('sha256').update(workspaceId).digest('hex')}.sqlite`);
    let exists = false;
    try { fs.statSync(file); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const db = new DatabaseSync(sqliteFilePath(file));
    try {
      db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
      if (exists) {
        const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
        if (version !== 1) throw new Error('App SQLite database version is invalid');
        const integrity = db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string } | undefined;
        if (integrity?.quick_check !== 'ok') throw new Error('App SQLite database integrity check failed');
        const found = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
        if (!['meta', 'installations', 'record_groups', 'records', 'records_fts', 'image_assets', 'image_references', 'jobs', 'outbox', 'receipts', 'connections', 'operations', 'extras'].every(name => found.has(name))) throw new Error('App SQLite database schema is incomplete');
        const columns = new Set((db.prepare('PRAGMA table_info(records)').all() as Array<{ name: string }>).map(column => column.name));
        if (columns.has('search_values') || !['created_at', 'record_revision', 'status', 'external_id', 'due_at'].every(name => columns.has(name))) throw new Error('App SQLite database schema is obsolete or incomplete');
        const identity = db.prepare("SELECT value FROM meta WHERE key='workspaceId'").get() as { value: string } | undefined;
        if (!identity || identity.value !== workspaceId) throw new Error('App SQLite workspace identity is invalid');
      } else {
        db.exec('BEGIN IMMEDIATE');
        try { db.exec(schema); db.prepare("INSERT INTO meta(key,value) VALUES ('workspaceId',?)").run(workspaceId); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const ftsVersion = (db.prepare("SELECT value FROM meta WHERE key='records_fts_version'").get() as { value?: string } | undefined)?.value;
      if (ftsVersion !== '1') {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec('DELETE FROM records_fts');
          const rows = db.prepare('SELECT app_id,id,collection_id,value,status,external_id,due_at FROM records').all() as Array<{ app_id: string; id: string; collection_id: string; value: string; status: string | null; external_id: string | null; due_at: string | null }>;
          const insert = db.prepare('INSERT INTO records_fts(app_id,record_id,collection_id,search_text) VALUES (?,?,?,?)');
          for (const row of rows) insert.run(row.app_id, row.id, row.collection_id, rowSearchText(row));
          db.prepare("INSERT INTO meta(key,value) VALUES ('records_fts_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      this.databases.set(workspaceId, db); return db;
    } catch (error) { db.close(); throw error; }
  }
  open(workspaceId: string): { revision: number } {
    const row = this.database(workspaceId).prepare("SELECT value FROM meta WHERE key='revision'").get() as { value: string } | undefined;
    const revision = Number(row?.value); if (!row || !Number.isSafeInteger(revision) || revision < 0) throw new Error('App SQLite revision is invalid');
    return { revision };
  }
  transact(workspaceId: string, expectedRevision: number, changes: AppSqliteChange[]): { revision: number } {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(changes) || changes.length > 100_000) throw new Error('Invalid SQLite transaction');
    const db = this.database(workspaceId); db.exec('BEGIN IMMEDIATE');
    try {
      const revision = this.open(workspaceId).revision;
      if (revision !== expectedRevision) throw new Error('App SQLite revision changed');
      const simple = (table: AppSqliteTable, id: string, value: unknown) => db.prepare(`INSERT INTO ${table}(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(requiredId(id), encoded(value));
      const remove = (table: AppSqliteTable, id: string) => db.prepare(`DELETE FROM ${table} WHERE id=?`).run(requiredId(id));
      for (const change of changes) switch (change.type) {
        case 'putRecordGroup': db.prepare('INSERT OR IGNORE INTO record_groups(id) VALUES (?)').run(requiredId(change.appId)); break;
        case 'deleteRecordGroup': db.prepare('DELETE FROM records WHERE app_id=?').run(requiredId(change.appId)); db.prepare('DELETE FROM records_fts WHERE app_id=?').run(requiredId(change.appId)); db.prepare('DELETE FROM record_groups WHERE id=?').run(change.appId); break;
        case 'putRecord': {
          const record = change.record, appId = requiredId(change.appId);
          if (!record || !Number.isFinite(record.updatedAt) || !Number.isSafeInteger(record.revision) || record.revision < 0 || !record.values || typeof record.values !== 'object') throw new Error('Invalid app record');
          const status = hotText(record.values.status), externalId = hotText(record.values.externalId), dueAt = hotDueAt(record.values.dueAt);
          db.prepare('INSERT OR IGNORE INTO record_groups(id) VALUES (?)').run(appId);
          db.prepare('INSERT INTO records(app_id,id,collection_id,created_at,updated_at,record_revision,status,external_id,due_at,value) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(app_id,id) DO UPDATE SET collection_id=excluded.collection_id,created_at=excluded.created_at,updated_at=excluded.updated_at,record_revision=excluded.record_revision,status=excluded.status,external_id=excluded.external_id,due_at=excluded.due_at,value=excluded.value')
            .run(appId, requiredId(record.id), requiredId(record.collection), record.createdAt, record.updatedAt, record.revision, status, externalId, dueAt, encoded(storedRecord(record)));
          db.prepare('DELETE FROM records_fts WHERE app_id=? AND record_id=?').run(appId, requiredId(record.id));
          db.prepare('INSERT INTO records_fts(app_id,record_id,collection_id,search_text) VALUES (?,?,?,?)').run(appId, requiredId(record.id), requiredId(record.collection), searchText(record.values));
          if (change.assetIds !== undefined) {
            if (!Array.isArray(change.assetIds) || change.assetIds.length > 40) throw new Error('Invalid image references');
            const ids = [...new Set(change.assetIds)];
            for (const id of ids) if (!db.prepare('SELECT 1 FROM image_assets WHERE id=? AND app_id=? AND deleting=0').get(requiredId(id), appId)) throw new Error('Image asset is unavailable to this app');
            db.prepare('DELETE FROM image_references WHERE app_id=? AND record_id=?').run(appId, record.id);
            for (const id of ids) db.prepare('INSERT INTO image_references(app_id,record_id,asset_id) VALUES (?,?,?)').run(appId, record.id, id);
          }
          break;
        }
        case 'deleteRecord': db.prepare('DELETE FROM records WHERE app_id=? AND id=?').run(requiredId(change.appId), requiredId(change.id)); db.prepare('DELETE FROM records_fts WHERE app_id=? AND record_id=?').run(requiredId(change.appId), requiredId(change.id)); break;
        case 'putImageAsset': {
          const value = change.value;
          if (!value || !/^[0-9a-f-]{36}$/i.test(value.id) || !value.appId || value.deleting || !['image/jpeg', 'image/png', 'image/webp'].includes(value.mime) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 || !/^[a-f0-9]{64}$/.test(value.sha256) || !/^[a-f0-9]{64}$/.test(value.thumbnailSha256)) throw new Error('Invalid image asset');
          if (db.prepare('SELECT 1 FROM image_assets WHERE id=?').get(value.id)) throw new Error('Image asset already exists');
          db.prepare('INSERT INTO image_assets(id,app_id,deleting,value) VALUES (?,?,0,?)').run(value.id, requiredId(value.appId), encoded(value));
          break;
        }
        case 'markImageDeleting': {
          const row = db.prepare('SELECT deleting,value FROM image_assets WHERE id=? AND app_id=?').get(requiredId(change.id), requiredId(change.appId)) as { deleting: number; value: string } | undefined;
          if (!row) throw new Error('Image asset not found');
          if (db.prepare('SELECT 1 FROM image_references WHERE asset_id=? LIMIT 1').get(change.id)) throw new Error('Image asset is still referenced');
          if (!row.deleting) db.prepare('UPDATE image_assets SET deleting=1,value=? WHERE id=? AND app_id=?').run(encoded({ ...JSON.parse(row.value), deleting: true }), change.id, change.appId);
          break;
        }
        case 'deleteImageAsset': {
          const result = db.prepare('DELETE FROM image_assets WHERE id=? AND app_id=? AND deleting=1').run(requiredId(change.id), requiredId(change.appId));
          if (!Number(result.changes)) throw new Error('Image asset is not marked for deletion');
          break;
        }
        case 'putInstallation': simple('installations', change.value.definition.id, change.value); break;
        case 'deleteInstallation': remove('installations', change.id); break;
        case 'putJob': db.prepare('INSERT INTO jobs(id,app_id,kind,due_at,enabled,value) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id,kind=excluded.kind,due_at=excluded.due_at,enabled=excluded.enabled,value=excluded.value').run(requiredId(change.value.id), requiredId(change.value.appId), change.value.kind, change.value.dueAt, Number(change.value.enabled), encoded(change.value)); break;
        case 'deleteJob': remove('jobs', change.id); break;
        case 'putOutbox': db.prepare('INSERT INTO outbox(id,app_id,next_attempt_at,delivered_at,value) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id,next_attempt_at=excluded.next_attempt_at,delivered_at=excluded.delivered_at,value=excluded.value').run(requiredId(change.value.id), requiredId(change.value.appId), change.value.nextAttemptAt, change.value.deliveredAt ?? null, encoded(change.value)); break;
        case 'deleteOutbox': remove('outbox', change.id); break;
        case 'putReceipt': simple('receipts', change.value.key, change.value); break;
        case 'deleteReceipt': remove('receipts', change.id); break;
        case 'putConnection': simple('connections', change.value.id, change.value); break;
        case 'deleteConnection': remove('connections', change.id); break;
        case 'putOperation': simple('operations', change.value.operationId, change.value); break;
        case 'deleteOperation': remove('operations', change.id); break;
        case 'putExtra': simple('extras', change.id, change.value); break;
        case 'deleteExtra': remove('extras', change.id); break;
        default: throw new Error('Unknown SQLite transaction operation');
      }
      db.prepare("UPDATE meta SET value=? WHERE key='revision'").run(String(revision + 1)); db.exec('COMMIT');
      return { revision: revision + 1 };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  list(workspaceId: string, table: AppSqliteTable): unknown[] {
    if (!tables.has(table)) throw new Error('Unknown SQLite table');
    return (this.database(workspaceId).prepare(`SELECT value FROM ${table} ORDER BY rowid`).all() as Array<{ value: string }>).map(row => JSON.parse(row.value));
  }
  recordAppIds(workspaceId: string): string[] {
    return (this.database(workspaceId).prepare('SELECT id FROM record_groups ORDER BY rowid').all() as Array<{ id: string }>).map(row => row.id);
  }
  recordsForApp(workspaceId: string, appId: string): AppRecord[] {
    return (this.database(workspaceId).prepare('SELECT id,collection_id,created_at,updated_at,record_revision,status,external_id,due_at,value FROM records WHERE app_id=? ORDER BY rowid').all(requiredId(appId)) as Array<Parameters<typeof loadedRecord>[0]>).map(loadedRecord);
  }
  record(workspaceId: string, appId: string, id: string): AppRecord | undefined {
    const row = this.database(workspaceId).prepare('SELECT id,collection_id,created_at,updated_at,record_revision,status,external_id,due_at,value FROM records WHERE app_id=? AND id=?').get(requiredId(appId), requiredId(id)) as Parameters<typeof loadedRecord>[0] | undefined;
    return row ? loadedRecord(row) : undefined;
  }
  imageAsset(workspaceId: string, appId: string, id: string): AppImageAsset | undefined {
    const row = this.database(workspaceId).prepare('SELECT value FROM image_assets WHERE id=? AND app_id=?').get(requiredId(id), requiredId(appId)) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as AppImageAsset : undefined;
  }
  imageAssets(workspaceId: string, appId: string): AppImageAsset[] {
    return (this.database(workspaceId).prepare('SELECT value FROM image_assets WHERE app_id=? ORDER BY rowid').all(requiredId(appId)) as Array<{ value: string }>).map(row => JSON.parse(row.value) as AppImageAsset);
  }
  allImageAssets(workspaceId: string): AppImageAsset[] {
    return (this.database(workspaceId).prepare('SELECT value FROM image_assets ORDER BY rowid').all() as Array<{ value: string }>).map(row => JSON.parse(row.value) as AppImageAsset);
  }
  imageReferenceCount(workspaceId: string, id: string): number {
    return Number((this.database(workspaceId).prepare('SELECT COUNT(*) AS n FROM image_references WHERE asset_id=?').get(requiredId(id)) as { n: number }).n);
  }
  extras(workspaceId: string): Record<string, unknown> {
    return Object.fromEntries((this.database(workspaceId).prepare('SELECT id,value FROM extras').all() as Array<{ id: string; value: string }>).map(row => [row.id, JSON.parse(row.value)]));
  }
  query(workspaceId: string, query: AppQuery): { records: AppRecord[]; total: number } {
    const db = this.database(workspaceId), params: SQLInputValue[] = [requiredId(query.appId), requiredId(query.collection ?? '')];
    const conditions = ['app_id=?', 'collection_id=?'];
    if (query.id) { conditions.push('id=?'); params.push(requiredId(query.id)); }
    if (query.search) {
      const search = query.search.toLocaleLowerCase().slice(0, 200).trim();
      if (search.length >= 3) { conditions.push('EXISTS (SELECT 1 FROM records_fts WHERE records_fts.app_id=records.app_id AND records_fts.record_id=records.id AND records_fts MATCH ?)'); params.push(ftsQuery(search)); }
      else if (search) { conditions.push('EXISTS (SELECT 1 FROM records_fts WHERE records_fts.app_id=records.app_id AND records_fts.record_id=records.id AND instr(records_fts.search_text,?) > 0)'); params.push(search); }
    }
    for (const [key, value] of Object.entries(query.filter ?? {})) {
      if (key === 'revision' && typeof value === 'number' && Number.isSafeInteger(value)) { conditions.push('record_revision=?'); params.push(value); continue; }
      if (key === 'status' && typeof value === 'string') { conditions.push('status=?'); params.push(value); continue; }
      if (key === 'externalId' && typeof value === 'string') { conditions.push('external_id=?'); params.push(value); continue; }
      if (key === 'dueAt' && typeof value === 'string') { conditions.push('due_at=?'); params.push(value); continue; }
      const jsonPath = `$.values.${JSON.stringify(key)}`;
      if (value === null) { conditions.push("json_type(value,?)='null'"); params.push(jsonPath); }
      else if (typeof value === 'boolean') { conditions.push('json_type(value,?)=?'); params.push(jsonPath, value ? 'true' : 'false'); }
      else if (typeof value === 'number' && Number.isFinite(value)) { conditions.push("json_type(value,?) IN ('integer','real') AND json_extract(value,?)=?"); params.push(jsonPath, jsonPath, value); }
      else if (typeof value === 'string') { conditions.push("json_type(value,?)='text' AND json_extract(value,?)=?"); params.push(jsonPath, jsonPath, value); }
      else throw new Error('Invalid record filter');
    }
    const where = conditions.join(' AND ');
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where}`).get(...params) as { n: number }).n);
    const { offset, limit } = normalizeAppQueryWindow(query.offset, query.limit);
    const rows = db.prepare(`SELECT id,collection_id,created_at,updated_at,record_revision,status,external_id,due_at,value FROM records WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Parameters<typeof loadedRecord>[0]>;
    return { records: rows.map(loadedRecord), total };
  }
  closeWorkspace(workspaceId: string): void {
    const db = this.databases.get(workspaceId);
    if (!db) return;
    db.close();
    this.databases.delete(workspaceId);
  }
  close(): void { for (const workspaceId of this.databases.keys()) this.closeWorkspace(workspaceId); }
}
