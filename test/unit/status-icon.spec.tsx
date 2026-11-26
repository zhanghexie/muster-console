/**
 * 会话状态图标（环形家族）挂点测试：
 * 状态语义从「圆点/均衡器」迁移到「状态图标」后，唯一定义点 StatusIcon.tsx 负责映射，
 * 左栏会话行、看板卡片、画布节点三处共用。这里守卫：
 * 1. BoardStatus → 图标类（颜色 st-* / 动画 session-state-spin|attn）映射不回退；
 * 2. 看板卡片渲染的是状态图标槽（board-status-ic），不再出现旧 board-dot。
 * 动画本身是 CSS 循环装饰（base.css .ui-spinner / --dur-loop，只动 transform），组件级只守状态→类名流转。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SessionStatusIcon } from '../../src/renderer/src/components/StatusIcon';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import type { BoardStatus } from '../../src/shared/boardStatus';

const CLASS_BY_STATUS: Record<BoardStatus, { color: string; anim?: string }> = {
  working: { color: 'st-working', anim: 'session-state-spin' },
  idle: { color: 'st-idle' },
  quiet: { color: 'st-idle' },
  blocked: { color: 'st-needsyou', anim: 'session-state-attn' },
  waiting: { color: 'st-needsyou', anim: 'session-state-attn' },
  error: { color: 'st-error' },
  no_signal: { color: 'st-nosignal' },
  done: { color: 'st-done' },
  exited: { color: 'st-idle' },
  scheduled: { color: 'st-idle' }
};

describe('会话状态图标映射（组件级）', () => {
  it.each(Object.keys(CLASS_BY_STATUS) as BoardStatus[])('%s：颜色与动画类正确', (status) => {
    const { container } = render(<SessionStatusIcon status={status} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    const want = CLASS_BY_STATUS[status];
    expect(svg?.classList.contains(want.color)).toBe(true);
    if (want.anim) expect(svg?.classList.contains(want.anim)).toBe(true);
  });

  it('工作中与需要你必带循环动画类（转动/呼吸），静态状态不带', () => {
    const working = render(<SessionStatusIcon status="working" />);
    expect(working.container.querySelector('svg.session-state-spin')).toBeTruthy();
    expect(working.container.querySelector('svg.ui-spinner')).toBeTruthy();
    const blocked = render(<SessionStatusIcon status="blocked" />);
    expect(blocked.container.querySelector('svg.session-state-attn')).toBeTruthy();
    const done = render(<SessionStatusIcon status="done" />);
    expect(done.container.querySelector('svg.session-state-spin')).toBeNull();
    expect(done.container.querySelector('svg.session-state-attn')).toBeNull();
  });

  it('工作中走统一 IconSpinner 几何（正圆 + pathLength=100），不是旧 270° 路径', () => {
    const { container } = render(<SessionStatusIcon status="working" />);
    const circle = container.querySelector('svg.ui-spinner circle');
    expect(circle).toBeTruthy();
    expect(circle?.getAttribute('pathLength')).toBe('100');
    expect(container.querySelector('svg.ui-spinner path')).toBeNull();
  });
});

describe('看板卡片状态图标（组件级）', () => {
  const base = {
    sessionId: 's1',
    name: '会话',
    runtimeLabel: 'pi',
    relTimeTs: Date.now(),
    isActive: false,
    onSelect: () => {},
    onContextMenu: () => {}
  };

  it('working：渲染状态图标槽 + 旋转图标，不再出现旧 board-dot', () => {
    const { container } = render(<BoardCard {...base} status="working" />);
    expect(container.querySelector('.session-state-slot svg.session-state-spin')).toBeTruthy();
    expect(container.querySelector('.board-dot')).toBeNull();
  });

  it('done：状态图标带完成色，不带动画', () => {
    const { container } = render(<BoardCard {...base} status="done" />);
    expect(container.querySelector('.session-state-slot svg.st-done')).toBeTruthy();
    expect(container.querySelector('.session-state-slot svg.session-state-spin')).toBeNull();
  });
});
