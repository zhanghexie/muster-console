import { t } from '../../shared/i18n';
import { normalizeAnthropicBaseUrl, normalizePiBaseUrl } from '../../shared/piCatalog';

/** 设置页「测试连接」的等待上限：够慢网握手，又不至于让按钮转到用户放弃 */
const LLM_PROBE_TIMEOUT_MS = 12_000;

/**
 * 测试大模型服务商连通性：发送极小请求探活，返回延迟与错误信息。
 */
export async function testLlmConnection(args: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  api?: import('../../shared/types').LlmApiProtocol;
}): Promise<import('../../shared/types').LlmTestResult> {
  const startedAt = Date.now();
  const isResponsesApi = args.api === 'openai-responses';
  const isAnthropicApi = args.api === 'anthropic-messages';
  // F-01：非 anthropic 协议复用运行时同款 /v1 归一化——网关 baseUrl 不带 /vN 时
  // 探针与 pi 实际请求打同一路径，不再「探针 404、保存后却能聊」的两张皮。
  // Anthropic 目录可能已含 /v1。保留网关前缀，再拼一次协议路径。
  const base = isAnthropicApi
    ? normalizeAnthropicBaseUrl(args.baseUrl)
    : normalizePiBaseUrl(args.baseUrl);
  const url = isAnthropicApi
    ? base + '/v1/messages'
    : isResponsesApi
      ? base + '/responses'
      : base + '/chat/completions';
  const apiKey = args.apiKey.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_PROBE_TIMEOUT_MS);
  try {
    const payload = isResponsesApi
      ? {
          model: args.model?.trim() || 'gpt-4o',
          input: 'hi',
          max_output_tokens: 16
        }
      : {
          model: args.model?.trim() || 'default',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1
        };

    const authHeaders: Record<string, string> = isAnthropicApi
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}`, 'api-key': apiKey };
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload)
    });
    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        durationMs,
        error: `HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`
      };
    }
    return { ok: true, durationMs };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    return {
      ok: false,
      durationMs,
      error: (e as Error).name === 'AbortError' ? t('连接超时（12秒未响应）') : (e as Error).message
    };
  } finally {
    clearTimeout(timer);
  }
}
