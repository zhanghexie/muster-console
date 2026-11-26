/**
 * node-repl 持久会话（zcode-adopt-batch-d S2.2/T2）纯函数合同：
 * - 超时钳制（缺省 60s / 上限 120s，对齐 ZCode js 工具契约）
 * - generation 单调防 ABA：reset 后旧 generation 的迟到产物不得写入新上下文
 * - 超时/取消后 kernel reset 的可操作恢复指引（静默重建会让模型连环 ReferenceError）
 * - 工具面文案：label/description 用用户语言，禁 js/node_repl 实现术语进 title
 * 无 process / 无 IO / 不 import i18n，test/*.mjs 即时转译导入。
 */

// ---------------------------------------------------------------------------
// 超时契约
// ---------------------------------------------------------------------------

/** 缺省单次执行超时（ms）；预计超 30s 应显式传 timeoutMs */
export const NODE_REPL_DEFAULT_TIMEOUT_MS = 60_000;
/** timeoutMs 上限（ms） */
export const NODE_REPL_MAX_TIMEOUT_MS = 120_000;
/** timeoutMs 下限（ms）：过小无意义，钳到 1s */
export const NODE_REPL_MIN_TIMEOUT_MS = 1_000;

/**
 * 钳制调用方传入的 timeoutMs：非数/非有限 → 缺省；越界收进 [MIN, MAX]。
 * 纯函数，不读时钟。
 */
export function resolveNodeReplTimeoutMs(input: unknown): number {
  const n = typeof input === 'number' && Number.isFinite(input) ? Math.floor(input) : NaN;
  if (!Number.isFinite(n)) return NODE_REPL_DEFAULT_TIMEOUT_MS;
  if (n < NODE_REPL_MIN_TIMEOUT_MS) return NODE_REPL_MIN_TIMEOUT_MS;
  if (n > NODE_REPL_MAX_TIMEOUT_MS) return NODE_REPL_MAX_TIMEOUT_MS;
  return n;
}

// ---------------------------------------------------------------------------
// generation 防 ABA
// ---------------------------------------------------------------------------

/**
 * 调用方起跑时捕获的 generation 是否已过期（session 已 reset 过）。
 * 过期调用的完成回调/定时器/写回一律丢弃，不得落入新一代上下文。
 */
export function isNodeReplStaleGeneration(callGeneration: number, sessionGeneration: number): boolean {
  return callGeneration !== sessionGeneration;
}

// ---------------------------------------------------------------------------
// 结果与 reset 指引文案（发给 Worker 模型的协议文案，非 UI）
// ---------------------------------------------------------------------------

export type NodeReplResetReason = 'timeout' | 'cancel';

/** 超时/取消后 kernel 重建的恢复指引（ZCode 同款语义：不静默重建） */
export function nodeReplKernelResetNote(reason: NodeReplResetReason): string {
  const why = reason === 'timeout' ? '执行超时' : '执行被取消';
  return `${why}：执行上下文已整体重建，此前的全局绑定与定时器全部清除；继续前请先重新初始化所需状态。`;
}

export type NodeReplRunStatus = 'ok' | 'timeout' | 'cancel' | 'error';

export interface NodeReplRunResult {
  status: NodeReplRunStatus;
  /** 结果正文（求值展示 / 错误信息 / reset 指引） */
  text: string;
  /**
   * 求值是否有返回值（value !== undefined 时 true）。
   * 空字符串求值结果与 undefined 的展示区分依赖本标志；
   * 协议向后兼容：旧回执缺省视为有值。
   */
  hasValue?: boolean;
  /** 执行结束时 session 的 generation（用于调用方判串线） */
  generation: number;
  /** 是否触发了 kernel reset（timeout/cancel/未捕获致命错误时 true） */
  kernelReset: boolean;
}

/**
 * 成功结果的展示文本：真 undefined（hasValue=false）标 'undefined'；
 * 有值时原样返回 inspect 文本——空串是空字符串值的合法 inspect 形态，
 * 不得改写成 'undefined'（与真 undefined 不可区分会误导状态判断）。
 */
export function formatNodeReplValue(inspected: string, hasValue = true): string {
  if (!hasValue) return 'undefined';
  return inspected;
}

/** 单次输出预算（模型侧展示截断；超出落尾注） */
export const NODE_REPL_OUTPUT_BUDGET = 64 * 1024;

export function truncateNodeReplOutput(text: string, budget: number = NODE_REPL_OUTPUT_BUDGET): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n…（输出超过 ${budget} 字符已截断）`;
}

// ---------------------------------------------------------------------------
// 工具面（node_repl / js；label 与 description 用用户语言，禁实现术语进 title）
// ---------------------------------------------------------------------------

export const NODE_REPL_TOOL_ID = 'node_repl.js';

/** 展示名：用户语言，不出现 js / node_repl 等实现术语 */
export const NODE_REPL_TOOL_LABEL = '运行 JavaScript 代码';

export const NODE_REPL_TOOL_DESCRIPTION = [
  '在本会话专属的持久代码环境里执行一段 JavaScript。同一会话的多次调用共享同一份全局状态（globalThis / var / function 声明会保留），适合分步计算、累积变量、复用已加载的模块。',
  '契约：单次执行默认 60 秒超时（可传 timeoutMs，上限 120 秒）；超时或取消会重建执行上下文并清除全部既有绑定与定时器，结果里会明示「上下文已重建」——此时必须重新初始化状态再继续，不要沿用旧变量。',
  '注意：这是完整 Node 权限的代码执行（可 require / 读写文件 / 起进程），与 Bash 同级高危；只在确有必要时使用，不要拿它做普通文本处理。'
].join('\n');

export const NODE_REPL_TOOL_ARGS_HINT = 'code, timeoutMs?';
