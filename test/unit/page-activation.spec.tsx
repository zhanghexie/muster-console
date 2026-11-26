import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePageActivation, type PageActivationOptions } from '../../src/renderer/src/hooks/usePageActivation';
import { dispatchPeekPointer } from '../../src/renderer/src/browserPointer';

const opts = vi.hoisted(() => ({ current: null as unknown as PageActivationOptions }));
const show = { terminal: vi.fn(), git: vi.fn() };
const clickHSwitch = vi.fn((alreadyThere: boolean, apply: () => void) => { if (!alreadyThere) apply(); });
const armHSwitch = vi.fn();
const clearHTimer = vi.fn();
const suppressUntil = { current: 0 };

/** 左页组件树持有一段内容，经 portal 渲染进右页 DOM（同固定到右侧 / 右侧扩展标签） */
function Strip({ hDock = 'terminal', narrow = false }: { hDock?: 'terminal' | 'git'; narrow?: boolean }) {
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [right, setRight] = useState<HTMLDivElement | null>(null);
  opts.current = { hDock, narrow, suppressUntil, clickHSwitch, armHSwitch, clearHTimer, show };
  usePageActivation(strip, opts.current);
  return <div ref={setStrip}>
    <div data-h-page="terminal" data-testid="left">
      <button data-testid="left-button" onClick={e => e.stopPropagation()}>左</button>
      {right ? createPortal(<div data-testid="docked">固定内容</div>, right) : null}
    </div>
    <div data-h-page="git" data-testid="right"><div ref={setRight} /><span data-testid="right-own">右</span></div>
  </div>;
}

beforeEach(() => { vi.clearAllMocks(); suppressUntil.current = 0; });

describe('虚拟屏切页按真实 DOM 判定', () => {
  it('点击 portal 到右屏的内容激活右屏，而不是其 React 父级所在的左屏', () => {
    render(<Strip />);
    fireEvent.click(screen.getByTestId('docked'));
    expect(show.git).toHaveBeenCalledTimes(1);
    expect(show.terminal).not.toHaveBeenCalled();
  });

  it('当前屏上的点击（含 React stopPropagation 的控件）无效，露条上的控件点击照常切屏', () => {
    const view = render(<Strip />);
    fireEvent.click(screen.getByTestId('left-button'));
    expect(clickHSwitch).toHaveBeenLastCalledWith(true, show.terminal);
    expect(show.terminal).not.toHaveBeenCalled();
    view.rerender(<Strip hDock="git" />);
    fireEvent.click(screen.getByTestId('left-button'));
    expect(show.terminal).toHaveBeenCalledTimes(1);
  });

  it('程序化切页后静默跟随 click，仍接受网页露条上一次新的按下', () => {
    render(<Strip />);
    suppressUntil.current = Date.now() + 10_000;
    fireEvent.click(screen.getByTestId('docked'));
    expect(clickHSwitch).not.toHaveBeenCalled();
    act(() => dispatchPeekPointer('down', screen.getByTestId('right-own')));
    expect(show.git).toHaveBeenCalledTimes(1);
  });

  it('悬停按 DOM 进出：进入 portal 内容即进入右屏，在右屏内部移动不清计时，离开两屏才清', () => {
    render(<Strip />);
    fireEvent.pointerOver(screen.getByTestId('docked'), { relatedTarget: screen.getByTestId('left-button') });
    expect(armHSwitch).toHaveBeenLastCalledWith(false, show.git);
    clearHTimer.mockClear();
    fireEvent.pointerOver(screen.getByTestId('right-own'), { relatedTarget: screen.getByTestId('docked') });
    fireEvent.pointerOut(screen.getByTestId('docked'), { relatedTarget: screen.getByTestId('right-own') });
    expect(armHSwitch).toHaveBeenCalledTimes(1);
    expect(clearHTimer).not.toHaveBeenCalled();
    fireEvent.pointerOut(screen.getByTestId('right-own'), { relatedTarget: document.body });
    expect(clearHTimer).toHaveBeenCalledTimes(1);
  });

  it('iframe / webview 覆盖层按自身所在屏转入同一入口；窄屏抽屉不响应', () => {
    const view = render(<Strip />);
    act(() => dispatchPeekPointer('move', screen.getByTestId('right-own')));
    expect(armHSwitch).toHaveBeenLastCalledWith(false, show.git);
    act(() => dispatchPeekPointer('down', screen.getByTestId('right-own')));
    expect(show.git).toHaveBeenCalledTimes(1);
    view.rerender(<Strip narrow />);
    act(() => dispatchPeekPointer('down', screen.getByTestId('right-own')));
    expect(show.git).toHaveBeenCalledTimes(1);
  });
});
