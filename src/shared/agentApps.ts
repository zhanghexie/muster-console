/** App authoring and runtime contract. No model-provider or renderer dependency. */
import type { LogicalChannel, LogicalChannelCatalogEntry, LogicalChannelMessage, LogicalChannelMessagePage, LogicalChannelMessageQuery } from './messagingChannels';

// Host namespace outside authorable App IDs, so existing custom apps keep their identities.
export const CHANNEL_APP_ID = 'muster.channel';
export const isLegacyChannelApp = (id: string): boolean => id === 'mail' || id === 'messages';
export const CHANNEL_APP_COMMANDS = ['channels', 'list', 'get', 'state', 'reply', 'send', 'save-draft', 'search', 'catalog', 'bind', 'unbind'] as const;
export type AppValue = string | number | boolean | null;
export type AppValues = Record<string, AppValue>;
export type AppField = { id: string; label: string; type: 'text' | 'multiline' | 'number' | 'boolean' | 'datetime' | 'url' | 'select' | 'image'; required?: boolean; options?: string[]; readOnly?: boolean };
export type AppCollection = { id: string; title: string; fields: AppField[]; titleField: string; subtitleField?: string; bodyField?: string; purpose?: 'mail' | 'feeds' | 'articles' | 'messages' };
export const APP_HANDLERS = ['records.list', 'records.get', 'records.create', 'records.update', 'records.remove', 'reminders.set', 'reminders.cancel', 'rss.subscribe', 'rss.sync', 'mail.sync', 'mail.send', 'mail.reply', 'messages.sync', 'messages.send', 'channel.run'] as const;
export type AppHandler = typeof APP_HANDLERS[number];
export type AppPermission = 'rss' | 'mail.read' | 'mail.send' | 'messages.read' | 'messages.send';
export type AppView = {
  id: string; title: string; kind: 'list' | 'checklist' | 'reader' | 'messages' | 'form' | 'custom' | 'operation';
  collection?: string; commands?: string[]; html?: string;
};
export type AppCommand = {
  id: string; title: string; handler: AppHandler; collection?: string;
  /** A fixed patch makes reusable actions (complete, star, archive) ordinary record commands. */
  patch?: AppValues;
  presentation?: { viewId: string; entity?: 'input.id' | 'result.id' };
};
export type AgentAppDefinition = {
  sdkVersion: 1; id: string; name: string; version: number; icon: string; description: string;
  collections: AppCollection[]; commands: AppCommand[]; views: AppView[]; homeView: string;
  permissions?: AppPermission[];
  notificationHint?: string;
};
export type AppPlaceholderKind = 'rss-no-title' | 'mail-no-subject' | 'mail-body-omitted' | 'message-unknown-sender' | 'message-withdrawn' | 'message-peer' | 'message-group-member' | 'message-unknown-body';
export type AppPlaceholderFields = Record<string, AppPlaceholderKind>;
export type AppRecord = { id: string; collection: string; revision: number; createdAt: number; updatedAt: number; values: AppValues; origin?: { connectionId: string; messageId: string }; placeholderFields?: AppPlaceholderFields };
export type AppImageAsset = { id: string; appId: string; name: string; mime: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number; bytes: number; sha256: string; thumbnailSha256: string; createdAt: number; deleting?: boolean };
export type AppOperation = {
  workspaceId: string; agentId: string; runId: string; operationId: string; sequence: number;
  appId: string; commandId: string; title: string; actor: 'agent' | 'human' | 'background';
  phase: 'running' | 'succeeded' | 'failed' | 'cancelled'; at: number; viewId: string; entityId?: string;
  revision?: number; error?: string;
};
export type AppCall = { appId: string; commandId: string; params?: Record<string, unknown>; requestId?: string };
export type AppQuery = { appId: string; collection?: string; id?: string; notificationId?: string; search?: string; filter?: AppValues; offset?: number; limit?: number; channelId?: string; viewId?: 'bindings'; channelQuery?: LogicalChannelMessageQuery & { drafts?: boolean } };
export const MAX_APP_DEFINITION_BYTES = 300_000;
export const MAX_APP_DEFINITION_EXTENSION_BYTES = 64_000;
export const MAX_APP_RECORD_VALUE_BYTES = 256_000;
export const MAX_APP_RECORD_EXTENSION_BYTES = 64_000;
const APP_DEFINITION_KEYS = new Set(['sdkVersion', 'id', 'name', 'version', 'icon', 'description', 'collections', 'commands', 'views', 'homeView', 'permissions', 'notificationHint']);
const jsonUtf8Bytes = (value: unknown): number => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return 0;
  return new TextEncoder().encode(encoded).byteLength;
};
const jsonExtensions = (value: unknown, known: ReadonlySet<string>): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
};
/** Query windows are shared by the in-memory and SQLite stores. Keep paging
 * bounded even when a tool supplies an untrusted runtime value. */
export const APP_QUERY_MAX_LIMIT = 200;
export const APP_QUERY_DEFAULT_LIMIT = 100;
export const APP_QUERY_MAX_OFFSET = 1_000_000;
export function normalizeAppQueryWindow(offset: unknown, limit: unknown): { offset: number; limit: number } {
  const read = (value: unknown, name: string, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
    return value;
  };
  return {
    offset: Math.min(APP_QUERY_MAX_OFFSET, Math.max(0, read(offset, 'offset', 0))),
    limit: Math.max(1, Math.min(APP_QUERY_MAX_LIMIT, read(limit, 'limit', APP_QUERY_DEFAULT_LIMIT))),
  };
}
export type AppCallResult = { record?: AppRecord; records?: AppRecord[]; total?: number; nextOffset?: number | null; truncated?: Record<string, string[]>; removed?: boolean; count?: number; status?: string; message?: string; channels?: LogicalChannel[]; channelCatalog?: LogicalChannelCatalogEntry[]; channelMessages?: LogicalChannelMessagePage; channelMessage?: LogicalChannelMessage; searchLimited?: boolean };
export type AppInstallation = { definition: AgentAppDefinition; enabled: boolean; installedAt: number; approvedDefinition?: string; libraryPrivate?: boolean; library?: { catalogId: string; baseFingerprint: string; private: boolean } };
export type AppLibraryItem = { catalogId: string; appId: string; name: string; description: string; version: number; private: boolean; canManageVisibility: boolean; canPublish?: boolean; conflict: boolean; installedVersion?: number; updateAvailable: boolean };
export type MailConnectionConfig = {
  kind: 'imap-smtp'; id: string; name: string; address: string; user: string;
  imapHost: string; imapPort: number; imapTls: 'tls' | 'starttls';
  smtpHost: string; smtpPort: number; smtpTls: 'tls' | 'starttls'; mailbox: string;
};
export type MessageConnectionConfig = { kind: 'feishu'; id: string; name: string; chatId: string; identity: 'bot' | 'user'; /** Retired records may omit the credential scope. Live CLI operations require it. */ profile?: string };
export type AppConnectionNamePlaceholder = 'feishu-private' | 'feishu-group' | 'feishu-paired' | 'feishu-unnamed';
export type AppFeishuChat = { chatId: string; name: string; unavailable?: string; namePlaceholder?: AppConnectionNamePlaceholder };
export type AppFeishuChatPage = { chats: AppFeishuChat[]; pageToken?: string };
export type AppFeishuStatus = { workspaceId: string; cliReady: boolean; appBound: boolean; starting: boolean; receiving?: boolean; onboarding: { url: string; qrDataUrl?: string } | null; lastError?: string; binding?: { code: string; expiresAt: number; ready?: boolean } | null; pairedChat?: AppFeishuChat; pairingError?: string };
export type AppConnection = (MailConnectionConfig | MessageConnectionConfig) & {
  enabled: boolean; grants: Record<string, AppPermission[]>; revision: number;
  notify?: 'wake' | 'digest' | 'mute';
  notificationHint?: string;
  namePlaceholder?: AppConnectionNamePlaceholder;
  lastSyncAt?: number; lastError?: string;
};
export type AppConnectionInput = (MailConnectionConfig | MessageConnectionConfig) & { password?: string; smtpPassword?: string; expectedRevision?: number; enabled: boolean; notify?: 'wake' | 'digest' | 'mute'; notificationHint?: string; grants: Record<string, AppPermission[]>; namePlaceholder?: AppConnectionNamePlaceholder };
export type AppSnapshot = { workspaceId: string; apps: AppInstallation[]; operations: AppOperation[]; connections: AppConnection[]; errors: string[] };
export type AppChanged = { workspaceId: string; appId?: string; revision: number };
export const APP_ID = /^[a-z][a-z0-9-]{0,63}$/;
const fieldId = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const permissions = new Set<AppPermission>(['rss', 'mail.read', 'mail.send', 'messages.read', 'messages.send']);
const viewKinds = new Set(['list', 'checklist', 'reader', 'messages', 'form', 'custom', 'operation']);
const fieldKinds = new Set(['text', 'multiline', 'number', 'boolean', 'datetime', 'url', 'select', 'image']);

export function appError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function unique<T extends { id: string }>(items: T[], kind: string): void {
  assert(new Set(items.map(item => item.id)).size === items.length, `Duplicate ${kind} id`);
}
/** Validation also synthesizes the standard operation page; broken explicit bindings fail closed. */
export function validateAppDefinition(input: unknown): AgentAppDefinition {
  assert(input && typeof input === 'object', 'App definition must be an object');
  assert(jsonUtf8Bytes(input) <= MAX_APP_DEFINITION_BYTES, 'App package exceeds 300 KB');
  assert(jsonUtf8Bytes(jsonExtensions(input, APP_DEFINITION_KEYS)) <= MAX_APP_DEFINITION_EXTENSION_BYTES, 'App definition extension fields exceed 64 KB');
  const d = structuredClone(input) as AgentAppDefinition;
  assert(d.sdkVersion === 1 && (APP_ID.test(d.id) || d.id === CHANNEL_APP_ID), 'Unsupported sdkVersion or invalid app id');
  assert(!['constructor', 'prototype'].includes(d.id), 'Reserved app id');
  assert(typeof d.name === 'string' && d.name.trim().length > 0 && d.name.length <= 60, 'App name is required (max 60 characters)');
  assert(Number.isSafeInteger(d.version) && d.version > 0, 'App version must be a positive integer');
  assert(typeof d.description === 'string' && d.description.length <= 1000, 'App description is required');
  assert(d.notificationHint === undefined || typeof d.notificationHint === 'string' && d.notificationHint.length <= 2000, 'notificationHint must be text (max 2000 characters)');
  assert(typeof d.icon === 'string' && d.icon.length <= 24, 'Invalid app icon');
  for (const key of ['collections', 'commands', 'views'] as const) assert(Array.isArray(d[key]) && d[key].length <= 64, `Invalid ${key}`);
  unique(d.collections, 'collection'); unique(d.commands, 'command'); unique(d.views, 'view');
  for (const collection of d.collections) {
    assert(APP_ID.test(collection.id) && typeof collection.title === 'string', 'Invalid collection');
    assert(!collection.purpose || ['mail', 'feeds', 'articles', 'messages'].includes(collection.purpose), 'Invalid collection purpose');
    assert(Array.isArray(collection.fields) && collection.fields.length > 0 && collection.fields.length <= 40, 'A collection needs 1–40 fields');
    unique(collection.fields, 'field');
    for (const field of collection.fields) {
      assert(fieldId.test(field.id) && !['constructor', 'prototype', '__proto__'].includes(field.id), 'Invalid field id');
      assert(typeof field.label === 'string' && field.label.length <= 80 && fieldKinds.has(field.type), 'Invalid field');
      if (field.type === 'select') assert(Array.isArray(field.options) && field.options.length > 0 && field.options.length <= 30 && field.options.every(x => typeof x === 'string'), 'Select fields need options');
    }
    assert(typeof collection.titleField === 'string' && collection.fields.some(f => f.id === collection.titleField), 'A collection needs a valid titleField');
    for (const key of ['subtitleField', 'bodyField'] as const) if (collection[key]) assert(collection.fields.some(f => f.id === collection[key]), `Unknown ${key}`);
  }
  const collectionIds = new Set(d.collections.map(c => c.id));
  for (const view of d.views) {
    assert(APP_ID.test(view.id) && typeof view.title === 'string' && viewKinds.has(view.kind), 'Invalid view');
    if (view.collection) assert(collectionIds.has(view.collection), 'View refers to an unknown collection');
    if (!['custom', 'operation'].includes(view.kind)) assert(view.collection, 'Data view needs a collection');
    if (view.kind === 'custom') {
      assert(typeof view.html === 'string' && view.html.length <= 120_000, 'Custom view needs bounded HTML');
      assert(!/<(?:iframe|object|embed|link|base)\b/i.test(view.html), 'Custom pages cannot embed external surfaces/styles');
      assert(/\bapp\.onPresent\s*\(/.test(view.html), 'Custom pages must implement app.onPresent for host navigation');
      assert(!/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\s*\(|\b(?:transition|animation)[\w-]*\s*:[^;}]*\d(?:\.\d+)?m?s\b/i.test(view.html), 'Custom styles must use host color and motion tokens');
    }
    assert(!view.commands || Array.isArray(view.commands) && view.commands.every(id => d.commands.some(c => c.id === id)), 'View refers to an unknown command');
  }
  assert(d.views.some(v => v.id === d.homeView), 'homeView must exist');
  for (const command of d.commands) {
    assert(APP_ID.test(command.id) && typeof command.title === 'string' && APP_HANDLERS.includes(command.handler), 'Invalid command or unsupported handler');
    if (command.handler === 'channel.run') {
      assert(d.id === CHANNEL_APP_ID && !command.collection && !command.patch && CHANNEL_APP_COMMANDS.some(id => id === command.id) && command.presentation?.viewId === d.homeView, 'Invalid built-in Channel command');
      continue;
    }
    if (command.collection) assert(collectionIds.has(command.collection), 'Command refers to an unknown collection');
    assert(command.collection, 'Commands need a collection');
    const collection = d.collections.find(c => c.id === command.collection)!;
    const capability = command.handler.startsWith('mail.') ? command.handler === 'mail.sync' || command.handler === 'mail.reply' ? 'mail.read' : 'mail.send' : command.handler.startsWith('messages.') ? command.handler === 'messages.sync' ? 'messages.read' : 'messages.send' : command.handler.startsWith('rss.') ? 'rss' : undefined;
    if (capability) assert(d.permissions?.includes(capability), `Command requires declared permission: ${capability}`);
    if (command.handler.startsWith('mail.')) assert(collection.purpose === 'mail', 'Mail commands require a mail collection');
    if (command.handler.startsWith('messages.')) assert(collection.purpose === 'messages', 'Message commands require a messages collection');
    if (command.handler.startsWith('rss.') || collection.purpose === 'feeds') assert(d.collections.some(c => c.purpose === 'feeds') && d.collections.some(c => c.purpose === 'articles') && d.commands.some(c => c.handler === 'rss.sync'), 'RSS requires feeds, articles and a sync command');
    if (command.patch) validateRecordValues(d.collections.find(c => c.id === command.collection)!, command.patch, true);
    if (command.patch) assert(command.handler === 'records.update', 'Fixed patches are only supported for record updates');
    if (command.presentation) {
      const view = d.views.find(v => v.id === command.presentation!.viewId);
      assert(view, 'Presentation view does not exist');
      assert(!view.collection || !command.collection || view.collection === command.collection, 'Presentation collection does not match command');
      assert(!command.presentation.entity || ['input.id', 'result.id'].includes(command.presentation.entity), 'Invalid presentation entity binding');
    } else {
      const view = d.views.find(v => v.collection === command.collection && v.kind !== 'form');
      if (view) command.presentation = { viewId: view.id, entity: ['records.create', 'reminders.set', 'rss.subscribe', 'mail.reply', 'messages.send'].includes(command.handler) ? 'result.id' : 'input.id' };
      else {
        let fallback = d.views.find(v => v.kind === 'operation');
        if (!fallback) { assert(!d.views.some(v => v.id === 'operation'), 'Reserved fallback view id collision'); fallback = { id: 'operation', title: '操作', kind: 'operation' }; d.views.push(fallback); }
        command.presentation = { viewId: fallback.id };
      }
    }
  }
  assert(!d.permissions || Array.isArray(d.permissions) && d.permissions.every(p => permissions.has(p)), 'Unknown app permission');
  const reachable = (command: AppCommand) => d.views.some(view => view.collection === command.collection && view.kind !== 'operation' && view.commands?.includes(command.id));
  for (const collection of d.collections) {
    const commands = d.commands.filter(command => command.collection === collection.id);
    assert(commands.some(command => command.handler === 'records.remove' && reachable(command)), `Collection ${collection.id} needs a reachable records.remove command`);
    for (const command of commands.filter(command => command.patch)) for (const key of Object.keys(command.patch!)) {
      const field = collection.fields.find(field => field.id === key)!;
      // Mail's generic editor only opens unsent drafts, so it cannot restore inbox/sent state.
      const editable = collection.purpose !== 'mail' && !field.readOnly && commands.some(other => other.handler === 'records.update' && !other.patch && reachable(other));
      // A different arbitrary text/number value does not restore the previous value.
      // Multi-field state actions need a complete opposite boolean vector, not partial toggles.
      const inverse = commands.some(other => other !== command && other.patch && reachable(other) && Object.entries(command.patch!).every(([field, fixed]) => typeof fixed === 'boolean' && other.patch![field] === !fixed));
      assert(reachable(command) && (editable || inverse), `Collection ${collection.id} command ${command.id} needs a reachable reverse operation for ${key}`);
    }
  }
  return d;
}

export function validateRecordValues(collection: AppCollection, input: unknown, partial = false, trusted = false): AppValues {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'values must be an object');
  const values = input as AppValues;
  assert(jsonUtf8Bytes(values) <= MAX_APP_RECORD_VALUE_BYTES, 'Record exceeds 256 KB');
  for (const key of Object.keys(values)) assert(collection.fields.some(f => f.id === key), `Unknown field: ${key}`);
  if (values.notificationHint !== undefined) assert(typeof values.notificationHint === 'string' && values.notificationHint.length <= 2000, 'notificationHint must be text (max 2000 characters)');
  for (const f of collection.fields) {
    const v = values[f.id];
    if (v === undefined) { assert(partial || !f.required, `Required field: ${f.label}`); continue; }
    assert(trusted || !f.readOnly, `Read-only field: ${f.label}`);
    if (v === null) { assert(!f.required, `Required field: ${f.label}`); continue; }
    if (f.type === 'number') assert(typeof v === 'number' && Number.isFinite(v), `Invalid number: ${f.label}`);
    else if (f.type === 'boolean') assert(typeof v === 'boolean', `Invalid boolean: ${f.label}`);
    else {
      assert(typeof v === 'string' && (!f.required || v.trim().length > 0), `Invalid text: ${f.label}`);
      if (f.type === 'select') assert(f.options!.includes(v), `Invalid option: ${f.label}`);
      if (f.type === 'datetime' && v) assert(Number.isFinite(Date.parse(v)), `Invalid time: ${f.label}`);
      if (f.type === 'url' && v) assert(/^https?:\/\//i.test(v), 'Only HTTP(S) URLs are supported');
      if (f.type === 'image' && v) assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v), 'Invalid image asset identity');
    }
  }
  return { ...values };
}

/** SDK factory: arbitrary app identities get working CRUD, forms and presentation bindings. */
export function defineRecordApp(input: { id: string; name: string; icon?: string; description?: string; fields: AppField[]; titleField: string; bodyField?: string }): AgentAppDefinition {
  return validateAppDefinition({ sdkVersion: 1, id: input.id, name: input.name, icon: input.icon ?? '▤', description: input.description ?? input.name, version: 1,
    collections: [{ id: 'items', title: input.name, fields: input.fields, titleField: input.titleField, bodyField: input.bodyField }],
    commands: ['list', 'get', 'create', 'update', 'remove'].map(action => ({ id: action, title: ({ list: '查看列表', get: '查看详情', create: '新增', update: '编辑', remove: '删除' } as Record<string,string>)[action], handler: `records.${action}`, collection: 'items' })),
    views: [{ id: 'main', title: input.name, kind: 'list', collection: 'items', commands: ['create', 'update', 'remove'] }], homeView: 'main' });
}
