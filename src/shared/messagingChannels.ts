/** Public desktop and App projections. Native routing evidence stays in the main process. */
import type { AppConnectionNamePlaceholder, AppPlaceholderFields } from './agentApps';
export type LogicalChannelPermission = 'read' | 'reply';
export type LogicalChannelNotify = 'digest' | 'wake' | 'mute';

export type LogicalChannelRemoteTarget =
  | { kind: 'scheduler' }
  | { kind: 'gui' | 'pty'; sessionId: string };

export type LogicalChannelRemoteTargetChoice = LogicalChannelRemoteTarget & { label: string };
export type LogicalChannelRemoteAccess = { kind: 'workbench' };

export interface LogicalChannelRemoteStatus {
  ready: boolean;
  binding: { code: string; expiresAt: number } | null;
  boundUsers: { id: string; label: string; boundAt: number }[];
}

export interface LogicalChannelSource {
  id: string;
  provider: string;
  botId: string;
  conversationId: string;
  threadId?: string;
  conversationType: 'direct' | 'group';
  label: string;
  connected: boolean;
  lastSeenAt: number;
  canSend: boolean;
  canRemote: boolean;
  legacyNamePlaceholder?: AppConnectionNamePlaceholder;
  /** Desktop provenance for a connection kept in a pre-Channel workspace store. */
  legacyOwnerWorkspaceId?: string;
}

export interface LogicalChannelSourceGrant {
  sourceId: string;
  permission: LogicalChannelPermission;
  notify: LogicalChannelNotify | null;
  source: LogicalChannelSource;
  remoteTarget: LogicalChannelRemoteAccess | null;
  remote: LogicalChannelRemoteStatus | null;
}

export interface LogicalChannel {
  id: string;
  name: string;
  notify: LogicalChannelNotify;
  sources: LogicalChannelSourceGrant[];
}

export type LogicalChannelCatalogEntry = Pick<LogicalChannel, 'id' | 'name'> & { sourceCount: number; bound: boolean };
export type LogicalChannelLegacyAccess = { originalSourceId: string; permission: LogicalChannelPermission; notify: LogicalChannelNotify };
export type LogicalChannelLegacyNotice = {
  eventId: string;
  committedAt: number;
  messages: { sourceId: string; messageId: string; ownerMuted?: boolean }[];
};

export interface LogicalChannelMessage {
  id: string;
  channelId: string;
  sourceId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  senderLabel: string;
  createdAt: number;
  subject?: string;
  replyToId?: string;
  status: 'received' | 'submitted' | 'sent' | 'failed' | 'unknown' | 'draft';
  read: boolean;
  processed: boolean;
  reason?: string;
  remoteHandled?: boolean;
  /** One live notification owner per workspace/source event, including when linked by several Channels. */
  notificationOwner?: boolean;
  recipient?: string;
  revision?: number;
  attachments?: string;
  legacyPlaceholderFields?: AppPlaceholderFields;
}

export interface LogicalChannelMessagePage {
  messages: LogicalChannelMessage[];
  nextCursor: string | null;
}

export interface LogicalChannelMessageQuery {
  after?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  sourceId?: string;
  search?: string;
  unread?: boolean;
  processed?: boolean;
  drafts?: boolean;
  /** Host App notification polling. Native and legacy references each have an arrival cursor. */
  notifications?: boolean | 'legacy';
}

export interface LogicalChannelMessageStateInput {
  workspaceId: string;
  channelId: string;
  messageId: string;
  read?: boolean;
  processed?: boolean;
}

export interface LogicalChannelReplyInput {
  workspaceId: string;
  channelId: string;
  messageId: string;
  text: string;
  requestId: string;
}

export interface LogicalChannelSendInput {
  workspaceId: string;
  channelId: string;
  sourceId: string;
  text: string;
  requestId: string;
  subject?: string;
  recipient?: string;
  draftId?: string;
}

export interface LogicalChannelDraftInput {
  workspaceId: string;
  channelId: string;
  sourceId: string;
  text: string;
  recipient: string;
  subject: string;
  draftId?: string;
  expectedRevision?: number;
}

export interface LogicalChannelDiagnostics {
  received: number;
  remoteHandled: number;
  sent: number;
  failed: number;
  unknown: number;
  stages: Record<LogicalChannelStage, number>;
  lastStage?: { stage: LogicalChannelStage; at: number; reason?: string; sourceId?: string };
  lastMessage?: LogicalChannelMessage;
}

export type LogicalChannelStage = 'receive' | 'authorized' | 'routed' | 'reply' | 'failure';
export type LogicalChannelChange = { workspaceId: string; channelId: string; messageId?: string; kind: 'message' | 'state' | 'channel' };

export type LogicalChannelLegacyMessageQuery = Omit<LogicalChannelMessageQuery, 'after' | 'sourceId'> & {
  after?: { createdAt: number; id: string };
};

/** Host-only delegation. Existing mailbox credentials and records stay in their workspace store. */
export interface LogicalChannelLegacyAdapter {
  listSources(workspaceId: string): Promise<(LogicalChannelSource & {
    legacyDefault?: { name: string; permission: LogicalChannelPermission; notify: LogicalChannelNotify };
  })[]>;
  listMessages(workspaceId: string, channelId: string, sourceId: string, query: LogicalChannelLegacyMessageQuery): Promise<LogicalChannelMessage[]>;
  getMessage(workspaceId: string, channelId: string, sourceId: string, messageId: string): Promise<(LogicalChannelMessage & { legacyOwnerMuted?: boolean }) | undefined>;
  send(input: LogicalChannelSendInput, signal?: AbortSignal): Promise<LogicalChannelMessage>;
  reply(input: LogicalChannelReplyInput & { sourceId: string }, signal?: AbortSignal): Promise<LogicalChannelMessage>;
  setMessageState(input: LogicalChannelMessageStateInput & { sourceId: string }): Promise<LogicalChannelMessage>;
  saveDraft?(input: LogicalChannelDraftInput, signal?: AbortSignal): Promise<LogicalChannelMessage>;
}

/** Operations routed through the desktop-only messaging IPC under the `channels` namespace. */
export type LogicalChannelMethod =
  | 'list' | 'get' | 'create' | 'update' | 'remove'
  | 'bindings.list' | 'bindings.add' | 'bindings.remove'
  | 'sources.list' | 'sources.add' | 'sources.update' | 'sources.remove'
  | 'messages.list' | 'messages.reply' | 'messages.send' | 'messages.state' | 'messages.saveDraft'
  | 'remote.begin' | 'remote.status' | 'remote.revoke' | 'diagnostics';
