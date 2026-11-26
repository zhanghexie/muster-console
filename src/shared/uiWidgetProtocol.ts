/** Versioned, JSON-only interface shared by the host, renderer and artifact runtime. */
export const UI_WIDGET_PROTOCOL_VERSION = 2;
export const UI_WIDGET_STATE_MAX_BYTES = 256 * 1024;

export type UiJsonValue = null | boolean | number | string | UiJsonValue[] | { [key: string]: UiJsonValue };
export type UiRenderStatus = 'generated' | 'mounted' | 'rendered' | 'degraded' | 'failed';

export interface UiWidgetState {
  modelContent: UiJsonValue;
  privateContent: UiJsonValue;
  presentation: { collapsed: boolean };
  revision: number;
}

export interface UiWidgetStatePatch {
  valueChanges?: Record<string, { value: UiJsonValue; private: boolean }>;
  defaults?: Record<string, { value: UiJsonValue; private: boolean }>;
  uiChanges?: Record<string, UiJsonValue>;
  modelContent?: UiJsonValue;
  privateContent?: UiJsonValue;
  presentation?: { collapsed: boolean };
}

export type UiWidgetAction =
  | { type: 'followup'; text: string; mode?: 'draft' | 'send'; title?: string }
  | { type: 'copy'; text: string }
  | { type: 'openUrl'; url: string };

export interface UiWidgetActionResult {
  message?: string;
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  type?: UiWidgetAction['type'];
  text?: string;
  mode?: 'draft' | 'send';
  url?: string;
  sessionId?: string;
}

export function validateUiWidgetAction(value: unknown): UiWidgetAction {
  if (!value || typeof value !== 'object') throw new Error('交互动作无效');
  const input = value as Record<string, unknown>;
  if (input.type === 'openUrl') {
    const url = typeof input.url === 'string' ? new URL(input.url) : null;
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('链接只支持 http 或 https');
    return { type: 'openUrl', url: url.href };
  }
  if (!['copy', 'followup'].includes(String(input.type)) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12000) {
    throw new Error('交互动作文本为空或超过长度限制');
  }
  if (input.type === 'copy') return { type: 'copy', text: input.text };
  return { type: 'followup', text: input.text, mode: input.mode === 'send' ? 'send' : 'draft',
    ...(typeof input.title === 'string' ? { title: input.title.slice(0, 250) } : {}) };
}

export interface UiWidgetReceipt {
  status: UiRenderStatus;
  visible: boolean;
  error?: string;
  diagnostics?: UiWidgetDiagnostic[];
  updatedAt: number;
}

export interface UiWidgetDiagnostic {
  code: string; message: string;
  component?: string; id?: string; name?: string; attribute?: string;
  expression?: string; position?: number; hint?: string;
}

export function sanitizeUiWidgetDiagnostics(value: unknown): UiWidgetDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).filter(item => !!item && typeof item === 'object').map(item => {
    const result: UiWidgetDiagnostic = { code: String(item.code || 'component_value').slice(0, 80), message: String(item.message || '').slice(0, 800) };
    for (const key of ['component', 'id', 'name', 'attribute', 'expression', 'hint'] as const) if (typeof item[key] === 'string') result[key] = item[key].slice(0, key === 'expression' ? 512 : 180);
    if (Number.isSafeInteger(item.position) && item.position >= 0) result.position = item.position;
    return result;
  });
}

export interface UiWidgetSnapshot {
  path: string;
  title: string;
  artifactVersion: number;
  state: UiWidgetState;
  receipt: UiWidgetReceipt;
}

export function emptyUiWidgetState(): UiWidgetState {
  return { modelContent: null, privateContent: null, presentation: { collapsed: false }, revision: 0 };
}

/** Public values already have a durable copy in modelContent. Preserve distinct/private restoration values. */
export function compactUiWidgetState<T extends { modelContent?: UiJsonValue; privateContent?: UiJsonValue }>(state: T): T {
  const content = state.privateContent;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return state;
  const saved = content.values;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return state;
  const publicValues = state.modelContent && typeof state.modelContent === 'object' && !Array.isArray(state.modelContent) ? state.modelContent : {};
  const values = { ...saved };
  for (const key of Object.keys(values)) if (Object.prototype.hasOwnProperty.call(publicValues, key) && JSON.stringify(values[key]) === JSON.stringify(publicValues[key])) delete values[key];
  return { ...state, privateContent: { ...content, values } };
}

export function uiWidgetStateUsage(state: UiWidgetState) {
  const usedBytes = new TextEncoder().encode(JSON.stringify(compactUiWidgetState(state))).length;
  return { usedBytes, maxBytes: UI_WIDGET_STATE_MAX_BYTES, remainingBytes: Math.max(0, UI_WIDGET_STATE_MAX_BYTES - usedBytes) };
}

function stateSizeError(usedBytes: number): Error {
  return new Error(`交互状态超出 256 KiB：已用 ${usedBytes} 字节，上限 ${UI_WIDGET_STATE_MAX_BYTES} 字节；请只保存选择 ID 和界面参数`);
}

function isJson(value: unknown, depth = 0): value is UiJsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJson(item, depth + 1));
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([key, item]) =>
    !['__proto__', 'constructor', 'prototype'].includes(key) && isJson(item, depth + 1));
}

/** Invalid state is rejected, never truncated into a different user selection. */
export function validateUiWidgetStatePatch(value: unknown): UiWidgetStatePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('交互状态必须是 JSON 对象');
  const input = value as Record<string, unknown>;
  const patch: UiWidgetStatePatch = {};
  for (const key of ['valueChanges', 'defaults', 'uiChanges'] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const changes = input[key];
    if (!isJson(changes) || !changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('交互增量必须是有效 JSON 对象');
    if (key !== 'uiChanges' && Object.values(changes).some(change => !change || typeof change !== 'object' || Array.isArray(change) || typeof change.private !== 'boolean' || !Object.prototype.hasOwnProperty.call(change, 'value'))) throw new Error('交互值增量须包含 value/private');
    Object.assign(patch, { [key]: changes });
  }
  for (const key of ['modelContent', 'privateContent'] as const) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      if (!isJson(input[key])) throw new Error(`交互状态 ${key} 必须是有效 JSON`);
      patch[key] = input[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'presentation')) {
    const presentation = input.presentation as Record<string, unknown> | null;
    if (!presentation || typeof presentation !== 'object' || typeof presentation.collapsed !== 'boolean') {
      throw new Error('交互展示状态 collapsed 必须是布尔值');
    }
    patch.presentation = { collapsed: presentation.collapsed };
  }
  const json = JSON.stringify(patch);
  const bytes = new TextEncoder().encode(JSON.stringify(compactUiWidgetState(patch))).length;
  if (bytes > UI_WIDGET_STATE_MAX_BYTES) throw stateSizeError(bytes);
  return JSON.parse(json) as UiWidgetStatePatch;
}

export function mergeUiWidgetState(current: UiWidgetState, input: unknown): UiWidgetState {
  const patch = validateUiWidgetStatePatch(input);
  const { valueChanges, defaults, uiChanges, ...content } = patch;
  const next = { ...current, ...content, revision: current.revision + 1 };
  const record = (value: UiJsonValue): Record<string, UiJsonValue> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (valueChanges || defaults || uiChanges) {
    const privateContent = { ...record(next.privateContent) };
    const values = { ...record(privateContent.values ?? null) }, ui = { ...record(privateContent.ui ?? null), ...uiChanges };
    const model = { ...record(next.modelContent) };
    for (const [key, definition] of Object.entries(defaults ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(values, key)) values[key] = definition.value;
      if (definition.private) delete model[key]; else model[key] = values[key];
    }
    for (const [key, change] of Object.entries(valueChanges ?? {})) {
      values[key] = change.value;
      if (change.private) delete model[key]; else model[key] = change.value;
    }
    next.privateContent = { ...privateContent, values, ui };
    next.modelContent = Object.keys(model).length ? model : null;
  }
  const usedBytes = uiWidgetStateUsage(next).usedBytes;
  if (usedBytes > UI_WIDGET_STATE_MAX_BYTES) throw stateSizeError(usedBytes);
  // Hydrate compact storage for existing consumers; new writes remain compact on disk.
  if (next.modelContent && typeof next.modelContent === 'object' && !Array.isArray(next.modelContent) && Object.prototype.hasOwnProperty.call(record(next.privateContent), 'values')) {
    const privateContent = record(next.privateContent), values = record(privateContent.values ?? null);
    next.privateContent = { ...privateContent, values: { ...next.modelContent, ...values } };
  }
  return next;
}

/** Canonical message identity also deduplicates Windows case and separators. */
export function uiWidgetIdentity(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
