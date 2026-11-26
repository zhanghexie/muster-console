import type { Terminal } from '@xterm/xterm';

/** 按实际屏幕尺寸映射到 xterm 可见缓冲；宽字符的尾格不是空白。 */
export function isBlankTerminalCell(term: Pick<Terminal, 'cols' | 'rows' | 'buffer'>,
  screen: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = screen.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0 && term.cols > 0 && term.rows > 0) ||
      clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return false;
  const col = Math.floor((clientX - rect.left) * term.cols / rect.width);
  const row = Math.floor((clientY - rect.top) * term.rows / rect.height);
  const buffer = term.buffer.active;
  const cell = buffer.getLine(buffer.viewportY + row)?.getCell(col);
  return !!cell && cell.getWidth() > 0 && cell.getChars().trim() === '';
}
