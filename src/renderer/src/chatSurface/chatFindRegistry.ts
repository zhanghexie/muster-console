/**
 * 会话查找：多表面（调度浮窗 + GUI）共存时的归属与调度面板打开缝。
 * 模块态，不进 React；KeybindingHost / 各 ChatSurfaceView 读写。
 */
import type { ChatSearchHitId } from '../../../shared/chatSearch';

export type ChatFindScope = 'current' | 'all';

export type ChatFindShared = {
  open: boolean;
  query: string;
  scope: ChatFindScope;
  /** 活动命中身份（不是下标）：各表面组合列表顺序不同，下标跨表面会错位 */
  activeHitId: ChatSearchHitId | null;
  ownerId: string | null;
  /** 每次 Ctrl+F 递增，已开时把焦点拉回输入框 */
  focusEpoch: number;
};

const listeners = new Set<() => void>();

let shared: ChatFindShared = {
  open: false,
  query: '',
  scope: 'current',
  activeHitId: null,
  ownerId: null,
  focusEpoch: 0
};

export function getChatFindShared(): ChatFindShared {
  return shared;
}

export function subscribeChatFindShared(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function patchChatFindShared(patch: Partial<ChatFindShared>): void {
  shared = { ...shared, ...patch };
  emit();
}

export type ChatFindTarget = {
  id: string;
  kind: 'dispatch' | 'gui-session';
  enabled: boolean;
  sessionId: string;
  el: HTMLElement | null;
};

const targets = new Map<string, ChatFindTarget>();

export function registerChatFindTarget(t: ChatFindTarget): () => void {
  targets.set(t.id, t);
  return () => {
    const cur = targets.get(t.id);
    if (cur === t) targets.delete(t.id);
  };
}

export function updateChatFindTarget(id: string, patch: Partial<ChatFindTarget>): void {
  const cur = targets.get(id);
  if (!cur) return;
  targets.set(id, { ...cur, ...patch, id });
}

export function resolveChatFindTarget(preferredGuiId?: string): ChatFindTarget | null {
  const preferred = preferredGuiId ? targets.get(preferredGuiId) : undefined;
  const ae = document.activeElement;
  if (ae instanceof HTMLElement) {
    for (const t of targets.values()) {
      // Dispatch has its own focused surface. In the center, pointer focus can
      // move panes while the old pane's search input remains activeElement.
      if (t.enabled && t.el?.contains(ae) && (t.kind === 'dispatch' || !preferred?.enabled)) return t;
    }
  }
  if (preferred?.enabled && preferred.kind === 'gui-session') return preferred;
  for (const t of targets.values()) {
    if (t.enabled && t.kind === 'gui-session') return t;
  }
  for (const t of targets.values()) {
    if (t.enabled) return t;
  }
  return null;
}

export function dispatchFindId(workspaceId: string): string {
  return `dispatch:${workspaceId}`;
}

export function isDispatchFindId(id: string): boolean {
  return id.startsWith('dispatch:');
}

export function workspaceIdFromDispatchFind(id: string): string {
  return id.startsWith('dispatch:') ? id.slice('dispatch:'.length) : id;
}

type DispatchOpener = (workspaceId: string) => void;
let dispatchOpener: DispatchOpener | null = null;

export function registerDispatchOpener(fn: DispatchOpener | null): void {
  dispatchOpener = fn;
}

export function openDispatchChat(workspaceId: string): void {
  dispatchOpener?.(workspaceId);
}

export function isChatFindDomTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('.chat-surface-view, .chat-find-layer, .chat-find-bar'));
}

export function isFilesFindDomTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('.files-panel, .file-editor, .find-in-file-float'));
}

export function resetChatFindSharedForTest(): void {
  shared = {
    open: false,
    query: '',
    scope: 'current',
    activeHitId: null,
    ownerId: null,
    focusEpoch: 0
  };
  targets.clear();
  dispatchOpener = null;
  emit();
}
