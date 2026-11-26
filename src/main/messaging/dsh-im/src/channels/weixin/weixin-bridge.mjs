import { createChannelIngress } from '../shared/channel-ingress.mjs';

import {
  DEFAULT_WEIXIN_MAX_MESSAGE_CHARS,
  extractWeixinFiles,
  extractWeixinImages,
  extractWeixinReplyReference,
  extractWeixinText,
  splitWeixinText,
  weixinMessageId,
  weixinMessageTimestampMs,
} from './weixin-api.mjs';

import { rememberConnectionTestTarget } from '../shared/connection-test.mjs';

import { providerMessageIdsFor } from '../shared/semantic/delivery.mjs';

import { t } from '../shared/i18n.mjs';

const WEIXIN_SEND_DIAGNOSTIC = Symbol('weixin-send-diagnostic');

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeDiagnosticToken(value) {
  const token = value === undefined || value === null ? '' : String(value).trim();
  return /^-?[A-Za-z0-9_.:-]{1,160}$/u.test(token) ? token : '-';
}

function weixinApiHost(baseUrl) {
  try {
    return safeDiagnosticToken(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return '-';
  }
}

function createWeixinSendDiagnostic({
  baseUrl,
  text,
  chunk,
  chunkIndex,
  chunkCount,
  maxMessageChars,
  contextToken,
  runId,
  error,
}) {
  const status = Number(error?.status ?? error?.httpStatus);
  const http = Number.isInteger(status)
    ? String(status)
    : error?.code === 'send-rejected' ? '2xx' : '-';
  return [
    'endpoint=sendmessage',
    `host=${weixinApiHost(baseUrl)}`,
    `chunk=${chunkIndex + 1}/${chunkCount}`,
    `chunkChars=${chunk.length}`,
    `chunkUtf8Bytes=${Buffer.byteLength(chunk, 'utf8')}`,
    `totalChars=${text.length}`,
    `totalUtf8Bytes=${Buffer.byteLength(text, 'utf8')}`,
    `limitChars=${maxMessageChars}`,
    `contextToken=${contextToken ? 'yes' : 'no'}`,
    `runId=${runId ? 'yes' : 'no'}`,
    `http=${http}`,
    `provider=${safeDiagnosticToken(error?.providerCode)}`,
    `cause=${safeDiagnosticToken(error?.code ?? error?.name)}`,
  ].join(' ');
}

export function weixinSendError(error, details) {
  const diagnostic = createWeixinSendDiagnostic({ ...details, error });
  const wrapped = new Error(`Weixin text delivery failed (${diagnostic})`, { cause: error });
  const code = safeDiagnosticToken(error?.code);
  wrapped.code = code === '-' ? 'weixin-send-failed' : code;
  const status = Number(error?.status ?? error?.httpStatus);
  if (Number.isInteger(status)) wrapped.status = status;
  const providerCode = safeDiagnosticToken(error?.providerCode);
  if (providerCode !== '-') wrapped.providerCode = providerCode;
  wrapped[WEIXIN_SEND_DIAGNOSTIC] = diagnostic;
  return wrapped;
}

export function weixinSendFailureOptions(error, { proactive = false } = {}) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const diagnostic = current[WEIXIN_SEND_DIAGNOSTIC];
    if (typeof diagnostic === 'string' && diagnostic) {
      return {
        reason: 'weixin-send-failed',
        userMessage: [
          proactive
            ? t('微信主动消息发送失败。长轮询在线不代表消息可以发送。')
            : t('回复已经生成，但微信发送失败，可能只收到部分内容。请将下面的诊断信息完整反馈给管理员。'),
          ...(String(current.providerCode) === '-2' ? [
            t('iLink 拒绝发送，可能涉及会话有效期、发送额度或消息内容。可让接收者发一条消息后重试；不要通过反复发送心跳尝试续期。'),
          ] : []),
          t('微信发送诊断：{diagnostic}', { diagnostic }),
        ].join('\n'),
      };
    }
    current = current.cause;
  }
  return undefined;
}

export function weixinInboundMessage(message, api, state, { loadReplyContent } = {}) {
  const toUserId = nonEmptyString(message?.from_user_id);
  const replyTo = extractWeixinReplyReference(message, {
    resolveContent: (reference) => state?.recentOutboundTextFor?.({
      toUserId,
      ...reference,
    }),
    ...(typeof loadReplyContent === 'function' ? {
      loadContent: (reference, options) => loadReplyContent({
        toUserId,
        ...reference,
      }, options),
    } : {}),
  });
  return {
    content: extractWeixinText(message) ?? '',
    images: typeof api?.inboundImages === 'function'
      ? api.inboundImages(message)
      : extractWeixinImages(message),
    files: typeof api?.inboundFiles === 'function'
      ? api.inboundFiles(message)
      : extractWeixinFiles(message),
    ...(replyTo ? { replyTo } : {}),
  };
}

export function createWeixinBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    lastMessageError: null,
  };
}

export class WeixinChannelBridge {
  #api;
  #baseUrl;
  #token;
  #ownerUserId;
  #state;
  #status;
  #logger;
  #maxMessageChars;
  #signal;
  #ingress;
  #closed = false;

  constructor({ api, baseUrl, token, ownerUserId, receiveChannelMessage, state, status = createWeixinBridgeStatus(), logger = console, maxMessageChars = DEFAULT_WEIXIN_MAX_MESSAGE_CHARS, signal }) {
    if (typeof api?.sendText !== 'function' || !baseUrl || !token || !ownerUserId || !state) throw new TypeError('WeChat bridge dependencies are required');
    this.#api = api;
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#ownerUserId = ownerUserId;
    this.#state = state;
    this.#status = status;
    this.#logger = logger;
    this.#maxMessageChars = maxMessageChars;
    this.#signal = signal;
    this.#ingress = createChannelIngress(receiveChannelMessage);
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(message) {
    if (this.#closed || this.#signal?.aborted) return Promise.resolve();
    if (message?.message_type === 2) return Promise.resolve();
    const messageId = weixinMessageId(message);
    const sender = nonEmptyString(message?.from_user_id);
    if (!messageId || !sender || this.#state.hasSeen(messageId)) return Promise.resolve();
    const commandText = nonEmptyString(extractWeixinText(message)) ?? '';
    {
      if (sender === this.#ownerUserId) rememberConnectionTestTarget(this.#state, { toUserId: sender });
      const token = nonEmptyString(message.context_token) ?? undefined;
      const runId = nonEmptyString(message.run_id) ?? undefined;
      const remembered = this.#state.rememberContextToken?.({
        userId: sender, contextToken: token, seq: message.seq,
        messageTimeMs: message.create_time_ms ?? weixinMessageTimestampMs(messageId),
      });
      // The store updates its in-memory token before persisting. Start routing
      // now so a later message in the same poll cannot overtake a binding code.
      void Promise.resolve(remembered).catch(() => {
        this.#logger.warn?.('[dsh-weixin] Workbench reply context could not be stored');
      });
      return this.#ingress.forward({
        messageId, senderId: sender, conversationId: sender, conversationType: 'direct',
        addressed: true, senderIsBot: false, text: commandText,
      }, {
        signal: this.#signal,
        sendText: (text, signal) => this.#send(sender, text, token, runId, { signal }),
        ...(typeof this.#api.sendImage === 'function' && {
          sendImage: (file, signal) => this.#api.sendImage({
            baseUrl: this.#baseUrl, token: this.#token, toUserId: sender, file,
            contextToken: token ?? this.#state.contextTokenFor?.(sender), runId, signal,
          }),
        }),
      });
    }
  }

  async #send(toUserId, text, contextToken, runId, { signal = this.#signal } = {}) {
    signal?.throwIfAborted();
    contextToken ??= this.#state.contextTokenFor?.(toUserId);
    const providerMessageIds = [];
    const chunks = splitWeixinText(text, this.#maxMessageChars);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      signal?.throwIfAborted();
      const chunk = chunks[chunkIndex];
      const sentAt = Date.now();
      try {
        const result = await this.#api.sendText({
          baseUrl: this.#baseUrl,
          token: this.#token,
          toUserId,
          text: chunk,
          contextToken,
          runId,
          signal,
        });
        const chunkMessageIds = providerMessageIdsFor(result);
        providerMessageIds.push(...chunkMessageIds);
        try {
          await this.#state.rememberOutboundMessage?.({
            toUserId,
            text: chunk,
            sentAt,
            completedAt: Date.now(),
            providerMessageIds: chunkMessageIds,
          });
        } catch (error) {
          this.#logger.warn?.('[dsh-weixin] failed to remember an outbound message:', error);
        }
      } catch (error) {
        throw weixinSendError(error, {
          baseUrl: this.#baseUrl,
          text,
          chunk,
          chunkIndex,
          chunkCount: chunks.length,
          maxMessageChars: this.#maxMessageChars,
          contextToken,
          runId,
        });
      }
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
