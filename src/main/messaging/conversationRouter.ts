import {
  accessDenial, conversationKey, isMessagingId,
  type ConversationRouteResult, type InboundReceipt,
  type NormalizedAttachment, type NormalizedInboundMessage,
  type SessionAdapter, type SessionSubmissionResult
} from './contracts';
import type { ConversationStateStore } from './state/conversationStateStore';

export { conversationKey } from './contracts';

type RouterOptions = Readonly<{ maxPerConversation?: number; maxPending?: number; now?: () => number }>;
type Queue = { tail: Promise<void>; pending: number };

const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_ATTACHMENTS = 16;

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function attachmentSnapshot(attachment: NormalizedAttachment): NormalizedAttachment | undefined {
  if (!attachment) return undefined;
  const { platformFileId, mimeType, sizeBytes, resourceRef } = attachment;
  if (!isMessagingId(platformFileId) || (mimeType !== undefined && !isMessagingId(mimeType)) ||
      (sizeBytes !== undefined && !validTimestamp(sizeBytes)) || (resourceRef !== undefined && !isMessagingId(resourceRef))) return undefined;
  return Object.freeze({ platformFileId, mimeType, sizeBytes, resourceRef });
}

/** Snapshot normalized fields and drop any platform payload attached by a caller. */
function messageSnapshot(input: NormalizedInboundMessage): NormalizedInboundMessage | undefined {
  if (!input) return undefined;
  const {
    channelKey, botId, conversationId, threadId, eventKind, messageId, conversationType, senderId, senderDisplayName,
    senderIsBot, plainText, replyTo, attachments, addressed, mentioned, sourceTimestamp, idempotencyKey, idempotencyScope
  } = input;
  if (![channelKey, botId, conversationId, messageId, senderId].every(isMessagingId) ||
      [threadId, senderDisplayName, replyTo, idempotencyKey].some(value => value !== undefined && !isMessagingId(value)) ||
      (eventKind !== undefined && eventKind !== 'message') ||
      (conversationType !== 'direct' && conversationType !== 'group') ||
      typeof senderIsBot !== 'boolean' || typeof addressed !== 'boolean' ||
      (mentioned !== undefined && typeof mentioned !== 'boolean') ||
      (sourceTimestamp !== undefined && !validTimestamp(sourceTimestamp)) ||
      (idempotencyScope !== undefined && !['account', 'conversation', 'thread'].includes(idempotencyScope)) ||
      typeof plainText !== 'string' || plainText.length > MAX_TEXT_LENGTH) return undefined;
  let projectedAttachments: NormalizedAttachment[] | undefined;
  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) return undefined;
    projectedAttachments = [];
    for (const attachment of attachments) {
      const projected = attachmentSnapshot(attachment);
      if (!projected) return undefined;
      projectedAttachments.push(projected);
    }
  }
  return Object.freeze({
    channelKey, botId, conversationId, threadId, eventKind, messageId, conversationType, senderId, senderDisplayName,
    senderIsBot, plainText, replyTo, attachments: projectedAttachments && Object.freeze(projectedAttachments), addressed,
    mentioned, sourceTimestamp, idempotencyKey, idempotencyScope
  });
}

export class ConversationRouter {
  private readonly queues = new Map<string, Queue>();
  private accepting = true;
  private pending = 0;
  private readonly maxPerConversation: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(
    private readonly store: ConversationStateStore,
    private readonly session: SessionAdapter,
    options: RouterOptions = {}
  ) {
    this.maxPerConversation = options.maxPerConversation ?? 32;
    this.maxPending = options.maxPending ?? 512;
    this.now = options.now ?? Date.now;
    if (![this.maxPerConversation, this.maxPending].every(limit => Number.isSafeInteger(limit) && limit > 0)) {
      throw new Error('Invalid messaging queue limits');
    }
  }

  async accept(input: NormalizedInboundMessage): Promise<ConversationRouteResult> {
    if (!this.accepting) return { status: 'ignored', reason: 'closing' };
    const message = messageSnapshot(input);
    if (!message) return { status: 'ignored', reason: 'invalid-message' };
    if (message.senderIsBot) return { status: 'ignored', reason: 'bot' };
    const key = conversationKey(message);
    const existing = this.queues.get(key);
    const limit = this.pending >= this.maxPending ? 'router'
      : existing && existing.pending >= this.maxPerConversation ? 'conversation' : undefined;
    let admission;
    try {
      if (!this.store.getAccount(message)?.enabled) return { status: 'ignored', reason: 'account-disabled' };
      const binding = this.store.getBinding(message);
      if (!binding) return { status: 'ignored', reason: 'unbound' };
      const denial = accessDenial(binding.access, message);
      if (denial) return { status: 'ignored', reason: denial };
      admission = this.store.reserveInbound(message, binding, this.now(), limit);
    } catch {
      return { status: 'state-unavailable' };
    }
    if (admission.status === 'account-disabled' || admission.status === 'binding-changed') {
      return { status: 'ignored', reason: admission.status };
    }
    if (admission.status === 'backpressure') return admission;
    if (admission.status === 'duplicate') return { status: 'duplicate', receipt: admission.receipt };

    const queue = existing ?? { tail: Promise.resolve(), pending: 0 };
    queue.pending += 1;
    this.pending += 1;
    this.queues.set(key, queue);
    const work = queue.tail.then(() => this.dispatch(message, admission.receipt));
    const release = () => {
      this.pending -= 1;
      queue.pending -= 1;
      if (queue.pending === 0) this.queues.delete(key);
    };
    queue.tail = work.then(release, release);
    return work;
  }

  private async dispatch(message: NormalizedInboundMessage, receipt: InboundReceipt): Promise<ConversationRouteResult> {
    const { requestId } = receipt;
    try {
      const now = this.now();
      if (!this.accepting) {
        this.store.returnQueuedForRetry(requestId, now);
        return { status: 'retryable', requestId };
      }
      const outcome = this.store.beginDispatch(message, requestId, now);
      if (outcome !== 'dispatching') return { status: 'ignored', reason: outcome };
    } catch {
      return { status: 'state-unavailable' };
    }
    let result: SessionSubmissionResult = { status: 'unknown' };
    try {
      const submitted = await this.session.submit(Object.freeze({
        requestId, intent: 'external-message', actor: 'remote-human', origin: Object.freeze({ ...receipt.origin }),
        binding: Object.freeze({ ...receipt.binding }), message
      }));
      if (submitted.status === 'accepted' && isMessagingId(submitted.turnId)) {
        result = { status: 'accepted', turnId: submitted.turnId };
      } else if (submitted.status === 'rejected' || submitted.status === 'retryable') {
        result = { status: submitted.status };
      }
    } catch {
      // A thrown adapter error cannot establish that the host did not receive the request.
    }
    try {
      this.store.finishDispatch(requestId, result, this.now());
    } catch {
      return { status: 'unknown', requestId };
    }
    return { ...result, requestId };
  }

  stopAdmission(): void {
    this.accepting = false;
  }

  async stopAndWait(): Promise<void> {
    this.stopAdmission();
    await Promise.all(Array.from(this.queues.values(), queue => queue.tail));
  }
}
