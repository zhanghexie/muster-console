import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOKMARKS, mergeDefaultBookmarks } from '../../src/shared/defaultBookmarks';
import type { BookmarkNode } from '../../src/shared/bookmarks';
import { bookmarkDisplayLabel } from '../../src/renderer/src/bookmarkDisplay';
import { en } from '../../src/shared/i18n/locales/en';

const all = (nodes: BookmarkNode[]): BookmarkNode[] => nodes.flatMap(node => [node, ...all(node.children ?? [])]);

describe('default workspace bookmarks', () => {
  it('translates only unchanged built-in labels, including IDs suffixed during merging', () => {
    const translate = (key: string): string => en[key] ?? key;
    for (const node of all(DEFAULT_BOOKMARKS)) {
      if (/[\u4e00-\u9fff]/.test(node.label)) expect(en[node.label], node.id).toBeTruthy();
      expect(bookmarkDisplayLabel(node, translate)).toBe(translate(node.label));
    }
    const doubao = all(DEFAULT_BOOKMARKS).find(node => node.id === 'default-doubao')!;
    expect(bookmarkDisplayLabel({ ...doubao, id: `${doubao.id}-2` }, translate)).toBe('Doubao');
    expect(bookmarkDisplayLabel({ ...doubao, label: '我的豆包' }, translate)).toBe('我的豆包');
    expect(bookmarkDisplayLabel({ ...doubao, url: 'https://mine.test/' }, translate)).toBe('豆包');
    expect(bookmarkDisplayLabel({ ...doubao, id: 'my-doubao' }, translate)).toBe('豆包');
  });
  it('provides categorized, unique HTTPS sites including the requested examples', () => {
    const result = mergeDefaultBookmarks([]);
    expect(result.complete).toBe(true);
    expect(result.nodes.map(node => node.label)).toEqual(['工作', '娱乐', '阅读学习', '实用工具']);
    const sites = all(result.nodes).filter(node => node.url);
    expect(sites.length).toBeGreaterThanOrEqual(35);
    expect(new Set(sites.map(node => node.url)).size).toBe(sites.length);
    expect(sites.every(node => node.url?.startsWith('https://'))).toBe(true);
    expect(sites.map(node => node.label)).toEqual(expect.arrayContaining(['DeepSeek', 'ChatGPT', 'YouTube', '哔哩哔哩']));
    expect(all(DEFAULT_BOOKMARKS).filter(node => node.url)).toHaveLength(sites.length);
  });

  it('merges into existing folders, skips saved URLs and avoids ID collisions', () => {
    const existing: BookmarkNode[] = [
      { id: 'default-deepseek', label: '我的网页', url: 'https://mine.test/' },
      { id: 'my-work', label: '工作', children: [{ id: 'my-ai', label: 'AI聊天', children: [
        { id: 'my-chatgpt', label: '我的 ChatGPT', url: 'https://chatgpt.com', description: '原有收藏' }
      ] }] }
    ];
    const result = mergeDefaultBookmarks(existing);
    expect(result.complete).toBe(true);
    expect(result.nodes.filter(node => node.label === '工作')).toHaveLength(1);
    const ai = result.nodes.find(node => node.id === 'my-work')!.children!.find(node => node.id === 'my-ai')!;
    expect(ai.children?.find(node => node.id === 'my-chatgpt')).toMatchObject({ description: '原有收藏' });
    expect(ai.children?.find(node => node.label === 'DeepSeek')?.id).toBe('default-deepseek-2');
    expect(all(result.nodes).filter(node => node.url?.startsWith('https://chatgpt.com'))).toHaveLength(1);
    expect(existing[1].children?.[0].children).toHaveLength(1);
  });

  it('keeps the original tree intact when folder limits prevent initialization', () => {
    const full = Array.from({ length: 200 }, (_, index) => ({ id: `custom-${index}`, label: `自定义 ${index}`, url: `https://site${index}.test/` }));
    const result = mergeDefaultBookmarks(full);
    expect(result).toEqual({ nodes: full, complete: false });
  });
});
