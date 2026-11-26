/**
 * 看板推送决策（纯函数）：deriveBoardStatus 输出翻转时是否发通知、发到哪些通道。
 * 主进程在权威写入点（setPhase / applyActivitySignal）把翻转前后状态交给
 * src/main/notify/bus.ts 的 NotifyBus，由本模块单点决策，再分发桌面 toast /
 * 手机 WS（T1.2）/ 飞书卡片（T1.3）。
 *
 * 规则（docs/features/notification-system.md「推送决策与通知总线」节）：
 * 1. 仅进入 needs_you 类（waiting/blocked）/ done / error 且写入源可信才触发；
 *    同类重入（prev 与 next 同触发类）不算新翻转，不重发。
 * 2. 同会话同触发类 45s 账本去重（防快速翻转抖动重弹；账本只记真实发送，不续窗）。
 * 3. 免打扰时段拦 done/error；Worker 的 needs_you 不可关——没有任何开关或时段能拦它。
 *    调度会话（sessionId 为 orchestrator:<wsId>）的 needs_you 豁免系统通知（左下角改走条目胶囊）。
 * 4. 通道矩阵：needs_you/done/error 默认全通道（toast/mobile）；
 *    订阅端可再收紧（按设备能力），决策端只管 phase 级规则。
 */
import type { BoardStatus } from './boardStatus';
import { isOrchestratorSessionId } from './runtimeFacts';

/** 触发类。needs_you 不可关（产品规则）；done/error 允许用户在偏好里关掉（默认开） */
export type NotifyTrigger = 'needs_you' | 'done' | 'error';

/** 推送通道：toast=桌面气泡（已接）；mobile=手机表面 WS（T1.2） */
export type NotifyChannelId = 'toast' | 'mobile';

/** 可信写入源：phase 三源（model/llm/user）+ 结构化 hook + 系统事实。廉价 pty 输出不在此列。 */
export type NotifySource = 'model' | 'llm' | 'user' | 'hook' | 'system';

/** 同会话同触发类的去重窗口（信号账本，思路参考 wmux AgentDetector 的 per-cycle dedup） */
export const NOTIFY_DEDUP_WINDOW_MS = 45_000;

/** 免打扰时段（本地时间 HH:mm，支持跨零点，如 22:00–08:00；含 start 不含 end） */
export interface DndWindow {
  start: string;
  end: string;
}

/** 通知偏好（AppConfig.notify；设置页写入为 T1.4，字段全部可选） */
export interface NotifyPrefs {
  /** done 通知开关，默认 true（needs_you 无开关：不可关是产品规则） */
  done?: boolean;
  /** error 通知开关，默认 true */
  error?: boolean;
  /** 免打扰时段：拦 done/error，needs_you 照推；null/缺省=未设置 */
  dnd?: DndWindow | null;
}

/** 推导态翻转（prev 为写入前推导、next 为写入后推导；prev=null 视为首评，允许触发） */
export interface NotifyTransition {
  sessionId: string;
  prev: BoardStatus | null;
  next: BoardStatus;
  source: NotifySource;
}

export interface NotifyDecisionContext {
  /** 该 (sessionId, trigger) 上次真实发送时间戳（信号账本），无则 undefined */
  lastSentAt?: number;
  prefs?: NotifyPrefs | null;
  now: number;
}

export interface NotifyDecisionChannels {
  toast: boolean;
  mobile: boolean;
}

export interface NotifyDecision {
  send: boolean;
  trigger: NotifyTrigger | null;
  /** send=false 的原因（观测/测试用）：hidden=隐藏会话不推、no-trigger=未进入触发类或源不可信、
   *  no-flip=同类重入、pref-off=被开关关掉、dnd=免打扰拦截、dedup=45s 账本去重、
   *  scheduler=调度会话 needs_you 豁免桌面通知（气泡仍计） */
  reason?: 'hidden' | 'no-trigger' | 'no-flip' | 'pref-off' | 'dnd' | 'dedup' | 'scheduler';
  channels: NotifyDecisionChannels;
  /** send=true 时应记入信号账本的时间戳（=now）；被拦截时不出现（不续窗） */
  ledgerTs?: number;
}

const TRUSTED_SOURCES: ReadonlySet<string> = new Set(['model', 'llm', 'user', 'hook', 'system']);

/** 写入源是否可信：决策（decideNotify）与 NotifyBus 原始翻转流（onFlip，T3.3）共用同一口径 */
export function isTrustedSource(source: NotifySource): boolean {
  return TRUSTED_SOURCES.has(source);
}

const NO_CHANNELS: NotifyDecisionChannels = { toast: false, mobile: false };
const ALL_CHANNELS: NotifyDecisionChannels = { toast: true, mobile: true };

/** 推导态 → 触发类。no_signal 虽属 needsYou 分区，但属弱推断（无信号），不触发推送。 */
export function notifyTriggerOf(status: BoardStatus | null): NotifyTrigger | null {
  switch (status) {
    case 'waiting':
    case 'blocked':
      return 'needs_you';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

/** 'HH:mm' → 当日分钟数；非法返回 null */
export function parseHhmm(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 免打扰判定：含 start 不含 end；start<end 为同日窗口，start>end 跨零点；
 * start===end 或任一侧非法视为无效窗口（永不生效）。
 */
export function inDndWindow(dnd: DndWindow | null | undefined, date: Date): boolean {
  if (!dnd) return false;
  const s = parseHhmm(dnd.start);
  const e = parseHhmm(dnd.end);
  if (s === null || e === null || s === e) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/**
 * 推送决策主函数。规则顺序：源可信 → 进入触发类 → 同类不重入 →
 * 调度 needs_you 豁免 → 偏好开关（Worker needs_you 无开关）→ 免打扰（needs_you 免疫）→ 45s 账本去重。
 */
export function decideNotify(
  transition: NotifyTransition,
  ctx: NotifyDecisionContext
): NotifyDecision {
  const fail = (reason: NonNullable<NotifyDecision['reason']>, trigger: NotifyTrigger | null): NotifyDecision => ({
    send: false,
    trigger,
    reason,
    channels: NO_CHANNELS
  });

  if (!isTrustedSource(transition.source)) return fail('no-trigger', null);

  const trigger = notifyTriggerOf(transition.next);
  if (!trigger) return fail('no-trigger', null);

  // 同类重入不是翻转（如 hook blocked 后模型再报 needs_you）：不重复打扰
  if (transition.prev !== null && notifyTriggerOf(transition.prev) === trigger) {
    return fail('no-flip', trigger);
  }

  // 调度会话（orchestrator:<wsId>）needs_you 只点亮左下角气泡，不弹系统通知。
  // Worker 会话身份不含此前缀，通知逻辑照旧。done/error 不走这条豁免。
  if (trigger === 'needs_you' && isOrchestratorSessionId(transition.sessionId)) {
    return fail('scheduler', trigger);
  }

  const prefs = ctx.prefs ?? {};
  // needs_you 不可关：无开关字段、免打扰也不拦
  if (trigger !== 'needs_you') {
    if (prefs[trigger] === false) return fail('pref-off', trigger);
    if (inDndWindow(prefs.dnd, new Date(ctx.now))) return fail('dnd', trigger);
  }

  if (
    ctx.lastSentAt !== undefined &&
    ctx.now - ctx.lastSentAt < NOTIFY_DEDUP_WINDOW_MS
  ) {
    return fail('dedup', trigger);
  }

  return { send: true, trigger, channels: ALL_CHANNELS, ledgerTs: ctx.now };
}

/** 配置归一化：只收已知字段；布尔开关透传（done/errorBoundOnly），
 *  dnd 需两侧合法且不相等，其余丢弃 */
export function normalizeNotifyPrefs(raw: unknown): NotifyPrefs {
  const out: NotifyPrefs = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  if (typeof o.done === 'boolean') out.done = o.done;
  if (typeof o.error === 'boolean') out.error = o.error;
  const dnd = o.dnd;
  if (dnd && typeof dnd === 'object' && !Array.isArray(dnd)) {
    const start = (dnd as Record<string, unknown>).start;
    const end = (dnd as Record<string, unknown>).end;
    const s = parseHhmm(start);
    const e = parseHhmm(end);
    if (s !== null && e !== null && s !== e) {
      out.dnd = { start: String(start).trim(), end: String(end).trim() };
    }
  }
  return out;
}
