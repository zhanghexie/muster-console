/**
 * 无头 LLM 读屏：一次非流式短补全，不进调度对话、不拉 Worker。
 */
import type { OpenAIConfig } from '../../shared/types';
import type { SessionPhaseKind } from '../../shared/types';
import { parseScreenClassifyOutput, SCREEN_CLASSIFY_MAX_CHARS } from '../../shared/screenClassify';

/** 读屏是后台旁路，超时就当 unknown，别把生命周期轮询拖住 */
const CLASSIFY_TIMEOUT_MS = 12_000;

const SYSTEM = `You classify a coding-agent terminal screen (plain text).
Reply with exactly one token: idle | needs_you | done | unknown
- idle: ordinary conversation ended or the agent is awaiting a new task
- needs_you: the user must supply input, make a decision, grant permission or accept delivery
- done: an explicit task was delivered and verified, with no user action pending
- unknown: cannot tell`;

export async function classifyTerminalScreen(
  cfg: OpenAIConfig,
  screenText: string,
  signal?: AbortSignal
): Promise<SessionPhaseKind | 'unknown'> {
  const key = cfg.apiKey?.trim();
  const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!key || !base) return 'unknown';
  const url = /\/v\d+$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const text = screenText.slice(-SCREEN_CLASSIFY_MAX_CHARS);
  const ac = new AbortController();
  const abort = () => ac.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => ac.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    ac.signal.throwIfAborted();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'api-key': key
      },
      body: JSON.stringify({
        model: cfg.model || 'default',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: text || '(empty screen)' }
        ],
        max_tokens: 8,
        stream: false
      }),
      signal: ac.signal
    });
    if (!res.ok) throw new Error(`classify HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    return parseScreenClassifyOutput(content);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
