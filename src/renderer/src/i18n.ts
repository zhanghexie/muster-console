/**
 * 渲染层语言接线（主题 theme.ts 同款三段式）：
 * 1. 模块加载即用 localStorage 缓存先刷（防启动闪错语言）；
 * 2. main.tsx 启动时 initLocale()：config.get() 校正 + 订阅 locale:changed；
 * 3. 挂 initReactI18next——组件里 useTranslation() 拿 t，语言切换自动重渲染。
 * 设置切换语言走 changeLocale()（本地立即生效 + config:update 落盘）。
 */
import { initReactI18next } from 'react-i18next';
import {
  applyLocaleSetting,
  setupI18n,
  type AppLocale,
  type ResolvedLocale
} from '../../shared/i18n';

const LOCALE_CACHE_KEY = 'muster.locale.cache.v1';

function readCachedResolved(): ResolvedLocale | null {
  try {
    const raw = localStorage.getItem(LOCALE_CACHE_KEY);
    if (raw === 'zh-CN' || raw === 'en') return raw;
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return null;
}

function cacheResolved(locale: ResolvedLocale): void {
  try {
    localStorage.setItem(LOCALE_CACHE_KEY, locale);
  } catch {
    /* ignore */
  }
}

// 初始化（reactModule 必须在 init 前挂上，useTranslation 才会订阅 languageChanged
// 触发重渲染）→ 缓存先刷（缺缓存保持默认中文，等待 config 校正）
setupI18n({ reactModule: initReactI18next });
const cached = readCachedResolved();
if (cached) applyLocaleSetting(cached);

/** main.tsx 启动调用：主进程配置为准校正语言 + 订阅后续变更 */
export function initLocale(): void {
  try {
    void window.api.config
      .get()
      .then((cfg) => {
        cacheResolved(applyLocaleSetting(cfg.locale, navigator.language));
      })
      .catch(() => {
        /* 主进程不可达（如单测环境）保持缓存语言 */
      });
  } catch {
    /* ignore */
  }
  try {
    window.api.on('locale:changed', (p) => {
      cacheResolved(applyLocaleSetting(p.locale, navigator.language));
    });
  } catch {
    /* ignore */
  }
}

/** 设置「外观」页切换语言：本地立即生效 + 落盘（语言不随设置表单草稿回写） */
export function changeLocale(locale: AppLocale): void {
  cacheResolved(applyLocaleSetting(locale, navigator.language));
  void window.api.config.update({ locale }).catch(() => {
    /* ignore */
  });
}
