export type NativeConfigValue = string | boolean;

export interface NativeConfigChoice {
  value: string;
  name: string;
  description?: string;
  disabled?: boolean;
  launchOnly?: boolean;
}

export interface NativeConfigGroup {
  id: string;
  name: string;
  choices: NativeConfigChoice[];
}

export interface NativeConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: 'select' | 'boolean';
  currentValue?: NativeConfigValue;
  choices?: Array<NativeConfigChoice | NativeConfigGroup>;
  changePolicy: 'live' | 'idle' | 'reconnect' | 'launch-only' | 'read-only';
}

export interface NativeConfigIdentity {
  runtimeId: string;
  presetId?: string;
  sourceKey: string;
  version?: string;
}

export interface NativeConfigIntent {
  identity: NativeConfigIdentity;
  selections: Array<{ id: string; value: NativeConfigValue }>;
}

export interface NativeConfigState {
  status: 'uninitialized' | 'ready' | 'unsupported' | 'error';
  options: NativeConfigOption[];
  error?: string;
  catalogSource?: 'session' | 'catalog' | 'versioned-adapter';
}

export interface NativeConfigSnapshot extends NativeConfigState {
  identity: NativeConfigIdentity;
  revision: number;
  source: 'session' | 'catalog' | 'versioned-adapter';
  requested?: NativeConfigIntent['selections'];
}

export interface NativeConfigChange {
  identity: NativeConfigIdentity;
  revision: number;
  id: string;
  value: NativeConfigValue;
}

export interface NativeApprovalChoice {
  id: string;
  name: string;
  kind?: string;
  description?: string;
  scope?: 'once' | 'persistent' | 'session';
}

export const NATIVE_CONFIG_INTENT_SCHEMA = {
  type: 'object', required: ['identity', 'selections'], additionalProperties: false,
  properties: {
    identity: { type: 'object', required: ['runtimeId', 'sourceKey'], additionalProperties: false, properties: {
      runtimeId: { type: 'string' }, presetId: { type: 'string' }, sourceKey: { type: 'string' }, version: { type: 'string' }
    } },
    selections: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', required: ['id', 'value'],
      additionalProperties: false, properties: { id: { type: 'string' }, value: { type: ['string', 'boolean'] } } } }
  }
};

export function sameNativeConfigIdentity(left: NativeConfigIdentity, right: NativeConfigIdentity): boolean {
  return left.runtimeId === right.runtimeId && left.presetId === right.presetId &&
    left.sourceKey === right.sourceKey && left.version === right.version;
}

export function nativeOptionAccepts(option: NativeConfigOption, value: unknown): value is NativeConfigValue {
  if (option.type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string') return false;
  return option.choices?.some(choice => 'choices' in choice
    ? choice.choices.some(item => item.value === value && !item.disabled) : choice.value === value && !choice.disabled) ?? false;
}

/** A child can start with the same values only when every adjustable setting was observed and is representable. */
export function observedNativeConfigIntent(snapshot: NativeConfigSnapshot | null): NativeConfigIntent | undefined {
  if (snapshot?.status !== 'ready' || snapshot.requested?.length) return undefined;
  const options = snapshot.options.filter(option => option.changePolicy !== 'read-only');
  const selections: NativeConfigIntent['selections'] = [];
  for (const option of options) {
    if (option.changePolicy === 'launch-only' || !nativeOptionAccepts(option, option.currentValue)) return undefined;
    selections.push({ id: option.id, value: option.currentValue });
  }
  return selections.length ? { identity: snapshot.identity, selections } : undefined;
}

/** Normalize untrusted launch metadata without interpreting any native IDs. */
export function parseNativeConfigIntent(raw: unknown): NativeConfigIntent | undefined {
  if (raw === undefined) return undefined;
  const value = raw as Partial<NativeConfigIntent> | null;
  const id = (input: unknown, limit = 512): input is string => typeof input === 'string' && !!input.trim() &&
    input.length <= limit && !/[\u0000-\u001f]/.test(input);
  const identity = value?.identity;
  if (!identity || !id(identity.runtimeId) || !id(identity.sourceKey, 8192) ||
      (identity.presetId !== undefined && !id(identity.presetId)) ||
      (identity.version !== undefined && identity.version !== '' && !id(identity.version, 8192)) ||
      !Array.isArray(value?.selections) || !value.selections.length || value.selections.length > 64) {
    throw new Error('Invalid nativeConfig identity or selections.');
  }
  const seen = new Set<string>();
  const selections = value.selections.map(selection => {
    if (!selection || !id(selection.id) || seen.has(selection.id) || (typeof selection.value !== 'boolean' && !id(selection.value))) {
      throw new Error('Invalid nativeConfig option or value.');
    }
    seen.add(selection.id);
    return { id: selection.id, value: selection.value };
  });
  return { identity: { runtimeId: identity.runtimeId, sourceKey: identity.sourceKey,
    ...(identity.presetId === undefined ? {} : { presetId: identity.presetId }),
    ...(identity.version === undefined ? {} : { version: identity.version }) }, selections };
}
