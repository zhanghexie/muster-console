import { randomUuid } from './randomUuid';
export interface BookmarkNode { id: string; label: string; url?: string; children?: BookmarkNode[]; dateAdded?: number; description?: string; favicon?: string }
export interface WorkspaceBookmarks {
  version: 1;
  bookmarks: BookmarkNode[];
  bookmarkDefaultsVersion: number;
}
export interface WorkspaceBookmarksRead {
  snapshot: WorkspaceBookmarks;
  cleanupError?: string;
}
export type WorkspaceBookmarksResult = ({ ok: true } & WorkspaceBookmarksRead) | { ok: false; error: string };

/** Bookmark edits apply to the current tree inside the workspace reducer. */
export type BookmarkChange =
  | { kind: 'add'; parentId: string | null; node: BookmarkNode; index?: number }
  | { kind: 'update'; id: string; label?: string; url?: string; description?: string; favicon?: string }
  | { kind: 'remove'; ids: string[] }
  | { kind: 'move'; ids: string[]; parentId: string | null; index?: number }
  | { kind: 'sort'; mode: 'name' | 'time' };

export type BookmarkChangeResult = { nodes: BookmarkNode[]; error?: 'not-found' | 'invalid' | 'cycle' | 'limit' };
const MAX_CHILDREN = 200;
const MAX_DEPTH = 8;

export function isBookmarkUrl(value: string): boolean {
  return /^(?:https?:\/\/|file:\/\/|about:blank$|localhost[:/])/i.test(value.trim());
}

export function isBookmarkFavicon(value: string): boolean {
  return value.length <= 65_536 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value);
}

/** A malformed project file must be reported rather than silently truncated and saved. */
export function isBookmarkTree(value: unknown): value is BookmarkNode[] {
  const ids = new Set<string>();
  const check = (items: unknown, depth: number): boolean =>
    Array.isArray(items) && items.length <= MAX_CHILDREN && (depth <= MAX_DEPTH || !items.length) && items.every(node => {
      if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.label !== 'string') return false;
      ids.add(node.id);
      return (node.dateAdded === undefined || (Number.isFinite(node.dateAdded) && node.dateAdded >= 0)) &&
        (node.description === undefined || typeof node.description === 'string') &&
        (node.favicon === undefined || (typeof node.favicon === 'string' && isBookmarkFavicon(node.favicon))) &&
        (node.url === undefined
          ? node.children === undefined || check(node.children, depth + 1)
          : typeof node.url === 'string' && isBookmarkUrl(node.url) && node.children === undefined);
    });
  return check(value, 0);
}

export function isBookmarkChange(change: BookmarkChange): boolean {
  if (!change || typeof change !== 'object') return false;
  const validIndex = (value: unknown) => value === undefined || Number.isSafeInteger(value);
  switch (change.kind) {
    case 'add': return (change.parentId === null || typeof change.parentId === 'string') && validIndex(change.index) && isBookmarkTree([change.node]);
    case 'update': return typeof change.id === 'string' &&
      [change.label, change.url, change.description, change.favicon].every(value => value === undefined || typeof value === 'string');
    case 'remove': return Array.isArray(change.ids) && change.ids.every(id => typeof id === 'string');
    case 'move': return Array.isArray(change.ids) && change.ids.every(id => typeof id === 'string') &&
      (change.parentId === null || typeof change.parentId === 'string') && validIndex(change.index);
    case 'sort': return change.mode === 'name' || change.mode === 'time';
    default: return false;
  }
}

export function bookmarkId(): string {
  return `bookmark-${randomUuid()}`;
}

export function findBookmark(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children && findBookmark(node.children, id);
    if (child) return child;
  }
  return undefined;
}

export function bookmarkDescendants(node: BookmarkNode): BookmarkNode[] {
  return [node, ...(node.children ?? []).flatMap(bookmarkDescendants)];
}

function mapTree(nodes: BookmarkNode[], fn: (node: BookmarkNode) => BookmarkNode | null): BookmarkNode[] {
  return nodes.flatMap(node => {
    const next = fn(node);
    if (!next) return [];
    return [{ ...next, ...(next.children ? { children: mapTree(next.children, fn) } : {}) }];
  });
}

function insert(nodes: BookmarkNode[], parentId: string | null, additions: BookmarkNode[], index?: number): BookmarkNode[] {
  const into = (items: BookmarkNode[]) => {
    const result = [...items];
    result.splice(index == null ? result.length : Math.max(0, Math.min(result.length, index)), 0, ...additions);
    return result;
  };
  if (parentId === null) return into(nodes);
  return mapTree(nodes, node => node.id === parentId ? { ...node, children: into(node.children ?? []) } : node);
}

function validTree(nodes: BookmarkNode[], depth = 0): boolean {
  return depth <= MAX_DEPTH && nodes.length <= MAX_CHILDREN && nodes.every(node =>
    !node.children?.length || validTree(node.children, depth + 1));
}

/** Preserve source ordering when parents and descendants are both selected. */
function selectedRoots(nodes: BookmarkNode[], ids: Set<string>): BookmarkNode[] {
  return nodes.flatMap(node => ids.has(node.id) ? [node] : selectedRoots(node.children ?? [], ids));
}

export function applyBookmarkChange(nodes: BookmarkNode[], change: BookmarkChange): BookmarkChangeResult {
  if (change.kind === 'add') {
    if (!change.node.id || !change.node.label.trim() || findBookmark(nodes, change.node.id) ||
      (change.node.url !== undefined && !isBookmarkUrl(change.node.url))) return { nodes, error: 'invalid' };
    const parent = change.parentId === null ? null : findBookmark(nodes, change.parentId);
    if (change.parentId !== null && (!parent || parent.url)) return { nodes, error: 'not-found' };
    const next = insert(nodes, change.parentId, [change.node], change.index);
    return validTree(next) ? { nodes: next } : { nodes, error: 'limit' };
  }
  if (change.kind === 'update') {
    const target = findBookmark(nodes, change.id);
    if (!target) return { nodes, error: 'not-found' };
    if ((change.label !== undefined && !change.label.trim()) ||
      (change.url !== undefined && (!target.url || !isBookmarkUrl(change.url))) ||
      (change.favicon !== undefined && (!target.url || !isBookmarkFavicon(change.favicon)))) return { nodes, error: 'invalid' };
    return { nodes: mapTree(nodes, node => node.id === change.id ? {
      ...node,
      ...(change.label !== undefined ? { label: change.label.trim() } : {}),
      ...(change.url !== undefined ? { url: change.url.trim() } : {}),
      ...(change.description !== undefined ? { description: change.description } : {}),
      ...(change.favicon !== undefined ? { favicon: change.favicon } : {})
    } : node) };
  }
  if (change.kind === 'remove') {
    const ids = new Set(change.ids);
    return { nodes: mapTree(nodes, node => ids.has(node.id) ? null : node) };
  }
  if (change.kind === 'move') {
    const moving = selectedRoots(nodes, new Set(change.ids));
    if (!moving.length) return { nodes, error: 'not-found' };
    const target = change.parentId === null ? null : findBookmark(nodes, change.parentId);
    if (change.parentId !== null && (!target || target.url)) return { nodes, error: 'not-found' };
    if (target && moving.some(node => bookmarkDescendants(node).some(item => item.id === target.id))) return { nodes, error: 'cycle' };
    const movingIds = new Set(moving.map(node => node.id));
    const remainder = mapTree(nodes, node => movingIds.has(node.id) ? null : node);
    const next = insert(remainder, change.parentId, moving, change.index);
    return validTree(next) ? { nodes: next } : { nodes, error: 'limit' };
  }
  const sort = (items: BookmarkNode[]): BookmarkNode[] => items.map(node => ({
    ...node, ...(node.children ? { children: sort(node.children) } : {})
  })).sort((a, b) => {
    if (change.mode === 'time') {
      if (a.dateAdded == null && b.dateAdded != null) return 1;
      if (a.dateAdded != null && b.dateAdded == null) return -1;
      return (b.dateAdded ?? 0) - (a.dateAdded ?? 0);
    }
    if (!!a.url !== !!b.url) return a.url ? 1 : -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });
  });
  return { nodes: sort(nodes) };
}
