/**
 * usePresence 进出场契约（动画规约的 JS 侧核心）：
 * enter 首帧提交 → 同帧强制样式后切 in 起播、out 延迟卸载、退场中重开回弹且不打断成卸载。
 * usePresenceValue：退场期冻结最后一个非空值。
 * 时长常量与 base.css --dur-* 对齐（MOTION，test/motion-token-sync.mjs 守），改一处必须同步另一处。
 */
import React, { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  usePresence,
  usePresenceValue,
  MOTION
} from '../../src/renderer/src/components/motion';
import { initInteractionPreferences, setInteractionPreferences } from '../../src/renderer/src/interactionPreferences';

let stagesSeen: string[] = [];

function Probe({ exitMs = MOTION.exitMs }: { exitMs?: number }) {
  const [open, setOpen] = useState(true);
  const p = usePresence(open, exitMs);
  stagesSeen.push(p.stage);
  return (
    <div>
      <button data-testid="toggle" onClick={() => setOpen((v) => !v)}>
        toggle
      </button>
      <button data-testid="open" onClick={() => setOpen(true)}>
        open
      </button>
      <div data-testid="stage" data-mounted={p.mounted ? '1' : '0'}>
        {p.stage}
      </div>
    </div>
  );
}

const stageOf = () => screen.getByTestId('stage').textContent;
const mountedOf = () => screen.getByTestId('stage').dataset.mounted;

describe('usePresence 进出场', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stagesSeen = [];
    setInteractionPreferences({ scrollFeel: 'native', scrollDistance: 1, motion: 'system' });
  });
  afterEach(() => {
    act(() => setInteractionPreferences({ motion: 'system' }));
    vi.useRealTimers();
  });

  it('open 先以 enter 提交一次，再在同一帧内切 in（不靠定时器，不丢首帧起始态）', () => {
    render(<Probe />);
    expect(mountedOf()).toBe('1');
    expect(stagesSeen[0]).toBe('enter');
    expect(stageOf()).toBe('in');
  });

  it('close 进 out，exitMs+80 兜底后才卸载', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('toggle'));

    expect(stageOf()).toBe('out');
    expect(mountedOf()).toBe('1');

    act(() => { vi.advanceTimersByTime(MOTION.exitMs + 80); });
    expect(mountedOf()).toBe('0');
  });

  it('卸载后重开：重新走 enter → in', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('toggle'));
    act(() => { vi.advanceTimersByTime(MOTION.exitMs + 80); });
    expect(mountedOf()).toBe('0');

    stagesSeen = [];
    fireEvent.click(screen.getByTestId('open'));
    expect(stagesSeen).toContain('enter');
    expect(stagesSeen.indexOf('enter')).toBeLessThan(stagesSeen.lastIndexOf('in'));
    expect(stageOf()).toBe('in');
  });

  it('退场中重开：stage 回弹到 in，卸载定时器被取消不误卸载', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('toggle')); // 进 out
    expect(stageOf()).toBe('out');

    act(() => { vi.advanceTimersByTime(100); }); // 退场中途
    stagesSeen = [];
    fireEvent.click(screen.getByTestId('open')); // 重开 → 回弹
    expect(stageOf()).toBe('in');
    expect(stagesSeen).not.toContain('enter');
    expect(mountedOf()).toBe('1');

    // 原卸载时刻已过：不应被残留定时器卸掉
    act(() => { vi.advanceTimersByTime(MOTION.exitMs + 200); });
    expect(mountedOf()).toBe('1');
    expect(stageOf()).toBe('in');
  });

  it('用户减少动效即时进出场，不读布局或等待卸载兜底', () => {
    setInteractionPreferences({ motion: 'reduced' });
    const measure = vi.spyOn(document.body, 'offsetWidth', 'get');
    render(<Probe />);
    expect(stageOf()).toBe('in');
    expect(measure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('toggle'));
    expect(mountedOf()).toBe('0');
    expect(vi.getTimerCount()).toBe(0);
    measure.mockRestore();
  });

  it('退场期间切到减少，立即取消兜底；再开不会被旧计时器误卸载', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('toggle'));
    expect(stageOf()).toBe('out');
    act(() => setInteractionPreferences({ motion: 'reduced' }));
    expect(mountedOf()).toBe('0');
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByTestId('open'));
    expect(stageOf()).toBe('in');
    act(() => vi.advanceTimersByTime(MOTION.exitMs + 100));
    expect(mountedOf()).toBe('1');
  });

  it('系统减少动态效果变化也能结束正在进行的退场', () => {
    // Reinitialize the singleton against a controllable real MediaQueryList contract.
    initInteractionPreferences()();
    let reduced = false;
    let change: (() => void) | undefined;
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return reduced; },
      addEventListener: (_: string, fn: () => void) => { change = fn; },
      removeEventListener: () => {}
    })));
    const stop = initInteractionPreferences();
    try {
      render(<Probe />);
      fireEvent.click(screen.getByTestId('toggle'));
      expect(stageOf()).toBe('out');
      reduced = true;
      act(() => change?.());
      expect(mountedOf()).toBe('0');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });
});

function ValueProbe() {
  const [value, setValue] = useState<string | null>('A');
  const { presence, value: shown } = usePresenceValue(value);
  return (
    <div>
      <button data-testid="set-b" onClick={() => setValue('B')}>b</button>
      <button data-testid="clear" onClick={() => setValue(null)}>clear</button>
      <div data-testid="val" data-stage={presence.stage} data-mounted={presence.mounted ? '1' : '0'}>
        {shown ?? ''}
      </div>
    </div>
  );
}

describe('usePresenceValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('非空→非空只换内容不重播；置空后退场期冻结最后一个值，卸载后清空', () => {
    render(<ValueProbe />);
    const el = () => screen.getByTestId('val');
    expect(el().textContent).toBe('A');
    expect(el().dataset.stage).toBe('in');

    fireEvent.click(screen.getByTestId('set-b'));
    expect(el().textContent).toBe('B');
    expect(el().dataset.stage).toBe('in');

    fireEvent.click(screen.getByTestId('clear'));
    expect(el().dataset.stage).toBe('out');
    expect(el().textContent).toBe('B');

    act(() => { vi.advanceTimersByTime(MOTION.exitMs + 80); });
    expect(el().dataset.mounted).toBe('0');
    expect(el().textContent).toBe('');
  });
});
