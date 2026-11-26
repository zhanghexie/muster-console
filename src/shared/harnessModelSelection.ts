/** Missing key means all models; a present list is the user's explicit selection. */
export type HarnessModelSelections = Record<string, string[]>;
const selectedSets = new WeakMap<string[], ReadonlySet<string>>();

export function harnessModelSelectionKey(runtimeId: string, agentId?: string): string {
  return runtimeId === 'acp' && agentId ? `acp:${agentId}` : `runtime:${runtimeId}`;
}

/** Core can expose the same model ID from different providers. */
export function harnessModelId(runtimeId: string, providerId: string, modelId: string): string {
  return runtimeId === 'pi' ? JSON.stringify([providerId, modelId]) : modelId;
}

export function isHarnessModelSelected(
  selections: HarnessModelSelections,
  key: string,
  modelId: string
): boolean {
  if (!Object.hasOwn(selections, key)) return true;
  const ids = selections[key]!;
  let set = selectedSets.get(ids);
  if (!set) { set = new Set(ids); selectedSets.set(ids, set); }
  return set.has(modelId);
}

export function normalizeHarnessModelSelections(value: unknown): HarnessModelSelections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: HarnessModelSelections = {};
  for (const [key, ids] of Object.entries(value)) {
    if (!validHarnessModelKey(key) || !Array.isArray(ids) || ids.length > 8192) continue;
    if (!ids.every(validHarnessModelId)) continue;
    result[key] = [...new Set(ids)];
  }
  return result;
}

export function validHarnessModelKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
}

export function validHarnessModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}
