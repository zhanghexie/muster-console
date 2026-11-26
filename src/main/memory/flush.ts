import { parseMemoryResponsesOutput } from './modelOutput';
/**
 * 压缩前 flush 静默回合（memory-refactor §6.2 / 决策 #8）：
 * 上下文即将被压缩摘要（细节会丢）之前，用一份**私有对话拷贝**（快照数组，不写主
 * 转录、不进 UI 消息流）跑一次静默 LLM 回合，提示词要求把未落盘的重要上下文写成
 * 记忆笔记；产出的笔记经**与 memory.note 相同的 noteStaging 通道**落情景暂存
 * （去重/召回回路防护/种类门一律照走）。
 *
 * 纪律：
 * - 失败/超时**绝不阻塞压缩**（调用方 try/catch 兜底，本模块内部也有超时竞速）；
 * - 对话拷贝发送前先过凭证脱敏（redact.ts），模型输出回填前再脱敏一次（双向保守）；
 * - LLM 调用为注入式（callModel），缺省传输层 createFetchFlushModelCall 是
 *  openai 兼容单回合（completions 非流式 / responses），模型解析在调用方
 *  （resolveLlmConfig——本模块不 import config.ts，保持 .mjs 可转译直测）。
 */
import { redactCredentialShapes } from './redact';

export interface FlushTurnMessage {
  role: 'user' | 'assistant';
  text: string;
  /** 该消息内出现过的工具名（污点定性用元数据；**不发给模型**） */
  toolNames?: ReadonlyArray<string>;
}

export const FLUSH_CONSTANTS = {
  /** 对话拷贝长度上限（超出截断保尾——近期上下文对 flush 更有价值） */
  MAX_CONVERSATION_CHARS: 16_000,
  /** 太短的对话不值得 flush（与 journalExitSummary 同门槛） */
  MIN_MESSAGES: 4,
  /** 单次笔记条数上限 */
  MAX_NOTES: 12,
  /** 单条笔记长度上限 */
  NOTE_MAX_CHARS: 1_000,
  /** 静默回合超时（超时放弃 flush，压缩继续） */
  TIMEOUT_MS: 90_000,
  MAX_OUTPUT_TOKENS: 2_048
} as const;

export const FLUSH_SYSTEM_PROMPT = [
  '你是记忆系统的「压缩前冲刷（flush）」环节。当前这份对话即将被压缩成摘要，压缩会丢失细节。',
  '请把对话中尚未写入长期记忆的重要上下文整理成记忆笔记，每条供日后检索召回。',
  '值得记的：关键决策及其理由、用户的偏好或明确指令、踩过的坑与修复方式、尚未完成需跟进的事项、重要的外部事实结论。',
  '不要记：寒暄与过程流水、对话里已出现的「记忆注入块」内容（那已经是记忆，复述会形成回路）、纯猜测。',
  '输出格式：**只输出一个 JSON 字符串数组**（不要代码块围栏、不要任何解释文字）。每项一条笔记：中文或原文均可，≤200 字，自包含、脱离上下文也能看懂。',
  '没有值得记的内容时输出 []。'
].join('\n');

/** 对话拷贝 → 发给模型的用户侧正文（【用户】/【助手】标注 + 截断保尾） */
export function buildFlushConversation(messages: ReadonlyArray<FlushTurnMessage>): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = redactCredentialShapes(m.text ?? '').text.trim();
    if (!text) continue;
    parts.push(m.role === 'user' ? `【用户】${text}` : `【助手】${text}`);
  }
  const joined = parts.join('\n\n');
  const cap = FLUSH_CONSTANTS.MAX_CONVERSATION_CHARS;
  return joined.length > cap ? `…[前文截断]\n${joined.slice(joined.length - cap)}` : joined;
}

export interface FlushModelCallInput {
  system: string;
  user: string;
}

export type FlushModelCall = (input: FlushModelCallInput) => Promise<string>;

/** noteStaging 通道注入面（与 memory.note 同一落点；返回 ok 标记即可） */
export type FlushNoteSink = (text: string) => { ok: boolean; reason?: string };

export interface MemoryFlushOutcome {
  ok: boolean;
  /** ok=true 时的跳过原因（不值得跑 / 没产出） */
  skipped?: 'too_few_messages' | 'empty_output';
  /** 落进 staging 的笔记数 */
  notesAdded: number;
  /** 被通道拒绝的笔记数（按原因计数；dup/recall_loop 属正常防护，不算失败） */
  notesRejected: Partial<Record<string, number>>;
  error?: string;
}

/** 解析模型输出为笔记列表（纯函数：剥围栏→找 JSON 数组→校验裁剪；失败返回 null） */
export function parseFlushNotes(raw: string | null | undefined): string[] | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of parsed) {
    if (typeof v !== 'string') continue;
    const t = redactCredentialShapes(v).text.trim().slice(0, FLUSH_CONSTANTS.NOTE_MAX_CHARS);
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= FLUSH_CONSTANTS.MAX_NOTES) break;
  }
  return out;
}

/**
 * flush 静默回合（核心执行；messages 必须是调用方给的私有拷贝快照）。
 * 任何异常都被捕获为 {ok:false, error}——调用方只需记日志，压缩照常。
 */
export async function runMemoryFlushTurn(opts: {
  messages: ReadonlyArray<FlushTurnMessage>;
  callModel: FlushModelCall;
  note: FlushNoteSink;
  timeoutMs?: number;
}): Promise<MemoryFlushOutcome> {
  const rejected: Partial<Record<string, number>> = {};
  try {
    const meaningful = opts.messages.filter((m) => (m.text ?? '').trim());
    if (meaningful.length < FLUSH_CONSTANTS.MIN_MESSAGES) {
      return { ok: true, skipped: 'too_few_messages', notesAdded: 0, notesRejected: rejected };
    }
    const user = buildFlushConversation(meaningful);
    const timeoutMs = opts.timeoutMs ?? FLUSH_CONSTANTS.TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_, reject) => {
      // 不 unref：本 Promise 已在 await 竞速里被引用，unref 会让空转进程（测试/CLI）
      // 在超时触发前退出；Electron 主进程的退出不受该短时定时器阻塞
      timer = setTimeout(() => reject(new Error(`flush 回合超时（${timeoutMs}ms）`)), timeoutMs);
    });
    let raw: string;
    try {
      raw = await Promise.race([opts.callModel({ system: FLUSH_SYSTEM_PROMPT, user }), timed]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const notes = parseFlushNotes(raw);
    if (!notes || notes.length === 0) {
      return { ok: true, skipped: 'empty_output', notesAdded: 0, notesRejected: rejected };
    }
    let added = 0;
    for (const note of notes) {
      const r = opts.note(note);
      if (r.ok) added += 1;
      else rejected[r.reason ?? 'unknown'] = (rejected[r.reason ?? 'unknown'] ?? 0) + 1;
    }
    return { ok: true, notesAdded: added, notesRejected: rejected };
  } catch (err) {
    return { ok: false, notesAdded: 0, notesRejected: rejected, error: String((err as Error)?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// 缺省传输层：openai 兼容单回合（协议分派同 textTools/runTextTool 先例；此处自带
// 精简副本避免 import config.ts/electron 链——flush.ts 保持 .mjs 可转译直测）
// ---------------------------------------------------------------------------

export interface FetchFlushTransportTarget {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  api?: 'openai-completions' | 'openai-responses';
  /** 测试注入（缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
}

/** 「关闭思考」启发式精简副本（源：main/textTools/runTextTool.ts buildThinkingOffParams） */
function buildThinkingOffParams(modelId: string, api: string): Record<string, unknown> | null {
  const m = (modelId ?? '').toLowerCase();
  const out: Record<string, unknown> = {};
  if (m.includes('qwen') || m.includes('qwq')) {
    out.enable_thinking = false;
    out.chat_template_kwargs = { enable_thinking: false };
  } else if (m.includes('glm') || m.includes('doubao')) {
    out.thinking = { type: 'disabled' };
  } else if (m.startsWith('gpt-5')) {
    out.reasoning_effort = 'minimal';
  }
  return Object.keys(out).length ? out : null;
}



/** openai 兼容端点的单回合调用（非流式；错误带状态与响应片段） */
export function createFetchFlushModelCall(target: FetchFlushTransportTarget): FlushModelCall {
  return async (input) => {
    const base = (target.baseUrl || '').trim().replace(/\/+$/, '');
    const key = (target.apiKey || '').trim();
    if (!base || !key) throw new Error('flush 模型未配置 baseUrl/apiKey');
    const doFetch = target.fetchImpl ?? (globalThis.fetch as typeof fetch);
    const api = target.api ?? 'openai-completions';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'api-key': key
    };
    const extra = buildThinkingOffParams(target.modelId, api) ?? {};
    if (api === 'openai-responses') {
      const res = await doFetch(`${base}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: target.modelId,
          instructions: input.system,
          input: input.user,
          max_output_tokens: FLUSH_CONSTANTS.MAX_OUTPUT_TOKENS,
          ...extra
        })
      });
      if (!res.ok) throw new Error(`flush LLM ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return parseMemoryResponsesOutput(await res.json());
    }
    const url = /\/v\d+$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: target.modelId,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user }
        ],
        max_tokens: FLUSH_CONSTANTS.MAX_OUTPUT_TOKENS,
        ...extra
      })
    });
    if (!res.ok) throw new Error(`flush LLM ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  };
}
