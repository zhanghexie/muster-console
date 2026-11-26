import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PiSyncResult } from './piConfigSync';

// The custom model descriptor requires a numeric budget even when the endpoint
// publishes no limit. For ordinary calls, omit that estimate on optional wire fields.
export function useProviderOutputDefaults(runtime: Pick<ModelRuntime, 'streamSimple'>,
  models: PiSyncResult['providerDefaultOutput']): void {
  if (!models?.length) return;
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    if (options?.maxTokens !== undefined || !models.some(m => m.provider === model.provider && m.id === model.id)) {
      return stream(model, context, options);
    }
    const api = model.api;
    if (!['openai-completions', 'openai-responses', 'azure-openai-responses', 'google-generative-ai', 'mistral-conversations'].includes(api)) {
      return stream(model, context, options);
    }
    return stream(model, context, { ...options, onPayload: async (payload, current) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return options?.onPayload?.(payload, current);
      const copy = { ...payload } as Record<string, unknown>;
      if (api === 'google-generative-ai') {
        if (copy.config && typeof copy.config === 'object') {
          const config = { ...copy.config } as Record<string, unknown>;
          delete config.maxOutputTokens;
          copy.config = config;
        }
      } else if (api === 'openai-completions') {
        delete copy.max_tokens;
        delete copy.max_completion_tokens;
      } else if (api === 'mistral-conversations') {
        delete copy.maxTokens;
      } else {
        delete copy.max_output_tokens;
      }
      return await options?.onPayload?.(copy, current) ?? copy;
    } });
  };
}
