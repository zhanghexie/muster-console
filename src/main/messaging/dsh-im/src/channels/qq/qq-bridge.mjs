import { createChannelIngress } from '../shared/channel-ingress.mjs';

import { fetchImageBuffer } from '../shared/image-prompt.mjs';

import {
  trackOutboundArtifactProviderPromise,
} from '../shared/semantic/artifact.mjs';

import { isQqMessageAddressed, normalizeQqMentions } from './qq-mention.mjs';

const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;

export const QQ_IMAGE_HOSTS = Object.freeze([
  '.myqcloud.com',
  '.qpic.cn',
  '.qq.com',
  '.qq.com.cn',
  '.tencentcos.com',
  '.ugcimg.cn',
]);

const QQ_IMAGE_FILENAME = /\.(?:gif|jpe?g|png|webp)$/i;

/** Durable queue-entry id; the conversation key keeps ids unique across chats. */

function conversationKey(message) {
  return `${message.kind}:${message.kind === 'group' ? message.groupOpenid : message.senderId}`;
}

function safeText(message) {
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

function attachmentMediaType(attachment) {
  const value = nonEmptyString(attachment?.content_type ?? attachment?.contentType);
  if (!value) return null;
  return value.split(';', 1)[0].trim().toLowerCase();
}

function isQqImageAttachment(attachment) {
  const mediaType = attachmentMediaType(attachment);
  return mediaType?.startsWith('image/') === true
    || QQ_IMAGE_FILENAME.test(nonEmptyString(attachment?.filename) ?? '');
}

function qqAttachmentKind(attachment) {
  const mediaType = attachmentMediaType(attachment);
  if (mediaType?.startsWith('image/')) return 'image';
  if (mediaType?.startsWith('audio/')) return 'audio';
  if (mediaType?.startsWith('video/')) return 'video';
  return 'file';
}

function qqReplyReference(message) {
  const refMsgIdx = nonEmptyString(message?.refMsgIdx);
  if (!refMsgIdx) return null;
  const element = Array.isArray(message?.msgElements) ? message.msgElements[0] : null;
  const sourceAttachments = Array.isArray(element?.attachments) ? element.attachments : [];
  const attachments = sourceAttachments.map((attachment) => {
    const name = nonEmptyString(attachment?.filename);
    return { kind: qqAttachmentKind(attachment), ...(name ? { name } : {}) };
  });
  const asrText = sourceAttachments
    .filter((attachment) => qqAttachmentKind(attachment) === 'audio')
    .map((attachment) => nonEmptyString(attachment?.asr_refer_text))
    .filter(Boolean)
    .join('\n');
  const content = asrText || nonEmptyString(element?.content);
  return {
    messageId: refMsgIdx,
    ...(content ? { content } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(!content && attachments.length === 0 ? { unavailableReason: 'not-delivered' } : {}),
  };
}

async function fetchQqFileBuffer(url, { fetchImpl, signal }) {
  const normalizedUrl = url.startsWith('//') ? `https:${url}` : url;
  const response = await fetchImpl(new URL(normalizedUrl), {
    method: 'GET',
    signal,
    redirect: 'follow',
  });
  if (!response?.ok) {
    await response?.body?.cancel?.().catch?.(() => undefined);
    throw new Error(`QQ file download failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Convert QQ's attachment metadata into lazily downloaded image references. */
export function qqInboundMessage(message, { fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const images = [];
  const files = [];
  for (const attachment of message?.attachments ?? []) {
    const url = nonEmptyString(attachment?.url);
    const name = nonEmptyString(attachment?.filename) ?? undefined;
    const mediaType = attachmentMediaType(attachment);
    const declaredSize = Number(attachment?.size);
    if (isQqImageAttachment(attachment)) {
      images.push({
        ...(name ? { name } : {}),
        ...(mediaType?.startsWith('image/') ? { mediaType } : {}),
        ...(Number.isFinite(declaredSize) && declaredSize >= 0 ? { size: declaredSize } : {}),
        load: ({ signal, maxBytes }) => {
          if (!url) throw new Error('QQ image attachment has no download URL');
          return fetchImageBuffer(url, {
            fetchImpl,
            signal,
            maxBytes,
            allowedHosts: QQ_IMAGE_HOSTS,
          });
        },
      });
      continue;
    }
    files.push({
      name: name ?? (files.length === 0 ? 'file' : `file-${files.length + 1}`),
      ...(mediaType?.includes('/') ? { mediaType } : {}),
      ...(Number.isFinite(declaredSize) && declaredSize >= 0 ? { size: declaredSize } : {}),
      load: ({ signal } = {}) => {
        if (!url) throw new Error('QQ file attachment has no download URL');
        return fetchQqFileBuffer(url, { fetchImpl, signal });
      },
    });
  }
  const replyTo = qqReplyReference(message);
  return {
    content: safeText(message),
    images,
    files,
    ...(replyTo ? { replyTo } : {}),
  };
}

// QQ accepts passive replies to an inbound msg_id for a bounded window
// (C2C 60 min, group 5 min). Proactive C2C/group sends are quota-limited and
// are often refused, so a late result keeps the passive route while the
// window is still open and only falls back to proactive delivery after it.
const PASSIVE_REPLY_WINDOW_MS = Object.freeze({ c2c: 60 * 60_000, group: 5 * 60_000 });
const PASSIVE_REPLY_MARGIN_MS = 30_000;

export function deferredDeliveryTarget(target, now = Date.now()) {
  const route = { scope: target?.scope, targetId: target?.targetId };
  const window = PASSIVE_REPLY_WINDOW_MS[target?.scope];
  if (!nonEmptyString(target?.msgId) || !window || !Number.isFinite(target?.receivedAt)) return route;
  return now - target.receivedAt < window - PASSIVE_REPLY_MARGIN_MS ? { ...route, msgId: target.msgId } : route;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function qqArtifactError(error, { dispatched = false } = {}) {
  if (error?.code?.startsWith?.('artifact-')) {
    return error;
  }
  if (error?.name === 'UploadDailyLimitExceededError') {
    const wrapped = new Error('QQ daily file upload limit exceeded', { cause: error });
    wrapped.name = error.name;
    wrapped.code = 'artifact-rate-limited';
    return wrapped;
  }
  const status = Number(error?.httpStatus);
  const wrapped = new Error('QQ file delivery failed', { cause: error });
  if (status === 401 || status === 403) wrapped.code = 'artifact-permission-required';
  else if (status === 413) wrapped.code = 'artifact-too-large';
  else if (status === 429) wrapped.code = 'artifact-rate-limited';
  else if ([400, 404, 405, 406, 410, 415, 422].includes(status)) {
    wrapped.code = 'artifact-provider-rejected';
  } else {
    wrapped.code = dispatched ? 'artifact-delivery-uncertain' : 'artifact-provider-failed';
  }
  return wrapped;
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

/** Send one materialized artifact through QQ's native image message. */
export async function sendQqImage(
  bot,
  target,
  file,
  { signal, timeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS } = {},
) {
  signal?.throwIfAborted();
  if (typeof bot?.sendImage !== 'function') {
    const unavailable = new Error('QQ image delivery is unavailable');
    unavailable.code = 'artifact-provider-unavailable';
    throw unavailable;
  }

  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const pending = bot.sendImage(
      target,
      { buffer: file.bytes },
      { onProgress: () => signal?.throwIfAborted() },
    );
    trackOutboundArtifactProviderPromise(file, pending);
    return await waitWithSignal(pending, waitSignal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw qqArtifactError(error, { dispatched: true });
  }
}

export function createQqBridgeStatus() {
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

export class QqChannelBridge {
  #bot;
  #state;
  #status;
  #signal;
  #fileUploadTimeoutMs;
  #ingress;

  constructor({ bot, ownerUserOpenid, receiveChannelMessage, state, status = createQqBridgeStatus(), signal, fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS }) {
    if (typeof bot?.sendText !== 'function' || !ownerUserOpenid || !state) throw new TypeError('QQ bridge dependencies are required');
    if (!Number.isInteger(fileUploadTimeoutMs) || fileUploadTimeoutMs < 1) throw new TypeError('fileUploadTimeoutMs must be a positive integer');
    this.#bot = bot;
    this.#state = state;
    this.#status = status;
    this.#signal = signal;
    this.#fileUploadTimeoutMs = Math.min(fileUploadTimeoutMs, DEFAULT_FILE_UPLOAD_TIMEOUT_MS);
    this.#ingress = createChannelIngress(receiveChannelMessage);
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(message) {
    return this.#accept(message);
  }

  #accept(message) {
    if (this.#signal?.aborted) return Promise.resolve();
    const messageId = nonEmptyString(message?.messageId);
    const sender = nonEmptyString(message?.senderId);
    if (!messageId || !sender || message?.senderIsBot === true
      || !['c2c', 'group'].includes(message?.kind)
      || this.#state.hasSeen(messageId)) return Promise.resolve();
    message = normalizeQqMentions(message, new Set([this.#bot.appId]));
    const key = conversationKey(message);
    const addressed = isQqMessageAddressed(message);
    const commandText = safeText(message);
    return this.#ingress.forward({
      messageId, senderId: sender, conversationId: key,
      conversationType: message.kind === 'c2c' ? 'direct' : 'group', addressed, senderIsBot: false, text: commandText,
    }, {
      signal: this.#signal,
      ...(message.replyTarget && { sendText: (text, signal) => {
        signal?.throwIfAborted();
        return this.#bot.sendText(message.replyTarget, text);
      } }),
      ...(message.replyTarget && typeof this.#bot.sendImage === 'function' && {
        sendImage: (file, signal) => sendQqImage(this.#bot, message.replyTarget, file, {
          signal, timeoutMs: this.#fileUploadTimeoutMs,
        }),
      }),
    });
  }

  waitForIdle() {
    return this.#ingress.waitForIdle();
  }
}
