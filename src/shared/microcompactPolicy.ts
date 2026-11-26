/**
 * B1 调度会话 microcompact（zcode-adoption-plan B1）：判定纯函数层。
 *
 * 与 autoCompact.ts 同层同风格：只做判定，不做 IO、不做真正的压缩调用。
 * 双触发器（对齐 ZCode compact/microcompact.ts）：
 * - idle（主路径）：调度空闲超阈值（事件唤醒/人回来）才动手——长空闲时 prompt cache
 *   本来就过期，清理零缓存代价（「清理挑缓存已死时动手」原则）；
 * - token-pressure（兜底）：占比达 autoCompact 阈值 × 0.9（缺省 0.72）档，先试
 *   microcompact，节省不足最小节省常量才放行到 0.8 全量压缩。
 *
 * **实现层级结论（2026-09-23 spike，详见 docs/features/scheduler-prompt-injection.md）**：
 * 走层级二（降级）——pi SessionManager 是 append-only（session-manager.d.ts「Entries
 * cannot be modified or deleted」，_rewriteFile 为 private），历史改写 API 不存在；
 * 会话文件虽是 JSONL 可解析，但活会话全量驻内存、LLM 上下文从内存构建且会在
 * migrate/branch 等时机从内存整写回盘——文件级改写对活会话既无效也会被覆盖。
 * pi 的 `session.compact(customInstructions)` 受支持（agent-session.d.ts:515，
 * 本仓 safeCompactSession 已透传），故触发后动作 = 带定向摘要指令的 compact：
 * 效果弱于真替换（一阶近似），层级一（宿主侧真替换）留待 pi 能力升级。
 */

import {
  type AutoCompactDecision,
  type AutoCompactSkipReason,
  decideAutoCompact,
  normalizeAutoCompactConfig
} from './autoCompact';
import {
  COMPACT_SUMMARY_CORE_SECTIONS,
  COMPACT_SUMMARY_VERBATIM_CLAUSE
} from './compactSummary';

/** AutoCompactConfig.micro 的类型（AutoCompactConfig 里以 type-only 惰性引用，避免运行时环） */
export interface MicroCompactConfig {
  /** 缺省 true；false 关闭微压缩（0.8 全量压缩不受影响） */
  enabled?: boolean;
  /** idle 触发阈值（分钟），缺省 30 */
  idleMinutes?: number;
  /** 最小节省（tokens），估算低于此不动手，缺省 2000 */
  minSavingsTokens?: number;
  /** 每个白名单工具保留最近 N 条结果不清，缺省 5（ZCode 同款） */
  keepRecent?: number;
}

export const DEFAULT_MICROCOMPACT_IDLE_MINUTES = 30;
export const DEFAULT_MICROCOMPACT_MIN_SAVINGS_TOKENS = 2000;
export const DEFAULT_MICROCOMPACT_KEEP_RECENT = 5;
/** token 兜底档 = autoCompact 阈值 × 本系数（0.8 × 0.9 = 0.72） */
export const MICROCOMPACT_TOKEN_RATIO = 0.9;

/**
 * 微压缩白名单（调度宿主工具，Catalog 点名；匹配时把 pi 注册名的下划线归一回点号）。
 * 判据：宿主注入的**读类轮询**工具——结果大、时效短、旧结果无回看价值（要新数据再查
 * 一次即可），清单逐个评估如下：
 * - sessions.observe：会话目录、状态与上下文快照，后续可重新读取；
 * - memory.list：可重新检索的记忆列表。
 * 刻意不进清单：一切写类工具（sessions.create / sessions.message 等回执短且有对账价值）、
 * askQuestion 类决策结果（是任务证据面）、ui.* / notify（短文本，不值得清）、
 * mcp.search（R5 后目录发现主入口，schema 页保留价值高）。R5 发现层退役：tools.search 移除。
 * 错误结果一律保留（isError=true 跳过，携带排障信息），对齐 ZCode clearErrorResults=false。
 */
export const MICROCOMPACT_COMPACTABLE_TOOLS: readonly string[] = [
  'sessions.observe',
  'memory.list'
];

/** 白名单命中判定：pi 注册名（sessions_observe）与 Catalog 点名（sessions.observe）都认 */
export function isMicrocompactableToolName(toolName: string): boolean {
  const normalized = toolName.trim().replace(/_/g, '.');
  return MICROCOMPACT_COMPACTABLE_TOOLS.includes(normalized);
}

/** 粗估 token 数：CJK 字符 ≈1 token/字，其余 ≈4 字符/token（确定性启发式，够门槛判定用） */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) >= 0x2e80) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 微压缩配置归一：非法值回缺省，数值夹紧到合法域 */
export function normalizeMicroCompactConfig(raw: unknown): {
  enabled: boolean;
  idleMinutes: number;
  minSavingsTokens: number;
  keepRecent: number;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      enabled: true,
      idleMinutes: DEFAULT_MICROCOMPACT_IDLE_MINUTES,
      minSavingsTokens: DEFAULT_MICROCOMPACT_MIN_SAVINGS_TOKENS,
      keepRecent: DEFAULT_MICROCOMPACT_KEEP_RECENT
    };
  }
  const o = raw as MicroCompactConfig;
  const posInt = (v: unknown, fallback: number, min: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
    return Math.max(min, Math.floor(v));
  };
  return {
    enabled: o.enabled !== false,
    idleMinutes: posInt(o.idleMinutes, DEFAULT_MICROCOMPACT_IDLE_MINUTES, 1),
    minSavingsTokens: posInt(o.minSavingsTokens, DEFAULT_MICROCOMPACT_MIN_SAVINGS_TOKENS, 0),
    keepRecent: posInt(o.keepRecent, DEFAULT_MICROCOMPACT_KEEP_RECENT, 1)
  };
}

/**
 * autoCompact 配置整归一（B1 后的 config.ts 消费入口）：基础两字段 + micro 子配置。
 * 放本文件而非 autoCompact.ts，避免 autoCompact ⇄ microcompactPolicy 运行时相互引用。
 */
export function normalizeAutoCompactWithMicro(raw: unknown): {
  enabled: boolean;
  ratio: number;
  micro: { enabled: boolean; idleMinutes: number; minSavingsTokens: number; keepRecent: number };
} {
  const base = normalizeAutoCompactConfig(raw);
  return { ...base, micro: normalizeMicroCompactConfig((raw as { micro?: unknown } | null)?.micro) };
}

// ---------------------------------------------------------------------------
// 触发判定
// ---------------------------------------------------------------------------

export type MicrocompactTrigger = 'idle' | 'token-pressure';

export type MicrocompactSkipReason =
  | 'disabled'
  | 'busy'
  | 'not-idle'
  | 'below-micro-ratio'
  | 'unknown-usage'
  | 'no-candidates'
  | 'nothing-to-clear'
  | 'below-min-savings';

export interface MicrocompactCandidate {
  /** 稳定标识（pi toolCallId / 会话条目 id） */
  id: string;
  /** 工具名（点名或 pi 注册名均可，命中判定内部归一） */
  toolName: string;
  /** 结果文本（用于估算可省 token；非文本块不计，保守低估） */
  text: string;
  isError?: boolean;
  /** 已是占位符的（层级一真替换后的残留）跳过；层级二下恒为 false */
  alreadyCleared?: boolean;
}

export type MicrocompactDecision =
  | {
      action: 'clear';
      trigger: MicrocompactTrigger;
      /** 待清理候选 id（调用方按层级一/二各自语义执行） */
      clearIds: string[];
      /** 估算可省 token（粗估，只用于门槛判定与日志） */
      estimatedSavingsTokens: number;
    }
  | { action: 'skip'; reason: MicrocompactSkipReason };

/**
 * idle 触发判定：上次 assistant 完成距今 ≥ 阈值。无完成时间（新会话/重启）不触发。
 */
export function isIdleTriggerDue(
  nowMs: number,
  lastAssistantCompletedAtMs: number | null | undefined,
  idleThresholdMs: number
): boolean {
  if (typeof lastAssistantCompletedAtMs !== 'number' || !Number.isFinite(lastAssistantCompletedAtMs)) {
    return false;
  }
  if (!(idleThresholdMs > 0)) return false;
  return nowMs - lastAssistantCompletedAtMs >= idleThresholdMs;
}

/** token 兜底档阈值：autoCompact 阈值 × MICROCOMPACT_TOKEN_RATIO（0.8 → 0.72） */
export function microTriggerRatio(ratioThreshold: number): number {
  return ratioThreshold * MICROCOMPACT_TOKEN_RATIO;
}

/**
 * 单触发器微压缩判定：给定触发（idle/token-pressure 由调用方按上两个纯函数判 viability），
 * 决定「清哪些、值不值得清」。白名单命中 + 跳过错误/已清 + 保留每工具最近 N 条 +
 * 最小节省门槛，全在这一个纯函数里，可测。
 */
export function decideMicrocompact(input: {
  trigger: MicrocompactTrigger;
  enabled: boolean;
  busy: boolean;
  candidates: readonly MicrocompactCandidate[];
  keepRecent?: number;
  minSavingsTokens?: number;
}): MicrocompactDecision {
  if (!input.enabled) return { action: 'skip', reason: 'disabled' };
  if (input.busy) return { action: 'skip', reason: 'busy' };
  const keepRecent =
    typeof input.keepRecent === 'number' && Number.isFinite(input.keepRecent) && input.keepRecent >= 1
      ? Math.floor(input.keepRecent)
      : DEFAULT_MICROCOMPACT_KEEP_RECENT;
  const minSavings =
    typeof input.minSavingsTokens === 'number' && Number.isFinite(input.minSavingsTokens) && input.minSavingsTokens >= 0
      ? input.minSavingsTokens
      : DEFAULT_MICROCOMPACT_MIN_SAVINGS_TOKENS;

  const clearable = input.candidates.filter(
    (c) =>
      isMicrocompactableToolName(c.toolName) && c.isError !== true && c.alreadyCleared !== true
  );
  if (clearable.length === 0) return { action: 'skip', reason: 'no-candidates' };
  // 白名单是逐工具保留最近 N 条（ZCode 是全局最近 N 组；逐工具更贴合「轮询」语义：
  // 每个 polling 工具都留一份最新快照，其余全清）
  const perTool = new Map<string, MicrocompactCandidate[]>();
  for (const c of clearable) {
    const key = c.toolName.trim().replace(/_/g, '.');
    const list = perTool.get(key) ?? [];
    list.push(c);
    perTool.set(key, list);
  }
  const toClear: MicrocompactCandidate[] = [];
  for (const list of perTool.values()) {
    // 会话顺序即入列顺序：尾部 N 条是最近快照，其余全清
    toClear.push(...list.slice(0, Math.max(0, list.length - keepRecent)));
  }
  if (toClear.length === 0) return { action: 'skip', reason: 'nothing-to-clear' };
  const estimatedSavingsTokens = toClear.reduce((sum, c) => sum + estimateTextTokens(c.text), 0);
  if (estimatedSavingsTokens < minSavings) {
    return { action: 'skip', reason: 'below-min-savings' };
  }
  return {
    action: 'clear',
    trigger: input.trigger,
    clearIds: toClear.map((c) => c.id),
    estimatedSavingsTokens
  };
}

// ---------------------------------------------------------------------------
// autoCompact 链上的 token 兜底（0.72 档先试微压缩，不足放行 0.8 全量）
// ---------------------------------------------------------------------------

/** AutoCompactDecision 的 reason 与微压缩 skip reason 的并集 */
export type SchedulerCompactSkipReason = AutoCompactSkipReason | MicrocompactSkipReason;

export type SchedulerCompactDecision =
  | { action: 'compact' }
  | { action: 'micro'; trigger: MicrocompactTrigger; decision: Extract<MicrocompactDecision, { action: 'clear' }> }
  | { action: 'skip'; reason: SchedulerCompactSkipReason };

/**
 * 调度自动压缩链（B1）：0.8 全量压缩判定不变；在它之前先判 0.72 微压缩档。
 * - 0.8 全量、能力位/开关/busy/用量未知：沿用 decideAutoCompact 原语义（微压缩同受
 *   busy/开关互斥——与手动 /compact、在飞压缩一把闸）；
 * - 低于 0.8 但 ≥ 0.72 且微压缩开：用白名单候选试微压缩，节省不足 → skip
 *   below-min-savings（等 0.8 全量），未达 0.72 → skip below-micro-ratio。
 * 纯函数；触发后动作（层级二 compact 定向指令）由调用方执行。
 */
export function decideSchedulerCompactChain(input: {
  autoCompactCapable: boolean;
  configEnabled: boolean;
  ratioThreshold: number;
  tokens: number | null | undefined;
  contextWindow: number | null | undefined;
  busy: boolean;
  /** 微压缩配置（已归一）；enabled=false 时本链退化为原 decideAutoCompact */
  micro: { enabled: boolean; minSavingsTokens: number; keepRecent: number };
  candidates: readonly MicrocompactCandidate[];
}): SchedulerCompactDecision {
  const full: AutoCompactDecision = decideAutoCompact(input);
  if (full.action === 'compact') return { action: 'compact' };
  // 微压缩与全量压缩同闸：能力位/总开关/busy/用量未知任一不满足都原样透传（互斥复用现有判定）
  if (full.reason !== 'below-threshold') return full;
  // 微压缩关 → 链退化为原 decideAutoCompact（below-threshold 原样返回）
  if (!input.micro.enabled) return full;
  // 不变量：decideAutoCompact 对非法 tokens/contextWindow 必先返 unknown-usage（上面已
  // 透传），能走到这里 reason 必为 below-threshold ⇒ 两者均为合法数值——类型收窄用
  // 断言即可，不再做二次校验（那段分支不可达，属死代码）
  const ratio = (input.tokens as number) / (input.contextWindow as number);
  if (ratio < microTriggerRatio(input.ratioThreshold)) {
    return { action: 'skip', reason: 'below-micro-ratio' };
  }
  const decision = decideMicrocompact({
    trigger: 'token-pressure',
    enabled: true,
    busy: input.busy,
    candidates: input.candidates,
    keepRecent: input.micro.keepRecent,
    minSavingsTokens: input.micro.minSavingsTokens
  });
  if (decision.action === 'clear') return { action: 'micro', trigger: decision.trigger, decision };
  // 节省不足/无可清 → 放行等 0.8 全量（skip，不再往下打）
  return { action: 'skip', reason: decision.reason };
}

/**
 * 层级二动作的定向摘要指令：触发后随 session.compact(customInstructions) 下发。
 * 一阶近似说明：pi compact 是整会话摘要（保留 keepRecentTokens 尾部原文），不是
 * ZCode 式「只替换旧工具结果」——效果弱于真替换，靠指令把旧轮询结果压成单行结论。
 *
 * B3 起与全量压缩共用同一套六节核心（compactSummary.COMPACT_SUMMARY_CORE_SECTIONS）：
 * 微压缩版 = 轮询清理指令 + 共用核心精简引用（逐字保留条款随核心带上）。
 */
export function buildMicroCompactInstructions(keepRecent: number = DEFAULT_MICROCOMPACT_KEEP_RECENT): string {
  const tools = MICROCOMPACT_COMPACTABLE_TOOLS.join(' / ');
  // 六节名从共用核心常量派生（节名=每节首个「:」前的标题），消除双份维护
  const sectionHeads = COMPACT_SUMMARY_CORE_SECTIONS.map((s) => s.split(':')[0]).join('/');
  return [
    'Beyond the regular summary, this compaction first prunes old polling results from history:',
    `For whitelisted tools (${tools}) keep only a one-line conclusion per historical tool result (format "<datetime> <tool>: <one-sentence conclusion>");`,
    'drop their stale values, list details and long JSON entirely (the scheduler re-queries fresh data when needed);',
    // 与判定侧 keepRecent 同口径（调用方传 normalize 后的配置值），指令不与决策脱节
    `keep the most recent ${keepRecent} whitelisted tool results in full.`,
    `The regular summary follows the scheduler compaction six-section core (${sectionHeads});`,
    `${COMPACT_SUMMARY_VERBATIM_CLAUSE}`,
    'User messages, task decisions, acceptance states, file paths and unfinished items are preserved verbatim.'
  ].join('\n');
}
