/**
 * 全局 Tooltip 进出场：
 * - 移出后退场能播放（DOM 保留且 data-mp-stage=out，到时卸载）——曾因 `if (!tip) return null`
 *   退场阶段直接不渲染，退场动画永远不播；
 * - 热身：刚因移出隐藏后扫到相邻目标，0 延迟出现且挂 is-instant（不重播入场）；
 *   超出热身窗口 / 点击打断后恢复常规悬停延迟。
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { TooltipHost } from '../../src/renderer/src/components/Tooltip';
import { MOTION } from '../../src/renderer/src/components/motion';

function Harness() {
  return (
    <>
      <TooltipHost />
      <button data-testid="a" title="提示 A">A</button>
      <button data-testid="b" title="提示 B">B</button>
      <span data-testid="gap">gap</span>
    </>
  );
}

const tipEl = () => document.querySelector<HTMLElement>('.app-tooltip');

function hover(el: Element): void {
  fireEvent.mouseOver(el);
}

function leave(el: Element, to: Element): void {
  fireEvent.mouseOut(el, { relatedTarget: to });
}

describe('TooltipHost 进出场', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('移出后保留 DOM 播退场（stage=out，内容冻结），退场时长过后才卸载', () => {
    const { getByTestId } = render(<Harness />);
    const a = getByTestId('a');
    hover(a);
    act(() => { vi.advanceTimersByTime(350); });
    expect(tipEl()?.textContent).toBe('提示 A');
    expect(tipEl()?.dataset.mpStage).toBe('in');

    leave(a, getByTestId('gap'));
    expect(tipEl()).toBeTruthy();
    expect(tipEl()?.dataset.mpStage).toBe('out');
    expect(tipEl()?.textContent).toBe('提示 A');

    act(() => { vi.advanceTimersByTime(MOTION.microMs + 80); });
    expect(tipEl()).toBeNull();
  });

  it('热身窗口内扫到相邻按钮：0 延迟出现、挂 is-instant', () => {
    const { getByTestId } = render(<Harness />);
    const a = getByTestId('a');
    const b = getByTestId('b');
    hover(a);
    act(() => { vi.advanceTimersByTime(350); });
    expect(tipEl()?.classList.contains('is-instant')).toBe(false);

    leave(a, b);
    hover(b);
    expect(tipEl()?.textContent).toBe('提示 B');
    expect(tipEl()?.dataset.mpStage).toBe('in');
    expect(tipEl()?.classList.contains('is-instant')).toBe(true);
  });

  it('超出热身窗口后恢复常规悬停延迟', () => {
    const { getByTestId } = render(<Harness />);
    const a = getByTestId('a');
    const b = getByTestId('b');
    hover(a);
    act(() => { vi.advanceTimersByTime(350); });
    leave(a, getByTestId('gap'));
    act(() => { vi.advanceTimersByTime(400); });
    expect(tipEl()).toBeNull();

    hover(b);
    expect(tipEl()).toBeNull();
    act(() => { vi.advanceTimersByTime(350); });
    expect(tipEl()?.textContent).toBe('提示 B');
    expect(tipEl()?.classList.contains('is-instant')).toBe(false);
  });

  it('点击打断隐藏不开热身窗口', () => {
    const { getByTestId } = render(<Harness />);
    const a = getByTestId('a');
    const b = getByTestId('b');
    hover(a);
    act(() => { vi.advanceTimersByTime(350); });
    fireEvent.mouseDown(a);
    leave(a, b);
    hover(b);
    expect(tipEl()?.dataset.mpStage).not.toBe('in');
  });

  it('dismisses a focused tooltip on Escape without consuming the key or moving focus', () => {
    const { getByTestId } = render(<Harness />);
    const a = getByTestId('a');
    act(() => a.focus());
    act(() => vi.advanceTimersByTime(80));
    expect(tipEl()?.textContent).toBe('提示 A');

    expect(fireEvent.keyDown(a, { key: 'Escape', isComposing: true })).toBe(true);
    expect(tipEl()?.dataset.mpStage).toBe('in');
    expect(fireEvent.keyDown(a, { key: 'Escape' })).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(tipEl()?.dataset.mpStage).toBe('out');
    expect(a.getAttribute('title')).toBeNull();

    act(() => getByTestId('b').focus());
    expect(a.getAttribute('title')).toBe('提示 A');
    act(() => vi.advanceTimersByTime(80));
    expect(tipEl()?.textContent).toBe('提示 B');
  });

  it('cancels a pending hover tooltip on Escape until the pointer leaves the trigger', () => {
    const { getByTestId } = render(<Harness />);
    const a = getByTestId('a');
    hover(a);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    hover(a);
    act(() => vi.advanceTimersByTime(350));
    expect(tipEl()).toBeNull();
    expect(a.getAttribute('title')).toBeNull();

    leave(a, getByTestId('gap'));
    expect(a.getAttribute('title')).toBe('提示 A');
    hover(a);
    act(() => vi.advanceTimersByTime(350));
    expect(tipEl()?.textContent).toBe('提示 A');
  });
});


it('native picker descriptions use a manual top-layer tooltip; ordinary tooltips keep their portal', () => {
  vi.useFakeTimers();
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover');
  const open = new WeakSet<Element>();
  const show = vi.fn(function(this: HTMLElement) { open.add(this); });
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: show });
  const matches = Element.prototype.matches;
  const matchSpy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function(this: Element, selector: string) {
    return selector === ':popover-open' ? open.has(this) : matches.call(this, selector);
  });
  const select = document.createElement('select');
  select.className = 'c-select-native';
  const option = document.createElement('option');
  option.title = 'Read only'; option.textContent = 'Safe'; select.append(option); document.body.append(select);
  try {
    const view = render(<Harness />);
    hover(option);
    act(() => { vi.advanceTimersByTime(350); });
    expect(tipEl()?.getAttribute('popover')).toBe('manual');
    expect(show).toHaveBeenCalledOnce();
    expect(tipEl()?.style.margin).toBe('0px');
    leave(option, view.getByTestId('a')); hover(view.getByTestId('a'));
    act(() => { vi.advanceTimersByTime(350); });
    expect(tipEl()?.hasAttribute('popover')).toBe(false);
    expect(show).toHaveBeenCalledOnce();
    view.unmount();
  } finally {
    select.remove(); matchSpy.mockRestore();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'showPopover', descriptor);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
    vi.useRealTimers();
  }
});
