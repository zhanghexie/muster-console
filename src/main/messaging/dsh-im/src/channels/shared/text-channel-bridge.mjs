import { createChannelIngress } from './channel-ingress.mjs';
import { t } from './i18n.mjs';
import { sendRememberedConnectionTest } from './connection-test.mjs';
import { createTextDeliveryBlock } from './semantic/delivery.mjs';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createTextBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    lastMessageError: null,
    reactionsAdded: 0,
    reactionsRemoved: 0,
    reactionErrors: 0,
  };
}

// Use the message body when a provider adds display metadata to the content.
function controlTextOf(message) {
  return cleanText(message?.controlText ?? message?.content);
}

export class TextChannelBridge {
  #descriptor;
  #bot;
  #state;
  #status;
  #signal;
  #ingress;

  constructor({ descriptor, bot, receiveChannelMessage, state, status = createTextBridgeStatus(), signal }) {
    if (!descriptor?.key || !descriptor?.label || typeof bot?.sendText !== 'function' || !state) throw new TypeError('Channel bridge dependencies are required');
    this.#descriptor = descriptor;
    this.#bot = bot;
    this.#state = state;
    this.#status = status;
    this.#signal = signal;
    this.#ingress = createChannelIngress(receiveChannelMessage);
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(message) {
    if (this.#signal?.aborted) return Promise.resolve();
    const conversationId = cleanText(message?.conversationId);
    const kind = message?.kind === 'group' ? 'group' : 'direct';
    const normalized = { ...message, kind, conversationId };
    const messageId = cleanText(normalized.messageId);
    const senderId = cleanText(normalized.senderId);
    if (!messageId || !senderId || !conversationId || normalized.senderIsBot === true
      || this.#state.hasSeen(messageId)) {
      return Promise.resolve();
    }
    const replyTarget = normalized.replyTarget;
    const threadId = normalized.threadId ?? replyTarget?.messageThreadId;
    const uploadImage = this.#bot.sendImage ?? this.#bot.sendFile;
    return this.#ingress.forward({
      messageId, senderId, conversationType: kind,
      conversationId: String(replyTarget?.chatId ?? replyTarget?.channelId ?? replyTarget?.roomId ?? conversationId),
      ...(threadId == null ? {} : { threadId: String(threadId) }),
      ...(typeof normalized.subject === 'string' && { subject: normalized.subject }),
      ...(typeof normalized.nativeMessageId === 'string' && { nativeMessageId: normalized.nativeMessageId }),
      ...(typeof normalized.senderName === 'string' && { senderLabel: normalized.senderName }),
      ...(typeof normalized.chatTitle === 'string' && { conversationLabel: normalized.chatTitle }),
      addressed: kind === 'direct' || normalized.addressed === true,
      senderIsBot: false, text: controlTextOf(normalized),
    }, {
      signal: this.#signal,
      ...(replyTarget && { sendText: (text, signal) => this.#bot.sendText(replyTarget, text, { signal }) }),
      ...(replyTarget && typeof uploadImage === 'function' && {
        sendImage: (file, signal) => uploadImage.call(this.#bot, replyTarget, file, { signal }),
      }),
    });
  }

  sendConnectionTest(text) {
    return sendRememberedConnectionTest({
      state: this.#state,
      text,
      channelLabel: t('{label}机器人', { label: this.#descriptor.label }),
      send: (target, message) => this.#bot.sendText(target, message),
    });
  }

  sendProactiveText(target, text, { signal, format = 'plain' } = {}) {
    signal?.throwIfAborted();
    if (format === 'markdown' && typeof this.#bot.sendDelivery === 'function') {
      return this.#bot.sendDelivery(target, createTextDeliveryBlock(text, format));
    }
    return this.#bot.sendText(target, text, { signal });
  }

  waitForIdle() {
    return this.#ingress.waitForIdle();
  }
}
