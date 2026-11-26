import type { ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

export const PI_THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface PiReasoningModel {
  readonly id: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly compat?: Record<string, unknown>;
}

export type PiReasoningShard = Readonly<Record<string, PiReasoningModel>>;

export const isCatalogRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function catalogHttpsUrl(value: unknown, allowQuery = false): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  const url = URL.parse(value);
  if (url?.protocol === 'https:' && !url.username && !url.password && (allowQuery || (!url.search && !url.hash))) return url;
}

/** Pi begins at medium, then selects the next supported slot or the highest lower one. */
export function piDefaultThinkingLevel(levels: readonly ModelThinkingLevel[]): ModelThinkingLevel {
  return PI_THINKING_LEVELS.slice(3).find(level => levels.includes(level)) ?? levels.at(-1) ?? 'off';
}

export function piThinkingLevels(model: Pick<PiReasoningModel, 'reasoning' | 'thinkingLevelMap'>): ModelThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  return PI_THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (level === 'xhigh' || level === 'max' ? mapped !== undefined : true);
  });
}

function reasoningCompat(value: unknown): PiReasoningModel['compat'] {
  if (!isCatalogRecord(value)) return;
  const compat: Record<string, unknown> = {};
  for (const key of ['supportsReasoningEffort', 'requiresReasoningContentOnAssistantMessages', 'forceAdaptiveThinking',
    'allowEmptySignature', 'supportsMidConvoEffort', 'supportsThinkingTokenBudget']) {
    if (typeof value[key] === 'boolean') compat[key] = value[key];
  }
  if (typeof value.thinkingFormat === 'string' && ['openai', 'openrouter', 'deepseek', 'together', 'baseten',
    'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'].includes(value.thinkingFormat)) {
    compat.thinkingFormat = value.thinkingFormat;
  }
  if (typeof value.thinkingTokenBudgetField === 'string' &&
    ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'].includes(value.thinkingTokenBudgetField)) {
    compat.thinkingTokenBudgetField = value.thinkingTokenBudgetField;
  }
  for (const key of ['chatTemplateArgs', 'chatTemplateKwargs']) {
    const args = value[key];
    if (!isCatalogRecord(args)) continue;
    compat[key] = Object.fromEntries(Object.entries(args).filter(([name, setting]) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(name) && (setting === null ||
        ['string', 'boolean', 'number'].includes(typeof setting) ||
        (isCatalogRecord(setting) && Object.keys(setting).every(field => field === '$var' || field === 'omitWhenOff') &&
          ['thinking.enabled', 'thinking.effort', 'thinking.budget'].some(variable => variable === setting.$var) &&
          (setting.omitWhenOff === undefined || typeof setting.omitWhenOff === 'boolean')))));
  }
  return Object.keys(compat).length ? compat : undefined;
}

/** Project only capability fields. Provider URLs here are identities for lookups. */
export function projectPiReasoningModel(value: unknown, provider?: string): PiReasoningModel | undefined {
  if (!isCatalogRecord(value)) return;
  const { id, api, baseUrl, type, reasoning, thinkingLevelMap } = value;
  if ((type !== undefined && type !== 'chat') || typeof id !== 'string' || !/^\S{1,512}$/.test(id) ||
    typeof api !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(api) ||
    typeof baseUrl !== 'string' || (!catalogHttpsUrl(baseUrl) && !(provider === 'azure' && baseUrl === '')) ||
    typeof reasoning !== 'boolean') return;
  let map: ThinkingLevelMap | undefined;
  if (thinkingLevelMap !== undefined) {
    if (!isCatalogRecord(thinkingLevelMap)) return;
    map = {};
    for (const level of PI_THINKING_LEVELS) {
      const mapped = thinkingLevelMap[level];
      if (mapped === null || (typeof mapped === 'string' && mapped.length <= 128)) map[level] = mapped;
      else if (mapped !== undefined) return;
    }
  }
  const compat = reasoningCompat(value.compat);
  return { id, baseUrl, api, reasoning, ...(map ? { thinkingLevelMap: map } : {}), ...(compat ? { compat } : {}) };
}

export function parsePiReasoningShard(value: unknown, provider?: string): PiReasoningShard {
  const raw = Array.isArray(value) ? value : isCatalogRecord(value)
    ? (Array.isArray(value.models) ? value.models : Object.values(value)) : [];
  const models = new Map<string, PiReasoningModel>();
  for (const item of raw) {
    if (isCatalogRecord(item) && item.type !== undefined && item.type !== 'chat') continue;
    const model = projectPiReasoningModel(item, provider);
    if (!model || models.has(model.id)) throw new Error('Invalid Pi reasoning model');
    models.set(model.id, model);
  }
  if (!models.size) throw new Error('Empty Pi reasoning catalog');
  return Object.fromEntries(models);
}
