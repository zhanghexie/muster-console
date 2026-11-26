import type { NativeConfigState } from '../../../../shared/nativeSessionConfig';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// session/setMode choices for ZCode's native protocol when the server only sends the current mode.
const nativeModes = ['plan', 'build', 'edit', 'yolo', 'guarded', 'auto'];

export function zcodeNativeConfig(raw: unknown, nativeProtocol: boolean): NativeConfigState {
  const snapshot = object(raw);
  const settings = object(snapshot.settings ?? raw);
  const mode = object(settings.mode);
  const currentValue = typeof mode.current === 'string' ? mode.current : undefined;
  const available = Array.isArray(mode.available) ? mode.available : nativeProtocol ? nativeModes : [];
  if (!currentValue && !available.length) return { status: 'unsupported', options: [] };
  const choices = available.slice(0, 128).flatMap(item => {
    const entry = object(item);
    const value = typeof item === 'string' ? item : entry.value ?? entry.id;
    if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f]/.test(value)) return [];
    const name = entry.label ?? entry.name;
    return [{ value, name: typeof name === 'string' && name ? name : value,
      ...(entry.disabled === true || entry.allowed === false || entry.available === false ? { disabled: true } : {}) }];
  });
  return { status: 'ready', catalogSource: Array.isArray(mode.available) ? undefined : 'versioned-adapter', options: [{ id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue,
    changePolicy: choices.length ? 'live' : 'read-only', choices }] };
}
