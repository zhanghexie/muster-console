/**
 * 网关 WS 应用层协议契约（webApiShim ↔ WebAccessServer 共用）。
 *
 * 帧类型（与既有 invoke/result/event/push 并列，畸形帧静默丢弃）：
 *   C→S {t:'hello', caps:{terminal?, stream?}}  兴趣声明（断线重连后需重发）
 *   C→S {t:'filter', drop:[channel, …]}        显式丢弃列表（整表替换 hello 派生的 drop，非并集）
 *   C→S {t:'ping'} / S→C {t:'pong'}            应用层心跳（另有协议层 ws.ping/pong）
 *
 * 兼容约定：未声明 hello/filter 的客户端 drop=null，事件**全量**广播（旧客户端行为不变）。
 */
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_MISS_CYCLES = 2;
/** 超过约 2 个心跳周期没收到任何帧 → 判半开，客户端主动 close 走重连 */
export const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISS_CYCLES;
/** 服务端对僵尸客户端的协议层 ping 周期（连续无 pong 则 terminate） */
export const SERVER_HEARTBEAT_INTERVAL_MS = 30_000;
export const INVOKE_TIMEOUT_MS = 30_000;
/** token 被拒（close 4001）后的重试冷却；URL 换了新 token 时立即重试不冷却 */
export const TOKEN_REJECT_COOLDOWN_MS = 5_000;
export const OUTBOX_MAX = 500;
/** 可靠 send 在重连 flush 中累计失败超过此次数 → 放弃并给用户可见错误 */
export const RELIABLE_FLUSH_ATTEMPTS_MAX = 3;
export const TOKEN_COOKIE_NAME = 'ma_web_token';

/* ─────────────────────────── 控制帧 ─────────────────────────── */

export interface ClientCaps {
  /** 终端/PTY 相关事件。缺省 true */
  terminal?: boolean;
  /** 模型流式事件（agent:token / agent:thinking）。缺省 true；聊天对账靠 agent:message/history */
  stream?: boolean;
}

export type HelloFrame = { t: 'hello'; caps: ClientCaps };
export type FilterFrame = { t: 'filter'; drop: string[] };
export type PingFrame = { t: 'ping' };
export type PongFrame = { t: 'pong' };

export type ClientControl =
  | { kind: 'hello'; caps: ClientCaps }
  | { kind: 'filter'; drop: string[] }
  | { kind: 'ping' }
  | { kind: 'pong' };

/** 客户端→服务端全部合法帧的解码结果（R1，审计 2026-10-02：解码与业务分派分离） */
export type ClientFrame =
  | { kind: 'invoke'; id: number; channel: string; args: unknown }
  | { kind: 'send'; channel: string; args: unknown[] }
  | ClientControl;

export function encodeHello(caps: ClientCaps): string {
  return JSON.stringify({ t: 'hello', caps: normalizeCaps(caps) } satisfies HelloFrame);
}

export function encodeFilter(drop: string[]): string {
  return JSON.stringify({ t: 'filter', drop: drop.filter((d) => typeof d === 'string' && d) } satisfies FilterFrame);
}

export function encodePing(): string {
  return JSON.stringify({ t: 'ping' } satisfies PingFrame);
}

export function encodePong(): string {
  return JSON.stringify({ t: 'pong' } satisfies PongFrame);
}

/** 归一 caps：非布尔丢弃，缺省视为 true（要全量） */
export function normalizeCaps(raw: unknown): ClientCaps {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const caps: ClientCaps = {};
  if (typeof o.terminal === 'boolean') caps.terminal = o.terminal;
  if (typeof o.stream === 'boolean') caps.stream = o.stream;
  return caps;
}

/**
 * 解析客户端控制帧。业务帧（invoke/send/…）与畸形帧都返回 null（调用方继续走原解析）。
 */
export function parseClientControl(raw: unknown): ClientControl | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.t === 'ping') return { kind: 'ping' };
  if (o.t === 'pong') return { kind: 'pong' };
  if (o.t === 'hello') return { kind: 'hello', caps: normalizeCaps(o.caps) };
  if (o.t === 'filter') {
    const drop = Array.isArray(o.drop) ? o.drop.filter((d): d is string => typeof d === 'string' && !!d) : [];
    return { kind: 'filter', drop };
  }
  return null;
}

/**
 * 解析客户端→服务端全部帧（含业务帧）：合法 JSON 不一定是协议对象（null/数组/
 * 标量/字段类型不对都是畸形帧），一律返回 null 由调用方按约定静默丢弃。
 * 只做结构解码，不承担鉴权/owner 校验（那是 server 分派层的职责）。
 */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  const ctrl = parseClientControl(raw);
  if (ctrl) return ctrl;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.t === 'invoke' && typeof o.id === 'number' && Number.isFinite(o.id) && typeof o.channel === 'string') {
    return { kind: 'invoke', id: o.id, channel: o.channel, args: o.args };
  }
  if (o.t === 'send' && typeof o.channel === 'string') {
    return { kind: 'send', channel: o.channel, args: Array.isArray(o.args) ? o.args : [] };
  }
  return null;
}

/* ─────────────────────────── 兴趣 / 过滤 ─────────────────────────── */

/** stream=false 时丢弃的流式热区（保留 agent:message / agent:history 对账） */
export const STREAM_DROP_CHANNELS = ['agent:token', 'agent:thinking'] as const;
/** terminal=false 时丢弃的终端热区 */
export const TERMINAL_DROP_CHANNELS = [
  'pty:data',
  'pty:exit',
  'pty:respawn',
  'terminal:capture-request'
] as const;

/** caps → 丢弃列表。全量兴趣（默认）返回空数组 */
export function capsDropList(caps: ClientCaps): string[] {
  const drop: string[] = [];
  if (caps.terminal === false) drop.push(...TERMINAL_DROP_CHANNELS);
  if (caps.stream === false) drop.push(...STREAM_DROP_CHANNELS);
  return drop;
}

/**
 * 是否应跳过向该客户端广播 channel。
 * drop 为 null/undefined = 未声明兴趣 → 不丢（向后兼容，保持 test/web-access.mjs 行为）。
 */
export function shouldDropChannel(drop: readonly string[] | null | undefined, channel: string): boolean {
  if (!drop || drop.length === 0) return false;
  return drop.includes(channel);
}

/** hello+filter 合并：以显式 filter 覆盖（整表替换） */
export function mergeDropList(fromCaps: string[], explicit: string[] | null | undefined): string[] {
  if (explicit) return [...explicit];
  return [...fromCaps];
}

/* ─────────────────────────── send 可靠性 ─────────────────────────── */

export type SendReliability = 'reliable' | 'unreliable';

/** 动态回执：断线保留、重连至少一次重发（requestId 幂等，先到先得） */
export const RELIABLE_SEND_PREFIXES = ['ui:confirm:', 'ui:dialog:', 'terminal:capture:'] as const;
/** fire-and-forget：断线可丢；发送时若已非 OPEN 仍入 outbox 尽量送达 */
export const UNRELIABLE_SEND_CHANNELS = new Set(['pty:input', 'pty:resize', 'sessions:touch-used']);

export function isReliableSend(channel: string): boolean {
  return RELIABLE_SEND_PREFIXES.some((p) => channel.startsWith(p));
}

export function sendReliability(channel: string): SendReliability {
  return isReliableSend(channel) ? 'reliable' : 'unreliable';
}

/* ─────────────────────────── outbox（可靠重发） ─────────────────────────── */

export interface OutboxItem {
  /** 序列化后的 WS 文本帧 */
  text: string;
  reliable: boolean;
  channel: string;
  /** flush 时 send 抛错的累计次数 */
  attempts: number;
}

/** 入队。容量满时优先丢最旧的不可靠帧；全为可靠帧时丢最旧可靠帧（有界队列下「至少一次」的例外） */
export function outboxEnqueue(
  outbox: readonly OutboxItem[],
  item: { text: string; reliable: boolean; channel: string },
  max: number = OUTBOX_MAX
): OutboxItem[] {
  const next = [...outbox, { ...item, attempts: 0 }];
  while (next.length > max) {
    const i = next.findIndex((x) => !x.reliable);
    if (i >= 0) next.splice(i, 1);
    else next.shift();
  }
  return next;
}

/** 断线：不可靠帧可丢，可靠帧原样保留（重连 onopen 重发） */
export function outboxOnDisconnect(outbox: readonly OutboxItem[]): OutboxItem[] {
  return outbox.filter((x) => x.reliable);
}

export interface OutboxFlushResult {
  /** 未发出的（含 send 抛错后剩余的全部，顺序保持） */
  remaining: OutboxItem[];
  /** 可靠帧累计失败超限，应给用户可见错误并放弃 */
  giveUp: OutboxItem[];
}

/**
 * onopen 冲刷：逐条 send；中途抛错则**当前及之后全部保留在 remaining**（不整段丢）。
 * 成功发出的帧从 outbox 消费掉。
 */
export function outboxFlush(
  outbox: readonly OutboxItem[],
  send: (text: string) => void,
  maxAttempts: number = RELIABLE_FLUSH_ATTEMPTS_MAX
): OutboxFlushResult {
  const remaining: OutboxItem[] = [];
  const giveUp: OutboxItem[] = [];
  let blocked = false;
  for (const item of outbox) {
    if (blocked) {
      remaining.push(item);
      continue;
    }
    try {
      send(item.text);
    } catch {
      blocked = true;
      const next: OutboxItem = { ...item, attempts: item.attempts + 1 };
      if (next.reliable && next.attempts >= maxAttempts) giveUp.push(next);
      else remaining.push(next);
    }
  }
  return { remaining, giveUp };
}

/* ─────────────────────────── token 来源 ─────────────────────────── */

/** Cookie 里读 token；无则空串 */
export function extractCookieToken(cookieHeader: string, name: string = TOKEN_COOKIE_NAME): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return '';
}

/**
 * token 来源优先级：`?token=` query > Cookie `ma_web_token` > 空。
 * **不读写 localStorage**（轮换后旧 token 粘住会导致 4001）。
 */
export function resolveWebToken(search: string, cookieHeader: string): string {
  try {
    const q = new URLSearchParams(search).get('token');
    if (q && q.trim()) return q.trim();
  } catch {
    /* ignore */
  }
  return extractCookieToken(cookieHeader);
}

/** URL 上的 token 与当前不一致（用户用新链接打开了本页）→ 应立即采用并重试 */
export function shouldAdoptUrlToken(current: string, search: string): boolean {
  try {
    const q = new URLSearchParams(search).get('token');
    return !!q && q.trim() !== '' && q.trim() !== current;
  } catch {
    return false;
  }
}

/* ─────────────────────────── 候选地址（last-good 优先） ─────────────────────────── */

export interface CandidateState {
  candidates: string[];
  lastGood: string | null;
  /** 下次 connect 是否先试 lastGood */
  preferLastGood: boolean;
  idx: number;
  /** 覆盖地址（?ws=/localStorage）是唯一候选且尚未回退到 defaults */
  overrideOnly: boolean;
}

export function createCandidateState(opts: { override: string | null | undefined; defaults: string[] }): CandidateState {
  const override = opts.override?.trim() || '';
  if (override) {
    return {
      candidates: [override],
      lastGood: null,
      preferLastGood: false,
      idx: 0,
      overrideOnly: true
    };
  }
  return {
    candidates: [...opts.defaults],
    lastGood: null,
    preferLastGood: false,
    idx: 0,
    overrideOnly: false
  };
}

export function pickConnectBase(state: CandidateState): string | null {
  if (state.preferLastGood && state.lastGood) return state.lastGood;
  return state.candidates[state.idx] ?? state.candidates[0] ?? null;
}

export function onConnectSuccess(state: CandidateState, base: string): CandidateState {
  const idx = state.candidates.indexOf(base);
  return {
    ...state,
    lastGood: base,
    preferLastGood: true,
    idx: idx >= 0 ? idx : state.idx
  };
}

/**
 * 连接失败后的下一轮状态：
 * - 若在试 lastGood：停止偏好，轮换其它候选；
 * - 若覆盖地址是唯一候选：回退并入 defaultCandidates（旧 IP 不粘死），defaults 优先；
 * - 否则环形轮换。
 */
export function onConnectFailure(state: CandidateState, defaults: string[]): CandidateState {
  if (state.preferLastGood && state.lastGood) {
    let candidates = state.candidates;
    let overrideOnly = state.overrideOnly;
    if (overrideOnly && candidates.length === 1) {
      candidates = expandWithDefaults(candidates, defaults);
      overrideOnly = false;
    }
    const nextIdx = candidates.findIndex((c) => c !== state.lastGood);
    return {
      ...state,
      candidates,
      overrideOnly,
      preferLastGood: false,
      idx: nextIdx >= 0 ? nextIdx : 0
    };
  }
  let candidates = state.candidates;
  let overrideOnly = state.overrideOnly;
  if (overrideOnly && candidates.length === 1) {
    const failed = candidates[0];
    candidates = expandWithDefaults(candidates, defaults);
    overrideOnly = false;
    // 刚失败的覆盖地址放到轮换末尾，下一家先试 default
    const rest = candidates.filter((c) => c !== failed);
    candidates = rest.length > 0 ? [...rest, failed] : candidates;
    return { ...state, candidates, overrideOnly, preferLastGood: false, idx: 0 };
  }
  const nextIdx = candidates.length ? (state.idx + 1) % candidates.length : 0;
  return { ...state, candidates, overrideOnly, preferLastGood: false, idx: nextIdx };
}

function expandWithDefaults(current: string[], defaults: string[]): string[] {
  return [...new Set([...defaults, ...current])];
}

/* ─────────────────────────── 心跳半开判定 ─────────────────────────── */

/** 超过 timeout 未收到任何帧 → 半开 */
export function isHalfOpen(lastRxAt: number, now: number, timeoutMs: number = HEARTBEAT_TIMEOUT_MS): boolean {
  if (!lastRxAt) return true;
  return now - lastRxAt > timeoutMs;
}

/* ─────────────────────────── 移动端默认兴趣 ─────────────────────────── */

/**
 * 手机表面默认不订终端/流式热区（弱网防洪泛）；桌面 web 默认全量。
 * 也可显式再叠 drop 列表（如额外丢 pty:data）。
 */
export function defaultWebCaps(opts: { mobile: boolean }): ClientCaps {
  return opts.mobile ? { terminal: false, stream: false } : { terminal: true, stream: true };
}
