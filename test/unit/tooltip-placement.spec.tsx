import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { TooltipHost } from '../../src/renderer/src/components/Tooltip';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
    toJSON: () => ({ left, top, width, height }) };
}

describe('TooltipHost 统一定位', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 600);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function show(anchor: DOMRect, size = rect(0, 0, 100, 30), focus = false, scale = 1) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('app-tooltip') ? rect(0, 0, size.width * scale, size.height * scale) : anchor;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(size.width);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(size.height);
    const view = render(<><TooltipHost /><button title="历史">历史按钮</button><button>相邻按钮</button></>);
    const button = view.getByText('历史按钮');
    if (focus) fireEvent.focusIn(button);
    else fireEvent.mouseOver(button);
    act(() => { vi.advanceTimersByTime(focus ? 80 : 350); });
    const tip = view.getByRole('tooltip');
    return { left: Number.parseFloat(tip.style.left), top: Number.parseFloat(tip.style.top) };
  }

  it('工具栏按钮上下都能容纳时优先上方，不盖同排相邻按钮', () => {
    const anchor = rect(260, 100, 28, 28);
    const tip = show(anchor);
    expect(tip).toEqual({ left: 224, top: 64 });
    expect(tip.top + 30).toBeLessThan(anchor.top);
  });

  it('键盘聚焦沿用上方优先规则', () => {
    expect(show(rect(260, 100, 28, 28), undefined, true)).toEqual({ left: 224, top: 64 });
  });

  it.each([0.98, 0.985])('入场或退场反转的 scale=%s 不影响测量尺寸与安全边距', (scale) => {
    expect(show(rect(764, 100, 28, 28), undefined, false, scale)).toEqual({ left: 692, top: 64 });
  });

  it('靠顶按钮上方不够时翻到下方', () => {
    expect(show(rect(260, 10, 28, 28))).toEqual({ left: 224, top: 44 });
  });

  it('靠底按钮保持在上方', () => {
    expect(show(rect(260, 562, 28, 28))).toEqual({ left: 224, top: 526 });
  });

  it.each([
    [8, 8],
    [764, 692]
  ])('靠横向边缘 x=%i 时平移回安全边距，保持上下位置', (x, expectedLeft) => {
    expect(show(rect(x, 100, 28, 28))).toEqual({ left: expectedLeft, top: 64 });
  });

  it('多行提示按实测高度判断上方是否足够', () => {
    expect(show(rect(260, 100, 28, 28), rect(0, 0, 200, 100))).toEqual({ left: 174, top: 134 });
  });

  it.each([[260, 294], [500, 394]])('上下都容纳不了时才用侧面，x=%i 向窗口内部放置', (x, left) => {
    expect(show(rect(x, 280, 28, 28), rect(0, 0, 100, 400))).toEqual({ left, top: 94 });
  });
});
