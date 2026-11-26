/**
 * 主题应用（渲染层）：主题种子与工作区色先解析为一份 ResolvedAppearance，
 * 同步发布 CSS、CodeMirror、xterm、扩展面板与原生窗口的最终颜色。
 * 生效路径：localStorage 缓存先刷（防启动闪深色）→ IPC 拉当前主题校正 → 订阅 themes:changed。
 */

import {
  BUILTIN_THEMES,
  THEME_COLOR_KEYS,
  builtinTheme,
  parseTheme,
  type WorkbenchTheme
} from '../../shared/theme';
import { syncWindowChrome } from './windowChrome';
import { resolveAppearance, type AppearanceWorkspace, type ResolvedAppearance } from '../../shared/resolvedAppearance';

/** 兼容期清理：旧版只存 'dark' 字符串的键 */
const LEGACY_THEME_KEY = 'muster.theme';
/** 启动缓存：完整主题 JSON（避免 IPC 往返期间闪默认深色） */
const THEME_CACHE_KEY = 'muster.theme.cache.v1';
const BOOT_APPEARANCE_KEY = 'muster.appearance.boot.v1';

const listeners = new Set<(theme: WorkbenchTheme) => void>();
const appearanceListeners = new Set<(appearance: ResolvedAppearance) => void>();

let current: WorkbenchTheme = builtinTheme('dark')!;
let workspace: AppearanceWorkspace = { workspaceId: null, accent: '#8b7bff', enabled: false };
let appearanceRevision = 0;
let appearance = resolveAppearance(current, workspace, appearanceRevision);
let previewing = false;
/** 上次已发布外观的签名：DOM 写入面（root CSS 变量/终端配色/原生框/材质属性）
 *  的全部输入。签名不变时发布是纯 no-op——跳过可避免 CodeMirror/xterm 主题
 *  重配带来的动态样式表变动（会级联成近全文档 style recalc；工作区切换在
 *  未定制各区别色时是重灾区，实测 100ms+ 长任务的主因）。 */
let lastAppearanceSignature = '';

function appearanceSignature(value: ResolvedAppearance, material: boolean): string {
  return JSON.stringify([value.cssVars, value.terminal, value.nativeChrome, value.appearance, material]);
}

export function getTheme(): WorkbenchTheme {
  return current;
}

/** 启动同步取缓存主题；缓存缺失/损坏回内置深色 */
export function getStoredTheme(): WorkbenchTheme {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (raw) {
      const res = parseTheme(JSON.parse(raw));
      if (res.ok) return res.theme!;
    }
  } catch {
    /* 回内置深色 */
  }
  return builtinTheme('dark')!;
}

export function getResolvedAppearance(): ResolvedAppearance { return appearance; }

export function subscribeAppearance(fn: (value: ResolvedAppearance) => void): () => void {
  appearanceListeners.add(fn);
  return () => { appearanceListeners.delete(fn); };
}

function publishAppearance(): void {
  const candidate = resolveAppearance(current, workspace, appearanceRevision + 1);
  const signature = appearanceSignature(candidate, workspace.enabled);
  if (signature === lastAppearanceSignature) return;
  lastAppearanceSignature = signature;
  appearanceRevision += 1;
  appearance = candidate;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(appearance.cssVars)) root.style.setProperty(key, value);
  root.dataset.appearanceRevision = String(appearance.revision);
  root.dataset.workspaceMaterial = workspace.enabled ? 'frosted' : 'solid';
  if (!previewing) {
    try {
      const keys = ['--fg-primary', '--surface-frame', '--surface-raised', '--status-danger-bg', '--status-danger-fg', '--status-danger-border'];
      localStorage.setItem(BOOT_APPEARANCE_KEY, JSON.stringify(Object.fromEntries(keys.map(key => [key, appearance.cssVars[key]]))));
    } catch { /* Storage can be unavailable; generated defaults cover the first frame. */ }
  }
  void syncWindowChrome(appearance.nativeChrome);
  for (const fn of appearanceListeners) fn(appearance);
}

export function setWorkspaceAppearance(next: AppearanceWorkspace): void {
  if (workspace.workspaceId === next.workspaceId && workspace.accent === next.accent && workspace.enabled === next.enabled) return;
  workspace = { ...next };
  publishAppearance();
}

/** Material hook shares the same resolver; it never derives or composites colors. */
export function setWorkspaceMaterialEnabled(enabled: boolean): void {
  setWorkspaceAppearance({ ...workspace, enabled });
}

export function applyTheme(theme: WorkbenchTheme, options: { persist?: boolean } = {}): void {
  if (!theme) return;
  current = theme;
  previewing = options.persist === false;
  const root = document.documentElement;
  // 先清后写：缓存里的旧主题可能缺键，避免残留上一次的值
  for (const key of THEME_COLOR_KEYS) root.style.removeProperty(`--${key}`);
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key}`, value);
  }
  root.dataset.theme = theme.appearance;
  root.style.colorScheme = theme.appearance;
  try {
    if (options.persist !== false) {
      localStorage.removeItem(LEGACY_THEME_KEY);
      localStorage.setItem(
        THEME_CACHE_KEY,
        JSON.stringify({ name: theme.name, appearance: theme.appearance, colors: theme.colors, terminal: theme.terminal })
      );
    }
  } catch {
    /* 隐私模式等场景忽略 */
  }
  publishAppearance();
  for (const fn of listeners) fn(theme);
}

/** 启动初始化：缓存即时刷 + 主进程主题为准校正 + 订阅后续变更 */
export async function initTheme(): Promise<void> {
  applyTheme(getStoredTheme());
  try {
    const view = await window.api.themes.list();
    applyTheme(view.active);
  } catch {
    /* 主进程不可达（如单测环境）时保持缓存主题 */
  }
  try {
    window.api.on('themes:changed', (payload) => {
      applyTheme(payload.active);
    });
  } catch {
    /* ignore */
  }
}

export function subscribeTheme(fn: (theme: WorkbenchTheme) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 终端配色（xterm 只收具体色值，不走 CSS 变量）。
 * 默认底色/前景/选区来自当前 appearance；ANSI 身份色仍来自主题种子。
 */
export function terminalTheme(_mode?: unknown): Record<string, string> {
  return { ...appearance.terminal };
}

export { BUILTIN_THEMES };
export type { WorkbenchTheme };
