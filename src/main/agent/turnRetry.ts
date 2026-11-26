/**
 * 调度回合级自动重试的判定与节奏（纯逻辑，供 mjs 层测试）。
 * 背景：本机跑重测试链期间，LLM 的 SSE 流会被整窗掐断（每次请求 usage=0 瞬败、
 * pi 请求级重试全败），调度在窗口内完全不可用。请求级重试预算放宽（piConfigSync
 * 写入 settings.json）约能扛 2 分钟；更长的窗口靠回合失败后延时重发兜底。
 *
 * 2026-09-16 补：同会话请求级/回合级重试救不了「stream ended before a terminal
 * response event」——用户切同一模型即愈，因为 switchModel 会 dispose 活会话。
 * 失败收口必须按本回合 assistant 判定（display 末条在 busy 排队时是用户消息），
 * 丢掉活会话后再重发，行为对齐切模型。
 */

/** 瞬态服务错误文案模式（对齐 pi-ai retry.js 的可重试类；4xx/额度类确定性错误不在列） */
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /stream ended before a terminal response event/i,
  /stream ended without a stop reason/i,
  /request timed out/i,
  /terminated/i,
  /socket hang up/i,
  /other side closed/i,
  /fetch failed/i,
  /connection (?:error|refused|lost|reset)/i,
  /upstream connect/i,
  /reset before headers/i,
  /network error/i,
  /websocket (?:closed|error)/i,
  // Node syscall / undici：TUN 切换、代理闪断常见（「read ECONNRESET」不含 connection 一词）
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /EPIPE/i
];

/**
 * 网络层 / 传输中止：GUI Worker 在飞回合可自动续作的类别。
 * `[aborted]` 是引擎把传输掐死后的 run status（实例：`[unknown] [aborted] read ECONNRESET`），
 * 不是用户点停止——用户中止走 abortRequested，不进这里。
 * 不匹配「summarization aborted」这类压缩文案。
 */
const NETWORK_TURN_ERROR_PATTERNS: RegExp[] = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /EPIPE/i,
  /socket hang up/i,
  /other side closed/i,
  /fetch failed/i,
  /network error/i,
  /connection (?:error|refused|lost|reset)/i,
  /request timed out/i,
  /\[aborted\]/i,
  /\bAbortError\b/i
];

/** 活会话粘住的断流：同会话再请求仍死，必须 dispose 重建（切模型的实际生效点） */
const STICKY_SESSION_ERROR_PATTERNS: RegExp[] = [
  /stream ended before a terminal response event/i,
  /stream ended without a stop reason/i
];

/** 是否瞬态服务错误：值得自动重试；返回 false 的（如 401/402/上下文超限）直接报错等人工 */
export function isTransientProviderError(errorMessage: string | undefined | null): boolean {
  if (!errorMessage) return false;
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(errorMessage));
}

/** 网络/传输中止：GUI 在飞回合续作与调度 turn_error 上报共用这一类 */
export function isNetworkTurnError(errorMessage: string | undefined | null): boolean {
  if (!errorMessage) return false;
  if (/summarization aborted/i.test(errorMessage)) return false;
  return NETWORK_TURN_ERROR_PATTERNS.some((p) => p.test(errorMessage));
}

/** 每个连续失败序列的自动重试上限（不含首次失败；超过则只报错，等人工重试） */
export const TURN_AUTO_RETRY_MAX = 3;

/** 第 attempt 次（1 起）自动重试前的等待：30s 起步翻倍，封顶 2 分钟 → 30s/60s/120s */
export function turnAutoRetryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (Math.max(1, attempt) - 1), 120_000);
}

/** 同会话重试无效、必须重建 Pi 会话的断流（切同一模型即愈的那类） */
export function isStickySessionError(errorMessage: string | undefined | null): boolean {
  if (!errorMessage) return false;
  return STICKY_SESSION_ERROR_PATTERNS.some((p) => p.test(errorMessage));
}

export interface OrchestratorTurnClosePlan {
  failed: boolean;
  invalidateSession: boolean;
  drainQueue: boolean;
  /** null = 不安排回合级重试 */
  retryDelayMs: number | null;
}

/** retry 定位所需的最小消息形状（display 里的消息远不止这些字段） */
export interface RetryScanMessage {
  role: string;
  error?: string | null;
  queued?: boolean;
}

/**
 * 定位可重试的失败回合：从 display 尾部向前找最近一条带 error 的 assistant。
 * 失败回合常被 busy 期间排队/插话的消息垫在后面（它们还没被处理，不构成「失败之后
 * 又有新进展」），跳过；但先撞到一条无 error 的 assistant 说明失败之后已有成功回合，
 * 旧失败不可再重试。返回失败 assistant 的下标，无可重试返回 -1。
 */
export function locateRetryableTurn(display: RetryScanMessage[]): number {
  for (let i = display.length - 1; i >= 0; i--) {
    const m = display[i]!;
    if (m.role !== 'assistant') continue;
    return m.error ? i : -1;
  }
  return -1;
}

/**
 * 从失败 assistant 向前找重发源用户消息（host 手动重试与调度 retry 共用回扫）：
 * 跳过 busy 期间排队/插话垫在后面的消息，命中第一条匹配即返回；找不到返回 null。
 * match 由调用方给定（GUI 面不含 host 通栏，调度面还要排除 host 注入）。
 */
export function findRetrySourceMessage<T>(
  display: readonly T[],
  failedIdx: number,
  match: (m: T) => boolean
): T | null {
  for (let i = failedIdx - 1; i >= 0; i--) {
    const m = display[i]!;
    if (match(m)) return m;
  }
  return null;
}

/**
 * 调度回合收口决策。失败看本回合 assistant，不看 display 末条——busy 时编排事件
 * 会把用户/宿主消息垫在后面，用末条判断会把失败当成成功并立刻 drain 到坏会话上。
 *
 * 本回合已执行过工具（toolCallCount > 0）时不自动重试：重发会把写操作（提交、
 * 写文件、发消息）重放一遍且模型对已跑过的部分记忆不完整；这种失败只报错等人工。
 */
export function planOrchestratorTurnClose(input: {
  assistantError?: string | null;
  queueLength: number;
  nextRetryAttempt: number;
  toolCallCount?: number;
}): OrchestratorTurnClosePlan {
  const failed = !!input.assistantError;
  if (!failed) {
    return {
      failed: false,
      invalidateSession: false,
      drainQueue: input.queueLength > 0,
      retryDelayMs: null
    };
  }
  const transient = isTransientProviderError(input.assistantError);
  const sticky = isStickySessionError(input.assistantError);
  const sideEffectFree = (input.toolCallCount ?? 0) === 0;
  let retryDelayMs: number | null = null;
  if (
    transient &&
    sideEffectFree &&
    input.nextRetryAttempt >= 1 &&
    input.nextRetryAttempt <= TURN_AUTO_RETRY_MAX
  ) {
    retryDelayMs = sticky ? 0 : turnAutoRetryDelayMs(input.nextRetryAttempt);
  }
  return {
    failed: true,
    invalidateSession: true,
    drainQueue: false,
    retryDelayMs
  };
}

/** AppConfig.guiTurnRetry：GUI Worker 网络断连后续作（缺省开） */
export interface GuiTurnRetryConfig {
  /** 缺省 true */
  enabled?: boolean;
  /** 连续续作上限（不含首次失败），缺省 3 */
  maxRetries?: number;
  /** 首次退避毫秒，之后指数翻倍，缺省 2000 */
  baseDelayMs?: number;
  /** 退避封顶毫秒，缺省 30000 */
  maxDelayMs?: number;
}

export type NormalizedGuiTurnRetryConfig = {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const GUI_TURN_RETRY_DEFAULTS: NormalizedGuiTurnRetryConfig = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000
};

const GUI_RETRY_MAX_MIN = 1;
const GUI_RETRY_MAX_MAX = 8;
const GUI_RETRY_BASE_MIN = 100;
const GUI_RETRY_BASE_MAX = 60_000;
const GUI_RETRY_CAP_MAX = 120_000;

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const n = Math.round(raw);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function normalizeGuiTurnRetryConfig(raw: unknown): NormalizedGuiTurnRetryConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...GUI_TURN_RETRY_DEFAULTS };
  }
  const o = raw as GuiTurnRetryConfig;
  const baseDelayMs = clampInt(
    o.baseDelayMs,
    GUI_RETRY_BASE_MIN,
    GUI_RETRY_BASE_MAX,
    GUI_TURN_RETRY_DEFAULTS.baseDelayMs
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    clampInt(o.maxDelayMs, baseDelayMs, GUI_RETRY_CAP_MAX, GUI_TURN_RETRY_DEFAULTS.maxDelayMs)
  );
  return {
    enabled: o.enabled !== false,
    maxRetries: clampInt(
      o.maxRetries,
      GUI_RETRY_MAX_MIN,
      GUI_RETRY_MAX_MAX,
      GUI_TURN_RETRY_DEFAULTS.maxRetries
    ),
    baseDelayMs,
    maxDelayMs
  };
}

/** 第 attempt 次（1 起）GUI 续作前等待：base 起步翻倍，封顶 maxDelay */
export function guiTurnRetryDelayMs(
  attempt: number,
  cfg: Pick<NormalizedGuiTurnRetryConfig, 'baseDelayMs' | 'maxDelayMs'> = GUI_TURN_RETRY_DEFAULTS
): number {
  const n = Math.max(1, attempt);
  return Math.min(cfg.baseDelayMs * 2 ** (n - 1), cfg.maxDelayMs);
}

export type GuiTurnRetryPlan =
  | {
      action: 'retry';
      delayMs: number;
      mode: 'resend' | 'continue';
      attempt: number;
      max: number;
    }
  | { action: 'fail'; report: 'network_error' | 'none' };

/**
 * GUI 在飞回合失败后的续作决策。用户点停止不续作、不上报。
 * 网络/传输中止才续作：无进度则重发原用户消息，已有思考/正文/工具则发续作提示
 * （不重放已执行工具）。次数用尽或关闭配置 → 上报调度 turn_error。
 */
export function planGuiTurnRetry(input: {
  errorMessage: string | undefined | null;
  userAborted: boolean;
  nextAttempt: number;
  hasProgress: boolean;
  config: NormalizedGuiTurnRetryConfig;
}): GuiTurnRetryPlan {
  if (input.userAborted) return { action: 'fail', report: 'none' };
  if (!isNetworkTurnError(input.errorMessage)) return { action: 'fail', report: 'none' };
  if (!input.config.enabled) return { action: 'fail', report: 'network_error' };
  if (input.nextAttempt < 1 || input.nextAttempt > input.config.maxRetries) {
    return { action: 'fail', report: 'network_error' };
  }
  return {
    action: 'retry',
    delayMs: guiTurnRetryDelayMs(input.nextAttempt, input.config),
    mode: input.hasProgress ? 'continue' : 'resend',
    attempt: input.nextAttempt,
    max: input.config.maxRetries
  };
}

/** assistant 本回合是否已产出内容（决定 resend vs continue） */
export function guiTurnHasProgress(assistant: {
  parts?: ReadonlyArray<{ kind: string; text?: string }>;
} | null | undefined): boolean {
  if (!assistant?.parts?.length) return false;
  return assistant.parts.some((p) => {
    if (p.kind === 'tool') return true;
    if (p.kind === 'text' || p.kind === 'thinking') return Boolean(p.text?.trim());
    return false;
  });
}
