/** Pi coding-agent 会话上我们实际用到的表面。 */
import { t } from './i18n';

export interface PiSessionHandle {
  dispose?: () => void | Promise<void>;
  subscribe: (fn: (event: PiAgentEvent) => void) => () => void;
  /** The core agent awaits its listeners; AgentSession.subscribe does not. */
  agent?: { subscribe?: (fn: (event: PiAgentEvent) => void | Promise<void>) => () => void };
  prompt: (
    text: string,
    options?: { images?: Array<{ type: 'image'; data: string; mimeType: string }>; expandPromptTemplates?: boolean }
  ) => Promise<unknown>;
  abort?: () => void | Promise<void>;
  sendCustomMessage?: (message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> }, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }) => Promise<unknown>;
  /** 取消请求级自动重试的退避睡眠（pi AgentSession.abortRetry） */
  abortRetry?: () => void;
  abortCompaction?: () => void;
  model?: { id?: string; provider?: string; reasoning?: boolean };
  /** 当前模型由 Pi 声明的可选档；不可用时回落到已加载的目录。 */
  getAvailableThinkingLevels?: () => readonly string[];
  /** SDK 版本相关：部分版本才提供运行期切换思考档位 */
  setThinkingLevel?: (level: string) => void;
  /** 回合中插话（steer）；调度「立即」用。SDK 版本相关，缺席/拒绝时调用方回落排队 */
  steer?: (text: string) => Promise<unknown>;
  /** 当前是否正在流式回合内；false 时 steer 不可用（勿盲发，防静默丢消息） */
  isStreaming?: boolean;
  /**
   * 手动上下文压缩（pi SDK /compact 的 SDK 入口；会先 abort 当前回合，调用方须先
   * 判空闲）。SDK 版本相关：缺席或会话太小/已压缩时抛错，错误文案直接给用户。
   */
  compact?: (customInstructions?: string) => Promise<unknown>;
  /** 是否正在压缩（含自动压缩）；SDK 版本相关，缺席时不判 */
  isCompacting?: boolean;
  /**
   * B1 微压缩候选采集用：pi AgentSession 的会话条目管理器（append-only，宿主只读）。
   * SDK 版本相关：缺席/形态不符时采集方返回空候选（见 main/agent/piMicrocompact.ts）。
   */
  sessionManager?: {
    buildContextEntries?: () => unknown[];
    getEntries?: () => unknown[];
    getCwd?: () => string;
    getSessionFile?: () => string | undefined;
    appendCustomEntry?: (customType: string, data?: unknown) => string;
  };
}

/** 手动压缩的结果字段（pi CompactionResult 里我们关心的子集） */
export interface PiCompactOutcome {
  summary?: string;
  tokensBefore?: number | null;
  estimatedTokensAfter?: number | null;
}

/** 归一的手动压缩结果：成功带摘要，失败带用户可读原因 */
export type PiCompactResult = ({ ok: true } & PiCompactOutcome) | { ok: false; error: string };

/** 压缩成功的一句话结果（主进程通知 / 渲染层 local echo 共用；摘要全文不塞短文案） */
export function formatCompactResult(r: Extract<PiCompactResult, { ok: true }>): string {
  const before = typeof r.tokensBefore === 'number' ? r.tokensBefore : null;
  const after = typeof r.estimatedTokensAfter === 'number' ? r.estimatedTokensAfter : null;
  if (before != null && after != null) {
    return t('上下文已压缩：约 {{before}} → {{after}} tokens', { before, after });
  }
  if (before != null) return t('上下文已压缩（压缩前 {{before}} tokens）', { before });
  return t('上下文已压缩');
}

type CompactableSession = {
  compact?: (customInstructions?: string) => Promise<unknown>;
  /** SDK 回合进行中；compact() 会先 abort 当前回合，摘要请求会吃到已 abort 的信号 */
  isStreaming?: boolean;
  /** SDK 正在压缩（含自动压缩） */
  isCompacting?: boolean;
};

/** 同一 session 上 compact 单飞：重叠调用会让后一次 abort() 掐死前一次的摘要请求 */
const compactInFlight = new WeakMap<object, Promise<PiCompactResult>>();

/**
 * 安全调用手动压缩：方法缺席（旧 SDK）与抛错统一归一成 ok=false，
 * 不让版本差异炸到调用方。参数取最小结构面（兼容 SDK AgentSession 与 PiSessionHandle）。
 *
 * 引擎 `session.compact()` 会先 `abort()`（含 abortCompaction）。空闲判定必须看
 * SDK 自身 isStreaming/isCompacting，不能只信 Host/Orchestrator 的 busy——两边
 * 短暂失步时盲调会把进行中的摘要信号掐掉（Turn prefix summarization aborted）。
 * 同一 session 重叠 compact 也拒后一次，避免第二次 abort 杀掉第一次。
 */
export async function safeCompactSession(
  session: CompactableSession | null | undefined,
  customInstructions?: string
): Promise<PiCompactResult> {
  if (!session || typeof session.compact !== 'function') {
    return { ok: false, error: t('当前 pi 会话不支持手动压缩') };
  }
  if (session.isStreaming === true) {
    return { ok: false, error: t('Agent 正忙，请等当前回合结束后再压缩') };
  }
  if (session.isCompacting === true) {
    return { ok: false, error: t('正在压缩，请稍候') };
  }
  const existing = compactInFlight.get(session);
  if (existing) return { ok: false, error: t('正在压缩，请稍候') };

  const run = (async (): Promise<PiCompactResult> => {
    try {
      const r = (await session.compact!(customInstructions?.trim() || undefined)) as PiCompactOutcome | null;
      return {
        ok: true,
        summary: typeof r?.summary === 'string' ? r.summary : undefined,
        tokensBefore: typeof r?.tokensBefore === 'number' ? r.tokensBefore : null,
        estimatedTokensAfter:
          typeof r?.estimatedTokensAfter === 'number' ? r.estimatedTokensAfter : null
      };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  })();
  compactInFlight.set(session, run);
  try {
    return await run;
  } finally {
    if (compactInFlight.get(session) === run) compactInFlight.delete(session);
  }
}

/** agent_end.messages 尾部倒扫取最后一条 assistant 的结算（调度与 GUI driver 共用） */
export function lastAssistantOutcome(
  messages: ReadonlyArray<{ role?: string; stopReason?: string; errorMessage?: string }> | undefined
): { stopReason?: string; errorMessage?: string } {
  const msgs = messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === 'assistant') {
      return { stopReason: m.stopReason, errorMessage: m.errorMessage };
    }
  }
  return {};
}

/** 运行期切思考档：部分 SDK 版本无该方法/调用会抛，统一兜住（onError 可选记日志）。
 *  泛型 level 兼容 PiSessionHandle(string) 与 SDK AgentSession(ThinkingLevel 窄类型) 两种签名。 */
export function safeSetThinkingLevel<T extends string>(
  session: { setThinkingLevel?: (level: T) => void },
  level: T,
  onError?: (message: string) => void
): void {
  if (typeof session.setThinkingLevel !== 'function') return;
  try {
    session.setThinkingLevel(level);
  } catch (e) {
    onError?.((e as Error)?.message ?? String(e));
  }
}

/** Pi assistant 消息（agent_end.messages 里我们关心的字段） */
export interface PiAssistantMessage {
  role: 'assistant';
  content?: Array<{ type: string }>;
  stopReason?: string;
  errorMessage?: string;
}

export type PiAgentEvent =
  | {
      type: 'message_update';
      assistantMessageEvent?: { type: string; delta?: string };
    }
  | {
      type: 'tool_execution_start';
      toolName?: string;
      toolCallId?: string;
      args?: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId?: string;
      isError?: boolean;
      result?: unknown;
    }
  /** 单次 LLM 调用结束（含自动重试前的暂停；willRetry=true 时回合尚未真正结束） */
  | { type: 'agent_end'; messages?: PiAssistantMessage[]; willRetry?: boolean }
  /** 整个回合（含重试循环）真正结束 */
  | { type: 'agent_settled' }
  | {
      type: 'auto_retry_start';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: string; [key: string]: unknown };
