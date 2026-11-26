import type { NativeConfigChoice, NativeConfigGroup, NativeConfigOption, NativeConfigState, NativeConfigValue } from '../../../../shared/nativeSessionConfig';
import { nativeOptionAccepts } from '../../../../shared/nativeSessionConfig';
import { consumedAcpConfigIds } from './modelOptions';

export const acpConfigCapabilities = { configOptions: { boolean: {} } };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function acpNativeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 512 && value.trim() && !/[\u0000-\u001f]/.test(value) ? value : undefined;
}

function display(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
}

function choices(items: unknown, legacy: boolean): NativeConfigChoice[] {
  if (!Array.isArray(items)) return [];
  const result: NativeConfigChoice[] = [];
  const seen = new Set<string>();
  for (const entry of items.slice(0, 256)) {
    const item = record(entry);
    const value = acpNativeId(legacy ? item.id : item.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push({ value, name: display(item.name, 512) ?? value, description: display(item.description, 4096),
      ...(item.disabled === true || item.allowed === false ? { disabled: true } : {}) });
  }
  return result;
}

function groupedChoices(raw: unknown): Array<NativeConfigChoice | NativeConfigGroup> {
  if (!Array.isArray(raw) || !raw.some(item => Array.isArray(record(item).options))) return choices(raw, false);
  const groups: NativeConfigGroup[] = [];
  for (const entry of raw.slice(0, 64)) {
    const item = record(entry);
    const id = acpNativeId(item.group);
    if (!id || groups.some(group => group.id === id)) continue;
    groups.push({ id, name: display(item.name, 512) ?? id, choices: choices(item.options, false) });
  }
  return groups;
}

export function acpNativeConfig(metadata: Record<string, unknown>, diagnostic?: (type: string) => void): NativeConfigState {
  if (Array.isArray(metadata.configOptions)) {
    const options: NativeConfigOption[] = [];
    const consumed = consumedAcpConfigIds(metadata);
    for (const raw of metadata.configOptions.slice(0, 128)) {
      const item = record(raw);
      const id = acpNativeId(item.id);
      if (!id || consumed.has(id) || options.some(option => option.id === id)) continue;
      const type = item.type;
      if (type !== 'select' && type !== 'boolean') {
        diagnostic?.(display(type, 100) ?? 'unknown');
        continue;
      }
      const currentValue = type === 'boolean'
        ? typeof item.currentValue === 'boolean' ? item.currentValue : undefined
        : acpNativeId(item.currentValue);
      options.push({ id, type, currentValue, name: display(item.name, 512) ?? id,
        category: acpNativeId(item.category), description: display(item.description, 4096),
        changePolicy: 'live', ...(type === 'select' ? { choices: groupedChoices(item.options) } : {}) });
    }
    return { status: 'ready', options };
  }
  const modes = record(metadata.modes);
  if (!Array.isArray(modes.availableModes)) return { status: 'unsupported', options: [] };
  return { status: 'ready', options: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select',
    currentValue: acpNativeId(modes.currentModeId), choices: choices(modes.availableModes, true), changePolicy: 'live' }] };
}

export function acpNativeSelection(metadata: Record<string, unknown>, sessionId: string, id: string, value: NativeConfigValue) {
  const option = acpNativeConfig(metadata).options.find(item => item.id === id);
  if (!option || !nativeOptionAccepts(option, value)) throw new Error('ACP did not advertise the selected option or value.');
  return Array.isArray(metadata.configOptions)
    ? { method: 'session/set_config_option', params: { sessionId, configId: id, value, ...(option.type === 'boolean' ? { type: 'boolean' } : {}) } }
    : { method: 'session/set_mode', params: { sessionId, modeId: value } };
}
