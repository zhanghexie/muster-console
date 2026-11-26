import { createChannelIngress } from '../shared/channel-ingress.mjs';

import { SESSION_NAV_HELP_LINES } from '../shared/command-catalog.mjs';

import { normalizeDingtalkSessionWebhook, splitDingtalkText } from './dingtalk-api.mjs';

import { providerMessageIdsFor } from '../shared/semantic/delivery.mjs';

const HELP_TEXT_LINES = [
  '钉钉机器人已连接 Muster。',
  '',
  '直接发送文字、图片或文件即可继续当前会话。',
  '/m 或 /menu  打开下拉操作菜单',
  '/new  开启一个全新会话',
  '/compact  压缩当前会话的较早上下文',
  '/clear  清空当前会话上下文（保留 Session 绑定和历史记录）',
  '/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）',
  '/workspace 工作区序号或绝对路径  切换工作区',
  '/workspacelist  列出工作区绝对路径',
  '/ws、/wsl、/workspaces  工作区命令别名',
  '/sessionlist 或 /sessions [工作区序号或绝对路径]  列出会话 ID 和标题',
  '/sessionlist --all  跨工作区汇总会话（每个工作区默认显示 10 个，可用 --limit N 调整）',
  '/sessionlist --limit N  仅列出当前工作区前 N 个会话',
  '/session Session ID、当前工作区序号或标题关键词  将当前聊天绑定到指定会话',
  ...SESSION_NAV_HELP_LINES,
  '/models  按序号列出所有可用模型',
  '/reasoninglist 或 /reasonings  按序号列出当前模型可用推理等级',
  '/reasoning [序号、等级ID或 --default]  查看或切换当前推理等级',
  '/model [序号或完整模型ID] [推理等级ID]  查看或切换当前会话模型',
  '示例：先发 /models，再发 /model 2 [推理等级ID]',
  '/presetlist 或 /presets  按序号列出可用 Agent Preset',
  '/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset',
  '纯数字 ID：/preset id:<ID>',
  '/preset --default  跟随 Host 默认',
  '/stop  停止当前任务',
  '/steer 补充指令  纠偏当前任务',
  '/batch  开始批量输入（仅私聊，最多 10 条文字）',
  '/send  提交当前批次',
  '/cancel  取消当前批次',
  '/status  检查连接状态',
  '/version  查看插件版本',
  '/help  显示本帮助',
];

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function senderStaffId(message) {
  return nonEmptyString(message?.senderStaffId) ?? nonEmptyString(message?.senderId);
}

function parsedMessageContent(message) {
  if (message?.content && typeof message.content === 'object') return message.content;
  if (typeof message?.content !== 'string') return null;
  try {
    const parsed = JSON.parse(message.content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function richTextEntries(content) {
  const entries = content?.richText ?? content?.rich_text;
  return Array.isArray(entries) ? entries : [];
}

function richTextEntryText(entry) {
  if (typeof entry?.text === 'string') return nonEmptyString(entry.text);
  if (typeof entry?.text?.content === 'string') return nonEmptyString(entry.text.content);
  if (String(entry?.type).toLowerCase() === 'text' && typeof entry?.content === 'string') {
    return nonEmptyString(entry.content);
  }
  return null;
}

function downloadCodeFor(value) {
  return nonEmptyString(value?.downloadCode) ?? nonEmptyString(value?.pictureDownloadCode);
}

function dingtalkImageEntries(msgtype, content) {
  if (msgtype === 'picture') return [content];
  if (msgtype !== 'richtext') return [];
  return richTextEntries(content)
    .filter((entry) => String(entry?.type ?? '').toLowerCase() === 'picture');
}

function dingtalkTimestampMs(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.trunc(number < 10_000_000_000 ? number * 1_000 : number);
}

function usefulReplyText(value) {
  const text = nonEmptyString(value);
  return text && !/^\[interactive card message\]$/iu.test(text) ? text : null;
}

function dingtalkReplyMessage(message) {
  if (message?.text?.isReplyMsg !== true) return null;
  const replied = message.text.repliedMsg;
  if (!replied || typeof replied !== 'object') return null;
  const msgtype = nonEmptyString(replied.msgType ?? replied.msgtype)?.toLowerCase() ?? '';
  const repliedContent = parsedMessageContent({ content: replied.content }) ?? {};
  // Quoted richText entries use msgType instead of the direct callback's type.
  const content = msgtype === 'richtext' ? {
    ...repliedContent,
    richText: richTextEntries(repliedContent).map((entry) => ({
      ...entry, type: entry?.type ?? entry?.msgType ?? entry?.msgtype,
    })),
  } : repliedContent;
  return {
    msgtype,
    robotCode: message.robotCode,
    text: {
      content: nonEmptyString(repliedContent.text)
        ?? (typeof replied.content === 'string' ? replied.content : ''),
    },
    content,
  };
}

function dingtalkReplyReference(message, options) {
  if (message?.text?.isReplyMsg !== true) return null;
  const pseudoMessage = dingtalkReplyMessage(message);
  if (!pseudoMessage) return { unavailableReason: 'not-delivered' };
  const replied = message.text.repliedMsg;
  const { msgtype, content: repliedContent } = pseudoMessage;
  const normalized = dingtalkInboundMessage(pseudoMessage, options);
  let attachments = [];
  if (msgtype === 'picture') {
    attachments = [{ kind: 'image' }];
  } else if (msgtype === 'file') {
    const name = nonEmptyString(repliedContent.fileName ?? repliedContent.file_name);
    attachments = [{ kind: 'file', ...(name ? { name } : {}) }];
  } else if (msgtype === 'richtext') {
    attachments = dingtalkImageEntries(msgtype, repliedContent)
      .map(() => ({ kind: 'image' }));
  } else if (msgtype === 'voice' || msgtype === 'audio') {
    attachments = [{ kind: 'audio' }];
  } else if (msgtype === 'video') {
    attachments = [{ kind: 'video' }];
  }

  const messageId = nonEmptyString(replied.msgId ?? replied.messageId);
  const authorId = nonEmptyString(replied.senderId ?? replied.senderStaffId);
  const authorName = nonEmptyString(replied.senderNick ?? replied.senderName);
  const content = usefulReplyText(normalized.content)
    ?? usefulReplyText(repliedContent.text)
    ?? usefulReplyText(repliedContent.summary)
    ?? usefulReplyText(repliedContent.title);
  const processQueryKey = nonEmptyString(
    message?.originalProcessQueryKey ?? repliedContent.processQueryKey,
  );
  const createdAt = dingtalkTimestampMs(replied.createdAt ?? replied.createTime);
  const load = !content && attachments.length === 0
    && typeof options?.loadReplyContent === 'function'
    ? ({ signal } = {}) => options.loadReplyContent({
        ...(messageId ? { messageId } : {}),
        ...(processQueryKey ? { processQueryKey } : {}),
        ...(createdAt === null ? {} : { createdAt }),
      }, { signal })
    : null;
  const supported = [
    'text', 'picture', 'file', 'richtext', 'voice', 'audio', 'video',
    'interactivecard', 'chatrecord',
  ]
    .includes(msgtype);
  return {
    ...(messageId ? { messageId } : {}),
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    ...(content ? { content } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(load ? { load } : {}),
    ...(!content && attachments.length === 0 && !load
      ? { unavailableReason: supported ? 'not-delivered' : 'unsupported' }
      : {}),
  };
}

// Resolve only the immediate quote, after command/interaction routing has finished.

/** Normalize DingTalk picture and richText callbacks into lazy image references. */
export function dingtalkInboundMessage(message, {
  api,
  clientId,
  clientSecret,
  loadReplyContent,
} = {}) {
  const msgtype = String(message?.msgtype ?? '').toLowerCase();
  const content = parsedMessageContent(message);
  const richEntries = msgtype === 'richtext' ? richTextEntries(content) : [];
  const text = msgtype === 'text'
    ? nonEmptyString(message?.text?.content) ?? ''
    : richEntries.map(richTextEntryText).filter(Boolean).join('\n');
  const imageCodes = dingtalkImageEntries(msgtype, content).map(downloadCodeFor).filter(Boolean);
  const fileCode = msgtype === 'file' ? downloadCodeFor(content) : null;
  const replyTo = dingtalkReplyReference(message, {
    api,
    clientId,
    clientSecret,
    loadReplyContent,
  });
  return {
    content: text,
    images: imageCodes.map((downloadCode, index) => ({
      name: index === 0 ? 'image' : `image-${index + 1}`,
      load: ({ signal, maxBytes }) => {
        if (typeof api?.downloadImage !== 'function') {
          throw new Error('DingTalk API does not support image downloads');
        }
        return api.downloadImage({
          clientId,
          clientSecret,
          robotCode: message?.robotCode,
          downloadCode,
          signal,
          maxBytes,
        });
      },
    })),
    files: fileCode ? [{
      name: nonEmptyString(content?.fileName ?? content?.file_name) ?? 'file',
      load: ({ signal } = {}) => {
        if (typeof api?.downloadFile !== 'function') {
          throw new Error('DingTalk API does not support file downloads');
        }
        return api.downloadFile({
          clientId,
          clientSecret,
          robotCode: message?.robotCode,
          downloadCode: fileCode,
          signal,
        });
      },
    }] : [],
    ...(replyTo ? { replyTo } : {}),
  };
}

function conversationKey(message, sender) {
  if (String(message?.conversationType) === '2') {
    const conversationId = nonEmptyString(message?.conversationId);
    if (!conversationId) throw new Error('DingTalk group message has no conversation id');
    return `group:${conversationId}`;
  }
  return `p2p:${sender}`;
}

function fileTarget(message, sender, clientId) {
  const robotCode = nonEmptyString(message?.robotCode) ?? clientId;
  if (String(message?.conversationType) === '2') {
    return {
      type: 'group',
      openConversationId: nonEmptyString(message?.conversationId),
      robotCode,
    };
  }
  return { type: 'user', userId: sender, robotCode };
}

function increment(status, key) {
  status[key] = (status[key] ?? 0) + 1;
  status.stats ??= {};
  status.stats[key] = status[key];
}

export function createDingtalkBridgeStatus({ pendingSenders = [] } = {}) {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    messagesIgnored: 0,
    reactionsAdded: 0,
    reactionsRemoved: 0,
    reactionErrors: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    lastMessageError: null,
    pendingSenders: structuredClone(pendingSenders),
    stats: {
      messagesReceived: 0,
      messagesReplied: 0,
      messagesRejected: 0,
      messagesIgnored: 0,
      reactionsAdded: 0,
      reactionsRemoved: 0,
      reactionErrors: 0,
    },
  };
}

export class DingtalkChannelBridge {
  #api;
  #clientId;
  #clientSecret;
  #state;
  #status;
  #maxMessageChars;
  #signal;
  #ingress;

  constructor({ api, clientId, clientSecret, receiveChannelMessage, state, status = createDingtalkBridgeStatus(), maxMessageChars = 4_000, signal }) {
    if (typeof api?.sendText !== 'function' || !nonEmptyString(clientId) || !nonEmptyString(clientSecret) || !state) throw new TypeError('DingTalk bridge dependencies are required');
    this.#api = api;
    this.#clientId = clientId.trim();
    this.#clientSecret = clientSecret.trim();
    this.#state = state;
    this.#status = status;
    this.#maxMessageChars = maxMessageChars;
    this.#signal = signal;
    this.#ingress = createChannelIngress(receiveChannelMessage);
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(message) {
    if (this.#signal?.aborted) return Promise.resolve();
    const messageId = nonEmptyString(message?.msgId);
    const sender = senderStaffId(message);
    if (!messageId || !sender || this.#state.hasSeen(messageId)) return Promise.resolve();
    const conversationType = String(message.conversationType) === '2' ? 'group'
      : String(message.conversationType) === '1' ? 'direct' : null;

    let key;
    try {
      key = conversationKey(message, sender);
    } catch {
      increment(this.#status, 'messagesRejected');
      this.#status.lastRejectedAt = new Date().toISOString();
      return Promise.resolve();
    }

    let sessionWebhook = null;
    try {
      sessionWebhook = normalizeDingtalkSessionWebhook(message.sessionWebhook);
    } catch {
      // An unsafe reply route must never be able to submit an approval.
    }
    const promptMessage = dingtalkInboundMessage(message);
    const commandText = nonEmptyString(promptMessage.content) ?? '';
    const addressed = String(message.conversationType) !== '2' || message?.isInAtList === true;
    return this.#ingress.forward({
      messageId, senderId: sender, conversationId: key, conversationType,
      addressed, senderIsBot: false, text: commandText,
    }, {
      signal: this.#signal,
      ...(sessionWebhook && { sendText: (text, signal) => this.#send(sessionWebhook, text, undefined, { signal }) }),
      ...(typeof this.#api.sendImage === 'function' && {
        sendImage: (file, signal) => this.#api.sendImage({
          clientId: this.#clientId, clientSecret: this.#clientSecret,
          target: fileTarget(message, sender, this.#clientId), file, signal,
        }),
      }),
    });
  }

  async #send(sessionWebhook, text, at, { signal = this.#signal } = {}) {
    const providerMessageIds = [];
    for (const chunk of splitDingtalkText(text, this.#maxMessageChars)) {
      signal?.throwIfAborted();
      const result = await this.#api.sendText({
        clientId: this.#clientId,
        clientSecret: this.#clientSecret,
        sessionWebhook,
        text: chunk,
        at,
        signal,
      });
      providerMessageIds.push(...providerMessageIdsFor(result));
    }
    return providerMessageIds;
  }

  waitForIdle() {
    return this.#ingress.waitForIdle();
  }
}

export const DingTalkChannelBridge = DingtalkChannelBridge;
export const createDingTalkBridgeStatus = createDingtalkBridgeStatus;
