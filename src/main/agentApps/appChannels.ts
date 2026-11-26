import type { AppCallResult } from '../../shared/agentApps';
import type { LogicalChannel, LogicalChannelCatalogEntry, LogicalChannelDraftInput, LogicalChannelLegacyAccess, LogicalChannelLegacyNotice, LogicalChannelMessage, LogicalChannelMessagePage, LogicalChannelMessageQuery, LogicalChannelMessageStateInput, LogicalChannelReplyInput, LogicalChannelSendInput } from '../../shared/messagingChannels';
import type { AgentAppsOptions, AppActor } from './service';

export interface AppChannelHost {
  catalog(workspaceId: string, signal?: AbortSignal): Promise<LogicalChannelCatalogEntry[]>;
  bindChannel(workspaceId: string, channelId: string, bound: boolean, signal?: AbortSignal): void | Promise<void>;
  legacyAccess(workspaceId: string, signal?: AbortSignal): Promise<LogicalChannelLegacyAccess[]>;
  captureLegacyNotices(workspaceId: string, notice: LogicalChannelLegacyNotice, signal?: AbortSignal): Promise<void>;
  listChannels(workspaceId: string, signal?: AbortSignal): Promise<LogicalChannel[]>;
  listMessages(workspaceId: string, channelId: string, query?: LogicalChannelMessageQuery, signal?: AbortSignal): Promise<LogicalChannelMessagePage>;
  getMessage(workspaceId: string, channelId: string, messageId: string, signal?: AbortSignal): Promise<LogicalChannelMessage | undefined>;
  reply(input: LogicalChannelReplyInput, signal?: AbortSignal): Promise<LogicalChannelMessage>;
  send(input: LogicalChannelSendInput, signal?: AbortSignal): Promise<LogicalChannelMessage>;
  setMessageState(input: LogicalChannelMessageStateInput): Promise<LogicalChannelMessage>;
  saveDraft(input: LogicalChannelDraftInput, signal?: AbortSignal): Promise<LogicalChannelMessage>;
}

function stringParam(value: unknown, label: string, max = 512, empty = false): string {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}
const preview = ({ attachments: _attachments, ...message }: LogicalChannelMessage): LogicalChannelMessage => ({ ...message, text: message.text.slice(0, 600) });

export async function runChannelApp(options: Pick<AgentAppsOptions, 'channels' | 'confirmSend'>, workspaceId: string, command: string, params: Record<string, unknown>, requestId: string | undefined, actor: AppActor): Promise<AppCallResult> {
  actor.signal?.throwIfAborted();
  const host = options.channels;
  if (!host) throw new Error('Channel service is unavailable');
  if (command === 'catalog') return { channelCatalog: await host.catalog(workspaceId, actor.signal) };
  if (command === 'bind' || command === 'unbind') {
    if (actor.kind === 'background') throw new Error('Background jobs cannot change Channel bindings');
    await host.bindChannel(workspaceId, stringParam(params.channelId, 'Channel id'), command === 'bind', actor.signal);
    return { status: command === 'bind' ? 'bound' : 'unbound' };
  }
  if (command === 'channels') return { channels: (await host.listChannels(workspaceId, actor.signal)).map(channel => ({ ...channel,
    sources: channel.sources.map(grant => ({ ...grant, remote: null, remoteTarget: null })) })) };
  if (command === 'search') {
    const search = stringParam(params.search, 'search', 200).trim();
    const limit = actor.kind === 'agent' ? 12 : 40;
    const results: LogicalChannelMessage[] = [];
    const channels = await host.listChannels(workspaceId, actor.signal);
    let more = false;
    for (let offset = 0; offset < channels.length; offset += 6) {
      actor.signal?.throwIfAborted();
      const pages = await Promise.all(channels.slice(offset, offset + 6).map(async channel => {
        try { return await host.listMessages(workspaceId, channel.id, { search, limit, order: 'desc' }, actor.signal); }
        catch (error) { if (!(error instanceof Error) || !['channel-not-found', 'channel-not-bound'].includes(error.message)) throw error; }
      }));
      for (const page of pages) if (page) { results.push(...page.messages.map(preview)); more ||= page.nextCursor !== null; }
      results.sort((left, right) => right.createdAt - left.createdAt || left.channelId.localeCompare(right.channelId) || left.id.localeCompare(right.id));
      if (results.length > limit) { results.length = limit; more = true; }
    }
    return { channelMessages: { messages: results, nextCursor: null }, searchLimited: more };
  }
  const channelId = stringParam(params.channelId, 'Channel id');
  if (command === 'list') {
    const query: LogicalChannelMessageQuery = {};
    if (params.limit !== undefined) {
      if (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1) throw new Error('Invalid message limit');
      query.limit = Math.min(Number(params.limit), actor.kind === 'agent' ? 12 : 50);
    } else query.limit = actor.kind === 'agent' ? 8 : 40;
    if (params.order !== undefined) {
      if (params.order !== 'asc' && params.order !== 'desc') throw new Error('Invalid message order');
      query.order = params.order;
    }
    for (const key of ['search', 'after', 'sourceId'] as const) if (params[key] !== undefined) query[key] = stringParam(params[key], key, key === 'search' ? 200 : 4096, key === 'search');
    for (const key of ['unread', 'processed', 'drafts'] as const) if (params[key] !== undefined) {
      if (typeof params[key] !== 'boolean') throw new Error(`Invalid ${key}`);
      query[key] = params[key];
    }
    const page = await host.listMessages(workspaceId, channelId, query, actor.signal);
    return { channelMessages: actor.kind === 'agent' ? { ...page, messages: page.messages.map(preview) } : page };
  }
  if (command === 'save-draft') {
    if (params.expectedRevision !== undefined && (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 1)) throw new Error('Invalid draft revision');
    return { channelMessage: await host.saveDraft({ workspaceId, channelId, sourceId: stringParam(params.sourceId, 'source id'),
      text: stringParam(params.text ?? '', 'body', 20_000, true), recipient: stringParam(params.recipient ?? '', 'recipient', 1000, true), subject: stringParam(params.subject ?? '', 'subject', 1000, true),
      draftId: params.draftId === undefined ? undefined : stringParam(params.draftId, 'draft id'), expectedRevision: params.expectedRevision as number | undefined }, actor.signal) };
  }
  if (command === 'send' || command === 'reply') {
    if (actor.kind === 'background') throw new Error('Background jobs cannot send external messages');
    const text = stringParam(params.text, 'body', 20_000, command === 'send' && params.draftId !== undefined);
    const sendId = stringParam(requestId, 'requestId', 128);
    const reply = command === 'reply';
    const messageId = reply ? stringParam(params.messageId, 'message id') : undefined;
    const original = messageId ? await host.getMessage(workspaceId, channelId, messageId, actor.signal) : undefined;
    if (messageId && !original) throw new Error('Message not found');
    const sourceId = original?.sourceId ?? stringParam(params.sourceId, 'source id');
    const recipient = params.recipient === undefined ? undefined : stringParam(params.recipient, 'recipient', 1000);
    const subject = params.subject === undefined ? undefined : stringParam(params.subject, 'subject', 1000, true);
    const draftId = params.draftId === undefined ? undefined : stringParam(params.draftId, 'draft id');
    if (actor.kind === 'agent' && !await options.confirmSend(workspaceId, 'Channel', { accountId: sourceId.replace(/^legacy:/, ''), body: text, to: original?.senderLabel ?? recipient ?? sourceId, subject: original?.subject ?? subject ?? '' }, actor.signal)) throw new Error('Sending cancelled; no message submitted');
    actor.signal?.throwIfAborted();
    return { channelMessage: reply
      ? await host.reply({ workspaceId, channelId, messageId: messageId!, text, requestId: sendId }, actor.signal)
      : await host.send({ workspaceId, channelId, sourceId, text, requestId: sendId, recipient, subject, draftId }, actor.signal) };
  }
  const messageId = stringParam(params.messageId, 'message id');
  if (command === 'get') {
    const message = await host.getMessage(workspaceId, channelId, messageId, actor.signal);
    if (!message) throw new Error('Message not found');
    return { channelMessage: message };
  }
  if (command === 'state') {
    if ([params.read, params.processed].every(v => v === undefined) || [params.read, params.processed].some(v => v !== undefined && typeof v !== 'boolean')) throw new Error('Pass a read or processed boolean');
    return { channelMessage: await host.setMessageState({ workspaceId, channelId, messageId, read: params.read as boolean | undefined, processed: params.processed as boolean | undefined }) };
  }
  throw new Error('Unknown Channel command');
}
