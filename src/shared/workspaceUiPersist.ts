/**
 * 工作区 UI 持久化字段的解析 / 夹紧（渲染层与单测共用）。
 * 盘上坏值一律回落默认，不抛。
 */

export type HDockPage = 'terminal' | 'git';
export type HiddenView = 'exclude' | 'include' | 'only';

export const FILES_SPLIT_RATIO_DEFAULT = 0.28;
export const GIT_REPO_SPLIT_RATIO_DEFAULT = 0.28;
export const SPLIT_RATIO_MIN = 0.15;
export const SPLIT_RATIO_MAX = 0.85;

export function parseHDock(v: unknown): HDockPage {
  return v === 'git' ? 'git' : 'terminal';
}

/**
 * 视觉当前页：
 * - 专注布局强制终端页（Git 已并肩可见，hDock 恒 terminal）；
 * - 虚拟屏关闭时只能停在终端页（Git 页宽为 0，停在 git 会让快捷键/激活态错位）；
 * - 其余用盘上值。
 * 手机表面走 MobileApp，不消费本字段。
 */
export function visualHDock(opts: {
  stored: unknown;
  hVirtualScreen: boolean;
  focusMode: boolean;
}): HDockPage {
  if (opts.focusMode || !opts.hVirtualScreen) return 'terminal';
  return parseHDock(opts.stored);
}

export function parseHiddenView(v: unknown): HiddenView {
  return v === 'include' || v === 'only' ? v : 'exclude';
}

/** 眼睛左键：exclude ↔ include（only 视为「已显示」一侧，回到 exclude） */
export function cycleHiddenViewExcludeInclude(v: HiddenView): HiddenView {
  return v === 'exclude' ? 'include' : 'exclude';
}

/** 右键菜单「只显示隐藏的」：only ↔ include */
export function toggleHiddenViewOnly(v: HiddenView): HiddenView {
  return v === 'only' ? 'include' : 'only';
}

export function clampSplitRatio(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, n));
}
