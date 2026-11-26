import type { HarnessModelGroup, HarnessPickerModel } from './harnessPicker';

const identity = (row: HarnessPickerModel): string => JSON.stringify([row.providerId, row.modelId]);
const labelKey = (row: HarnessPickerModel): string => JSON.stringify([row.group?.id ?? null, row.label]);

/** Keep native choices distinct; only equal identities may be deduplicated. */
export function pickerModelRows<T extends HarnessPickerModel>(models: readonly T[]): Array<T & HarnessPickerModel> {
  const unique = new Map<string, T>();
  for (const row of models) if (!unique.has(identity(row))) unique.set(identity(row), row);
  const rows = [...unique.values()];
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(labelKey(row), (counts.get(labelKey(row)) ?? 0) + 1);
  return rows.map(row => {
    if (row.detail || counts.get(labelKey(row)) === 1) return row;
    const ambiguousId = rows.some(other => identity(other) !== identity(row) && labelKey(other) === labelKey(row) && other.modelId === row.modelId);
    return { ...row, detail: ambiguousId ? `${row.providerId} / ${row.modelId}` : row.modelId };
  });
}

/** Group only explicitly supplied metadata, preserving first-seen group and model order. */
export function pickerModelGroups<T extends { group?: HarnessModelGroup }>(rows: readonly T[]): Array<{ group?: HarnessModelGroup; label?: string; items: T[] }> {
  const groups = new Map<string | null, { group?: HarnessModelGroup; label?: string; items: T[] }>();
  for (const row of rows) {
    const key = row.group?.id ?? null;
    if (!groups.has(key)) groups.set(key, { ...(row.group ? { group: row.group } : {}), items: [] });
    groups.get(key)!.items.push(row);
  }
  const result = [...groups.values()];
  for (const entry of result) if (entry.group) {
    entry.label = result.some(other => other !== entry && other.group?.label === entry.group!.label)
      ? `${entry.group.label} · ${entry.group.id}` : entry.group.label;
  }
  return result;
}

export function pickerModelTitle(row: HarnessPickerModel): string {
  return [...new Set([row.label, row.group?.label, row.group?.id, row.detail, row.modelId, row.nativeLaunchModel].filter(Boolean))].join('\n');
}

export function pickerModelSelectionLabel(row: HarnessPickerModel): string {
  return [row.group?.label, row.label, row.detail].filter(Boolean).join(' · ');
}
