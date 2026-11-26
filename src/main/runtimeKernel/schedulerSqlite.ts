import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import { userDataStorage } from './storageRootResolver';
import { resolveChatHistoryBounds } from '../../shared/chatHistory';
import type { ArchivedToolCallSummary, ChatDisplayPart, ChatMessage, ToolCallRecord } from '../../shared/types';

export type SchedulerSqliteSnapshot = {
  display: ChatMessage[];
  api: unknown[];
  piSessionFile?: string;
  fork?: { parentSessionId: string; atSeq: number; uptoMessageId: string };
};

type StoredMessage = {
  id: string;
  ordinal: number;
  role: 'user' | 'assistant';
  created_at: number;
  finished_at: number | null;
  archived: number;
  meta_json: string;
};

type StoredPart = {
  ordinal: number;
  kind: 'text' | 'thinking' | 'tool';
  text: string | null;
  tool_id: string | null;
};

type StoredTool = {
  tool_id: string;
  ordinal: number;
  name: string;
  arguments: string | null;
  input_json: string | null;
  result: string | null;
  status: ToolCallRecord['status'];
  preview_path: string | null;
  patch: string | null;
  started_at: number | null;
  finished_at: number | null;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduler_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS scheduler_message (
    id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    meta_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS scheduler_part (
    message_id TEXT NOT NULL REFERENCES scheduler_message(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'thinking', 'tool')),
    text TEXT,
    tool_id TEXT,
    PRIMARY KEY (message_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS scheduler_tool (
    message_id TEXT NOT NULL REFERENCES scheduler_message(id) ON DELETE CASCADE,
    tool_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    arguments TEXT,
    input_json TEXT,
    result TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'cancelled')),
    preview_path TEXT,
    patch TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    PRIMARY KEY (message_id, tool_id)
  );
  CREATE INDEX IF NOT EXISTS scheduler_message_ordinal ON scheduler_message(ordinal);
  CREATE INDEX IF NOT EXISTS scheduler_tool_message_ordinal ON scheduler_tool(message_id, ordinal);
  INSERT OR IGNORE INTO scheduler_meta(key, value) VALUES
    ('api_json', '[]'), ('revision', '0');
  PRAGMA user_version = 1;
`;

const json = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Invalid scheduler SQLite value');
  return encoded;
};

const nullableJson = (value: unknown): string | null => value === undefined ? null : json(value);

export function schedulerSqlitePath(rootDir: string, sessionId: string): string {
  return userDataStorage(rootDir).scopedPath('session', 'scheduler-sessions', sessionId, id => `${id}.sqlite`);
}

function messageMeta(message: ChatMessage): string {
  const {
    id: _id,
    role: _role,
    content: _content,
    createdAt: _createdAt,
    finishedAt: _finishedAt,
    parts: _parts,
    toolCalls: _toolCalls,
    thinking: _thinking,
    archived: _archived,
    archivedTools: _archivedTools,
    ...meta
  } = message;
  return json(meta);
}

function toolArguments(tool: ToolCallRecord): string | null {
  return typeof tool.arguments === 'string' ? tool.arguments : null;
}

function partsOf(message: ChatMessage): ChatDisplayPart[] {
  if (message.parts?.length) return message.parts;
  const parts: ChatDisplayPart[] = [];
  if (message.thinking) parts.push({ kind: 'thinking', text: message.thinking });
  if (message.content) parts.push({ kind: 'text', text: message.content });
  for (const tool of message.toolCalls ?? []) parts.push({ kind: 'tool', toolCall: tool });
  return parts;
}

function archivedToolSummaries(tools: readonly StoredTool[]): ArchivedToolCallSummary[] {
  return tools.map(tool => ({ id: tool.tool_id, name: tool.name, status: tool.status }));
}

function toToolCall(tool: StoredTool): ToolCallRecord {
  const value: ToolCallRecord = {
    id: tool.tool_id,
    name: tool.name,
    arguments: tool.arguments ?? '',
    status: tool.status
  };
  if (tool.input_json) value.input = JSON.parse(tool.input_json) as Record<string, unknown>;
  if (tool.result !== null) value.result = tool.result;
  if (tool.preview_path !== null) value.previewPath = tool.preview_path;
  if (tool.patch !== null) value.patch = tool.patch;
  return value;
}

function restoreMessage(row: StoredMessage, parts: StoredPart[], tools: StoredTool[]): ChatMessage {
  const meta = JSON.parse(row.meta_json) as Omit<ChatMessage, 'id' | 'role' | 'content' | 'createdAt'>;
  const text = parts.filter(part => part.kind === 'text' && part.text !== null).map(part => part.text).join('');
  const thinking = parts.filter(part => part.kind === 'thinking' && part.text !== null).map(part => part.text).join('');
  const message: ChatMessage = {
    ...meta,
    id: row.id,
    role: row.role,
    content: text,
    createdAt: row.created_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at })
  };
  if (row.archived) {
    message.archived = true;
    if (typeof meta.archiveSummary === 'string' && meta.archiveSummary) message.archiveSummary = meta.archiveSummary;
    message.archivedTools = archivedToolSummaries(tools);
    return message;
  }
  const restoredParts: ChatDisplayPart[] = [];
  for (const part of parts) {
    if (part.kind === 'tool') {
      const tool = tools.find(item => item.tool_id === part.tool_id);
      if (tool) restoredParts.push({ kind: 'tool', toolCall: toToolCall(tool) });
    } else if (part.text !== null) restoredParts.push({ kind: part.kind, text: part.text });
  }
  if (restoredParts.length) message.parts = restoredParts;
  if (tools.length) message.toolCalls = tools.sort((a, b) => a.ordinal - b.ordinal).map(toToolCall);
  if (thinking) message.thinking = thinking;
  return message;
}

export class SchedulerSqliteStore {
  readonly file: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(rootDir: string, readonly sessionId: string) {
    this.file = schedulerSqlitePath(rootDir, sessionId);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(sqliteFilePath(this.file));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
  }

  get hasData(): boolean {
    if (Number((this.db.prepare('SELECT COUNT(*) AS n FROM scheduler_message').get() as { n: number }).n) > 0) return true;
    const row = this.db.prepare("SELECT key,value FROM scheduler_meta WHERE key IN ('api_json','pi_session_file','fork_json')").all() as Array<{ key: string; value: string | null }>;
    return row.some(item => item.key !== 'api_json' ? !!item.value : !!item.value && item.value !== '[]');
  }

  get revision(): number {
    const value = this.db.prepare("SELECT value FROM scheduler_meta WHERE key='revision'").get() as { value?: string } | undefined;
    const revision = Number(value?.value ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid scheduler SQLite revision');
    return revision;
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Scheduler SQLite rollback failed'); }
      throw error;
    }
  }

  private bumpRevision(): number {
    const next = this.revision + 1;
    this.db.prepare("UPDATE scheduler_meta SET value=? WHERE key='revision'").run(String(next));
    return next;
  }

  private insertMessage(message: ChatMessage, index?: number): void {
    const existing = this.db.prepare('SELECT ordinal FROM scheduler_message WHERE id=?').get(message.id) as { ordinal: number } | undefined;
    let ordinal = existing?.ordinal;
    if (ordinal === undefined) {
      if (index !== undefined) {
        this.db.prepare('UPDATE scheduler_message SET ordinal=-ordinal-1 WHERE ordinal>=?').run(Math.max(0, index));
        this.db.prepare('UPDATE scheduler_message SET ordinal=-ordinal WHERE ordinal<0').run();
        ordinal = Math.max(0, index);
      } else {
        const row = this.db.prepare('SELECT COALESCE(MAX(ordinal)+1,0) AS ordinal FROM scheduler_message').get() as { ordinal: number };
        ordinal = row.ordinal;
      }
    }
    const archived = message.archived === true;
    const archivedTools = message.archivedTools ?? [];
    const allTools = message.toolCalls ?? [];
    const tools = archived ? archivedTools.map((tool, toolOrdinal) => ({
      id: tool.id,
      ordinal: toolOrdinal,
      name: tool.name,
      arguments: null,
      input_json: null,
      result: null,
      status: tool.status,
      preview_path: null,
      patch: null,
      started_at: null,
      finished_at: null
    })) : allTools.map((tool, toolOrdinal) => ({
      id: tool.id,
      ordinal: toolOrdinal,
      name: tool.name,
      arguments: toolArguments(tool),
      input_json: nullableJson(tool.input),
      result: tool.result ?? null,
      status: tool.status,
      preview_path: tool.previewPath ?? null,
      patch: tool.patch ?? null,
      started_at: null,
      finished_at: null
    }));
    this.db.prepare(`INSERT INTO scheduler_message(id,ordinal,role,created_at,finished_at,archived,meta_json)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,role=excluded.role,
      created_at=excluded.created_at,finished_at=excluded.finished_at,archived=excluded.archived,
      meta_json=excluded.meta_json`)
      .run(message.id, ordinal, message.role, message.createdAt, message.finishedAt ?? null,
        archived ? 1 : 0, messageMeta(message));
    this.db.prepare('DELETE FROM scheduler_part WHERE message_id=?').run(message.id);
    this.db.prepare('DELETE FROM scheduler_tool WHERE message_id=?').run(message.id);
    if (!archived) {
      const insertPart = this.db.prepare('INSERT INTO scheduler_part(message_id,ordinal,kind,text,tool_id) VALUES(?,?,?,?,?)');
      const insertTool = this.db.prepare(`INSERT INTO scheduler_tool(message_id,tool_id,ordinal,name,arguments,input_json,result,status,preview_path,patch,started_at,finished_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      const toolById = new Map(allTools.map((tool, toolOrdinal) => [tool.id, { tool, toolOrdinal }]));
      const parts = partsOf(message);
      for (let partOrdinal = 0; partOrdinal < parts.length; partOrdinal++) {
        const part = parts[partOrdinal]!;
        if (part.kind === 'tool') insertPart.run(message.id, partOrdinal, part.kind, null, part.toolCall.id);
        else insertPart.run(message.id, partOrdinal, part.kind, part.text, null);
      }
      for (const [toolId, value] of toolById) {
        const tool = value.tool;
        insertTool.run(message.id, toolId, value.toolOrdinal, tool.name, toolArguments(tool), nullableJson(tool.input),
          tool.result ?? null, tool.status, tool.previewPath ?? null, tool.patch ?? null, null, null);
      }
    } else {
      const insertPart = this.db.prepare('INSERT INTO scheduler_part(message_id,ordinal,kind,text,tool_id) VALUES(?,?,?,?,?)');
      if (message.content) insertPart.run(message.id, 0, 'text', message.content, null);
      const insertTool = this.db.prepare(`INSERT INTO scheduler_tool(message_id,tool_id,ordinal,name,arguments,input_json,result,status,preview_path,patch,started_at,finished_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const tool of tools) insertTool.run(message.id, tool.id, tool.ordinal, tool.name, null, null, null, tool.status, null, null, null, null);
    }
  }

  writeMessage(message: ChatMessage, index?: number): number {
    return this.transaction(() => { this.insertMessage(message, index); return this.bumpRevision(); });
  }

  writeDelta(message: ChatMessage, token: string, thinking: boolean): number {
    return this.transaction(() => {
      if (thinking) {
        this.db.prepare('UPDATE scheduler_message SET meta_json=? WHERE id=?')
          .run(messageMeta(message), message.id);
      } else {
        this.db.prepare('UPDATE scheduler_message SET meta_json=? WHERE id=?')
          .run(messageMeta(message), message.id);
      }
      const kind = thinking ? 'thinking' : 'text';
      const tail = this.db.prepare('SELECT ordinal,kind FROM scheduler_part WHERE message_id=? ORDER BY ordinal DESC LIMIT 1').get(message.id) as { ordinal: number; kind: string } | undefined;
      if (tail?.kind === kind) {
        this.db.prepare('UPDATE scheduler_part SET text=COALESCE(text,\'\') || ? WHERE message_id=? AND ordinal=?').run(token, message.id, tail.ordinal);
      } else {
        this.db.prepare('INSERT INTO scheduler_part(message_id,ordinal,kind,text,tool_id) VALUES(?,?,?,?,NULL)')
          .run(message.id, (tail?.ordinal ?? -1) + 1, kind, token);
      }
      return this.bumpRevision();
    });
  }

  replaceParts(message: ChatMessage): number {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM scheduler_part WHERE message_id=?').run(message.id);
      const insertPart = this.db.prepare('INSERT INTO scheduler_part(message_id,ordinal,kind,text,tool_id) VALUES(?,?,?,?,?)');
      for (const [ordinal, part] of partsOf(message).entries()) {
        if (part.kind === 'tool') insertPart.run(message.id, ordinal, part.kind, null, part.toolCall.id);
        else insertPart.run(message.id, ordinal, part.kind, part.text, null);
      }
      const ids = (message.toolCalls ?? []).map(tool => tool.id);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM scheduler_tool WHERE message_id=? AND tool_id NOT IN (${placeholders})`).run(message.id, ...ids);
      } else {
        this.db.prepare('DELETE FROM scheduler_tool WHERE message_id=?').run(message.id);
      }
      this.db.prepare('UPDATE scheduler_message SET role=?,created_at=?,finished_at=?,archived=?,meta_json=? WHERE id=?')
        .run(message.role, message.createdAt, message.finishedAt ?? null, message.archived ? 1 : 0,
          messageMeta(message), message.id);
      return this.bumpRevision();
    });
  }

  writeTool(message: ChatMessage, tool: ToolCallRecord): number {
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO scheduler_tool(message_id,tool_id,ordinal,name,arguments,input_json,result,status,preview_path,patch,started_at,finished_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(message_id,tool_id) DO UPDATE SET ordinal=excluded.ordinal,name=excluded.name,
        arguments=excluded.arguments,input_json=excluded.input_json,result=excluded.result,status=excluded.status,
        preview_path=excluded.preview_path,patch=excluded.patch`)
        .run(message.id, tool.id, message.toolCalls?.findIndex(item => item.id === tool.id) ?? 0, tool.name,
          toolArguments(tool), nullableJson(tool.input), tool.result ?? null, tool.status,
          tool.previewPath ?? null, tool.patch ?? null, null, null);
      const part = this.db.prepare('SELECT ordinal FROM scheduler_part WHERE message_id=? AND kind=\'tool\' AND tool_id=?').get(message.id, tool.id) as { ordinal: number } | undefined;
      if (!part) {
        const tail = this.db.prepare('SELECT COALESCE(MAX(ordinal)+1,0) AS ordinal FROM scheduler_part WHERE message_id=?').get(message.id) as { ordinal: number };
        this.db.prepare('INSERT INTO scheduler_part(message_id,ordinal,kind,text,tool_id) VALUES(?,?,?,?,?)')
          .run(message.id, tail.ordinal, 'tool', null, tool.id);
      }
      this.db.prepare('UPDATE scheduler_message SET meta_json=?,finished_at=? WHERE id=?')
        .run(messageMeta(message), message.finishedAt ?? null, message.id);
      return this.bumpRevision();
    });
  }

  patchMessage(message: ChatMessage): number {
    return this.transaction(() => {
      this.db.prepare(`UPDATE scheduler_message SET role=?,created_at=?,finished_at=?,archived=?,meta_json=? WHERE id=?`)
        .run(message.role, message.createdAt, message.finishedAt ?? null, message.archived ? 1 : 0,
          messageMeta(message), message.id);
      return this.bumpRevision();
    });
  }

  writeMessages(messages: readonly ChatMessage[], api: readonly unknown[], piSessionFile?: string, fork?: SchedulerSqliteSnapshot['fork']): number {
    return this.transaction(() => {
      this.db.exec('DELETE FROM scheduler_message');
      for (const message of messages) this.insertMessage(message);
      this.db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('api_json',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json(api));
      if (piSessionFile === undefined) this.db.prepare("DELETE FROM scheduler_meta WHERE key='pi_session_file'").run();
      else this.db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('pi_session_file',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(piSessionFile);
      if (fork === undefined) this.db.prepare("DELETE FROM scheduler_meta WHERE key='fork_json'").run();
      else this.db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('fork_json',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json(fork));
      return this.bumpRevision();
    });
  }

  writeMetadata(api: readonly unknown[], piSessionFile?: string): number {
    return this.transaction(() => {
      this.db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('api_json',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json(api));
      if (piSessionFile === undefined) this.db.prepare("DELETE FROM scheduler_meta WHERE key='pi_session_file'").run();
      else this.db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('pi_session_file',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(piSessionFile);
      return this.bumpRevision();
    });
  }

  writeFork(fork: SchedulerSqliteSnapshot['fork']): number {
    return this.transaction(() => {
      this.db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('fork_json',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json(fork));
      return this.bumpRevision();
    });
  }

  archiveExpired(cutoff: number): { ids: string[]; revision: number | null } {
    const rows = this.db.prepare(`SELECT id,meta_json FROM scheduler_message
      WHERE role='assistant' AND archived=0 AND created_at<=? AND finished_at IS NOT NULL ORDER BY ordinal`).all(cutoff) as Array<{ id: string; meta_json: string }>;
    if (!rows.length) return { ids: [], revision: null };
    return this.transaction(() => {
      const toolRows = this.db.prepare('SELECT tool_id,name,status FROM scheduler_tool WHERE message_id=? ORDER BY ordinal');
      const textParts = this.db.prepare("SELECT text FROM scheduler_part WHERE message_id=? AND kind='text' ORDER BY ordinal");
      const update = this.db.prepare('UPDATE scheduler_message SET archived=1,meta_json=? WHERE id=?');
      const deleteParts = this.db.prepare('DELETE FROM scheduler_part WHERE message_id=?');
      const purgeTools = this.db.prepare(`UPDATE scheduler_tool SET arguments=NULL,input_json=NULL,result=NULL,preview_path=NULL,patch=NULL WHERE message_id=?`);
      const insertPart = this.db.prepare('INSERT INTO scheduler_part(message_id,ordinal,kind,text,tool_id) VALUES(?,?,?,?,?)');
      const ids: string[] = [];
      for (const row of rows) {
        const tools = toolRows.all(row.id) as Array<{ tool_id: string; name: string; status: ToolCallRecord['status'] }>;
        const content = (textParts.all(row.id) as Array<{ text: string | null }>).map(part => part.text ?? '').join('');
        const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
        if (!content.trim()) meta.archiveSummary = `已完成 ${tools.length} 个工具调用`;
        update.run(json(meta), row.id);
        deleteParts.run(row.id);
        if (content) insertPart.run(row.id, 0, 'text', content, null);
        purgeTools.run(row.id);
        ids.push(row.id);
      }
      return { ids, revision: this.bumpRevision() };
    });
  }

  snapshot(): SchedulerSqliteSnapshot {
    const rows = this.db.prepare('SELECT * FROM scheduler_message ORDER BY ordinal').all() as StoredMessage[];
    const partStmt = this.db.prepare('SELECT ordinal,kind,text,tool_id FROM scheduler_part WHERE message_id=? ORDER BY ordinal');
    const toolStmt = this.db.prepare('SELECT tool_id,ordinal,name,arguments,input_json,result,status,preview_path,patch,started_at,finished_at FROM scheduler_tool WHERE message_id=? ORDER BY ordinal');
    const display = rows.map(row => restoreMessage(row, partStmt.all(row.id) as StoredPart[], toolStmt.all(row.id) as StoredTool[]));
    const apiRow = this.db.prepare("SELECT value FROM scheduler_meta WHERE key='api_json'").get() as { value?: string } | undefined;
    const piRow = this.db.prepare("SELECT value FROM scheduler_meta WHERE key='pi_session_file'").get() as { value?: string } | undefined;
    const forkRow = this.db.prepare("SELECT value FROM scheduler_meta WHERE key='fork_json'").get() as { value?: string } | undefined;
    return {
      display,
      api: apiRow?.value ? JSON.parse(apiRow.value) as unknown[] : [],
      ...(piRow?.value ? { piSessionFile: piRow.value } : {}),
      ...(forkRow?.value ? { fork: JSON.parse(forkRow.value) as SchedulerSqliteSnapshot['fork'] } : {})
    };
  }

  metadata(): { piSessionFile?: string } {
    const row = this.db.prepare("SELECT value FROM scheduler_meta WHERE key='pi_session_file'").get() as { value?: string } | undefined;
    return row?.value ? { piSessionFile: row.value } : {};
  }

  page(before?: number, limit?: number, targetMessageId?: string): { messages: ChatMessage[]; before: number; total: number; hasEarlier: boolean } {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM scheduler_message').get() as { n: number }).n);
    let target: number | undefined;
    if (targetMessageId) {
      const row = this.db.prepare('SELECT ordinal FROM scheduler_message WHERE id=?').get(targetMessageId) as { ordinal?: number } | undefined;
      target = row?.ordinal ?? -1;
    }
    const bounds = resolveChatHistoryBounds(total, before, limit, target);
    const rows = this.db.prepare('SELECT * FROM scheduler_message WHERE ordinal>=? AND ordinal<? ORDER BY ordinal').all(bounds.start, bounds.end) as StoredMessage[];
    const partStmt = this.db.prepare('SELECT ordinal,kind,text,tool_id FROM scheduler_part WHERE message_id=? ORDER BY ordinal');
    const toolStmt = this.db.prepare('SELECT tool_id,ordinal,name,arguments,input_json,result,status,preview_path,patch,started_at,finished_at FROM scheduler_tool WHERE message_id=? ORDER BY ordinal');
    return {
      messages: rows.map(row => restoreMessage(row, partStmt.all(row.id) as StoredPart[], toolStmt.all(row.id) as StoredTool[])),
      before: bounds.start,
      total,
      hasEarlier: bounds.start > 0
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
    finally { this.db.close(); }
  }
}
