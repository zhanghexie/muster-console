import { createChannelIngress } from '../shared/channel-ingress.mjs';

import { providerMessageIdsFor } from '../shared/semantic/delivery.mjs';

import { WECOM_APP_TEXT_MAX_BYTES, splitUtf8ByBytes } from './wecom-app-api.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function messageText(message) {
  if (message?.msgtype !== 'text') return '';
  return typeof message.text?.content === 'string' ? message.text.content : '';
}

function supportedInboundType(message) {
  return message?.msgtype === 'text' || message?.msgtype === 'image';
}

// Inbound image source: WeCom either hands out a directly fetchable PicUrl or
// a media_id downloadable through the authenticated media API. Loads are cached
// so an eager prefetch survives the queue wait without a second download.

export class WecomAppBridge {
  #api;
  #state;
  #status;
  #signal;
  #maxChunkBytes;
  #closed = false;
  #ingress;

  constructor({ api, receiveChannelMessage, state, status, signal, maxChunkBytes = WECOM_APP_TEXT_MAX_BYTES }) {
    if (typeof api?.sendText !== 'function' || !state) throw new TypeError('WeCom App bridge dependencies are required');
    this.#api = api;
    this.#state = state;
    this.#status = status;
    this.#signal = signal;
    this.#maxChunkBytes = maxChunkBytes;
    this.#ingress = createChannelIngress(receiveChannelMessage);
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(message) {
    if (this.#closed || this.#signal?.aborted) return Promise.resolve();
    const messageId = nonEmptyString(message?.msgid);
    const sender = nonEmptyString(message?.from?.userid);
    if (!messageId || !sender || !supportedInboundType(message)
      || this.#state.hasSeen(messageId)) {
      return Promise.resolve();
    }
    const commandText = nonEmptyString(messageText(message)) ?? '';
    return this.#ingress.forward({
      messageId, senderId: sender, conversationId: sender, conversationType: 'direct',
      addressed: true, senderIsBot: false, text: commandText,
    }, {
      signal: this.#signal, sendText: (text, signal) => this.#send(sender, text, { signal }),
      ...(typeof this.#api.sendArtifactFile === 'function' && {
        sendImage: (file, signal) => this.#api.sendArtifactFile({
          userId: sender, kind: 'image', bytes: file.bytes, filename: file.fileName, signal,
        }),
      }),
    });
  }

  async #send(sender, text, { signal = this.#signal } = {}) {
    const target = nonEmptyString(sender);
    const value = typeof text === 'string' ? text : '';
    if (!target || !value) return [];
    const providerMessageIds = [];
    const chunks = splitUtf8ByBytes(value, this.#maxChunkBytes);
    for (const chunk of chunks) {
      signal?.throwIfAborted();
      if (!chunk) continue;
      const result = await this.#api.sendText({ userId: target, content: chunk, signal });
      providerMessageIds.push(...providerMessageIdsFor(result));
    }
    return providerMessageIds;
  }

  waitForIdle() {
    return this.#ingress.waitForIdle();
  }

  async close() {
    this.#closed = true;
    await this.waitForIdle();
  }
}
