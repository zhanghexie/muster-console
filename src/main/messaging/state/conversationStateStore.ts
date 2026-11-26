import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../../sqliteFilePath';
import {
  accessDenial, conversationKey, inboundMessageKey, isMessagingId, messagingAccountKey,
  type ConversationAddress, type ConversationBinding, type ConversationTarget, type InboundReceipt,
  type MessageOrigin, type MessagingAccountConfig, type MessagingAccountRef,
  type NormalizedInboundMessage, type SessionSubmissionResult
} from '../contracts';

const APPLICATION_ID = 0x4d534749;
const SCHEMA_VERSION = 1;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RECEIPTS_PER_ACCOUNT = 10_000;
const SCHEMA = `
  CREATE TABLE messaging_accounts (
    account_key TEXT PRIMARY KEY,
    config_json TEXT NOT NULL CHECK (json_valid(config_json))
  ) STRICT;
  CREATE TABLE messaging_bindings (
    conversation_key TEXT PRIMARY KEY,
    account_key TEXT NOT NULL REFERENCES messaging_accounts(account_key) ON DELETE CASCADE,
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    last_activity_at INTEGER
  ) STRICT;
  CREATE INDEX messaging_bindings_by_account ON messaging_bindings(account_key);
  CREATE TABLE messaging_inbox (
    message_key TEXT PRIMARY KEY,
    account_key TEXT NOT NULL REFERENCES messaging_accounts(account_key) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'accepted', 'rejected', 'retryable', 'unknown')),
    updated_at INTEGER NOT NULL,
    turn_id TEXT,
    CHECK ((status = 'accepted') = (turn_id IS NOT NULL))
  ) STRICT;
  CREATE INDEX messaging_inbox_by_account ON messaging_inbox(account_key, status, updated_at);
`;

type StoreOptions = Readonly<{ retentionMs?: number; maxReceiptsPerAccount?: number }>;
type BindingInput = Omit<ConversationBinding, 'revision'>;
type QueueLimit = 'conversation' | 'router';
type Reservation =
  | { status: 'queued'; receipt: InboundReceipt }
  | { status: 'duplicate'; receipt: InboundReceipt }
  | { status: 'account-disabled' }
  | { status: 'binding-changed' }
  | { status: 'backpressure'; limit: QueueLimit | 'receipts' };
type DispatchDecision = 'dispatching' | 'account-disabled' | 'unbound' | 'forbidden' | 'not-addressed' | 'binding-changed';
type InboxRow = {
  request_id: string;
  origin_json: string;
  binding_json: string;
  status: InboundReceipt['status'];
  updated_at: number;
  turn_id: string | null;
};

function assertId(value: unknown, label: string): asserts value is string {
  if (!isMessagingId(value)) throw new Error(`Invalid messaging ${label}`);
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid messaging timestamp');
}

function accountSnapshot(account: MessagingAccountConfig): MessagingAccountConfig {
  const { channelKey, botId, displayName, enabled, credentialRef, workspaceId } = account;
  assertId(channelKey, 'channel key');
  assertId(botId, 'bot ID');
  assertId(displayName, 'display name');
  if (typeof enabled !== 'boolean') throw new Error('Invalid messaging account enabled flag');
  assertId(credentialRef?.provider, 'credential provider');
  assertId(credentialRef?.id, 'credential reference');
  if (workspaceId !== undefined) assertId(workspaceId, 'workspace ID');
  return { channelKey, botId, displayName, enabled, credentialRef: { provider: credentialRef.provider, id: credentialRef.id }, workspaceId };
}

function addressSnapshot(address: ConversationAddress): ConversationAddress {
  const { channelKey, botId, conversationId, threadId } = address;
  assertId(channelKey, 'channel key');
  assertId(botId, 'bot ID');
  assertId(conversationId, 'conversation ID');
  if (threadId !== undefined) assertId(threadId, 'thread ID');
  return threadId === undefined ? { channelKey, botId, conversationId } : { channelKey, botId, conversationId, threadId };
}

function targetSnapshot(input: Omit<ConversationTarget, 'revision'>, revision: string): ConversationTarget {
  const { workspaceId, sessionId } = input;
  assertId(workspaceId, 'workspace ID');
  assertId(sessionId, 'session ID');
  assertId(revision, 'binding revision');
  return { ...addressSnapshot(input), workspaceId, sessionId, revision };
}

function sameTarget(a: ConversationTarget, b: ConversationTarget): boolean {
  return a.workspaceId === b.workspaceId && a.sessionId === b.sessionId;
}

function bindingSnapshot(input: BindingInput, revision: string): ConversationBinding {
  const { access, lastActivityAt } = input;
  if (lastActivityAt !== undefined) assertTimestamp(lastActivityAt);
  if (!access || !Array.isArray(access.allowedSenderIds) || access.allowedSenderIds.length > 1024 || !access.allowedSenderIds.every(isMessagingId) ||
      !['allowlist', 'off'].includes(access.direct) || !['mention', 'all', 'off'].includes(access.group)) {
    throw new Error('Invalid messaging access policy');
  }
  return {
    ...targetSnapshot(input, revision), lastActivityAt,
    access: { allowedSenderIds: [...new Set(access.allowedSenderIds)], direct: access.direct, group: access.group }
  };
}

function parseBinding(json: string): ConversationBinding {
  const input = JSON.parse(json) as ConversationBinding;
  return bindingSnapshot(input, input.revision);
}

function parseReceipt(row: InboxRow): InboundReceipt {
  const origin = JSON.parse(row.origin_json) as MessageOrigin;
  const target = JSON.parse(row.binding_json) as ConversationTarget;
  assertId(origin.messageId, 'origin message ID');
  return {
    requestId: row.request_id,
    origin: { ...addressSnapshot(origin), messageId: origin.messageId },
    binding: targetSnapshot(target, target.revision),
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id })
  };
}

/** Owned by the messaging runtime. Only the sole dispatch owner may recover interrupted inbox rows. */
export class ConversationStateStore {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly retentionMs: number;
  private readonly maxReceiptsPerAccount: number;
  private closed = false;

  constructor(file: string, options: StoreOptions = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxReceiptsPerAccount = options.maxReceiptsPerAccount ?? DEFAULT_RECEIPTS_PER_ACCOUNT;
    if (!file || !positiveInteger(this.retentionMs) || !positiveInteger(this.maxReceiptsPerAccount)) {
      throw new Error('Invalid messaging state store options');
    }
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let created = false;
    try {
      fs.closeSync(fs.openSync(this.file, 'wx', 0o600));
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.db = new DatabaseSync(sqliteFilePath(this.file));
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      this.transaction(() => this.initialize(created));
    } catch (error) {
      this.db.close();
      throw new Error('Messaging state could not be opened. Check its schema or restore a valid backup.', { cause: error });
    }
  }

  private initialize(created: boolean): void {
    const applicationId = this.db.prepare('PRAGMA application_id').get()?.application_id;
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (created && applicationId === 0 && version === 0) {
      this.db.exec(`${SCHEMA} PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
      return;
    }
    if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) throw new Error('Unsupported messaging state schema');
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('Corrupt messaging state');
    }
    for (const row of this.db.prepare('SELECT account_key, config_json FROM messaging_accounts').iterate()) {
      const account = accountSnapshot(JSON.parse(String(row.config_json)) as MessagingAccountConfig);
      if (row.account_key !== messagingAccountKey(account)) throw new Error('Mismatched account key');
    }
    for (const row of this.db.prepare('SELECT conversation_key, account_key, binding_json, last_activity_at FROM messaging_bindings').iterate()) {
      const binding = parseBinding(String(row.binding_json));
      if (row.conversation_key !== conversationKey(binding) || row.account_key !== messagingAccountKey(binding)) {
        throw new Error('Mismatched conversation binding key');
      }
      if (row.last_activity_at !== null) assertTimestamp(Number(row.last_activity_at));
    }
    for (const row of this.db.prepare('SELECT * FROM messaging_inbox').iterate()) {
      const receipt = parseReceipt(row as InboxRow);
      assertId(receipt.requestId, 'request ID');
      if (receipt.turnId !== undefined) assertId(receipt.turnId, 'turn ID');
      assertTimestamp(receipt.updatedAt);
      if (row.account_key !== messagingAccountKey(receipt.origin) || conversationKey(receipt.origin) !== conversationKey(receipt.binding)) {
        throw new Error('Mismatched inbox receipt address');
      }
    }
  }

  private transaction<T>(job: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = job();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (rollback) {
        throw new AggregateError([error, rollback], 'Messaging state rollback failed');
      }
      throw error;
    }
  }

  setAccount(input: MessagingAccountConfig): void {
    const account = accountSnapshot(input);
    this.transaction(() => {
      const previous = this.getAccount(account);
      if (previous && (previous.credentialRef.provider !== account.credentialRef.provider || previous.credentialRef.id !== account.credentialRef.id)) {
        throw new Error('Use a new messaging account for a different credential reference');
      }
      this.db.prepare(`INSERT INTO messaging_accounts(account_key, config_json) VALUES (?, ?)
        ON CONFLICT(account_key) DO UPDATE SET config_json=excluded.config_json`).run(messagingAccountKey(account), JSON.stringify(account));
    });
  }

  getAccount(account: MessagingAccountRef): MessagingAccountConfig | undefined {
    const row = this.db.prepare('SELECT config_json FROM messaging_accounts WHERE account_key=?').get(messagingAccountKey(account));
    return row && accountSnapshot(JSON.parse(String(row.config_json)) as MessagingAccountConfig);
  }

  listAccounts(): readonly MessagingAccountConfig[] {
    return this.db.prepare('SELECT config_json FROM messaging_accounts ORDER BY account_key').all()
      .map(row => accountSnapshot(JSON.parse(String(row.config_json)) as MessagingAccountConfig));
  }

  deleteAccount(account: MessagingAccountRef): boolean {
    const key = messagingAccountKey(account);
    return this.transaction(() => {
      if (this.getAccount(account)?.enabled) throw new Error('Disable the messaging account before deleting it');
      if (this.db.prepare("SELECT 1 FROM messaging_inbox WHERE account_key=? AND status IN ('queued','dispatching','unknown')").get(key)) {
        throw new Error('Messaging account has work that is in progress or has an unknown outcome');
      }
      return this.db.prepare('DELETE FROM messaging_accounts WHERE account_key=?').run(key).changes !== 0;
    });
  }

  setBinding(input: BindingInput): ConversationBinding {
    const binding = bindingSnapshot(input, randomUUID());
    this.db.prepare(`INSERT INTO messaging_bindings(conversation_key, account_key, binding_json, last_activity_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET binding_json=excluded.binding_json, last_activity_at=excluded.last_activity_at`)
      .run(conversationKey(binding), messagingAccountKey(binding), JSON.stringify(binding), binding.lastActivityAt ?? null);
    return binding;
  }

  getBinding(address: ConversationAddress): ConversationBinding | undefined {
    const row = this.db.prepare('SELECT binding_json, last_activity_at FROM messaging_bindings WHERE conversation_key=?').get(conversationKey(address));
    return row && { ...parseBinding(String(row.binding_json)), lastActivityAt: row.last_activity_at === null ? undefined : Number(row.last_activity_at) };
  }

  deleteBinding(address: ConversationAddress): boolean {
    return this.db.prepare('DELETE FROM messaging_bindings WHERE conversation_key=?').run(conversationKey(address)).changes !== 0;
  }

  getInboundReceipt(requestId: string): InboundReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM messaging_inbox WHERE request_id=?').get(requestId) as InboxRow | undefined;
    return row && parseReceipt(row);
  }

  reserveInbound(message: NormalizedInboundMessage, binding: ConversationBinding, now: number, queueLimit?: QueueLimit): Reservation {
    assertTimestamp(now);
    return this.transaction(() => {
      if (!this.getAccount(message)?.enabled) return { status: 'account-disabled' };
      if (this.getBinding(message)?.revision !== binding.revision) return { status: 'binding-changed' };
      const accountKey = messagingAccountKey(message);
      const eventKey = inboundMessageKey(message);
      this.db.prepare(`DELETE FROM messaging_inbox WHERE account_key=? AND status IN ('accepted','rejected','retryable') AND updated_at < ?`)
        .run(accountKey, now - this.retentionMs);
      const existing = this.db.prepare('SELECT * FROM messaging_inbox WHERE message_key=?').get(eventKey) as InboxRow | undefined;
      if (existing && existing.status !== 'retryable') return { status: 'duplicate', receipt: parseReceipt(existing) };
      const retry = existing && parseReceipt(existing);
      if (retry && (!sameTarget(retry.binding, binding) ||
          conversationKey(retry.origin) !== conversationKey(message) || retry.origin.messageId !== message.messageId)) {
        this.db.prepare("UPDATE messaging_inbox SET status='rejected', updated_at=? WHERE request_id=?").run(now, retry.requestId);
        return { status: 'binding-changed' };
      }
      if (queueLimit) return { status: 'backpressure', limit: queueLimit };
      if (!existing && this.db.prepare('SELECT 1 FROM messaging_inbox WHERE account_key=? LIMIT 1 OFFSET ?').get(accountKey, this.maxReceiptsPerAccount - 1)) {
        return { status: 'backpressure', limit: 'receipts' };
      }
      const receipt: InboundReceipt = {
        requestId: retry?.requestId ?? randomUUID(),
        origin: retry?.origin ?? { ...addressSnapshot(message), messageId: message.messageId },
        binding: retry?.binding ?? targetSnapshot(binding, binding.revision),
        updatedAt: now,
        status: 'queued'
      };
      this.db.prepare(`INSERT INTO messaging_inbox(message_key, account_key, request_id, origin_json, binding_json, status, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT(message_key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`)
        .run(eventKey, accountKey, receipt.requestId, JSON.stringify(receipt.origin), JSON.stringify(receipt.binding), now);
      this.db.prepare('UPDATE messaging_bindings SET last_activity_at=MAX(COALESCE(last_activity_at, 0), ?) WHERE conversation_key=?')
        .run(now, conversationKey(binding));
      return { status: 'queued', receipt };
    });
  }

  beginDispatch(message: NormalizedInboundMessage, requestId: string, now: number): DispatchDecision {
    assertTimestamp(now);
    return this.transaction(() => {
      const receipt = this.getInboundReceipt(requestId);
      if (receipt?.status !== 'queued') throw new Error('Messaging request is no longer queued');
      const current = this.getBinding(message);
      let denial: Exclude<DispatchDecision, 'dispatching'> | undefined;
      if (!this.getAccount(message)?.enabled) denial = 'account-disabled';
      else if (!current) denial = 'unbound';
      else if (!sameTarget(receipt.binding, current)) denial = 'binding-changed';
      else denial = accessDenial(current.access, message);
      const status = denial ? 'rejected' : 'dispatching';
      const result = this.db.prepare("UPDATE messaging_inbox SET status=?, updated_at=? WHERE message_key=? AND request_id=? AND status='queued'")
        .run(status, now, inboundMessageKey(message), requestId);
      if (!result.changes) throw new Error('Messaging request is no longer queued');
      return denial ?? 'dispatching';
    });
  }

  returnQueuedForRetry(requestId: string, now: number): void {
    assertTimestamp(now);
    const updated = this.db.prepare("UPDATE messaging_inbox SET status='retryable', updated_at=? WHERE request_id=? AND status='queued'").run(now, requestId);
    if (!updated.changes) throw new Error('Messaging request is no longer queued');
  }

  finishDispatch(requestId: string, result: SessionSubmissionResult, now: number): void {
    assertTimestamp(now);
    if (result.status === 'accepted') assertId(result.turnId, 'turn ID');
    const updated = this.db.prepare("UPDATE messaging_inbox SET status=?, turn_id=?, updated_at=? WHERE request_id=? AND status='dispatching'")
      .run(result.status, result.status === 'accepted' ? result.turnId : null, now, requestId);
    if (!updated.changes) throw new Error('Messaging request is no longer dispatching');
  }

  /** Startup only, before connecting transports. Retryable rows still require source redelivery. */
  recoverInterrupted(now = Date.now()): void {
    assertTimestamp(now);
    this.db.prepare(`UPDATE messaging_inbox SET status=CASE status WHEN 'dispatching' THEN 'unknown' ELSE 'retryable' END, updated_at=?
      WHERE status IN ('queued','dispatching')`).run(now);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
