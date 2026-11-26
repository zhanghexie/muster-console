import type { Terminal } from '@xterm/xterm';
import { scanEntityRanges, type ScanBufferRow, type ScanEntity } from '../../../shared/terminalScan';
import { resolvePathCandidate } from '../../../shared/terminalSelectionText';
import type { ScanHitView } from '../components/TerminalScanOverlay';

export function readViewportLines(term: Terminal): ScanBufferRow[] {
  const buf = term.buffer.active;
  const lines: ScanBufferRow[] = [];
  let first = buf.viewportY;
  let last = Math.min(buf.length, buf.viewportY + term.rows);
  // 补齐视口上下沿切开的逻辑行；高亮阶段仅保留可见片段。
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  while (last < buf.length && buf.getLine(last)?.isWrapped) last++;
  for (let i = first; i < last; i++) {
    const line = buf.getLine(i);
    const continued = i + 1 < last && !!buf.getLine(i + 1)?.isWrapped;
    lines.push({
      text: line ? line.translateToString(!continued) : '',
      isWrapped: !!line?.isWrapped,
      row: i - buf.viewportY
    });
  }
  return lines;
}

type BufferLineLike = {
  length: number;
  getCell: (col: number) => { getWidth(): number; getChars(): string } | undefined;
};

/**
 * translateToString 的 UTF-16 下标 → 终端列。
 * 中日韩等宽字符占 2 列，不能再用「下标 ≈ 列」。
 */
function mapStringRangeToCols(
  line: BufferLineLike,
  start: number,
  end: number
): { col0: number; col1: number } {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(a, Math.max(start, end));
  let strPos = 0;
  let col0 = -1;
  for (let col = 0; col < line.length; col++) {
    const cell = line.getCell(col);
    if (!cell || cell.getWidth() === 0) continue;
    const len = Math.max(1, cell.getChars().length);
    const next = strPos + len;
    if (col0 < 0 && next > a) col0 = col;
    if (col0 >= 0 && next >= b) {
      return { col0, col1: col + cell.getWidth() };
    }
    strPos = next;
  }
  if (col0 < 0) col0 = 0;
  return { col0, col1: Math.max(col0 + 1, strPos > 0 ? line.length : 1) };
}

/** 按终端列算像素框（宽字符正确） */
export function entitiesToHits(
  term: Terminal,
  entities: ScanEntity[],
  cellW: number,
  cellH: number,
  origin: { x: number; y: number },
  cwd?: string
): ScanHitView[] {
  const buf = term.buffer.active;
  return entities.map((e, i) => {
    // file/dir 的 pathText 经 filterEntitiesByStat 已回填为最长存在前缀；url 仅在
    // localhost 映射命中本地文件时带 absPath（菜单追加「在文件区预览/资源管理器」）
    const abs =
      e.kind === 'url'
        ? e.absPath ?? undefined
        : resolvePathCandidate(e.pathText ?? e.text, cwd) ?? undefined;
    const rects = scanEntityRanges(e)
      .filter((r) => r.row >= 0 && r.row < term.rows)
      .map((r) => {
        const bl = buf.getLine(buf.viewportY + r.row) as BufferLineLike | undefined;
        const { col0, col1 } = bl
          ? mapStringRangeToCols(bl, r.start, r.end)
          : { col0: r.start, col1: r.end };
        return {
          left: origin.x + col0 * cellW,
          top: origin.y + r.row * cellH,
          width: Math.max(cellW, (col1 - col0) * cellW),
          height: cellH
        };
      });
    return {
      id: `${e.row}:${e.start}:${i}`,
      kind: e.kind,
      text: e.text,
      absPath: abs,
      line: e.line,
      col: e.col,
      rects
    };
  }).filter((hit) => hit.rects.length > 0);
}
