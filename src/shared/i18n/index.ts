/**
 * 应用多语言核心：i18next 实例 + 语言解析/切换/订阅。
 * 无 React 依赖——主进程 / 渲染层 / 共享层三方共用；渲染层由 renderer/src/i18n.ts
 * 挂 initReactI18next，组件里 useTranslation() 拿 t（语言切换自动重渲染），
 * 非 React 代码直接用本模块导出的 t()（改语言后下次取值即新语言）。
 *
 * key 方案：key = 中文原文。英文词条在 locales/en.ts；缺词条时 i18next 回退
 * fallbackLng（zh-CN 无资源）→ 最终显示 key 本身（中文原文），绝不露生 key。
 * 插值：模板串里的 ${x} 改写成 {{x}} 占位，调用时传 { x }。不传 count（避开
 * i18next 复数后缀机制），英文复数敏感的串交给 Intl（相对时间等）或按单复数分 key。
 *
 * 语言值：'system' 跟随系统（zh* → zh-CN，其余 → en）；持久化在 AppConfig.locale。
 */
import i18next, { type i18n as I18nInstance, type Module } from 'i18next';
import { en } from './locales/en';

/** 用户可设置的语言档位 */
export type AppLocale = 'system' | 'zh-CN' | 'en';
/** 解析后的实际语言（资源齐备的两个） */
export type ResolvedLocale = 'zh-CN' | 'en';

const listeners = new Set<(locale: ResolvedLocale) => void>();

/** 用户设置值（'system' 或具体语言） */
let configured: AppLocale = 'system';
/** 当前生效语言（i18next lng） */
let resolved: ResolvedLocale = 'zh-CN';
/** 是否已初始化（setupI18n 幂等） */
let inited = false;

/** 系统语言标签（zh-CN / en-US …）解析为支持的语言 */
export function resolveSystemLocale(systemLang: string | undefined): ResolvedLocale {
  return (systemLang ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** 设置档位 + 系统语言 → 生效语言 */
export function resolveAppLocale(
  locale: AppLocale | undefined,
  systemLang: string | undefined
): ResolvedLocale {
  if (locale === 'zh-CN' || locale === 'en') return locale;
  return resolveSystemLocale(systemLang);
}

// zh-CN 注册「身份资源」（key→key）：i18next 对 missing-key 回退的 key 不做
// 插值（含 {{x}} 的 key 会原样露出），走正常翻译命中才能把 {{x}} 替换掉；
// en 缺词条回退 zh-CN 时同理（中文 + 数字占位正常替换）。
const zhIdentity: Record<string, string> = {};
for (const key of Object.keys(en)) zhIdentity[key] = key;

/**
 * 初始化（幂等）。**渲染层必须传 reactModule=initReactI18next 且要在语言切换
 * 生效前挂上**——react-i18next 的 useTranslation 依赖它写入的 react 默认项
 * （bindI18n='languageChanged'）才会订阅语言变化重渲染；主进程/测试不带参调用
 * （或由 t()/applyLocaleSetting 懒初始化兜底）。
 */
/**
 * t() 调用结果缓存（2026-09-14 性能专项 + P2-2 扩展）：key=中文原文的静态标签在
 * 渲染层被高频重复解析（真机 CPU profile：i18next 解析占长任务窗口 ~8%，单次点击
 * 上千次 t()），结果只随语言与 options 变化——key-only 与带 options 的调用都命中
 * Map 直取。options 键排序后 JSON.stringify 参与缓存键（异序同参同键）；options
 * 值含函数（formatter 等语义依赖调用点）时跳过缓存透传；languageChanged 清空。
 */
const tCache = new Map<string, string>();

/** options 的稳定序列化：键排序后 JSON.stringify；含函数值返回 null（不缓存透传） */
function optionsCacheKey(options: Record<string, unknown>): string | null {
  const keys = Object.keys(options);
  for (const k of keys) {
    if (typeof options[k] === 'function') return null;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of [...keys].sort()) sorted[k] = options[k];
  return JSON.stringify(sorted);
}

export function setupI18n(opts?: { reactModule?: Module }): void {
  if (inited) return;
  inited = true;
  if (opts?.reactModule) i18next.use(opts.reactModule);
  i18next.init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhIdentity }
    },
    // React 已自行转义；桌面应用无 XSS 注入面差异
    interpolation: { escapeValue: false },
    // key = 中文原文（扁平表），大量 key 同时含 '.' 与 ':'（如 "tool.script xxx: {{error}}"）；
    // 默认 nsSeparator 会把冒号前段误判成 namespace 只剩 "{{x}}"，故禁用 ns 拆分
    nsSeparator: false,
    returnNull: false
  });
  // 实例级 t 包装：react-i18next 的 useTranslation/fixedT 运行时经 this.t 进入，
  // 组件里的每次取词都会路过这里——key-only 与带 options 命中缓存（P2-2），
  // options 含函数值时透传原实现（formatter 语义依赖调用点，不缓存）
  const inst = i18next as unknown as {
    t: (key: string, options?: Record<string, unknown>) => string;
  };
  const origT = inst.t.bind(i18next);
  inst.t = (key: string, options?: Record<string, unknown>): string => {
    if (typeof key !== 'string') return origT(key, options);
    let cacheKey: string;
    if (options === undefined) {
      cacheKey = key;
    } else {
      const optKey = optionsCacheKey(options);
      if (optKey === null) return origT(key, options);
      cacheKey = `${key}\u0001${optKey}`;
    }
    const hit = tCache.get(cacheKey);
    if (hit !== undefined) return hit;
    const v = options === undefined ? origT(key) : origT(key, options);
    tCache.set(cacheKey, v);
    return v;
  };
  i18next.on('languageChanged', () => tCache.clear());
}

/** 测试专用（i18n-t-cache.spec）：观测缓存是否参与调用路径（非语义面，不供业务用） */
export function tCacheSizeForTest(): number {
  return tCache.size;
}

/** document 只在渲染进程存在；主进程侧跳过 DOM 同步 */
function syncDocumentLang(next: ResolvedLocale): void {
  const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
  if (doc) doc.documentElement.lang = next;
}

function applyResolved(next: ResolvedLocale): void {
  syncDocumentLang(next);
  if (next === resolved) return;
  resolved = next;
  void i18next.changeLanguage(next);
  for (const fn of listeners) fn(next);
}

/** 当前用户设置档位（含 'system'） */
export function getLocaleSetting(): AppLocale {
  return configured;
}

/** 当前生效语言 */
export function getResolvedLocale(): ResolvedLocale {
  return resolved;
}

/**
 * 应用语言设置（主进程启动 / 渲染层启动与设置切换共用）。
 * systemLang：主进程传 app.getLocale()，渲染层传 navigator.language。
 * 返回生效语言。
 */
export function applyLocaleSetting(
  locale: AppLocale | undefined,
  systemLang?: string
): ResolvedLocale {
  setupI18n();
  configured = locale ?? 'system';
  const next = resolveAppLocale(configured, systemLang);
  applyResolved(next);
  return next;
}

/**
 * 翻译。React 组件请用 useTranslation() 返回的同名 t（自动随语言切换重渲染）；
 * 本函数用于非 React 代码（shared 纯函数 / 主进程 / 模块顶层）。
 * key 必须是字面量中文原文（覆盖率脚本 test/i18n-coverage.mjs 据此对账 en 词条）。
 */
export function t(key: string, options?: Record<string, unknown>): string {
  if (!inited) setupI18n();
  return i18next.t(key, options) as string;
}

/** 订阅生效语言变化（返回退订函数） */
export function subscribeLocale(fn: (locale: ResolvedLocale) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export { i18next as i18nInstance };
export type { I18nInstance };
