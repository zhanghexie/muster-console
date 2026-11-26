/** 从 xterm 单元格属性还原视觉背景色，给 Fit 余量垫色（跟当前 TUI 底色，而非默认 theme）。 */

export type TerminalPadTheme = {
  background: string;
  foreground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type CellVisualBgSample = {
  inverse: boolean;
  bgDefault: boolean;
  bgRgb: boolean;
  bgPalette: boolean;
  bg: number;
  fgDefault: boolean;
  fgRgb: boolean;
  fgPalette: boolean;
  fg: number;
};

export function rgbToCss(rgb: number): string {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

const THEME_ANSI16: (keyof TerminalPadTheme)[] = [
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
];

/** xterm 256 色：0–15 走 theme；16–231 立方；232–255 灰阶。 */
export function ansi256ToCss(index: number, theme?: TerminalPadTheme): string {
  const i = Math.max(0, Math.min(255, index | 0));
  if (i < 16) {
    if (theme) return theme[THEME_ANSI16[i]] || rgbToCss(0);
    return rgbToCss(0);
  }
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return rgbToCss((v << 16) | (v << 8) | v);
  }
  const c = i - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const to = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return rgbToCss((to(r) << 16) | (to(g) << 8) | to(b));
}

function channelCss(
  isDefault: boolean,
  isRgb: boolean,
  isPalette: boolean,
  value: number,
  theme: TerminalPadTheme,
  fallback: string
): string {
  if (isDefault) return fallback;
  if (isRgb) return rgbToCss(value);
  if (isPalette) return ansi256ToCss(value, theme);
  return fallback;
}

/** 单格视觉前景（处理 inverse）。 */
export function cssFromCellVisualFg(sample: CellVisualBgSample, theme: TerminalPadTheme): string {
  if (sample.inverse) {
    return channelCss(
      sample.bgDefault,
      sample.bgRgb,
      sample.bgPalette,
      sample.bg,
      theme,
      theme.background
    );
  }
  return channelCss(
    sample.fgDefault,
    sample.fgRgb,
    sample.fgPalette,
    sample.fg,
    theme,
    theme.foreground
  );
}

/** 单格视觉背景（处理 inverse）。 */
export function cssFromCellVisualBg(sample: CellVisualBgSample, theme: TerminalPadTheme): string {
  if (sample.inverse) {
    return channelCss(
      sample.fgDefault,
      sample.fgRgb,
      sample.fgPalette,
      sample.fg,
      theme,
      theme.foreground
    );
  }
  return channelCss(
    sample.bgDefault,
    sample.bgRgb,
    sample.bgPalette,
    sample.bg,
    theme,
    theme.background
  );
}

/** 多数票；平票时优先非默认色（TUI 铺底）。 */
export function majorityPadCss(
  samples: CellVisualBgSample[],
  theme: TerminalPadTheme,
  fallback: string
): string {
  if (!samples.length) return fallback;
  const counts = new Map<string, number>();
  for (const s of samples) {
    const css = cssFromCellVisualBg(s, theme);
    counts.set(css, (counts.get(css) ?? 0) + 1);
  }
  let best = fallback;
  let bestN = -1;
  for (const [css, n] of counts) {
    if (n > bestN) {
      best = css;
      bestN = n;
      continue;
    }
    if (n === bestN && css !== fallback && best === fallback) {
      best = css;
    }
  }
  return best;
}

/**
 * 右缘垫条宽度：从字符网格右缘量到 terminal-wrap 右缘——含 fit 余量与 wrap 右内边距，
 * 两段都跟右缘 TUI 色；只量到 container 右缘时右内边距会露出底部取色。
 */
export function padSideWidth(wrapRight: number, screenRight: number): number {
  return Math.max(0, Math.round(wrapRight - screenRight));
}
