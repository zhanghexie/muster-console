/**
 * 主题系统共享模型（主/渲染进程共用）：
 *  - 内置主题：深色（默认种子）+ 浅色，最终角色由 resolvedAppearance 单源生成
 *  - 自定义主题：userData/themes/<id>.json，JSON 由 parseTheme 校验、formatThemeJson 落盘
 * 主题只管颜色 token（design.md 色彩系统）；圆角/字阶/层级不在主题范围内。
 */

import { t } from './i18n';

export type ThemeAppearance = 'dark' | 'light';

export const DEFAULT_THEME_ID = 'dark';

/** 可编辑颜色种子（key 不带 -- 前缀）；缺键按同外观内置主题回填。
 *  最终 CSS/renderer 颜色由 resolver 派生，生成的 base/SDK 默认块不另设调色板。 */
export const THEME_COLOR_KEYS = [
  // 框与页海拔梯（design.md §1.1）
  'bg-frame',
  'bg-canvas',
  'bg-panel',
  'bg-raised',
  'bg-overlay',
  'bg-input',
  // 文字三级 + 描边（§1.2）
  'ink',
  'ink-soft',
  'text-2',
  'text-3',
  'hairline',
  // 状态色（§1.3）
  'green',
  'yellow',
  'red',
  'blue',
  'purple',
  // 语法高亮（§1.4）
  'syn-fg',
  'syn-muted',
  'syn-blue',
  'syn-cyan',
  'syn-red',
  'syn-purple',
  'syn-orange',
  'syn-yellow',
  // 交互叠层 / 阴影 / 骨架 / 滚动条 / 遮罩
  'hover-fill',
  'hover-fill-strong',
  'selected-fill',
  'shadow-card',
  'shadow-page',
  'shadow-input',
  'shadow-pop',
  'skel-a',
  'skel-b',
  'scroll-thumb',
  'scroll-thumb-hover',
  'scrim'
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type ThemeColors = Record<ThemeColorKey, string>;

/** xterm 终端色（API 只收具体色值，不走 CSS 变量，须随主题单独下发） */
export const TERMINAL_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionInactiveBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;

/** Host surfaces/content inks are opaque; only explicit interaction/selection masks may carry alpha. */
const OVERLAY_THEME_KEYS = new Set(['hover-fill', 'hover-fill-strong', 'selected-fill', 'skel-a', 'skel-b', 'scrim']);
const OVERLAY_TERMINAL_KEYS = new Set(['selectionBackground', 'selectionInactiveBackground']);

/** One policy for JSON validation and the theme editor's alpha controls. */
export function themeColorAllowsAlpha(section: 'colors' | 'terminal', key: string): boolean {
  return section === 'terminal' ? OVERLAY_TERMINAL_KEYS.has(key) : OVERLAY_THEME_KEYS.has(key) || SHADOW_VALUE_KEYS.has(key);
}

export type TerminalColorKey = (typeof TERMINAL_COLOR_KEYS)[number];
export type TerminalColors = Record<TerminalColorKey, string>;

export interface WorkbenchTheme {
  /** 主题 id：内置 dark/light，或自定义主题的文件名（不含 .json） */
  id: string;
  name: string;
  /** light = color-scheme 与原生控件（滚动条/表单）转浅色 */
  appearance: ThemeAppearance;
  /** 内置主题不可编辑/删除 */
  builtin?: boolean;
  colors: ThemeColors;
  terminal: TerminalColors;
}

/** 列表/事件里下发的轻量元信息 */
export interface ThemeMetaInfo {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  builtin: boolean;
  /** 列表色卡预览：面板底 + 主文字 + 强调色（取自主题 colors） */
  preview: { bg: string; ink: string; accent: string };
}

export interface ThemeListView {
  activeId: string;
  active: WorkbenchTheme;
  themes: ThemeMetaInfo[];
  /** 自定义主题 JSON 所在目录（打开文件夹用） */
  dir: string;
  /** 全局默认主题 id（config.themeId；工作区未设独立主题时即生效主题） */
  globalThemeId: string;
  /** 当前工作区的独立主题 id；未设置（跟随全局）或主题已失效时为 undefined */
  workspaceThemeId?: string;
  /** 活跃工作区（生效主题按它解析） */
  activeWorkspaceId?: string;
  activeWorkspaceName?: string;
}

/** themes:changed 推送载荷 */
export interface ThemesChangedPayload {
  activeId: string;
  active: WorkbenchTheme;
  themes: ThemeMetaInfo[];
  globalThemeId: string;
  workspaceThemeId?: string;
  activeWorkspaceId?: string;
  activeWorkspaceName?: string;
}

/** themes.activate 的作用域：缺省 global 改全局默认；workspace 只改指定/当前工作区 */
export interface ThemeActivateOptions {
  scope?: 'global' | 'workspace';
  /** scope=workspace 时可指定其他已打开工作区，缺省当前活跃工作区 */
  workspaceId?: string;
  /** scope=workspace 且为 true：清除该工作区独立主题，回到跟随全局（忽略 id） */
  followGlobal?: boolean;
}

/* ---------- 内置深色（= base.css :root + terminalTheme() 原值，改动需双向同步） ---------- */

const BUILTIN_DARK_THEME: WorkbenchTheme = {
  id: 'dark',
  name: '深色（默认）',
  appearance: 'dark',
  builtin: true,
  colors: {
    'bg-frame': '#202023',
    'bg-canvas': '#141416',
    'bg-panel': '#141416',
    'bg-raised': '#232326',
    'bg-overlay': '#262629',
    'bg-input': '#161618',
    ink: '#ededee',
    'ink-soft': '#d9d9dc',
    'text-2': '#a3a3a8',
    'text-3': '#98989d',
    hairline: '#2a2a2d',
    green: '#45d0a0',
    yellow: '#e8c65a',
    red: '#f3687b',
    blue: '#6cc2ff',
    purple: '#a88fff',
    'syn-fg': '#c9d1d9',
    'syn-muted': '#8b949e',
    'syn-blue': '#8ac6ff',
    'syn-cyan': '#a5d8ff',
    'syn-red': '#f88b9a',
    'syn-purple': '#c3b1ff',
    'syn-orange': '#ffb37d',
    'syn-yellow': '#e8d47c',
    'hover-fill': 'rgba(255, 255, 255, 0.05)',
    'hover-fill-strong': 'rgba(255, 255, 255, 0.09)',
    'selected-fill': 'rgba(255, 255, 255, 0.08)',
    'shadow-card':
      '0 0 0 1px rgba(255, 255, 255, 0.06), 0 2px 6px rgba(0, 0, 0, 0.35), 0 16px 40px rgba(0, 0, 0, 0.28)',
    'shadow-page': '0 1px 4px rgba(0, 0, 0, 0.4)',
    'shadow-input': 'none',
    'shadow-pop': '0 0 0 1px rgba(255, 255, 255, 0.08), 0 20px 56px rgba(0, 0, 0, 0.6)',
    'skel-a': 'rgba(255, 255, 255, 0.04)',
    'skel-b': 'rgba(255, 255, 255, 0.09)',
    'scroll-thumb': '#3a3a3e',
    'scroll-thumb-hover': '#4c4c52',
    scrim: 'rgba(0, 0, 0, 0.45)'
  },
  terminal: {
    background: '#141416',
    foreground: '#ededee',
    cursor: '#fafafa',
    cursorAccent: '#141416',
    selectionBackground: '#3f3f45',
    selectionInactiveBackground: '#313136',
    black: '#141416',
    red: '#f3687b',
    green: '#45d0a0',
    yellow: '#e8c65a',
    blue: '#8ac6ff',
    magenta: '#b39dff',
    cyan: '#67e8f9',
    white: '#ededee',
    brightBlack: '#74747a',
    brightRed: '#f88b9a',
    brightGreen: '#5fd8ab',
    brightYellow: '#e6cf7d',
    brightBlue: '#d4d4d8',
    brightMagenta: '#d49cff',
    brightCyan: '#a5f3fc',
    brightWhite: '#fafafa'
  }
};

/* ---------- 内置浅色（背景/文字保持纯中性灰；状态与语法色取 GitHub Light 档） ---------- */

const BUILTIN_LIGHT_THEME: WorkbenchTheme = {
  id: 'light',
  name: '浅色',
  appearance: 'light',
  builtin: true,
  colors: {
    'bg-frame': '#f0f3f9',
    'bg-canvas': '#f7f7f5',
    'bg-panel': '#ffffff',
    'bg-raised': '#f7f7f5',
    'bg-overlay': '#ffffff',
    'bg-input': '#f2f3f5',
    ink: '#2f2e2b',
    'ink-soft': '#45443f',
    'text-2': '#55534f',
    'text-3': '#64625d',
    hairline: '#e3e2dd',
    green: '#18704f',
    yellow: '#795800',
    red: '#b52e47',
    blue: '#2464a4',
    purple: '#6843ba',
    'syn-fg': '#242424',
    'syn-muted': '#6e7781',
    'syn-blue': '#0a5fae',
    'syn-cyan': '#1b7c83',
    'syn-red': '#a41238',
    'syn-purple': '#7654e0',
    'syn-orange': '#9c4a00',
    'syn-yellow': '#8a6d1d',
    'hover-fill': 'rgba(20, 18, 10, 0.045)',
    'hover-fill-strong': 'rgba(20, 18, 10, 0.08)',
    'selected-fill': 'rgba(20, 18, 10, 0.06)',
    'shadow-card':
      '0 0 0 1px rgba(20, 18, 10, 0.06), 0 1px 3px rgba(20, 18, 10, 0.06), 0 12px 32px rgba(20, 18, 10, 0.08)',
    'shadow-page': '0 1px 4px rgba(0, 0, 0, 0.4)',
    'shadow-input': '0 2px 8px rgba(20, 24, 34, 0.04)',
    'shadow-pop': '0 0 0 1px rgba(20, 18, 10, 0.08), 0 20px 56px rgba(20, 18, 10, 0.18)',
    'skel-a': 'rgba(20, 18, 10, 0.05)',
    'skel-b': 'rgba(20, 18, 10, 0.1)',
    'scroll-thumb': '#cfcdc6',
    'scroll-thumb-hover': '#b3b1aa',
    scrim: 'rgba(20, 18, 10, 0.18)'
  },
  terminal: {
    background: '#f7f7f5',
    foreground: '#2f2e2b',
    cursor: '#2f2e2b',
    cursorAccent: '#f7f7f5',
    selectionBackground: '#add6ff',
    selectionInactiveBackground: '#dfdfdf',
    black: '#242424',
    red: '#cf2246',
    green: '#106b4b',
    yellow: '#4d2d00',
    blue: '#0a5fae',
    magenta: '#7654e0',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a41238',
    brightGreen: '#0e7a52',
    brightYellow: '#633c01',
    brightBlue: '#0a6fc2',
    brightMagenta: '#6143c9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f'
  }
};

export const BUILTIN_THEMES: WorkbenchTheme[] = [BUILTIN_DARK_THEME, BUILTIN_LIGHT_THEME];

export function builtinTheme(id: string): WorkbenchTheme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

/** 同外观的内置主题（残缺字段回填基准：dark 主题缺项回深色，light 回浅色） */
function fallbackFor(appearance: ThemeAppearance): WorkbenchTheme {
  return appearance === 'light' ? BUILTIN_LIGHT_THEME : BUILTIN_DARK_THEME;
}

/* ---------- 校验与规整 ---------- */

const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 允许 #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba()（值会写进 CSS 变量，收窄防注入） */
const COLOR_VALUE_RE =
  /^#[0-9a-fA-F]{3,4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$|^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+%?\s*|\/\s*[\d.]+%?\s*)?\)$/;

/** 阴影 token 是完整 box-shadow 值：逗号分隔的多段「偏移(可含无单位 0) + 颜色」 */
const SHADOW_LEN = String.raw`(?:0(?:\.\d+)?|[-+]?\d*\.?\d+px)`;
const SHADOW_COLOR = String.raw`(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\([^()]+\))`;
const SHADOW_PART_RE = new RegExp(
  `^(?:inset\\s+)?${SHADOW_LEN}(?:\\s+${SHADOW_LEN}){0,3}\\s+${SHADOW_COLOR}$`
);
const SHADOW_VALUE_KEYS = new Set(['shadow-card', 'shadow-page', 'shadow-input', 'shadow-pop']);

/** 按顶层逗号分段（忽略 rgba(...) 内部的逗号） */
function splitShadowParts(v: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function isValidThemeValue(key: string, value: string): boolean {
  const v = value.trim();
  if (SHADOW_VALUE_KEYS.has(key)) {
    if (v === 'none') return true;
    const parts = splitShadowParts(v);
    return parts.length > 0 && parts.every((part) => SHADOW_PART_RE.test(part));
  }
  return COLOR_VALUE_RE.test(v) && parseCssColor(v) !== null;
}

export interface ThemeParseResult {
  ok: boolean;
  theme?: WorkbenchTheme;
  errors: string[];
}

/**
 * 校验并规整主题对象（自定义主题 JSON 的唯一入口）。
 * 缺失的颜色键按同外观内置主题回填，未知字段/非法色值报错（帮用户抓 JSON 手误）。
 */
export function parseTheme(
  raw: unknown,
  opts?: { id?: string; requireId?: boolean }
): ThemeParseResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [t('主题必须是 JSON 对象')] };
  }
  const obj = raw as Record<string, unknown>;

  let id = typeof opts?.id === 'string' ? opts.id : '';
  if (!id && typeof obj.id === 'string') id = obj.id.trim().toLowerCase();
  if (!id && opts?.requireId) errors.push(t('缺少主题 id'));
  else if (id && !THEME_ID_RE.test(id)) {
    errors.push(t('id "{{id}}" 不合法（只允许小写字母/数字/连字符，≤64 字符）', { id }));
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) errors.push(t('name 必须是非空字符串（主题显示名）'));

  let appearance: ThemeAppearance = 'dark';
  if (obj.appearance === undefined) {
    appearance = 'dark';
  } else if (obj.appearance === 'dark' || obj.appearance === 'light') {
    appearance = obj.appearance;
  } else {
    errors.push(
      t('appearance 只能是 "dark" 或 "light"，当前为 {{value}}', {
        value: JSON.stringify(obj.appearance)
      })
    );
  }

  const collect = (
    section: 'colors' | 'terminal',
    knownKeys: readonly string[]
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    const src = obj[section];
    if (src === undefined) return out;
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      errors.push(t('{{section}} 必须是对象', { section }));
      return out;
    }
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (!knownKeys.includes(k)) {
        errors.push(t('{{section}} 存在未知字段 "{{key}}"（拼写错误或已废弃）', { section, key: k }));
        continue;
      }
      if (typeof v !== 'string' || !isValidThemeValue(k, v)) {
        errors.push(
          t(
            '{{section}}."{{key}}" 的值 {{value}} 不合法（支持 #hex / rgb() / rgba()；阴影 token 支持多段 box-shadow）',
            { section, key: k, value: JSON.stringify(v) }
          )
        );
        continue;
      }
      const parsedColor = parseCssColor(v);
      const alphaAllowed = themeColorAllowsAlpha(section, k);
      if (parsedColor && parsedColor.a < 1 && !alphaAllowed) {
        errors.push(t('{{section}}."{{key}}" 必须不透明；透明度只用于材质或交互叠层', { section, key: k }));
        continue;
      }
      out[k] = v.trim();
    }
    return out;
  };

  const colors = collect('colors', THEME_COLOR_KEYS);
  const terminal = collect('terminal', TERMINAL_COLOR_KEYS);

  if (errors.length > 0) return { ok: false, errors };

  const base = fallbackFor(appearance);
  const theme: WorkbenchTheme = {
    id: id || name,
    name,
    appearance,
    colors: { ...base.colors, ...colors },
    terminal: { ...base.terminal, ...terminal }
  };
  return { ok: true, theme, errors: [] };
}

/** 主题 JSON 落盘文本：固定键序 + 2 空格缩进 + 结尾换行（id 由文件名承载，不写入） */
export function formatThemeJson(theme: WorkbenchTheme): string {
  const pick = (src: Record<string, string>, keys: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of keys) out[k] = src[k];
    return out;
  };
  const ordered = {
    name: theme.name,
    appearance: theme.appearance,
    colors: pick(theme.colors, THEME_COLOR_KEYS),
    terminal: pick(theme.terminal, TERMINAL_COLOR_KEYS)
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 从主题名推导文件 id：取 ASCII 母数字段，无则 theme；冲突时追加 -2/-3 */
export function slugifyThemeId(name: string, existing: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'theme';
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/* ---------- 颜色解析/格式化（色盘 UI 与预览共用） ---------- */

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 解析 #hex（3/4/6/8 位）与 rgb()/rgba()；不认识返回 null */
export function parseCssColor(v: string): RgbaColor | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = s.match(/^#([0-9a-fA-F]{8})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: Math.round(((n & 255) / 255) * 1000) / 1000 };
  }
  m = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m) {
    return {
      r: parseInt(m[1][0] + m[1][0], 16),
      g: parseInt(m[1][1] + m[1][1], 16),
      b: parseInt(m[1][2] + m[1][2], 16),
      a: 1
    };
  }
  m = s.match(/^#([0-9a-fA-F]{4})$/);
  if (m) {
    return {
      r: parseInt(m[1][0] + m[1][0], 16),
      g: parseInt(m[1][1] + m[1][1], 16),
      b: parseInt(m[1][2] + m[1][2], 16),
      a: Math.round((parseInt(m[1][3] + m[1][3], 16) / 255) * 1000) / 1000
    };
  }
  m = s.match(
    /^rgba?\(\s*(\d*\.?\d+)(%?)\s*,\s*(\d*\.?\d+)(%?)\s*,\s*(\d*\.?\d+)(%?)\s*(?:,\s*(\d*\.?\d+)(%?)\s*)?\)$/
  );
  if (m) {
    // A2-8-1：% 后缀按 CSS 语义折算——通道 v*255/100、alpha v/100（此前捕获了
    // % 却按无单位数值用，rgb(100%,0%,0%) 会被解析成 r=100）
    const c = (vi: number): number => {
      const v = parseFloat(m![vi]);
      const chan = m![vi + 1] === '%' ? (v * 255) / 100 : v;
      return Math.min(255, Math.max(0, Math.round(chan)));
    };
    const aRaw = m[7] !== undefined ? parseFloat(m[7]) : 1;
    const a = m[8] === '%' ? aRaw / 100 : aRaw;
    return {
      r: c(1),
      g: c(3),
      b: c(5),
      a: Math.min(1, Math.max(0, a))
    };
  }
  return null;
}

/** a>=1 输出 #rrggbb，否则 rgba(r, g, b, a)（a 保留 3 位小数） */
export function formatCssColor(c: RgbaColor): string {
  const r = Math.min(255, Math.max(0, Math.round(c.r)));
  const g = Math.min(255, Math.max(0, Math.round(c.g)));
  const b = Math.min(255, Math.max(0, Math.round(c.b)));
  const a = Math.min(1, Math.max(0, c.a));
  const hex = [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (a >= 0.999) return `#${hex}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/* ---------- 色盘 UI 分组元数据（设置页与 Agent 工具描述共用口径） ---------- */

export interface ThemeUiColorItem {
  key: string;
  label: string;
}

export interface ThemeUiGroup {
  id: string;
  label: string;
  section: 'colors' | 'terminal';
  /** 折叠态初始值（低频组默认收起） */
  collapsed?: boolean;
  keys: ThemeUiColorItem[];
}

/**
 * 色盘编辑器分组。故意不含 shadow-card / shadow-page / shadow-input / shadow-pop（完整 box-shadow 多段值，
 * 非单色，留给 JSON 文件手改）；其余 THEME_COLOR_KEYS 每键恰出现一次。
 */
export const THEME_UI_GROUPS: ThemeUiGroup[] = [
  {
    id: 'bg',
    label: '背景海拔',
    section: 'colors',
    keys: [
      { key: 'bg-frame', label: '框（窗口底/顶栏/左栏）' },
      { key: 'bg-canvas', label: '画布底（终端/编辑器）' },
      { key: 'bg-panel', label: '页（中栏/工具页）' },
      { key: 'bg-raised', label: '卡片浮起' },
      { key: 'bg-overlay', label: '浮层（菜单/弹窗）' },
      { key: 'bg-input', label: '输入框' }
    ]
  },
  {
    id: 'text',
    label: '文字与描边',
    section: 'colors',
    keys: [
      { key: 'ink', label: '主文字' },
      { key: 'ink-soft', label: '主文字（次亮）' },
      { key: 'text-2', label: '二级文字' },
      { key: 'text-3', label: '三级文字/占位' },
      { key: 'hairline', label: '描边/分隔线' }
    ]
  },
  {
    id: 'status',
    label: '状态色',
    section: 'colors',
    keys: [
      { key: 'green', label: '成功/完成' },
      { key: 'yellow', label: '等待/注意' },
      { key: 'red', label: '错误/危险' },
      { key: 'blue', label: '进行中/信息' },
      { key: 'purple', label: '特殊态' }
    ]
  },
  {
    id: 'syn',
    label: '语法高亮（代码内容）',
    section: 'colors',
    collapsed: true,
    keys: [
      { key: 'syn-fg', label: '代码正文' },
      { key: 'syn-muted', label: '注释/弱化' },
      { key: 'syn-blue', label: '蓝（关键字）' },
      { key: 'syn-cyan', label: '青（字符串）' },
      { key: 'syn-red', label: '红（删除）' },
      { key: 'syn-purple', label: '紫' },
      { key: 'syn-orange', label: '橙（数字）' },
      { key: 'syn-yellow', label: '黄（警告）' }
    ]
  },
  {
    id: 'overlay',
    label: '交互叠层与遮罩',
    section: 'colors',
    collapsed: true,
    keys: [
      { key: 'hover-fill', label: '悬停叠层' },
      { key: 'hover-fill-strong', label: '悬停叠层（强）' },
      { key: 'selected-fill', label: '选中叠层' },
      { key: 'scrim', label: '弹窗遮罩' },
      { key: 'skel-a', label: '骨架屏 A' },
      { key: 'skel-b', label: '骨架屏 B' }
    ]
  },
  {
    id: 'scroll',
    label: '滚动条',
    section: 'colors',
    collapsed: true,
    keys: [
      { key: 'scroll-thumb', label: '滑块' },
      { key: 'scroll-thumb-hover', label: '滑块（悬停）' }
    ]
  },
  {
    id: 'terminal',
    label: '终端配色（xterm）',
    section: 'terminal',
    collapsed: true,
    keys: [
      { key: 'background', label: '终端底色' },
      { key: 'foreground', label: '终端前景' },
      { key: 'cursor', label: '光标' },
      { key: 'cursorAccent', label: '光标反色' },
      { key: 'selectionBackground', label: '选区' },
      { key: 'selectionInactiveBackground', label: '选区（未聚焦）' },
      { key: 'black', label: 'ANSI black' },
      { key: 'red', label: 'ANSI red' },
      { key: 'green', label: 'ANSI green' },
      { key: 'yellow', label: 'ANSI yellow' },
      { key: 'blue', label: 'ANSI blue' },
      { key: 'magenta', label: 'ANSI magenta' },
      { key: 'cyan', label: 'ANSI cyan' },
      { key: 'white', label: 'ANSI white' },
      { key: 'brightBlack', label: 'ANSI bright black' },
      { key: 'brightRed', label: 'ANSI bright red' },
      { key: 'brightGreen', label: 'ANSI bright green' },
      { key: 'brightYellow', label: 'ANSI bright yellow' },
      { key: 'brightBlue', label: 'ANSI bright blue' },
      { key: 'brightMagenta', label: 'ANSI bright magenta' },
      { key: 'brightCyan', label: 'ANSI bright cyan' },
      { key: 'brightWhite', label: 'ANSI bright white' }
    ]
  }
];
