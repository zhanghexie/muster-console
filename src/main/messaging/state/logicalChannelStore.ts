import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../../sqliteFilePath';
import type { LogicalChannel, LogicalChannelMessage, LogicalChannelNotify, LogicalChannelPermission,
  LogicalChannelRemoteAccess, LogicalChannelSource, LogicalChannelStage } from '../../../shared/messagingChannels';

const APPLICATION_ID = 0x4d43484e;
const SCHEMA_VERSION = 3;
const LEGACY_NOTIFICATION_SCHEMA = `
  ALTER TABLE channel_bindings ADD COLUMN bound_at REAL NOT NULL DEFAULT 0;
  ALTER TABLE grants ADD COLUMN linked_at REAL NOT NULL DEFAULT 0;
  CREATE TABLE legacy_notice_claims (id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE legacy_workspace_notices (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,channel_id) REFERENCES channel_bindings(workspace_id,channel_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX legacy_notices_workspace ON legacy_workspace_notices(workspace_id,channel_id,ordinal);
  CREATE TABLE legacy_notice_refs (
    ordinal INTEGER NOT NULL REFERENCES legacy_workspace_notices(ordinal) ON DELETE CASCADE,
    message_id TEXT NOT NULL, PRIMARY KEY(ordinal,message_id)
  ) STRICT;
  CREATE INDEX legacy_notice_message ON legacy_notice_refs(message_id,ordinal);
`;
const BINDING_SCHEMA = `
  CREATE TABLE channel_bindings (
    workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    generation TEXT NOT NULL UNIQUE, PRIMARY KEY(workspace_id,channel_id)
  ) STRICT;
  CREATE INDEX bindings_channel ON channel_bindings(channel_id);
  CREATE TABLE workspace_message_state (
    workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, event_key TEXT NOT NULL,
    read INTEGER NOT NULL CHECK(read IN (0,1)), processed INTEGER NOT NULL CHECK(processed IN (0,1)),
    PRIMARY KEY(workspace_id,source_id,event_key)
  ) STRICT;
  CREATE TABLE workspace_notices (
    workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, ordinal INTEGER NOT NULL REFERENCES messages(ordinal) ON DELETE CASCADE,
    PRIMARY KEY(workspace_id,channel_id,ordinal),
    FOREIGN KEY(workspace_id,channel_id) REFERENCES channel_bindings(workspace_id,channel_id) ON DELETE CASCADE
  ) STRICT;
`;
const SCHEMA = `
  CREATE TABLE channels (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
    notify TEXT NOT NULL CHECK(notify IN ('digest','wake','mute'))
  ) STRICT;
  CREATE INDEX channel_workspace ON channels(workspace_id, name, id);
  CREATE TABLE sources (
    id TEXT NOT NULL, owner TEXT NOT NULL, provider TEXT NOT NULL, bot_id TEXT NOT NULL,
    address_key TEXT, retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
    details TEXT NOT NULL CHECK(json_valid(details)), PRIMARY KEY(id, owner)
  ) STRICT;
  CREATE INDEX source_account ON sources(provider, bot_id);
  CREATE UNIQUE INDEX source_active_address ON sources(address_key) WHERE retired=0 AND address_key IS NOT NULL;
  CREATE TABLE grants (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL, source_owner TEXT NOT NULL,
    permission TEXT NOT NULL CHECK(permission IN ('read','reply')),
    notify TEXT CHECK(notify IN ('digest','wake','mute')),
    target TEXT CHECK(target IS NULL OR json_valid(target)),
    UNIQUE(channel_id, source_id), FOREIGN KEY(source_id, source_owner) REFERENCES sources(id, owner) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX grants_source ON grants(source_id, source_owner);
  CREATE UNIQUE INDEX grants_remote ON grants(source_id, source_owner) WHERE target IS NOT NULL;
  CREATE TABLE messages (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE, event_key TEXT,
    request_key TEXT UNIQUE, request_digest TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    status TEXT NOT NULL CHECK(status IN ('received','submitted','sent','failed','unknown')),
    created_at INTEGER NOT NULL, details TEXT NOT NULL CHECK(json_valid(details)),
    UNIQUE(grant_id, event_key)
  ) STRICT;
  CREATE INDEX messages_channel ON messages(channel_id, created_at, id);
  CREATE INDEX messages_notices ON messages(channel_id, ordinal)
    WHERE direction='inbound' AND json_extract(details,'$.notificationOwner')=1;
  CREATE INDEX messages_grant ON messages(grant_id, created_at, id);
  CREATE TABLE inbound_claims (
    source_id TEXT NOT NULL, event_key TEXT NOT NULL, created_at INTEGER NOT NULL,
    retained INTEGER NOT NULL CHECK(retained IN (0,1)),
    PRIMARY KEY(source_id, event_key)
  ) STRICT;
  CREATE INDEX inbound_claims_age ON inbound_claims(created_at) WHERE retained=0;
  CREATE TABLE send_receipts (
    request_key TEXT PRIMARY KEY, digest TEXT NOT NULL, message_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('submitted','sent','failed','unknown')), created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX send_receipts_age ON send_receipts(created_at);
  CREATE TABLE stages (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK(stage IN ('receive','authorized','routed','reply','failure')),
    count INTEGER NOT NULL, at INTEGER NOT NULL, sequence INTEGER NOT NULL, source_id TEXT, reason TEXT,
    PRIMARY KEY(channel_id, stage)
  ) STRICT;
  CREATE TABLE legacy_defaults (
    workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(workspace_id, source_id)
  ) STRICT;
`;

export type StoredChannel = Pick<LogicalChannel, 'id' | 'name' | 'notify'>;
export type BoundChannel = StoredChannel & { workspace_id: string; generation: string };
export type StoredGrant = {
  id: string;
  channel_id: string;
  source_id: string;
  source_owner: string;
  permission: LogicalChannelPermission;
  notify: LogicalChannelNotify | null;
  target: string | null;
};
export type StoredSource = Pick<LogicalChannelSource, 'id' | 'provider' | 'botId'> & {
  owner: string;
  retired: number;
  details: string;
};
export type StoredMessage = {
  id: string;
  grant_id: string;
  channel_id: string;
  direction: LogicalChannelMessage['direction'];
  event_key?: string | null;
  workspace_read?: number | null;
  workspace_processed?: number | null;
  workspace_notice?: number;
  status: Exclude<LogicalChannelMessage['status'], 'draft'>;
  created_at: number;
  details: string;
};
export type StoredStage = { stage: LogicalChannelStage; count: number; at: number; source_id: string | null; reason: string | null };

export function storedTarget(row: StoredGrant): LogicalChannelRemoteAccess | null {
  return row.target === null ? null : { kind: 'workbench' };
}

export function legacyGlobalSourceId(workspaceId: string, sourceId: string): string {
  return `legacy:${createHash('sha256').update(JSON.stringify([workspaceId, sourceId])).digest('hex')}`;
}

function migrateV1(db: DatabaseSync): void {
  db.exec(BINDING_SCHEMA);
  db.exec(`INSERT INTO channel_bindings SELECT workspace_id,id,lower(hex(randomblob(16))) FROM channels;
    INSERT INTO workspace_message_state
      SELECT c.workspace_id,g.source_id,coalesce(m.event_key,m.id),max(coalesce(json_extract(m.details,'$.read'),0)),
        max(coalesce(json_extract(m.details,'$.processed'),0))
      FROM messages m JOIN grants g ON g.id=m.grant_id JOIN channels c ON c.id=m.channel_id
      GROUP BY c.workspace_id,g.source_id,coalesce(m.event_key,m.id);
    INSERT INTO workspace_notices SELECT c.workspace_id,c.id,m.ordinal FROM messages m JOIN channels c ON c.id=m.channel_id
      WHERE m.direction='inbound' AND json_extract(m.details,'$.notificationOwner')=1;
    UPDATE grants SET target='{"kind":"workbench"}' WHERE target IS NOT NULL;
    PRAGMA defer_foreign_keys=ON;`);
  for (const row of db.prepare("SELECT id,owner FROM sources WHERE owner!=''").all()) {
    const sourceId = String(row.id), owner = String(row.owner), globalId = legacyGlobalSourceId(owner, sourceId);
    db.prepare("UPDATE sources SET id=?,details=json_set(details,'$.legacyId',?) WHERE id=? AND owner=?")
      .run(globalId, sourceId, sourceId, owner);
    db.prepare('UPDATE grants SET source_id=? WHERE source_id=? AND source_owner=?').run(globalId, sourceId, owner);
  }
}

export class LogicalChannelStore {
  private db?: DatabaseSync;
  private closed = false;
  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) throw new TypeError('Logical Channel store requires an absolute path');
  }

  database(): DatabaseSync {
    if (this.closed) throw new Error('logical-channel-store-closed');
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      if (!fs.lstatSync(this.file).isFile()) throw new Error('logical-channel-store-invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.createDatabase();
      if (!fs.lstatSync(this.file).isFile()) throw new Error('logical-channel-store-invalid');
    }
    const db = new DatabaseSync(sqliteFilePath(this.file));
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        const id = db.prepare('PRAGMA application_id').get()?.application_id;
        const version = db.prepare('PRAGMA user_version').get()?.user_version;
        if (id !== APPLICATION_ID || version !== 1 && version !== 2 && version !== SCHEMA_VERSION ||
            db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
            db.prepare('PRAGMA foreign_key_check').get()) {
          throw new Error('logical-channel-store-invalid');
        }
        if (version === 1) migrateV1(db);
        if (version !== SCHEMA_VERSION) db.exec(`${LEGACY_NOTIFICATION_SCHEMA} PRAGMA user_version=${SCHEMA_VERSION};`);
        // The previous owner may have sent a request before exiting. Never replay it.
        db.exec("UPDATE send_receipts SET status='unknown' WHERE status='submitted'; UPDATE messages SET status='unknown' WHERE status='submitted';");
      }, db);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw new Error('logical-channel-store-unavailable', { cause: error });
    }
  }

  private createDatabase(): void {
    const temporary = `${this.file}.creating-${randomUUID()}`;
    fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
    try {
      const db = new DatabaseSync(sqliteFilePath(temporary));
      try {
        db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
        this.transaction(() => db.exec(`${SCHEMA} ${BINDING_SCHEMA} ${LEGACY_NOTIFICATION_SCHEMA} PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`), db);
      } finally { db.close(); }
      try { fs.linkSync(temporary, this.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { fs.unlinkSync(temporary); }
  }

  transaction<T>(operation: () => T, db = this.database()): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.db?.close();
    this.db = undefined;
  }
}
