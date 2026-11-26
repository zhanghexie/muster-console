/**
 * Composer 本地工具的共享逻辑：手动确认发送清单（原 /tosend 清单，命令已删，
 * 存储沿用）+ /quickInput 快捷短语。
 * 纯函数、仅 type-only 依赖（test/composer-tools.mjs 即时转译导入锁行为）；
 * localStorage 读写留在渲染层组件里。
 */
import type { QueuedNoteDraft } from './noteAnnotations';
import { hasWorkerModelMentions } from './workerModelMention';

// ── 手动确认发送清单（永不自动发送；经跨泳道拖拽/忙时分流产生条目）──

/** 清单随文图片（与 ChatImageAttachment 对齐的可序列化子集；url 不落盘） */
export interface TosendImage {
  sourcePath?: string;
  id: string;
  /** 纯 base64（不带 data:image/...;base64, 前缀） */
  data: string;
  mimeType: string;
  name?: string;
  size?: number;
}

export interface TosendItem {
  id: string;
  text: string;
  ts: number;
  /** 随文图片（可空；图-only 条目 text 可为空串） */
  images?: TosendImage[];
  /** 正文已展开；取回编辑时恢复批注胶囊，不能依赖已清空的会话批注表。 */
  noteDraft?: QueuedNoteDraft;
}

export const TOSEND_MAX_ITEMS = 20;
export const TOSEND_MAX_CHARS = 2000;

function limitTosendText(text: string): string {
  return hasWorkerModelMentions(text) ? text : text.slice(0, TOSEND_MAX_CHARS);
}

function localId(prefix: string, now: number): string {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTosendImages(images: TosendImage[] | undefined): TosendImage[] | undefined {
  if (!images?.length) return undefined;
  const out: TosendImage[] = [];
  for (const im of images) {
    if (!im || typeof im.data !== 'string' || (!im.data && !im.sourcePath && im.size !== 0) || typeof im.mimeType !== 'string') continue;
    out.push({
      id: typeof im.id === 'string' && im.id ? im.id : localId('img', Date.now()),
      data: im.data,
      mimeType: im.mimeType,
      ...(im.sourcePath ? { sourcePath: im.sourcePath } : {}),
      ...(im.name ? { name: im.name } : {}),
      ...(typeof im.size === 'number' ? { size: im.size } : {})
    });
  }
  return out.length ? out : undefined;
}

/**
 * 追加一条（trim、单条限长、清单上限裁最旧）。
 * 纯空白且无图 = 空内容原样返回；图-only 条目允许 text 为空。
 */
export function addTosendItem(
  list: TosendItem[],
  text: string,
  now = Date.now(),
  images?: TosendImage[],
  noteDraft?: QueuedNoteDraft
): TosendItem[] {
  // 批注引文可超过旧短文本上限；必须保留末尾用户批注与完整原文。
  const content = noteDraft ? text.trim() : limitTosendText(text.trim());
  const imgs = normalizeTosendImages(images);
  if (!content && !imgs) return list;
  const next = [
    ...list,
    {
      id: localId('ts', now),
      text: content,
      ts: now,
      ...(imgs ? { images: imgs } : {}),
      ...(noteDraft ? { noteDraft: structuredClone(noteDraft) } : {})
    }
  ];
  return next.length > TOSEND_MAX_ITEMS ? next.slice(next.length - TOSEND_MAX_ITEMS) : next;
}

export function removeTosendItem(list: TosendItem[], id: string): TosendItem[] {
  return list.filter((i) => i.id !== id);
}

/** 改写一条待发送内容（trim + 限长；随文图片保留；改空且无图视为无效不动原清单） */
export function updateTosendItem(list: TosendItem[], id: string, text: string): TosendItem[] {
  const content = limitTosendText(text.trim());
  const hit = list.find((i) => i.id === id);
  if (!hit) return list;
  if (!content && !hit.images?.length) return list;
  if (hit.text === content) return list;
  return list.map((i) => {
    if (i.id !== id) return i;
    const { noteDraft: _oldDraft, ...rest } = i;
    return { ...rest, text: content };
  });
}

/** 按 id 全量重排（拖拽落盘用）；缺失的 id 忽略、清单里多出的条目保序追加尾部 */
export function reorderTosendByIds(list: TosendItem[], orderedIds: string[]): TosendItem[] {
  const byId = new Map(list.map((i) => [i.id, i]));
  const next: TosendItem[] = [];
  for (const id of orderedIds) {
    const hit = byId.get(id);
    if (hit) {
      next.push(hit);
      byId.delete(id);
    }
  }
  for (const rest of byId.values()) next.push(rest);
  return next;
}

/** 落盘解析：坏 JSON / 结构不对的条目剔除，不抛错；随文图片一并还原 */
export function parseTosendList(raw: string | null | undefined): TosendItem[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: TosendItem[] = [];
    for (const it of data) {
      if (!it || typeof it !== 'object') continue;
      const rec = it as { id?: unknown; text?: unknown; ts?: unknown; images?: unknown; noteDraft?: unknown };
      const noteDraft = parseQueuedNoteDraft(rec.noteDraft);
      const text = typeof rec.text === 'string'
        ? noteDraft ? rec.text : limitTosendText(rec.text)
        : '';
      const imgs = normalizeTosendImages(
        Array.isArray(rec.images) ? (rec.images as TosendImage[]) : undefined
      );
      // 空白正文且无图的条目剔除（历史纯文本条目兼容：有正文即可）
      if (!text.trim() && !imgs) continue;
      out.push({
        id: typeof rec.id === 'string' ? rec.id : localId('ts', Date.now()),
        text,
        ts: typeof rec.ts === 'number' ? rec.ts : 0,
        ...(imgs ? { images: imgs } : {}),
        ...(noteDraft ? { noteDraft } : {})
      });
    }
    return out.slice(0, TOSEND_MAX_ITEMS);
  } catch {
    return [];
  }
}

function parseQueuedNoteDraft(value: unknown): QueuedNoteDraft | undefined {
  if (!value || typeof value !== 'object') return;
  const draft = value as QueuedNoteDraft;
  if (typeof draft.text !== 'string' || !Array.isArray(draft.notes) || !draft.notes.length) return;
  const notes = draft.notes.filter(n => n && Number.isSafeInteger(n.seq) && n.seq > 0 &&
    typeof n.id === 'string' && typeof n.messageId === 'string' &&
    typeof n.quote === 'string' && typeof n.note === 'string' &&
    (!n.file || (typeof n.file.path === 'string' &&
      (n.file.line == null || Number.isSafeInteger(n.file.line)) &&
      (n.file.endLine == null || Number.isSafeInteger(n.file.endLine)))) &&
    (!n.web || (typeof n.web.label === 'string' && typeof n.web.selector === 'string' &&
      typeof n.web.url === 'string' && (n.web.shot == null || typeof n.web.shot === 'string'))));
  return notes.length === draft.notes.length ? { text: draft.text, notes } : undefined;
}

export function serializeTosendList(list: TosendItem[]): string {
  return JSON.stringify(list);
}

// ── /quickInput 快捷短语（key/value）──

export interface QuickPhrase {
  id: string;
  key: string;
  value: string;
  ts: number;
}

export const PHRASE_KEY_MAX_CHARS = 60;
export const PHRASE_VALUE_MAX_CHARS = 2000;

/** 规整一条短语：trim + 限长；名称与内容都为空视为无效返回 null */
export function normalizePhrase(
  key: string,
  value: string
): { key: string; value: string } | null {
  const k = key.trim().slice(0, PHRASE_KEY_MAX_CHARS);
  const v = value.trim().slice(0, PHRASE_VALUE_MAX_CHARS);
  if (!k && !v) return null;
  return { key: k, value: v };
}

/** 搜索：key 或 value 大小写不敏感子串命中（空查询=全部） */
export function filterQuickPhrases(list: QuickPhrase[], query: string): QuickPhrase[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (p) => p.key.toLowerCase().includes(q) || p.value.toLowerCase().includes(q)
  );
}

/**
 * 新增或更新：id 为 null 追加到末尾，否则原地更新（保持顺序）。
 * 返回清单与落定的条目 id（供编辑态回填）。
 */
export function upsertQuickPhrase(
  list: QuickPhrase[],
  id: string | null,
  key: string,
  value: string,
  now = Date.now()
): { list: QuickPhrase[]; id: string } {
  const norm = normalizePhrase(key, value);
  if (!norm) return { list, id: id ?? '' };
  if (id) {
    return {
      list: list.map((p) => (p.id === id ? { ...p, key: norm.key, value: norm.value } : p)),
      id
    };
  }
  const newId = localId('qp', now);
  return { list: [...list, { id: newId, key: norm.key, value: norm.value, ts: now }], id: newId };
}

export function removeQuickPhrase(list: QuickPhrase[], id: string): QuickPhrase[] {
  return list.filter((p) => p.id !== id);
}

/** 落盘解析：坏 JSON / 缺字段条目剔除，不抛错 */
export function parseQuickPhrases(raw: string | null | undefined): QuickPhrase[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: QuickPhrase[] = [];
    for (const it of data) {
      if (!it || typeof it !== 'object') continue;
      const rec = it as { id?: unknown; key?: unknown; value?: unknown; ts?: unknown };
      if (
        typeof rec.key !== 'string' ||
        typeof rec.value !== 'string' ||
        (!rec.key.trim() && !rec.value.trim())
      ) {
        continue;
      }
      out.push({
        id: typeof rec.id === 'string' ? rec.id : localId('qp', Date.now()),
        key: rec.key.trim().slice(0, PHRASE_KEY_MAX_CHARS),
        value: rec.value.trim().slice(0, PHRASE_VALUE_MAX_CHARS),
        ts: typeof rec.ts === 'number' ? rec.ts : 0
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeQuickPhrases(list: QuickPhrase[]): string {
  return JSON.stringify(list);
}
