import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import { t } from '../../shared/i18n';
import type { ModelParameterDescriptor } from '../../shared/modelParameters';
import { coreReasoningMatchesEndpoint, reasoningBudgetValues, type CoreReasoningBinding, type PublishedCoreReasoningBinding } from './coreReasoningCatalog';
import { PI_THINKING_LEVELS } from './piReasoningCatalog';

export function supportsCoreReasoning(binding: CoreReasoningBinding, value?: string | null): value is string {
  const { effort, canDisable, canEnable, budget } = binding.reasoning;
  return typeof value === 'string' && (effort.includes(value) || (value === 'off' && canDisable) || (value === 'on' && canEnable) ||
    reasoningBudgetValues(budget).some(tokens => value === `budget-${tokens}`));
}

export function describeCoreReasoning(binding: CoreReasoningBinding, modeLevel?: string): ModelParameterDescriptor {
  const { canDisable, canEnable, budget, effort, defaultEffort } = binding.reasoning;
  const effectiveDefault = supportsCoreReasoning(binding, modeLevel) ? modeLevel : defaultEffort;
  return {
    id: 'reasoning', semantic: 'reasoning', label: t('思考强度'), apply: 'next-turn', supportsDefault: true,
    ...(effectiveDefault === undefined ? {} : { defaultValue: effectiveDefault }),
    options: [
      ...(canDisable ? [{ value: 'off', label: t('关闭') }] : []),
      ...(canEnable ? [{ value: 'on', label: t('开启') }] : []),
      ...effort.map(value => ({ value, label: value })),
      ...reasoningBudgetValues(budget).map(tokens => ({ value: `budget-${tokens}`, label: `${tokens.toLocaleString()} tokens` }))
    ]
  };
}

/** Set only reasoning fields on an already constructed SDK request. */
export function applyCoreReasoning(payload: unknown, binding: PublishedCoreReasoningBinding, value?: string): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const next = { ...payload } as Record<string, unknown>;
  const selected = supportsCoreReasoning(binding, value) ? value : undefined;
  const off = selected === 'off' && binding.reasoning.canDisable;
  const effort = selected && binding.reasoning.effort.includes(selected) ? selected : undefined;
  const budget = selected?.startsWith('budget-') ? Number(selected.slice(7)) : undefined;
  if (binding.reasoning.format === 'openai') {
    const { effort: _sdkEffort, ...rest } = next.reasoning as Record<string, unknown> | undefined ?? {};
    if (off) { next.reasoning = { effort: 'none' }; }
    else if (effort) { next.reasoning = { ...rest, effort }; }
    else if (Object.keys(rest).length) { next.reasoning = rest; }
    else delete next.reasoning;
    return next;
  }
  delete next.reasoning_effort;
  delete next.thinking;
  delete next.enable_thinking;
  delete next.thinking_budget;
  if (selected === undefined) return next;
  const { format, canEnable, canDisable } = binding.reasoning;
  if (format === 'openai-chat') {
    delete next.reasoning;
    next.reasoning_effort = off ? 'none' : selected === 'on' ? 'medium' : effort;
    return next;
  }
  if (format === 'deepseek') next.thinking = { type: off ? 'disabled' : 'enabled' };
  if (format === 'zai') next.thinking = off ? { type: 'disabled' } : { type: 'enabled', clear_thinking: false };
  if (format === 'qwen' || (format === 'siliconflow' && (canEnable || canDisable))) next.enable_thinking = !off;
  if (effort && !off) next.reasoning_effort = effort;
  if (budget !== undefined && !off) next.thinking_budget = budget;
  return next;
}

/**
 * Pi needs an internal slot for session state and request construction. The exact
 * value stays in the host's per-turn control, including values newer than Pi.
 */
export function configurePiReasoning(runtime: Pick<ModelRuntime, 'streamSimple'>,
  model: Model<Api>, binding: CoreReasoningBinding) {
  if (!coreReasoningMatchesEndpoint(binding, model.baseUrl, model.api, model.id)) {
    throw new Error('Core reasoning capability does not match the model endpoint');
  }
  if ('native' in binding) {
    return {
      model: { ...model, reasoning: true, thinkingLevelMap: binding.native.thinkingLevelMap,
        compat: { ...model.compat, ...binding.native.compat } } as Model<Api>,
      setLevel(requested?: string | null, modeLevel?: string): ModelThinkingLevel {
        const desired = supportsCoreReasoning(binding, requested) ? requested : supportsCoreReasoning(binding, modeLevel)
          ? modeLevel : binding.reasoning.defaultEffort;
        return PI_THINKING_LEVELS.find(level => level === desired) ?? 'off';
      }
    };
  }
  const { canDisable, defaultEffort, effort, format } = binding.reasoning;
  const carrier = PI_THINKING_LEVELS.find(level => level !== 'off' && (level === defaultEffort || effort.includes(level))) ?? 'high';
  const map: ThinkingLevelMap = {};
  for (const level of PI_THINKING_LEVELS) {
    const available = level === 'off' ? canDisable : level === carrier || effort.includes(level);
    map[level] = available ? level : null;
  }

  let selected: string | undefined;
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (current, context, options) => {
    if (current.provider !== model.provider || !coreReasoningMatchesEndpoint(binding, current.baseUrl, current.api, current.id)) {
      return stream(current, context, options);
    }
    const value = selected;
    return stream(current, context, { ...options, onPayload: async (payload, actual) => {
      const next = await options?.onPayload?.(payload, actual) ?? payload;
      return coreReasoningMatchesEndpoint(binding, actual.baseUrl, actual.api, actual.id)
        ? applyCoreReasoning(next, binding, value) : next;
    } });
  };
  const thinkingFormat = format === 'siliconflow' ? 'qwen' : format === 'openai-chat' ? 'openai' : format;
  const configured = { ...model, reasoning: true, thinkingLevelMap: map,
    ...(format === 'openai' ? {} : { compat: { ...model.compat, thinkingFormat, supportsReasoningEffort: true,
      ...(format === 'deepseek' ? { requiresReasoningContentOnAssistantMessages: true } : {}) } }) };
  return {
    model: configured,
    setLevel(requested?: string | null, modeLevel?: string): ModelThinkingLevel {
      selected = supportsCoreReasoning(binding, requested) ? requested : supportsCoreReasoning(binding, modeLevel) ? modeLevel : undefined;
      const desired = selected ?? defaultEffort;
      return PI_THINKING_LEVELS.find(level => level === desired && map[level] !== null) ?? carrier;
    }
  };
}
