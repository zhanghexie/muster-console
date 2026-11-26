import { describe, expect, it } from 'vitest';
import { applyBookmarkChange, isBookmarkTree } from '../../src/shared/bookmarks';
import { initialRightWorkspace, reduceRightWorkspace, saveRightWorkspace, type BookmarkNode } from '../../src/shared/rightWorkspace';

const tree: BookmarkNode[] = [
  { id: 'a', label: 'A', url: 'https://a.test', dateAdded: 10 },
  { id: 'folder', label: 'Folder', children: [{ id: 'b', label: 'B', url: 'https://b.test' }] },
  { id: 'c', label: 'C', url: 'https://c.test', dateAdded: 20 }
];

describe('workspace bookmark mutations', () => {
  it('moves root items into folders and back in one update without losing metadata', () => {
    const moved = applyBookmarkChange(tree, { kind: 'move', ids: ['a', 'c'], parentId: 'folder', index: 1 });
    expect(moved.error).toBeUndefined();
    expect(moved.nodes.map(node => node.id)).toEqual(['folder']);
    expect(moved.nodes[0].children?.map(node => node.id)).toEqual(['b', 'a', 'c']);
    expect(moved.nodes[0].children?.[1].dateAdded).toBe(10);
    const back = applyBookmarkChange(moved.nodes, { kind: 'move', ids: ['a'], parentId: null, index: 0 });
    expect(back.nodes.map(node => node.id)).toEqual(['a', 'folder']);
  });
  it('rejects cycles and unsafe URLs without changing the original tree', () => {
    const nested = [{ id: 'p', label: 'P', children: [{ id: 'q', label: 'Q', children: [] }] }];
    expect(applyBookmarkChange(nested, { kind: 'move', ids: ['p'], parentId: 'q' })).toEqual({ nodes: nested, error: 'cycle' });
    expect(applyBookmarkChange(tree, { kind: 'add', parentId: null, node: { id: 'bad', label: 'Bad', url: 'javascript:alert(1)' } }).error).toBe('invalid');
  });
  it('keeps missing dates unknown and sorts them after dated entries', () => {
    const sorted = applyBookmarkChange(tree, { kind: 'sort', mode: 'time' }).nodes;
    expect(sorted.map(node => node.id)).toEqual(['c', 'a', 'folder']);
    expect(sorted[2].children?.[0].dateAdded).toBeUndefined();
  });
  it('preserves metadata through persistence and ignores stale workspace edits', () => {
    let s = reduceRightWorkspace(initialRightWorkspace('ws', 's'), { type: 'bookmarkSnapshot', workspaceId: 'ws', saved: { version: 1, bookmarks: [], bookmarkDefaultsVersion: 1 } });
    s = reduceRightWorkspace(s, { type: 'bookmarkChange', workspaceId: 'ws', change: { kind: 'add', parentId: null, node: { ...tree[0], description: 'Notes' } } });
    s = reduceRightWorkspace(s, { type: 'bookmarkChange', workspaceId: 'ws', change: { kind: 'update', id: 'a', favicon: 'data:image/png;base64,ZmFrZQ==' } });
    expect(isBookmarkTree(s.bookmarks.ws)).toBe(true);
    expect(s.bookmarks.ws[0]).toMatchObject({ id: 'a', dateAdded: 10, description: 'Notes', favicon: 'data:image/png;base64,ZmFrZQ==' });
    expect(saveRightWorkspace(s)).not.toHaveProperty('bookmarks');
    s = reduceRightWorkspace(s, { type: 'scope', workspaceId: 'other', sessionId: 's' });
    s = reduceRightWorkspace(s, { type: 'bookmarkChange', workspaceId: 'ws', change: { kind: 'remove', ids: ['a'] } });
    expect(s.bookmarks.ws).toHaveLength(1);
  });
});
