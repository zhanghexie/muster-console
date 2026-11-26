import { describe, expect, it } from 'vitest';
import { centerPaneEdgeAt, centerSnapRevealAt } from '../../src/renderer/src/hooks/useCenterPaneDrag';

describe('thumbnail edge contact', () => {
  it('顶部提示区展开，左右外部不展开，继续向上到顶边退出选择器', () => {
    const bar = { left: 120, top: 48, width: 560, height: 106 };
    expect(centerSnapRevealAt(800, 400, 18, false, bar)).toBe(true);
    expect(centerSnapRevealAt(800, 80, 18, false, bar)).toBe(false);
    expect(centerSnapRevealAt(800, 400, 100, true, bar)).toBe(true);
    expect(centerSnapRevealAt(800, 400, 4, true, bar)).toBe(false);
  });
  it.each([
    [{ left: 0, top: 80, width: 312, height: 468 }, 156, 92, 'left'],
    [{ left: 488, top: 80, width: 312, height: 468 }, 644, 92, 'right'],
    [{ left: 250, top: 0, width: 256, height: 192 }, 378, 5, 'fullscreen'],
    [{ left: 250, top: 132, width: 312, height: 468 }, 406, 145, 'close'],
    [{ left: 1, top: 1, width: 798, height: 598 }, 400, 300, null],
  ] as const)('contact uses card bounds: %s', (card, x, y, action) => {
    expect(centerPaneEdgeAt(card, 800, 600, x, y)).toBe(action);
  });
  it('outside pointer cancels; corners choose the contacted edge nearest the pointer', () => {
    const card = { left: -10, top: -10, width: 300, height: 400 };
    expect(centerPaneEdgeAt(card, 800, 600, -1, 10)).toBeNull();
    expect(centerPaneEdgeAt(card, 800, 600, 80, 2)).toBe('fullscreen');
    expect(centerPaneEdgeAt(card, 800, 600, 2, 80)).toBe('left');
  });
});
