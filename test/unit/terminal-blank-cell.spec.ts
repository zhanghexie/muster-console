import type { Terminal } from '@xterm/xterm';
import { expect, it, vi } from 'vitest';
import { isBlankTerminalCell } from '../../src/renderer/src/terminal/blankCell';

it('仅把可见缓冲中的空白字符格视为空白，缩放和宽字符尾格不误判', () => {
  const screen = document.createElement('div');
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, right: 300, bottom: 150,
    width: 200, height: 100, x: 100, y: 50, toJSON: () => ({}) } as DOMRect);
  const cells = [
    [{ getChars: () => '', getWidth: () => 1 }, { getChars: () => '字', getWidth: () => 2 },
      { getChars: () => '', getWidth: () => 0 }, { getChars: () => ' ', getWidth: () => 1 }],
    [{ getChars: () => 'x', getWidth: () => 1 }, { getChars: () => '', getWidth: () => 1 },
      { getChars: () => '', getWidth: () => 1 }, { getChars: () => '', getWidth: () => 1 }]
  ];
  const term = { cols: 4, rows: 2, buffer: { active: { viewportY: 3,
    getLine: (row: number) => cells[row - 3] ? { getCell: (col: number) => cells[row - 3]?.[col] } : undefined
  } } } as unknown as Pick<Terminal, 'cols' | 'rows' | 'buffer'>;
  expect(isBlankTerminalCell(term, screen, 125, 75)).toBe(true);
  expect(isBlankTerminalCell(term, screen, 175, 75)).toBe(false);
  expect(isBlankTerminalCell(term, screen, 225, 75)).toBe(false);
  expect(isBlankTerminalCell(term, screen, 275, 75)).toBe(true);
  expect(isBlankTerminalCell(term, screen, 125, 125)).toBe(false);
  expect(isBlankTerminalCell(term, screen, 175, 125)).toBe(true);
  expect(isBlankTerminalCell(term, screen, 300, 75)).toBe(false);
});
