/**
 * 纯色背景与原生窗口外观联动：纯色会铺到顶栏，Windows 窗口按钮区（titleBarOverlay 只能单色）
 * 须同步成同一色；浅底时顶栏文字与按钮符号切深色（html.fb-light-surface，chrome.css）。
 * 工作区主题色关闭时复位为主题的框色（与 theme.ts 下发同源）。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  LIGHT_SURFACE_LUMINANCE,
  relativeLuminance,
  SOLID_LEVELS,
  type FrameBackdropChoice
} from '../../shared/frameBackdrop';
import { getTheme, subscribeTheme } from './theme';
import { syncWindowChrome } from './windowChrome';

const LIGHT_CLASS = 'fb-light-surface';
const DARK_INK = '#111112';

/** 任意 CSS 颜色 → sRGB（借 canvas 解析，与界面渲染同一套色彩规则）；解析不了返回 null */
export function cssColorToRgb(css: string): { r: number; g: number; b: number } | null {
  try {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  } catch {
    return null;
  }
}

const hex = (n: number) => n.toString(16).padStart(2, '0');

/** 纯色档的实际底色（#rrggbb）；算不出时返回 null */
export function solidBackdropHex(accent: string, frame: string, level: FrameBackdropChoice['solidLevel']): string | null {
  const k = SOLID_LEVELS[level ?? 'deep'];
  const rgb = cssColorToRgb(`color-mix(in oklab, ${accent} ${k}%, ${frame})`);
  return rgb ? `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}` : null;
}

let themeVersion = 0;
const bumpTheme = (fn: () => void) =>
  subscribeTheme(() => {
    themeVersion++;
    fn();
  });

export function useFrameBackdropChrome(choice: FrameBackdropChoice, accent: string, frameFxOn: boolean): void {
  const tv = useSyncExternalStore(bumpTheme, () => themeVersion);
  const wasSolid = useRef(false);
  const solid = frameFxOn && choice.id === 'solid';
  const level = choice.solidLevel;

  useEffect(() => {
    const theme = getTheme();
    const frame = theme.colors['bg-frame'];
    const ink = theme.colors['ink'];
    const root = document.documentElement;
    if (solid) {
      const color = solidBackdropHex(accent, frame, level);
      const rgb = color ? cssColorToRgb(color) : null;
      const light = !!rgb && relativeLuminance(rgb.r, rgb.g, rgb.b) > LIGHT_SURFACE_LUMINANCE;
      root.classList.toggle(LIGHT_CLASS, light);
      wasSolid.current = true;
      if (color) {
        void syncWindowChrome({ panel: color, ink: light ? DARK_INK : ink, appearance: theme.appearance });
      }
      return;
    }
    root.classList.remove(LIGHT_CLASS);
    if (!wasSolid.current) return;
    wasSolid.current = false;
    void syncWindowChrome({ panel: frame, ink, appearance: theme.appearance });
  }, [solid, level, accent, tv]);
}
