import { createChannelIngress } from '../shared/channel-ingress.mjs';

import { extractInboundMessage, isBotSender } from './message-utils.mjs';

// Lazily evaluated: t() must run after setImHostLanguage, not at import time.

/** Managed-topic root candidates expire without a returned thread_id. */

/** Bound main-feed roots awaiting a topic so silent drops cannot grow them. */

/** Conversations remembered as auto-continued-round delivery targets (LRU). */

// After the merge a bare /workspace or /ws opens the same picker card.

/** A displayed menu stays number-tappable for this long. */

/** Bound callback work per conversation so retries cannot exhaust Host RPCs. */

/** Bound actual stop/steer submissions independently from ordinary card UI work. */

/** Provider retries may arrive after the original callback has already settled. */

/** Keep pre-persistence completion arrivals long enough for a new watch to baseline. */

/** Collapse callback-flood notices instead of amplifying overload into more API calls. */

/** Cards should degrade promptly when one optional Host data source is slow. */

const REPAIR_AUTHORIZATION_STATES = new Set([
  'starting', 'qr_ready', 'polling', 'slow_down', 'domain_switched',
]);
const REPAIR_ACTIVE_STATES = new Set([...REPAIR_AUTHORIZATION_STATES, 'saving']);
const REPAIR_TERMINAL_STATES = new Set([
  'succeeded', 'expired', 'cancelled', 'error',
]);
const REPAIR_URL_HOSTS = new Set([
  'accounts.feishu.cn',
  'open.feishu.cn',
  'accounts.larksuite.com',
  'open.larksuite.com',
]);

/** Matches fast card commands that should not be queued behind a running task. */

// ── Step push (分步直推) limits ──────────────────────────────────────────────
/** Feishu allows 5 msg/s per chat; step push stays well below that. */

/** One turn never pushes more step messages than this (熔断阈值). */

/** Excerpt bounds for step push message rendering. */

/** Silence threshold before the thinking status heartbeat appears. */

/** The thinking heartbeat refreshes its elapsed time at this cadence. */

/** One turn never refreshes the thinking heartbeat more than this. */

/** One pending heartbeat id is retried at most this many times across
 *  recall boundaries before it is abandoned (with a warning). */

/** One post message carries at most this many UTF-8 bytes after its rich-text
 *  content has been JSON encoded (Feishu caps rich-text requests at 30KB). */

/** Streaming-card mode coalesces card renders behind one PATCH per interval —
 *  patching the same message is far more rate sensitive than posting. */

/** Confirm missed boundaries from history; elapsed time is never completion. */

/** Retire orphan snapshots outside Feishu's message update window. */

/**
 * The one-line label an auto-continued round shows in the conversation. The
 * Harness goal driver feeds the round a `<goal_round>` prompt that must never
 * reach the chat, so both the goal-round card and the session-sync mirror
 * announce the round by number instead of echoing that text.
 */

/** One answer chunk inside the streaming card: small enough that the block
 *  splitter can always distribute blocks across sealed/live cards. */

/** Panels (tool summary / thinking) shed their oldest lines past this budget
 *  so a single panel can never outgrow the card on its own. */

/** One thinking note is excerpted to this many characters inside its panel. */

/** Split independently rendered posts with the shared structure-aware splitter.
 * Budget the serialized payload, including reopened fences and JSON escapes.
 * Retry from the original source when lowering the character bound so that
 * generated fences are never mistaken for source content on a second split. */

/** Salient tool-argument fields for the intent summary, in priority order. */

/** Bounds the per-conversation step push send-state cache. */

/** Real clock used by step push throttling; tests inject a fake one. */

/** Pretty-print a tool call's arguments for an approval card. */

/** Strip control characters so the approval card text stays clean. */

/**
 * A p2p text message that is nothing but a mention of the bot.
 *
 * The mention is stripped before we see the text, so `@bot` arrives as an empty
 * body — indistinguishable from an empty message unless the message type is
 * checked. Deliberately narrow:
 *
 *   - only `p2p`, where the reader is talking to the bot directly;
 *   - only `text`, so a voice note, video, sticker or forwarded card keeps its
 *     own "not supported" notice instead of silently opening a menu;
 *   - only when nothing else came with it, so `@bot 你好` stays a prompt.
 *
 * The caller also treats this as a command for access control, because opening
 * the menu is `/m` by another route and carries the same information.
 */

/**
 * A message that is nothing but a mention of the bot, with no body of its own.
 * There is no question to answer — a direct chat opens the menu card for it and
 * a group gets the "text, image and file only" notice — so it must not open a
 * topic either: an empty topic would leave an empty session behind, and every
 * look at the menu would create another one.
 *
 * Mirrors the reply-reference test (`feishuReplyTargetId`): an explicit quote
 * keeps the message a real question even when the mention is all the text it
 * carries.
 */

/** Canonical workspace/session help advertised by every bridge family. */

/** Safe user-facing text for bind/workspace failures (no raw messages). */

/** Collapse a step push excerpt into one tidy line. */

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Accept SDK payload fields that may already be objects or JSON strings. */

/** Normalize a single-select value without corrupting valid commas in an id/path. */
function callbackSingleOption(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const selected = callbackSingleOption(entry);
      if (selected !== null) return selected;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    if ('value' in value) return callbackSingleOption(value.value);
    if ('option' in value) return callbackSingleOption(value.option);
    return null;
  }
  if (typeof value !== 'string') return null;
  const source = value.trim();
  if (!source) return null;
  if (source.startsWith('[') || source.startsWith('{') || source.startsWith('"')) {
    try {
      const parsed = JSON.parse(source);
      if (parsed !== value) return callbackSingleOption(parsed);
    } catch { /* plain value below */ }
  }
  return source;
}

/** Normalize multi-select values across current and legacy SDK shapes. */
function callbackMultiOptionValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => callbackMultiOptionValues(entry));
  if (value && typeof value === 'object') {
    if ('value' in value) return callbackMultiOptionValues(value.value);
    if ('option' in value) return callbackMultiOptionValues(value.option);
    return [];
  }
  if (typeof value !== 'string') return [];
  const source = value.trim();
  if (!source) return [];
  if (source.startsWith('[') || source.startsWith('{') || source.startsWith('"')) {
    try {
      const parsed = JSON.parse(source);
      if (parsed !== value) return callbackMultiOptionValues(parsed);
    } catch { /* plain value below */ }
  }
  return source.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function senderOpenId(event) {
  return nonEmptyString(event?.sender?.sender_id?.open_id)
    ?? nonEmptyString(event?.sender?.sender_id?.user_id);
}

export class FeishuChannelBridge {
  #client;
  #channel;
  #state;
  #logger;
  #signal;
  #botOpenId;
  #anchorTopicReply = new Map();
  #rootCandidates = new Map();
  #ingress;

  constructor({ client, channel, receiveChannelMessage, state, botOpenId, logger = console, signal }) {
    if (!client || !state) throw new TypeError('Feishu bridge dependencies are required');
    this.#client = client;
    this.#channel = channel;
    this.#state = state;
    this.#botOpenId = nonEmptyString(botOpenId);
    this.#logger = logger;
    this.#signal = signal;
    this.#ingress = createChannelIngress(receiveChannelMessage);
  }

  accept(event) {
    {
      const message = event?.message;
      const conversationType = message?.chat_type === 'p2p' ? 'direct' : message?.chat_type === 'group' ? 'group' : undefined;
      const conversationId = nonEmptyString(message?.chat_id);
      const messageId = nonEmptyString(message?.message_id);
      const senderId = senderOpenId(event);
      if (!conversationType || !conversationId || !messageId || !senderId) return Promise.resolve();
      const threadId = nonEmptyString(message.thread_id);
      const text = nonEmptyString(extractInboundMessage(event, this.#client).content) ?? '';
      return this.#ingress.forward({
        conversationId, conversationType, messageId, senderId, ...(threadId && { threadId }),
        addressed: conversationType === 'direct' || this.#isAddressed(event), senderIsBot: isBotSender(event), text,
      }, {
        signal: this.#signal,
        sendText: (answer, signal) => this.#send(conversationId, answer, {
          replyTo: messageId, replyInThread: Boolean(threadId), allowUnthreadedFallback: false, signal,
        }),
        ...(typeof this.#channel?.sendImage === 'function' && {
          sendImage: (file, signal) => this.#channel.sendImage(conversationId, file, {
            replyTo: messageId, replyInThread: Boolean(threadId), signal,
          }),
        }),
      });
    }
  }

  #isAddressed(event) {
    if (event?.message?.chat_type === 'p2p') return true;
    return this.#isMentioned(event);
  }

  #isMentioned(event) {
    const mentions = Array.isArray(event?.message?.mentions) ? event.message.mentions : [];
    if (!this.#botOpenId) return mentions.length > 0;
    return mentions.some((mention) => mention?.id?.open_id === this.#botOpenId
      || mention?.open_id === this.#botOpenId);
  }

  #replyInThreadFor(replyTo) {
    // Topic membership is decided by the conversation shape alone (see
    // #rememberTopicReply): a manual-topic chat threads its replies even
    // when the 群话题回复 switch is off.
    return nonEmptyString(replyTo)
      && this.#anchorTopicReply.get(replyTo) === true;
  }

  #pruneRootCandidates(now = Date.now()) {
    for (const [messageId, expiresAt] of this.#rootCandidates) {
      if (expiresAt <= now) this.#rootCandidates.delete(messageId);
    }
  }

  #forgetTopicRoot(messageId) {
    if (!nonEmptyString(messageId)) return;
    this.#rootCandidates.delete(messageId);
  }

  async #registerTopicFromReply(replyTo, chatId, response) {
    await this.#registerTopicReply(replyTo, chatId, response?.data?.thread_id);
  }

  async #registerTopicReply(rootMessageId, chatId, threadId) {
    const known = nonEmptyString(threadId);
    if (known) {
      await this.#registerTopicThreadId(known, rootMessageId, chatId);
      return;
    }
    await this.#ensureTopicRegistered(rootMessageId, chatId);
  }

  async #ensureTopicRegistered(rootMessageId, chatId) {
    this.#pruneRootCandidates();
    if (!nonEmptyString(rootMessageId) || !this.#rootCandidates.has(rootMessageId)) return;
    const threadId = await this.#readTopicThreadId(rootMessageId);
    if (threadId) {
      await this.#registerTopicThreadId(threadId, rootMessageId, chatId);
      return;
    }
    // Still no topic: drop the candidate so a later addressed question opens a
    // fresh session rather than reusing a stale slot.
    this.#forgetTopicRoot(rootMessageId);
  }

  async #readTopicThreadId(messageId) {
    const read = this.#client?.im?.v1?.message?.get;
    if (typeof read !== 'function') return null;
    try {
      const response = await read({ path: { message_id: messageId } });
      if (response?.code && response.code !== 0) return null;
      const items = Array.isArray(response?.data?.items) ? response.data.items : [];
      const item = items.find((candidate) => nonEmptyString(candidate?.message_id) === messageId)
        ?? items[0];
      return nonEmptyString(item?.thread_id);
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-feishu] could not read the topic of a replied-to message:',
        error?.message ?? String(error),
      );
      return null;
    }
  }

  async #registerTopicThreadId(threadId, rootMessageId, chatId) {
    this.#pruneRootCandidates();
    if (!threadId || !this.#rootCandidates.has(rootMessageId)) return;
    this.#rootCandidates.delete(rootMessageId);
    if (!chatId || typeof this.#state?.setTopic !== 'function') return;
    try {
      await this.#state.setTopic(threadId, { rootMessageId, chatId });
    } catch (error) {
      this.#logger.warn?.('[dsh-feishu] failed to record managed topic:', error?.message ?? String(error));
    }
  }

  async #send(chatId, text, {
    replyTo, receiveIdType = 'chat_id', replyInThread, allowUnthreadedFallback = true, signal = this.#signal,
  } = {}) {
    signal?.throwIfAborted();
    const content = JSON.stringify({ text });
    if (replyTo) {
      try {
        const response = await this.#client.im.v1.message.reply({
          path: { message_id: replyTo },
          data: {
            msg_type: 'text',
            content,
            ...((replyInThread ?? this.#replyInThreadFor(replyTo)) ? { reply_in_thread: true } : {}),
          },
        });
        if (response?.code && response.code !== 0) {
          throw new Error(`Feishu reply failed: ${response.msg || response.code}`);
        }
        await this.#registerTopicFromReply(replyTo, chatId, response);
        return nonEmptyString(response?.data?.message_id);
      } catch (error) {
        if (!allowUnthreadedFallback) throw error;
        // The referenced message may be gone (recalled/deleted); keep the
        // delivery promise by falling back to a plain chat message.
        this.#logger.warn?.(
          '[dsh-feishu] threaded reply failed; falling back to a plain message:',
          error?.message ?? String(error),
        );
        // The topic never opened; a managed root candidate must not linger.
        this.#forgetTopicRoot(replyTo);
      }
    }
    signal?.throwIfAborted();
    const response = await this.#client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content,
      },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`Feishu send failed: ${response.msg || response.code}`);
    }
    return nonEmptyString(response?.data?.message_id);
  }

  waitForIdle() {
    return this.#ingress.waitForIdle();
  }
}
