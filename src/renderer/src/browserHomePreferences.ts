export interface HomeSearchEngine { id: string; name: string; url: string }
export interface HomeSearchPreferences { engines: HomeSearchEngine[]; defaultId: string }

export const HOME_SEARCH_PRESETS: HomeSearchEngine[] = [
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  { id: 'bilibili', name: '哔哩哔哩', url: 'https://search.bilibili.com/all?keyword=%s' },
  { id: 'yandex', name: 'Yandex', url: 'https://yandex.com/search/?text=%s' },
  { id: 'zhihu', name: '知乎', url: 'https://www.zhihu.com/search?q=%s' }
];

/** Preset names are data in saved preferences; localize only unchanged defaults. */
export function homeSearchEngineLabel(engine: HomeSearchEngine, translate: (key: string) => string): string {
  const preset = HOME_SEARCH_PRESETS.find(item => item.id === engine.id && item.name === engine.name && item.url === engine.url);
  return preset ? translate(preset.name) : engine.name;
}
const KEY = 'muster.browser.home.search.v1';
export const HOME_SEARCH_CHANGED = 'muster:browser-home-search-changed';
const LEGACY_BAIDU_PRESET: HomeSearchEngine = { id: 'baidu', name: 'Baidu', url: 'https://www.baidu.com/s?wd=%s' };

export function validSearchTemplate(value: string): boolean {
  if (!value.includes('%s')) return false;
  try { return ['https:', 'http:'].includes(new URL(value.replace('%s', 'query')).protocol); }
  catch { return false; }
}

export function readHomeSearchPreferences(): HomeSearchPreferences {
  const fallback = { engines: HOME_SEARCH_PRESETS, defaultId: 'bing' };
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as HomeSearchPreferences | null;
    if (!parsed || !Array.isArray(parsed.engines)) return fallback;
    const seen = new Set<string>();
    const engines = parsed.engines.slice(0, 12).filter(engine => {
      if (!engine || typeof engine.id !== 'string' || !engine.id || seen.has(engine.id) ||
        typeof engine.name !== 'string' || !engine.name.trim() || typeof engine.url !== 'string' || !validSearchTemplate(engine.url)) return false;
      // 只剔除旧版内置项，用户自己添加或修改过的搜索引擎仍保留。
      if (engine.id === LEGACY_BAIDU_PRESET.id && engine.name === LEGACY_BAIDU_PRESET.name && engine.url === LEGACY_BAIDU_PRESET.url) return false;
      seen.add(engine.id); return true;
    });
    return engines.length ? { engines, defaultId: engines.some(engine => engine.id === parsed.defaultId) ? parsed.defaultId : engines[0].id } : fallback;
  } catch { return fallback; }
}

export function writeHomeSearchPreferences(value: HomeSearchPreferences): void {
  localStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(HOME_SEARCH_CHANGED));
}
