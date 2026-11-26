/** ACP session model options as declared by the connected agent. */
import type { HarnessModelGroup } from '../../../../shared/harnessPicker';
export interface AcpModelItem { id: string; name: string; group?: HarnessModelGroup }
export interface AcpModelList { items: AcpModelItem[]; currentModelId?: string }
export interface AcpReasoningOption {
  configId: string;
  options: Array<{ value: string; label: string }>;
  currentValue?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeId = (value: unknown): string =>
  typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f]/.test(value) ? value.trim() : '';
const safeName = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() && !/[\u0000-\u001f]/.test(value) ? value.trim().slice(0, 200) : fallback;

function optionRecords(options: unknown, preserveGroups = false): Record<string, unknown>[] {
  if (!Array.isArray(options)) return [];
  const flat: Record<string, unknown>[] = [];
  for (const entry of options.slice(0, 1024)) {
    const item = record(entry);
    if (Array.isArray(item.options)) {
      const groupId = safeId(item.group ?? item.id);
      const groupLabel = safeName(item.name, groupId);
      for (const child of item.options.slice(0, 1024)) flat.push({ ...record(child),
        displayGroup: preserveGroups && groupId && groupLabel ? { id: groupId, label: groupLabel } : undefined });
    } else flat.push({ ...item, displayGroup: undefined });
    if (flat.length >= 1024) break;
  }
  return flat.slice(0, 1024);
}

function modelOption(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const options = Array.isArray(metadata.configOptions) ? metadata.configOptions.map(record) : [];
  return options.find(option => option.id === 'model' && option.type === 'select')
    ?? options.find(option => option.category === 'model' && option.type === 'select');
}

export function consumedAcpConfigIds(metadata: Record<string, unknown>): Set<unknown> {
  const ids = new Set<unknown>();
  const model = modelOption(metadata);
  if (model) ids.add(model.id);
  const reasoning = parseAcpReasoningOption(metadata);
  if (reasoning) ids.add(reasoning.configId);
  return ids;
}

/** Only expose thinking controls explicitly advertised by this agent and model. */
export function parseAcpReasoningOption(raw: unknown): AcpReasoningOption | undefined {
  const metadata = record(raw);
  const selects = (Array.isArray(metadata.configOptions) ? metadata.configOptions : [])
    .slice(0, 64).map(record).filter(option => option.type === 'select');
  const names = ['reasoning_effort', 'thought_level', 'effort', 'thinking'];
  const option = names.map(name => selects.find(item => item.id === name)).find(Boolean)
    ?? names.map(name => selects.find(item => item.category === name)).find(Boolean);
  if (!option) return undefined;
  const configId = safeId(option.id);
  if (!configId) return undefined;
  const seen = new Set<string>();
  const choices: AcpReasoningOption['options'] = [];
  for (const item of optionRecords(option.options)) {
    const value = safeId(item.value ?? item.id);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    choices.push({ value, label: safeName(item.name ?? item.label, value) });
    if (choices.length >= 128) break;
  }
  if (!choices.length) return undefined;
  const currentValue = safeId(option.currentValue);
  return { configId, options: choices, ...(seen.has(currentValue) ? { currentValue } : {}) };
}

export function acpReasoningSelection(raw: unknown, sessionId: string, value: string): {
  sessionId: string; configId: string; value: string;
} {
  const option = parseAcpReasoningOption(raw);
  if (!option || !option.options.some(item => item.value === value)) {
    throw new Error('ACP 引擎未声明所选思考强度；请刷新模型参数或使用引擎默认值');
  }
  return { sessionId, configId: option.configId, value };
}

/** Handles both current configOptions and the legacy ACP models object. */
export function parseAcpModelList(raw: unknown): AcpModelList {
  const metadata = record(raw);
  const option = modelOption(metadata);
  const models = record(metadata.models);
  const entries = option ? optionRecords(option.options, true) : optionRecords(models.availableModels);
  const seen = new Set<string>();
  const items: AcpModelItem[] = [];
  for (const entry of entries) {
    const id = safeId(option ? entry.value ?? entry.id : entry.modelId ?? entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, name: safeName(entry.name ?? entry.label, id),
      ...(entry.displayGroup ? { group: entry.displayGroup as HarnessModelGroup } : {}) });
  }
  const currentModelId = safeId(option?.currentValue ?? models.currentModelId);
  return { items, ...(currentModelId ? { currentModelId } : {}) };
}

export type AcpModelSelection =
  | { method: 'session/set_config_option'; params: { sessionId: string; configId: string; value: string } }
  | { method: 'session/set_model'; params: { sessionId: string; modelId: string } };

/** Select only advertised options, and let the caller wait for the agent's acknowledgement. */
export function acpModelSelection(raw: unknown, sessionId: string, modelId: string): AcpModelSelection {
  const metadata = record(raw);
  const selected = safeId(modelId);
  if (!selected) throw new Error('ACP 模型 ID 无效');
  const list = parseAcpModelList(metadata);
  if (!list.items.some(item => item.id === selected)) {
    throw new Error(`ACP agent 未声明所选模型 ${selected}；请刷新模型目录或使用引擎默认模型`);
  }
  const option = modelOption(metadata);
  if (option) {
    const configId = safeId(option.id);
    if (!configId) throw new Error('ACP agent 的模型配置缺少有效 ID');
    return { method: 'session/set_config_option', params: { sessionId, configId, value: selected } };
  }
  return { method: 'session/set_model', params: { sessionId, modelId: selected } };
}
