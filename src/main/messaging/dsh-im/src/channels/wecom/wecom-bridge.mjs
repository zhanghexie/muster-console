import { createChannelIngress } from '../shared/channel-ingress.mjs';

import { imageDownloadLimitMessage } from '../shared/image-prompt.mjs';

import { wecomSendError } from './send-error.mjs';

import { ImagePromptError } from '../shared/image-prompt.mjs';

import { trackOutboundArtifactProviderPromise } from '../shared/semantic/artifact.mjs';

const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;

// Built lazily: t() must run after setImHostLanguage, not at import time.

const MAX_REPLY_BYTES = 18_000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bodyOf(frame) {
  return frame?.body && typeof frame.body === 'object' ? frame.body : {};
}

function messageContentText(body) {
  let text = '';
  if (body.msgtype === 'text') {
    text = typeof body.text?.content === 'string' ? body.text.content.trim() : '';
  } else if (body.msgtype === 'voice') {
    text = typeof body.voice?.content === 'string' ? body.voice.content.trim() : '';
  } else if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    text = body.mixed.msg_item
      .filter((item) => item?.msgtype === 'text' && typeof item.text?.content === 'string')
      .map((item) => item.text.content)
      .join('\n')
      .trim();
  }
  return text;
}

function messageText(frame) {
  const body = bodyOf(frame);
  const text = messageContentText(body);
  // Group callbacks retain the leading @bot mention that caused delivery.
  // It is routing metadata rather than part of the user's prompt or answer.
  return body.chattype === 'group'
    ? text.replace(/^\s*@\S+(?:\s+|$)/u, '').trim()
    : text;
}

function imageContents(body) {
  if (body?.msgtype === 'image') return [body.image];
  if (body?.msgtype !== 'mixed' || !Array.isArray(body.mixed?.msg_item)) return [];
  return body.mixed.msg_item
    .filter((item) => item?.msgtype === 'image')
    .map((item) => item.image);
}

function fileContents(frame) {
  const body = bodyOf(frame);
  return body.msgtype === 'file' && body.file && typeof body.file === 'object'
    ? [body.file]
    : [];
}

function quoteAttachments(quote) {
  if (quote?.msgtype === 'image') return [{ kind: 'image' }];
  if (quote?.msgtype === 'voice') return [{ kind: 'audio' }];
  if (quote?.msgtype === 'file') {
    const name = nonEmptyString(
      quote.file?.filename ?? quote.file?.file_name ?? quote.file?.name,
    );
    return [{ kind: 'file', ...(name ? { name } : {}) }];
  }
  if (quote?.msgtype !== 'mixed' || !Array.isArray(quote.mixed?.msg_item)) return [];
  return quote.mixed.msg_item
    .filter((item) => item?.msgtype === 'image')
    .map(() => ({ kind: 'image' }));
}

function replyReferenceForBody(body) {
  const quote = body?.quote;
  if (!quote || typeof quote !== 'object') return null;
  const content = messageContentText(quote);
  const attachments = quoteAttachments(quote);
  const supported = ['text', 'image', 'mixed', 'voice', 'file'].includes(quote.msgtype);
  return {
    ...(content ? { content } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(!content && attachments.length === 0
      ? { unavailableReason: supported ? 'not-delivered' : 'unsupported' }
      : {}),
  };
}

function imageSource(client, image) {
  const url = nonEmptyString(image?.url);
  if (!url) return null;
  const aeskey = nonEmptyString(image?.aeskey) ?? undefined;
  return {
    async load({ signal, maxBytes }) {
      signal?.throwIfAborted();
      if (typeof client?.downloadFile !== 'function') {
        throw new Error('Enterprise WeChat image download is unavailable');
      }
      const result = await client.downloadFile(url, aeskey);
      signal?.throwIfAborted();
      const raw = result?.buffer;
      if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
        throw new Error('Enterprise WeChat image download returned no data');
      }
      const data = Buffer.from(raw);
      if (Number.isFinite(maxBytes) && data.length > maxBytes) {
        throw new ImagePromptError(
          'image-too-large',
          `Enterprise WeChat image exceeds ${maxBytes} bytes`,
          imageDownloadLimitMessage(maxBytes),
        );
      }
      return { data, name: result?.filename };
    },
  };
}

function fileSource(client, file) {
  const url = nonEmptyString(file?.url);
  if (!url) return null;
  const aeskey = nonEmptyString(file?.aeskey) ?? undefined;
  return {
    name: nonEmptyString(file?.filename ?? file?.file_name ?? file?.name) ?? 'file',
    async load({ signal } = {}) {
      signal?.throwIfAborted();
      if (typeof client?.downloadFile !== 'function') {
        throw new Error('Enterprise WeChat file download is unavailable');
      }
      const result = await client.downloadFile(url, aeskey);
      signal?.throwIfAborted();
      const raw = result?.buffer ?? result?.data;
      if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
        throw new Error('Enterprise WeChat file download returned no data');
      }
      return {
        data: Buffer.from(raw),
        ...(nonEmptyString(result?.filename) ? { name: result.filename.trim() } : {}),
      };
    },
  };
}

export function wecomInboundMessage(frame, client) {
  const body = bodyOf(frame);
  const replyTo = replyReferenceForBody(body);
  return {
    content: messageText(frame),
    images: imageContents(body).map((image) => imageSource(client, image)).filter(Boolean),
    files: fileContents(frame).map((file) => fileSource(client, file)).filter(Boolean),
    ...(replyTo ? { replyTo } : {}),
  };
}

function splitUtf8(text, maxBytes = MAX_REPLY_BYTES) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const chunks = [];
  let current = '';
  let bytes = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character);
    if (current && bytes + size > maxBytes) {
      chunks.push(current);
      current = character;
      bytes = size;
    } else {
      current += character;
      bytes += size;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) onAbort();
  });
}

function wecomArtifactError(error, { dispatched = false } = {}) {
  if (error?.code?.startsWith?.('artifact-')) return error;
  const status = Number(error?.httpStatus ?? error?.status ?? error?.response?.status);
  const providerCode = Number(error?.providerCode ?? error?.errcode ?? error?.body?.errcode);
  const wrapped = new Error('Enterprise WeChat file delivery failed', { cause: error });
  if (status === 401 || status === 403 || providerCode === 48002) {
    wrapped.code = 'artifact-permission-required';
  } else if (status === 413) {
    wrapped.code = 'artifact-too-large';
  } else if (status === 429 || providerCode === 45009) {
    wrapped.code = 'artifact-rate-limited';
  } else if (Number.isFinite(providerCode) && providerCode !== 0) {
    wrapped.code = 'artifact-provider-rejected';
  } else {
    wrapped.code = dispatched ? 'artifact-delivery-uncertain' : 'artifact-provider-failed';
  }
  if (Number.isFinite(status)) wrapped.status = status;
  if (Number.isFinite(providerCode)) wrapped.providerCode = providerCode;
  return wrapped;
}

async function sendWecomMedia(
  client,
  chatId,
  file,
  mediaType,
  { signal, timeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS } = {},
) {
  signal?.throwIfAborted();
  if (typeof client?.uploadMedia !== 'function'
    || typeof client?.sendMediaMessage !== 'function') {
    const unavailable = new Error(`Enterprise WeChat ${mediaType} delivery is unavailable`);
    unavailable.code = 'artifact-provider-unavailable';
    throw unavailable;
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const waitSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let uploaded;
  try {
    const pending = client.uploadMedia(file.bytes, {
      type: mediaType,
      filename: file.fileName,
    });
    trackOutboundArtifactProviderPromise(file, pending);
    uploaded = await waitWithSignal(pending, waitSignal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw wecomArtifactError(error);
  }

  signal?.throwIfAborted();
  const mediaId = nonEmptyString(uploaded?.media_id);
  if (!mediaId) {
    const rejected = new Error(`Enterprise WeChat ${mediaType} upload returned no media id`);
    rejected.code = 'artifact-provider-rejected';
    throw rejected;
  }

  let sent;
  try {
    const pending = client.sendMediaMessage(chatId, mediaType, mediaId);
    trackOutboundArtifactProviderPromise(file, pending);
    sent = await waitWithSignal(pending, waitSignal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw wecomArtifactError(error, { dispatched: true });
  }

  signal?.throwIfAborted();
  const providerCode = Number(sent?.body?.errcode ?? sent?.errcode);
  if (Number.isFinite(providerCode) && providerCode !== 0) {
    throw wecomArtifactError({ providerCode });
  }
  return sent;
}

/** Send one materialized artifact through Enterprise WeChat's native image message. */
export function sendWecomImage(client, chatId, file, options) {
  return sendWecomMedia(client, chatId, file, 'image', options);
}

function providerMessageId(result) {
  return nonEmptyString(result?.body?.msgid)
    ?? nonEmptyString(result?.body?.message_id);
}

export function createWecomBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    artifactsSent: 0,
    artifactSendErrors: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    lastMessageError: null,
  };
}

export class WecomChannelBridge {
  #client;
  #state;
  #status;
  #signal;
  #fileUploadTimeoutMs;
  #ingress;

  constructor({ client, receiveChannelMessage, state, status = createWecomBridgeStatus(), fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS, signal }) {
    if (!client || !state) throw new TypeError('WeCom bridge dependencies are required');
    this.#client = client;
    this.#state = state;
    this.#status = status;
    this.#fileUploadTimeoutMs = Math.min(fileUploadTimeoutMs, DEFAULT_FILE_UPLOAD_TIMEOUT_MS);
    this.#signal = signal;
    this.#ingress = createChannelIngress(receiveChannelMessage);
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(frame) {
    if (this.#signal?.aborted) return Promise.resolve();
    const body = bodyOf(frame);
    const messageId = nonEmptyString(body.msgid);
    const senderId = nonEmptyString(body.from?.userid);
    const chatId = body.chattype === 'group'
      ? nonEmptyString(body.chatid)
      : senderId;
    if (!messageId || !senderId || !chatId
      || !['single', 'group'].includes(body.chattype)
      || this.#state.hasSeen(messageId)) return Promise.resolve();

    const commandMessage = wecomInboundMessage(frame, this.#client);
    const commandText = nonEmptyString(commandMessage.content) ?? '';
    const conversationType = body.chattype === 'single' ? 'direct' : 'group';
    return this.#ingress.forward({
      messageId, senderId, conversationId: chatId, conversationType,
      addressed: true, senderIsBot: false, text: commandText,
    }, {
      signal: this.#signal, sendText: (text, signal) => this.#sendActive(chatId, text, { signal }),
      sendImage: (file, signal) => sendWecomImage(this.#client, chatId, file, {
        signal, timeoutMs: this.#fileUploadTimeoutMs,
      }),
    });
  }

  async #sendActive(chatId, text, { signal = this.#signal } = {}) {
    const providerMessageIds = [];
    for (const chunk of splitUtf8(text)) {
      signal?.throwIfAborted();
      let result;
      try {
        result = await this.#client.sendMessage(
          chatId,
          { msgtype: 'markdown', markdown: { content: chunk } },
        );
      } catch (error) {
        throw wecomSendError(error, 'sendMessage');
      }
      const messageId = providerMessageId(result);
      if (messageId) providerMessageIds.push(messageId);
    }
    return providerMessageIds;
  }

  waitForIdle() {
    return this.#ingress.waitForIdle();
  }
}
