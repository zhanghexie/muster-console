/**
 * 界面字体设置（渲染层）：locale / panelGlow / userAvatar 同款三段式。
 * 1. 模块态默认 OPPO Sans + 标准档（与 AppConfig 缺省、base.css 默认值一致）；
 * 2. main.tsx 启动时 initUiFont()：config.get() 校正；
 * 3. 设置「外观 → 字体」切换走 setUiFont()（本地立即生效 + config:update 落盘）。
 * 生效机制：:root 内联 CSS 变量覆盖（--font-sans / --font-mono / 七个 --font-* 字阶），
 * 与 applyTheme 同通道；标准档/默认字体 = removeProperty 回落 CSS 默认（单源在 base.css）。
 */
import {
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SCALE,
  UI_FONT_SCALES,
  parseUiFontId,
  parseUiFontScale,
  uiFontMonoStack,
  uiFontSansStack,
  uiFontTerminalStack,
  type UiFontId,
  type UiFontScale
} from '../../shared/appearanceFonts';

export interface UiFontState {
  font: UiFontId;
  scale: UiFontScale;
}

const listeners = new Set<() => void>();
let current: UiFontState = { font: DEFAULT_UI_FONT, scale: DEFAULT_UI_FONT_SCALE };

/**
 * 可选字体的 CSS 源：选中该字体时才注入 <link>（启动零外部请求，不在首屏关键路径上；
 * CSS 内的 woff2 仍按 unicode-range 分包按需下载）。OPPO Sans 无 CSS API，其 @font-face
 * 常驻 base.css 顶部（默认字体随首屏就绪）；system 无需注册。
 */
const FONT_CSS_URLS: Partial<Record<UiFontId, string[]>> = {
  misans: [
    'https://cdn-font.hyperos.mi.com/font/css?family=MiSans:0:Chinese_Simplify,Latin&display=swap'
  ],
  harmonyos: [
    'https://cdn.jsdelivr.net/npm/harmonyos-sans-webfont-splitted@1.2.1/dist/HarmonyOS_Sans_SC/Regular.css',
    'https://cdn.jsdelivr.net/npm/harmonyos-sans-webfont-splitted@1.2.1/dist/HarmonyOS_Sans_SC/Medium.css',
    'https://cdn.jsdelivr.net/npm/harmonyos-sans-webfont-splitted@1.2.1/dist/HarmonyOS_Sans_SC/Bold.css'
  ]
};

const injectedFontCss = new Set<string>();

/** 扩展 iframe 与宿主共用字体资源；返回副本，不允许外部修改注册表。 */
export function getUiFontStylesheets(): string[] {
  return [...(FONT_CSS_URLS[current.font] ?? [])];
}

/** 幂等注入字体 CSS；加载失败移出已注入集合，下次选中可重试；失败即静默回退系统栈 */
function ensureFontCss(id: UiFontId): void {
  if (typeof document === 'undefined') return;
  for (const url of FONT_CSS_URLS[id] ?? []) {
    if (injectedFontCss.has(url)) continue;
    injectedFontCss.add(url);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.addEventListener('error', () => {
      injectedFontCss.delete(url);
      link.remove(); // 死节点不留在 head，重试时重新挂
    });
    document.head.appendChild(link);
  }
}

export function getUiFont(): UiFontState {
  return current;
}

export function subscribeUiFont(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** 终端字体栈（xterm 只收具体字体名）：固定纯等宽、不随界面字体设置（比例 UI 字体会被
 * xterm 按 'W' 撑列宽、按行盒撑行高，见 appearanceFonts.ts）；已开终端不热更，新终端生效 */
export function getTerminalFontFamily(): string {
  return uiFontTerminalStack();
}

/** 把当前设置写到 :root 内联变量（默认档回落 CSS 默认，保持 base.css 单源） */
function applyToDom(state: UiFontState): void {
  const root = document.documentElement;
  if (state.font === DEFAULT_UI_FONT) {
    root.style.removeProperty('--font-sans');
    root.style.removeProperty('--font-mono');
  } else {
    root.style.setProperty('--font-sans', uiFontSansStack(state.font));
    root.style.setProperty('--font-mono', uiFontMonoStack(state.font));
  }
  const tokens = UI_FONT_SCALES[state.scale];
  for (const [key, px] of Object.entries(tokens)) {
    if (state.scale === DEFAULT_UI_FONT_SCALE) root.style.removeProperty(`--font-${key}`);
    else root.style.setProperty(`--font-${key}`, `${px}px`);
  }
}

function apply(next: UiFontState): void {
  const changed = current.font !== next.font || current.scale !== next.scale;
  current = next;
  applyToDom(next);
  ensureFontCss(next.font);
  if (changed) for (const fn of listeners) fn();
}

/** 设置「外观」页切换：本地立即生效 + 落盘（不随设置表单草稿回写） */
export function setUiFont(next: UiFontState): void {
  apply(next);
  try {
    void window.api.config.update({ uiFont: next.font, uiFontScale: next.scale }).catch(() => {
      /* 落盘失败保持本地态（与 panelGlow 同口径） */
    });
  } catch {
    /* 单测 / 主进程不可达 */
  }
}

/** main.tsx 启动调用：主进程配置为准校正 */
export function initUiFont(): void {
  // 先按模块默认刷一次（幂等，防 CSS 与运行时漂移）
  applyToDom(current);
  try {
    void window.api.config
      .get()
      .then((cfg) => {
        apply({
          font: parseUiFontId(cfg?.uiFont),
          scale: parseUiFontScale(cfg?.uiFontScale)
        });
      })
      .catch(() => {
        /* 保持默认 */
      });
  } catch {
    /* ignore */
  }
}

/** 测试用：只写内存态并刷 DOM，不落盘 */
export function resetUiFontForTest(next: UiFontState = { font: DEFAULT_UI_FONT, scale: DEFAULT_UI_FONT_SCALE }): void {
  apply(next);
}
