/**
 * SplitPane 松手 / 键盘才 onRatioCommit（拖动过程不落盘）。
 * 自查：把 onPointerUp 里的 commit 去掉，松手用例应转红。
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { SplitPane } from '../../src/renderer/src/components/SplitPane';
import { SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '../../src/shared/workspaceUiPersist';

function Harness({
  onRatioCommit,
  primaryRatio
}: {
  onRatioCommit: (ratio: number) => void;
  primaryRatio?: number;
}): React.JSX.Element {
  return (
    <SplitPane
      axis="row"
      defaultPrimaryRatio={0.28}
      primaryRatio={primaryRatio}
      onRatioCommit={onRatioCommit}
      minPrimary={80}
      minSecondary={80}
      aria-label="调整分割"
    >
      <div>主栏</div>
      <div>次栏</div>
    </SplitPane>
  );
}

function mockRect(el: HTMLElement, width = 1006, height = 400): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({})
  } as DOMRect);
}

describe('SplitPane 松手再提交', () => {
  it('拖动过程不 commit，松手才上抛夹紧后的占比', () => {
    const onRatioCommit = vi.fn();
    const { container } = render(<Harness onRatioCommit={onRatioCommit} />);
    const body = container.querySelector('.split-pane') as HTMLElement;
    const handle = screen.getByRole('separator', { name: '调整分割' });
    mockRect(body, 1006);

    fireEvent.pointerDown(handle, { clientX: 400, clientY: 10, pointerId: 1 });
    expect(onRatioCommit).not.toHaveBeenCalled();
    fireEvent.pointerMove(handle, { clientX: 500, clientY: 10, pointerId: 1 });
    expect(onRatioCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { clientX: 500, clientY: 10, pointerId: 1 });
    // usable = 1006 - 6，raw=500 → 500/1000 = 0.5
    expect(onRatioCommit).toHaveBeenCalledTimes(1);
    expect(onRatioCommit).toHaveBeenCalledWith(0.5);
  });

  it('方向键 / Home / End 每次都 commit', () => {
    const onRatioCommit = vi.fn();
    render(<Harness onRatioCommit={onRatioCommit} primaryRatio={0.4} />);
    const handle = screen.getByRole('separator', { name: '调整分割' });

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onRatioCommit).toHaveBeenLastCalledWith(0.42);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onRatioCommit).toHaveBeenLastCalledWith(SPLIT_RATIO_MIN);
    fireEvent.keyDown(handle, { key: 'End' });
    expect(onRatioCommit).toHaveBeenLastCalledWith(SPLIT_RATIO_MAX);
  });

  it('外部 primaryRatio 变化时同步（切工作区），不在同步时 commit', () => {
    const onRatioCommit = vi.fn();
    const { rerender } = render(
      <Harness onRatioCommit={onRatioCommit} primaryRatio={0.28} />
    );
    rerender(<Harness onRatioCommit={onRatioCommit} primaryRatio={0.55} />);
    const handle = screen.getByRole('separator', { name: '调整分割' });
    expect(handle.getAttribute('aria-valuenow')).toBe('55');
    expect(onRatioCommit).not.toHaveBeenCalled();
  });

  it.each(['row', 'column'] as const)('%s 窄容器压缩最小尺寸并扣除手柄，扩宽恢复原比例且不回写偏好', axis => {
    let resized!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const commit = vi.fn();
    try {
      const view = render(<SplitPane axis={axis} primaryRatio={0.32} defaultPrimaryRatio={0.32}
        minPrimary={160} minSecondary={200} onRatioCommit={commit}><div>Changes</div><div>Diff</div></SplitPane>);
      const body = view.container.querySelector('.split-pane') as HTMLElement;
      const primary = view.container.querySelector('.split-pane-primary') as HTMLElement;
      const secondary = view.container.querySelector('.split-pane-secondary') as HTMLElement;
      const minKey = axis === 'row' ? 'minWidth' : 'minHeight';
      mockRect(body, 334, 334); act(() => resized());
      expect(Number.parseFloat(primary.style[minKey]) + Number.parseFloat(secondary.style[minKey])).toBeCloseTo(328);
      expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('44');
      expect(secondary.style.flexBasis).toContain('100% - 6px');
      mockRect(body, 1006, 1006); act(() => resized());
      expect(primary.style[minKey]).toBe('160px'); expect(secondary.style[minKey]).toBe('200px');
      expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('32');
      expect(commit).not.toHaveBeenCalled();
      view.unmount(); expect(disconnect).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});
