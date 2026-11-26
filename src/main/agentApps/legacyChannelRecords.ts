import type { AppConnection, AppRecord } from '../../shared/agentApps';
import type { LogicalChannelLegacyMessageQuery, LogicalChannelMessage, LogicalChannelSource } from '../../shared/messagingChannels';
import type { AppWorkspaceState } from './store';

export const LEGACY_MAIL_HISTORY = 'legacy:!mail';
export const LEGACY_FEISHU_HISTORY = 'legacy:!messages';
export const legacySourceId = (id: string): string => `legacy:${id}`;
export const legacyMessageId = (appId: 'mail' | 'messages', id: string): string => `legacy:${appId}:${id}`;
export const legacyAppId = (connection: AppConnection): 'mail' | 'messages' => connection.kind === 'imap-smtp' ? 'mail' : 'messages';

function connectionSource(conn: AppConnection, send: boolean): LogicalChannelSource {
  return { id: legacySourceId(conn.id), provider: conn.kind === 'imap-smtp' ? 'email' : 'feishu', botId: conn.id,
    conversationId: conn.kind === 'feishu' ? conn.chatId : conn.id, conversationType: conn.kind === 'imap-smtp' ? 'direct' : 'group',
    label: conn.name, legacyNamePlaceholder: conn.namePlaceholder, connected: conn.enabled, canSend: conn.enabled && send, canRemote: false, lastSeenAt: conn.lastSyncAt ?? 0 };
}

export function legacySources(state: AppWorkspaceState) {
  const installed = (appId: string) => state.installations.find(item => item.definition.id === appId);
  const sources = state.connections.flatMap(conn => {
    const appId = legacyAppId(conn);
    const app = installed(appId);
    if (!app) return [];
    const grants = conn.grants[appId] ?? [];
    const read = grants.includes(`${appId}.read`), send = grants.includes(`${appId}.send`);
    if (!read && !send) return [];
    return [{ ...connectionSource(conn, send && app.enabled), connected: conn.enabled && app.enabled,
      canRemote: read && app.enabled && conn.enabled && conn.kind === 'feishu' && conn.identity === 'bot' && !!conn.profile?.startsWith('muster-phone-'),
      legacyDefault: { name: conn.name, permission: send ? 'reply' as const : 'read' as const, notify: conn.notify ?? 'wake' } }];
  });
  for (const [appId, id, label, provider] of [['mail', LEGACY_MAIL_HISTORY, '旧邮箱记录', 'email'], ['messages', LEGACY_FEISHU_HISTORY, '旧飞书消息', 'feishu']] as const) {
    if (!installed(appId) || !legacyRecordsForSource(state, id).records.length) continue;
    sources.push({ id, provider, botId: id, conversationId: id, conversationType: 'direct', label, connected: false, canSend: false,
      canRemote: false, lastSeenAt: 0, legacyDefault: { name: label, permission: 'read', notify: 'mute' } });
  }
  return sources;
}

export function legacyRecordsForSource(state: AppWorkspaceState, sourceId: string): { appId: 'mail' | 'messages'; connection?: AppConnection; records: AppRecord[] } {
  const connection = state.connections.find(conn => legacySourceId(conn.id) === sourceId);
  const appId = connection ? legacyAppId(connection) : sourceId === LEGACY_MAIL_HISTORY ? 'mail' : 'messages';
  if (!connection && sourceId !== LEGACY_MAIL_HISTORY && sourceId !== LEGACY_FEISHU_HISTORY) return { appId, records: [] };
  const oldConnectionIds = new Set(state.connections.map(conn => conn.id));
  const records = (state.records[appId] ?? []).filter(record => {
    const accountId = record.origin?.connectionId ?? record.values.accountId;
    return connection ? accountId === connection.id : typeof accountId !== 'string' || !oldConnectionIds.has(accountId);
  });
  return { appId, records, connection };
}

export function projectLegacyMessage(channelId: string, sourceId: string, appId: 'mail' | 'messages', record: AppRecord): LogicalChannelMessage {
  const values = record.values;
  const direction = values.mine === true || values.folder === 'sent' || values.folder === 'drafts' ? 'outbound' : 'inbound';
  const status = values.status === 'uncertain' ? 'unknown' : values.status === 'sending' ? 'submitted' : values.status === 'draft' || values.folder === 'drafts' && !values.status ? 'draft' : direction === 'outbound' ? 'sent' : 'received';
  const date = typeof values.date === 'string' ? Date.parse(values.date) : Number.NaN;
  return { id: legacyMessageId(appId, record.id), channelId, sourceId, direction, status, text: String(values.body ?? ''),
    senderLabel: String(values.sender ?? values.from ?? ''), read: values.read === true, processed: values.processed === true,
    createdAt: Number.isFinite(date) ? date : record.createdAt, subject: typeof values.subject === 'string' ? values.subject : undefined,
    recipient: typeof values.to === 'string' ? values.to : undefined, attachments: typeof values.attachments === 'string' ? values.attachments : undefined,
    revision: record.revision, legacyPlaceholderFields: record.placeholderFields };
}

export function filterLegacyMessages(messages: LogicalChannelMessage[], query: LogicalChannelLegacyMessageQuery): LogicalChannelMessage[] {
  const search = query.search?.toLocaleLowerCase().trim();
  const direction = query.order === 'asc' ? 1 : -1;
  const compare = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number => direction * (a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return messages.filter(message => (query.drafts === true ? message.status === 'draft' : message.status !== 'draft')
    && (query.unread === undefined || (message.direction === 'inbound' && !message.read) === query.unread)
    && (query.processed === undefined || message.processed === query.processed)
    && (!search || [message.text, message.subject, message.senderLabel, message.recipient].some(value => value?.toLocaleLowerCase().includes(search)))
    && (!query.after || compare(message, query.after) > 0)).sort(compare).slice(0, query.limit ?? 40);
}
