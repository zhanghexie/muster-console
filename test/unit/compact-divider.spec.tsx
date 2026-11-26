/**
 * CompactDivider 两态与 presence 切换（动画规约）：
 * 进行中=通栏线 + 动态压缩图标 + 「正在压缩上下文」；
 * 完成=同位置 + IconClock + 「上下文已压缩」；
 * 切换走 usePresence + token（data-mp-stage），禁止 keyframes 进出场。
 * 运行: npx vitest run test/unit/compact-divider.spec.tsx
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { CompactDivider } from '../../src/renderer/src/components/CompactDivider';
import { MOTION } from '../../src/renderer/src/components/motion';

describe('CompactDivider 压缩分割线', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('进行中：通栏分割线 + 压缩图标和文案', () => {
    const { container } = render(<CompactDivider status="running" />);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(container.querySelector('.chat-compact-sep')).toBeTruthy();
    expect(container.querySelectorAll('.chat-compact-sep-line').length).toBe(2);
    expect(screen.getByText('正在压缩上下文')).toBeTruthy();
    expect(container.querySelectorAll('.compaction-activity span')).toHaveLength(3);
    expect(container.querySelector('.typing-dots')).toBeNull();
    expect(screen.queryByText('上下文已压缩')).toBeNull();
    const live = container.querySelector('.chat-compact-sep-state');
    expect(live?.getAttribute('data-mp-stage')).toBe('in');
  });

  it('完成：时钟图标 + 「上下文已压缩」，无三点', () => {
    const { container } = render(<CompactDivider status="complete" />);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(screen.getByText('上下文已压缩')).toBeTruthy();
    expect(container.querySelector('.chat-compact-sep-icon')).toBeTruthy();
    expect(container.querySelector('.typing-dots')).toBeNull();
    expect(screen.queryByText('正在压缩上下文')).toBeNull();
  });

  it('进行中→完成：usePresence 交叉淡化，退场播完才卸动态图标', () => {
    const { container, rerender } = render(<CompactDivider status="running" />);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(screen.getByText('正在压缩上下文')).toBeTruthy();

    rerender(<CompactDivider status="complete" />);
    // 切换当帧：进行中进 out，完成挂载入场（enter 起始态已在 layout 阶段落成后切 in）——
    // 两条都在，走 data-mp-stage 不是 keyframes
    const states = container.querySelectorAll('.chat-compact-sep-state');
    expect(states.length).toBe(2);
    const stages = [...states].map((el) => el.getAttribute('data-mp-stage'));
    expect(stages.filter((s) => s === 'out')).toHaveLength(1);
    expect(stages.filter((s) => s !== 'out')).toHaveLength(1);
    expect(container.querySelector('.chat-compact-sep-state[data-mp-stage="out"]')?.className).not.toMatch(
      /keyframes|animate-/
    );

    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(screen.getByText('上下文已压缩')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(MOTION.exitMs + 80);
    });
    expect(screen.queryByText('正在压缩上下文')).toBeNull();
    expect(container.querySelector('.compaction-activity')).toBeNull();
    expect(screen.getByText('上下文已压缩')).toBeTruthy();
    const done = container.querySelector('.chat-compact-sep-state');
    expect(done?.getAttribute('data-mp-stage')).toBe('in');
  });
});
