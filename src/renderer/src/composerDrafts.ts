/**
 * 调度 Agent 输入框草稿：按工作区存 localStorage，面板关闭/切区/重开都不丢。
 * 拖拽路径等外部写入通过 window 事件 'composer-draft-change' 通知已挂载的输入框。
 */

const STORAGE_KEY = 'muster.composer.drafts.v1';

export const DRAFT_CHANGE_EVENT = 'composer-draft-change';

type DraftMap = Record<string, string>;

let cache: DraftMap | null = null;

function load(): DraftMap {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as DraftMap) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(load()));
  } catch {
    /* 存储满等情况忽略 */
  }
}

/** 落盘防抖：每击键同步 stringify+setItem 会在输入热路径上反复序列化整个草稿表 */
const PERSIST_DEBOUNCE_MS = 300;
let persistTimer: number | null = null;

function schedulePersist(): void {
  if (persistTimer != null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persist();
  }, PERSIST_DEBOUNCE_MS);
}

export function getDraft(workspaceId: string): string {
  if (!workspaceId) return '';
  return load()[workspaceId] ?? '';
}

export function setDraft(workspaceId: string, text: string): void {
  if (!workspaceId) return;
  const m = load();
  if (text) m[workspaceId] = text;
  else delete m[workspaceId];
  schedulePersist();
}

/** 外部追加（拖文件到头像/面板）：写完后派发事件让已挂载的输入框同步显示 */
export function appendDraft(workspaceId: string, chunk: string): string {
  if (!workspaceId || !chunk) return getDraft(workspaceId);
  const m = load();
  const next = (m[workspaceId] ?? '') + chunk;
  m[workspaceId] = next;
  schedulePersist();
  window.dispatchEvent(
    new CustomEvent(DRAFT_CHANGE_EVENT, { detail: { workspaceId, text: next } })
  );
  return next;
}

/** 外部整体替换（批注 token 摘除等）：写完后派发事件让已挂载的输入框同步显示 */
export function replaceDraft(workspaceId: string, text: string): string {
  if (!workspaceId) return getDraft(workspaceId);
  const m = load();
  if (text) m[workspaceId] = text;
  else delete m[workspaceId];
  schedulePersist();
  window.dispatchEvent(new CustomEvent(DRAFT_CHANGE_EVENT, { detail: { workspaceId, text } }));
  return text;
}

export function clearDraft(workspaceId: string): void {
  setDraft(workspaceId, '');
}
