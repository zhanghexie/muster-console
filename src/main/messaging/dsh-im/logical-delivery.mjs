import { normalizeDeliveryTarget } from './adapters/host/delivery-adapter.mjs';

function deliveryError(code) {
  return Object.assign(new Error(code), { code });
}

function routeId(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 512
      || /[\u0000-\u001f\u007f]/u.test(value)) throw deliveryError('invalid-target');
  return value;
}

function prefixed(id, prefix) {
  if (!id.startsWith(`${prefix}:`)) throw deliveryError('invalid-target');
  return routeId(id.slice(prefix.length + 1));
}

function telegramId(value) {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(parsed)) throw deliveryError('invalid-target');
  return parsed;
}

/** Resolve only the native route of a source already verified by the host. */
export function logicalDeliveryDraft(source, message) {
  const { provider, conversationType } = source ?? {};
  if (conversationType !== 'direct' && conversationType !== 'group') throw deliveryError('invalid-target');
  const id = routeId(source.conversationId);
  const thread = source.threadId === undefined ? undefined : routeId(source.threadId);
  const parent = message.nativeMessageId === undefined ? undefined : routeId(message.nativeMessageId);
  const explicitReply = message.reply === true;
  const direct = conversationType === 'direct';
  const options = { logical: true };
  let kind;
  let route;

  if (thread && !['feishu', 'slack', 'telegram', 'discord', 'matrix'].includes(provider)) {
    throw deliveryError('thread-unavailable');
  }
  switch (provider) {
    case 'weixin':
      if (!direct) throw deliveryError('invalid-target');
      kind = 'user'; route = { toUserId: id };
      break;
    case 'feishu':
      // Feishu calls this route "group" for the chat_id addressing form. The
      // same API takes a verified oc_ ID for chats of either visible type.
      kind = 'group'; route = { chatId: id };
      if (thread && !parent) throw deliveryError('thread-unavailable');
      if (thread || (explicitReply && parent)) {
        options.nativeMessageId = parent;
        options.replyInThread = Boolean(thread);
      }
      break;
    case 'dingtalk':
      kind = direct ? 'user' : 'group';
      route = direct ? { userId: prefixed(id, 'p2p') } : { openConversationId: prefixed(id, 'group') };
      break;
    case 'wecom':
      kind = direct ? 'user' : 'group'; route = { chatId: id };
      break;
    case 'wecom-app':
      if (!direct) throw deliveryError('invalid-target');
      kind = 'user'; route = { chatId: id };
      break;
    case 'qq':
      kind = direct ? 'user' : 'group';
      route = direct ? { userOpenId: prefixed(id, 'c2c') } : { groupOpenId: prefixed(id, 'group') };
      if (explicitReply && parent) options.nativeMessageId = parent;
      break;
    case 'slack': {
      const threadTs = thread ?? (explicitReply ? parent : undefined);
      if (threadTs && !/^\d{1,20}(?:\.\d{1,20})?$/u.test(threadTs)) throw deliveryError('thread-unavailable');
      kind = threadTs ? 'thread' : 'conversation';
      route = threadTs ? { channelId: id, threadTs } : { channelId: id };
      break;
    }
    case 'telegram':
      kind = thread ? 'topic' : 'chat'; route = thread ? { chatId: id, messageThreadId: telegramId(thread) } : { chatId: id };
      if (explicitReply && parent) options.nativeMessageId = telegramId(parent);
      break;
    case 'discord':
      // The existing normalizer uses the actual thread channel as its target.
      if (thread && thread !== id) throw deliveryError('thread-unavailable');
      kind = 'channel'; route = { channelId: id };
      if (explicitReply && parent) options.nativeMessageId = parent;
      break;
    case 'whatsapp':
      kind = direct ? 'user' : 'group'; route = { jid: id };
      break;
    case 'imessage':
      if (!direct || !/^(?:iMessage|any);-;[^;]+$/u.test(id)) throw deliveryError('invalid-target');
      kind = 'user'; route = { chatGuid: id };
      break;
    case 'email':
      // Both SMTP and the optional mail CLI interpret list punctuation in
      // recipient fields. A Channel source authorizes one bare mailbox.
      if (!direct || /[,;():"\\]/u.test(id)) throw deliveryError('invalid-target');
      kind = 'user'; route = { address: id };
      if (explicitReply && parent) options.nativeMessageId = parent;
      if (message.subject !== undefined) {
        if (typeof message.subject !== 'string' || message.subject.length > 998 || /[\r\n\u0000]/u.test(message.subject)) {
          throw deliveryError('invalid-target');
        }
        options.subject = message.subject;
      }
      break;
    case 'matrix':
      kind = thread ? 'thread' : 'room'; route = thread ? { roomId: id, threadId: thread } : { roomId: id };
      if (explicitReply && parent) options.nativeMessageId = parent;
      break;
    default:
      throw deliveryError('capability-unavailable');
  }
  return { draft: normalizeDeliveryTarget(provider, { kind, route }, { targetIdRequired: false }), options };
}
