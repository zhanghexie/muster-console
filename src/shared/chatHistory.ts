export const CHAT_STORE_VERSION = 1;
export const MAX_CHAT_DISPLAY = 400;
export const MAX_CHAT_API = 400;
/**
 * Live history pushes only carry the tail window. Older messages are loaded
 * through the range IPC instead of being cloned into every renderer update.
 */
export const CHAT_HISTORY_PAGE_SIZE = 120;

/**
 * Resolve a bounded transcript window. A target id is centered when present so
 * reveal/navigation can load one absolute page instead of walking older cursors.
 */
export function resolveChatHistoryWindow<T extends { id: string }>(
  items: readonly T[],
  before?: number,
  limit = CHAT_HISTORY_PAGE_SIZE,
  targetMessageId?: string
): { start: number; end: number } {
  return resolveChatHistoryBounds(items.length, before, limit,
    targetMessageId ? items.findIndex(item => item.id === targetMessageId) : undefined);
}

/** Calculate a bounded window from an index without materializing message IDs. */
export function resolveChatHistoryBounds(total: number, before?: number, limit = CHAT_HISTORY_PAGE_SIZE, target?: number): { start: number; end: number } {
  const size = Number.isSafeInteger(limit) ? Math.max(1, Math.min(240, limit)) : CHAT_HISTORY_PAGE_SIZE;
  if (target !== undefined && target < 0) return { start: 0, end: 0 };
  if (target !== undefined && target >= 0) {
    const preferredStart = Math.max(0, target - Math.floor(size / 2));
    const start = Math.min(preferredStart, Math.max(0, total - size));
    return { start, end: Math.min(total, start + size) };
  }
  const end = Number.isSafeInteger(before) ? Math.max(0, Math.min(total, before!)) : total;
  return { start: Math.max(0, end - size), end };
}

export interface ChatStorePayload<TDisplay, TApi> {
  version: number;
  display: TDisplay[];
  api: TApi[];
  /** 当前绑定的 Pi 会话 jsonl 路径（调度面板装载历史会话后记录，缺省 = continueRecent） */
  piSessionFile?: string;
}

export interface ChatStoreData<TDisplay, TApi> {
  display: TDisplay[];
  api: TApi[];
  piSessionFile?: string;
}

export function trimChatHistory<TDisplay, TApi>(
  display: TDisplay[],
  api: TApi[]
): { display: TDisplay[]; api: TApi[] } {
  return {
    display: display.length > MAX_CHAT_DISPLAY ? display.slice(-MAX_CHAT_DISPLAY) : display,
    api: api.length > MAX_CHAT_API ? api.slice(-MAX_CHAT_API) : api
  };
}

export function wrapChatStore<TDisplay, TApi>(
  display: TDisplay[],
  api: TApi[],
  piSessionFile?: string
): ChatStorePayload<TDisplay, TApi> {
  const trimmed = trimChatHistory(display, api);
  return piSessionFile
    ? { version: CHAT_STORE_VERSION, ...trimmed, piSessionFile }
    : { version: CHAT_STORE_VERSION, ...trimmed };
}

export function unwrapChatStore<TDisplay, TApi>(
  raw: unknown,
  empty: ChatStoreData<TDisplay, TApi>
): ChatStoreData<TDisplay, TApi> {
  if (!raw || typeof raw !== 'object') return empty;
  const o = raw as {
    version?: number;
    display?: TDisplay[];
    api?: TApi[];
    piSessionFile?: string;
  };
  const display = Array.isArray(o.display) ? o.display : empty.display;
  const api = Array.isArray(o.api) ? o.api : empty.api;
  return { ...trimChatHistory(display, api), piSessionFile: o.piSessionFile || undefined };
}
