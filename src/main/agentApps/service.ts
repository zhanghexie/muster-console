import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appError, CHANNEL_APP_ID, isLegacyChannelApp, normalizeAppQueryWindow, validateAppDefinition, validateRecordValues, type AgentAppDefinition, type AppCall, type AppCallResult, type AppChanged, type AppCommand, type AppConnection, type AppConnectionInput, type AppFeishuChat, type AppFeishuChatPage, type AppLibraryItem, type AppOperation, type AppPermission, type AppPlaceholderFields, type AppQuery, type AppRecord, type AppSnapshot, type AppValues } from '../../shared/agentApps';
import { clearChangedAppPlaceholders, validAppPlaceholders } from '../../shared/appRecordPlaceholders';
import { builtInAgentApps } from '../../shared/agentAppsBuiltins';
import type { AppJob, AppOutboxEvent, AppWorkspaceState, StoredConnection } from './store';
import { appConnectionNameSource, validAppConnectionName } from '../../shared/appConnectionName';
import { AgentAppsSqliteStateStore } from './sqliteStateStore';
import { phoneFeishuProfile, type PhoneFeishuAccounts, type PhoneFeishuConversation } from './feishuAccounts';
import { appNotification, channelNoticeAction, channelNotification, notificationRecords } from './notifications';
import { getNextRunAt } from '../tasks/schedule';
import { AgentAppLibrary, appDefinitionFingerprint, isBundledAppDefinition } from './library';
import { runChannelApp, type AppChannelHost } from './appChannels';
import type { LogicalChannelDraftInput, LogicalChannelLegacyAccess, LogicalChannelLegacyMessageQuery, LogicalChannelMessage, LogicalChannelMessageStateInput, LogicalChannelReplyInput, LogicalChannelSendInput } from '../../shared/messagingChannels';
import { filterLegacyMessages, legacyMessageId, legacyRecordsForSource, legacySourceId, legacySources, projectLegacyMessage, LEGACY_FEISHU_HISTORY, LEGACY_MAIL_HISTORY } from './legacyChannelRecords';
import { imapMailboxKey } from '../messaging/imapConsumerArbiter';

export type AppActor = { kind: 'agent' | 'human' | 'background'; runId: string; signal?: AbortSignal; jobId?: string; jobRevision?: number; legacyChannelSend?: { draftRevision?: number } };
export type ConnectionSecret = { password: string; smtpPassword?: string };
export interface AppStateStore {
  read(workspaceId: string): AppWorkspaceState;
  transact<T>(workspaceId: string, fn: (draft: AppWorkspaceState) => T): T;
  queryRecords?(workspaceId: string, query: AppQuery): { records: AppRecord[]; total: number };
  updateRecord?(workspaceId: string, appId: string, id: string, update: (record: AppRecord) => void): AppRecord;
  close?(): void;
}
export type AppImportedBatch = { records: AppValues[]; placeholderFields?: Array<AppPlaceholderFields | null> };
export interface AppConnectors {
  feishuBotId?(profile: string): Promise<string>;
  feishuConversationName?(chatId: string, messageId: string, type: 'p2p' | 'group', profile: string): Promise<string | undefined>;
  listFeishuChats(identity: 'bot' | 'user', pageToken: string | undefined, profile: string): Promise<AppFeishuChatPage>;
  feed(url: string, signal?: AbortSignal): Promise<AppValues[] | AppImportedBatch>;
  sync(connection: AppConnection, secret: ConnectionSecret | undefined, cursor: Record<string, string | number>, signal?: AbortSignal, workspaceId?: string): Promise<AppImportedBatch & { cursor: Record<string, string | number> }>;
  send(connection: AppConnection, secret: ConnectionSecret | undefined, values: AppValues, requestId: string, signal?: AbortSignal): Promise<{ messageId: string }>;
  test(connection: AppConnection, secret?: ConnectionSecret, workspaceId?: string, signal?: AbortSignal): Promise<void>;
  closeImap?(): Promise<void>;
}
export interface AgentAppsOptions {
  root: string; workspaces(): string[];
  emit(kind: 'operation', value: AppOperation): void;
  emit(kind: 'changed', value: AppChanged): void;
  deliver(workspaceId: string, event: AppOutboxEvent): Promise<{ messageId?: string; muted?: boolean }>;
  connectors: AppConnectors;
  encrypt(secret: string): string; decrypt(secret: string): string;
  confirmSend(workspaceId: string, app: string, values: AppValues, signal?: AbortSignal): Promise<boolean>;
  authorizeDefinition?(workspaceId: string, action: string, definition: AgentAppDefinition, signal?: AbortSignal): Promise<boolean>;
  resolveManagedImage?(workspaceId: string, source: string): Promise<string>;
  feishuAccounts?: PhoneFeishuAccounts;
  channels?: AppChannelHost;
  claimImapConsumer?(workspaceId: string, mailbox: Extract<AppConnection, { kind: 'imap-smtp' }>): () => void;
  now?(): number;
  storeFactory?(root: string, seed: () => import('../../shared/agentApps').AppInstallation[]): AppStateStore;
}
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new Error(`${name} is required`);
  return value.trim();
}
function valuesOf(value: unknown): AppValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('values must be an object');
  return value as AppValues;
}
function publicConnection(c: StoredConnection): AppConnection {
  const { encryptedSecret: _secret, cursors: _cursors, ...safe } = c; return structuredClone(safe);
}
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex'); }
function isPersistentStoreFailure(error: unknown): boolean {
  const message = appError(error);
  return /App SQLite database (?:schema|version|integrity|workspace identity|revision)/i.test(message);
}
function localZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; }
function reminderWeekdays(value: AppValues[string] | undefined): number[] | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[0-6](,[0-6])*$/.test(value)) throw new Error('weekdays must be comma-separated digits 0–6');
  return [...new Set(value.split(',').map(Number))];
}
function nextCalendarReminder(time: string, weekdays: number[] | undefined, from: Date): number {
  return getNextRunAt(weekdays ? { kind: 'weekly', time, weekdays } : { kind: 'daily', time }, from);
}
const builtinIds = new Set(builtInAgentApps().map(a => a.id));
const externalSend = (command: AppCommand): boolean => command.handler === 'mail.send' || command.handler === 'messages.send' || command.handler === 'channel.run' && ['reply', 'send'].includes(command.id);
const LEGACY_BINDING_REQUIRED = 'This workspace has no access to that Channel source. Use muster.channel catalog and bind to choose a Channel first.';
function legacyRecordSource(state: AppWorkspaceState, appId: string, record: AppRecord): string {
  const accountId = record.origin?.connectionId ?? record.values.accountId;
  return typeof accountId === 'string' && state.connections.some(connection => connection.id === accountId)
    ? legacySourceId(accountId) : appId === 'mail' ? LEGACY_MAIL_HISTORY : LEGACY_FEISHU_HISTORY;
}
/**
 * 已投递 outbox 事件的滚动保留窗口（7 天，参照 evidence 滚动保留先例）：
 * 账本与事务成本不得随运行时长无限增长；未投递（含重试中）事件永不裁剪，
 * notificationId 续读只依赖近期事件——更老的 id 沿用既有「not found」错误路径。
 */
const OUTBOX_DELIVERED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export class AgentAppsService {
  readonly store: AppStateStore;
  private readonly library: AgentAppLibrary;
  private readonly libraryErrors = new Map<string, string>();
  private clock: () => number;
  private sequence = Date.now() * 100;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private activeTick?: Promise<void>;
  private background = new AbortController();
  private runningJobs = new Map<string, Promise<void>>();
  private knownWorkspaces = new Set<string>();
  private readonly backgroundWorkspaceErrors = new Map<string, string>();
  private readonly imapReservations = new Map<string, Map<string, { key: string; release(): void }>>();
  private inFlight = new Map<string, { fingerprint: string; work: Promise<AppCallResult> }>();
  constructor(private readonly options: AgentAppsOptions) {
    this.clock = options.now ?? Date.now;
    const seed = () => builtInAgentApps().map(definition => ({ definition, enabled: true, installedAt: this.clock() }));
    this.store = options.storeFactory ? options.storeFactory(options.root, seed) : new AgentAppsSqliteStateStore(options.root, seed);
    this.library = new AgentAppLibrary(path.join(path.dirname(options.root), 'agent-app-library'), this.clock);
  }
  private scope(workspaceId: string): void {
    if (!this.options.workspaces().includes(workspaceId)) throw new Error('App workspace is unavailable');
  }
  private app(workspaceId: string, appId: string): AgentAppDefinition {
    this.scope(workspaceId);
    const entry = this.store.read(workspaceId).installations.find(a => a.definition.id === appId);
    if (!entry?.enabled) throw new Error('App is not installed or is disabled');
    return entry.definition;
  }
  private guard(workspaceId: string, appId: string, actor: AppActor): void {
    this.app(workspaceId, appId); actor.signal?.throwIfAborted();
    if (actor.jobId) {
      const job = this.store.read(workspaceId).jobs.find(j => j.id === actor.jobId);
      if (!job?.enabled || job.revision !== actor.jobRevision) throw new Error('Background job was changed or cancelled');
    }
  }
  private changed(workspaceId: string, appId?: string): void {
    const event = { workspaceId, appId, revision: this.store.read(workspaceId).revision };
    queueMicrotask(() => { try { this.options.emit('changed', event); } catch (error) { console.warn('[agentApps] UI subscriber failed', appError(error)); } });
  }
  private operation(workspaceId: string, operation: AppOperation): void {
    this.store.transact(workspaceId, state => {
      state.operations = [...state.operations.filter(x => x.operationId !== operation.operationId), operation].slice(-120);
    });
    const copy = structuredClone(operation);
    queueMicrotask(() => { try { this.options.emit('operation', copy); } catch (error) { console.warn('[agentApps] operation subscriber failed', appError(error)); } });
  }
  snapshot(workspaceId: string): AppSnapshot {
    this.scope(workspaceId); const state = this.store.read(workspaceId);
    return structuredClone({ workspaceId, apps: state.installations.filter(item => !isLegacyChannelApp(item.definition.id)), operations: state.operations, connections: state.connections.map(publicConnection), errors: [...state.jobs.filter(j => j.lastError).map(j => j.lastError!).slice(-10), ...(this.libraryErrors.has(workspaceId) ? [this.libraryErrors.get(workspaceId)!] : [])] });
  }
  describeApp(workspaceId: string, appId: string) {
    this.scope(workspaceId);
    const installed = this.store.read(workspaceId).installations.find(item => item.definition.id === appId);
    if (!installed) throw new Error('Unknown app');
    return structuredClone(installed);
  }
  async queryChannel(workspaceId: string, query: AppQuery, signal?: AbortSignal): Promise<AppCallResult> {
    this.app(workspaceId, CHANNEL_APP_ID);
    const command = query.viewId === 'bindings' ? 'catalog' : query.id ? 'get' : query.channelId ? 'list' : typeof query.search === 'string' && query.search.trim() ? 'search' : 'channels';
    return runChannelApp(this.options, workspaceId, command, { ...query.channelQuery, ...(query.search !== undefined ? { search: query.search } : {}), ...(query.limit !== undefined ? { limit: query.limit } : {}), channelId: query.channelId, messageId: query.id }, undefined, { kind: 'human', runId: '', signal });
  }
  listLegacyChannelSources(workspaceId: string) {
    this.scope(workspaceId);
    return legacySources(this.store.read(workspaceId));
  }
  private legacyChannel(workspaceId: string, sourceId: string, capability: 'read' | 'send', strict = true) {
    this.scope(workspaceId);
    const state = this.store.read(workspaceId);
    const source = legacySources(state).find(item => item.id === sourceId);
    const records = legacyRecordsForSource(state, sourceId);
    const grants = records.connection?.grants[records.appId] ?? [];
    if (!source || (capability === 'send' ? !source.canSend : records.connection && !grants.includes(`${records.appId}.read`))) {
      if (strict) throw new Error('Channel source permission denied or unavailable');
      return { ...records, records: [] };
    }
    return records;
  }
  private async legacyCommandAccess(workspaceId: string, app: AgentAppDefinition, command: AppCommand,
    params: Record<string, unknown>, actor: AppActor): Promise<LogicalChannelLegacyAccess[] | undefined> {
    if (actor.kind !== 'agent' || !isLegacyChannelApp(app.id) || !this.options.channels) return;
    const candidates = await this.options.channels.legacyAccess(workspaceId, actor.signal);
    this.guard(workspaceId, app.id, actor);
    const state = this.store.read(workspaceId), send = externalSend(command);
    const history = app.id === 'mail' ? LEGACY_MAIL_HISTORY : LEGACY_FEISHU_HISTORY;
    const allowed = candidates.filter(source => {
      if (source.originalSourceId === history) return !send;
      const connection = state.connections.find(item => legacySourceId(item.id) === source.originalSourceId);
      return !!connection?.grants[app.id]?.includes(`${app.id}.${send ? 'send' : 'read'}` as AppPermission) &&
        (!send || source.permission === 'reply');
    });
    const requireSource = (sourceId: string) => {
      if (!allowed.some(source => source.originalSourceId === sourceId)) throw new Error(LEGACY_BINDING_REQUIRED);
    };
    if (!allowed.length) throw new Error(LEGACY_BINDING_REQUIRED);
    if (typeof params.id === 'string') {
      const record = (state.records[app.id] ?? []).find(item => item.id === params.id);
      if (!record) throw new Error('Record not found');
      requireSource(legacyRecordSource(state, app.id, record));
    }
    if (typeof params.accountId === 'string') requireSource(legacySourceId(params.accountId));
    const target = (params.values as AppValues | undefined)?.accountId;
    if (typeof target === 'string') requireSource(legacySourceId(target));
    if (command.handler === 'records.create' && typeof target !== 'string') requireSource(history);
    return allowed;
  }
  listLegacyChannelMessages(workspaceId: string, channelId: string, sourceId: string, query: LogicalChannelLegacyMessageQuery): LogicalChannelMessage[] {
    const { appId, records } = this.legacyChannel(workspaceId, sourceId, 'read', false);
    return filterLegacyMessages(records.map(record => projectLegacyMessage(channelId, sourceId, appId, record)), query);
  }
  getLegacyChannelMessage(workspaceId: string, channelId: string, sourceId: string, messageId: string): (LogicalChannelMessage & { legacyOwnerMuted?: boolean }) | undefined {
    const { appId, records, connection } = this.legacyChannel(workspaceId, sourceId, 'read', false);
    const record = records.find(item => legacyMessageId(appId, item.id) === messageId);
    return record && { ...projectLegacyMessage(channelId, sourceId, appId, record), legacyOwnerMuted: connection?.notify === 'mute',
      notificationOwner: connection?.enabled === true &&
      this.store.read(workspaceId).installations.some(item => item.definition.id === appId && item.enabled) };
  }
  setLegacyChannelMessageState(input: LogicalChannelMessageStateInput & { sourceId: string }): LogicalChannelMessage {
    const { workspaceId, channelId, sourceId, messageId, read, processed } = input;
    const { appId, records } = this.legacyChannel(workspaceId, sourceId, 'read');
    const original = records.find(item => legacyMessageId(appId, item.id) === messageId);
    if (!original) throw new Error('Message not found');
    const patch = (record: AppRecord) => {
      if (read !== undefined) record.values.read = read;
      if (processed !== undefined) record.values.processed = processed;
      record.revision++;
      record.updatedAt = this.clock();
    };
    const record = this.store.updateRecord?.(workspaceId, appId, original.id, patch) ?? this.store.transact(workspaceId, state => { const value = this.record(state, appId, original.id); patch(value); return value; });
    this.changed(workspaceId, appId);
    return projectLegacyMessage(channelId, sourceId, appId, record);
  }
  async sendLegacyChannelMessage(input: LogicalChannelSendInput | (LogicalChannelReplyInput & { sourceId: string }), signal?: AbortSignal): Promise<LogicalChannelMessage> {
    const { workspaceId, channelId, sourceId, requestId } = input;
    const { appId, connection, records } = this.legacyChannel(workspaceId, sourceId, 'send');
    if (!connection) throw new Error('Choose an enabled Channel source');
    const key = `channel-${fingerprint([sourceId, requestId])}`;
    const reply = 'messageId' in input;
    const values: AppValues = { body: input.text };
    const params: Record<string, unknown> = { accountId: connection.id, values };
    let draftRevision: number | undefined;
    if (reply) {
      this.legacyChannel(workspaceId, sourceId, 'read');
      const original = records.find(record => legacyMessageId(appId, record.id) === input.messageId);
      if (!original?.origin?.messageId || original.origin.connectionId !== connection.id || (appId === 'mail' ? original.values.folder !== 'inbox' : original.values.mine === true)) throw new Error('Reply requires a received message from this source');
      values.replyTo = original.origin.messageId;
      if (appId === 'mail') { values.to = original.values.from; values.subject = `Re: ${original.values.subject ?? ''}`; }
    } else if (appId === 'mail') {
      if (input.draftId) {
        const draft = records.find(record => legacyMessageId(appId, record.id) === input.draftId);
        if (!draft) throw new Error('Draft belongs to another source or is unavailable');
        params.id = draft.id;
        draftRevision = draft.revision;
        if (input.text.trim() !== String(draft.values.body ?? '').trim() || input.recipient !== draft.values.to || (input.subject ?? '') !== (draft.values.subject ?? '')) throw new Error('Save the current draft before sending');
      } else { values.to = required(input.recipient, 'recipient'); values.subject = input.subject ?? ''; }
    } else if (input.recipient !== undefined || input.subject !== undefined || input.draftId !== undefined) throw new Error('This source sends to its saved conversation');
    const result = await this.execute(workspaceId, { appId, commandId: 'send', params, requestId: key }, { kind: 'human', runId: key, signal, legacyChannelSend: { draftRevision } });
    if (!result.record) throw new Error('Earlier send record is unavailable');
    return projectLegacyMessage(channelId, sourceId, appId, result.record);
  }
  saveLegacyChannelDraft(input: LogicalChannelDraftInput, signal?: AbortSignal): LogicalChannelMessage {
    const { workspaceId, channelId, sourceId, draftId } = input;
    signal?.throwIfAborted();
    const destination = this.legacyChannel(workspaceId, sourceId, 'read');
    if (destination.appId !== 'mail') throw new Error('Only existing mailbox sources support drafts');
    const app = this.store.read(workspaceId).installations.find(item => item.definition.id === 'mail')!.definition;
    const collection = app.collections[0];
    const original = draftId ? destination.records.find(record => legacyMessageId('mail', record.id) === draftId) : undefined;
    if (draftId && (!original || original.values.folder !== 'drafts' || original.values.status !== 'draft')) throw new Error('Draft belongs to another source or is unavailable');
    const values = validateRecordValues(collection, { to: input.recipient, subject: input.subject, body: input.text, ...(destination.connection ? { accountId: destination.connection.id } : {}) }, true);
    const record = this.store.transact(workspaceId, state => {
      if (original) this.revision(this.record(state, 'mail', original.id), input.expectedRevision);
      return this.put(state, 'mail', collection.id, { ...values, folder: 'drafts', status: 'draft' }, original?.id);
    });
    this.changed(workspaceId, 'mail');
    return projectLegacyMessage(channelId, sourceId, 'mail', record);
  }
  query(workspaceId: string, query: AppQuery, legacyAccess?: LogicalChannelLegacyAccess[]): AppCallResult {
    const app = this.app(workspaceId, required(query.appId, 'appId'));
    const collection = query.collection ?? app.collections[0]?.id;
    if (!app.collections.some(c => c.id === collection)) throw new Error('Unknown collection');
    const state = this.store.read(workspaceId);
    const notification = query.notificationId ? state.outbox.find(e => e.id === query.notificationId && e.appId === app.id) : undefined;
    if (query.notificationId && !notification) throw new Error('Notification not found in this app/workspace');
    if (!notification && !legacyAccess && this.store.queryRecords) {
      const result = this.store.queryRecords(workspaceId, query.id ? { appId: app.id, collection, id: query.id } : { ...query, appId: app.id, collection });
      if (query.id) { if (!result.records[0]) throw new Error('Record not found'); return { record: result.records[0] }; }
      return result;
    }
    const allowed = legacyAccess && new Set(legacyAccess.map(source => source.originalSourceId));
    const rows = (notification ? notificationRecords(state, notification, false) : state.records[app.id] ?? []).filter(r =>
      r.collection === collection && (!allowed || allowed.has(legacyRecordSource(state, app.id, r))));
    if (query.id) {
      const record = rows.find(r => r.id === query.id); if (!record) throw new Error('Record not found');
      return { record: structuredClone(record) };
    }
    const term = query.search?.toLocaleLowerCase().slice(0, 200);
    const filtered = rows.filter(r => (!term || Object.values(r.values).some(v => String(v ?? '').toLocaleLowerCase().includes(term))) &&
      (!query.filter || Object.entries(query.filter).every(([key, value]) => r.values[key] === value)));
    if (!notification) filtered.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const { offset, limit } = normalizeAppQueryWindow(query.offset, query.limit);
    if (notification) {
      // Page fixed event membership, not a changing filtered array. Deletes cannot shift later pages.
      const byId = new Map(filtered.map(r => [r.id, r]));
      const records: AppRecord[] = [], truncated: Record<string, string[]> = {};
      let next = offset;
      for (; next < Math.min(notification.recordIds.length, offset + limit); next++) {
        const original = byId.get(notification.recordIds[next]); if (!original) continue;
        const record = structuredClone(original), fields: string[] = [];
        for (const [key, value] of Object.entries(record.values)) if (typeof value === 'string' && value.length > 1800) {
          record.values[key] = value.slice(0, 1800); fields.push(key);
        }
        // Custom apps may have many long fields. Still guarantee one bounded first record.
        if (!records.length && JSON.stringify(record).length > 12000) for (const [key, value] of Object.entries(record.values)) {
          if (typeof value === 'string' && value.length > 100) { record.values[key] = value.slice(0, 100); if (!fields.includes(key)) fields.push(key); }
        }
        const nextTruncated = fields.length ? { ...truncated, [record.id]: fields } : truncated;
        if (records.length && JSON.stringify({ records: [...records, record], truncated: nextTruncated }).length > 13500) break;
        records.push(record); if (fields.length) truncated[record.id] = fields;
      }
      return { records, total: notification.recordIds.length, nextOffset: next < notification.recordIds.length ? next : null,
        ...(Object.keys(truncated).length ? { truncated } : {}) };
    }
    return { records: structuredClone(filtered.slice(offset, offset + limit)), total: filtered.length };
  }
  notification(workspaceId: string, eventId: string, budget?: number) {
    this.scope(workspaceId);
    const state = this.store.read(workspaceId), event = state.outbox.find(e => e.id === eventId);
    return event ? appNotification(state, event, budget) : null;
  }
  notifications(workspaceId: string, eventIds: string[], budget?: number) {
    this.scope(workspaceId);
    if (!Array.isArray(eventIds) || eventIds.length > 128 || eventIds.some(id => typeof id !== 'string')) throw new Error('Invalid app notification batch');
    const state = this.store.read(workspaceId), byId = new Map(state.outbox.map(event => [event.id, event]));
    return eventIds.map(id => { const event = byId.get(id); return event ? appNotification(state, event, budget) : null; });
  }
  async resolveNotifications(workspaceId: string, eventIds: string[], budget?: number, signal?: AbortSignal) {
    const existing = this.notifications(workspaceId, eventIds, budget);
    const state = this.store.read(workspaceId);
    if (!this.options.channels) return existing;
    const enabled = state.installations.some(app => app.definition.id === CHANNEL_APP_ID && app.enabled);
    const events = new Map(state.outbox.filter(event => event.channelMessage || isLegacyChannelApp(event.appId)).map(event => [event.id, event]));
    if (!eventIds.some(id => events.has(id))) return existing;
    const host = this.options.channels;
    const requested = eventIds.map(id => events.get(id));
    const [currentChannels, legacy] = await Promise.all([
      enabled && requested.some(event => event?.channelMessage) ? host.listChannels(workspaceId, signal) : [],
      enabled && requested.some(event => event && isLegacyChannelApp(event.appId)) ? host.legacyAccess(workspaceId, signal) : []
    ]);
    const channels = new Map(currentChannels.map(channel => [channel.id, channel]));
    if (!this.options.workspaces().includes(workspaceId)) return eventIds.map(() => null);
    const live = this.store.read(workspaceId);
    const enabledNow = live.installations.some(app => app.definition.id === CHANNEL_APP_ID && app.enabled);
    return Promise.all(eventIds.map(async (id, index) => {
      const event = events.get(id);
      if (!event) return existing[index];
      if (!enabledNow) return null;
      const ref = event.channelMessage;
      if (!ref) {
        const active = legacy.filter(source => source.notify !== 'mute');
        const records = notificationRecords(live, event).filter(record => active.some(source =>
          source.originalSourceId === legacyRecordSource(live, event.appId, record)));
        const action = active.some(source => source.notify === 'wake' && records.some(record =>
          source.originalSourceId === legacyRecordSource(live, event.appId, record))) ? 'wake' : 'digest';
        const notification = appNotification(live, { ...event, recordIds: records.map(record => record.id) }, budget);
        return notification && { ...notification, action };
      }
      const channel = channels.get(ref.channelId);
      if (!channel) return null;
      let message: LogicalChannelMessage | undefined;
      try { message = await host.getMessage(workspaceId, channel.id, ref.messageId, signal); }
      catch (error) { if (!(error instanceof Error) || !['channel-not-found', 'channel-not-bound'].includes(error.message)) throw error; }
      const scopes = this.options.workspaces();
      if (!scopes.includes(workspaceId) || !this.store.read(workspaceId).installations.some(app => app.definition.id === CHANNEL_APP_ID && app.enabled)) return null;
      return message ? channelNotification(channel, message, budget) : null;
    }));
  }
  async install(workspaceId: string, input: unknown, installOptions: { private?: boolean; library?: { catalogId: string; baseFingerprint: string; private: boolean } } = {}, initiatedBy: 'human' | 'agent' = 'agent'): Promise<AgentAppDefinition> {
    this.scope(workspaceId); const definition = validateAppDefinition(input);
    if (installOptions.private !== undefined && typeof installOptions.private !== 'boolean') throw new Error('private must be boolean');
    if (builtinIds.has(definition.id)) throw new Error('Built-in app definitions are maintained by the host');
    const retained = this.store.read(workspaceId).uninstalledApps?.[definition.id];
    if (retained && retained.definitionFingerprint !== fingerprint(definition) && (!retained.catalogId || retained.catalogId !== installOptions.library?.catalogId)) throw new Error('Retained data belongs to a different app identity');
    const previous = this.store.read(workspaceId).installations.find(x => x.definition.id === definition.id);
    if (previous && installOptions.library && previous.library?.catalogId !== installOptions.library.catalogId) throw new Error('App id conflict with an already installed app');
    const before = fingerprint(previous);
    if (previous && definition.version <= previous.definition.version) throw new Error('An update needs a higher version');
    const behavior = (app: AgentAppDefinition) => { const { version: _version, name: _name, ...definition } = app; return fingerprint(definition); };
    const needsApproval = !previous || behavior(previous.definition) !== behavior(definition);
    if (needsApproval && initiatedBy !== 'human' && !isBundledAppDefinition(definition) && (!this.options.authorizeDefinition || !await this.options.authorizeDefinition(workspaceId, previous ? 'apps.update' : 'apps.install', structuredClone(definition)))) throw new Error('App definition approval denied or unavailable');
    this.scope(workspaceId);
    if (fingerprint(this.store.read(workspaceId).installations.find(x => x.definition.id === definition.id)) !== before) throw new Error('App changed during approval');
    this.store.transact(workspaceId, state => {
      const old = state.installations.find(x => x.definition.id === definition.id);
      if (old) {
        if (definition.version <= old.definition.version) throw new Error('An update needs a higher version');
        if (state.operations.some(op => op.appId === definition.id && op.phase === 'running')) throw new Error('App has operations in progress; retry the update after they finish');
        // Existing data must remain valid; destructive migrations require an explicit future migration contract.
        for (const record of state.records[definition.id] ?? []) {
          const collection = definition.collections.find(c => c.id === record.collection);
          if (!collection) throw new Error('Update would orphan existing records');
          validateRecordValues(collection, record.values, false, true);
        }
        for (const job of state.jobs.filter(j => j.appId === definition.id && j.enabled && j.kind === 'sync')) {
          const before = old.definition.commands.find(c => c.id === job.commandId);
          const after = definition.commands.find(c => c.id === job.commandId);
          if (!after || after.handler !== before?.handler || after.collection !== before.collection) throw new Error('Update would orphan an active background job');
        }
        old.definition = definition;
        old.approvedDefinition = fingerprint(definition);
        if (installOptions.library) old.library = installOptions.library;
      } else state.installations.push({ definition, enabled: true, installedAt: this.clock(), approvedDefinition: fingerprint(definition), libraryPrivate: installOptions.private ?? installOptions.library?.private ?? false, ...(installOptions.library ? { library: installOptions.library } : {}) });
      if (state.uninstalledApps) delete state.uninstalledApps[definition.id];
    });
    if (!previous && !installOptions.library) {
      try { this.registerLocalApp(workspaceId, definition.id); }
      catch (error) { this.changed(workspaceId, definition.id); throw new Error(`App installed but library registration failed: ${appError(error)}`); }
    }
    this.changed(workspaceId, definition.id); return definition;
  }
  private registerLocalApp(workspaceId: string, appId: string): void {
    const installation = this.store.read(workspaceId).installations.find(item => item.definition.id === appId);
    if (!installation || builtinIds.has(appId) || installation.library) return;
    const before = fingerprint(installation), privateApp = installation.libraryPrivate === true;
    const entry = this.library.register(workspaceId, installation.definition, privateApp);
    this.store.transact(workspaceId, state => {
      const current = state.installations.find(item => item.definition.id === appId);
      if (!current || fingerprint(current) !== before) throw new Error('App changed during library registration');
      current.library = { catalogId: entry.catalogId, baseFingerprint: entry.fingerprint, private: privateApp };
    });
  }
  private registerLocalApps(): void {
    for (const workspaceId of this.options.workspaces()) {
      try {
        const apps = this.store.read(workspaceId).installations.filter(item => !builtinIds.has(item.definition.id) && !item.library).map(item => item.definition.id);
        for (const appId of apps) this.registerLocalApp(workspaceId, appId);
        this.libraryErrors.delete(workspaceId);
      } catch (error) {
        const message = `App library registration failed: ${appError(error)}`;
        this.libraryErrors.set(workspaceId, message); console.error('[agentApps]', workspaceId, message);
      }
    }
  }
  listLibrary(workspaceId: string): AppLibraryItem[] {
    this.scope(workspaceId); this.registerLocalApps();
    const entries = this.library.list(workspaceId), installations = this.store.read(workspaceId).installations;
    return entries.map(entry => {
      const latest = entry.versions.at(-1)!, installed = installations.find(item => item.library?.catalogId === entry.catalogId);
      return { catalogId: entry.catalogId, appId: entry.appId, name: latest.definition.name, description: latest.definition.description, version: latest.definition.version, private: entry.private, canManageVisibility: entry.ownerWorkspaceId === workspaceId, canPublish: !!entry.ownerWorkspaceId,
        conflict: entries.some(other => other.catalogId !== entry.catalogId && other.appId === entry.appId),
        ...(installed ? { installedVersion: installed.definition.version } : {}), updateAvailable: !!installed && latest.definition.version > installed.definition.version };
    });
  }
  async installFromLibrary(workspaceId: string, catalogId: string, version?: number, initiatedBy: 'human' | 'agent' = 'agent'): Promise<AgentAppDefinition> {
    this.scope(workspaceId); this.registerLocalApps();
    const entry = this.library.get(workspaceId, required(catalogId, 'catalogId'), version);
    const existing = this.store.read(workspaceId).installations.find(item => item.definition.id === entry.definition.id);
    if (existing && existing.library?.catalogId !== catalogId) throw new Error('App id conflict with an already installed app');
    if (existing?.library && appDefinitionFingerprint(existing.definition) !== existing.library.baseFingerprint) throw new Error('Local app has unpublished changes; resolve the conflict before updating');
    return this.install(workspaceId, entry.definition, { library: { catalogId, baseFingerprint: entry.fingerprint, private: entry.private } }, initiatedBy);
  }
  publishToLibrary(workspaceId: string, appId: string): { catalogId: string; version: number } {
    this.scope(workspaceId); this.registerLocalApp(workspaceId, appId);
    const installation = this.store.read(workspaceId).installations.find(item => item.definition.id === appId);
    if (!installation?.library) throw new Error('Custom app is not installed');
    const before = fingerprint(installation), library = installation.library;
    const published = this.library.publish(workspaceId, library.catalogId, installation.definition, library.baseFingerprint);
    try {
      this.store.transact(workspaceId, state => {
        const current = state.installations.find(item => item.definition.id === appId);
        if (!current || fingerprint(current) !== before) throw new Error('App changed while publishing');
        current.library!.baseFingerprint = published;
      });
    } catch (error) { throw new Error(`Library version was published, but the workspace marker failed: ${appError(error)}`); }
    this.changed(workspaceId, appId); return { catalogId: library.catalogId, version: installation.definition.version };
  }
  setLibraryPrivate(workspaceId: string, appId: string, privateApp: boolean): void {
    this.scope(workspaceId); this.registerLocalApp(workspaceId, appId);
    const installation = this.store.read(workspaceId).installations.find(item => item.definition.id === appId);
    if (!installation?.library) throw new Error('Custom app is not installed');
    this.library.setPrivate(workspaceId, installation.library.catalogId, privateApp);
    this.store.transact(workspaceId, state => {
      const current = state.installations.find(item => item.definition.id === appId);
      if (!current?.library || current.library.catalogId !== installation.library!.catalogId) throw new Error('App changed while updating visibility');
      current.library.private = privateApp; current.libraryPrivate = privateApp;
    });
    this.changed(workspaceId, appId);
  }
  uninstall(workspaceId: string, appId: string, deleteData = false): { appId: string; dataDeleted: boolean; linkedRemindersStopped: number } {
    this.scope(workspaceId); required(appId, 'appId');
    if (typeof deleteData !== 'boolean') throw new Error('deleteData must be boolean');
    if (builtinIds.has(appId)) throw new Error('Built-in apps cannot be uninstalled; disable them instead');
    const result = this.store.transact(workspaceId, state => {
      const installation = state.installations.find(item => item.definition.id === appId);
      if (!installation) throw new Error('App not installed');
      if (state.operations.some(op => op.appId === appId && op.phase === 'running')) throw new Error('App has operations in progress; retry uninstall after they finish');
      const linked = new Set<string>();
      for (const job of state.jobs) if (job.appId === appId || job.kind === 'reminder' && job.params.targetApp === appId) {
        if (job.kind === 'reminder' && job.appId !== appId && job.enabled) {
          const id = String(job.params.id); linked.add(id);
          const record = (state.records[job.appId] ?? []).find(item => item.id === id);
          if (record) { record.values.enabled = false; record.revision++; record.updatedAt = this.clock(); }
        }
        job.enabled = false; job.revision++;
      }
      // A delivery may already be awaiting an acknowledgement. Keep its ledger
      // entry until normal pruning, but revoke its payload and future delivery.
      for (const event of state.outbox) if (event.appId === appId) {
        event.action = 'mute'; event.recordIds = [];
        if (deleteData) event.title = '';
      }
      for (const event of state.outbox) if (event.kind === 'reminder.due') {
        event.recordIds = event.recordIds.filter(id => !linked.has(id));
        if (!event.recordIds.length) event.action = 'mute';
      }
      for (const connection of state.connections) if (Object.prototype.hasOwnProperty.call(connection.grants, appId)) {
        delete connection.grants[appId]; connection.revision++;
        if (deleteData && connection.cursors) delete connection.cursors[appId];
      }
      state.installations = state.installations.filter(item => item.definition.id !== appId);
      if (deleteData) {
        delete state.records[appId];
        state.jobs = state.jobs.filter(job => job.appId !== appId);
        state.operations = state.operations.filter(op => op.appId !== appId);
        state.receipts = state.receipts.filter(receipt => !receipt.key.startsWith(`${appId}:`) || receipt.external);
        for (const receipt of state.receipts) if (receipt.key.startsWith(`${appId}:`)) delete receipt.result;
        if (state.uninstalledApps) delete state.uninstalledApps[appId];
      } else {
        (state.uninstalledApps ??= {})[appId] = { definitionFingerprint: fingerprint(installation.definition), ...(installation.library ? { catalogId: installation.library.catalogId } : {}) };
      }
      return { appId, dataDeleted: deleteData, linkedRemindersStopped: linked.size };
    });
    this.changed(workspaceId, appId); return result;
  }
  async setEnabled(workspaceId: string, appId: string, enabled: boolean, initiatedBy: 'human' | 'agent' = 'agent'): Promise<void> {
    this.scope(workspaceId);
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    const previous = this.store.read(workspaceId).installations.find(a => a.definition.id === appId);
    if (!previous) throw new Error('App not installed');
    if (previous.enabled === enabled) return;
    const before = fingerprint(previous);
    const trusted = !previous.approvedDefinition || previous.approvedDefinition === fingerprint(previous.definition) || isBundledAppDefinition(previous.definition);
    if (enabled && !trusted && initiatedBy !== 'human' && (!this.options.authorizeDefinition || !await this.options.authorizeDefinition(workspaceId, 'apps.enable', structuredClone(previous.definition)))) throw new Error('App enable approval denied or unavailable');
    this.scope(workspaceId);
    if (fingerprint(this.store.read(workspaceId).installations.find(a => a.definition.id === appId)) !== before) throw new Error('App changed during approval');

    this.store.transact(workspaceId, state => {
      const app = state.installations.find(a => a.definition.id === appId); if (!app) throw new Error('App not installed');
      app.enabled = enabled;
      if (enabled) app.approvedDefinition = fingerprint(app.definition);
    });
    this.changed(workspaceId, appId);
  }
  execute(workspaceId: string, call: AppCall, actor: AppActor): Promise<AppCallResult> {
    if (call.requestId !== undefined && (typeof call.requestId !== 'string' || !call.requestId.trim() || call.requestId.length > 128)) return Promise.reject(new Error('Invalid requestId'));
    const key = `${workspaceId}:${call.appId}:${isLegacyChannelApp(call.appId) ? `${actor.kind}:` : ''}${call.requestId ?? randomUUID()}`;
    const hash = fingerprint({ commandId: call.commandId, params: call.params ?? {} });
    const active = this.inFlight.get(key);
    if (active) return active.fingerprint === hash ? active.work : Promise.reject(new Error('requestId was used with different arguments'));
    const work = this.executeOnce(workspaceId, call, actor).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, { fingerprint: hash, work }); return work;
  }
  private async executeOnce(workspaceId: string, call: AppCall, actor: AppActor): Promise<AppCallResult> {
    const app = this.app(workspaceId, call.appId), command = app.commands.find(c => c.id === call.commandId);
    if (!command) throw new Error('Unknown app command');
    this.guard(workspaceId, app.id, actor);
    const params = call.params ?? {};
    if (!params || typeof params !== 'object' || Array.isArray(params) || JSON.stringify(params).length > 300_000) throw new Error('Invalid command parameters');
    if (externalSend(command) && (!call.requestId || call.requestId.length > 128)) throw new Error('Sending requires a stable requestId; reuse it to inspect the same attempt');
    const legacy = isLegacyChannelApp(app.id) && actor.kind === 'agent'
      ? await this.legacyCommandAccess(workspaceId, app, command, params, actor) : undefined;
    // Channel sends have their own durable receipts in the owning transport. Recheck its
    // current grant on replay and avoid two ledgers deciding the same external outcome.
    const receiptKey = call.requestId && command.handler !== 'channel.run' ? `${app.id}:${call.requestId}` : undefined;
    const hash = fingerprint({ commandId: call.commandId, params });
    const existing = receiptKey && this.store.read(workspaceId).receipts.find(r => r.key === receiptKey);
    if (existing) {
      if (existing.fingerprint !== hash) throw new Error('requestId was used with different arguments');
      if (existing.state === 'done') {
        const result = structuredClone(existing.result ?? {});
        if (legacy) {
          const state = this.store.read(workspaceId);
          const allowed = (record: AppRecord) => legacy.some(source => source.originalSourceId === legacyRecordSource(state, app.id, record));
          if (result.record && !allowed(result.record)) throw new Error(LEGACY_BINDING_REQUIRED);
          if (result.records) result.records = result.records.filter(allowed);
        }
        return result;
      }
      throw new Error('Earlier attempt has an uncertain outcome; inspect the saved record before a new send');
    }
    const op: AppOperation = { workspaceId, agentId: `orchestrator:${workspaceId}`, runId: actor.runId, operationId: randomUUID(), sequence: ++this.sequence,
      appId: app.id, commandId: command.id, title: command.title, actor: actor.kind, phase: 'running', at: this.clock(), viewId: command.presentation!.viewId,
      ...(command.presentation?.entity === 'input.id' && typeof params.id === 'string' ? { entityId: params.id } : {}) };
    this.operation(workspaceId, op);
    try {
      if (receiptKey) this.store.transact(workspaceId, s => { s.receipts.push({ key: receiptKey, fingerprint: hash, state: 'running', external: externalSend(command), at: this.clock() }); });
      const result = await this.dispatch(workspaceId, app, command, params, call.requestId, actor, legacy);
      this.store.transact(workspaceId, s => {
        if (receiptKey) {
          const r = s.receipts.find(x => x.key === receiptKey)!; r.state = 'done';
          // A concurrent deletion may finish after dispatch read a body but before its receipt commit.
          const saved = structuredClone(result);
          if (saved.record && !(s.records[app.id] ?? []).some(record => record.id === saved.record!.id)) { delete saved.record; saved.removed = true; }
          if (saved.records) saved.records = saved.records.filter(record => (s.records[app.id] ?? []).some(current => current.id === record.id));
          r.result = saved;
        }
        // Retain send receipts; old read/CRUD receipts are bounded by the private app ledger.
        const recent = new Set(s.receipts.filter(r => !r.external).slice(-1000));
        s.receipts = s.receipts.filter(r => r.external || recent.has(r));
      });
      this.operation(workspaceId, { ...op, phase: 'succeeded', sequence: ++this.sequence, at: this.clock(), entityId: result.removed ? undefined : command.presentation?.entity === 'result.id' ? result.record?.id : op.entityId, revision: result.record?.revision });
      this.changed(workspaceId, app.id); return result;
    } catch (error) {
      if (receiptKey) this.store.transact(workspaceId, s => {
        const r = s.receipts.find(x => x.key === receiptKey);
        if (r) { if (r.submitted) r.state = 'uncertain'; else s.receipts = s.receipts.filter(x => x !== r); }
      });
      this.operation(workspaceId, { ...op, phase: actor.signal?.aborted ? 'cancelled' : 'failed', sequence: ++this.sequence, at: this.clock(), error: appError(error) });
      this.changed(workspaceId, app.id); throw error;
    }
  }
  private collection(app: AgentAppDefinition, command: AppCommand) {
    const collection = app.collections.find(c => c.id === command.collection); if (!collection) throw new Error('Command collection is missing'); return collection;
  }
  private record(state: AppWorkspaceState, appId: string, id: unknown): AppRecord {
    const record = (state.records[appId] ?? []).find(r => r.id === required(id, 'id')); if (!record) throw new Error('Record not found'); return record;
  }
  private revision(record: AppRecord, value: unknown): void {
    if (value !== record.revision) throw new Error('Record changed or expectedRevision missing; read the latest record and retry');
  }
  private updateValues(record: AppRecord, collection: ReturnType<AgentAppsService['collection']>, command: AppCommand, params: Record<string, unknown>): void {
    if (record.collection !== collection.id) throw new Error('Record belongs to another collection');
    this.revision(record, params.expectedRevision);
    if (collection.purpose === 'mail' && !command.patch && (record.values.folder !== 'drafts' || record.values.status !== 'draft')) throw new Error('Only unsent drafts can be edited');
    const values = validateRecordValues(collection, command.patch ?? params.values, true);
    clearChangedAppPlaceholders(record, values);
    record.values = { ...record.values, ...values };
    record.revision++; record.updatedAt = this.clock();
  }
  private put(state: AppWorkspaceState, appId: string, collection: string, values: AppValues, id: string = randomUUID(), fields?: AppPlaceholderFields | null): AppRecord {
    const rows = state.records[appId] ??= [], old = rows.find(r => r.id === id);
    const valid = validAppPlaceholders(values, fields ?? undefined);
    if (old) { clearChangedAppPlaceholders(old, values); old.values = { ...old.values, ...values }; if (valid) old.placeholderFields = { ...old.placeholderFields, ...valid }; old.updatedAt = this.clock(); old.revision++; return old; }
    const record: AppRecord = { id, collection, values, revision: 1, createdAt: this.clock(), updatedAt: this.clock(), ...(valid ? { placeholderFields: valid } : {}) }; rows.push(record); return record;
  }
  private enqueue(state: AppWorkspaceState, appId: string, kind: string, recordIds: string[], title: string, action: AppOutboxEvent['action'], key: string = randomUUID(), occurrenceAt?: number): void {
    if (state.outbox.some(e => e.id === key)) return;
    state.outbox.push({ id: key, appId, kind, recordIds, title, action, createdAt: this.clock(), attempts: 0, nextAttemptAt: this.clock(),
      ...(isLegacyChannelApp(appId) && { legacyCommittedAt: performance.timeOrigin + performance.now() }),
      ...(occurrenceAt === undefined ? {} : { occurrenceAt }) });
  }

  private async handOffLegacyNotice(workspaceId: string, event: AppOutboxEvent, signal: AbortSignal): Promise<void> {
    const appId = event.appId === 'mail' ? 'mail' : 'messages';
    const state = this.store.read(workspaceId);
    const found = new Map((state.records[appId] ?? []).map(record => [record.id, record]));
    const messages = event.recordIds.flatMap(recordId => {
      const record = found.get(recordId);
      if (!record?.origin || record.values.mine === true || appId === 'mail' && record.values.folder !== 'inbox') return [];
      const connection = state.connections.find(item => item.id === record.origin!.connectionId);
      if (!connection?.enabled || !connection.grants[appId]?.includes(`${appId}.read`)) return [];
      return [{ sourceId: legacySourceId(connection.id), messageId: legacyMessageId(appId, recordId),
        ownerMuted: event.action === 'mute' || connection.notify === 'mute' }];
    });
    if (messages.length) await this.options.channels!.captureLegacyNotices(workspaceId, { eventId: event.id,
      committedAt: event.legacyCommittedAt ?? event.createdAt, messages }, signal);
  }
  private async collectChannelNotices(workspaceId: string, signal: AbortSignal): Promise<void> {
    const host = this.options.channels;
    if (!host || signal.aborted || !this.store.read(workspaceId).installations.some(item => item.definition.id === CHANNEL_APP_ID && item.enabled)) return;
    const channels = await host.listChannels(workspaceId, signal);
    for (const channel of channels) for (const lane of [true, 'legacy'] as const) {
      if (!channel.sources.some(grant => grant.sourceId.startsWith('legacy:') === (lane === 'legacy'))) continue;
      const cursorKey = fingerprint(lane === 'legacy' ? [channel.id, 'legacy'] : channel.id);
      const cursor = this.store.read(workspaceId).channelCursors?.[cursorKey];
      const page = await host.listMessages(workspaceId, channel.id, { after: cursor, order: 'asc', notifications: lane, limit: 40 }, signal);
      if (signal.aborted || !this.options.workspaces().includes(workspaceId)) return;
      if (!page.nextCursor || page.nextCursor === cursor) continue;
      this.store.transact(workspaceId, state => {
        if (!state.installations.some(item => item.definition.id === CHANNEL_APP_ID && item.enabled)) return;
        (state.channelCursors ??= {})[cursorKey] = page.nextCursor!;
        for (const message of page.messages) {
          const action = channelNoticeAction(channel, message);
          if (action === 'mute') continue;
          const id = `channel-${fingerprint([channel.id, message.id])}`;
          if (state.outbox.some(event => event.id === id)) continue;
          state.outbox.push({ id, appId: CHANNEL_APP_ID, kind: 'channel.new', recordIds: [], title: '收到 1 条渠道消息', action,
            channelMessage: { channelId: channel.id, messageId: message.id }, createdAt: this.clock(), nextAttemptAt: this.clock(), attempts: 0 });
        }
      });
    }
  }
  private job(state: AppWorkspaceState, job: Omit<AppJob, 'revision' | 'attempts'>): void {
    const old = state.jobs.find(j => j.id === job.id);
    state.jobs = state.jobs.filter(j => j.id !== job.id); state.jobs.push({ ...job, revision: (old?.revision ?? 0) + 1, attempts: 0 });
  }
  private async dispatch(ws: string, app: AgentAppDefinition, command: AppCommand, p: Record<string, unknown>, requestId: string | undefined,
    actor: AppActor, legacy?: LogicalChannelLegacyAccess[]): Promise<AppCallResult> {
    if (command.handler === 'channel.run') return runChannelApp(this.options, ws, command.id, p, requestId, actor);
    const collection = this.collection(app, command), handler = command.handler;
    if (handler === 'records.list' || handler === 'records.get') return this.query(ws, { ...p, appId: app.id, collection: collection.id, ...(handler === 'records.get' ? { id: required(p.id, 'id') } : {}) } as AppQuery, legacy);
    if (handler === 'records.create') {
      let values = validateRecordValues(collection, p.values);
      if (collection.purpose === 'mail') values = { ...values, folder: 'drafts', status: 'draft' };
      return this.store.transact(ws, s => ({ record: this.put(s, app.id, collection.id, values) }));
    }
    if (handler === 'records.update' && this.store.updateRecord && collection.purpose !== 'feeds') {
      const id = required(p.id, 'id');
      const linked = this.store.read(ws).jobs.some(job => job.params.targetApp === app.id && job.params.targetId === id);
      if (!linked) return { record: this.store.updateRecord(ws, app.id, id, record => this.updateValues(record, collection, command, p)) };
    }
    if (handler === 'records.update' || handler === 'records.remove') return this.store.transact(ws, s => {
      const r = this.record(s, app.id, p.id); if (r.collection !== collection.id) throw new Error('Record belongs to another collection'); this.revision(r, p.expectedRevision);
      if (handler === 'records.remove') {
        if (['sending', 'uncertain'].includes(String(r.values.status)) || s.receipts.some(receipt => receipt.external && receipt.recordId === r.id && receipt.state !== 'done')) throw new Error('Sending or uncertain records require reconciliation before local deletion');
        const keys = [fingerprint([app.id, r.id])];
        if (r.origin) keys.push(fingerprint([app.id, r.origin.connectionId, r.origin.messageId]));
        s.deletions = [...new Set([...(s.deletions ?? []), ...keys])].slice(-10_000);
        s.records[app.id] = s.records[app.id].filter(x => x !== r);
        for (const receipt of s.receipts) {
          if (!receipt.key.startsWith(`${app.id}:`) || !receipt.result) continue;
          if (receipt.result.record?.id === r.id) receipt.result = { removed: true };
          if (receipt.result.records) receipt.result.records = receipt.result.records.filter(record => record.id !== r.id);
        }
      }
      else this.updateValues(r, collection, command, p);
      if (handler === 'records.remove' || r.values.done === true || r.values.status === 'cancelled') for (const job of s.jobs) if (job.params.targetApp === app.id && job.params.targetId === r.id || handler === 'records.remove' && job.appId === app.id && job.params.id === r.id) {
        job.enabled = false; job.revision++;
        for (const event of s.outbox) if (event.appId === job.appId) {
          event.recordIds = event.recordIds.filter(id => id !== String(job.params.id));
          if (!event.recordIds.length) event.action = 'mute';
        }
      }
      if (handler === 'records.remove') for (const event of s.outbox) if (event.appId === app.id) {
        event.recordIds = event.recordIds.filter(id => id !== r.id);
        if (!event.recordIds.length) event.action = 'mute';
      }
      if (handler === 'records.remove' && collection.purpose === 'feeds') {
        const articleIds = new Set((s.records[app.id] ?? []).filter(record => record.values.sourceId === r.id).map(record => record.id));
        for (const event of s.outbox) if (event.appId === app.id) {
          event.recordIds = event.recordIds.filter(id => !articleIds.has(id));
          if (!event.recordIds.length) event.action = 'mute';
        }
      }
      if (collection.purpose === 'feeds') this.job(s, { kind: 'sync', id: `feed:${app.id}:${r.id}`, appId: app.id, commandId: app.commands.find(c => c.handler === 'rss.sync')!.id, params: { id: r.id }, dueAt: this.clock(), intervalMs: this.interval(r.values.intervalMinutes, 30), enabled: handler !== 'records.remove' && r.values.enabled !== false, missed: 'catch-up' });
      return handler === 'records.remove' ? { removed: true } : { record: r };
    });
    if (handler === 'reminders.set' || handler === 'reminders.cancel') return this.store.transact(ws, s => {
      const old = p.id ? this.record(s, app.id, p.id) : undefined;
      if (old) this.revision(old, p.expectedRevision);
      if (handler === 'reminders.cancel' && !old) throw new Error('Reminder id is required');
      const input = handler === 'reminders.set' ? { ...valuesOf(p.values) } : {};
      const dailyValue = Object.prototype.hasOwnProperty.call(input, 'dailyTime') ? input.dailyTime : old?.values.dailyTime;
      const daily = typeof dailyValue === 'string' ? dailyValue.trim() : '';
      const weekdays = reminderWeekdays(Object.prototype.hasOwnProperty.call(input, 'weekdays') ? input.weekdays : old?.values.weekdays);
      if (weekdays && !daily) throw new Error('weekdays requires dailyTime');
      const oldJob = old && s.jobs.find(job => job.id === `reminder:${old.id}`);
      if (handler === 'reminders.set' && daily && !Object.prototype.hasOwnProperty.call(input, 'dueAt') && (!old || daily !== old.values.dailyTime || (Object.prototype.hasOwnProperty.call(input, 'weekdays') && input.weekdays !== old.values.weekdays) || old.values.enabled === false || oldJob?.localZone !== localZone())) {
        input.dueAt = new Date(nextCalendarReminder(daily, weekdays, new Date(this.clock()))).toISOString();
      }
      if (handler === 'reminders.set' && old?.values.enabled === false && Date.parse(String(old.values.dueAt)) <= this.clock() && !Object.prototype.hasOwnProperty.call(input, 'dueAt')) throw new Error('Re-enabling an overdue reminder requires an explicit dueAt; old delivered occurrences are not replayed');
      const values: AppValues = handler === 'reminders.cancel' ? { ...old!.values, enabled: false } : { ...old?.values, ...validateRecordValues(collection, input, !!old), enabled: true };
      if (handler === 'reminders.set' && (values.targetApp || values.targetId)) { this.app(ws, required(values.targetApp, 'targetApp')); this.record(s, String(values.targetApp), values.targetId); }
      if (old) for (const event of s.outbox) if (event.appId === app.id) {
        event.recordIds = event.recordIds.filter(id => id !== old.id);
        if (!event.recordIds.length) event.action = 'mute';
      }
      const dueAt = Date.parse(String(values.dueAt)); if (!Number.isFinite(dueAt)) throw new Error('A valid dueAt is required');
      const repeat = Number(values.repeatMinutes ?? 0); if (!Number.isFinite(repeat) || repeat < 0 || repeat > 525600) throw new Error('Invalid repeat interval');
      const dailyTime = typeof values.dailyTime === 'string' ? values.dailyTime.trim() : '';
      if (dailyTime) {
        getNextRunAt({ kind: 'daily', time: dailyTime }, new Date(this.clock()));
        if (repeat) throw new Error('dailyTime and repeatMinutes cannot both repeat');
        if (handler === 'reminders.set' && Object.prototype.hasOwnProperty.call(input, 'dueAt')) {
          const [hours, minutes] = dailyTime.split(':').map(Number);
          const expected = new Date(dueAt); expected.setHours(hours, minutes, 0, 0);
          if (dueAt !== expected.getTime()) throw new Error('dailyTime must match the local dueAt');
          if (weekdays && !weekdays.includes(expected.getDay())) throw new Error('dueAt must match weekdays');
        }
        values.dailyTime = dailyTime;
      }
      const record = this.put(s, app.id, collection.id, values, old?.id);
      this.job(s, { kind: 'reminder', id: `reminder:${record.id}`, appId: app.id, commandId: 'due', params: { id: record.id, targetApp: values.targetApp, targetId: values.targetId }, dueAt, intervalMs: repeat ? Math.max(60_000, repeat * 60_000) : undefined, ...(dailyTime ? { dailyTime, weekdays, localZone: localZone() } : {}), enabled: values.enabled === true, missed: values.missed === 'skip' ? 'skip' : 'catch-up' });
      return { record };
    });
    if (handler === 'rss.subscribe') {
      const values = validateRecordValues(collection, p.values);
      return this.store.transact(ws, s => {
        const record = this.put(s, app.id, collection.id, { intervalMinutes: 30, notify: 'digest', enabled: true, ...values });
        this.job(s, { kind: 'sync', id: `feed:${app.id}:${record.id}`, appId: app.id, commandId: app.commands.find(c => c.handler === 'rss.sync')!.id, params: { id: record.id }, dueAt: this.clock(), intervalMs: this.interval(values.intervalMinutes, 30), enabled: true, missed: 'catch-up' }); return { record };
      });
    }
    if (handler === 'rss.sync') return this.syncFeeds(ws, app, p, actor);
    if (handler === 'mail.reply') return this.store.transact(ws, s => { const source = this.record(s, app.id, p.id); if (source.collection !== collection.id || source.values.folder !== 'inbox') throw new Error('Reply requires a received message'); return { record: this.put(s, app.id, collection.id, { to: source.values.from, subject: `Re: ${source.values.subject}`, body: '', accountId: source.values.accountId, replyTo: source.values.messageId, folder: 'drafts', status: 'draft' }) }; });
    if (handler === 'mail.sync' || handler === 'messages.sync') return this.syncConnection(ws, app, command, p, actor);
    if (externalSend(command)) return this.send(ws, app, command, p, requestId!, actor);
    throw new Error('Unsupported app handler');
  }
  private interval(value: unknown, fallback: number): number {
    const minutes = Number(value ?? fallback); if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) throw new Error('Refresh interval must be 1–10080 minutes'); return minutes * 60_000;
  }
  private async syncFeeds(ws: string, app: AgentAppDefinition, p: Record<string, unknown>, actor: AppActor): Promise<AppCallResult> {
    if (!app.permissions?.includes('rss')) throw new Error('App does not declare RSS access');
    const feedCollection = app.collections.find(c => c.purpose === 'feeds'), articlesCollection = app.collections.find(c => c.purpose === 'articles');
    if (!feedCollection || !articlesCollection) throw new Error('RSS requires feeds and articles collections');
    const feeds = (this.store.read(ws).records[app.id] ?? []).filter(r => r.collection === feedCollection.id && r.values.enabled !== false && (!p.id || p.id === r.id));
    let count = 0;
    for (const feed of feeds) {
      const imported = await this.options.connectors.feed(required(feed.values.url, 'feed URL'), actor.signal);
      const articles = Array.isArray(imported) ? imported : imported.records;
      this.guard(ws, app.id, actor);
      this.store.transact(ws, s => {
        const latest = this.record(s, app.id, feed.id); if (latest.revision !== feed.revision || latest.values.enabled === false) throw new Error('Feed changed during refresh');
        const syncKey = `${app.id}:${feed.id}`;
        const initial = s.feedSyncedAt?.[syncKey] === undefined && !(s.records[app.id] ?? []).some(r => r.values.sourceId === feed.id);
        const newIds: string[] = [];
        for (const [index, article] of articles.slice(0, 200).entries()) {
          const id = `article-${fingerprint([feed.id, article.externalId || article.url || article.title]).slice(0, 32)}`;
          if (s.deletions?.includes(fingerprint([app.id, id])) || (s.records[app.id] ?? []).some(r => r.id === id)) continue;
          this.put(s, app.id, articlesCollection.id, { ...article, source: String(feed.values.title), sourceId: feed.id, read: false, saved: false }, id, Array.isArray(imported) ? undefined : imported.placeholderFields?.[index]); count++;
          const keyword = String(feed.values.keyword ?? '').toLocaleLowerCase();
          if (!keyword || `${article.title} ${article.content}`.toLocaleLowerCase().includes(keyword)) newIds.push(id);
        }
        (s.feedSyncedAt ??= {})[syncKey] = this.clock();
        if (newIds.length) this.enqueue(s, app.id, initial ? 'rss.imported' : 'rss.new', newIds,
          initial ? `RSS 首次同步完成（${newIds.length} 条）` : `收到 ${newIds.length} 条 RSS 更新`,
          feed.values.notify === 'mute' ? 'mute' : !initial && feed.values.notify === 'wake' ? 'wake' : 'digest');
      });
    }
    return { count, status: 'synced' };
  }
  private connection(ws: string, app: AgentAppDefinition, id: unknown, permission: AppPermission): StoredConnection {
    if (!app.permissions?.includes(permission)) throw new Error('App has not declared this account capability');
    const connection = this.store.read(ws).connections.find(c => c.id === id);
    if (!connection?.enabled || !connection.grants[app.id]?.includes(permission)) throw new Error('Connection unavailable or this app is not authorized; connect an account in the phone settings');
    if ((permission.startsWith('mail.') && connection.kind !== 'imap-smtp') || (permission.startsWith('messages.') && connection.kind !== 'feishu')) throw new Error('Connection type does not match the command');
    return structuredClone(connection);
  }
  private secret(connection: StoredConnection): ConnectionSecret | undefined { return connection.encryptedSecret ? JSON.parse(this.options.decrypt(connection.encryptedSecret)) as ConnectionSecret : undefined; }
  private async syncConnection(ws: string, app: AgentAppDefinition, command: AppCommand, p: Record<string, unknown>, actor: AppActor): Promise<AppCallResult> {
    const permission = command.handler === 'mail.sync' ? 'mail.read' : 'messages.read';
    const connection = this.connection(ws, app, required(p.accountId, 'accountId'), permission);
    if (connection.kind === 'feishu' && connection.identity === 'bot' && connection.profile && this.options.feishuAccounts) {
      await this.phoneAccount(ws).ensureReceiving(ws);
      this.guard(ws, app.id, actor);
      const current = this.connection(ws, app, connection.id, permission); if (current.revision !== connection.revision) throw new Error('Connection changed during sync');
      this.store.transact(ws, s => { const c = s.connections.find(c => c.id === connection.id)!; c.lastSyncAt = this.clock(); delete c.lastError; });
      return { count: 0, status: 'synced' };
    }
    let response: Awaited<ReturnType<AppConnectors['sync']>>;
    try {
      this.prepareImapReservation(ws, connection)?.(true);
      response = await this.options.connectors.sync(publicConnection(connection), this.secret(connection), connection.cursors?.[app.id] ?? {}, actor.signal, ws);
    } catch (error) {
      if (!actor.signal?.aborted) this.store.transact(ws, s => { const current = s.connections.find(c => c.id === connection.id); if (current?.revision === connection.revision) current.lastError = appError(error); });
      throw error;
    }
    this.guard(ws, app.id, actor);
    const current = this.connection(ws, app, connection.id, permission); if (current.revision !== connection.revision) throw new Error('Connection changed during sync');
    return this.store.transact(ws, s => {
      const ids: string[] = [];
      for (const [index, values] of response.records.entries()) {
        const id = `external-${fingerprint([connection.id, values.uid || values.messageId]).slice(0, 32)}`;
        if (s.deletions?.includes(fingerprint([app.id, id])) || s.deletions?.includes(fingerprint([app.id, connection.id, String(values.messageId ?? '')]))) continue;
        const existing = (s.records[app.id] ?? []).find(r => r.id === id || r.values.accountId === connection.id && r.values.messageId === values.messageId);
        if (existing) {
          // Keep local read/sent state while incorporating edits/retractions from the source.
          if (connection.kind === 'feishu' && existing.values.status !== 'sent' && existing.values.body !== values.body) {
            const fields: AppPlaceholderFields = {};
            for (const [field, kind] of Object.entries(existing.placeholderFields ?? {})) if (existing.values[field] === values[field]) fields[field] = kind;
            for (const [field, kind] of Object.entries(response.placeholderFields?.[index] ?? {})) if (existing.values[field] !== values[field]) fields[field] = kind;
            this.put(s, app.id, command.collection!, { ...values, read: existing.values.read ?? false, mine: existing.values.mine ?? false }, existing.id, fields);
          }
          continue;
        }
        const record = this.put(s, app.id, command.collection!, { ...values, accountId: connection.id, read: false }, id, response.placeholderFields?.[index]);
        record.origin = { connectionId: connection.id, messageId: String(values.messageId ?? '') }; ids.push(id);
      }
      const c = s.connections.find(c => c.id === connection.id)!; (c.cursors ??= {})[app.id] = response.cursor; c.lastSyncAt = this.clock(); delete c.lastError;
      if (ids.length) this.enqueue(s, app.id, `${app.id}.new`, ids, `${connection.name}：${ids.length} 条新内容`, connection.notify ?? 'wake');
      return { count: ids.length, status: 'synced' };
    });
  }
  private async send(ws: string, app: AgentAppDefinition, command: AppCommand, p: Record<string, unknown>, requestId: string, actor: AppActor): Promise<AppCallResult> {
    const mail = command.handler === 'mail.send';
    const original = mail && (!actor.legacyChannelSend || p.id !== undefined) ? this.query(ws, { appId: app.id, collection: command.collection, id: required(p.id, 'id') }).record! : undefined;
    if (original) { this.revision(original, actor.legacyChannelSend?.draftRevision ?? p.expectedRevision); if (original.values.folder !== 'drafts' || ['sending', 'uncertain', 'sent'].includes(String(original.values.status))) throw new Error('This draft is already sending, sent, or needs reconciliation'); }
    const values: AppValues = original ? { ...original.values } : { ...validateRecordValues(this.collection(app, command), valuesOf(p.values), true), accountId: required(p.accountId, 'accountId'), ...(mail ? { folder: 'drafts' } : {}) };
    required(values.body, 'body'); if (mail) required(values.to, 'to');
    const permission = mail ? 'mail.send' : 'messages.send';
    const connection = this.connection(ws, app, values.accountId, permission);
    if (!mail && values.replyTo && !(this.store.read(ws).records[app.id] ?? []).some(r => r.origin?.connectionId === connection.id && r.origin.messageId === values.replyTo)) throw new Error('Reply target must be a host-synced message in this authorized conversation');
    if (actor.kind === 'background') throw new Error('Background jobs cannot send external messages');
    if (actor.kind === 'agent' && !await this.options.confirmSend(ws, app.name, values, actor.signal)) throw new Error('Sending cancelled; no message submitted');
    if (actor.kind === 'agent') await this.legacyCommandAccess(ws, app, command, p, actor);
    this.guard(ws, app.id, actor);
    if (this.connection(ws, app, connection.id, permission).revision !== connection.revision) throw new Error('Connection changed before sending');
    const secret = this.secret(connection);
    const pending = this.store.transact(ws, s => {
      if (original) this.revision(this.record(s, app.id, original.id), original.revision);
      const record = this.put(s, app.id, command.collection!, { ...values, status: 'sending', ...(!mail ? { mine: true } : {}), date: new Date(this.clock()).toISOString() }, original?.id);
      const receipt = s.receipts.find(r => r.key === `${app.id}:${requestId}`); if (receipt) { receipt.submitted = true; receipt.recordId = record.id; }
      return record;
    });
    this.changed(ws, app.id);
    try {
      const sent = await this.options.connectors.send(publicConnection(connection), secret, values, requestId, actor.signal);
      return this.store.transact(ws, s => { const record = this.put(s, app.id, command.collection!, { status: 'sent', messageId: sent.messageId, ...(mail ? { folder: 'sent' } : {}) }, pending.id); record.origin = { connectionId: connection.id, messageId: sent.messageId }; return { record }; });
    } catch (error) {
      this.store.transact(ws, s => { this.put(s, app.id, command.collection!, { status: 'uncertain' }, pending.id); });
      throw new Error(`发送结果未确认，请核对远端后再决定是否重发：${appError(error)}`);
    }
  }
  private phoneAccount(ws: string): PhoneFeishuAccounts {
    this.scope(ws);
    if (!this.options.feishuAccounts) throw new Error('手机机器人接入服务尚未就绪');
    return this.options.feishuAccounts;
  }
  feishuStatus(ws: string) { return this.phoneAccount(ws).get(ws); }
  startFeishuSetup(ws: string) { return this.phoneAccount(ws).start(ws); }
  cancelFeishuSetup(ws: string) { this.phoneAccount(ws).cancel(ws); return { ok: true }; }
  beginFeishuBinding(ws: string) { return this.phoneAccount(ws).beginBinding(ws); }
  pairedFeishuChats(ws: string): AppFeishuChat[] {
    this.scope(ws);
    const state = this.store.read(ws), profile = phoneFeishuProfile(ws);
    return [...new Map([...(state.feishuChats ?? []), ...state.connections.flatMap(c => c.kind === 'feishu' && c.identity === 'bot' && c.profile === profile ? [{ chatId: c.chatId, name: c.name, ...(c.namePlaceholder ? { namePlaceholder: c.namePlaceholder } : {}) }] : [])].map(chat => [chat.chatId, chat])).values()];
  }
  connectedFeishuPrivateChats(ws: string): AppFeishuChat[] {
    this.scope(ws);
    const state = this.store.read(ws), profile = phoneFeishuProfile(ws);
    return (state.feishuChats ?? []).filter(chat => state.connections.some(c => c.kind === 'feishu' && c.profile === profile && c.identity === 'bot' && c.chatId === chat.chatId && c.enabled && c.grants.messages?.includes('messages.read')));
  }
  rememberFeishuChat(ws: string, chat: AppFeishuChat): void {
    this.scope(ws);
    if (!/^oc_[\w-]+$/.test(chat.chatId) || !chat.name) throw new Error('此会话不能用于手机，请联系手机专用机器人');
    // Called only after a human's private message matches this phone's current binding code.
    // Commit the connection with the discovered chat; reception must not depend on an open UI.
    this.store.transact(ws, state => {
      const profile = phoneFeishuProfile(ws);
      const existing = state.connections.find(c => c.kind === 'feishu' && c.profile === profile && c.identity === 'bot' && c.chatId === chat.chatId);
      if (existing && (!existing.enabled || !existing.grants.messages?.includes('messages.read'))) throw new Error('已有私聊连接已停用或关闭读取权限，请在“我的连接”中启用');
      if (!existing) {
        const installed = state.installations.find(a => a.definition.id === 'messages' && a.enabled);
        const sync = installed?.definition.commands.find(c => c.handler === 'messages.sync');
        if (!sync || !installed?.definition.permissions?.includes('messages.read') || !installed.definition.permissions.includes('messages.send')) throw new Error('请先启用短信应用，再连接私聊');
        const id = `feishu-private-${fingerprint([ws, chat.chatId]).slice(0, 32)}`;
        const namePlaceholder = chat.namePlaceholder === 'feishu-paired' && validAppConnectionName(chat.name, chat.namePlaceholder) ? chat.namePlaceholder : undefined;
        state.connections.push({ kind: 'feishu', id, name: chat.name, ...(namePlaceholder ? { namePlaceholder } : {}), chatId: chat.chatId, identity: 'bot', profile,
          enabled: true, notify: 'wake', grants: { messages: ['messages.read', 'messages.send'] }, revision: 1, cursors: {} });
        this.job(state, { kind: 'sync', id: `connection:${id}:messages`, appId: 'messages', commandId: sync.id, params: { accountId: id }, dueAt: this.clock(), intervalMs: 120_000, enabled: true, missed: 'catch-up' });
      }
      const namePlaceholder = chat.namePlaceholder === 'feishu-paired' && validAppConnectionName(chat.name, chat.namePlaceholder) ? chat.namePlaceholder : undefined;
      state.feishuChats = [...(state.feishuChats ?? []).filter(item => item.chatId !== chat.chatId), { chatId: chat.chatId, name: chat.name, ...(namePlaceholder ? { namePlaceholder } : {}) }];
    });
    this.changed(ws);
  }
  receiveFeishuMessage(ws: string, values: AppValues, conversation?: PhoneFeishuConversation, fields?: AppPlaceholderFields): void {
    this.scope(ws);
    if (this.stopped || typeof values.messageId !== 'string' || !values.messageId || typeof values.chatId !== 'string' || !/^oc_[\w-]+$/.test(values.chatId)) return;
    if (conversation && (conversation.type !== 'p2p' && conversation.type !== 'group' || conversation.type === 'group' && !conversation.mentionedBot)) return;
    const profile = phoneFeishuProfile(ws), state = this.store.read(ws);
    const existing = state.connections.find(c => c.kind === 'feishu' && c.identity === 'bot' && c.profile === profile && c.chatId === values.chatId);
    if (existing && !existing.enabled || !existing && (!conversation || !state.installations.some(a => a.definition.id === 'messages' && a.enabled))) return;
    let discovered: { id: string; name: string } | undefined;
    const changed = this.store.transact(ws, s => {
      if (!existing && conversation) {
        const id = `feishu-chat-${fingerprint([ws, values.chatId]).slice(0, 32)}`;
        const suppliedName = conversation.name?.trim().slice(0, 200);
        const namePlaceholder = conversation.type === 'p2p' ? 'feishu-private' : 'feishu-group';
        const name = suppliedName || appConnectionNameSource(namePlaceholder, s.connections.filter(c => c.kind === 'feishu').length + 1);
        // The dedicated robot is connected once by the human. Incoming events discover
        // immutable delivery targets; custom apps still need their own explicit grants.
        s.connections.push({ kind: 'feishu', id, name, ...(!suppliedName ? { namePlaceholder } : {}), chatId: String(values.chatId), identity: 'bot', profile,
          enabled: true, notify: 'wake', grants: { messages: ['messages.read', 'messages.send'] }, revision: 1, cursors: {} });
        const sync = s.installations.find(a => a.definition.id === 'messages')!.definition.commands.find(c => c.handler === 'messages.sync');
        if (sync) this.job(s, { kind: 'sync', id: `connection:${id}:messages`, appId: 'messages', commandId: sync.id, params: { accountId: id }, dueAt: this.clock() + 120_000, intervalMs: 120_000, enabled: true, missed: 'catch-up' });
        discovered = { id, name };
      }
      const apps = new Set<string>();
      for (const connection of s.connections.filter(c => c.kind === 'feishu' && c.identity === 'bot' && c.profile === profile && c.enabled && c.chatId === values.chatId)) {
        for (const installed of s.installations.filter(a => a.enabled && connection.grants[a.definition.id]?.includes('messages.read'))) {
          const app = installed.definition;
          const command = app.commands.find(c => c.handler === 'messages.sync'); if (!command?.collection || !app.permissions?.includes('messages.read')) continue;
          const id = `external-${fingerprint([connection.id, values.messageId]).slice(0, 32)}`;
          if (s.deletions?.includes(fingerprint([app.id, id])) || s.deletions?.includes(fingerprint([app.id, connection.id, String(values.messageId)]))) continue;
          if ((s.records[app.id] ?? []).some(r => r.id === id || r.origin?.connectionId === connection.id && r.origin.messageId === values.messageId)) continue;
          const record = this.put(s, app.id, command.collection, { ...values, accountId: connection.id, read: false }, id, fields);
          record.origin = { connectionId: connection.id, messageId: String(values.messageId) };
          this.enqueue(s, app.id, `${app.id}.new`, [id], `${connection.name}：1 条新内容`, connection.notify ?? 'wake'); apps.add(app.id);
        }
        connection.lastSyncAt = this.clock(); delete connection.lastError;
      }
      return [...apps];
    });
    for (const appId of changed) this.changed(ws, appId);
    // Persist the first message before optional display-name lookup. Metadata must
    // never block reception, and a late result must not overwrite a user's rename.
    if (discovered && conversation && !conversation.name && this.options.connectors.feishuConversationName) {
      const original = discovered;
      void this.options.connectors.feishuConversationName(String(values.chatId), String(values.messageId), conversation.type, profile).then(name => {
        if (!name || this.stopped || !this.options.workspaces().includes(ws)) return;
        this.store.transact(ws, s => { const c = s.connections.find(c => c.id === original.id); if (c?.revision === 1 && c.name === original.name) { c.name = name.slice(0, 200); delete c.namePlaceholder; c.revision++; } });
        this.changed(ws, 'messages');
      }).catch(error => console.warn('[agentApps] received message; conversation name unavailable', appError(error)));
    }
  }
  async listFeishuChats(ws: string, identity: 'bot' | 'user', pageToken?: string): Promise<AppFeishuChatPage> {
    this.scope(ws);
    if (!['bot', 'user'].includes(identity)) throw new Error('无效的飞书身份');
    if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 4096)) throw new Error('无效的飞书分页标记');
    const profile = phoneFeishuProfile(ws);
    const page = await this.options.connectors.listFeishuChats(identity, pageToken, profile);
    this.scope(ws);
    const connections = this.store.read(ws).connections;
    const chats = [...new Map([...(identity === 'bot' ? this.pairedFeishuChats(ws) : []), ...page.chats].map(chat => [chat.chatId, chat])).values()];
    return { ...page, chats: chats.map(chat => ({ ...chat,
      unavailable: connections.some(c => c.kind === 'feishu' && c.chatId === chat.chatId && c.identity === identity && c.profile === profile) ? '已添加到手机，请编辑原连接' : undefined
    })) };
  }
  saveConnection(ws: string, input: AppConnectionInput, validateOnly = false): AppConnection {
    this.scope(ws);
    const id = required(input.id, 'connection id'); if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid connection id');
    const old = this.store.read(ws).connections.find(c => c.id === id);
    const profile = input.kind === 'feishu' ? old?.kind === 'feishu' ? old.profile : phoneFeishuProfile(ws) : undefined;
    const name = required(input.name, 'connection name');
    if (!input.grants || typeof input.grants !== 'object' || Array.isArray(input.grants)) throw new Error('Account grants are required');
    for (const [appId, grants] of Object.entries(input.grants)) { const app = this.store.read(ws).installations.find(a => a.definition.id === appId)?.definition; if (!app || !Array.isArray(grants) || grants.some(p => !app.permissions?.includes(p))) throw new Error('Invalid account grant'); }
    if (input.notify && !['wake', 'digest', 'mute'].includes(input.notify)) throw new Error('Invalid notification policy');
    if (input.notificationHint !== undefined && (typeof input.notificationHint !== 'string' || input.notificationHint.length > 2000)) throw new Error('处理提示最多 2000 字符');
    if (input.kind === 'imap-smtp') {
      for (const host of [input.imapHost, input.smtpHost]) if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('Invalid mail server hostname');
      for (const port of [input.imapPort, input.smtpPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
      if (!['tls','starttls'].includes(input.imapTls) || !['tls','starttls'].includes(input.smtpTls)) throw new Error('TLS or STARTTLS is required');
      required(input.address, 'address'); required(input.user, 'user'); required(input.mailbox, 'mailbox');
    } else if (input.kind === 'feishu') {
      if (!/^oc_[a-zA-Z0-9_-]+$/.test(input.chatId) || !['bot', 'user'].includes(input.identity)) throw new Error('A Feishu chat id and explicit identity are required');
      if (input.profile !== undefined && input.profile !== profile) throw new Error('连接授权由手机管理，不能切换到其他机器人');
      const connections = this.store.read(ws).connections;
      if (!old && connections.some(c => c.kind === 'feishu' && c.chatId === input.chatId && c.identity === input.identity && c.profile === profile)) throw new Error('此会话已添加到手机，请编辑原连接');
    } else throw new Error('Unsupported connector');
    const { password, smtpPassword, expectedRevision, namePlaceholder: requestedNamePlaceholder, ...safe } = input;
    const namePlaceholder = old && requestedNamePlaceholder === old.namePlaceholder && validAppConnectionName(name, requestedNamePlaceholder) ? requestedNamePlaceholder : undefined;
    if (old && expectedRevision !== old.revision) throw new Error('Connection changed or expectedRevision missing; reload settings before saving');
    const sameTarget = old?.kind === input.kind && (input.kind === 'feishu' ? old.kind === 'feishu' && old.chatId === input.chatId && old.identity === input.identity : old.kind === 'imap-smtp' && old.imapHost === input.imapHost && old.user === input.user && old.mailbox === input.mailbox);
    // Old message origins and IMAP UIDs remain scoped to the original account/chat.
    // Reusing its id for another destination would incorrectly authorize old replies.
    if (old && !sameTarget) throw new Error('连接目标不能更换；请为另一个邮箱或飞书会话新建连接，原连接可停用');
    for (const value of [password, smtpPassword]) if (value !== undefined && typeof value !== 'string') throw new Error('Mailbox passwords must be strings');
    let encryptedSecret = input.kind === 'imap-smtp' ? old?.encryptedSecret : undefined;
    if (input.kind === 'imap-smtp' && (password || smtpPassword)) {
      const previous = old ? this.secret(old) : undefined;
      const next = { password: password || previous?.password, smtpPassword: smtpPassword || previous?.smtpPassword };
      if (!next.password) throw new Error('Mailbox password or app password is required');
      encryptedSecret = this.options.encrypt(JSON.stringify(next));
    }
    if (input.kind === 'imap-smtp' && !encryptedSecret) throw new Error('Mailbox password or app password is required');
    const draft: StoredConnection = { ...safe, ...(namePlaceholder ? { namePlaceholder } : {}), ...(input.kind === 'feishu' ? { profile } : {}), id, name, encryptedSecret, cursors: sameTarget ? old.cursors : {}, enabled: input.enabled === true, revision: (old?.revision ?? 0) + 1 };
    const settleImap = this.prepareImapReservation(ws, draft);
    // Validate the exact target before approval, then arbitrate again at commit.
    if (validateOnly) { settleImap?.(false); return publicConnection(draft); }
    let connection: AppConnection;
    try { connection = this.store.transact(ws, s => {
      const c = draft;
      s.connections = [...s.connections.filter(c => c.id !== id), c];
      for (const appId of Object.keys(c.grants)) {
        const readPermission = c.kind === 'imap-smtp' ? 'mail.read' : 'messages.read';
        const sync = s.installations.find(a => a.definition.id === appId)!.definition.commands.find(command => command.handler === (c.kind === 'imap-smtp' ? 'mail.sync' : 'messages.sync'));
        if (sync) this.job(s, { kind: 'sync', id: `connection:${id}:${appId}`, appId, commandId: sync.id, params: { accountId: id }, dueAt: this.clock(), intervalMs: 120_000, enabled: c.enabled && c.grants[appId].includes(readPermission), missed: 'catch-up' });
      }
      for (const job of s.jobs) if (job.id.startsWith(`connection:${id}:`) && !c.grants[job.appId]) { job.enabled = false; job.revision++; }
      return publicConnection(c);
    }); } catch (error) { settleImap?.(false); throw error; }
    settleImap?.(true);
    this.changed(ws);
    if (connection.kind === 'feishu' && connection.identity === 'bot' && connection.profile && connection.enabled) this.startPhoneReceiver(ws);
    return connection;
  }
  async testConnection(ws: string, id: string): Promise<{ ok: true }> {
    this.scope(ws); const c = this.store.read(ws).connections.find(c => c.id === id); if (!c) throw new Error('Connection not found');
    try {
      if (c.kind === 'feishu' && c.identity === 'bot' && c.profile && this.options.feishuAccounts) await this.phoneAccount(ws).ensureReceiving(ws);
      else await this.options.connectors.test(publicConnection(c), this.secret(c), ws);
      this.store.transact(ws, s => { const latest = s.connections.find(x => x.id === id); if (latest?.revision === c.revision) delete latest.lastError; }); this.changed(ws); return { ok: true };
    }
    catch (error) { this.store.transact(ws, s => { const latest = s.connections.find(x => x.id === id); if (latest?.revision === c.revision) latest.lastError = appError(error); }); this.changed(ws); throw error; }
  }
  private prepareImapReservation(workspaceId: string, connection: AppConnection) {
    if (!this.options.claimImapConsumer || connection.kind !== 'imap-smtp') return;
    let workspace = this.imapReservations.get(workspaceId);
    if (!workspace) this.imapReservations.set(workspaceId, workspace = new Map());
    const previous = workspace.get(connection.id);
    const enabled = connection.enabled && Object.values(connection.grants).some(grants => grants.includes('mail.read'));
    const key = enabled ? imapMailboxKey(connection) : undefined;
    if (previous?.key === key) return;
    const next = key ? { key, release: this.options.claimImapConsumer(workspaceId, connection) } : undefined;
    return (saved: boolean) => {
      if (!saved) { next?.release(); return; }
      previous?.release();
      if (next) workspace.set(connection.id, next);
      else workspace.delete(connection.id);
    };
  }
  private releaseImapWorkspace(workspaceId: string): void {
    const reservations = this.imapReservations.get(workspaceId);
    if (!reservations) return;
    this.imapReservations.delete(workspaceId);
    for (const reservation of reservations.values()) reservation.release();
  }
  refreshImapReservations(): void {
    if (!this.options.claimImapConsumer) return;
    const workspaces = new Set(this.options.workspaces());
    for (const id of this.imapReservations.keys()) if (!workspaces.has(id)) this.releaseImapWorkspace(id);
    for (const id of workspaces) for (const connection of this.store.read(id).connections) {
      try { this.prepareImapReservation(id, connection)?.(true); }
      catch (error) {
        // Old compatible configurations opened before a competing consumer was connected.
        // The active sync path reports a conflict on its own connection instead of failing all Apps startup.
        if (!['imap-mailbox-in-use', 'imap-mailbox-identity-invalid'].includes(appError(error))) throw error;
      }
    }
  }
  private startPhoneReceiver(ws: string): void {
    if (this.stopped || !this.options.feishuAccounts) return;
    const connections = this.store.read(ws).connections.filter(c => c.kind === 'feishu' && c.identity === 'bot' && c.profile === phoneFeishuProfile(ws) && c.enabled);
    // Listen even with an empty inbox: the first incoming chat creates its own target.
    void this.phoneAccount(ws).get(ws).then(status => status.appBound ? this.phoneAccount(ws).ensureReceiving(ws) : undefined).then(() => undefined, error => appError(error)).then(error => {
      if (this.stopped || !this.options.workspaces().includes(ws)) return;
      this.store.transact(ws, s => { for (const old of connections) { const current = s.connections.find(c => c.id === old.id); if (current?.revision === old.revision) { if (error) current.lastError = error; else delete current.lastError; } } });
      this.changed(ws);
    });
  }
  start(): void {
    if (!this.stopped) return;
    try { this.refreshImapReservations(); } catch (error) { console.error('[agentApps] existing IMAP reservations unavailable', appError(error)); }
    this.stopped = false; this.background = new AbortController();
    this.backgroundWorkspaceErrors.clear();
    this.registerLocalApps();
    for (const ws of this.options.workspaces()) { try { this.startPhoneReceiver(ws); } catch (error) { console.error('[agentApps] phone receiver startup failed', ws, appError(error)); } }
    this.knownWorkspaces = new Set(this.options.workspaces());
    this.schedule();
  }
  refreshWorkspaces(): void {
    if (this.stopped) return;
    const current = new Set(this.options.workspaces());
    for (const ws of this.knownWorkspaces) if (!current.has(ws)) {
      this.releaseImapWorkspace(ws);
      this.options.feishuAccounts?.stopWorkspace(ws);
      this.backgroundWorkspaceErrors.delete(ws);
    }
    for (const ws of current) if (!this.knownWorkspaces.has(ws)) {
      try { this.startPhoneReceiver(ws); } catch (error) { console.error('[agentApps] phone receiver startup failed', ws, appError(error)); }
    }
    if ([...current].some(ws => !this.knownWorkspaces.has(ws))) {
      try { this.refreshImapReservations(); } catch (error) { console.error('[agentApps] existing IMAP reservations unavailable', appError(error)); }
      this.registerLocalApps();
    }
    this.knownWorkspaces = current;
  }
  stop(): void { this.stopped = true; this.background.abort(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.knownWorkspaces.clear(); this.backgroundWorkspaceErrors.clear(); this.options.feishuAccounts?.stop(); for (const ws of this.imapReservations.keys()) this.releaseImapWorkspace(ws); }
  async waitForIdle(): Promise<void> {
    for (;;) {
      const work = [...this.inFlight.values()].map(entry => entry.work as Promise<unknown>);
      work.push(...this.runningJobs.values());
      if (this.activeTick) work.push(this.activeTick);
      if (!work.length) return;
      await Promise.allSettled(work);
    }
  }
  private schedule(): void { if (this.stopped) return; this.timer = setTimeout(() => { void this.tick().finally(() => this.schedule()); }, 2000); this.timer.unref?.(); }
  tick(): Promise<void> {
    if (this.activeTick) return this.activeTick;
    this.activeTick = this.tickOnce().finally(() => { this.activeTick = undefined; });
    return this.activeTick;
  }
  private async tickOnce(): Promise<void> {
      for (const ws of this.options.workspaces()) {
        if (this.backgroundWorkspaceErrors.has(ws)) continue;
        try {
          const zone = localZone();
          if (this.store.read(ws).jobs.some(j => j.enabled && j.kind === 'reminder' && j.dailyTime && j.localZone !== zone && j.dueAt > this.clock())) {
            this.store.transact(ws, s => {
              for (const job of s.jobs.filter(j => j.enabled && j.kind === 'reminder' && j.dailyTime && j.localZone !== zone && j.dueAt > this.clock())) {
                job.dueAt = nextCalendarReminder(job.dailyTime!, job.weekdays, new Date(this.clock()));
                job.localZone = zone; job.revision++;
                const record = this.record(s, job.appId, job.params.id);
                record.values.dueAt = new Date(job.dueAt).toISOString(); record.revision++; record.updatedAt = this.clock();
              }
            });
            this.changed(ws);
          }
          const state = this.store.read(ws);
          for (const job of state.jobs.filter(j => j.enabled && j.kind === 'reminder' && j.dueAt <= this.clock())) await this.runJob(ws, structuredClone(job));
          await this.collectChannelNotices(ws, this.background.signal).catch(error => {
            if (!this.background.signal.aborted) console.warn('[agentApps] channel notification collection deferred', appError(error));
          });
          for (const pending of this.store.read(ws).outbox.filter(e => !e.deliveredAt && e.nextAttemptAt <= this.clock()).slice(0, 20)) {
            const event = this.store.read(ws).outbox.find(e => e.id === pending.id);
            if (!event || event.deliveredAt) continue;
            if (!this.store.read(ws).installations.some(a => a.definition.id === event.appId && a.enabled)) continue;
            try {
              let receipt: Awaited<ReturnType<AgentAppsOptions['deliver']>>;
              if (this.options.channels && isLegacyChannelApp(event.appId) && event.kind === `${event.appId}.new`) {
                await this.handOffLegacyNotice(ws, event, this.background.signal);
                receipt = { muted: true };
              } else receipt = event.action === 'mute' ? { muted: true } : await this.options.deliver(ws, structuredClone(event));
              if (!receipt.messageId && !receipt.muted) throw new Error('Notification was not durably acknowledged');
              this.store.transact(ws, s => { const e = s.outbox.find(x => x.id === event.id)!; e.deliveredAt = this.clock(); e.messageId = receipt.messageId; });
            } catch (error) {
              console.warn('[agentApps] notification remains pending', appError(error));
              this.store.transact(ws, s => { const e = s.outbox.find(x => x.id === event.id)!; e.attempts++; e.nextAttemptAt = this.clock() + Math.min(300_000, 2000 * 2 ** Math.min(e.attempts, 8)); });
            }
          }
          // F-01 滚动裁剪：已投递且超保留期的事件移出账本（无过期项时不写，避免空事务）。
          const now = this.clock();
          if (this.store.read(ws).outbox.some(e => e.deliveredAt !== undefined && now - e.deliveredAt > OUTBOX_DELIVERED_KEEP_MS)) {
            this.store.transact(ws, s => { s.outbox = s.outbox.filter(e => e.deliveredAt === undefined || now - e.deliveredAt <= OUTBOX_DELIVERED_KEEP_MS); });
          }
        } catch (error) {
          const message = appError(error);
          if (isPersistentStoreFailure(error)) {
            if (!this.backgroundWorkspaceErrors.has(ws)) {
              this.backgroundWorkspaceErrors.set(ws, message);
              console.error('[agentApps] workspace background disabled until restart', ws, message);
            }
          } else console.error('[agentApps] workspace background error', ws, message);
        }
      }
      // Slow network polling never holds the timer/wake pass. At most two sync jobs run
      // across all workspaces; stable due-time order and job identity avoid duplicate polls.
      const due = this.options.workspaces().flatMap(ws => {
        try { return this.store.read(ws).jobs.filter(j => j.enabled && j.kind === 'sync' && j.dueAt <= this.clock() && this.store.read(ws).installations.some(a => a.enabled && a.definition.id === j.appId)).map(job => ({ ws, job })); }
        catch { return []; } // Corrupt workspaces were surfaced by the main pass above.
      }).sort((a, b) => a.job.dueAt - b.job.dueAt);
      for (const { ws, job } of due) {
        if (this.runningJobs.size >= 2 || this.background.signal.aborted) break;
        const key = `${ws}:${job.id}`; if (this.runningJobs.has(key)) continue;
        const running = this.runJob(ws, structuredClone(job)).catch(error => console.error('[agentApps] sync job failed', appError(error))).finally(() => { this.runningJobs.delete(key); });
        this.runningJobs.set(key, running);
      }
  }
  private async runJob(ws: string, job: AppJob): Promise<void> {
    const installed = this.store.read(ws).installations.find(a => a.definition.id === job.appId); if (!installed?.enabled) return;
    if (job.kind === 'reminder') {
      this.store.transact(ws, s => {
        const current = s.jobs.find(j => j.id === job.id); if (!current?.enabled || current.revision !== job.revision) return;
        const record = this.record(s, job.appId, job.params.id);
        if (job.missed !== 'skip' || this.clock() - job.dueAt < 60_000) this.enqueue(s, job.appId, 'reminder.due', [record.id], String(record.values.title), 'wake', `${job.id}:${job.revision}:${job.dueAt}`, job.dueAt);
        if (job.dailyTime) { current.dueAt = nextCalendarReminder(job.dailyTime, job.weekdays, new Date(this.clock())); current.localZone = localZone(); record.values.dueAt = new Date(current.dueAt).toISOString(); }
        else if (job.intervalMs) { current.dueAt = job.dueAt + (Math.floor((this.clock() - job.dueAt) / job.intervalMs) + 1) * job.intervalMs; record.values.dueAt = new Date(current.dueAt).toISOString(); }
        else { current.enabled = false; record.values.enabled = false; }
        record.revision++; record.updatedAt = this.clock();
      }); this.changed(ws, job.appId); return;
    }
    if (!['mail.sync', 'messages.sync', 'rss.sync'].includes(installed.definition.commands.find(c => c.id === job.commandId)?.handler ?? '')) throw new Error('Background jobs may only run registered sync commands');
    try {
      await this.execute(ws, { appId: job.appId, commandId: job.commandId, params: job.params }, { kind: 'background', runId: job.id, jobId: job.id, jobRevision: job.revision, signal: this.background.signal });
      this.store.transact(ws, s => { const current = s.jobs.find(j => j.id === job.id); if (current?.revision === job.revision) { current.dueAt = this.clock() + (current.intervalMs ?? 120_000); current.attempts = 0; delete current.lastError; } });
    } catch (error) {
      this.store.transact(ws, s => {
        const current = s.jobs.find(j => j.id === job.id); if (current?.revision !== job.revision) return;
        current.attempts++; current.lastError = appError(error); current.dueAt = this.clock() + Math.min(900_000, 10_000 * 2 ** Math.min(current.attempts, 7));
        const connection = s.connections.find(c => c.id === current.params.accountId); if (connection) connection.lastError = current.lastError;
      }); this.changed(ws, job.appId);
    }
  }
}
