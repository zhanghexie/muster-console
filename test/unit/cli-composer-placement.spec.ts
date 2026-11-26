import { describe, expect, it } from 'vitest';
import {
  CLI_COMPOSER_INSET, clampCliComposerDimensions, clampCliComposerPoint, cliComposerDialogPlacement, parseCliComposerAnchor, parseCliComposerDimensions,
  pointForCliComposerAnchor, resizeCliComposerWidth, snapCliComposerPoint, type CliComposerSize
} from '../../src/renderer/src/components/cliComposerPlacement';

const size: CliComposerSize = { width: 800, height: 600, capsuleWidth: 120, capsuleHeight: 32, dialogHeight: 200 };

describe('CLI 输入胶囊贴边和展开位置', () => {
  it.each([
    [{ x: 12, y: 240 }, 'left'], [{ x: 668, y: 240 }, 'right'],
    [{ x: 300, y: 10 }, 'top'], [{ x: 300, y: 558 }, 'bottom']
  ] as const)('松手后贴最近的边：%s → %s', (point, edge) => {
    expect(snapCliComposerPoint(point, size).edge).toBe(edge);
  });

  it('拖出容器时限制在边界，改变面板尺寸时按边和相对位置恢复', () => {
    expect(clampCliComposerPoint({ x: -50, y: 900 }, size)).toEqual({ x: 8, y: 560 });
    const anchor = snapCliComposerPoint({ x: 12, y: 284 }, size);
    expect(anchor.edge).toBe('left');
    expect(anchor.fraction).toBeCloseTo(0.5);
    expect(pointForCliComposerAnchor(anchor, { ...size, width: 1200, height: 800 })).toEqual({ x: 8, y: 384 });
  });

  it('展开时以胶囊纵向中心为锚点，接近上下边缘时限制在面板内', () => {
    expect(cliComposerDialogPlacement({ x: 8, y: 250 }, size).top).toBe(166);
    expect(cliComposerDialogPlacement({ x: 8, y: 8 }, size).top).toBe(8);
    expect(cliComposerDialogPlacement({ x: 672, y: 560 }, size).top).toBe(392);
    expect(cliComposerDialogPlacement({ x: 8, y: 250 }, size).originY).toBe(50);
    expect(cliComposerDialogPlacement({ x: 8, y: 250 }, size).originX).toBe(0);
    expect(cliComposerDialogPlacement({ x: 672, y: 560 }, size).originX).toBe(100);
    expect(cliComposerDialogPlacement({ x: 672, y: 560 }, size).originY).toBe(100);
  });

  it.each([{ x: 8, y: 8 }, { x: 300, y: 250 }, { x: 672, y: 560 }])(
    '缩放起点与胶囊边缘重合：%s', point => {
      const placement = cliComposerDialogPlacement(point, size);
      const width = size.width - 2 * CLI_COMPOSER_INSET;
      const height = size.dialogHeight;
      // CSS 的 transform-origin 在未缩放的面板上；缩小后的外边框应与胶囊完整重合。
      const left = CLI_COMPOSER_INSET + width * placement.originX / 100 * (1 - placement.scaleX);
      const top = placement.top + height * placement.originY / 100 * (1 - placement.scaleY);
      expect(left).toBeCloseTo(point.x);
      expect(top).toBeCloseTo(point.y);
      expect(width * placement.scaleX).toBeCloseTo(size.capsuleWidth);
      expect(height * placement.scaleY).toBeCloseTo(size.capsuleHeight);
    }
  );

  it('异常的已保存位置回到默认值，越界比例被限制', () => {
    expect(parseCliComposerAnchor('{')).toEqual({ edge: 'right', fraction: 1 });
    expect(parseCliComposerAnchor('{"edge":"unknown","fraction":0.5}')).toEqual({ edge: 'right', fraction: 1 });
    expect(parseCliComposerAnchor('{"edge":"left","fraction":2}')).toEqual({ edge: 'left', fraction: 1 });
  });

  it('缩窄面板后，胶囊在面板左边或下方时仍从胶囊边缘开合', () => {
    const point = { x: 8, y: 400 };
    const resized = { ...size, dialogWidth: 400, dialogHeight: 240 };
    const placement = cliComposerDialogPlacement(point, resized, -80);
    expect(placement.left).toBe(392);
    const left = placement.left + resized.dialogWidth * placement.originX / 100 * (1 - placement.scaleX);
    const top = placement.top + resized.dialogHeight * placement.originY / 100 * (1 - placement.scaleY);
    expect(left).toBeCloseTo(point.x);
    expect(top).toBeCloseTo(point.y);
  });

  it('限制输入框宽度，窄窗口下保留有效边界', () => {
    expect(clampCliComposerDimensions({ width: 2, bottomOffset: 16, rightInset: 100 }, size))
      .toEqual({ width: 240, bottomOffset: 16, rightInset: 100 });
    expect(clampCliComposerDimensions({ width: 500, bottomOffset: 16, rightInset: 100 },
      { ...size, width: 180, height: 120 })).toEqual({ width: 164, bottomOffset: 16, rightInset: 0 });
  });

  it('左右边缘分别固定另一边，拖动范围限制在面板内', () => {
    const start = { width: 500, bottomOffset: 16, rightInset: 100 };
    expect(resizeCliComposerWidth(start, size, 'left', 40)).toEqual({ ...start, width: 460 });
    expect(resizeCliComposerWidth(start, size, 'right', -40)).toEqual({ ...start, width: 460, rightInset: 140 });
    expect(resizeCliComposerWidth(start, size, 'right', 1000)).toEqual({ ...start, width: 600, rightInset: 0 });
    expect(resizeCliComposerWidth(start, size, 'right', -1000)).toEqual({ ...start, width: 240, rightInset: 360 });
  });

  it('保留旧尺寸里的宽度与位置，但忽略旧固定高度', () => {
    expect(parseCliComposerDimensions('{"width":400,"height":260,"bottomOffset":16}'))
      .toEqual({ width: 400, bottomOffset: 16, rightInset: 0 });
    expect(parseCliComposerDimensions('{"width":400,"height":260,"bottomOffset":16,"rightInset":70}'))
      .toEqual({ width: 400, bottomOffset: 16, rightInset: 70 });
    expect(parseCliComposerDimensions('{"width":400,"bottomOffset":16,"rightInset":70}'))
      .toEqual({ width: 400, bottomOffset: 16, rightInset: 70 });
    expect(parseCliComposerDimensions('{"width":-1,"height":260,"bottomOffset":16}')).toBeNull();
    expect(parseCliComposerDimensions('{"width":400,"height":260}')).toBeNull();
    expect(parseCliComposerDimensions('{')).toBeNull();
  });
});
