import type { UiJsonValue, UiWidgetSnapshot } from '../shared/uiWidgetProtocol';
import { publicUiWidgetSnapshot } from './uiWidgetContext';

export interface UiInspectQuery { link?: string; pointer?: string; offset?: number; limit?: number; }
const size = (value: unknown): number => JSON.stringify(value).length;
const escape = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** A JSON pointer is always rooted in public modelContent, never restoration/file-private state. */
export function inspectUiWidgets(snapshots: UiWidgetSnapshot[], query: UiInspectQuery) {
  for (const key of ['offset', 'limit'] as const) if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || query[key]! < (key === 'limit' ? 1 : 0))) throw new Error(`${key} 须为${key === 'limit' ? '正' : '非负'}整数`);
  if (query.pointer !== undefined && !query.link) throw new Error('pointer 需要指定 link');
  const offset = query.offset ?? 0, limit = Math.min(query.limit ?? (query.link ? 20 : 4), query.link ? 100 : 8);
  const selected = query.link ? snapshots : snapshots.slice(offset, offset + limit);
  const widgets = selected.map(snapshot => {
    const summary = publicUiWidgetSnapshot(snapshot);
    const diagnostics = summary.receipt.diagnostics?.slice(0, 3).map(detail => ({ ...detail, message: detail.message.slice(0, 300), expression: detail.expression?.slice(0, 160) }));
    return { ...summary, title: summary.title.slice(0, 200), receipt: { ...summary.receipt, ...(diagnostics ? { diagnostics } : {}), ...(summary.receipt.error ? { error: summary.receipt.error.slice(0, 500) } : {}) },
      modelContent: size(summary.modelContent) <= 1800 ? summary.modelContent : null, requiresInspect: size(summary.modelContent) > 1800 };
  });
  let content: Record<string, unknown> | undefined;
  if (query.link && snapshots[0]) {
    const pointer = query.pointer ?? '';
    if (typeof pointer !== 'string' || pointer.length > 2048 || pointer !== '' && !pointer.startsWith('/') || /~(?![01])/g.test(pointer)) throw new Error('pointer 须为有效 JSON Pointer');
    let value: UiJsonValue | undefined = snapshots[0].state.modelContent;
    if (pointer) for (const token of pointer.slice(1).split('/')) {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (['__proto__', 'constructor', 'prototype'].includes(key) || value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) throw new Error('公开参数路径不存在');
      value = (value as Record<string, UiJsonValue>)[key];
    }
    if (typeof value === 'string') {
      let text = value.slice(offset, offset + Math.min(query.limit ?? 2048, 4096));
      while (size(text) > 5000) text = text.slice(0, Math.max(1, Math.floor(text.length * 0.8)));
      content = { pointer, kind: 'string', total: value.length, offset, value: text, ...(offset + text.length < value.length ? { nextOffset: offset + text.length } : {}) };
    } else if (value && typeof value === 'object') {
      const array = Array.isArray(value), keys = Object.keys(value), entries: Record<string, unknown>[] = [];
      let budget = 5000;
      for (const key of keys.slice(offset, offset + limit)) {
        const item = (value as Record<string, UiJsonValue>)[key]!, itemPointer = `${pointer}/${escape(key)}`;
        const entry: Record<string, unknown> = size(item) <= Math.min(1800, budget) ? { key, pointer: itemPointer, value: item } : { key, pointer: itemPointer, requiresInspect: true, kind: Array.isArray(item) ? 'array' : typeof item, length: typeof item === 'string' || Array.isArray(item) ? item.length : undefined };
        if (size(entry) > budget && entries.length) break;
        entries.push(entry); budget -= size(entry);
      }
      content = { pointer, kind: array ? 'array' : 'object', total: keys.length, offset, entries, ...(offset + entries.length < keys.length ? { nextOffset: offset + entries.length } : {}) };
    } else content = { pointer, kind: value === null ? 'null' : typeof value, value };
  }
  const result = { widgets, ...(content ? { content } : {}), ...(!query.link && offset + widgets.length < snapshots.length ? { nextOffset: offset + widgets.length } : {}) };
  if (size(result) > 9000) for (const widget of widgets) { widget.requiresInspect ||= widget.modelContent !== null; widget.modelContent = null; }
  if (size(result) > 11000) throw new Error('元数据过大，请减小 limit 或缩小 pointer 范围');
  return result;
}
