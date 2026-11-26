import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import { safeScopedKey, userDataStorage } from '../runtimeKernel/storageRootResolver';
import { coerceSourceAgentIdentity } from '../../shared/subagentCharacters';
import {
  AGENT_MESSAGE_TEXT_MAX, AGENT_MESSAGE_PREVIEW_CHARS, agentMessageReplyToExists, appendAgentMessage,
  emptyAgentMessageLedger, isPendingInitialAssignment, markAgentMessagesRead, parseAgentMessageLedger,
  queryAgentMessageOutbox, type AgentMessageLedger, type AgentMessageLedgerEntry, type AgentMessageOutboxQuery,
  type AgentMessageOutboxResult, type AppendAgentMessageInput, type InitialAssignmentReceipt
} from '../../shared/agentMessage';

const MAILBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mailbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS mailbox_message (
    sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, entry_json TEXT NOT NULL, body_path TEXT
  );
  CREATE INDEX IF NOT EXISTS mailbox_message_id ON mailbox_message(id);
  INSERT OR IGNORE INTO mailbox_meta(key,value) VALUES ('schema','1'),('seq','0');
`;
export const AGENT_MESSAGES_DIR = 'agent-messages';
const USER_DATA_DIR_KEY = '__musterMessageStoreUserDataDir';
const writeChains = new Map<string, Promise<unknown>>();
const mailboxConnections = new Map<string, Opened>();
const appendListeners = new Set<(workspaceId: string, entry: AgentMessageLedgerEntry, body: string) => void>();
const changeListeners = new Set<(workspaceId: string) => void>();
function globalStore(): Record<string, unknown> { return globalThis as unknown as Record<string, unknown>; }
export function setAgentMessagesUserDataDir(dir: string): void { globalStore()[USER_DATA_DIR_KEY] = path.resolve(dir); }
function userDataDir(): string { const value = globalStore()[USER_DATA_DIR_KEY]; if (typeof value !== 'string' || !value) throw new Error('[messageStore] userData 目录未注入（setAgentMessagesUserDataDir）'); return value; }
function workspaceFileKey(id: string): string { return safeScopedKey(id.trim() || 'default'); }
export function agentMessagesFilePath(workspaceId: string): string { return userDataStorage(userDataDir()).scopedPath('workspace', 'agent-messages', workspaceId.trim() || 'default', id => `${workspaceFileKey(id)}.sqlite`); }
/** Diagnostic-only legacy path. The SQLite store never reads it. */
export function legacyAgentMessagesFilePath(root: string): string { return path.join(root, '.muster', 'messages.json'); }
export function listAgentMessageWorkspaceIds(): string[] {
  try {
    const root = userDataStorage(userDataDir()).resolve('app', 'agent-messages');
    return fs.readdirSync(root).filter(name => name.endsWith('.sqlite')).map(name => {
      const file = path.join(root, name);
      try {
        const db = new DatabaseSync(sqliteFilePath(file));
        const value = (db.prepare("SELECT value FROM mailbox_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
        close(db);
        return value?.trim() || name.slice(0, -7);
      } catch { return name.slice(0, -7); }
    });
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
type Opened = { db: DatabaseSync; file: string; size: number; mtimeMs: number };
function openMailbox(workspaceId: string, create: boolean): Opened | undefined {
  const file = agentMessagesFilePath(workspaceId);
  const cached = mailboxConnections.get(file);
  if (cached) {
    try {
      const stat = fs.statSync(file);
      if (stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) return cached;
      const header = Buffer.alloc(16);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
      if (header.toString('ascii') !== 'SQLite format 3\u0000') throw new Error('邮箱索引读取失败，已保留原文件：SQLite mailbox header is invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { cached.db.close(); } catch { /* already closed */ }
    mailboxConnections.delete(file);
  }
  if (!create && !fs.existsSync(file)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    if (fs.existsSync(file)) {
      const header = Buffer.alloc(16);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
      if (header.toString('ascii') !== 'SQLite format 3\u0000') throw new Error('SQLite mailbox header is invalid');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true }); db = new DatabaseSync(sqliteFilePath(file));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;'); db.exec(MAILBOX_SCHEMA);
    const columns = db.prepare('PRAGMA table_info(mailbox_message)').all() as Array<{ name?: string }>;
    if (!columns.some(column => column.name === 'body_path')) throw new Error('邮箱 schema v1 不支持旧的内嵌正文列，请执行发布前 reset');
    db.prepare("INSERT OR IGNORE INTO mailbox_meta(key,value) VALUES ('workspace_id',?)").run(workspaceId);
    const stat = fs.statSync(file);
    const opened = { db, file, size: stat.size, mtimeMs: stat.mtimeMs }; mailboxConnections.set(file, opened); return opened;
  } catch (error) {
    if (db) close(db);
    throw new Error(`邮箱索引读取失败，已保留原文件：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
function close(db: DatabaseSync): void {
  const opened = [...mailboxConnections.values()].find(item => item.db === db);
  if (opened) {
    try { const stat = fs.statSync(opened.file); opened.size = stat.size; opened.mtimeMs = stat.mtimeMs; } catch { /* keep the connection for the next diagnostic */ }
    return;
  }
  try { db.close(); } catch { /* already closed */ }
}
function enqueue<T>(file: string, job: () => T): Promise<T> { const key = path.resolve(file), prev = writeChains.get(key) ?? Promise.resolve(); const next = prev.then(job, job); writeChains.set(key, next.catch(() => {})); return next; }
function tx<T>(db: DatabaseSync, job: () => T): T { db.exec('BEGIN IMMEDIATE'); try { const result = job(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve original */ } throw error; } }
function decode(raw: string): AgentMessageLedgerEntry { const parsed = parseAgentMessageLedger({ schemaVersion: 1, seq: 0, messages: [JSON.parse(raw)] }); if (!parsed.messages[0]) throw new Error('邮箱包含无效条目，需要修复原文件'); return parsed.messages[0]; }
function ledger(db: DatabaseSync): AgentMessageLedger {
  const seq = Number((db.prepare("SELECT value FROM mailbox_meta WHERE key='seq'").get() as { value?: string } | undefined)?.value ?? 0); if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('邮箱收件位置无效，需要修复原文件');
  const rows = db.prepare('SELECT sequence,entry_json FROM mailbox_message ORDER BY sequence').all() as Array<{ sequence: number; entry_json: string }>;
  const messages = rows.map(row => { const entry = decode(row.entry_json); if (entry.sequence !== row.sequence) throw new Error('邮箱收件位置无效，需要修复原文件'); return entry; });
  if (messages.some((m, i) => !Number.isSafeInteger(m.sequence) || m.sequence! <= (messages[i - 1]?.sequence ?? 0))) throw new Error('邮箱收件位置无效，需要修复原文件');
  return { schemaVersion: 1, seq: Math.max(seq, messages.at(-1)?.sequence ?? 0), messages };
}
export function readAgentMessageLedger(_root: string, workspaceId: string): AgentMessageLedger { const opened = openMailbox(workspaceId, false); if (!opened) return emptyAgentMessageLedger(); try { return ledger(opened.db); } catch (error) { throw new Error(`邮箱索引读取失败，已保留原文件：${error instanceof Error ? error.message : String(error)}`); } finally { close(opened.db); } }
export function hasAgentMessageInStore(workspaceId: string, id: string): boolean {
  const opened = openMailbox(workspaceId, false);
  if (!opened) return false;
  try { return !!opened.db.prepare('SELECT 1 FROM mailbox_message WHERE id=?').get(id); }
  finally { close(opened.db); }
}
function emitChanged(workspaceId: string): void { for (const fn of changeListeners) { try { fn(workspaceId); } catch (error) { console.error('[messageStore] change listener failed', error); } } }
export function onAgentMessageAppended(fn: (workspaceId: string, entry: AgentMessageLedgerEntry, body: string) => void): () => void { appendListeners.add(fn); return () => { appendListeners.delete(fn); }; }
export function onAgentMessagesChanged(fn: (workspaceId: string) => void): () => void { changeListeners.add(fn); return () => { changeListeners.delete(fn); }; }
function updateEntry(db: DatabaseSync, id: string, update: (entry: AgentMessageLedgerEntry) => AgentMessageLedgerEntry): AgentMessageLedgerEntry | undefined { const row = db.prepare('SELECT entry_json FROM mailbox_message WHERE id=?').get(id) as { entry_json: string } | undefined; if (!row) return undefined; const next = update(decode(row.entry_json)); db.prepare('UPDATE mailbox_message SET entry_json=? WHERE id=?').run(JSON.stringify(next), id); return next; }
function messageBodyPath(workspaceId: string, messageId: string): string {
  const key = createHash('sha256').update(messageId, 'utf8').digest('hex');
  return path.join(userDataStorage(userDataDir()).scopedPath('workspace', 'agent-messages', workspaceId.trim() || 'default', id => `${workspaceFileKey(id)}-bodies`), `${key}.txt`);
}
export function agentMessageBodyPath(workspaceId: string, messageId: string): string { return messageBodyPath(workspaceId, messageId); }
function ensureImmutableBody(workspaceId: string, messageId: string, body: string): { file: string; created: boolean } {
  const file = messageBodyPath(workspaceId, messageId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      const bytes = Buffer.from(body, 'utf8');
      fs.writeSync(fd, bytes, 0, bytes.length, null);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return { file, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (fs.readFileSync(file, 'utf8') !== body) throw new Error(`信件 ${messageId} 正文文件已存在但内容不同`);
    return { file, created: false };
  }
}
function bodyFor(workspaceId: string, db: DatabaseSync, entry: AgentMessageLedgerEntry): string {
  if (entry.bodyChars === undefined) return entry.text;
  const row = db.prepare('SELECT body_path FROM mailbox_message WHERE id=?').get(entry.id) as { body_path?: string | null } | undefined;
  const expected = path.basename(messageBodyPath(workspaceId, entry.id));
  if (row?.body_path !== expected) throw new Error(`信件 ${entry.id} 正文读取失败：正文索引不存在`);
  try { return fs.readFileSync(messageBodyPath(workspaceId, entry.id), 'utf8'); }
  catch (error) { throw new Error(`信件 ${entry.id} 正文读取失败：${error instanceof Error ? error.message : String(error)}`); }
}
export class AgentMessageReplyToNotFound extends Error { constructor(replyTo: string) { super(`replyTo 引用的消息不存在：${replyTo}（host.mail.read 可查现有消息 id）`); this.name = 'AgentMessageReplyToNotFound'; } }
export function appendAgentMessageToStore(_root: string, workspaceId: string, input: AppendAgentMessageInput, options?: { replyValidated?: boolean; reuseInitialAssignment?: boolean }): Promise<AgentMessageLedgerEntry> {
  const file = agentMessagesFilePath(workspaceId); return enqueue(file, () => { const opened = openMailbox(workspaceId, true)!; let createdBodyFile: string | undefined; try {
    let body: string | undefined; const result = tx(opened.db, () => { if (input.text.length > AGENT_MESSAGE_TEXT_MAX) throw new Error(`信件正文超过 ${AGENT_MESSAGE_TEXT_MAX} 字符，未保存`);
      const seq = Number((opened.db.prepare("SELECT value FROM mailbox_meta WHERE key='seq'").get() as { value?: string } | undefined)?.value ?? 0);
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('邮箱收件位置无效，需要修复原文件');
      const current = { schemaVersion: 1, seq, messages: [] } as AgentMessageLedger;
      const duplicateRow = input.id ? opened.db.prepare('SELECT entry_json FROM mailbox_message WHERE id=?').get(input.id) as { entry_json: string } | undefined : undefined;
      const duplicate = duplicateRow ? decode(duplicateRow.entry_json) : undefined;
      if (duplicate) { if (options?.reuseInitialAssignment && duplicate.meta?.initialAssignment && duplicate.to === input.to) return duplicate; const desired = appendAgentMessage(current, input).entry; if (duplicate.from !== input.from || duplicate.to !== input.to || duplicate.kind !== (input.kind ?? 'notice') || duplicate.replyTo !== input.replyTo || JSON.stringify(duplicate.meta) !== JSON.stringify(desired.meta) || bodyFor(workspaceId, opened.db, duplicate) !== input.text) throw new Error('相同寄信标识对应不同内容，请使用新的标识'); return duplicate; }
      if (input.replyTo?.trim() && !options?.replyValidated && !opened.db.prepare('SELECT 1 FROM mailbox_message WHERE id=?').get(input.replyTo)) throw new AgentMessageReplyToNotFound(input.replyTo);
      body = input.text; const { ledger: next, entry } = appendAgentMessage(current, input.receipt === 'stored' ? { ...input, text: input.text.slice(0, AGENT_MESSAGE_PREVIEW_CHARS), bodyChars: input.text.length } : input);
      const storedBody = input.receipt === 'stored' ? ensureImmutableBody(workspaceId, entry.id, body) : undefined;
      if (storedBody?.created) createdBodyFile = storedBody.file;
      opened.db.prepare('INSERT INTO mailbox_message(sequence,id,entry_json,body_path) VALUES(?,?,?,?)').run(entry.sequence ?? next.seq, entry.id, JSON.stringify(entry), storedBody ? path.basename(storedBody.file) : null); opened.db.prepare("UPDATE mailbox_meta SET value=? WHERE key='seq'").run(String(next.seq)); return entry; });
    if (body !== undefined) {
      emitChanged(workspaceId);
      for (const fn of appendListeners) {
        try { fn(workspaceId, result, body); }
        catch (error) { console.error('[messageStore] append listener failed', error); }
      }
    }
    return result;
  } catch (error) { if (createdBodyFile) { try { fs.rmSync(createdBodyFile, { force: true }); } catch { /* preserve the transaction error */ } } throw error;
  } finally { close(opened.db); } });
}
export function readAgentMessageBody(_root: string, workspaceId: string, entry: AgentMessageLedgerEntry): string { const opened = openMailbox(workspaceId, false); if (!opened) throw new Error(`信件 ${entry.id} 正文读取失败：邮箱不存在`); try { return bodyFor(workspaceId, opened.db, entry); } catch (error) { throw new Error(`信件 ${entry.id} 正文读取失败：${error instanceof Error ? error.message : String(error)}`); } finally { close(opened.db); } }
export function reserveInitialAssignmentInStore(_root: string, workspaceId: string, recipient: string, id: string, reservation: InitialAssignmentReceipt): Promise<boolean> { const file = agentMessagesFilePath(workspaceId); return enqueue(file, () => { const opened = openMailbox(workspaceId, false); if (!opened) return false; try { return tx(opened.db, () => { const row = opened.db.prepare('SELECT entry_json FROM mailbox_message WHERE id=?').get(id) as { entry_json: string } | undefined; if (!row) return false; const current = decode(row.entry_json); if (current.to !== recipient || !isPendingInitialAssignment(current)) return false; updateEntry(opened.db, id, () => ({ ...current, initialAssignmentReceipt: reservation })); return true; }); } finally { close(opened.db); } }); }
export function settleInitialAssignmentInStore(_root: string, workspaceId: string, id: string, reservationId: string, deliveredAt?: number): Promise<void> { const file = agentMessagesFilePath(workspaceId); return enqueue(file, () => { const opened = openMailbox(workspaceId, false); if (!opened) return; try { tx(opened.db, () => { updateEntry(opened.db, id, message => { const receipt = message.initialAssignmentReceipt; if (!receipt || receipt.reservationId !== reservationId || receipt.deliveredAt !== undefined) return message; if (deliveredAt === undefined) { const next = { ...message }; delete next.initialAssignmentReceipt; return next; } const next = { ...message, initialAssignmentReceipt: { ...receipt, deliveredAt } }; delete next.wakeError; delete next.wakeDeferred; return next; }); }); } finally { close(opened.db); } }); }
export function updateAgentMessageWakeInStore(_root: string, workspaceId: string, ids: readonly string[], result: { notifiedAt?: number; error?: string; deferred?: string; atIdle?: true; interruption?: AgentMessageLedgerEntry['interruption']; deliveryMethod?: AgentMessageLedgerEntry['deliveryMethod']; uncertain?: boolean }): Promise<void> { const file = agentMessagesFilePath(workspaceId); return enqueue(file, () => { const opened = openMailbox(workspaceId, false); if (!opened) return; try { tx(opened.db, () => { for (const id of new Set(ids)) updateEntry(opened.db, id, message => { const next = { ...message }; if (result.interruption) next.interruption = result.interruption; if (result.deliveryMethod) next.deliveryMethod = result.deliveryMethod; if (result.uncertain === true) next.wakeUncertain = true; else if (result.uncertain === false || result.notifiedAt !== undefined) delete next.wakeUncertain; if (result.atIdle) next.wakeAtIdle = true; if (result.notifiedAt !== undefined) { next.notifiedAt = result.notifiedAt; delete next.wakeError; delete next.wakeDeferred; delete next.wakeAtIdle; } else if (result.error) { next.wakeError = result.error.slice(0, 500); delete next.wakeDeferred; } else if (result.deferred && !message.read) { next.wakeDeferred = result.deferred.slice(0, 500); delete next.wakeError; } return next; }); }); } finally { close(opened.db); } }); }
export function persistAgentMessageSourceAgentInStore(_root: string, workspaceId: string, id: string, sourceAgent: import('../../shared/subagentCharacters').SourceAgentIdentity): Promise<void> { const file = agentMessagesFilePath(workspaceId); return enqueue(file, () => { const opened = openMailbox(workspaceId, false); if (!opened) return; try { const snapshot = coerceSourceAgentIdentity(sourceAgent); if (!snapshot) return; tx(opened.db, () => { updateEntry(opened.db, id, message => message.sourceAgent ? message : { ...message, sourceAgent: snapshot }); }); } finally { close(opened.db); } }); }
export function queryAgentMessageOutboxFromStore(root: string, workspaceId: string, query: AgentMessageOutboxQuery = {}): AgentMessageOutboxResult { return queryAgentMessageOutbox(readAgentMessageLedger(root, workspaceId), query); }
export function agentMessageReplyToExistsInStore(root: string, workspaceId: string, replyTo: string): boolean { return agentMessageReplyToExists(readAgentMessageLedger(root, workspaceId), replyTo); }
export function markAgentMessagesReadInStore(_root: string, workspaceId: string, ids: readonly string[], signal?: AbortSignal): Promise<void> { const file = agentMessagesFilePath(workspaceId); return enqueue(file, () => { if (signal?.aborted) throw new Error('收信已取消，未写入已读回执'); const opened = openMailbox(workspaceId, false); if (!opened) return; try { let changed = false; tx(opened.db, () => { const current = ledger(opened.db), wanted = new Set(ids.map(s => s.trim()).filter(Boolean)); if (!current.messages.some(m => wanted.has(m.id) && !m.read)) return; changed = true; for (const m of current.messages.filter(item => wanted.has(item.id))) updateEntry(opened.db, m.id, item => markAgentMessagesRead({ schemaVersion: 1, seq: 0, messages: [item] }, [item.id]).messages[0]!); }); if (changed) emitChanged(workspaceId); } finally { close(opened.db); } }); }
export function resetMessageStoreChainsForTest(): void {
  writeChains.clear();
  for (const opened of mailboxConnections.values()) { try { opened.db.close(); } catch { /* already closed */ } }
  mailboxConnections.clear();
}
