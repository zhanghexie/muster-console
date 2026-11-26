/** Shared mailbox headers, legacy parsing and optional question/reply projections.
 * Host userData owns durable immutable bodies; listing does not consume mail.
 * Old inline delivered/session_ended entries remain compatible history.
 */
import { coerceSourceAgentIdentity, type SourceAgentIdentity } from './subagentCharacters';
/** Full letters are stored separately from the small mailbox index. Oversize input is rejected. */
export const AGENT_MESSAGE_TEXT_MAX = 262144;
export const AGENT_MESSAGE_PREVIEW_CHARS = 240;

export type AgentMessageReceipt = 'stored' | 'delivered' | 'session_ended';

export function isAgentMessageId(value: string): boolean {
  return /^m-\d+$/.test(value) || /^mail-[a-f0-9-]{36}$/.test(value);
}

/** 留言种类（O4）：提问/答复/知会/交接，缺省 notice */
export type AgentMessageKind = 'ask' | 'answer' | 'notice' | 'handoff';

/**
 * 收信哨兵：to='scheduler' 在宿主规范为工作区调度邮箱 orchestrator:<workspaceId>。
 * from 侧哨兵沿用 'host'（宿主/调度名义）与 'human'（人代答）。
 */
export const AGENT_MESSAGE_SCHEDULER_TARGET = 'scheduler';

/**
 * 结构化上下文（可选，additive）：提问对外句柄、答复锚点、语义子类与 UI chips。
 * 不开第二套存储——这些字段只是账本条目上的标注，提问/答复生命周期仍由派生视图计算。
 */
export interface AgentMessageMeta {
  /** Host-created assignment for a GUI Worker. */
  initialAssignment?: true;
  /** Host-only event routing; model content is resolved at dispatch, not exposed as a letter. */
  hostNotification?: import('./hostNotification').HostNotificationRef;
  /** Trusted host marks parent-to-child interruption mail; immutable for idempotency. */
  interrupt?: true;
  eventId?: string;
  subscriptionIds?: string[];
  digest?: true;
  subscriptionEvent?: true;
  /** 提问对外句柄（预生成 uuid；注入文案里展示，答复可引用） */
  askId?: string;
  /** answer 指向的 askId */
  replyAskId?: string;
  /** 语义子类：decision|blocked|notice|question|decision_request */
  tag?: string;
  /** Host notification identity; persisted so reattaching listeners cannot resend the same event. */
  notificationKey?: string;
  /** 业务条目引用（可选） */
  itemId?: string;
  /** 文件:行 */
  loc?: string;
  /** 隔离分支 */
  branch?: string;
  /** 提问用途：普通提问 / 合入知会 */
  intent?: 'ask' | 'integrate';
}

export const AGENT_MESSAGE_KINDS: readonly AgentMessageKind[] = [
  'ask',
  'answer',
  'notice',
  'handoff'
];

export function isAgentMessageKind(v: unknown): v is AgentMessageKind {
  return typeof v === 'string' && AGENT_MESSAGE_KINDS.includes(v as AgentMessageKind);
}

/** 旧账本文件名，仅供发布前诊断和显式 reset 识别，运行时不读取。 */
export const AGENT_MESSAGES_FILE = 'messages.json';
export const AGENT_MESSAGES_SCHEMA_VERSION = 1;

/** Legacy compatibility constant; mailbox retention no longer drops messages by count. */
export const AGENT_MESSAGES_MAX = 200;

export interface InitialAssignmentReceipt {
  reservationId: string;
  turnMessageId: string;
  bodyEnd: number;
  deliveredAt?: number;
}

export interface AgentMessageLedgerEntry {
  sourceAgent?: SourceAgentIdentity;
  interruption?: 'pending' | 'requested' | 'stopped' | 'delivering' | 'accepted';
  deliveryMethod?: import('./runtimeCommunication').RuntimeDeliveryMethod;
  /** Native channel may have accepted input; automatic retries are unsafe. */
  wakeUncertain?: true;
  /** New mail-UUID, or legacy m-seq. */
  id: string;
  /** Monotonic mailbox position, independent of wall clock and read receipts. Legacy indexes derive it on read. */
  sequence?: number;
  /** 发信会话 id；宿主/调度名义发送为 'host'，人代答为 'human' */
  from: string;
  /** 收信会话 id；'scheduler' = 发给调度 Agent */
  to: string;
  kind: AgentMessageKind;
  /** 回复的消息 id（须已存在于账本） */
  replyTo?: string;
  /** 结构化上下文（可选） */
  meta?: AgentMessageMeta;
  text: string;
  ts: number;
  receipt: AgentMessageReceipt;
  /** Recipient AI opened the body; not a processing or completion receipt. */
  read: boolean;
  subject?: string;
  fromName?: string;
  toName?: string;
  /** Present when text is only the preview of an immutable body file. */
  bodyChars?: number;
  readAt?: number;
  notifiedAt?: number;
  /** Latest retryable admission deferral. */
  wakeDeferred?: string;
  /** A subscription event must use idle admission after native interjection declined. */
  wakeAtIdle?: true;
  wakeError?: string;
  /** Reservation without deliveredAt may already have reached the native engine. */
  initialAssignmentReceipt?: InitialAssignmentReceipt;
}

export interface MailWakeReceipt {
  notifiedAt?: number;
  deliveryMethod?: AgentMessageLedgerEntry['deliveryMethod'];
  wakeUncertain?: true;
  wakeError?: string;
  wakeDeferred?: { reason: string; retryWhileUnread: true };
}

export interface MailSendWakeReceipt extends MailWakeReceipt {
  wake?: 'pending' | 'disabled' | 'deferred' | 'notified';
}

export function publicMailWakeReceipt(message: AgentMessageLedgerEntry, read = message.read): MailWakeReceipt {
  if (read) return {};
  return {
    ...(message.notifiedAt !== undefined ? { notifiedAt: message.notifiedAt } : {}),
    ...(message.deliveryMethod ? { deliveryMethod: message.deliveryMethod } : {}),
    ...(message.wakeUncertain ? { wakeUncertain: true as const } : {}),
    ...(message.wakeError ? { wakeError: message.wakeError } : {}),
    ...(!message.wakeUncertain && !message.wakeError && message.wakeDeferred ? {
      wakeDeferred: { reason: message.wakeDeferred, retryWhileUnread: true as const }
    } : {})
  };
}

export function isPendingInitialAssignment(message: AgentMessageLedgerEntry): boolean {
  return message.meta?.initialAssignment === true && message.receipt === 'stored' &&
    !message.read && !message.notifiedAt && !message.wakeUncertain && !message.initialAssignmentReceipt;
}

export function initialAssignmentStatus(message: AgentMessageLedgerEntry) {
  if (!message.meta?.initialAssignment) return undefined;
  const receipt = message.initialAssignmentReceipt;
  if (receipt?.deliveredAt !== undefined) {
    return { state: 'delivered' as const, turnMessageId: receipt.turnMessageId,
      deliveredAt: receipt.deliveredAt, bodyEnd: receipt.bodyEnd };
  }
  if (receipt || message.wakeUncertain) return { state: 'unconfirmed' as const };
  return { state: message.read || message.notifiedAt ? 'not-delivered' as const : 'pending' as const };
}

export interface AgentMessageLedger {
  schemaVersion: number;
  seq: number;
  messages: AgentMessageLedgerEntry[];
}

export function emptyAgentMessageLedger(): AgentMessageLedger {
  return { schemaVersion: AGENT_MESSAGES_SCHEMA_VERSION, seq: 0, messages: [] };
}

export function serializeAgentMessageLedger(ledger: AgentMessageLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

const legacyWakeDeferrals = new Set([
  '当前接入尚未就绪或未确认空闲，等待状态变化',
  '当前接入暂未受理',
  '等待当前回合结束后重查未读信',
  '等待终端确认空闲后重查未读信',
  '终端引擎会话或工作目录尚未就绪'
]);

function coerceLedgerEntry(v: unknown): AgentMessageLedgerEntry | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === 'string' && isAgentMessageId(o.id.trim()) ? o.id.trim() : '';
  const from = typeof o.from === 'string' && o.from.trim() ? o.from.trim().slice(0, 100) : '';
  const to = typeof o.to === 'string' && o.to.trim() ? o.to.trim().slice(0, 100) : '';
  const ts = Number.isFinite(o.ts) ? Math.floor(o.ts as number) : null;
  const receipt = o.receipt === 'stored' || o.receipt === 'delivered' || o.receipt === 'session_ended' ? o.receipt : null;
  const kind = isAgentMessageKind(o.kind) ? o.kind : null;
  if (!id || !from || !to || ts === null || !receipt || !kind) return null;
  const text = typeof o.text === 'string' ? o.text.slice(0, AGENT_MESSAGE_TEXT_MAX) : '';
  const replyTo =
    typeof o.replyTo === 'string' && isAgentMessageId(o.replyTo.trim()) ? o.replyTo.trim() : undefined;
  const meta = coerceAgentMessageMeta(o.meta);
  const legacyWakeError = typeof o.wakeError === 'string' ? o.wakeError.slice(0, 500) : '';
  const interjectFallback = legacyWakeError.startsWith('interject-fallback:');
  const wasDeferred = interjectFallback || legacyWakeDeferrals.has(legacyWakeError);
  const wakeDeferred = typeof o.wakeDeferred === 'string' ? o.wakeDeferred.slice(0, 500) :
    interjectFallback ? '等待调度空闲后投递' : wasDeferred ? legacyWakeError : '';
  const assignment = o.initialAssignmentReceipt as Partial<InitialAssignmentReceipt> | undefined;
  const initialAssignmentReceipt = meta?.initialAssignment && assignment && typeof assignment.reservationId === 'string' &&
    typeof assignment.turnMessageId === 'string' && typeof assignment.bodyEnd === 'number' &&
    Number.isSafeInteger(assignment.bodyEnd) && assignment.bodyEnd > 0 ? {
      reservationId: assignment.reservationId,
      turnMessageId: assignment.turnMessageId,
      bodyEnd: assignment.bodyEnd,
      ...(typeof assignment.deliveredAt === 'number' && Number.isFinite(assignment.deliveredAt) ?
        { deliveredAt: assignment.deliveredAt } : {})
    } : undefined;
  return {
    id,
    ...(Number.isSafeInteger(o.sequence) && (o.sequence as number) > 0 ? { sequence: o.sequence as number } : {}),
    from,
    to,
    kind,
    ...(replyTo ? { replyTo } : {}),
    ...(meta ? { meta } : {}),
    text,
    ts,
    receipt,
    read: o.read === true,
    ...(coerceSourceAgentIdentity(o.sourceAgent) ? { sourceAgent: coerceSourceAgentIdentity(o.sourceAgent) } : {}),
    ...(['pending', 'requested', 'stopped', 'delivering', 'accepted'].includes(String(o.interruption)) ? { interruption: o.interruption as AgentMessageLedgerEntry['interruption'] } : {}),
    ...(['sent', 'steered', 'queued', 'stopped-and-sent', 'written'].includes(String(o.deliveryMethod))
      ? { deliveryMethod: o.deliveryMethod as import('./runtimeCommunication').RuntimeDeliveryMethod } : {}),
    ...(o.wakeUncertain === true || meta?.initialAssignment && o.initialAssignmentReceipt !== undefined && !initialAssignmentReceipt ?
      { wakeUncertain: true as const } : {}),
    ...(typeof o.subject === 'string' ? { subject: o.subject.slice(0, 200) } : {}),
    ...(typeof o.fromName === 'string' ? { fromName: o.fromName.slice(0, 200) } : {}),
    ...(typeof o.toName === 'string' ? { toName: o.toName.slice(0, 200) } : {}),
    ...(typeof o.bodyChars === 'number' && o.bodyChars >= 0 ? { bodyChars: o.bodyChars } : {}),
    ...(typeof o.readAt === 'number' ? { readAt: o.readAt } : {}),
    ...(typeof o.notifiedAt === 'number' ? { notifiedAt: o.notifiedAt } : {}),
    ...(wakeDeferred ? { wakeDeferred } : {}),
    ...(o.wakeAtIdle === true || interjectFallback ? { wakeAtIdle: true as const } : {}),
    ...(legacyWakeError && !wasDeferred && legacyWakeError !== 'interjection pending' ? { wakeError: legacyWakeError } : {}),
    ...(initialAssignmentReceipt ? { initialAssignmentReceipt } : {})
  };
}

function clipMetaStr(v: unknown, max: number): string | undefined {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s || undefined;
}

/** meta 容错：坏字段丢弃、字符串裁剪；整体为空返回 undefined */
export function coerceAgentMessageMeta(v: unknown): AgentMessageMeta | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const meta: AgentMessageMeta = {
    ...(o.initialAssignment === true ? { initialAssignment: true as const } : {}),
    ...(o.hostNotification && typeof o.hostNotification === 'object' && ['app', 'event'].includes((o.hostNotification as { kind: string }).kind)
      ? { hostNotification: { kind: (o.hostNotification as { kind: 'app' | 'event' }).kind,
        ...(clipMetaStr((o.hostNotification as Record<string, unknown>).appId, 64) ? { appId: clipMetaStr((o.hostNotification as Record<string, unknown>).appId, 64)! } : {}),
        ...(clipMetaStr((o.hostNotification as Record<string, unknown>).eventId, 200) ? { eventId: clipMetaStr((o.hostNotification as Record<string, unknown>).eventId, 200)! } : {}) } } : {}),
    ...(o.interrupt === true ? { interrupt: true as const } : {}),
    ...(clipMetaStr(o.eventId, 160) ? { eventId: clipMetaStr(o.eventId, 160)! } : {}),
    ...(Array.isArray(o.subscriptionIds) ? { subscriptionIds: o.subscriptionIds.filter((id): id is string => typeof id === 'string').slice(0, 20) } : {}),
    ...(o.digest === true ? { digest: true as const } : {}),
    ...(o.subscriptionEvent === true ? { subscriptionEvent: true as const } : {}),
    ...(clipMetaStr(o.askId, 64) ? { askId: clipMetaStr(o.askId, 64)! } : {}),
    ...(clipMetaStr(o.replyAskId, 64) ? { replyAskId: clipMetaStr(o.replyAskId, 64)! } : {}),
    ...(clipMetaStr(o.tag, 24) ? { tag: clipMetaStr(o.tag, 24)! } : {}),
    ...(clipMetaStr(o.notificationKey, 160) ? { notificationKey: clipMetaStr(o.notificationKey, 160)! } : {}),
    ...(clipMetaStr(o.itemId, 120) ? { itemId: clipMetaStr(o.itemId, 120)! } : {}),
    ...(clipMetaStr(o.loc, 240) ? { loc: clipMetaStr(o.loc, 240)! } : {}),
    ...(clipMetaStr(o.branch, 200) ? { branch: clipMetaStr(o.branch, 200)! } : {}),
    ...(o.intent === 'ask' || o.intent === 'integrate' ? { intent: o.intent } : {})
  };
  return Object.keys(meta).length ? meta : undefined;
}

/** Legacy parsing retains every letter. The store rejects invalid/duplicate rows before writing. */
export function parseAgentMessageLedger(raw: unknown): AgentMessageLedger {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return emptyAgentMessageLedger();
    }
  }
  if (typeof data !== 'object' || data === null) return emptyAgentMessageLedger();
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.messages)) return emptyAgentMessageLedger();
  const seen = new Set<string>();
  const messages: AgentMessageLedgerEntry[] = [];
  for (const item of o.messages) {
    const m = coerceLedgerEntry(item);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    messages.push(m);
  }
  let seq = Number.isFinite(o.seq) && (o.seq as number) >= 0 ? Math.floor(o.seq as number) : 0;
  for (const m of messages) {
    const n = Number(m.id.slice(2));
    if (Number.isFinite(n) && n > seq) seq = n;
    if (m.sequence && m.sequence > seq) seq = m.sequence;
  }
  seq = Math.max(seq, messages.length);
  // Before sequence existed, entries were appended in index order. This base stays
  // stable when a new entry increments both seq and length, including old FIFO indexes.
  const base = seq - messages.length;
  messages.forEach((m, i) => { m.sequence ??= base + i + 1; });
  return { schemaVersion: AGENT_MESSAGES_SCHEMA_VERSION, seq, messages: evictAgentMessages(messages) };
}

/** Compatibility helper: all mail and reply anchors are retained. */
export function evictAgentMessages(
  messages: readonly AgentMessageLedgerEntry[]
): AgentMessageLedgerEntry[] {
  // Mail and reply anchors survive traffic bursts; retention is never an implicit FIFO drop.
  return [...messages];
}

/** replyTo 校验：目标消息 id 须已存在于账本（任意会话的条目皆可回，线程锚定在账本） */
export function agentMessageReplyToExists(ledger: AgentMessageLedger, replyTo: string): boolean {
  const id = replyTo.trim();
  return !!id && ledger.messages.some((m) => m.id === id);
}

export interface AppendAgentMessageInput {
  sourceAgent?: SourceAgentIdentity;
  interruption?: 'pending' | 'requested' | 'stopped';
  id?: string;
  from: string;
  to: string;
  kind?: AgentMessageKind;
  replyTo?: string;
  meta?: AgentMessageMeta;
  text: string;
  ts: number;
  receipt: AgentMessageReceipt;
  subject?: string;
  fromName?: string;
  toName?: string;
  bodyChars?: number;
}

/** Append a mailbox header. Legacy delivered keeps its historical read flag; stored starts unread. */
export function appendAgentMessage(
  ledger: AgentMessageLedger,
  input: AppendAgentMessageInput
): { ledger: AgentMessageLedger; entry: AgentMessageLedgerEntry } {
  const seq = ledger.seq + 1;
  const entry: AgentMessageLedgerEntry = {
    id: input.id && isAgentMessageId(input.id) ? input.id : `m-${seq}`,
    sequence: seq,
    from: input.from.trim().slice(0, 100),
    ...(coerceSourceAgentIdentity(input.sourceAgent) ? { sourceAgent: coerceSourceAgentIdentity(input.sourceAgent) } : {}),
    to: input.to.trim().slice(0, 100),
    kind: input.kind ?? 'notice',
    ...(input.replyTo?.trim() ? { replyTo: input.replyTo.trim() } : {}),
    ...(coerceAgentMessageMeta(input.meta) ? { meta: coerceAgentMessageMeta(input.meta) } : {}),
    text: input.text.slice(0, AGENT_MESSAGE_TEXT_MAX),
    ts: input.ts,
    receipt: input.receipt,
    read: input.receipt === 'delivered',
      ...(input.interruption ? { interruption: input.interruption } : {}),
    ...(input.subject ? { subject: input.subject.slice(0, 200) } : {}),
    ...(input.fromName ? { fromName: input.fromName.slice(0, 200) } : {}),
    ...(input.toName ? { toName: input.toName.slice(0, 200) } : {}),
    ...(input.bodyChars !== undefined ? { bodyChars: input.bodyChars } : {})
  };
  return {
    ledger: {
      schemaVersion: AGENT_MESSAGES_SCHEMA_VERSION,
      seq,
      messages: evictAgentMessages([...ledger.messages, entry])
    },
    entry
  };
}

/** Explicit recipient-body-read receipt, idempotent by ID. */
export function markAgentMessagesRead(
  ledger: AgentMessageLedger,
  ids: readonly string[],
  now = Date.now()
): AgentMessageLedger {
  const want = new Set(ids.map((s) => s.trim()).filter(Boolean));
  if (want.size === 0) return ledger;
  return {
    ...ledger,
    messages: ledger.messages.map((m) => (want.has(m.id) && !m.read ? { ...m, read: true, readAt: now } : m))
  };
}

export interface AgentMessageOutboxQuery {
  /** worker 会话 id：只见 from/to 含自己的条目；host/调度（hostView=true）看全部 */
  actorId?: string;
  hostView?: boolean;
  unreadOnly?: boolean;
  /** 只看该时间戳（epoch ms，不含）之后的消息 */
  since?: number;
}

export interface AgentMessageOutboxResult {
  /** 过滤后的条目总数（未截断前） */
  total: number;
  /** 过滤后的未读数 */
  unread: number;
  /** 最新在前 */
  messages: AgentMessageLedgerEntry[];
}

/** 查询账本（纯函数，不改 read）：worker 强制 from/to 过滤防偷看他人私信；hostView 看全部。标读由调用方（outbox handler）在返回前落盘 */
export function queryAgentMessageOutbox(
  ledger: AgentMessageLedger,
  query: AgentMessageOutboxQuery = {}
): AgentMessageOutboxResult {
  const actor = query.actorId?.trim() ?? '';
  const visible = query.hostView
    ? ledger.messages
    : ledger.messages.filter((m) => actor !== '' && (m.from === actor || m.to === actor));
  const scoped = visible.filter((m) => {
    if (query.unreadOnly && m.read) return false;
    if (query.since !== undefined && m.ts <= query.since) return false;
    return true;
  });
  return {
    total: scoped.length,
    unread: scoped.filter((m) => !m.read).length,
    messages: [...scoped].reverse() // 最新在前
  };
}

// ---------------------------------------------------------------------------
/**
 * 回复句柄归一：`m-N` 条目 id 或 askId 句柄都认，返回可落进 meta 的锚点。
 * 两个都匹配不上返回空对象（调用方走 FIFO 兑底或拒，由调用方定）。
 */
export function resolveAskHandle(
  ledger: AgentMessageLedger,
  handle: string
): { entryId?: string; askId?: string } {
  const h = handle.trim();
  if (!h) return {};
  const byEntry = ledger.messages.find((m) => m.id === h);
  if (byEntry?.kind === 'ask') return { entryId: byEntry.id, ...(byEntry.meta?.askId ? { askId: byEntry.meta.askId } : {}) };
  const byAskId = ledger.messages.find((m) => m.kind === 'ask' && m.meta?.askId === h);
  if (byAskId) return { entryId: byAskId.id, askId: h };
  return {};
}

/**
 * close() 删掉 registry 行之后仍能回执 session_ended 的墓碑。
 * 只记结束身份（id / 工作区 / 名称），不复活会话、不投递。
 */
export type EndedSessionRef = {
  id: string;
  name?: string;
  workspaceId?: string;
  archived?: boolean;
  lifecycle?: string;
  status?: string;
  endedAt: number;
};

/** 墓碑滚动上限：超限淘汰最老（Map 插入序） */
export const ENDED_SESSION_REFS_MAX = 200;

/** 收信会话已结束：归档、lifecycle=exited 或 status=exited，不再唤醒。 */
export function isAgentMessageTargetEnded(s: {
  archived?: boolean;
  lifecycle?: string;
  status?: string;
}): boolean {
  return s.archived === true || s.lifecycle === 'exited' || s.status === 'exited';
}

export function toEndedSessionRef(
  s: {
    id: string;
    name?: string;
    workspaceId?: string;
    archived?: boolean;
    lifecycle?: string;
    status?: string;
  },
  now = Date.now()
): EndedSessionRef {
  return {
    id: s.id,
    ...(s.name?.trim() ? { name: s.name } : {}),
    ...(s.workspaceId?.trim() ? { workspaceId: s.workspaceId } : {}),
    ...(s.archived === true ? { archived: true } : {}),
    ...(s.lifecycle ? { lifecycle: s.lifecycle } : {}),
    ...(s.status ? { status: s.status } : {}),
    endedAt: now
  };
}

/** 解析容错：坏条目丢弃；id 必须非空。 */
export function parseEndedSessionRefs(raw: unknown): EndedSessionRef[] {
  if (!Array.isArray(raw)) return [];
  const out: EndedSessionRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id) continue;
    const endedAt = typeof o.endedAt === 'number' && Number.isFinite(o.endedAt) ? o.endedAt : 0;
    out.push(
      toEndedSessionRef(
        {
          id,
          ...(typeof o.name === 'string' ? { name: o.name } : {}),
          ...(typeof o.workspaceId === 'string' ? { workspaceId: o.workspaceId } : {}),
          ...(o.archived === true ? { archived: true } : {}),
          ...(typeof o.lifecycle === 'string' ? { lifecycle: o.lifecycle } : {}),
          ...(typeof o.status === 'string' ? { status: o.status } : {})
        },
        endedAt
      )
    );
  }
  return out;
}

/**
 * 记一条墓碑：同 id 覆盖并挪到最新；超 max 淘汰最老。
 * 返回新数组（不改入参）。
 */
export function rememberEndedSessionRef(
  list: readonly EndedSessionRef[],
  ref: EndedSessionRef,
  max = ENDED_SESSION_REFS_MAX
): EndedSessionRef[] {
  const next = list.filter((x) => x.id !== ref.id);
  next.push(ref);
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

export function findEndedSessionRef(
  list: readonly EndedSessionRef[],
  id: string
): EndedSessionRef | undefined {
  const key = id.trim();
  if (!key) return undefined;
  return list.find((x) => x.id === key);
}

/**
 * message 通道查收信方：先活会话，再墓碑。
 * 活会话按 archived / lifecycle / status 判定 ended；墓碑一律 ended。
 * 两边都没有 → target=undefined（调用方抛「不存在」）。
 */
export function resolveAgentMessageTarget<
  L extends { id: string; archived?: boolean; lifecycle?: string; status?: string },
  E extends { id: string; name?: string; workspaceId?: string }
>(
  live: L | undefined,
  ended: E | undefined
): { target: L | E; ended: boolean } | { target: undefined; ended: false } {
  if (live) return { target: live, ended: isAgentMessageTargetEnded(live) };
  if (ended) return { target: ended, ended: true };
  return { target: undefined, ended: false };
}
