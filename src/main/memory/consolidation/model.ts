import { parseMemoryResponsesOutput } from '../modelOutput';
/**
 * 巩固模型回合（memory-refactor §6.3）：输入=门内候选（带证据引用）+当前策展文件
 * 全文；输出**结构化操作决策 JSON**（不写散文）：
 *
 *   {"operations":[{"op":"add"|"merge"|"supersede","candidateId":<stagingId>,
 *                   "text":"…","oldSnippet":"…","reason":"…","confidence":0.0-1.0}]}
 *
 * - add：候选独立成条（text=条目正文，可含 #tag/[[link]] 标记）；
 * - merge：候选并入既有条目（oldSnippet=当前策展文件中既有条目正文的**逐字节片段**，
 *   text=合并后的完整替换正文）；
 * - supersede：候选取代已过时条目（oldSnippet 同上，text=新正文）。
 * 模型只做决策；验证组装/Source 引用/预算/损失界全部在代码侧（apply.ts）。
 *
 * 传输层与 flush.ts 同款 openai 兼容单回合（模式复用；自带精简副本保持本模块
 * .mjs 可转译直测、错误前缀可辨）。
 */
import type { StagingCandidate } from './gates';
import type { GateSignalBreakdown } from './gates';

export const CONSOLIDATION_MODEL_CONSTANTS = {
  /** 单回合送入的候选上限（分数头部；sweep 已按 score 降序） */
  MAX_CANDIDATES: 12,
  /** 策展文件全文送入上限（超出截断保尾——追加区对合并决策更有价值） */
  MAX_TARGET_CHARS: 20_000,
  /** 模型单条 text 上限（与 entryFormat 生成侧同档裁剪） */
  TEXT_MAX_CHARS: 1_000,
  /** 静默回合超时 */
  TIMEOUT_MS: 120_000,
  // Responses budgets include hidden reasoning. 3072 truncated short JSON
  // decisions on GLM; the caller still enforces a bounded wall-clock deadline.
  MAX_OUTPUT_TOKENS: 8_192,
  /** 单回合操作数上限 */
  MAX_OPERATIONS: 12
} as const;

export const CONSOLIDATION_SYSTEM_PROMPT = [
  '你是记忆系统的「巩固（consolidation）」环节。下面给你一批通过信号门筛选的候选记忆（来自会话暂存），以及当前策展记忆文件全文。',
  '请决定每个候选的去向，输出操作决策——不写散文、不改写无关条目。',
  '操作类型：',
  '- add：候选值得独立成新条目（text=条目正文，自包含、≤300 字，可带 #tag 与 [[关联名]] 标记）。',
  '- merge：候选与文件中某既有条目是同一主题，应合并（oldSnippet=从当前策展文件**逐字节复制**的既有条目正文片段，足够唯一定位；text=合并后的完整替换正文，保留旧条目仍有价值的信息）。',
  '- supersede：候选使文件中某既有条目过时，应取代（oldSnippet 同上；text=新正文，保留仍有效的上下文）。',
  '纪律：',
  '- oldSnippet 必须能在当前策展文件中唯一匹配，否则不提出改写；禁止用 add 绕过定位失败、已有同义内容或无新增信息。',
  '- 一次任务的要求、背景、完成流水只留历史，不是长期经验。新增必须说明未来适用场景和相对已有记忆的新增信息；同义改写、标签变化、反复出现都不是新增信息。',
  '- 没有值得晋升的候选时输出 {"operations":[]}。不确定的候选给低 confidence 或不做操作。',
  '- confidence 为 0–1 的数：高置信 add 会自动应用；merge/supersede 与低置信一律进人工审批。',
  '输出格式：**只输出一个 JSON 对象**（不要代码块围栏、不要解释文字），形如 {"operations":[{"op":"add","candidateId":7,"text":"…","reason":"…","confidence":0.9}]}。'
].join('\n');

export interface ConsolidationModelCandidate {
  candidate: StagingCandidate & { signals: GateSignalBreakdown };
  /** 证据引用行（apply 侧落 Source: 行用；提示词里供模型理解候选来源） */
  citation: string;
}

export interface ConsolidationModelCallInput {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export type ConsolidationModelCall = (input: ConsolidationModelCallInput) => Promise<string>;

/** 候选 → 提示词条目（含信号摘要与证据引用） */
function formatCandidateForPrompt(c: ConsolidationModelCandidate): string {
  const s = c.candidate;
  const sig = s.signals;
  return [
    `### 候选 ${s.stagingId}`,
    `来源证据：${c.citation}`,
    `信号：score=${sig.score.toFixed(2)} 召回${s.recallEvents}次/查询${s.uniqueQueries}种/相关分均值${
      s.relevanceMean == null ? '无' : s.relevanceMean.toFixed(2)
    }`,
    `正文：${s.text.slice(0, CONSOLIDATION_MODEL_CONSTANTS.TEXT_MAX_CHARS)}`
  ].join('\n');
}

/** 组装用户侧正文：策展文件全文 + 候选清单（纯函数） */
export function buildConsolidationUserPrompt(
  curatedContent: string,
  candidates: ReadonlyArray<ConsolidationModelCandidate>
): string {
  const cap = CONSOLIDATION_MODEL_CONSTANTS.MAX_TARGET_CHARS;
  const curated = curatedContent.length > cap ? `${curatedContent.slice(curatedContent.length - cap)}\n…[前文截断]` : curatedContent;
  return [
    '## 当前策展记忆文件全文',
    curated || '（空文件）',
    '',
    '## 候选记忆（已按信号分降序）',
    ...candidates.map((c) => formatCandidateForPrompt(c))
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 输出解析（纯函数；格式漂移在这里收口）
// ---------------------------------------------------------------------------

export type ConsolidationOpKind = 'add' | 'merge' | 'supersede';

export interface ModelOperation {
  op: ConsolidationOpKind;
  /** 模型回显的候选 staging id（-1=模型未带；apply 侧按 unknown 丢弃） */
  candidateId: number;
  text: string;
  /** merge/supersede 定位用（当前策展文件逐字节片段） */
  oldSnippet?: string;
  reason?: string;
  /** 0–1（缺省/越界按 0 处理——不确定即低置信） */
  confidence: number;
}

/** 解析模型输出为操作列表（剥围栏→找 JSON 对象→逐项校验裁剪；失败返回 null） */
export function parseConsolidationOperations(raw: string | null | undefined): ModelOperation[] | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  const opsRaw = (parsed as { operations?: unknown }).operations;
  if (!Array.isArray(opsRaw)) return null;
  const out: ModelOperation[] = [];
  for (const v of opsRaw) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const op = String(o.op ?? '');
    if (op !== 'add' && op !== 'merge' && op !== 'supersede') continue;
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, CONSOLIDATION_MODEL_CONSTANTS.TEXT_MAX_CHARS) : '';
    const oldSnippet = typeof o.oldSnippet === 'string' ? o.oldSnippet : undefined;
    const confRaw = Number(o.confidence);
    const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;
    const candidateId =
      typeof o.candidateId === 'number' && Number.isInteger(o.candidateId) ? o.candidateId : -1;
    out.push({
      op,
      candidateId,
      text,
      oldSnippet: oldSnippet && oldSnippet.trim() ? oldSnippet : undefined,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : undefined,
      confidence
    });
    if (out.length >= CONSOLIDATION_MODEL_CONSTANTS.MAX_OPERATIONS) break;
  }
  return out;
}

export interface ConsolidationModelOutcome {
  ok: boolean;
  /** ok=false 时的错误（超时/网络/解析失败） */
  error?: string;
  operations?: ModelOperation[];
}

/** 巩固静默回合（超时竞速同 flush 先例；任何异常捕获为 {ok:false,error}） */
export async function runConsolidationModelTurn(opts: {
  curatedContent: string;
  candidates: ReadonlyArray<ConsolidationModelCandidate>;
  callModel: ConsolidationModelCall;
  timeoutMs?: number;
}): Promise<ConsolidationModelOutcome> {
  try {
    if (opts.candidates.length === 0) return { ok: true, operations: [] };
    const timeoutMs = opts.timeoutMs ?? CONSOLIDATION_MODEL_CONSTANTS.TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_, reject) => {
      // 不 unref：同 flush 立场——await 竞速已引用本 Promise，unref 会让空转进程提前退出
      timer = setTimeout(() => reject(new Error(`巩固模型回合超时（${timeoutMs}ms）`)), timeoutMs);
    });
    let raw: string;
    try {
      raw = await Promise.race([
        opts.callModel({
          system: CONSOLIDATION_SYSTEM_PROMPT,
          user: buildConsolidationUserPrompt(opts.curatedContent, opts.candidates)
        }),
        timed
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const operations = parseConsolidationOperations(raw);
    if (!operations) {
      return { ok: false, error: `操作决策 JSON 解析失败：${(raw ?? '').slice(0, 160)}` };
    }
    return { ok: true, operations };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// 缺省传输层：openai 兼容单回合（flush.ts 同款模式的精简副本——错误前缀可辨、
// token 上限独立、不引 config.ts/electron 链）
// ---------------------------------------------------------------------------

export interface FetchConsolidationTransportTarget {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  api?: 'openai-completions' | 'openai-responses';
  /** 测试注入（缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
}

/** 「关闭思考」启发式精简副本（源：flush.ts；qwen/qwq、glm/doubao、gpt-5 三族） */
function buildThinkingOffParams(modelId: string): Record<string, unknown> | null {
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
export function createFetchConsolidationModelCall(
  target: FetchConsolidationTransportTarget
): ConsolidationModelCall {
  return async (input) => {
    const base = (target.baseUrl || '').trim().replace(/\/+$/, '');
    const key = (target.apiKey || '').trim();
    if (!base || !key) throw new Error('巩固模型未配置 baseUrl/apiKey');
    const doFetch = target.fetchImpl ?? (globalThis.fetch as typeof fetch);
    const api = target.api ?? 'openai-completions';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'api-key': key
    };
    const extra = buildThinkingOffParams(target.modelId) ?? {};
    if (api === 'openai-responses') {
      const res = await doFetch(`${base}/responses`, {
        method: 'POST',
        signal: input.signal,
        headers,
        body: JSON.stringify({
          model: target.modelId,
          instructions: input.system,
          input: input.user,
          max_output_tokens: CONSOLIDATION_MODEL_CONSTANTS.MAX_OUTPUT_TOKENS,
          text: { format: { type: 'json_object' } },
          ...extra
        })
      });
      if (!res.ok) throw new Error(`巩固 LLM ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return parseMemoryResponsesOutput(await res.json());
    }
    const url = /\/v\d+$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const res = await doFetch(url, {
      method: 'POST',
      signal: input.signal,
      headers,
      body: JSON.stringify({
        model: target.modelId,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user }
        ],
        max_tokens: CONSOLIDATION_MODEL_CONSTANTS.MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
        ...extra
      })
    });
    if (!res.ok) throw new Error(`巩固 LLM ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>;
    };
    if(data.choices?.[0]?.finish_reason==='length')throw new Error('记忆模型输出因长度限制未完成');
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  };
}
