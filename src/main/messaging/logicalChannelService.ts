import { createHash, randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type {
  LogicalChannel, LogicalChannelCatalogEntry, LogicalChannelChange, LogicalChannelDiagnostics, LogicalChannelDraftInput, LogicalChannelLegacyAccess, LogicalChannelLegacyAdapter, LogicalChannelLegacyNotice,
  LogicalChannelMessage, LogicalChannelMessagePage, LogicalChannelMessageQuery, LogicalChannelMessageStateInput,
  LogicalChannelNotify, LogicalChannelPermission, LogicalChannelRemoteStatus, LogicalChannelRemoteAccess,
  LogicalChannelReplyInput, LogicalChannelSendInput, LogicalChannelSource, LogicalChannelStage
} from '../../shared/messagingChannels';
import { isMessagingId } from './contracts';
import type { WorkbenchRemoteInput, WorkbenchRemoteReply } from './messagingHost';
import { LogicalChannelStore, legacyGlobalSourceId, storedTarget, type BoundChannel, type StoredChannel, type StoredGrant, type StoredMessage,
  type StoredSource, type StoredStage } from './state/logicalChannelStore';

type SourceDetails = Omit<LogicalChannelSource, 'id' | 'provider' | 'botId' | 'connected'> & {
  legacyConnected?: boolean;
  legacyProvided?: boolean;
  legacyId?: string;
  latestMessageId?: string;
};
type MessageDetails = Omit<LogicalChannelMessage, 'id' | 'channelId' | 'sourceId' | 'createdAt' | 'direction' | 'status'> & {
  nativeMessageId?: string;
};
type SourceAddress = Pick<LogicalChannelSource, 'provider' | 'botId' | 'conversationId' | 'threadId' | 'conversationType'>;
type DeliveryText = { text: string; subject?: string; nativeMessageId?: string; reply?: boolean };
export type LogicalRemoteScope = {
  id: string;
  source: SourceAddress;
};
type RemotePort = {
  intent(input: WorkbenchRemoteInput, scope?: LogicalRemoteScope): 'none' | 'pair' | 'control';
  isPairingSecret?(text: string): boolean;
  handle(input: WorkbenchRemoteInput, scope?: LogicalRemoteScope): Promise<WorkbenchRemoteReply>;
  manage(scope: LogicalRemoteScope, method: 'remote.status' | 'remote.begin' | 'remote.revoke', bindingId?: string): LogicalChannelRemoteStatus;
  revoke(scope: LogicalRemoteScope): void;
  revokeLegacySource?(source: SourceAddress): void;
};
type Options = {
  file: string;
  workspaceExists(workspaceId: string): boolean;
  workspaceIds?: () => readonly string[];
  connected(provider: string, botId: string, signal: AbortSignal): Promise<boolean>;
  send(source: SourceAddress, message: DeliveryText, signal: AbortSignal): Promise<void>;
  remote: RemotePort;
  legacy?: LogicalChannelLegacyAdapter;
  now?: () => number;
};

const PROVIDERS = new Set(['feishu', 'weixin', 'wecom', 'wecom-app', 'dingtalk', 'qq', 'slack',
  'telegram', 'discord', 'whatsapp', 'imessage', 'matrix', 'email']);
const SOURCE_LIMIT = 4096;
const GRANT_LIMIT = 64;
const CHANNEL_LIMIT = 128;
const MAX_TEXT = 64 * 1024;
const RETENTION = 30 * 24 * 60 * 60_000;
const NO_REPLY = { text: '' };
const WORKSPACE_MESSAGES = `FROM messages m JOIN grants g ON g.id=m.grant_id
  LEFT JOIN workspace_message_state s ON s.workspace_id=? AND s.source_id=g.source_id AND s.event_key=coalesce(m.event_key,m.id)
  LEFT JOIN workspace_notices n ON n.workspace_id=? AND n.channel_id=m.channel_id AND n.ordinal=m.ordinal`;
const WORKSPACE_MESSAGE_COLUMNS = `m.*, g.source_id, s.read AS workspace_read, s.processed AS workspace_processed,
  (n.ordinal IS NOT NULL) AS workspace_notice`;
const KNOWN_NOT_SENT = new Set(['bot-not-connected', 'invalid-target', 'unknown-bot', 'account-changed', 'target-changed',
  'capability-unavailable', 'stale-route', 'channel-source-not-sendable', 'delivery-context-unavailable', 'thread-unavailable']);

export class LogicalChannelError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LogicalChannelError'; }
}
function requireValue(condition: unknown, code = 'invalid-channel-request'): asserts condition {
  if (!condition) throw new LogicalChannelError(code);
}
function id(value: unknown): string {
  requireValue(isMessagingId(value));
  return value;
}
function permission(value: unknown): LogicalChannelPermission {
  requireValue(value === 'read' || value === 'reply');
  return value;
}
function notify(value: unknown): LogicalChannelNotify {
  requireValue(value === 'digest' || value === 'wake' || value === 'mute');
  return value;
}
function name(value: unknown): string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120);
  return value.trim();
}
function boundedLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 256) || fallback;
}
function hash(fields: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
function origin(source: SourceAddress): string {
  return hash([source.provider, source.botId, source.conversationId, source.threadId ?? null]);
}
function compareMessage(a: Pick<LogicalChannelMessage, 'createdAt' | 'id'>, b: Pick<LogicalChannelMessage, 'createdAt' | 'id'>): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function detailsOf(row: StoredSource): SourceDetails {
  return JSON.parse(row.details) as SourceDetails;
}
function sourceAddress(row: StoredSource): SourceAddress {
  const { conversationId, conversationType, threadId } = detailsOf(row);
  return { provider: row.provider, botId: row.botId, conversationId, conversationType, ...(threadId && { threadId }) };
}
function messageProjection(row: StoredMessage, sourceId: string): LogicalChannelMessage {
  const { nativeMessageId: _native, notificationOwner: _oldNotice, ...details } = JSON.parse(row.details) as MessageDetails;
  return { ...details, id: row.id, channelId: row.channel_id, sourceId, direction: row.direction,
    status: row.status, createdAt: row.created_at,
    read: row.workspace_read == null ? row.direction === 'outbound' : row.workspace_read === 1,
    processed: row.workspace_processed == null ? row.direction === 'outbound' : row.workspace_processed === 1,
    notificationOwner: row.workspace_notice === 1 };
}

/** Main-process owner of the Channel definition, authenticated discovery, and delivery ledger. */
export class LogicalChannelService {
  private readonly store: LogicalChannelStore;
  private readonly admission = new AbortController();
  private readonly listeners = new Set<(change: LogicalChannelChange) => void>();
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.store = new LogicalChannelStore(options.file);
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: (change: LogicalChannelChange) => void): () => void {
    if (this.admission.signal.aborted) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stopAdmission(): void { this.admission.abort(); }
  async stopAndWait(): Promise<void> {
    this.stopAdmission();
    await Promise.allSettled([...this.pending]);
    this.listeners.clear();
    this.store.close();
  }

  async listChannels(workspaceId: string, signal?: AbortSignal): Promise<LogicalChannel[]> {
    this.assertWorkspace(workspaceId);
    await this.syncLegacy(workspaceId, signal);
    const rows = this.store.database().prepare(`SELECT c.id,c.name,c.notify,b.workspace_id,b.generation FROM channels c
      JOIN channel_bindings b ON b.channel_id=c.id WHERE b.workspace_id=? ORDER BY c.name,c.id`).all(workspaceId) as BoundChannel[];
    const projected = await Promise.all(rows.map(row => this.projectChannel(row, signal)));
    return projected.filter((_channel, i) => this.stillBound(rows[i]));
  }

  async getChannel(workspaceId: string, channelId: string, signal?: AbortSignal): Promise<LogicalChannel> {
    const channel = this.channel(workspaceId, channelId);
    const projected = await this.projectChannel(channel, signal);
    this.assertBound(channel);
    return projected;
  }

  async catalog(workspaceId: string, signal?: AbortSignal): Promise<LogicalChannelCatalogEntry[]> {
    this.assertWorkspace(workspaceId);
    await this.syncAllLegacy(signal, workspaceId);
    return this.store.database().prepare(`SELECT c.id,c.name,count(g.id) AS sourceCount,b.generation IS NOT NULL AS bound
      FROM channels c LEFT JOIN grants g ON g.channel_id=c.id
      LEFT JOIN channel_bindings b ON b.channel_id=c.id AND b.workspace_id=?
      GROUP BY c.id ORDER BY c.name,c.id`).all(workspaceId).map(row => ({ id: String(row.id), name: String(row.name),
        sourceCount: Number(row.sourceCount), bound: row.bound === 1 }));
  }

  bindChannel(workspaceId: string, channelId: string, bound: boolean, signal?: AbortSignal): void {
    this.assertOpen(signal);
    this.assertWorkspace(workspaceId);
    const row = this.globalChannel(channelId);
    const db = this.store.database();
    const changes = bound ? db.prepare('INSERT OR IGNORE INTO channel_bindings VALUES (?,?,?,?)')
      .run(workspaceId, row.id, randomUUID(), performance.timeOrigin + performance.now()).changes
      : db.prepare('DELETE FROM channel_bindings WHERE workspace_id=? AND channel_id=?').run(workspaceId, row.id).changes;
    if (!bound) this.abortGrant(this.bindingKey(workspaceId, row.id));
    if (changes) this.emit({ workspaceId, channelId: row.id, kind: 'channel' });
  }

  async legacyAccess(workspaceId: string, signal?: AbortSignal): Promise<LogicalChannelLegacyAccess[]> {
    this.assertWorkspace(workspaceId);
    await this.syncLegacy(workspaceId, signal);
    this.assertOpen(signal);
    const rows = this.store.database().prepare(`SELECT json_extract(s.details,'$.legacyId') AS originalSourceId,
      g.permission,coalesce(g.notify,c.notify) AS notify FROM channel_bindings b
      JOIN channels c ON c.id=b.channel_id JOIN grants g ON g.channel_id=c.id
      JOIN sources s ON s.id=g.source_id AND s.owner=g.source_owner
      WHERE b.workspace_id=? AND s.owner=? AND s.retired=0 AND json_extract(s.details,'$.legacyProvided')=1`)
      .all(workspaceId, workspaceId) as LogicalChannelLegacyAccess[];
    return rows;
  }

  /** Record references supplied by the worker that committed the original, authenticated inbound event. */
  async captureLegacyNotices(owner: string, batch: LogicalChannelLegacyNotice, skipOwner: boolean, signal?: AbortSignal): Promise<void> {
    this.assertWorkspace(owner);
    requireValue(isMessagingId(batch.eventId) && Number.isFinite(batch.committedAt) && batch.committedAt >= 0);
    if (!batch.messages.length) return;
    await this.syncLegacy(owner, signal);
    this.assertOpen(signal);
    this.assertWorkspace(owner);
    const db = this.store.database();
    const bySource = new Map<string, { originals: Set<string>; ownerMuted: boolean }>();
    for (const { sourceId, messageId, ownerMuted } of batch.messages) {
      requireValue(isMessagingId(sourceId) && sourceId.startsWith('legacy:') && isMessagingId(messageId) && /^legacy:(mail|messages):/u.test(messageId));
      const source = legacyGlobalSourceId(owner, sourceId);
      const group = bySource.get(source) ?? { originals: new Set<string>(), ownerMuted: false };
      group.originals.add(messageId);
      group.ownerMuted ||= ownerMuted === true;
      bySource.set(source, group);
    }
    const changes: LogicalChannelChange[] = [];
    this.store.transaction(() => {
      const claim = db.prepare('INSERT OR IGNORE INTO legacy_notice_claims VALUES (?)');
      const admit = db.prepare('INSERT INTO legacy_workspace_notices (workspace_id,channel_id,grant_id) VALUES (?,?,?)');
      const reference = db.prepare('INSERT INTO legacy_notice_refs VALUES (?,?)');
      const eligible = db.prepare(`SELECT b.workspace_id,g.channel_id,g.id,coalesce(g.notify,c.notify) AS mode
        FROM grants g JOIN channels c ON c.id=g.channel_id JOIN channel_bindings b ON b.channel_id=c.id
        WHERE g.source_id=? AND g.source_owner=? AND g.linked_at<=? AND b.bound_at<=?
        AND coalesce(g.notify,c.notify)!='mute' ORDER BY coalesce(g.notify,c.notify)='wake' DESC,c.id`);
      for (const [sourceId, { originals, ownerMuted }] of bySource) {
        const accepted = [...originals].filter(messageId => claim.run(hash([sourceId, messageId])).changes);
        if (!accepted.length) continue;
        const assigned = new Set(skipOwner || ownerMuted ? [owner] : []);
        for (const row of eligible.all(sourceId, owner, batch.committedAt, batch.committedAt)) {
          const { workspace_id: workspaceId, channel_id: channelId, id: grantId } = row as { workspace_id: string; channel_id: string; id: string };
          if (assigned.has(workspaceId) || !this.options.workspaceExists(workspaceId)) continue;
          assigned.add(workspaceId);
          const { lastInsertRowid } = admit.run(workspaceId, channelId, grantId);
          for (const messageId of accepted) reference.run(lastInsertRowid, messageId);
          changes.push({ workspaceId, channelId, kind: 'message' });
        }
      }
    });
    for (const change of changes) this.emit(change);
  }

  async invoke(method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      this.assertOpen(signal);
      requireValue(payload && typeof payload === 'object' && !Array.isArray(payload));
      const p = payload as Record<string, unknown>;
      const value = await this.invokeOperation(method, p, signal);
      return { ok: true, value };
    } catch (error) {
      const code = signal.aborted || this.admission.signal.aborted ? 'cancelled'
        : error instanceof LogicalChannelError ? error.code : 'logical-channel-store-unavailable';
      return { ok: false, error: { code, ...(code === 'logical-channel-store-unavailable' && {
        message: '无法读取或保存 Channel 数据。请检查工作台应用数据目录的存储权限，重启后重试。原文件已保留。'
      }) } };
    }
  }

  private async invokeOperation(method: string, p: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (method === 'bindings.list') return this.listChannels(id(p.workspaceId), signal);
    if (method === 'bindings.add' || method === 'bindings.remove') {
      this.bindChannel(id(p.workspaceId), id(p.channelId), method === 'bindings.add', signal);
      return { bound: method === 'bindings.add' };
    }
    const db = this.store.database();
    if (method === 'list' || method === 'sources.list') {
      await this.syncAllLegacy(signal);
      if (method === 'sources.list') {
        const rows = db.prepare('SELECT id, owner, provider, bot_id AS botId, retired, details FROM sources WHERE retired=0').all() as StoredSource[];
        const connections = new Map<string, Promise<boolean>>();
        return Promise.all(rows.sort((a, b) => detailsOf(b).lastSeenAt - detailsOf(a).lastSeenAt)
          .map(source => this.projectSource(source, signal, connections, true)));
      }
      const rows = db.prepare('SELECT id,name,notify FROM channels ORDER BY name,id').all() as StoredChannel[];
      return Promise.all(rows.map(row => this.projectChannel(row, signal, true)));
    }
    if (method === 'create') {
      const channelId = randomUUID();
      this.store.transaction(() => {
        requireValue(Number(db.prepare('SELECT count(*) AS n FROM channels').get()?.n) < CHANNEL_LIMIT, 'channel-limit');
        db.prepare('INSERT INTO channels VALUES (?,?,?,?)').run(channelId, '', name(p.name), notify(p.notify ?? 'digest'));
      });
      this.emitCatalog(channelId);
      return this.projectChannel(this.globalChannel(channelId), signal, true);
    }
    const row = this.globalChannel(id(p.channelId));
    switch (method) {
      case 'get': return this.projectChannel(row, signal, true);
      case 'update':
        db.prepare('UPDATE channels SET name=?, notify=? WHERE id=?').run(
          p.name === undefined ? row.name : name(p.name), p.notify === undefined ? row.notify : notify(p.notify), row.id);
        break;
      case 'remove':
        for (const grant of this.grants(row.id)) this.revokeGrant(grant);
        db.prepare('DELETE FROM channels WHERE id=?').run(row.id);
        this.emitCatalog(row.id);
        return { removed: true };
      case 'sources.add': {
        const sourceId = id(p.sourceId);
        const source = db.prepare('SELECT id,owner,provider,bot_id AS botId,retired,details FROM sources WHERE id=?').get(sourceId) as StoredSource | undefined;
        requireValue(source && !source.retired, 'channel-source-not-found');
        const target = p.remoteTarget == null ? null : this.validateRemote(source, p.remoteTarget);
        this.store.transaction(() => this.addGrant(row.id, source, permission(p.permission ?? 'read'),
          p.notify == null ? null : notify(p.notify), target));
        break;
      }
      case 'sources.update': {
        const grant = this.grant(row.id, id(p.sourceId));
        const source = this.sourceFor(grant);
        const previous = storedTarget(grant);
        const target = p.remoteTarget === undefined ? previous : p.remoteTarget === null ? null : this.validateRemote(source, p.remoteTarget);
        const nextPermission = p.permission === undefined ? grant.permission : permission(p.permission);
        if (JSON.stringify(previous) !== JSON.stringify(target)) {
          this.assertRemoteAvailable(source, grant.id);
          this.revokeGrant(grant);
        } else if (grant.permission === 'reply' && nextPermission === 'read') this.abortGrant(grant.id);
        db.prepare('UPDATE grants SET permission=?, notify=?, target=? WHERE id=?').run(nextPermission,
          p.notify === undefined ? grant.notify : p.notify === null ? null : notify(p.notify),
          target && JSON.stringify(target), grant.id);
        break;
      }
      case 'sources.remove': {
        const grant = this.grant(row.id, id(p.sourceId));
        this.revokeGrant(grant);
        db.prepare('DELETE FROM grants WHERE id=?').run(grant.id);
        break;
      }
      case 'remote.begin':
      case 'remote.status':
      case 'remote.revoke': {
        const grant = this.grant(row.id, id(p.sourceId));
        const scope = this.remoteScope(grant);
        requireValue(scope, 'channel-remote-disabled');
        if (method === 'remote.begin') {
          const source = this.sourceFor(grant);
          this.validateRemote(source, storedTarget(grant));
          if (source.owner) await this.syncLegacy(source.owner, signal);
          const ready = source.owner ? detailsOf(this.sourceFor(grant)).legacyConnected === true
            : await this.options.connected(scope.source.provider, scope.source.botId, this.signal(signal));
          this.assertOpen(signal);
          requireValue(ready, 'channel-source-offline');
          const current = this.grant(row.id, grant.source_id);
          requireValue(current.id === grant.id && current.target === grant.target, 'channel-source-changed');
        }
        return this.options.remote.manage(scope, method, p.bindingId === undefined ? undefined : id(p.bindingId));
      }
      case 'messages.list':
        return this.listMessages(id(p.workspaceId), row.id, p as LogicalChannelMessageQuery, signal);
      case 'messages.reply':
        return this.reply(p as unknown as LogicalChannelReplyInput, signal);
      case 'messages.send':
        return this.send(p as unknown as LogicalChannelSendInput, signal);
      case 'messages.state':
        return this.setMessageState(p as unknown as LogicalChannelMessageStateInput, signal);
      case 'messages.saveDraft':
        return this.saveDraft(p as unknown as LogicalChannelDraftInput, signal);
      case 'diagnostics':
        return this.diagnostics(row);
      default: throw new LogicalChannelError('unknown-channel-operation');
    }
    this.emitCatalog(row.id);
    return this.projectChannel(this.globalChannel(row.id), signal, true);
  }

  private addGrant(channelId: string, source: StoredSource, access: LogicalChannelPermission,
    settings: LogicalChannelNotify | null, target: LogicalChannelRemoteAccess | null,
    linkedAt = performance.timeOrigin + performance.now()): void {
    const db = this.store.database();
    requireValue(!db.prepare('SELECT 1 FROM grants WHERE channel_id=? AND source_id=?').get(channelId, source.id), 'channel-source-already-added');
    requireValue(Number(db.prepare('SELECT count(*) AS n FROM grants WHERE channel_id=?').get(channelId)?.n) < GRANT_LIMIT, 'channel-source-limit');
    if (target) this.assertRemoteAvailable(source);
    db.prepare('INSERT INTO grants VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), channelId, source.id, source.owner,
      access, settings, target && JSON.stringify(target), linkedAt);
  }

  private assertRemoteAvailable(source: StoredSource, except = ''): void {
    const db = this.store.database();
    const conflict = source.owner ? db.prepare(`SELECT 1 FROM grants g JOIN sources s ON s.id=g.source_id AND s.owner=g.source_owner
      WHERE s.owner=? AND s.provider=? AND json_extract(s.details,'$.conversationId')=? AND g.target IS NOT NULL AND g.id!=?`)
      .get(source.owner, source.provider, detailsOf(source).conversationId, except)
      : db.prepare('SELECT 1 FROM grants WHERE source_id=? AND target IS NOT NULL AND id!=?').get(source.id, except);
    requireValue(!conflict, 'channel-remote-source-in-use');
  }

  private validateRemote(source: StoredSource, target: unknown): LogicalChannelRemoteAccess {
    requireValue(!source.retired && detailsOf(source).canRemote, 'remote-sender-unverifiable');
    requireValue((target as Partial<LogicalChannelRemoteAccess> | null)?.kind === 'workbench');
    return { kind: 'workbench' };
  }

  async listMessages(workspaceId: string, channelId: string, query: LogicalChannelMessageQuery = {}, signal?: AbortSignal): Promise<LogicalChannelMessagePage> {
    const channel = this.channel(workspaceId, channelId);
    const limit = query.limit ?? 40;
    const order = query.order ?? 'desc';
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 100 && (order === 'asc' || order === 'desc'));
    if (query.notifications === true) return this.listNotificationMessages(channel, query.after, limit);
    if (query.notifications === 'legacy') return this.listLegacyNotificationMessages(channel, query.after, limit, signal);
    const search = query.search;
    requireValue(search === undefined || typeof search === 'string' && search.length <= 256);
    requireValue(query.unread === undefined || typeof query.unread === 'boolean');
    requireValue(query.processed === undefined || typeof query.processed === 'boolean');
    requireValue(query.drafts === undefined || typeof query.drafts === 'boolean');
    const sourceId = query.sourceId === undefined ? undefined : id(query.sourceId);
    if (sourceId) this.grant(channel.id, sourceId);
    const boundary = this.readCursor(query.after, channel.id, order);
    const args: SQLInputValue[] = [workspaceId, workspaceId, channel.id];
    const filters = ['m.channel_id=?'];
    if (sourceId) { args.push(sourceId); filters.push('g.source_id=?'); }
    if (boundary) {
      filters.push(order === 'asc' ? '(m.created_at,m.id)>(?,?)' : '(m.created_at,m.id)<(?,?)');
      args.push(boundary.createdAt, boundary.id);
    }
    if (search?.trim()) {
      filters.push("instr(lower(json_extract(m.details,'$.text')),lower(?)) > 0 OR instr(lower(coalesce(json_extract(m.details,'$.subject'),'')),lower(?)) > 0");
      args.push(search.trim(), search.trim());
    }
    if (query.unread !== undefined) {
      filters.push("coalesce(s.read,m.direction='outbound')=?");
      args.push(query.unread ? 0 : 1);
    }
    if (query.processed !== undefined) {
      filters.push("coalesce(s.processed,m.direction='outbound')=?");
      args.push(query.processed ? 1 : 0);
    }
    const sqlOrder = order === 'asc' ? 'ASC' : 'DESC';
    const native = query.drafts ? [] : (this.store.database().prepare(`
      SELECT ${WORKSPACE_MESSAGE_COLUMNS} ${WORKSPACE_MESSAGES}
      WHERE ${filters.map(filter => `(${filter})`).join(' AND ')}
      ORDER BY m.created_at ${sqlOrder},m.id ${sqlOrder} LIMIT ?
    `).all(...args, limit + 1) as (StoredMessage & { source_id: string })[]);
    const legacy = await Promise.all(this.grants(channelId).filter(grant =>
      grant.source_owner && (!sourceId || grant.source_id === sourceId)).map(grant => this.listLegacyMessages(
        channel, grant, { order, limit: limit + 1, search, unread: query.unread, processed: query.processed, drafts: query.drafts }, boundary, signal)));
    this.assertOpen(signal);
    this.assertBound(channel);
    const permitted = new Set(this.grants(channelId).map(grant => grant.id));
    const messages = [...native.filter(row => permitted.has(row.grant_id)).map(row => messageProjection(row, row.source_id)), ...legacy.flat()]
      .sort((a, b) => compareMessage(a, b) * (order === 'asc' ? 1 : -1));
    const page = messages.slice(0, limit);
    // Ascending consumers can retain the watermark even at the current end.
    const last = page[page.length - 1];
    const nextCursor = last && (order === 'asc' || messages.length > limit)
      ? Buffer.from(JSON.stringify([channel.id, order, last.createdAt, last.id])).toString('base64url') : null;
    return { messages: page, nextCursor };
  }

  private noticeCursor(channelId: string, lane: string, after: unknown): number {
    if (after === undefined) return 0;
    try {
      requireValue(typeof after === 'string' && after.length <= 2048);
      const [channel, operation, position] = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) as unknown[];
      requireValue(channel === channelId && operation === lane && typeof position === 'number' && Number.isSafeInteger(position) && position >= 0);
      return position;
    } catch { throw new LogicalChannelError('invalid-channel-cursor'); }
  }

  private listNotificationMessages(channel: BoundChannel, after: unknown, limit: number): LogicalChannelMessagePage {
    const channelId = channel.id, ordinal = this.noticeCursor(channel.id, 'notifications', after);
    const rows = this.store.database().prepare(`SELECT m.*,g.source_id,s.read AS workspace_read,
      s.processed AS workspace_processed,1 AS workspace_notice
      FROM workspace_notices n JOIN messages m ON m.ordinal=n.ordinal JOIN grants g ON g.id=m.grant_id
      LEFT JOIN workspace_message_state s ON s.workspace_id=n.workspace_id AND s.source_id=g.source_id AND s.event_key=m.event_key
      WHERE n.workspace_id=? AND n.channel_id=? AND n.ordinal>? AND coalesce(s.processed,0)=0
      ORDER BY n.ordinal LIMIT ?`).all(channel.workspace_id, channelId, ordinal, limit) as (StoredMessage & { ordinal: number; source_id: string })[];
    const last = rows[rows.length - 1];
    return {
      messages: rows.map(row => messageProjection(row, row.source_id)),
      nextCursor: last ? Buffer.from(JSON.stringify([channelId, 'notifications', last.ordinal])).toString('base64url') : null
    };
  }

  private async listLegacyNotificationMessages(channel: BoundChannel, after: unknown, limit: number, signal?: AbortSignal): Promise<LogicalChannelMessagePage> {
    const lane = 'legacy-notifications', ordinal = this.noticeCursor(channel.id, lane, after);
    const db = this.store.database();
    const rows = db.prepare(`SELECT n.ordinal,g.source_id FROM legacy_workspace_notices n JOIN grants g ON g.id=n.grant_id
      WHERE n.workspace_id=? AND n.channel_id=? AND n.ordinal>? ORDER BY n.ordinal LIMIT ?`)
      .all(channel.workspace_id, channel.id, ordinal, limit) as { ordinal: number; source_id: string }[];
    const messages: LogicalChannelMessage[] = [];
    for (const row of rows) {
      const originals = db.prepare('SELECT message_id FROM legacy_notice_refs WHERE ordinal=? ORDER BY message_id').all(row.ordinal);
      for (const original of originals) {
        const messageId = `${row.source_id}:${String(original.message_id).slice('legacy:'.length)}`;
        const message = await this.getMessage(channel.workspace_id, channel.id, messageId, signal);
        this.assertBound(channel);
        if (message?.notificationOwner) { messages.push(message); break; }
      }
    }
    const last = rows.at(-1);
    return { messages, nextCursor: last ? Buffer.from(JSON.stringify([channel.id, lane, last.ordinal])).toString('base64url') : null };
  }

  async getMessage(workspaceId: string, channelId: string, messageId: string, signal?: AbortSignal): Promise<LogicalChannelMessage | undefined> {
    this.assertOpen(signal);
    const channel = this.channel(workspaceId, channelId);
    id(messageId);
    if (messageId.startsWith('legacy:')) {
      return (await this.legacyMessage(channel, messageId, signal))?.message;
    }
    const result = this.nativeMessage(channel, messageId);
    return result && messageProjection(result.row, result.grant.source_id);
  }

  async setMessageState(input: LogicalChannelMessageStateInput, signal?: AbortSignal): Promise<LogicalChannelMessage> {
    this.assertOpen(signal);
    const channel = this.channel(input.workspaceId, input.channelId);
    const messageId = id(input.messageId);
    requireValue(input.read === undefined || typeof input.read === 'boolean');
    requireValue(input.processed === undefined || typeof input.processed === 'boolean');
    if (messageId.startsWith('legacy:')) {
      const match = await this.legacyMessage(channel, messageId, signal);
      requireValue(match && this.options.legacy, 'channel-message-not-found');
      if (match.grant.source_owner === channel.workspace_id) {
        const result = await this.options.legacy.setMessageState({ ...input, messageId: match.originalId,
          sourceId: this.originalSourceId(match.grant) });
        requireValue(this.stillGranted(channel, match.grant), 'channel-source-changed');
        this.emit({ workspaceId: input.workspaceId, channelId: input.channelId, messageId: match.message.id, kind: 'state' });
        return this.projectLegacyMessage(channel, match.grant, result);
      }
      this.writeState(channel, match.grant.source_id, match.originalId, input.read ?? match.message.read, input.processed ?? match.message.processed);
      this.emit({ workspaceId: input.workspaceId, channelId: input.channelId, messageId: match.message.id, kind: 'state' });
      return { ...match.message, read: input.read ?? match.message.read, processed: input.processed ?? match.message.processed };
    }
    const result = this.nativeMessage(channel, messageId);
    requireValue(result, 'channel-message-not-found');
    const { row, grant } = result;
    const projection = messageProjection(row, grant.source_id);
    if (input.read === undefined && input.processed === undefined) return messageProjection(row, grant.source_id);
    const read = input.read ?? projection.read, processed = input.processed ?? projection.processed;
    const eventKey = row.event_key ?? row.id;
    this.writeState(channel, grant.source_id, eventKey, read, processed);
    const affected = this.store.database().prepare(`SELECT m.id,m.channel_id FROM messages m JOIN grants g ON g.id=m.grant_id
      JOIN channel_bindings b ON b.channel_id=m.channel_id AND b.workspace_id=?
      WHERE g.source_id=? AND coalesce(m.event_key,m.id)=?`).all(channel.workspace_id, grant.source_id, eventKey);
    for (const item of affected) this.emit({ workspaceId: input.workspaceId, channelId: String(item.channel_id),
      messageId: String(item.id), kind: 'state' });
    return { ...projection, read, processed };
  }

  private writeState(channel: BoundChannel, sourceId: string, eventKey: string, read: boolean, processed: boolean): void {
    this.store.database().prepare(`INSERT INTO workspace_message_state VALUES (?,?,?,?,?)
      ON CONFLICT(workspace_id,source_id,event_key) DO UPDATE SET read=excluded.read,processed=excluded.processed`)
      .run(channel.workspace_id, sourceId, eventKey, Number(read), Number(processed));
  }

  reply(input: LogicalChannelReplyInput, signal?: AbortSignal): Promise<LogicalChannelMessage> {
    return this.track(this.replyMessage(input, signal));
  }

  private async replyMessage(input: LogicalChannelReplyInput, signal?: AbortSignal): Promise<LogicalChannelMessage> {
    this.assertOpen(signal);
    const channel = this.channel(input.workspaceId, input.channelId);
    const messageId = id(input.messageId);
    if (messageId.startsWith('legacy:')) {
      const match = await this.legacyMessage(channel, messageId, signal);
      requireValue(match && match.message.direction === 'inbound' && this.options.legacy, 'channel-message-not-found');
      return this.deliverLegacy(channel, match.grant, signal, active => this.options.legacy!.reply({
        workspaceId: match.grant.source_owner, channelId: channel.id, messageId: match.originalId, sourceId: this.originalSourceId(match.grant),
        text: this.sendText(input.text, 20_000), requestId: this.legacyRequestId(channel, match.grant, id(input.requestId))
      }, active));
    }
    const match = this.nativeMessage(channel, messageId);
    requireValue(match && match.row.direction === 'inbound', 'channel-message-not-found');
    const details = JSON.parse(match.row.details) as MessageDetails;
    return this.deliverNative(channel, match.grant, {
      text: this.sendText(input.text), nativeMessageId: details.nativeMessageId, reply: true,
      ...(details.subject && { subject: details.subject.startsWith('Re: ') ? details.subject : `Re: ${details.subject}` })
    }, id(input.requestId), messageId, signal);
  }

  send(input: LogicalChannelSendInput, signal?: AbortSignal): Promise<LogicalChannelMessage> {
    return this.track(this.sendMessage(input, signal));
  }

  private async sendMessage(input: LogicalChannelSendInput, signal?: AbortSignal): Promise<LogicalChannelMessage> {
    this.assertOpen(signal);
    const channel = this.channel(input.workspaceId, input.channelId);
    const grant = this.grant(channel.id, id(input.sourceId));
    const text = this.sendText(input.text, grant.source_owner ? 20_000 : 4000);
    const requestId = id(input.requestId);
    const subject = input.subject;
    requireValue(subject === undefined || typeof subject === 'string' && subject.length <= 256 && !/[\r\n]/u.test(subject));
    if (grant.source_owner) {
      requireValue(this.options.legacy, 'channel-source-offline');
      const draftId = input.draftId === undefined ? undefined : this.originalMessageId(grant, id(input.draftId), channel);
      requireValue(input.draftId === undefined || draftId, 'channel-message-not-found');
      return this.deliverLegacy(channel, grant, signal, active => this.options.legacy!.send({
        ...input, workspaceId: grant.source_owner, channelId: channel.id, sourceId: this.originalSourceId(grant), text,
        requestId: this.legacyRequestId(channel, grant, requestId), subject, draftId
      }, active));
    }
    requireValue(input.recipient === undefined && input.draftId === undefined);
    return this.deliverNative(channel, grant, { text, ...(subject && { subject }) }, requestId, undefined, signal);
  }

  saveDraft(input: LogicalChannelDraftInput, signal?: AbortSignal): Promise<LogicalChannelMessage> {
    return this.track(this.saveLegacyDraft(input, signal));
  }

  private async saveLegacyDraft(input: LogicalChannelDraftInput, signal?: AbortSignal): Promise<LogicalChannelMessage> {
    this.assertOpen(signal);
    const channel = this.channel(input.workspaceId, input.channelId);
    const grant = this.grant(channel.id, id(input.sourceId));
    requireValue(grant.source_owner && this.options.legacy?.saveDraft, 'channel-draft-unavailable');
    const draftId = input.draftId === undefined ? undefined : this.originalMessageId(grant, id(input.draftId), channel);
    requireValue(input.draftId === undefined || draftId, 'channel-message-not-found');
    return this.deliverLegacy(channel, grant, signal, active => this.options.legacy!.saveDraft!({
      ...input, workspaceId: grant.source_owner, sourceId: this.originalSourceId(grant), draftId
    }, active), false);
  }

  private async deliverLegacy(channel: BoundChannel, grant: StoredGrant, signal: AbortSignal | undefined,
    send: (signal: AbortSignal) => Promise<LogicalChannelMessage>, requiresSend = true): Promise<LogicalChannelMessage> {
    requireValue(!requiresSend || grant.permission === 'reply', 'channel-source-read-only');
    const current = this.lease(grant.id, signal, channel);
    try {
      current.signal.throwIfAborted();
      const result = await send(current.signal);
      const projected = this.projectLegacyMessage(channel, grant, result);
      if (this.stillGranted(channel, grant)) this.emitChannel(channel.id, 'message', projected.id);
      return projected;
    } finally { current.release(); }
  }

  private async deliverNative(channel: BoundChannel, grant: StoredGrant, message: DeliveryText, requestId: string,
    replyToId?: string, signal?: AbortSignal): Promise<LogicalChannelMessage> {
    requireValue(grant.permission === 'reply', 'channel-source-read-only');
    const source = this.sourceFor(grant);
    requireValue(!source.retired && detailsOf(source).canSend, 'channel-source-not-sendable');
    const db = this.store.database();
    const requestKey = hash([channel.workspace_id, channel.id, requestId]);
    const digest = hash([grant.id, message.text, message.subject ?? null, replyToId ?? null]);
    const prior = db.prepare('SELECT digest,message_id FROM send_receipts WHERE request_key=?').get(requestKey);
    if (prior) {
      requireValue(prior.digest === digest, 'channel-request-conflict');
      const existing = this.nativeMessage(channel, String(prior.message_id));
      requireValue(existing, 'channel-send-result-expired');
      return messageProjection(existing.row, grant.source_id);
    }
    const active = this.lease(grant.id, signal, channel);
    const address = sourceAddress(source);
    try {
      active.signal.throwIfAborted();
      requireValue(await this.options.connected(address.provider, address.botId, active.signal), 'channel-source-offline');
      active.signal.throwIfAborted();
      requireValue(this.stillGranted(channel, grant, 'reply'), 'channel-source-changed');
      const details: MessageDetails = { text: message.text, senderLabel: '你', read: true, processed: true,
        ...(message.subject && { subject: message.subject }), ...(replyToId && { replyToId }) };
      const row: StoredMessage = {
        id: randomUUID(), channel_id: channel.id, grant_id: grant.id, direction: 'outbound',
        created_at: this.now(), status: 'submitted', details: JSON.stringify(details)
      };
      const existing = this.store.transaction(() => {
        const concurrent = db.prepare('SELECT digest,message_id FROM send_receipts WHERE request_key=?').get(requestKey);
        if (concurrent) {
          requireValue(concurrent.digest === digest, 'channel-request-conflict');
          const saved = this.nativeMessage(channel, String(concurrent.message_id));
          requireValue(saved, 'channel-send-result-expired');
          return saved.row;
        }
        db.prepare('INSERT INTO send_receipts VALUES (?,?,?,?,?)').run(requestKey, digest, row.id, row.status, row.created_at);
        db.prepare(`INSERT INTO messages
          (id,channel_id,grant_id,event_key,request_key,request_digest,direction,status,created_at,details) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          row.id, channel.id, grant.id, null, requestKey, digest, row.direction, row.status, row.created_at, row.details);
        return null;
      });
      if (existing) return messageProjection(existing, grant.source_id);
      try {
        await this.options.send(address, {
          ...message, nativeMessageId: message.nativeMessageId ?? detailsOf(this.sourceFor(grant)).latestMessageId
        }, active.signal);
        row.status = 'sent';
      } catch (error) {
        const code = (error as { code?: string })?.code;
        row.status = code && KNOWN_NOT_SENT.has(code) ? 'failed' : 'unknown';
        details.reason = row.status === 'failed' ? code : 'send-result-unknown';
        row.details = JSON.stringify(details);
      }
      this.store.transaction(() => {
        db.prepare('UPDATE send_receipts SET status=? WHERE request_key=?').run(row.status, requestKey);
        db.prepare('UPDATE messages SET status=?, details=? WHERE id=?').run(row.status, row.details, row.id);
        if (this.stillGranted(channel, grant)) this.stage(channel.id, grant.source_id,
          row.status === 'sent' ? 'reply' : 'failure', details.reason);
      });
      if (this.stillGranted(channel, grant)) this.emitChannel(channel.id, 'message', row.id);
      return messageProjection(row, grant.source_id);
    } finally { active.release(); }
  }

  receive(input: WorkbenchRemoteInput): Promise<WorkbenchRemoteReply> {
    return this.track(this.receiveMessage(input));
  }

  private async receiveMessage(input: WorkbenchRemoteInput): Promise<WorkbenchRemoteReply> {
    if (this.admission.signal.aborted || input.signal?.aborted || input.senderIsBot !== false ||
        !PROVIDERS.has(input.channelKey) || ![input.botId, input.conversationId, input.messageId, input.senderId].every(isMessagingId) ||
        input.threadId !== undefined && !isMessagingId(input.threadId) ||
        input.conversationType !== 'direct' && input.conversationType !== 'group') return NO_REPLY;
    const address: SourceAddress = { provider: input.channelKey, botId: input.botId, conversationId: input.conversationId,
      conversationType: input.conversationType, ...(input.threadId && { threadId: input.threadId }) };
    const db = this.store.database();
    const addressKey = origin(address);
    const previous = db.prepare('SELECT id, owner, provider, bot_id AS botId, retired, details FROM sources WHERE address_key=? AND retired=0')
      .get(addressKey) as StoredSource | undefined;
    const sourceId = previous?.id ?? randomUUID();
    const addressable = input.conversationType === 'direct' || input.addressed === true;
    if (!addressable && !previous) return NO_REPLY;
    const at = this.now();
    const sourceDetails: SourceDetails = {
      conversationId: input.conversationId, conversationType: input.conversationType, threadId: input.threadId,
      label: boundedLabel(input.conversationLabel, previous ? detailsOf(previous).label : input.conversationId),
      lastSeenAt: at, canRemote: input.channelKey !== 'email', canSend: true,
      latestMessageId: isMessagingId(input.nativeMessageId) ? input.nativeMessageId : input.messageId
    };
    const memberships = (db.prepare(`
      SELECT g.*, c.notify AS channel_notify
      FROM grants g JOIN channels c ON g.channel_id=c.id WHERE g.source_id=? AND g.source_owner='' ORDER BY c.id
    `).all(sourceId) as (StoredGrant & { channel_notify: LogicalChannelNotify })[]);
    const remoteGrant = memberships.find(item => item.target !== null);
    const scope = remoteGrant ? { id: remoteGrant.id, source: address } : undefined;
    let intent: ReturnType<RemotePort['intent']> = 'none';
    let remoteUnavailable = false;
    try { if (addressable) intent = this.options.remote.intent(input, scope); }
    catch { remoteUnavailable = true; }
    const recognizedPair = typeof input.text === 'string' && (/^\s*(?:接入|绑定|\/pair)(?:\s+[0-9]{6})?\s*$/u.test(input.text) ||
      this.options.remote.isPairingSecret?.(input.text));
    const eventKey = hash([input.messageId, input.senderId]);
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, MAX_TEXT) : '';
    const records: LogicalChannelChange[] = [];
    const notices = new Map<string, { grantId: string; mode: LogicalChannelNotify }>();
    const boundWorkspaces = new Map(memberships.map(grant => [grant.id, this.workspacesFor(grant.channel_id)]));
    if (intent !== 'control' && !remoteUnavailable) for (const grant of memberships) {
      const mode = grant.notify ?? grant.channel_notify;
      for (const workspaceId of boundWorkspaces.get(grant.id) ?? []) {
        const previous = notices.get(workspaceId);
        if (mode !== 'mute' && (!previous || mode === 'wake' && previous.mode !== 'wake')) {
          notices.set(workspaceId, { grantId: grant.id, mode });
        }
      }
    }
    const committed = this.store.transaction(() => {
      this.pruneInboundClaims(at);
      const result = db.prepare('INSERT OR IGNORE INTO inbound_claims VALUES (?,?,?,?)')
        .run(addressKey, eventKey, at, memberships.length || intent !== 'none' ? 1 : 0);
      if (!result.changes) return false;
      if (!previous) requireValue(Number(db.prepare('SELECT count(*) AS n FROM sources WHERE owner=?').get('')?.n) < SOURCE_LIMIT,
        'channel-source-discovery-limit');
      db.prepare(`INSERT INTO sources (id,owner,provider,bot_id,address_key,details) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id,owner) DO UPDATE SET details=excluded.details`)
        .run(sourceId, '', address.provider, address.botId, addressKey, JSON.stringify(sourceDetails));
      if (!memberships.length && intent === 'none') return false;
      for (const grant of memberships) {
        this.stage(grant.channel_id, sourceId, 'receive');
        if (remoteUnavailable && grant.id === remoteGrant?.id) this.stage(grant.channel_id, sourceId, 'failure', 'remote-store-unavailable');
        if (intent === 'pair' || recognizedPair || !text) continue;
        const messageId = randomUUID();
        const subject = typeof input.subject === 'string' ? input.subject.replace(/[\r\n]/gu, ' ').slice(0, 256) : undefined;
        const details: MessageDetails = {
          text, senderLabel: boundedLabel(input.senderLabel, input.senderId),
          nativeMessageId: isMessagingId(input.nativeMessageId) ? input.nativeMessageId : input.messageId,
          read: false, processed: false, remoteHandled: intent === 'control',
          ...(subject && { subject })
        };
        const { lastInsertRowid } = db.prepare(`INSERT INTO messages
          (id,channel_id,grant_id,event_key,request_key,request_digest,direction,status,created_at,details) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(messageId, grant.channel_id, grant.id, eventKey, null, null, 'inbound', 'received', at, JSON.stringify(details));
        for (const workspaceId of boundWorkspaces.get(grant.id) ?? []) {
          if (notices.get(workspaceId)?.grantId === grant.id) {
            db.prepare('INSERT INTO workspace_notices VALUES (?,?,?)').run(workspaceId, grant.channel_id, lastInsertRowid);
          }
          records.push({ workspaceId, channelId: grant.channel_id, messageId, kind: 'message' });
        }
      }
      if (remoteGrant && intent === 'control') this.stage(remoteGrant.channel_id, sourceId, 'authorized');
      return true;
    });
    if (!committed) return NO_REPLY;
    for (const change of records) this.emit(change);
    if (intent === 'none') return NO_REPLY;
    if (this.admission.signal.aborted || input.signal?.aborted) return NO_REPLY;
    if (!remoteGrant) return this.options.remote.handle(input, scope);
    const current = this.lease(remoteGrant.id, input.signal);
    try {
      current.signal.throwIfAborted();
      if (intent === 'control') this.stage(remoteGrant.channel_id, sourceId, 'routed');
      const result = await this.options.remote.handle({
        ...input, signal: current.signal,
        ...(input.deliver && { deliver: async (reply, signal) => {
          await input.deliver!(reply, signal);
          if (!signal.aborted) this.stage(remoteGrant.channel_id, sourceId, reply.failure ? 'failure' : 'reply', reply.failure);
        } })
      }, scope);
      if (current.signal.aborted) return NO_REPLY;
      if ((result.text || result.image) && input.deliver) {
        await input.deliver(result, current.signal);
        if (!current.signal.aborted) this.stage(remoteGrant.channel_id, sourceId, result.failure ? 'failure' : 'reply', result.failure);
      }
      if (!input.deliver && result.failure) this.stage(remoteGrant.channel_id, sourceId, 'failure', result.failure);
      return input.deliver ? NO_REPLY : result;
    } catch {
      if (!current.signal.aborted) this.stage(remoteGrant.channel_id, sourceId, 'failure', 'remote-result-unknown');
      return NO_REPLY;
    } finally { current.release(); }
  }

  /** The legacy Feishu listener authenticates the human and owns its reply transport. */
  receiveLegacyRemote(workspaceId: string, input: Omit<WorkbenchRemoteInput, 'channelKey' | 'botId'>): Promise<boolean> {
    return this.track(this.receiveLegacyMessage(workspaceId, input));
  }

  private async receiveLegacyMessage(workspaceId: string, input: Omit<WorkbenchRemoteInput, 'channelKey' | 'botId'>): Promise<boolean> {
    if (this.admission.signal.aborted || input.signal?.aborted || !this.options.workspaceExists(workspaceId) ||
        input.senderIsBot !== false || input.conversationType === 'group' && !input.addressed ||
        ![input.senderId, input.conversationId, input.messageId].every(isMessagingId)) return false;
    if (input.threadId) return this.options.remote.isPairingSecret?.(input.text) ?? false;
    const db = this.store.database();
    const candidates = db.prepare(`SELECT g.*,c.name,c.notify AS channel_notify FROM grants g
      JOIN sources s ON s.id=g.source_id AND s.owner=g.source_owner JOIN channels c ON c.id=g.channel_id
      WHERE s.owner=? AND s.provider='feishu' AND json_extract(s.details,'$.conversationId')=?
      AND json_extract(s.details,'$.canRemote')=1 AND json_extract(s.details,'$.legacyConnected')=1
      AND g.target IS NOT NULL ORDER BY g.id LIMIT 2`).all(workspaceId, input.conversationId) as
      (StoredGrant & { name: string; channel_notify: LogicalChannelNotify })[];
    if (candidates.length !== 1) return this.options.remote.isPairingSecret?.(input.text) ?? false;
    const [row] = candidates;
    const channel = { id: row.channel_id, name: row.name, notify: row.channel_notify };
    const scope = this.remoteScope(row)!;
    scope.source.conversationType = input.conversationType;
    const event: WorkbenchRemoteInput = { ...input, channelKey: 'feishu', botId: scope.source.botId };
    let intent: ReturnType<RemotePort['intent']>;
    try { intent = this.options.remote.intent(event, scope); }
    catch { return false; }
    if (intent === 'none') return this.options.remote.isPairingSecret?.(input.text) ?? false;
    const at = this.now();
    const accepted = this.store.transaction(() => {
      this.pruneInboundClaims(at);
      const sourceKey = hash([workspaceId, this.originalSourceId(row)]);
      const changes = db.prepare('INSERT OR IGNORE INTO inbound_claims VALUES (?,?,?,1)')
        .run(sourceKey, hash([input.messageId, input.senderId]), at).changes;
      if (changes) this.stage(channel.id, row.source_id, 'receive');
      if (changes && intent === 'control') this.stage(channel.id, row.source_id, 'authorized');
      return changes;
    });
    if (!accepted) return true;
    if (intent === 'control') this.stage(channel.id, row.source_id, 'routed');
    this.track(this.deliverLegacyRemote(row, channel, event, scope));
    return true;
  }

  private async deliverLegacyRemote(row: StoredGrant, channel: StoredChannel, input: WorkbenchRemoteInput, scope: LogicalRemoteScope): Promise<void> {
    const active = this.lease(row.id, input.signal);
    try {
      const result = await this.options.remote.handle({ ...input, signal: active.signal,
        ...(input.deliver && { deliver: async (reply, signal) => {
          await input.deliver!(reply, signal);
          if (!signal.aborted) this.stage(channel.id, row.source_id, reply.failure ? 'failure' : 'reply', reply.failure);
        } })
      }, scope);
      if (!active.signal.aborted) {
        if ((result.text || result.image) && input.deliver) {
          await input.deliver(result, active.signal);
          if (!active.signal.aborted) this.stage(channel.id, row.source_id, result.failure ? 'failure' : 'reply', result.failure);
        }
      }
    } catch {
      if (!active.signal.aborted) this.stage(channel.id, row.source_id, 'failure', 'remote-result-unknown');
    } finally { active.release(); }
  }

  revokeLegacyProvider(workspaceId: string, provider: string): void {
    if (this.admission.signal.aborted) return;
    const db = this.store.database();
    const grants = db.prepare(`SELECT g.* FROM grants g JOIN sources s ON s.id=g.source_id AND s.owner=g.source_owner
      WHERE s.owner=? AND s.provider=?`).all(workspaceId, provider) as StoredGrant[];
    this.store.transaction(() => {
      for (const grant of grants) {
        this.revokeGrant(grant);
        db.prepare('UPDATE grants SET target=NULL WHERE id=?').run(grant.id);
      }
      db.prepare(`UPDATE sources SET details=json_set(details,'$.legacyConnected',json('false')) WHERE owner=? AND provider=?`).run(workspaceId, provider);
    });
  }

  /** Explicit disconnect and deletion revoke all capabilities backed by the old login. */
  revokeAccount(provider: string, botId: string, remove: boolean): void {
    this.assertOpen();
    const db = this.store.database();
    const affected = db.prepare(`
      SELECT g.* FROM grants g JOIN sources s ON s.id=g.source_id AND s.owner=g.source_owner
      WHERE s.owner='' AND s.provider=? AND s.bot_id=?
    `).all(provider, botId) as StoredGrant[];
    for (const grant of affected) {
      this.revokeGrant(grant);
    }
    this.store.transaction(() => {
      db.prepare(`UPDATE grants SET target=NULL WHERE id IN (
        SELECT g.id FROM grants g JOIN sources s ON s.id=g.source_id AND s.owner=g.source_owner
        WHERE s.owner='' AND s.provider=? AND s.bot_id=?
      )`).run(provider, botId);
      if (remove) db.prepare("UPDATE sources SET retired=1 WHERE owner='' AND provider=? AND bot_id=?").run(provider, botId);
    });
    for (const channelId of new Set(affected.map(grant => grant.channel_id))) this.emitChannel(channelId, 'channel');
  }

  private async syncAllLegacy(signal?: AbortSignal, workspaceId?: string): Promise<void> {
    if (!this.options.legacy) return;
    const workspaces = this.options.workspaceIds?.() ?? (workspaceId ? [workspaceId] : []);
    for (const owner of new Set(workspaces)) {
      if (this.options.workspaceExists(owner)) await this.syncLegacy(owner, signal);
    }
    this.assertOpen(signal);
  }

  private async syncLegacy(workspaceId: string, signal?: AbortSignal): Promise<void> {
    if (!this.options.legacy) return;
    this.assertOpen(signal);
    const available = await this.options.legacy.listSources(workspaceId);
    this.assertOpen(signal);
    if (!this.options.workspaceExists(workspaceId)) return;
    const db = this.store.database();
    this.store.transaction(() => {
      db.prepare(`UPDATE sources SET details=json_set(details,'$.legacyConnected',json('false'),'$.legacyProvided',json('false')) WHERE owner=?`).run(workspaceId);
      for (const source of available.slice(0, SOURCE_LIMIT)) {
        if (!source.id.startsWith('legacy:') || !isMessagingId(source.id) || !isMessagingId(source.botId) ||
            !isMessagingId(source.conversationId) || !PROVIDERS.has(source.provider)) continue;
        const globalId = legacyGlobalSourceId(workspaceId, source.id);
        const details: SourceDetails = {
          conversationId: source.conversationId, threadId: source.threadId, conversationType: source.conversationType,
          label: boundedLabel(source.label, source.conversationId), lastSeenAt: source.lastSeenAt,
          canRemote: source.provider === 'feishu' && source.canRemote === true,
          canSend: !!source.canSend, legacyConnected: !!source.connected, legacyId: source.id, legacyProvided: true,
          ...(source.legacyNamePlaceholder && { legacyNamePlaceholder: source.legacyNamePlaceholder })
        };
        db.prepare(`INSERT INTO sources (id,owner,provider,bot_id,details) VALUES (?,?,?,?,?)
          ON CONFLICT(id,owner) DO UPDATE SET details=excluded.details`)
          .run(globalId, workspaceId, source.provider, source.botId, JSON.stringify(details));
        if (!source.legacyDefault || db.prepare('SELECT 1 FROM legacy_defaults WHERE workspace_id=? AND source_id=?').get(workspaceId, source.id)) continue;
        if (!db.prepare('SELECT 1 FROM grants WHERE source_id=? AND source_owner=?').get(globalId, workspaceId)) {
          const channelId = randomUUID();
          db.prepare('INSERT INTO channels VALUES (?,?,?,?)').run(channelId, '',
            name(source.legacyDefault.name), notify(source.legacyDefault.notify));
          this.addGrant(channelId, { id: globalId, owner: workspaceId, provider: source.provider, botId: source.botId,
            retired: 0, details: JSON.stringify(details) }, permission(source.legacyDefault.permission), null, null, 0);
          db.prepare('INSERT INTO channel_bindings (workspace_id,channel_id,generation) VALUES (?,?,?)').run(workspaceId, channelId, randomUUID());
        }
        db.prepare('INSERT INTO legacy_defaults VALUES (?,?)').run(workspaceId, source.id);
      }
    });
  }

  private originalSourceId(grant: StoredGrant): string {
    const legacyId = detailsOf(this.sourceFor(grant)).legacyId;
    requireValue(legacyId, 'channel-source-not-found');
    return legacyId;
  }

  private originalMessageId(grant: StoredGrant, value: string, channel: BoundChannel): string | undefined {
    const prefix = `${grant.source_id}:`;
    if (value.startsWith(prefix)) return `legacy:${value.slice(prefix.length)}`;
    if (channel.workspace_id === grant.source_owner && /^legacy:(?:mail|messages):/u.test(value)) return value;
  }

  private legacyRequestId(channel: BoundChannel, grant: StoredGrant, requestId: string): string {
    return channel.workspace_id === grant.source_owner ? requestId : `channel-${hash([channel.workspace_id, channel.id, requestId])}`;
  }

  private projectLegacyMessage(channel: BoundChannel, grant: StoredGrant,
    { legacyOwnerMuted, ...message }: LogicalChannelMessage & { legacyOwnerMuted?: boolean }): LogicalChannelMessage {
    const result = { ...message, id: `${grant.source_id}:${message.id.slice('legacy:'.length)}`, sourceId: grant.source_id };
    const owner = channel.workspace_id === grant.source_owner;
    if (!owner) {
      const state = this.store.database().prepare(`SELECT read,processed FROM workspace_message_state
        WHERE workspace_id=? AND source_id=? AND event_key=?`).get(channel.workspace_id, grant.source_id, message.id);
      result.read = state ? state.read === 1 : message.direction === 'outbound';
      result.processed = state ? state.processed === 1 : message.direction === 'outbound';
    }
    result.notificationOwner = message.direction === 'inbound' && message.notificationOwner !== false && !(owner && legacyOwnerMuted) &&
      !result.read && !result.processed && !!this.store.database().prepare(`
      SELECT 1 FROM legacy_notice_refs r JOIN legacy_workspace_notices n ON n.ordinal=r.ordinal
      WHERE r.message_id=? AND n.workspace_id=? AND n.channel_id=? AND n.grant_id=? LIMIT 1`)
      .get(message.id, channel.workspace_id, channel.id, grant.id);
    return result;
  }

  private async listLegacyMessages(channel: BoundChannel, grant: StoredGrant,
    query: Parameters<LogicalChannelLegacyAdapter['listMessages']>[3], boundary?: { createdAt: number; id: string },
    signal?: AbortSignal): Promise<LogicalChannelMessage[]> {
    if (!this.options.legacy || !this.options.workspaceExists(grant.source_owner)) return [];
    const sourceId = this.originalSourceId(grant), prefix = `${grant.source_id}:`;
    const local = channel.workspace_id === grant.source_owner;
    const ascending = query.order === 'asc';
    const limit = query.limit ?? 40;
    let after = boundary && { createdAt: boundary.createdAt, id: boundary.id.startsWith(prefix)
      ? `legacy:${boundary.id.slice(prefix.length)}` : prefix > boundary.id ? '' : '\uffff' };
    const messages: LogicalChannelMessage[] = [];
    while (messages.length < limit) {
      this.assertOpen(signal);
      const records = await this.options.legacy.listMessages(grant.source_owner, channel.id, sourceId, {
        ...query, after, unread: local ? query.unread : undefined, processed: local ? query.processed : undefined
      });
      if (!this.stillGranted(channel, grant)) return [];
      for (const record of records) {
        if (record.channelId !== channel.id || record.sourceId !== sourceId) continue;
        const message = this.projectLegacyMessage(channel, grant, record);
        if (boundary && compareMessage(message, boundary) * (ascending ? 1 : -1) <= 0) continue;
        if (query.unread !== undefined && (message.direction === 'inbound' && !message.read) !== query.unread) continue;
        if (query.processed !== undefined && message.processed !== query.processed) continue;
        messages.push(message);
      }
      const last = records.at(-1);
      if (records.length < limit || !last || after && compareMessage(last, after) * (ascending ? 1 : -1) <= 0) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
    return messages.slice(0, limit);
  }

  private async legacyMessage(channel: BoundChannel, messageId: string, signal?: AbortSignal): Promise<{
    message: LogicalChannelMessage; grant: StoredGrant; originalId: string;
  } | undefined> {
    if (!this.options.legacy) return;
    this.assertOpen(signal);
    for (const grant of this.grants(channel.id).filter(grant => grant.source_owner)) {
      const originalId = this.originalMessageId(grant, messageId, channel);
      if (!originalId || !this.options.workspaceExists(grant.source_owner)) continue;
      const sourceId = this.originalSourceId(grant);
      const message = await this.options.legacy.getMessage(grant.source_owner, channel.id, sourceId, originalId);
      this.assertOpen(signal);
      if (message?.id === originalId && message.channelId === channel.id && message.sourceId === sourceId &&
          this.stillGranted(channel, grant)) return { message: this.projectLegacyMessage(channel, grant, message), grant, originalId };
    }
  }

  private nativeMessage(channel: BoundChannel, messageId: string): { row: StoredMessage; grant: StoredGrant } | undefined {
    const db = this.store.database();
    const row = db.prepare(`SELECT ${WORKSPACE_MESSAGE_COLUMNS} ${WORKSPACE_MESSAGES} WHERE m.channel_id=? AND m.id=?`)
      .get(channel.workspace_id, channel.workspace_id, channel.id, messageId) as StoredMessage | undefined;
    if (!row) return;
    const grant = db.prepare('SELECT * FROM grants WHERE id=? AND channel_id=?').get(row.grant_id, channel.id) as StoredGrant | undefined;
    if (grant) return { row, grant };
  }

  private readCursor(value: unknown, channelId: string, order: string): { createdAt: number; id: string } | undefined {
    if (value === undefined) return undefined;
    try {
      requireValue(typeof value === 'string' && value.length <= 2048);
      const [channel, direction, createdAt, messageId] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown[];
      requireValue(channel === channelId && direction === order && typeof createdAt === 'number' && Number.isSafeInteger(createdAt));
      return { createdAt, id: id(messageId) };
    } catch { throw new LogicalChannelError('invalid-channel-cursor'); }
  }

  private sendText(value: unknown, maxLength = 4000): string {
    requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value));
    return value.trim();
  }

  private diagnostics(channel: StoredChannel): LogicalChannelDiagnostics {
    const db = this.store.database();
    const rows = db.prepare('SELECT * FROM stages WHERE channel_id=? ORDER BY sequence DESC').all(channel.id) as StoredStage[];
    const stages: LogicalChannelDiagnostics['stages'] = { receive: 0, authorized: 0, routed: 0, reply: 0, failure: 0 };
    for (const row of rows) stages[row.stage] = row.count;
    const counters = db.prepare(`SELECT SUM(status='received') AS received, SUM(status='sent') AS sent,
      SUM(status='failed') AS failed, SUM(status='unknown') AS unknown,
      SUM(json_extract(details,'$.remoteHandled')=1) AS remote_handled FROM messages WHERE channel_id=?`).get(channel.id);
    const last = db.prepare(`SELECT m.*, g.source_id FROM messages m JOIN grants g ON m.grant_id=g.id
      WHERE m.channel_id=? ORDER BY m.created_at DESC,m.id DESC LIMIT 1`).get(channel.id) as (StoredMessage & { source_id: string }) | undefined;
    const first = rows[0];
    return { received: Number(counters?.received ?? 0), remoteHandled: Number(counters?.remote_handled ?? 0),
      sent: Number(counters?.sent ?? 0), failed: Number(counters?.failed ?? 0), unknown: Number(counters?.unknown ?? 0), stages,
      ...(first && { lastStage: { stage: first.stage, at: first.at, reason: first.reason ?? undefined, sourceId: first.source_id ?? undefined } }),
      ...(last && { lastMessage: messageProjection(last, last.source_id) }) };
  }

  private stage(channelId: string, sourceId: string, stage: LogicalChannelStage, reason?: string): void {
    this.store.database().prepare(`INSERT INTO stages VALUES (?,?,1,?,(SELECT coalesce(max(sequence),0)+1 FROM stages WHERE channel_id=?),?,?)
      ON CONFLICT(channel_id,stage) DO UPDATE SET count=count+1, at=excluded.at, sequence=excluded.sequence,
      source_id=excluded.source_id, reason=excluded.reason`)
      .run(channelId, stage, this.now(), channelId, sourceId, reason ?? null);
  }

  private pruneInboundClaims(now: number): void {
    this.store.database().prepare('DELETE FROM inbound_claims WHERE retained=0 AND created_at<?').run(now - RETENTION);
  }

  private async projectChannel(channel: StoredChannel, signal?: AbortSignal, includeRemote = false): Promise<LogicalChannel> {
    const connections = new Map<string, Promise<boolean>>();
    const sources = await Promise.all(this.grants(channel.id).map(async grant => {
      const source = await this.projectSource(this.sourceFor(grant), signal, connections, includeRemote);
      this.assertOpen(signal);
      if (!this.stillGranted(channel, grant)) return undefined;
      const scope = includeRemote ? this.remoteScope(grant) : undefined;
      const remote = scope ? this.options.remote.manage(scope, 'remote.status') : null;
      return { sourceId: source.id, source, permission: grant.permission, notify: grant.notify,
        remoteTarget: includeRemote ? storedTarget(grant) : null, remote };
    }));
    this.assertOpen(signal);
    return { id: channel.id, name: channel.name, notify: channel.notify,
      sources: sources.filter(item => item !== undefined) };
  }

  private async projectSource(row: StoredSource, signal: AbortSignal | undefined,
    connections: Map<string, Promise<boolean>>, includeLegacyOwner = false): Promise<LogicalChannelSource> {
    const { legacyConnected, legacyProvided, latestMessageId: _latest, legacyId: _legacy, ...details } = detailsOf(row);
    const key = JSON.stringify([row.provider, row.botId]);
    if (row.retired) return { ...details, id: row.id, provider: row.provider, botId: row.botId,
      connected: false, canSend: false, canRemote: false };
    if (row.owner) {
      const available = this.options.workspaceExists(row.owner) && legacyProvided !== false;
      return { ...details, id: row.id, provider: row.provider, botId: row.botId, connected: available && legacyConnected === true,
        canSend: available && details.canSend, canRemote: available && details.canRemote,
        ...(includeLegacyOwner && { legacyOwnerWorkspaceId: row.owner }) };
    }
    let state = connections.get(key);
    if (!state) {
      state = this.options.connected(row.provider, row.botId, this.signal(signal)).catch(() => false);
      connections.set(key, state);
    }
    return { ...details, id: row.id, provider: row.provider, botId: row.botId, connected: await state };
  }

  private globalChannel(channelId: string): StoredChannel {
    const row = this.store.database().prepare('SELECT id,name,notify FROM channels WHERE id=?').get(id(channelId)) as StoredChannel | undefined;
    requireValue(row, 'channel-not-found');
    return row;
  }

  private channel(workspaceId: string, channelId: string): BoundChannel {
    this.assertWorkspace(workspaceId);
    const row = this.store.database().prepare(`SELECT c.id,c.name,c.notify,b.workspace_id,b.generation FROM channels c
      JOIN channel_bindings b ON b.channel_id=c.id WHERE c.id=? AND b.workspace_id=?`)
      .get(id(channelId), workspaceId) as BoundChannel | undefined;
    if (!row) {
      this.globalChannel(channelId);
      throw new LogicalChannelError('channel-not-bound');
    }
    return row;
  }

  private grant(channelId: string, sourceId: string): StoredGrant {
    const row = this.store.database().prepare('SELECT * FROM grants WHERE channel_id=? AND source_id=?')
      .get(channelId, sourceId) as StoredGrant | undefined;
    requireValue(row, 'channel-source-not-granted');
    return row;
  }

  private grants(channelId: string): StoredGrant[] {
    return this.store.database().prepare('SELECT * FROM grants WHERE channel_id=? ORDER BY rowid').all(channelId) as StoredGrant[];
  }

  private source(sourceId: string, owner: string): StoredSource | undefined {
    return this.store.database().prepare('SELECT id, owner, provider, bot_id AS botId, retired, details FROM sources WHERE id=? AND owner=?')
      .get(sourceId, owner) as StoredSource | undefined;
  }

  private sourceFor(grant: StoredGrant): StoredSource {
    const row = this.source(grant.source_id, grant.source_owner);
    requireValue(row, 'channel-source-not-found');
    return row;
  }

  private remoteScope(grant: StoredGrant): LogicalRemoteScope | undefined {
    if (grant.target !== null) return { id: grant.id, source: sourceAddress(this.sourceFor(grant)) };
  }

  private revokeGrant(grant: StoredGrant): void {
    this.abortGrant(grant.id);
    const scope = this.remoteScope(grant);
    if (scope) this.options.remote.revoke(scope);
    if (!grant.source_owner) this.options.remote.revokeLegacySource?.(sourceAddress(this.sourceFor(grant)));
  }

  private abortGrant(id: string): void {
    for (const controller of this.active.get(id) ?? []) controller.abort();
  }

  private stillBound(channel: BoundChannel): boolean {
    return !this.admission.signal.aborted && this.options.workspaceExists(channel.workspace_id) && !!this.store.database()
      .prepare('SELECT 1 FROM channel_bindings WHERE workspace_id=? AND channel_id=? AND generation=?')
      .get(channel.workspace_id, channel.id, channel.generation);
  }

  private assertBound(channel: BoundChannel): void {
    if (!this.stillBound(channel)) {
      this.assertOpen();
      this.globalChannel(channel.id);
      throw new LogicalChannelError('channel-not-bound');
    }
  }

  private stillGranted(channel: StoredChannel, grant: StoredGrant, access?: LogicalChannelPermission): boolean {
    if (this.admission.signal.aborted || 'generation' in channel && !this.stillBound(channel as BoundChannel)) return false;
    const row = this.store.database().prepare('SELECT * FROM grants WHERE id=? AND channel_id=?').get(grant.id, channel.id) as StoredGrant | undefined;
    return !!row && (access === undefined || row.permission === access);
  }

  private bindingKey(workspaceId: string, channelId: string): string { return JSON.stringify([workspaceId, channelId]); }

  private lease(id: string, signal?: AbortSignal, channel?: BoundChannel): { signal: AbortSignal; release(): void } {
    const controller = new AbortController();
    const keys = channel ? [id, this.bindingKey(channel.workspace_id, channel.id)] : [id];
    for (const key of keys) {
      const running = this.active.get(key) ?? new Set<AbortController>();
      running.add(controller);
      this.active.set(key, running);
    }
    return { signal: AbortSignal.any([this.admission.signal, controller.signal, ...(signal ? [signal] : [])]), release: () => {
      for (const key of keys) {
        const running = this.active.get(key);
        running?.delete(controller);
        if (!running?.size) this.active.delete(key);
      }
    } };
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.admission.signal]) : this.admission.signal;
  }

  private assertOpen(signal?: AbortSignal): void {
    requireValue(!this.admission.signal.aborted && !signal?.aborted, 'cancelled');
  }

  private assertWorkspace(workspaceId: string): void {
    this.assertOpen();
    requireValue(this.options.workspaceExists(id(workspaceId)), 'channel-workspace-not-found');
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const release = () => { this.pending.delete(promise); };
    void promise.then(release, release);
    return promise;
  }

  private emit(change: LogicalChannelChange): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* A listener cannot undo committed state. */ }
    }
  }

  private workspacesFor(channelId: string): string[] {
    return this.store.database().prepare('SELECT workspace_id FROM channel_bindings WHERE channel_id=?').all(channelId)
      .map(row => String(row.workspace_id)).filter(workspaceId => this.options.workspaceExists(workspaceId));
  }

  private emitChannel(channelId: string, kind: LogicalChannelChange['kind'], messageId?: string): void {
    for (const workspaceId of this.workspacesFor(channelId)) this.emit({ workspaceId, channelId, kind, messageId });
  }

  private emitCatalog(channelId: string): void {
    for (const workspaceId of new Set(this.options.workspaceIds?.() ?? this.workspacesFor(channelId))) {
      if (this.options.workspaceExists(workspaceId)) this.emit({ workspaceId, channelId, kind: 'channel' });
    }
  }
}
