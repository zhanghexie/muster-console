/**
 * 扩展 / 调度 Agent 共用的宿主对话框契约。
 * 主进程 UiBridge、extension 扩展面板 ma.ui、Catalog 工具对齐此形状。
 */

import { t } from './i18n';

export const UI_DIALOG_TIMEOUT_MS = 120_000;
export const UI_DIALOG_TITLE_MAX = 80;
export const UI_DIALOG_MESSAGE_MAX = 500;
export const UI_DIALOG_ITEMS_MAX = 50;
export const UI_DIALOG_LABEL_MAX = 64;
export const UI_DIALOG_DETAIL_MAX = 200;
export const UI_DIALOG_ID_MAX = 64;
export const UI_DIALOG_PLACEHOLDER_MAX = 120;
export const UI_DIALOG_DEFAULT_VALUE_MAX = 4000;

export type UiDialogKind = 'prompt' | 'select' | 'multiSelect' | 'menu';

export interface UiDialogItem {
  id: string;
  label: string;
  detail?: string;
  /** menu 专用：分隔线（无 id/label 时也可） */
  separator?: boolean;
}

export interface UiPromptArgs {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
}

export interface UiSelectArgs {
  title: string;
  message?: string;
  items: UiDialogItem[];
}

export interface UiMultiSelectArgs {
  title: string;
  message?: string;
  items: UiDialogItem[];
  selectedIds?: string[];
}

export interface UiMenuArgs {
  title?: string;
  items: UiDialogItem[];
}

/** 主进程 → 渲染层的统一对话框请求 */
export type UiDialogRequest =
  | ({ requestId: string; kind: 'prompt' } & UiPromptArgs)
  | ({ requestId: string; kind: 'select' } & UiSelectArgs)
  | ({ requestId: string; kind: 'multiSelect' } & UiMultiSelectArgs)
  | ({ requestId: string; kind: 'menu' } & UiMenuArgs);

/** 渲染层回传：取消为 cancelled:true；成功带 value */
export type UiDialogResponse =
  | { cancelled: true }
  | { cancelled: false; value: string | string[] };

export type UiExtUiMethod = 'prompt' | 'select' | 'multiSelect' | 'menu' | 'confirm';

function clampStr(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function assertTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) throw new Error(t('title 必须是非空字符串'));
  return clampStr(title.trim(), UI_DIALOG_TITLE_MAX);
}

function optMessage(message: unknown): string | undefined {
  if (message == null) return undefined;
  if (typeof message !== 'string') throw new Error(t('message 必须是字符串'));
  const trimmed = message.trim();
  return trimmed ? clampStr(trimmed, UI_DIALOG_MESSAGE_MAX) : undefined;
}

function parseItems(raw: unknown, allowSeparator: boolean): UiDialogItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(t('items 必须是非空数组'));
  }
  if (raw.length > UI_DIALOG_ITEMS_MAX) {
    throw new Error(t('items 至多 {{n}} 项', { n: UI_DIALOG_ITEMS_MAX }));
  }
  const out: UiDialogItem[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') throw new Error(t('items 项必须是对象'));
    const o = row as Record<string, unknown>;
    if (o.separator === true) {
      if (!allowSeparator) throw new Error(t('本对话框不支持 separator'));
      out.push({ id: '', label: '', separator: true });
      continue;
    }
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!id || id.length > UI_DIALOG_ID_MAX) {
      throw new Error(t('item.id 必须是 1-{{n}} 字符', { n: UI_DIALOG_ID_MAX }));
    }
    if (!label || label.length > UI_DIALOG_LABEL_MAX) {
      throw new Error(t('item.label 必须是 1-{{n}} 字符', { n: UI_DIALOG_LABEL_MAX }));
    }
    if (seen.has(id)) throw new Error(t('item.id 重复：{{id}}', { id }));
    seen.add(id);
    let detail: string | undefined;
    if (o.detail != null) {
      if (typeof o.detail !== 'string') throw new Error(t('item.detail 必须是字符串'));
      const d = o.detail.trim();
      detail = d ? clampStr(d, UI_DIALOG_DETAIL_MAX) : undefined;
    }
    out.push({ id, label, ...(detail ? { detail } : {}) });
  }
  const actionable = out.filter((i) => !i.separator);
  if (actionable.length === 0) throw new Error(t('items 至少需要一项可选条目'));
  return out;
}

export function normalizePromptArgs(raw: unknown): UiPromptArgs {
  if (!raw || typeof raw !== 'object') throw new Error(t('args 必须是对象'));
  const o = raw as Record<string, unknown>;
  const title = assertTitle(o.title);
  const message = optMessage(o.message);
  let defaultValue: string | undefined;
  if (o.defaultValue != null) {
    if (typeof o.defaultValue !== 'string') throw new Error(t('defaultValue 必须是字符串'));
    defaultValue = clampStr(o.defaultValue, UI_DIALOG_DEFAULT_VALUE_MAX);
  }
  let placeholder: string | undefined;
  if (o.placeholder != null) {
    if (typeof o.placeholder !== 'string') throw new Error(t('placeholder 必须是字符串'));
    const p = o.placeholder.trim();
    placeholder = p ? clampStr(p, UI_DIALOG_PLACEHOLDER_MAX) : undefined;
  }
  const multiline = o.multiline == null ? undefined : !!o.multiline;
  return {
    title,
    ...(message ? { message } : {}),
    ...(defaultValue != null ? { defaultValue } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(multiline != null ? { multiline } : {})
  };
}

export function normalizeSelectArgs(raw: unknown): UiSelectArgs {
  if (!raw || typeof raw !== 'object') throw new Error(t('args 必须是对象'));
  const o = raw as Record<string, unknown>;
  const message = optMessage(o.message);
  return {
    title: assertTitle(o.title),
    ...(message ? { message } : {}),
    items: parseItems(o.items, false)
  };
}

export function normalizeMultiSelectArgs(raw: unknown): UiMultiSelectArgs {
  if (!raw || typeof raw !== 'object') throw new Error(t('args 必须是对象'));
  const o = raw as Record<string, unknown>;
  const items = parseItems(o.items, false);
  const ids = new Set(items.map((i) => i.id));
  let selectedIds: string[] | undefined;
  if (o.selectedIds != null) {
    if (!Array.isArray(o.selectedIds)) throw new Error(t('selectedIds 必须是数组'));
    selectedIds = [];
    for (const x of o.selectedIds) {
      if (typeof x !== 'string' || !ids.has(x)) {
        throw new Error(t('selectedIds 含未知 id: {{id}}', { id: JSON.stringify(x) }));
      }
      if (!selectedIds.includes(x)) selectedIds.push(x);
    }
  }
  const message = optMessage(o.message);
  return {
    title: assertTitle(o.title),
    ...(message ? { message } : {}),
    items,
    ...(selectedIds ? { selectedIds } : {})
  };
}

export function normalizeMenuArgs(raw: unknown): UiMenuArgs {
  if (!raw || typeof raw !== 'object') throw new Error(t('args 必须是对象'));
  const o = raw as Record<string, unknown>;
  let title: string | undefined;
  if (o.title != null) {
    if (typeof o.title !== 'string') throw new Error(t('title 必须是字符串'));
    const trimmed = o.title.trim();
    title = trimmed ? clampStr(trimmed, UI_DIALOG_TITLE_MAX) : undefined;
  }
  return {
    ...(title ? { title } : {}),
    items: parseItems(o.items, true)
  };
}
