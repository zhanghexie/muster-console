import { createHash } from 'node:crypto';
import type { LlmModelConfig, LlmProviderConfig } from '../../shared/types';

/** The selected connection's execution settings, without display names or unrelated models.
 * Credentials participate only in the digest; callers must never log its input. */
export function llmConnectionIdentity({ provider, model, catalogInput }: {
  provider: LlmProviderConfig;
  model: LlmModelConfig;
  catalogInput?: Pick<LlmModelConfig, 'contextWindow' | 'multimodal'>;
}): string {
  // Local SDK priming can refine defaults during connection setup. Only a
  // published change to the selected model's effective input invalidates it.
  const configuredModel = provider.models?.find(item => item.id === model.id) ?? { id: model.id };
  const { name: _name, ...modelConfig } = configuredModel;
  const value = {
    provider: {
      id: provider.id,
      api: provider.api ?? 'openai-completions',
      baseUrl: provider.baseUrl?.trim().replace(/\/+$/, ''),
      apiKey: provider.apiKey?.trim(),
      enabled: provider.enabled !== false,
      thinking: provider.thinking,
      compat: provider.compat,
      modalities: provider.modalities
    },
    model: modelConfig,
    catalogInput
  };
  const canonical = JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item);
  return createHash('sha256').update(canonical).digest('hex');
}
