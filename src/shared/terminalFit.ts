/**
 * FitAddon 按整行向下取整；底部余量用主题背景垫齐，不拉高 lineHeight，也不裁剪内容。
 */

export const TERMINAL_BASE_LINE_HEIGHT = 1.2;

/** 在不超出 availH 的前提下，能放下的整行数（floor）。 */
export function rowsFittingHeight(availH: number, cellH: number): number {
  if (!(availH > 0) || !(cellH > 0)) return 0;
  return Math.max(0, Math.floor(availH / cellH));
}

/** 整行网格下方可露出的垫高（px），供背景色填充。 */
export function verticalPadPx(availH: number, rows: number, cellH: number): number {
  if (!(availH > 0)) return 0;
  if (!(rows > 0) || !(cellH > 0)) return availH;
  return Math.max(0, availH - rows * cellH);
}

/** 若当前 rows 已高于容器，降到可完整放下的行数（至少保留原 rows 与可容纳行数的较小者）。 */
export function clampRowsToHeight(rows: number, availH: number, cellH: number): number {
  if (!(rows > 0)) return 0;
  const fit = rowsFittingHeight(availH, cellH);
  if (!(fit > 0)) return rows;
  return Math.min(rows, fit);
}
