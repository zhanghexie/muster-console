/** Entries are shortcuts, never filesystem paths. Order is the array order within each parent. */
import { isValidExtensionIcon } from './extensionIcons';

type NavigationBase = { id: string; parentId: string | null; title: string; favorite?: boolean; scope?: 'workspace' | 'global'; placement?: 'center' | 'left' | 'right' | 'window' | 'tab' };
export type ExtensionNavigationNode = NavigationBase & (
  | { kind: 'folder'; expanded: boolean }
  // Prototype-only webpage node; extension storage rejects it.
  | { kind: 'web'; url: string; profile?: string }
  | { kind: 'extension'; extensionId: string; viewId: string; description?: string; icon?: string; extensionScope?: 'global' | 'project'; extensionSourceRootId?: string }
);
export type NavigationPlacement = 'before' | 'after' | 'inside';
export type NavigationMove = { sourceId: string; targetId: string | null; placement: NavigationPlacement };

export function navigationChildren(nodes: ExtensionNavigationNode[], parentId: string | null): ExtensionNavigationNode[] {
  return nodes.filter(node => node.parentId === parentId);
}

export function navigationPath(nodes: ExtensionNavigationNode[], id: string | null): ExtensionNavigationNode[] {
  const result: ExtensionNavigationNode[] = [];
  const seen = new Set<string>();
  let current = nodes.find(node => node.id === id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    result.unshift(current);
    current = nodes.find(node => node.id === current?.parentId);
  }
  return result;
}

export function visibleNavigation(nodes: ExtensionNavigationNode[]): Array<{ node: ExtensionNavigationNode; depth: number }> {
  const result: Array<{ node: ExtensionNavigationNode; depth: number }> = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const node of navigationChildren(nodes, parent)) {
      result.push({ node, depth });
      if (node.kind === 'folder' && node.expanded) walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}

export function canMoveNavigation(nodes: ExtensionNavigationNode[], move: NavigationMove): boolean {
  const source = nodes.find(node => node.id === move.sourceId);
  const target = nodes.find(node => node.id === move.targetId);
  if (!source || source.id === move.targetId) return false;
  if (move.targetId === null) return move.placement === 'inside';
  if (!target || (move.placement === 'inside' && target.kind !== 'folder')) return false;
  const parent = move.placement === 'inside' ? target.id : target.parentId;
  return !navigationPath(nodes, parent).some(node => node.id === source.id);
}

export function moveNavigation(nodes: ExtensionNavigationNode[], move: NavigationMove): ExtensionNavigationNode[] {
  if (!canMoveNavigation(nodes, move)) return nodes;
  const source = nodes.find(node => node.id === move.sourceId)!;
  const target = nodes.find(node => node.id === move.targetId);
  const parentId = move.placement === 'inside' ? move.targetId : target!.parentId;
  const next = nodes.filter(node => node.id !== source.id);
  let index = next.length;
  if (move.placement !== 'inside') {
    index = next.findIndex(node => node.id === move.targetId) + (move.placement === 'after' ? 1 : 0);
  }
  next.splice(index, 0, { ...source, parentId });
  const scope = parentId ? next.find(node => node.id === parentId)?.scope ?? 'workspace' : source.scope;
  const moved = new Set(nodes.filter(node => navigationPath(nodes, node.id).some(ancestor => ancestor.id === source.id)).map(node => node.id));
  return next.map(node => node.id === parentId && node.kind === 'folder' ? { ...node, expanded: true } : moved.has(node.id) && scope !== undefined ? { ...node, scope } : node);
}

/** Promote direct children into the folder's exact sibling position; descendants remain attached. */
export function dissolveNavigationFolder(nodes: ExtensionNavigationNode[], id: string): ExtensionNavigationNode[] {
  const folder = nodes.find(node => node.id === id);
  if (folder?.kind !== 'folder') return nodes;
  const children = navigationChildren(nodes, id);
  const remainder = nodes.filter(node => node.parentId !== id);
  const index = remainder.findIndex(node => node.id === id);
  remainder.splice(index, 1, ...children.map(node => ({ ...node, parentId: folder.parentId })));
  return remainder;
}

export function normalizeNavigationUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^localhost:\d/i.test(trimmed)
    ? trimmed
    : `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Local prototype persistence is untrusted input; reject broken parents and cycles. */
export function parseNavigation(raw: unknown): ExtensionNavigationNode[] | null {
  if (!Array.isArray(raw) || raw.length > 1000) return null;
  const ids = new Set<string>();
  for (const node of raw) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id || node.id.length > 128 || ids.has(node.id)
      || typeof node.title !== 'string' || !node.title.trim() || node.title.length > 100
      || (node.favorite !== undefined && typeof node.favorite !== 'boolean')
      || (node.scope !== undefined && node.scope !== 'workspace' && node.scope !== 'global')
      || (node.placement !== undefined && !['center', 'left', 'right', 'window', 'tab'].includes(String(node.placement)))
      || (node.parentId !== null && typeof node.parentId !== 'string')) return null;
    if (node.kind === 'folder') { if (typeof node.expanded !== 'boolean') return null; }
    else if (node.kind === 'web') {
      if (typeof node.url !== 'string' || !normalizeNavigationUrl(node.url)
        || (node.profile !== undefined && (typeof node.profile !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(node.profile)))) return null;
    }
    else if (node.kind === 'extension') {
      if (typeof node.extensionId !== 'string' || typeof node.viewId !== 'string'
        || (node.description !== undefined && typeof node.description !== 'string')
        || (node.icon !== undefined && !isValidExtensionIcon(node.icon))
        || Object.hasOwn(node, 'extensionRuntime')
        || (node.extensionScope !== undefined && node.extensionScope !== 'global' && node.extensionScope !== 'project')
        || (node.extensionSourceRootId !== undefined && (typeof node.extensionSourceRootId !== 'string' || !node.extensionSourceRootId))) return null;
    } else return null;
    ids.add(node.id);
  }
  const nodes = raw as ExtensionNavigationNode[];
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let parent = node.parentId;
    while (parent !== null) {
      const owner = nodes.find(item => item.id === parent);
      if (!owner || owner.kind !== 'folder' || seen.has(owner.id)) return null;
      seen.add(owner.id);
      parent = owner.parentId;
    }
  }
  return nodes.map(node => node.kind === 'web' ? { ...node, url: normalizeNavigationUrl(node.url)! } : node);
}

export interface ExtensionNavigationSnapshot {
  workspaceId: string;
  revision: number;
  nodes: ExtensionNavigationNode[];
  libraryExpanded: boolean;
}
