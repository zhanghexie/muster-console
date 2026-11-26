import type { CredentialRef } from './state/credentialRefs';

export type { CredentialRef } from './state/credentialRefs';

export type MessagingAccountRef = Readonly<{ channelKey: string; botId: string }>;

/** Host-only account configuration. Public connection snapshots do not expose this record. */
export type MessagingAccountConfig = MessagingAccountRef & Readonly<{
  displayName: string;
  enabled: boolean;
  credentialRef: CredentialRef;
  workspaceId?: string;
}>;

export type ConversationAddress = MessagingAccountRef & Readonly<{
  conversationId: string;
  threadId?: string;
}>;

export type ChannelInboundCapability = 'text' | 'image' | 'file' | 'audio';
export type ChannelOutboundCapability = 'text' | 'rich-text' | 'image' | 'file' | 'card' | 'typing' | 'reaction';
export type ChannelLimits = Readonly<{ maxTextLength?: number; maxAttachmentBytes?: number }>;

export type ChannelDescriptor = Readonly<{
  channelKey: string;
  displayName: string;
  connection: 'polling' | 'socket' | 'webhook' | 'local';
  inbound: readonly ChannelInboundCapability[];
  /** Adapter support. The connected account may still lack permissions. */
  outbound: readonly ChannelOutboundCapability[];
  defaultTriggers: Readonly<{ direct: 'allowlist' | 'off'; group: 'mention' | 'off' | 'all' }>;
  limits: ChannelLimits;
  documentationUrl?: string;
}>;

export type NormalizedAttachment = Readonly<{
  platformFileId: string;
  mimeType?: string;
  sizeBytes?: number;
  resourceRef?: string;
}>;

/** Host-only projection from an authenticated transport. Deliberately contains no raw event. */
export type NormalizedInboundMessage = ConversationAddress & Readonly<{
  eventKind?: 'message';
  messageId: string;
  conversationType: 'direct' | 'group';
  senderId: string;
  senderDisplayName?: string;
  senderIsBot: boolean;
  plainText: string;
  replyTo?: string;
  attachments?: readonly NormalizedAttachment[];
  /** Addressed to this bot, including an adapter-verified reply to the bot. */
  addressed: boolean;
  mentioned?: boolean;
  sourceTimestamp?: number;
  /** Stable source event ID. Without an explicit ID, messageId must be unique in the declared scope. */
  idempotencyKey?: string;
  idempotencyScope?: 'account' | 'conversation' | 'thread';
}>;

export type MessagingAccessPolicy = Readonly<{
  allowedSenderIds: readonly string[];
  direct: ChannelDescriptor['defaultTriggers']['direct'];
  group: ChannelDescriptor['defaultTriggers']['group'];
}>;

export type ConversationTarget = ConversationAddress & Readonly<{
  workspaceId: string;
  sessionId: string;
  revision: string;
}>;

export type ConversationBinding = ConversationTarget & Readonly<{
  access: MessagingAccessPolicy;
  lastActivityAt?: number;
}>;

/** Stable reply address for a turn. Capture before dispatch so a later rebind cannot reroute it. */
export type MessageOrigin = ConversationAddress & Readonly<{ messageId: string }>;

export type SessionSubmission = Readonly<{
  requestId: string;
  intent: 'external-message';
  actor: 'remote-human';
  origin: MessageOrigin;
  binding: ConversationTarget;
  message: NormalizedInboundMessage;
}>;

export type SessionSubmissionResult =
  | Readonly<{ status: 'accepted'; turnId: string }>
  | Readonly<{ status: 'rejected' | 'retryable' | 'unknown' }>;

export interface SessionAdapter {
  /** Submit literal user content without parsing local host commands. Only return retryable for known non-admission. */
  submit(input: SessionSubmission): Promise<SessionSubmissionResult>;
}

export type InboundReceipt = Readonly<{
  requestId: string;
  origin: MessageOrigin;
  binding: ConversationTarget;
  status: 'queued' | 'dispatching' | 'accepted' | 'rejected' | 'retryable' | 'unknown';
  updatedAt: number;
  turnId?: string;
}>;

export type ConversationRouteResult =
  | Readonly<{ status: 'ignored'; reason: 'invalid-message' | 'bot' | 'closing' | 'account-disabled' | 'unbound' | 'forbidden' | 'not-addressed' | 'binding-changed' }>
  | Readonly<{ status: 'backpressure'; limit: 'conversation' | 'router' | 'receipts' }>
  | Readonly<{ status: 'state-unavailable' }>
  | Readonly<{ status: 'duplicate'; receipt: InboundReceipt }>
  | Readonly<{ status: 'accepted'; requestId: string; turnId: string }>
  | Readonly<{ status: 'rejected' | 'retryable' | 'unknown'; requestId: string }>;

export type ChannelDeliveryRequest = Readonly<{ origin: MessageOrigin }> & (
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'rich-text'; markdown: string; editMessageId?: string }>
  | Readonly<{ kind: 'image' | 'file'; resourceRef: string }>
  | Readonly<{ kind: 'card'; templateId: string; values: Readonly<Record<string, string>> }>
  | Readonly<{ kind: 'typing'; active: boolean }>
  | Readonly<{ kind: 'reaction'; reaction: string; active: boolean }>
);

export type ChannelDeliveryResult =
  | Readonly<{ status: 'sent'; messageId?: string }>
  /** A timeout with an indeterminate delivery outcome must be reported as unknown. */
  | Readonly<{ status: 'rejected' | 'timeout' | 'unknown' | 'unsupported' }>;

export interface ChannelDeliveryClient {
  deliver(request: ChannelDeliveryRequest, signal: AbortSignal): Promise<ChannelDeliveryResult>;
  limits(target: ConversationAddress, signal: AbortSignal): Promise<ChannelLimits>;
}

export function isMessagingId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && value.trim().length > 0 && !value.includes('\0');
}

export function messagingAccountKey(account: MessagingAccountRef): string {
  return JSON.stringify([account.channelKey, account.botId]);
}

export function conversationKey(address: ConversationAddress): string {
  return JSON.stringify([address.channelKey, address.botId, address.conversationId, address.threadId ?? null]);
}

export function inboundMessageKey(message: NormalizedInboundMessage): string {
  const scope = message.idempotencyScope ?? 'conversation';
  return JSON.stringify([
    message.channelKey,
    message.botId,
    message.eventKind ?? 'message',
    scope,
    scope === 'account' ? null : message.conversationId,
    scope === 'thread' ? message.threadId ?? null : null,
    message.idempotencyKey ?? message.messageId
  ]);
}

export function accessDenial(policy: MessagingAccessPolicy, message: NormalizedInboundMessage): 'forbidden' | 'not-addressed' | undefined {
  if (!policy.allowedSenderIds.includes(message.senderId)) return 'forbidden';
  const mode = message.conversationType === 'direct' ? policy.direct : policy.group;
  if (mode === 'off') return 'forbidden';
  if (mode === 'mention' && !message.addressed) return 'not-addressed';
}
