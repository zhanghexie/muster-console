/**
 * 界面字体设置（主/渲染/共享纯函数，无 DOM 依赖）：
 * - 字体族四档：OPPO Sans（默认）/ MiSans / HarmonyOS Sans / 系统默认；
 * - 字号三档：紧凑 / 标准 / 宽松——整体平移 base.css 字阶 token。
 * 字体文件注册在 renderer（base.css @font-face + uiFont.ts 按选中字体注入 CSS link），这里只管栈映射与解析。
 */

export type UiFontId = 'oppo' | 'misans' | 'harmonyos' | 'system';
export type UiFontScale = 'compact' | 'standard' | 'comfortable';

export const DEFAULT_UI_FONT: UiFontId = 'oppo';
export const DEFAULT_UI_FONT_SCALE: UiFontScale = 'standard';

/** 各字体的中文族名（system = 不指定，交给系统回落） */
const FONT_FAMILY_NAME: Record<Exclude<UiFontId, 'system'>, string> = {
  oppo: 'OPPO Sans',
  misans: 'MiSans',
  harmonyos: 'HarmonyOS Sans SC'
};

/** 比例栈（--font-sans）：首选字体 + 系统回落链 */
export function uiFontSansStack(id: UiFontId): string {
  const fallback = "Geist, Inter, 'Segoe UI', 'Microsoft YaHei', sans-serif";
  return id === 'system' ? fallback : `'${FONT_FAMILY_NAME[id]}', ${fallback}`;
}

/** 等宽栈（--font-mono，编辑器/代码块等 UI 场景）：西文等宽不变，中文回落随字体设置 */
export function uiFontMonoStack(id: UiFontId): string {
  const west = "'Cascadia Mono', 'Cascadia Code', Consolas";
  const tail = "'Courier New', monospace";
  return id === 'system'
    ? `${west}, ${tail}`
    : `${west}, '${FONT_FAMILY_NAME[id]}', ${tail}`;
}

/**
 * 终端字体栈（xterm 只收双引号具体字体名）：固定纯等宽、不随界面字体设置。
 * UI 字体都是比例字体，xterm 按栈内命中字体的度量定网格（'W' 宽定列宽、
 * fontBoundingBox 定行高），比例字体会把列宽撑到最宽字形、行盒撑到 UI 行高，
 * 横竖间隙显著大于等宽字体；中文交系统兜底（与「跟随系统」档一致）。
 */
export function uiFontTerminalStack(): string {
  return uiFontMonoStack('system').replace(/'/g, '"');
}

export function parseUiFontId(raw: unknown): UiFontId {
  return raw === 'misans' || raw === 'harmonyos' || raw === 'system' || raw === 'oppo'
    ? raw
    : DEFAULT_UI_FONT;
}

export function parseUiFontScale(raw: unknown): UiFontScale {
  return raw === 'compact' || raw === 'comfortable' || raw === 'standard'
    ? raw
    : DEFAULT_UI_FONT_SCALE;
}

/** 三档字阶（对应 base.css 七个 --font-* token 的 px 值；standard 与 CSS 默认一致） */
export const UI_FONT_SCALES: Record<
  UiFontScale,
  { micro: number; caption: number; ui: number; control: number; body: number; title: number; head: number }
> = {
  compact: { micro: 10, caption: 11, ui: 12, control: 13, body: 14, title: 16, head: 19 },
  standard: { micro: 10, caption: 12, ui: 13, control: 14, body: 15, title: 17, head: 20 },
  comfortable: { micro: 11, caption: 13, ui: 14, control: 15, body: 16, title: 18, head: 21 }
};
