import { DEFAULT_BOOKMARKS } from '../../shared/defaultBookmarks';
import type { BookmarkNode } from '../../shared/rightWorkspace';

const builtins = new Map<string, BookmarkNode>();
function addBuiltins(nodes: BookmarkNode[]): void {
  for (const node of nodes) {
    builtins.set(node.id, node);
    if (node.children) addBuiltins(node.children);
  }
}
addBuiltins(DEFAULT_BOOKMARKS);

/** Translate only unchanged default labels; user bookmarks and edits stay literal. */
export function bookmarkDisplayLabel(node: BookmarkNode, translate: (key: string) => string): string {
  // Initial merging may append a numeric suffix if another node has the default ID.
  const builtin = builtins.get(node.id) ?? builtins.get(node.id.replace(/-(?:[2-9]|[1-9]\d+)$/, ''));
  if (!builtin || node.label !== builtin.label || node.url !== builtin.url || !!node.children !== !!builtin.children) return node.label;
  return translate(builtin.label);
}
