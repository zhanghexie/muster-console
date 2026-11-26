import React, { useRef, useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CENTER_SNAP_LAYOUTS, deriveCenterSplitSnapLayout,
  type CenterPaneSlot, type SplitPaneRef
} from '../../src/shared/centerSplit';
import { CenterSnapBar, type CenterSnapBarProps } from '../../src/renderer/src/components/CenterSnapBar';
import { MOTION, usePresence } from '../../src/renderer/src/components/motion';

const a: SplitPaneRef = { kind: 'session', sessionId: 'chat-a' };
const b: SplitPaneRef = { kind: 'session', sessionId: 'terminal-b' };
const c: SplitPaneRef = { kind: 'utility', sel: 'tasks' };
const empty: SplitPaneRef = { kind: 'empty' };

function props(refs: SplitPaneRef[] = [a, b], source: CenterPaneSlot = 0): CenterSnapBarProps {
  return {
    currentRefs: refs, sourceRef: refs[source], target: null,
    previewFor: target => deriveCenterSplitSnapLayout(refs[0], {
      open: refs.length > 1, secondary: refs[1] ?? empty, tertiary: refs[2],
      layoutId: refs.length === 3 ? 'thirds' : undefined, dir: 'row', ratio: .5
    }, source, target),
    labelFor: ref => ref.kind === 'session' ? ref.sessionId === 'chat-a' ? '对话 A' : '终端 B'
      : ref.kind === 'utility' ? '定时任务' : '空面板',
    iconFor: ref => ref.kind === 'session' ? ref.sessionId === 'terminal-b' ? 'terminal' : 'chat' : 'tool',
    presenceSpread: { 'data-mp-stage': 'in' },
    onPreview: vi.fn(), onSelect: vi.fn(), onDismiss: vi.fn()
  };
}
const cell = (layout: string, index: number) => screen.getByTestId(`center-snap-cell-${layout}-${index}`) as HTMLButtonElement;

afterEach(() => { vi.useRealTimers(); });

describe('中央 Windows 式 Snap 顶部条', () => {
  it('只提供最多三格的六个共享预设，并保留 normalized cell 几何和命中数据', () => {
    render(<CenterSnapBar {...props()} />);
    const bar = screen.getByRole('toolbar', { name: '选择分屏布局' });
    expect(bar.classList.contains('mp-pop')).toBe(true);
    expect(bar.getAttribute('data-mp-stage')).toBe('in');
    expect(within(bar).getAllByRole('group')).toHaveLength(6);
    for (const layout of CENTER_SNAP_LAYOUTS) for (const [index, rect] of layout.cells.entries()) {
      const target = cell(layout.id, index);
      expect(target.getAttribute('data-center-snap-layout')).toBe(layout.id);
      expect(target.getAttribute('data-center-snap-index')).toBe(String(index));
      expect(Number.parseFloat(target.style.left)).toBeCloseTo(rect.x * 100);
      expect(Number.parseFloat(target.style.top)).toBeCloseTo(rect.y * 100);
      expect(Number.parseFloat(target.style.width)).toBeCloseTo(rect.width * 100);
      expect(Number.parseFloat(target.style.height)).toBeCloseTo(rect.height * 100);
    }
    expect(screen.queryByTestId('center-snap-cell-quad-0')).toBeNull();
  });

  it('缩略格只显示引用类型图标与名称 tooltip，不复制正文', () => {
    render(<CenterSnapBar {...props()} />);
    expect(cell('halves', 0).getAttribute('data-snap-ref-id')).toBe('chat-a');
    expect(cell('halves', 1).getAttribute('data-snap-ref-id')).toBe('terminal-b');
    expect(cell('halves', 1).getAttribute('data-tooltip')).toBe('终端 B');
    expect(cell('halves', 1).querySelector('.center-snap-ref-icon svg')).not.toBeNull();
    expect(cell('halves', 0).classList.contains('is-source')).toBe(true);
    expect(cell('halves', 1).classList.contains('is-occupied')).toBe(true);
    expect(screen.getByTestId('center-snap-bar').querySelector('textarea')).toBeNull();
  });

  it('候选 order 按逻辑引用映射到实际格，主内容不随 source 挪格被误替换', () => {
    const options = props([a, b], 1);
    render(<CenterSnapBar {...options} target={{ layoutId: 'thirds', index: 2 }} />);
    expect(cell('thirds', 2).getAttribute('data-snap-ref-id')).toBe('terminal-b');
    expect(cell('thirds', 2).classList.contains('is-source')).toBe(true);
    expect(cell('thirds', 2).getAttribute('aria-pressed')).toBe('true');
    expect(cell('thirds', 0).getAttribute('data-snap-ref-id')).toBe('chat-a');
    expect(cell('thirds', 1).getAttribute('data-snap-ref-kind')).toBe('empty');
    expect(options.currentRefs).toEqual([a, b]);
  });

  it('同预设没有 hover 时源图标沿原 physical order，显式新落点才覆盖它', () => {
    const options = props([a, b, c]);
    options.previewFor = target => deriveCenterSplitSnapLayout(a, {
      open: true, secondary: b, tertiary: c, layoutId: 'thirds', order: [2, 0, 1], dir: 'row', ratio: .5
    }, 0, target);
    const view = render(<CenterSnapBar {...options} />);
    expect(cell('thirds', 2).getAttribute('data-snap-ref-id')).toBe('chat-a');
    expect(cell('thirds', 2).classList.contains('is-source')).toBe(true);
    expect(cell('thirds', 0).getAttribute('data-snap-ref-id')).toBe('terminal-b');
    expect(cell('thirds', 1).getAttribute('data-snap-ref-id')).toBe('tasks');
    view.rerender(<CenterSnapBar {...options} target={{ layoutId: 'thirds', index: 0 }} />);
    expect(cell('thirds', 0).getAttribute('data-snap-ref-id')).toBe('chat-a');
    expect(cell('thirds', 0).getAttribute('aria-pressed')).toBe('true');
  });

  it('指针进入只预览，离开清候选，点击才选择具体格', () => {
    const options = props();
    render(<CenterSnapBar {...options} />);
    fireEvent.pointerOver(cell('focus', 2));
    expect(options.onPreview).toHaveBeenLastCalledWith({ layoutId: 'focus', index: 2 });
    expect(options.onSelect).not.toHaveBeenCalled();
    fireEvent.pointerOut(cell('focus', 2), { relatedTarget: screen.getByTestId('center-snap-bar') });
    expect(options.onPreview).toHaveBeenLastCalledWith(null);
    fireEvent.pointerOut(screen.getByTestId('center-snap-bar'), { relatedTarget: document.body });
    expect(options.onPreview).toHaveBeenLastCalledWith(null);
    fireEvent.click(cell('focus', 2));
    expect(options.onSelect).toHaveBeenCalledExactlyOnceWith({ layoutId: 'focus', index: 2 });
  });

  it('三个已占用引用会禁用所有两格预设，不通过选择丢弃任何内容', () => {
    const options = props([a, b, c]);
    render(<CenterSnapBar {...options} />);
    for (const id of ['halves', 'wide', 'stack']) {
      expect(cell(id, 0).disabled).toBe(true);
      expect(cell(id, 0).tabIndex).toBe(-1);
      expect(cell(id, 0).getAttribute('data-tooltip')).toBe('此布局无法保留所有已打开面板');
      fireEvent.pointerOver(cell(id, 0)); fireEvent.click(cell(id, 0));
    }
    expect(options.onPreview).not.toHaveBeenCalled();
    expect(options.onSelect).not.toHaveBeenCalled();
    expect(cell('focus', 0).disabled).toBe(false);
    expect(cell('thirds', 0).disabled).toBe(false);
    expect(options.currentRefs).toEqual([a, b, c]);
  });

  it('Tab 一次进入，方向/Home/End 循环格子，Space/Enter 选择当前格', async () => {
    const user = userEvent.setup(), options = props();
    render(<CenterSnapBar {...options} />);
    await user.tab();
    expect(document.activeElement).toBe(cell('halves', 0));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(cell('halves', 1));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(cell('wide', 0));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(cell('thirds', 2));
    await user.keyboard('{Home} ');
    expect(options.onSelect).toHaveBeenLastCalledWith({ layoutId: 'halves', index: 0 });
    await user.keyboard('{ArrowLeft}{Enter}');
    expect(options.onSelect).toHaveBeenLastCalledWith({ layoutId: 'thirds', index: 2 });
  });

  it('方向导航跳过容量不足的全部预设', async () => {
    const user = userEvent.setup();
    render(<CenterSnapBar {...props([a, b, c])} />);
    await user.tab();
    expect(document.activeElement).toBe(cell('focus', 0));
    await user.keyboard('{End}{ArrowRight}');
    expect(document.activeElement).toBe(cell('focus', 0));
  });

  it('Escape 清候选并交父控制器关闭与恢复把手焦点', async () => {
    const user = userEvent.setup(), options = props();
    function Harness(): React.JSX.Element {
      const trigger = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(true);
      return <><button ref={trigger}>原面板把手</button>{open && <CenterSnapBar {...options} onDismiss={() => {
        options.onDismiss(); setOpen(false); trigger.current?.focus();
      }} />}</>;
    }
    render(<Harness />);
    act(() => { cell('halves', 0).focus(); });
    await user.keyboard('{Escape}');
    expect(options.onPreview).toHaveBeenLastCalledWith(null);
    expect(options.onDismiss).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '原面板把手' }));
    expect(screen.queryByTestId('center-snap-bar')).toBeNull();
  });

  it('父 presence 退场时惯性内容不可选，退场反转复用原格 DOM', () => {
    vi.useFakeTimers();
    const options = props();
    function Harness({ open }: { open: boolean }): React.JSX.Element | null {
      const presence = usePresence(open, MOTION.microMs);
      return presence.mounted ? <CenterSnapBar {...options} presenceSpread={presence.spread} /> : null;
    }
    const view = render(<Harness open />), original = cell('halves', 0);
    view.rerender(<Harness open={false} />);
    expect(screen.getByTestId('center-snap-bar').hasAttribute('inert')).toBe(true);
    expect(original.disabled).toBe(true);
    fireEvent.click(original);
    expect(options.onSelect).not.toHaveBeenCalled();
    view.rerender(<Harness open />);
    expect(cell('halves', 0)).toBe(original);
    expect(screen.getByTestId('center-snap-bar').hasAttribute('inert')).toBe(false);
    expect(original.disabled).toBe(false);
    view.rerender(<Harness open={false} />);
    act(() => { vi.advanceTimersByTime(MOTION.microMs + 80); });
    expect(screen.queryByTestId('center-snap-bar')).toBeNull();
  });
});
