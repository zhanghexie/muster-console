const CHANNELS = new Set([
  'weixin',
  'feishu',
  'dingtalk',
  'wecom',
  'wecom-app',
  'qq',
  'slack',
  'telegram',
  'discord',
  'whatsapp',
  'imessage',
  'email',
  'matrix',
]);

export function supportsDeliveryChannel(channel) {
  return CHANNELS.has(channel);
}

function invalidTarget(message) {
  const error = new Error(message);
  error.code = 'invalid-target';
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isRecord(value)) throw invalidTarget(`${label} must be an object`);
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw invalidTarget(`${label} contains an unknown field`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw invalidTarget(`${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function targetName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw invalidTarget('target.name must contain 1 to 80 characters');
  }
  return value.trim();
}

function routeWithStrings(route, fields) {
  exactKeys(route, fields, 'route');
  const normalized = {};
  for (const field of fields) normalized[field] = requiredString(route[field], `route.${field}`);
  return normalized;
}

function oneOf(value, choices) {
  if (!choices.includes(value)) throw invalidTarget('target kind is not supported by this channel');
  return value;
}

function normalizeRoute(channel, kind, route) {
  switch (channel) {
    case 'weixin':
      oneOf(kind, ['user']);
      return routeWithStrings(route, ['toUserId']);
    case 'feishu':
      oneOf(kind, ['user', 'group']);
      return routeWithStrings(route, kind === 'user' ? ['openId'] : ['chatId']);
    case 'dingtalk':
      oneOf(kind, ['user', 'group']);
      return routeWithStrings(route, kind === 'user' ? ['userId'] : ['openConversationId']);
    case 'wecom':
      oneOf(kind, ['user', 'group']);
      return routeWithStrings(route, ['chatId']);
    case 'wecom-app':
      oneOf(kind, ['user']);
      return routeWithStrings(route, ['chatId']);
    case 'qq':
      oneOf(kind, ['user', 'group']);
      return routeWithStrings(route, kind === 'user' ? ['userOpenId'] : ['groupOpenId']);
    case 'slack': {
      oneOf(kind, ['conversation', 'thread']);
      const normalized = routeWithStrings(
        route,
        kind === 'conversation' ? ['channelId'] : ['channelId', 'threadTs'],
      );
      return normalized;
    }
    case 'telegram': {
      oneOf(kind, ['chat', 'topic']);
      exactKeys(route, kind === 'chat' ? ['chatId'] : ['chatId', 'messageThreadId'], 'route');
      const chatId = requiredString(route.chatId, 'route.chatId');
      if (!/^-?\d+$/.test(chatId)) throw invalidTarget('route.chatId must be a decimal string');
      if (kind === 'chat') return { chatId };
      if (!Number.isSafeInteger(route.messageThreadId) || route.messageThreadId <= 0) {
        throw invalidTarget('route.messageThreadId must be a positive integer');
      }
      return { chatId, messageThreadId: route.messageThreadId };
    }
    case 'discord':
      oneOf(kind, ['channel']);
      return routeWithStrings(route, ['channelId']);
    case 'whatsapp': {
      oneOf(kind, ['user', 'group']);
      const normalized = routeWithStrings(route, ['jid']);
      const valid = kind === 'user'
        ? /^\d{5,32}@(s\.whatsapp\.net|lid)$/.test(normalized.jid)
        : /^\d{5,32}(?:-\d{1,32})?@g\.us$/.test(normalized.jid);
      if (!valid) {
        throw invalidTarget(`route.jid must be a ${kind} WhatsApp JID`);
      }
      return normalized;
    }
    case 'imessage':
      oneOf(kind, ['user']);
      return routeWithStrings(route, ['chatGuid']);
    case 'email': {
      oneOf(kind, ['user']);
      const normalized = routeWithStrings(route, ['address']);
      // Mail addresses are normalized to lower case everywhere so a target
      // created from a mixed-case address still matches.
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized.address)) {
        throw invalidTarget('route.address must be a valid email address');
      }
      return { address: normalized.address.toLowerCase() };
    }
    case 'matrix': {
      oneOf(kind, ['room', 'thread', 'dm']);
      const normalized = routeWithStrings(
        route,
        kind === 'room' ? ['roomId'] : kind === 'thread' ? ['roomId', 'threadId'] : ['userId'],
      );
      if (kind === 'dm' && !/^@[^:\s]+:[^\s:]+(?::\d{1,5})?$/u.test(normalized.userId)) {
        throw invalidTarget('route.userId must be a Matrix user id');
      }
      if (kind !== 'dm' && !/^[!][^:$\s]+:[^\s:$]+(?::\d{1,5})?$/.test(normalized.roomId)) {
        throw invalidTarget('route.roomId must be a Matrix room id');
      }
      if (kind === 'thread' && !/^\$[^\s]+/.test(normalized.threadId)) {
        throw invalidTarget('route.threadId must be a Matrix event id');
      }
      return normalized;
    }
    default:
      throw new TypeError(`Unsupported delivery channel: ${channel}`);
  }
}

/** Strictly validate and copy one channel delivery target. */
export function normalizeDeliveryTarget(channel, value, { targetIdRequired = true } = {}) {
  if (!supportsDeliveryChannel(channel)) throw new TypeError(`Unsupported delivery channel: ${channel}`);
  exactKeys(
    value,
    targetIdRequired ? ['targetId', 'name', 'kind', 'route'] : ['name', 'kind', 'route'],
    'target',
  );
  const normalized = {};
  if (targetIdRequired) normalized.targetId = requiredString(value.targetId, 'target.targetId');
  if (value.name !== undefined) normalized.name = targetName(value.name);
  normalized.kind = requiredString(value.kind, 'target.kind');
  normalized.route = normalizeRoute(channel, normalized.kind, value.route);
  return normalized;
}

function targetWithoutSessionSync(target) {
  return {
    targetId: target.targetId,
    ...(target.name === undefined ? {} : { name: target.name }),
    kind: target.kind,
    route: target.route,
  };
}

export function createDeliveryAdapter({ channel, workspaces, coreController }) {
  return Object.freeze({
    channel,
    ownsBot: botId => workspaces.has(botId),
    async sendText(botId, target, text, options = {}) {
      const normalized = normalizeDeliveryTarget(channel, targetWithoutSessionSync(target));
      const result = await coreController.sendProactiveText(botId, normalized, text, options);
      return options.receipt === true ? result : { sent: true };
    },
  });
}
