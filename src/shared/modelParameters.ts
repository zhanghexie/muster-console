/** JSON-only model controls. Values are opaque; only adapters interpret native fields. */
export interface ModelParameterDescriptor {
  id: string;
  semantic?: 'reasoning';
  label: string;
  options: Array<{ value: string; label: string }>;
  apply: 'next-turn' | 'reconnect';
  supportsDefault: boolean;
  /** Known engine default; absence means unknown, never an invented medium. */
  defaultValue?: string;
}

export type ModelParameterValues = Record<string, string>;
export interface ModelParameterContext {
  runtimeId: string;
  providerId: string;
  modelId: string;
  parameters: ModelParameterDescriptor[];
  /** Adapter projects legacy session fields without teaching the host their semantics. */
  legacyValues?: ModelParameterValues;
  /** A failed discovery is distinct from a successful declaration of no controls. */
  unavailable?: boolean;
  warning?: string;
}
export interface ModelParameterProfile {
  runtimeId: string;
  providerId?: string;
  modelId?: string;
  parameters: Record<string, {
    label?: string;
    /** Display aliases map only to values advertised by the adapter. */
    options?: Array<{ value: string; label: string; mappedValue: string }>;
    /** null clears this scope's default and inherits the next scope. */
    defaultValue?: string | null;
  }>;
}
export interface ModelParameterState {
  descriptor: ModelParameterDescriptor;
  override: string | null;
  effectiveValue: string | null;
  source: 'session' | 'model' | 'runtime' | 'engine';
}
export interface ModelParameterSnapshot extends ModelParameterContext {
  controls: ModelParameterState[];
  /** Canonical adapter values, excluding unknown engine defaults. */
  values: ModelParameterValues;
  reconnectKey: string;
}

const safeKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && !['__proto__', 'constructor', 'prototype'].includes(v);
const safeValue = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Missing or malformed capability declarations degrade, never enable unsupported controls. */
export function normalizeModelParameterDescriptors(raw: unknown): ModelParameterDescriptor[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.slice(0, 32).flatMap((r): ModelParameterDescriptor[] => {
    if (!record(r) || !safeKey(r.id) || seen.has(r.id) || typeof r.label !== 'string' || !r.label.trim() ||
      !['next-turn', 'reconnect'].includes(r.apply) || typeof r.supportsDefault !== 'boolean' || !Array.isArray(r.options)) return [];
    const values = new Set<string>();
    const options = r.options.slice(0, 128).flatMap((o): ModelParameterDescriptor['options'] => {
      if (!record(o) || !safeValue(o.value) || values.has(o.value) || typeof o.label !== 'string' || !o.label.trim()) return [];
      values.add(o.value);
      return [{ value: o.value, label: o.label.slice(0, 160) }];
    });
    if (!options.length) return [];
    seen.add(r.id);
    return [{ id: r.id, label: r.label.slice(0, 160), options, apply: r.apply, supportsDefault: r.supportsDefault,
      ...(r.semantic === 'reasoning' ? { semantic: r.semantic } : {}),
      ...(values.has(r.defaultValue) ? { defaultValue: r.defaultValue } : {}) }];
  });
}

/** Reject malformed user edits instead of silently storing a partially valid profile. */
export function parseModelParameterProfiles(raw: unknown): ModelParameterProfile[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 128) throw new Error('Invalid model parameter profiles');
  const scopes = new Set<string>();
  return raw.map((r) => {
    if (!record(r) || !safeKey(r.runtimeId) || !record(r.parameters) || Object.keys(r.parameters).length > 32 ||
      (r.providerId !== undefined && !safeKey(r.providerId)) || (r.modelId !== undefined && !safeValue(r.modelId))) throw new Error('Invalid model parameter profile');
    const scope = JSON.stringify([r.runtimeId, r.providerId ?? '', r.modelId ?? '']);
    if (scopes.has(scope)) throw new Error('Duplicate model parameter profile');
    scopes.add(scope);
    const parameters: ModelParameterProfile['parameters'] = {};
    for (const [id, p] of Object.entries(r.parameters)) {
      if (!safeKey(id) || !record(p) || (p.label !== undefined && (typeof p.label !== 'string' || !p.label.trim())) ||
        (p.defaultValue !== undefined && p.defaultValue !== null && !safeValue(p.defaultValue))) throw new Error('Invalid model parameter setting');
      let options: ModelParameterProfile['parameters'][string]['options'];
      if (p.options !== undefined) {
        if (!Array.isArray(p.options) || !p.options.length || p.options.length > 128) throw new Error('Invalid model parameter options');
        const values = new Set<string>();
        options = p.options.map((o: unknown) => {
          if (!record(o) || !safeValue(o.value) || values.has(o.value) || !safeValue(o.mappedValue) || typeof o.label !== 'string' || !o.label.trim()) throw new Error('Invalid model parameter mapping');
          values.add(o.value);
          return { value: o.value, label: o.label.slice(0, 160), mappedValue: o.mappedValue };
        });
      }
      parameters[id] = { ...(p.label !== undefined ? { label: p.label.slice(0, 160) } : {}), ...(options ? { options } : {}), ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}) };
    }
    return { runtimeId: r.runtimeId, ...(r.providerId ? { providerId: r.providerId } : {}), ...(r.modelId ? { modelId: r.modelId } : {}), parameters };
  });
}

export function normalizeModelParameterValues(raw: unknown): ModelParameterValues {
  if (!record(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([id, value]) => safeKey(id) && safeValue(value)).slice(0, 32));
}

function matchingProfiles(context: ModelParameterContext, profiles: ModelParameterProfile[]) {
  return profiles.filter(p => p.runtimeId === context.runtimeId && (!p.providerId || p.providerId === context.providerId) && (!p.modelId || p.modelId === context.modelId))
    .sort((a, b) => (Number(!!a.modelId) * 2 + Number(!!a.providerId)) - (Number(!!b.modelId) * 2 + Number(!!b.providerId)));
}

export function hasConfiguredModelParameterDefault(context: ModelParameterContext, profiles: ModelParameterProfile[]): boolean {
  return matchingProfiles(context, profiles).some(profile => Object.values(profile.parameters).some(setting => setting.defaultValue != null));
}

/** Configuration cannot invent a capability or a native value. */
export function modelParameterOptions(context: ModelParameterContext, profiles: ModelParameterProfile[], id: string): Array<{ value: string; label: string; mappedValue: string }> {
  const def = context.parameters.find(d => d.id === id);
  if (!def) return [];
  let options = def.options.map(o => ({ ...o, mappedValue: o.value }));
  for (const p of matchingProfiles(context, profiles)) {
    const next = p.parameters[id]?.options;
    if (next?.every(o => def.options.some(native => native.value === o.mappedValue))) options = next;
  }
  return options;
}

export function validateModelParameterProfile(context: ModelParameterContext, profile: ModelParameterProfile, inherited: ModelParameterProfile[] = []): string | undefined {
  for (const [id, setting] of Object.entries(profile.parameters)) {
    const def = context.parameters.find(d => d.id === id);
    if (!def) return `Unsupported model parameter: ${id}`;
    const allowed = new Set(def.options.map(o => o.value));
    if (setting.options?.some(o => !allowed.has(o.mappedValue))) return `Unsupported parameter mapping: ${id}`;
    const options = setting.options ?? modelParameterOptions(context, inherited, id);
    if (setting.defaultValue != null && !options.some(o => o.value === setting.defaultValue || (!setting.options && o.mappedValue === setting.defaultValue))) return `Unknown parameter default: ${id}`;
  }
  return undefined;
}

export function resolveModelParameters(context: ModelParameterContext, profiles: ModelParameterProfile[], overrides: ModelParameterValues = {}): ModelParameterSnapshot {
  const values: ModelParameterValues = {};
  const controls: ModelParameterState[] = [];
  const reconnect: Array<[string, string]> = [];
  const warnings: string[] = context.warning ? [context.warning] : [];
  for (const id of Object.keys(overrides)) if (!context.parameters.some(d => d.id === id)) warnings.push(`Unsupported parameter override: ${id}`);
  const applicable: ModelParameterProfile[] = [];
  for (const p of matchingProfiles(context, profiles)) {
    const error = validateModelParameterProfile(context, p, applicable);
    if (error) warnings.push(error);
    else applicable.push(p);
  }
  for (const native of normalizeModelParameterDescriptors(context.parameters)) {
    let descriptor = { ...native, options: native.options.map(o => ({ ...o })) };
    let mapping = new Map(native.options.map(o => [o.value, o.value]));
    let value = native.defaultValue ?? null;
    let source: ModelParameterState['source'] = 'engine';
    for (const p of applicable) {
      const setting = p.parameters[native.id];
      if (!setting) continue;
      if (setting.label) descriptor.label = setting.label;
      if (setting.options) {
        // Preserve the previous scope's canonical default across renamed aliases.
        const canonical = value === null ? null : mapping.get(value);
        mapping = new Map(setting.options.map(o => [o.value, o.mappedValue]));
        descriptor.options = setting.options.map(({ value, label }) => ({ value, label }));
        value = canonical == null ? null : setting.options.find(o => o.mappedValue === canonical)?.value ?? null;
      }
      if (setting.defaultValue != null) {
        value = mapping.has(setting.defaultValue) ? setting.defaultValue : [...mapping].find(([, canonical]) => canonical === setting.defaultValue)?.[0] ?? null;
        source = p.modelId ? 'model' : 'runtime';
      }
    }
    const legacy = context.legacyValues?.[native.id];
    const requested = overrides[native.id];
    const override = requested !== undefined
      ? (mapping.has(requested) ? requested : [...mapping].find(([, canonical]) => canonical === requested)?.[0] ?? requested)
      : (legacy !== undefined
      ? (mapping.has(legacy) ? legacy : [...mapping].find(([, canonical]) => canonical === legacy)?.[0]) : undefined);
    let selected: string | null = null;
    if (override !== undefined) {
      if (mapping.has(override)) { selected = override; value = override; source = 'session'; }
      else warnings.push(`Unknown parameter override: ${native.id}`);
    }
    // Engine defaults are display-only; omit them so engine-local config stays authoritative.
    if (value !== null && (source !== 'engine' || !native.supportsDefault)) {
      const canonical = mapping.get(value);
      if (canonical !== undefined) { values[native.id] = canonical; if (native.apply === 'reconnect') reconnect.push([native.id, canonical]); }
    }
    controls.push({ descriptor, override: selected, effectiveValue: value, source });
  }
  return { ...context, parameters: controls.map(c => c.descriptor), controls, values, reconnectKey: JSON.stringify(reconnect.sort(([a], [b]) => a.localeCompare(b))), ...(warnings.length ? { warning: warnings.join('; ') } : {}) };
}

/** Canonical adapter values, accepting the model's currently advertised user aliases. */
export function canonicalModelParameterOverrides(context: ModelParameterContext, profiles: ModelParameterProfile[], input: ModelParameterValues): ModelParameterValues {
  const snapshot = resolveModelParameters(context, profiles, input);
  return Object.fromEntries(Object.keys(input).sort().map(id => {
    if (!snapshot.controls.some(control => control.descriptor.id === id && control.override !== null) || snapshot.values[id] === undefined) {
      throw new Error(`Unsupported model parameter value: ${id}`);
    }
    return [id, snapshot.values[id]];
  }));
}

/** Validate a partial session edit before mutation; null removes an override. */
export function changeModelParameters(snapshot: ModelParameterSnapshot, current: ModelParameterValues, changes: unknown): ModelParameterValues {
  if (!record(changes) || Object.keys(changes).length > 32) throw new Error('Invalid model parameter change');
  const next = { ...current };
  for (const [id, value] of Object.entries(changes)) {
    if (!safeKey(id)) throw new Error('Invalid model parameter id');
    const control = snapshot.controls.find(c => c.descriptor.id === id);
    if (!control || (value === null && !control.descriptor.supportsDefault) || (value !== null && !control.descriptor.options.some(o => o.value === value))) throw new Error(`Unsupported model parameter value: ${id}`);
    if (value === null) delete next[id]; else next[id] = value;
  }
  return next;
}
