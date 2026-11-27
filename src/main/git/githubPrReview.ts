import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import type { AppContext } from '../context';
import { resolveLlmConfig } from '../config';
import { normalizePiBaseUrl } from '../agent/piConfigSync';
import { loadPiSdk } from '../agentSession/drivers/pi/piSdk';
import { redactCredentialShapes } from '../memory/redact';
import { t } from '../../shared/i18n';
import { PR_REVIEW_SYSTEM_PROMPT } from '../../shared/prReviewPrompt';
import { GitHubPrError } from './githubHttp';

export async function generateGitHubPrReview(ctx: AppContext, evidence: string): Promise<{ body: string; partial: boolean }> {
  const { provider, model } = resolveLlmConfig(ctx.config.get());
  if (!model.id || provider.enabled === false || !provider.baseUrl?.trim() || !provider.apiKey?.trim() ||
      !(model.modalities ?? provider.modalities ?? ['text']).includes('text')) {
    throw new GitHubPrError('configuration', t('请先在模型设置中配置可用的文本模型'));
  }
  const pi = await loadPiSdk();
  const values = new Map<string, Credential>([[provider.id, { type: 'api_key', key: provider.apiKey }]]);
  const credentials: CredentialStore = {
    async read(id) { return values.get(id); },
    async list() { return [...values].map(([providerId, value]) => ({ providerId, type: value.type })); },
    async modify(id, update) {
      const next = await update(values.get(id));
      if (next) values.set(id, next); else values.delete(id);
      return next;
    },
    async delete(id) { values.delete(id); }
  };
  const runtime = await pi.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const api = provider.api ?? 'openai-completions';
  const baseUrl = api === 'openai-completions' || api === 'openai-responses'
    ? normalizePiBaseUrl(provider.baseUrl) : provider.baseUrl.trim().replace(/\/+$/, '');
  const contextWindow = model.contextWindow ?? 16_384;
  runtime.registerProvider(provider.id, { api, name: provider.name, baseUrl, authHeader: true, models: [{
    id: model.id, name: model.name || model.id, contextWindow, maxTokens: model.maxTokens ?? 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, input: ['text'], reasoning: false
  }] });
  const configured = runtime.getModel(provider.id, model.id);
  if (!configured) throw new GitHubPrError('configuration', t('请先在模型设置中配置可用的文本模型'));
  const budget = Math.max(1024, contextWindow * 2 - 4096);
  const redacted = redactCredentialShapes(evidence).text;
  const input = redacted.length > budget ? `${redacted.slice(0, budget)}\n[Partial repository evidence]` : redacted;
  const response = await runtime.completeSimple(configured, {
    systemPrompt: PR_REVIEW_SYSTEM_PROMPT, messages: [{ role: 'user', content: input, timestamp: Date.now() }]
  }, { maxTokens: Math.min(2000, model.maxTokens ?? 2048), signal: AbortSignal.timeout(90_000) });
  const body = response.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n').trim();
  if (!body || response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new GitHubPrError('failed', t('生成 GitHub 审查草稿失败，请检查模型设置后重试'));
  }
  return { body: redactCredentialShapes(body).text.slice(0, 24_000), partial: redacted.length > budget };
}
