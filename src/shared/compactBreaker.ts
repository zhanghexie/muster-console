/**
 * B2 双熔断状态机（zcode-adoption-plan B2）：自动压缩链的 rapid-refill 与连续失败
 * 熔断，判定纯函数层（与 autoCompact.ts / microcompactPolicy.ts 同层同风格：只做
 * 状态转移，不做 IO、不调真正的压缩）。
 *
 * **ZCode 机制对齐**（refs/ZCode core/src/runtime/methods/turn-loop-state.ts:21-22、
 * 154-191）：「compact 后不足 3 个工具轮上下文再次回满 → 计 1 次 rapid refill；
 * 连续 3 次 → 停止自动压缩并报错」。本仓按**回合**粒度（调度回合=一次 LLM 链，
 * 工具轮细分在 pi 引擎内不可见）移植同款语义；连续失败熔断对应 ZCode policy 的
 * MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES 思路（缺省 2 次）。
 *
 * **reactive compact 归属（2026-09-23 spike 结论，详见 docs/features/scheduler-prompt-injection.md）**：
 * pi-coding-agent 的 AgentSession._checkCompaction 已内置「回合内超窗 → 摘除失败
 * assistant → compact → 重试一次」（agent-session.js:1658-1695，每回合一次闸
 * _overflowRecoveryAttempted，错误面由 pi-ai 导出的 isContextOverflow 结构化识别），
 * 宿主不再重复实现（pi 的 compact() 本体无单飞闸，真正的互斥是宿主两层闸：
 * orchestrator busy check-and-set 同步原子闸 + safeCompactSession 的 compactInFlight
 * WeakMap——见 piEvents.ts；宿主重复触发只会徒增并发压缩风险）。
 * 宿主补的正是 pi 缺的**跨回合**振荡熔断；超窗错误分类纯函数
 * （classifyContextOverflowMessage）保留在宿主侧，用于回合失败的结构化日志与
 * 错误面取证（模式移植自 pi-ai dist/utils/overflow.js OVERFLOW_PATTERNS）。
 *
 * **恢复条件**：用户手动 /compact 成功，或会话重建（clearHistory / 切换历史会话 /
 * 分叉——桶上状态随会话指针重置）。状态记在调度桶，纯内存（重启复位可接受，
 * 与 C1 dateKey 同惯例：重启后最坏情况是多压缩一次，不会漏压缩）。
 */

/** rapid-refill 窗口：compact 成功后 N 个回合内再次触发自动压缩 → 计 1 次 refill（ZCode 同款 3） */
export const RAPID_REFILL_TURN_WINDOW = 3;
/** 连续 N 次 rapid refill → 熔断（ZCode 同款 3） */
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
/** 连续 M 次自动压缩失败 → 熔断（ZCode policy 同思路，缺省 2） */
export const MAX_CONSECUTIVE_COMPACT_FAILURES = 2;

export type CompactBreakerTripReason = 'rapid-refill' | 'consecutive-failures';

/** 熔断状态机状态（会话级内存态；初始值即未熔断、无历史计数） */
export interface CompactBreakerState {
  /** 距上次成功的自动压缩已完成的回合数（手动压缩成功同样清零——窗口语义一致） */
  turnsSinceCompact: number;
  /** 连续 rapid refill 计数（某次自动压缩触发时窗口已过 → 归零，ZCode evaluateRapidRefill 同款） */
  refillStreak: number;
  /** 连续自动压缩失败计数（成功归零） */
  failureStreak: number;
  /** true=已熔断：自动压缩链停（0.8 全量 / 0.72 微压缩 / idle 微压缩都跳过），手动 /compact 不受限 */
  tripped: boolean;
  /** 熔断原因（tripped 时有值） */
  trippedReason?: CompactBreakerTripReason;
  /** 熔断发生时间（ms，日志/面板信号用） */
  trippedAt?: number;
  /**
   * 上次成功压缩（自动或手动）的时间戳；**undefined=从未压缩过**。首次达阈值触发的
   * 压缩是正常行为不是振荡，不计 refill（ZCode evaluateRapidRefill 对 undefined
   * tracking 计 0 的同款口径）——refill 连击只在「已有过一次成功压缩」后才开始累计。
   */
  lastCompactAt?: number;
}

export function initialCompactBreakerState(): CompactBreakerState {
  return { turnsSinceCompact: 0, refillStreak: 0, failureStreak: 0, tripped: false };
}

/** 计数夹紧：状态只经本模块事件流转，防御性钳到合法域（外部传入损坏值不扩散） */
function clampState(s: CompactBreakerState): CompactBreakerState {
  const nonNeg = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    turnsSinceCompact: nonNeg(s.turnsSinceCompact),
    refillStreak: nonNeg(s.refillStreak),
    failureStreak: nonNeg(s.failureStreak),
    tripped: s.tripped === true,
    ...(s.tripped ? { trippedReason: s.trippedReason ?? 'rapid-refill', trippedAt: s.trippedAt } : {}),
    ...(typeof s.lastCompactAt === 'number' && Number.isFinite(s.lastCompactAt) && s.lastCompactAt > 0
      ? { lastCompactAt: s.lastCompactAt }
      : {})
  };
}

/**
 * 回合收口喂线：每完成一个回合（无论成败）窗口计数 +1。熔断态不老化（tripped
 * 只能手动恢复/重建会话），但计数照走，恢复后窗口从当前值起算（偏保守：刚恢复
 * 时窗口内余量更小，更早识别再次振荡）。
 */
export function feedBreakerTurnCompleted(
  state: CompactBreakerState,
  nowMs: number = Date.now()
): CompactBreakerState {
  void nowMs;
  const next = clampState(state);
  next.turnsSinceCompact += 1;
  return next;
}

/** 自动压缩链是否被熔断挡住（maybeAutoCompact / maybeIdleMicrocompact 的第一道闸） */
export function isAutoCompactBlocked(state: CompactBreakerState): boolean {
  return state.tripped === true;
}

export interface AutoCompactAttemptResult {
  /** false=不得执行本次自动压缩（已熔断，或本次触发即熔断） */
  allowed: boolean;
  state: CompactBreakerState;
  /** 本次触发是否把熔断打闸（调用方据此发可见信号，只发这一拍） */
  justTripped: boolean;
}

/**
 * 自动压缩即将执行（maybeAutoCompact 链给出 compact/micro 动作后、真正调
 * compactSession 前喂线）。refill 计数口径（ZCode evaluateRapidRefill 同款）：
 * - **从未成功压缩过（lastCompactAt 缺省）**：首次达阈值是正常行为不是振荡，
 *   计 0（ZCode 对 undefined tracking 计 0）；
 * - 已有成功压缩且距其不足 N 个回合：计 1 次 rapid refill；
 * - 窗口已过（≥N 回合）：streak 归零重计。
 * 连击到上限即熔断并拒绝本次压缩。
 */
export function beginAutoCompactAttempt(
  state: CompactBreakerState,
  nowMs: number = Date.now()
): AutoCompactAttemptResult {
  const cur = clampState(state);
  if (cur.tripped) return { allowed: false, state: cur, justTripped: false };
  const next: CompactBreakerState = { ...cur };
  if (next.lastCompactAt === undefined) {
    // 从未压缩过：不计 refill（见状态字段注），streak 保持归零
    next.refillStreak = 0;
  } else if (next.turnsSinceCompact < RAPID_REFILL_TURN_WINDOW) {
    next.refillStreak += 1;
  } else {
    // 窗口已过：正常节奏的压缩，streak 重计（ZCode 同款）
    next.refillStreak = 0;
  }
  if (next.refillStreak >= MAX_CONSECUTIVE_RAPID_REFILLS) {
    return {
      allowed: false,
      justTripped: true,
      state: {
        ...next,
        tripped: true,
        trippedReason: 'rapid-refill',
        trippedAt: nowMs
      }
    };
  }
  return { allowed: true, state: next, justTripped: false };
}

/**
 * 自动压缩结果喂线：成功开新窗口（turnsSinceCompact=0）并清失败连击；失败累计
 * 失败连击，达上限熔断（refill streak 保留——失败同样是「上下文还满着」的证据，
 * 恢复后立刻识别再次回满）。手动压缩成败不经此（手动是恢复通道，不递增失败）。
 */
export function recordAutoCompactOutcome(
  state: CompactBreakerState,
  ok: boolean,
  nowMs: number = Date.now()
): AutoCompactAttemptResult {
  const cur = clampState(state);
  if (cur.tripped) return { allowed: false, state: cur, justTripped: false };
  if (ok) {
    return {
      allowed: true,
      justTripped: false,
      state: { ...cur, turnsSinceCompact: 0, failureStreak: 0, lastCompactAt: nowMs }
    };
  }
  const failureStreak = cur.failureStreak + 1;
  if (failureStreak >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
    return {
      allowed: false,
      justTripped: true,
      state: {
        ...cur,
        failureStreak,
        tripped: true,
        trippedReason: 'consecutive-failures',
        trippedAt: nowMs
      }
    };
  }
  return { allowed: true, justTripped: false, state: { ...cur, failureStreak } };
}

/**
 * 手动 /compact 成功：熔断恢复 + 计数清零，并**开新 refill 窗口**（记
 * lastCompactAt——手动压缩后同样可能被自治负载快速回满，振荡照计）。
 * 恢复条件之一（另一条是会话重建，由调用方直接重置桶上状态）。手动压缩不受
 * 熔断限制（isAutoCompactBlocked 不挡手动路径），成功即证明压缩链路可用。
 */
export function recordManualCompactSuccess(
  state: CompactBreakerState,
  nowMs: number = Date.now()
): CompactBreakerState {
  void state;
  return { ...initialCompactBreakerState(), lastCompactAt: nowMs };
}

/** 会话重建（clearHistory / 切换历史会话 / 分叉）时的全量重置 */
export function resetCompactBreaker(): CompactBreakerState {
  return initialCompactBreakerState();
}

// ---------------------------------------------------------------------------
// 超窗错误分类（B2 spike 产物；reactive 动作归 pi 引擎，宿主只做识别与取证）
// ---------------------------------------------------------------------------

/**
 * 超窗错误消息模式（移植自 pi-ai dist/utils/overflow.js OVERFLOW_PATTERNS /
 * NON_OVERFLOW_PATTERNS，2026-09-23 版本；Anthropic 与 OpenAI-compatible 双 provider
 * 覆盖，样例见 test/compact-breaker.mjs fixture）。宿主用途：回合失败消息的结构化
 * 归因日志（pi 已在回合内完成一次 compact+重试，宿主日志要能区分「超窗失败」与
 * 普通失败）。授权注：新增 provider 模式以 pi-ai 上游为准同步。
 *
 * **条数对照**：本表 26 条 = 上游同版本 25 条全覆盖（含 DS4「prompt has N tokens,
 * but the configured context size is…」与 Cerebras「^4(00|13)…(no body)」）+ 本仓
 * 泛化 `context[_ ]window[_ ]exceeded` 一条（上游只有 context[_ ]length[_ ]exceeded；
 * z.ai finish_reason 是 window 变体，上游经 model_context_window_exceeded 命中）；
 * 上游 LiteLLM 的 `exceeds…maximum context length` 后缀组在本仓改为可选（超集，仅
 * 放宽不收紧）。增删任一条需同步本注与 test/compact-breaker.mjs §7 fixture。
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))?/i, // OpenAI-compatible proxies (LiteLLM 等)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter（多数后端）
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow
  /range of input length should be/i, // DashScope / Qwen
  /context[_ ]length[_ ]exceeded/i, // generic
  /context[_ ]window[_ ]exceeded/i, // generic（本仓泛化；上游只有 length 变体）
  /too many tokens/i, // generic
  /token limit exceeded/i, // generic
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i // Cerebras: 400/413 with no body
];

/** 非溢出排除（限流/服务端错误优先——Bedrock "Too many tokens, please wait" 是限流不是超窗） */
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i
];

/** 回合失败消息是否带超窗特征（结构化识别；空/非串一律 false） */
export function classifyContextOverflowMessage(message: string | undefined | null): boolean {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return false;
  if (NON_OVERFLOW_PATTERNS.some((p) => p.test(text))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(text));
}
