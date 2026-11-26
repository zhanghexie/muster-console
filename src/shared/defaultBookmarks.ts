import { applyBookmarkChange, findBookmark } from './bookmarks';
import type { BookmarkNode } from './bookmarks';

export const DEFAULT_BOOKMARKS_VERSION = 1;

const folder = (id: string, label: string, children: BookmarkNode[]): BookmarkNode => ({ id: `default-${id}`, label, children });
const site = (id: string, label: string, url: string): BookmarkNode => ({ id: `default-${id}`, label, url });

/** Curated starting points; these are ordinary, editable workspace bookmarks after initialization. */
export const DEFAULT_BOOKMARKS: BookmarkNode[] = [
  folder('work', '工作', [
    folder('ai', 'AI 聊天', [
      site('deepseek', 'DeepSeek', 'https://chat.deepseek.com/'),
      site('chatgpt', 'ChatGPT', 'https://chatgpt.com/'),
      site('claude', 'Claude', 'https://claude.ai/'),
      site('gemini', 'Gemini', 'https://gemini.google.com/'),
      site('kimi', 'Kimi', 'https://www.kimi.com/'),
      site('doubao', '豆包', 'https://www.doubao.com/'),
      site('qianwen', '千问', 'https://www.qianwen.com/'),
      site('perplexity', 'Perplexity', 'https://www.perplexity.ai/')
    ]),
    folder('dev', '开发', [
      site('github', 'GitHub', 'https://github.com/'),
      site('huggingface', 'Hugging Face', 'https://huggingface.co/'),
      site('stackoverflow', 'Stack Overflow', 'https://stackoverflow.com/'),
      site('mdn', 'MDN Web 文档', 'https://developer.mozilla.org/zh-CN/'),
      site('juejin', '稀土掘金', 'https://juejin.cn/'),
      site('leetcode', '力扣', 'https://leetcode.cn/'),
      site('v2ex', 'V2EX', 'https://www.v2ex.com/')
    ]),
    folder('collaboration', '办公协作', [
      site('feishu', '飞书', 'https://www.feishu.cn/'),
      site('tencent-docs', '腾讯文档', 'https://docs.qq.com/'),
      site('notion', 'Notion', 'https://www.notion.so/'),
      site('figma', 'Figma', 'https://www.figma.com/')
    ])
  ]),
  folder('entertainment', '娱乐', [
    folder('video', '视频', [
      site('youtube', 'YouTube', 'https://www.youtube.com/'),
      site('bilibili', '哔哩哔哩', 'https://www.bilibili.com/'),
      site('douyin', '抖音', 'https://www.douyin.com/'),
      site('netflix', 'Netflix', 'https://www.netflix.com/')
    ]),
    folder('music', '音乐', [
      site('netease-music', '网易云音乐', 'https://music.163.com/'),
      site('qq-music', 'QQ 音乐', 'https://y.qq.com/'),
      site('spotify', 'Spotify', 'https://open.spotify.com/'),
      site('apple-music', 'Apple Music', 'https://music.apple.com/')
    ]),
    folder('community', '社区', [
      site('xiaohongshu', '小红书', 'https://www.xiaohongshu.com/'),
      site('douban', '豆瓣', 'https://www.douban.com/'),
      site('reddit', 'Reddit', 'https://www.reddit.com/')
    ])
  ]),
  folder('learn', '阅读学习', [
    site('zhihu', '知乎', 'https://www.zhihu.com/'),
    site('wikipedia', '维基百科', 'https://zh.wikipedia.org/'),
    site('sspai', '少数派', 'https://sspai.com/'),
    site('arxiv', 'arXiv', 'https://arxiv.org/'),
    site('scholar', 'Google 学术', 'https://scholar.google.com/'),
    site('coursera', 'Coursera', 'https://www.coursera.org/')
  ]),
  folder('tools', '实用工具', [
    folder('search', '搜索', [
      site('bing', '必应', 'https://www.bing.com/'),
      site('baidu', '百度', 'https://www.baidu.com/'),
      site('google', 'Google', 'https://www.google.com/'),
      site('duckduckgo', 'DuckDuckGo', 'https://duckduckgo.com/')
    ]),
    folder('translation', '翻译', [
      site('deepl', 'DeepL', 'https://www.deepl.com/translator'),
      site('youdao', '有道翻译', 'https://fanyi.youdao.com/')
    ])
  ])
];

const folderKey = (label: string): string => label.replace(/\s+/g, '').toLocaleLowerCase();
const urlKey = (url: string): string => {
  try { return new URL(url).href.replace(/\/$/, ''); } catch { return url.trim(); }
};

/** Merge once, preserving existing nodes and skipping websites already bookmarked anywhere. */
export function mergeDefaultBookmarks(nodes: BookmarkNode[]): { nodes: BookmarkNode[]; complete: boolean } {
  let next = nodes;
  const knownUrls = new Set<string>();
  const collectUrls = (list: BookmarkNode[]): void => {
    for (const node of list) { if (node.url) knownUrls.add(urlKey(node.url)); else collectUrls(node.children ?? []); }
  };
  collectUrls(nodes);
  const uniqueId = (base: string): string => {
    let id = base, suffix = 2;
    while (findBookmark(next, id)) id = `${base}-${suffix++}`;
    return id;
  };
  const entries: Array<{ site: BookmarkNode; path: BookmarkNode[] }> = [];
  const collectEntries = (list: BookmarkNode[], path: BookmarkNode[]): void => {
    for (const node of list) {
      if (node.url) entries.push({ site: node, path });
      else collectEntries(node.children ?? [], [...path, node]);
    }
  };
  collectEntries(DEFAULT_BOOKMARKS, []);
  for (const entry of entries) {
    const key = urlKey(entry.site.url!);
    if (knownUrls.has(key)) continue;
    let parentId: string | null = null;
    for (const part of entry.path) {
      const siblings: BookmarkNode[] = parentId === null ? next : findBookmark(next, parentId)?.children ?? [];
      const existing = siblings.find(node => !node.url && folderKey(node.label) === folderKey(part.label));
      if (existing) { parentId = existing.id; continue; }
      const id = uniqueId(part.id);
      const result = applyBookmarkChange(next, { kind: 'add', parentId, node: { id, label: part.label, children: [] } });
      if (result.error) return { nodes, complete: false };
      next = result.nodes; parentId = id;
    }
    const result = applyBookmarkChange(next, { kind: 'add', parentId, node: { ...entry.site, id: uniqueId(entry.site.id) } });
    if (result.error) return { nodes, complete: false };
    next = result.nodes; knownUrls.add(key);
  }
  return { nodes: next, complete: true };
}
