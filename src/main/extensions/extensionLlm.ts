import type { AppContext } from '../context';
import { validateLlmChatRequest } from '../../shared/extensions';
import { errorMessage } from '../../shared/errors';
import { t } from '../../shared/i18n';
const LLM_PER_EXT_CONCURRENCY = 2;
const llmInFlight = new Map<string, number>();

export async function llmChat(
  ctx: AppContext,
  extId: string,
  rawMessages: unknown,
  rawOpts?: unknown,
  concurrencyKey: string = extId,
  signal?: AbortSignal
): Promise<{ text: string }> {
  const v = validateLlmChatRequest(rawMessages, rawOpts);
  if (!v.ok) throw new Error(v.error);
  if (signal?.aborted) { const error = new Error(t('已取消')); error.name = 'AbortError'; throw error; }
  const startedAt = Date.now();
  const { openai } = ctx.config.get();
  const remember = (ok: boolean, extra: { text?: string; error?: string }): void => {
    try {
      ctx.usage?.recordExtLlmCall({
        extId,
        model: openai.model,
        messages: v.messages,
        maxTokens: v.maxTokens,
        temperature: v.temperature,
        ok,
        text: extra.text,
        error: extra.error,
        durationMs: Date.now() - startedAt,
        startedAt
      });
    } catch {
      /* 统计失败不影响调用结果 */
    }
  };
  if (!openai.apiKey?.trim() || !openai.baseUrl?.trim()) {
    const error = t('宿主未配置 LLM（设置中填写 OpenAI 兼容 baseUrl/apiKey）');
    remember(false, { error });
    throw new Error(error);
  }
  const running = llmInFlight.get(concurrencyKey) ?? 0;
  if (running >= LLM_PER_EXT_CONCURRENCY) {
    const error = t('LLM 请求过于频繁（每面板最多 2 个在途）');
    remember(false, { error });
    throw new Error(error);
  }
  llmInFlight.set(concurrencyKey, running + 1);
  const controller = new AbortController();
  let interrupted: 'cancelled' | 'timeout' | undefined;
  const cancel = (): void => { interrupted ??= 'cancelled'; controller.abort(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { interrupted ??= 'timeout'; controller.abort(); }, v.timeoutMs);
  try {
    const url = openai.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openai.apiKey}`
      },
      body: JSON.stringify({
        model: openai.model,
        messages: v.messages,
        max_tokens: v.maxTokens,
        temperature: v.temperature,
        stream: false,
        ...(v.thinking && v.thinking !== 'off' ? { reasoning_effort: v.thinking === 'light' ? 'low' : v.thinking } : {})
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${body.slice(0, 200) || res.statusText}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    controller.signal.throwIfAborted();
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) throw new Error(t('LLM 返回空内容'));
    remember(true, { text });
    return { text };
  } catch (e) {
    const error = interrupted === 'cancelled' ? t('已取消')
      : interrupted === 'timeout' ? t('LLM 请求超时（>{{sec}}s）', { sec: v.timeoutMs / 1000 })
      : errorMessage(e);
    remember(false, { error });
    const failure = new Error(error, { cause: e });
    if (interrupted) failure.name = interrupted === 'cancelled' ? 'AbortError' : 'TimeoutError';
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    const left = (llmInFlight.get(concurrencyKey) ?? 1) - 1;
    if (left > 0) llmInFlight.set(concurrencyKey, left);
    else llmInFlight.delete(concurrencyKey);
  }
}

export type ExtensionLlmDelta = (delta: string) => void;

/** OpenAI-compatible streaming call used by the extension surface. */
export async function llmChatStream(
  ctx: AppContext,
  extId: string,
  rawMessages: unknown,
  rawOpts: unknown,
  onDelta: ExtensionLlmDelta,
  concurrencyKey: string = extId,
  signal?: AbortSignal
): Promise<{ text: string }> {
  const v = validateLlmChatRequest(rawMessages, rawOpts);
  if (!v.ok) throw new Error(v.error);
  if (signal?.aborted) { const error = new Error(t('已取消')); error.name = 'AbortError'; throw error; }
  const startedAt = Date.now();
  const { openai } = ctx.config.get();
  const remember = (ok: boolean, extra: { text?: string; error?: string }): void => {
    try {
      ctx.usage?.recordExtLlmCall({ extId, model: openai.model, messages: v.messages, maxTokens: v.maxTokens, temperature: v.temperature,
        ok, text: extra.text, error: extra.error, durationMs: Date.now() - startedAt, startedAt });
    } catch { /* usage failure must not change the call result */ }
  };
  if (!openai.apiKey?.trim() || !openai.baseUrl?.trim()) {
    const error = t('宿主未配置 LLM（设置中填写 OpenAI 兼容 baseUrl/apiKey）'); remember(false, { error }); throw new Error(error);
  }
  const running = llmInFlight.get(concurrencyKey) ?? 0;
  if (running >= LLM_PER_EXT_CONCURRENCY) {
    const error = t('LLM 请求过于频繁（每面板最多 2 个在途）'); remember(false, { error }); throw new Error(error);
  }
  llmInFlight.set(concurrencyKey, running + 1);
  const controller = new AbortController();
  let interrupted: 'cancelled' | 'timeout' | undefined;
  const cancel = (): void => { interrupted ??= 'cancelled'; controller.abort(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { interrupted ??= 'timeout'; controller.abort(); }, v.timeoutMs);
  try {
    const res = await fetch(openai.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openai.apiKey}` },
      body: JSON.stringify({ model: openai.model, messages: v.messages, max_tokens: v.maxTokens, temperature: v.temperature, stream: true,
        ...(v.thinking && v.thinking !== 'off' ? { reasoning_effort: v.thinking === 'light' ? 'low' : v.thinking } : {}) })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${body.slice(0, 200) || res.statusText}`);
    }
    if (!res.body) throw new Error(t('LLM 未返回流式响应体'));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let done = false;
    const consume = (line: string): void => {
      const value = line.trim();
      if (!value || !value.startsWith('data:')) return;
      const payload = value.slice(5).trim();
      if (payload === '[DONE]') { done = true; return; }
      let data: { choices?: Array<{ delta?: { content?: unknown } }> };
      try { data = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }; }
      catch { return; }
      const delta = data.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) { text += delta; onDelta(delta); }
    };
    while (!done) {
      controller.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) { consume(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1); index = buffer.indexOf('\n'); }
    }
    buffer += decoder.decode();
    if (buffer) consume(buffer);
    controller.signal.throwIfAborted();
    if (!text.trim()) throw new Error(t('LLM 返回空内容'));
    remember(true, { text });
    return { text };
  } catch (e) {
    const error = interrupted === 'cancelled' ? t('已取消')
      : interrupted === 'timeout' ? t('LLM 请求超时（>{{sec}}s）', { sec: v.timeoutMs / 1000 })
      : errorMessage(e);
    remember(false, { error });
    const failure = new Error(error, { cause: e });
    if (interrupted) failure.name = interrupted === 'cancelled' ? 'AbortError' : 'TimeoutError';
    throw failure;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    const left = (llmInFlight.get(concurrencyKey) ?? 1) - 1;
    if (left > 0) llmInFlight.set(concurrencyKey, left); else llmInFlight.delete(concurrencyKey);
  }
}
