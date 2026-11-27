/**
 * 划词「文本工具」执行：apiKey 只在主进程使用；
 * 模型逐级回落：功能指定 → 功能组默认 → 全局 active（resolveLlmConfig）。
 * completions 协议传 onDelta 时走 SSE 流式（边生成边推）；responses 协议始终非流式。
 */
import type {
  AppConfig,
  LlmProviderConfig,
  TextToolRunRequest,
  TextToolRunResult
} from '../../shared/types';
import { resolveLlmConfig } from '../config';
import { t } from '../../shared/i18n';

const RUN_TIMEOUT_MS = 60_000;
/** 输入保护：超长选区截断，避免单次请求爆上下文/预算 */
const MAX_INPUT_CHARS = 24_000;
const MAX_OUTPUT_TOKENS = 4096;

/**
 * 「关闭思考」启发式：按模型名/网关附加各家的关闭/降档参数（尽力而为，
 * 未识别的模型不附加任何参数，避免被严格网关 400）。
 * - Qwen（通义/SiliconFlow/vLLM）：enable_thinking:false + chat_template_kwargs
 * - GLM（智谱）/ 豆包：thinking:{type:'disabled'}
 * - GPT-5：reasoning_effort:'minimal'；o 系/grok/gemini：'low'（responses 用 reasoning.effort）
 * - OpenRouter：reasoning:{enabled:false}
 * - DeepSeek reasoner 官方无关闭参数 → 不附加（请选 deepseek-chat 非思考版）
 */
export function buildThinkingOffParams(
  modelId: string,
  api: string,
  baseUrl: string
): Record<string, unknown> | null {
  const m = modelId.toLowerCase();
  const out: Record<string, unknown> = {};
  const effort = (v: 'minimal' | 'low'): void => {
    if (api === 'openai-responses') {
      out.reasoning = { ...(out.reasoning as object | undefined), effort: v };
    } else {
      out.reasoning_effort = v;
    }
  };
  if (/openrouter\.ai/i.test(baseUrl)) {
    out.reasoning = { enabled: false };
  }
  if (m.includes('qwen') || m.includes('qwq')) {
    out.enable_thinking = false;
    out.chat_template_kwargs = { enable_thinking: false };
  } else if (m.includes('glm') || m.includes('doubao')) {
    out.thinking = { type: 'disabled' };
  } else if (/^gpt-5/.test(m)) {
    effort('minimal');
  } else if (/^(o[134])\b/.test(m) || m.startsWith('o1-') || m.startsWith('o3-') || m.startsWith('o4-')) {
    effort('low');
  } else if (m.includes('gemini') || m.includes('grok')) {
    effort('low');
  }
  return Object.keys(out).length ? out : null;
}

/** 功能指定 → 功能组默认 → 全局 active；resolveLlmConfig 兜底无效引用 */
export function resolveTextToolLlm(
  config: AppConfig,
  fn: { providerId?: string; modelId?: string }
): { provider: LlmProviderConfig; modelId: string; baseUrl: string; apiKey: string } {
  const tt = config.textTools;
  const providerId = fn.providerId?.trim() || tt?.defaultProviderId?.trim() || undefined;
  const modelId = fn.modelId?.trim() || tt?.defaultModelId?.trim() || undefined;
  const { provider, model, openai } = resolveLlmConfig(config, { providerId, modelId });
  return {
    provider,
    modelId: model.id,
    baseUrl: openai.baseUrl,
    apiKey: openai.apiKey
  };
}

/** 解析 /responses 原始 JSON：output[].content[].text 拼接（SDK 的 output_text 快捷字段存在则直接用） */
function parseResponsesOutput(data: unknown): string {
  const d = data as { output_text?: unknown; output?: unknown };
  if (typeof d.output_text === 'string' && d.output_text) return d.output_text;
  let content = '';
  if (Array.isArray(d.output)) {
    for (const item of d.output) {
      const parts = (item as { content?: unknown })?.content;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === 'string') content += text;
      }
    }
  }
  return content;
}

/** SSE data: 行解析：delta.content 正文增量、delta.reasoning_content 思考段增量
 *  （DeepSeek 等推理模型先输出思考，不接住的话卡片会长时间"毫无动静"） */
async function streamCompletions(
  res: Response,
  onDelta: (delta: string) => void,
  onReasoning?: (piece: string) => void
): Promise<string> {
  if (!res.body) throw new Error(t('LLM 响应无 body'));
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let content = '';
  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: {
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
      error?: { message?: unknown } | string;
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    // OpenAI 兼容网关常在流中途以 data:{"error":…} 终止（配额/审查/网关故障）：
    // 识别后立即中断并抛出真实错误，避免最终误报「模型返回空内容」掩盖原因
    const streamError = chunk.error;
    if (streamError) {
      const detail = typeof streamError === 'string'
        ? streamError
        : typeof streamError.message === 'string' && streamError.message
          ? streamError.message
          : JSON.stringify(streamError);
      throw new Error(t('LLM 流返回错误：{{message}}', { message: detail }));
    }
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
      onReasoning?.(delta.reasoning_content);
    }
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }
  if (pending) handleLine(pending);
  return content;
}

export async function runTextTool(
  config: AppConfig,
  req: TextToolRunRequest,
  opts?: {
    onDelta?: (delta: string) => void;
    /** 模型解析完成、即将发请求（渲染层先亮出实际模型名） */
    onStart?: (modelLabel: string) => void;
    /** 模型思考段增量（reasoning_content；正文 content 之外的输出） */
    onReasoning?: (piece: string) => void;
  }
): Promise<TextToolRunResult> {
  const prompt = (req.prompt || '').trim();
  const text = (req.text || '').slice(0, MAX_INPUT_CHARS);
  if (!prompt) throw new Error(t('提示词为空'));
  if (!text.trim()) throw new Error(t('选中文本为空'));

  const { provider, modelId, baseUrl: rawBase, apiKey } = resolveTextToolLlm(config, req);
  if (!modelId) throw new Error(t('请先在模型设置中配置可用的文本模型'));
  const api = provider.api ?? 'openai-completions';
  if (api !== 'openai-completions' && api !== 'openai-responses') {
    throw new Error(t('「{{name}}」的 {{api}} 协议暂不支持文本工具，请换 OpenAI 兼容模型', { name: provider.name, api }));
  }
  const key = apiKey?.trim();
  const base = (rawBase || '').trim().replace(/\/+$/, '');
  if (!key || !base) {
    throw new Error(t('「{{name}}」未配置 baseUrl/apiKey（设置 → 模型服务商）', { name: provider.name }));
  }
  const modelLabel = `${provider.name} · ${modelId}`;
  const onDelta = opts?.onDelta;
  opts?.onStart?.(modelLabel);
  // 尽力关闭思考（缺省开）；未识别的模型返回 null 即不附加任何参数
  const thinkingParams =
    req.noThinking !== false ? buildThinkingOffParams(modelId, api, base) : null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);
  try {
    const headers = {
      'Content-Type': 'application/json',
      // 同时带两种鉴权头：多数服务认 Bearer，Azure/小米 MiMo 等认 api-key
      Authorization: `Bearer ${key}`,
      'api-key': key
    };
    let content: string;
    if (api === 'openai-responses') {
      const res = await fetch(`${base}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          instructions: prompt,
          input: text,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          ...(thinkingParams ?? {})
        }),
        signal: ac.signal
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${body.slice(0, 200) || res.statusText}`);
      }
      content = parseResponsesOutput((await res.json()) as unknown);
    } else {
      const url = /\/v\d+$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: text }
          ],
          max_tokens: MAX_OUTPUT_TOKENS,
          // 传 onDelta 即流式：首个 token 一出就往卡片推，不再等全文
          stream: Boolean(onDelta),
          ...(thinkingParams ?? {})
        }),
        signal: ac.signal
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${body.slice(0, 200) || res.statusText}`);
      }
      content =
        onDelta && res.body
          ? await streamCompletions(res, onDelta, opts?.onReasoning)
          : parseCompletionsOutput((await res.json()) as unknown);
    }
    if (!content.trim()) throw new Error(t('模型返回空内容'));
    return { text: content, modelLabel };
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(t('请求超时（>{{n}}s）', { n: RUN_TIMEOUT_MS / 1000 }));
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseCompletionsOutput(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: string } }> };
  return d.choices?.[0]?.message?.content ?? '';
}
