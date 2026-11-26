/**
 * 流式揭示与滚动弹簧（2026-10-30）：
 * - Spring 数学子步积分 / dt 钳制 / 收敛吸附 / 无过冲（ζ≥1）；
 * - applyRevealToParts 字符预算截断：多段累计 offset、工具门控整行插入、思考不排队；
 * - ChatMessageView 揭示投影：突发大块不整段蹦出、流结束立即对齐并清残余动画、
 *   减少动态直出、中途挂载即时对齐（不回放）。
 * 运行：npm run test:unit -- test/unit/stream-reveal.spec.tsx
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { Spring, SPRING_SCROLL, SPRING_TEXT, SPRING_TEXT_LONG } from '../../src/renderer/src/chatSurface/spring';
import {
  applyRevealToParts,
  revealCharTotal
} from '../../src/renderer/src/chatSurface/useStreamReveal';
import { resetRevealTickerForTest, revealTickerIdle } from '../../src/renderer/src/chatSurface/revealTicker';
import type { ChatDisplayPart, ChatMessage, ToolCallRecord } from '../../src/shared/types';

const state = vi.hoisted(() => ({ reduced: false, listeners: new Set<() => void>() }));
vi.mock('../../src/renderer/src/interactionPreferences', () => ({
  getInteractionPreferences: () => ({ scrollFeel: 'native', scrollDistance: 1, motion: 'system' }),
  prefersReducedMotionPreference: () => state.reduced,
  subscribeInteractionPreferences: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); }
}));

let now = 0;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  now = 0; nextFrame = 0; frames.clear();
  state.reduced = false; state.listeners.clear();
  resetRevealTickerForTest();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => {
  cleanup(); document.body.innerHTML = '';
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function frame(ms = 16): void {
  now += ms;
  const pending = [...frames.values()]; frames.clear();
  act(() => { for (const fn of pending) fn(now); });
}
/** 揭示任务整个流式期常驻 ticker（设计如此），按步数上限泵帧 */
function pumpFrames(limit = 200): void {
  for (let i = 0; i < limit && frames.size > 0; i++) frame(16);
}

describe('second-order damped spring', () => {
  it('substep integration converges and snaps within thresholds, never overshooting', () => {
    const spring = new Spring(SPRING_TEXT, 0);
    spring.target = 500;
    let prev = 0;
    for (let i = 0; i < 300 && !spring.settled; i++) {
      spring.update(1 / 60);
      expect(spring.pos).toBeGreaterThanOrEqual(prev); // ζ≥1：单调逼近
      expect(spring.pos).toBeLessThanOrEqual(500);
      prev = spring.pos;
    }
    expect(spring.settled).toBe(true);
    expect(spring.pos).toBe(500);
    expect(spring.vel).toBe(0);
  });

  it('clamps huge frame dt (background tab return) without divergence', () => {
    const spring = new Spring(SPRING_SCROLL, 0);
    spring.target = 2600;
    for (let i = 0; i < 30; i++) spring.update(3600);
    expect(spring.pos).toBeGreaterThan(0);
    expect(spring.pos).toBeLessThanOrEqual(2600);
    while (!spring.settled) spring.update(0.016);
    expect(spring.pos).toBe(2600);
  });

  it('snap aligns immediately', () => {
    const spring = new Spring(SPRING_TEXT, 10);
    spring.target = 1000;
    spring.update(0.016);
    expect(spring.pos).toBeGreaterThan(10);
    spring.snap(1000);
    expect(spring.pos).toBe(1000);
    expect(spring.vel).toBe(0);
    expect(spring.settled).toBe(true);
  });

  it('switching to the long-text tuning mid-flight keeps state monotonic', () => {
    const spring = new Spring(SPRING_TEXT, 0);
    spring.target = 5000;
    spring.update(0.05);
    spring.setTuning(SPRING_TEXT_LONG);
    let prev = spring.pos;
    for (let i = 0; i < 400 && !spring.settled; i++) {
      spring.update(0.016);
      expect(spring.pos).toBeGreaterThanOrEqual(prev);
      prev = spring.pos;
    }
    expect(spring.pos).toBe(5000);
  });
});

describe('applyRevealToParts budget truncation', () => {
  const text = (t: string): ChatDisplayPart => ({ kind: 'text', text: t });
  const thinking = (t: string): ChatDisplayPart => ({ kind: 'thinking', text: t });
  const tool = (id: string): ChatDisplayPart => ({
    kind: 'tool',
    toolCall: { id, name: 'fs.read', arguments: '{}', status: 'ok' } as ToolCallRecord
  });

  it('returns null when fully visible; truncates later segments by cumulative offset', () => {
    const parts = [text('aaaa'), tool('t1'), text('bbbb')];
    expect(applyRevealToParts(parts, 8)).toBeNull();
    expect(applyRevealToParts(parts, 6)).toEqual([text('aaaa'), tool('t1'), text('bb')]);
    expect(applyRevealToParts(parts, 2)).toEqual([text('aa')]); // 工具 offset=4>2：整行隐藏，后文自然为空
    expect(applyRevealToParts(parts, 4)).toEqual([text('aaaa'), tool('t1')]); // 前文刚揭示完：工具开门
  });

  it('tool rows are whole once inserted and ordered with the data', () => {
    const parts = [text('aaaa'), tool('t1'), text('bbbb'), tool('t2')];
    expect(applyRevealToParts(parts, 7)).toEqual([text('aaaa'), tool('t1'), text('bbb')]); // t2 的 offset=8>7：未到
    expect(applyRevealToParts(parts, 8)).toBeNull(); // budget 恰达 t2 的 offset：整行可见
    expect(applyRevealToParts(parts, 99)).toBeNull();
  });

  it('thinking passes through ungated (live indicator does not queue)', () => {
    const parts = [text('aaaa'), thinking('th'), text('bb')];
    expect(applyRevealToParts(parts, 0)).toEqual([thinking('th')]);
    expect(applyRevealToParts(parts, 5)).toEqual([text('aaaa'), thinking('th'), text('b')]);
  });

  it('clamps beyond-total budgets and floors fractional input', () => {
    expect(applyRevealToParts([text('abc')], 99)).toBeNull();
    expect(applyRevealToParts([text('abc')], 1.9)).toEqual([text('a')]);
    expect(applyRevealToParts([], 5)).toBeNull();
  });

  it('revealCharTotal counts text only, falling back to content', () => {
    expect(revealCharTotal({ parts: [text('ab'), tool('t'), text('cd')] } as ChatMessage)).toBe(4);
    expect(revealCharTotal({ content: 'xyz' } as ChatMessage)).toBe(3);
    expect(revealCharTotal({} as ChatMessage)).toBe(0);
  });
});

function msg(parts: ChatDisplayPart[], id = 'turn-1'): ChatMessage {
  return { id, role: 'assistant', content: '', parts, createdAt: Date.now() } as ChatMessage;
}
function bodyText(container: HTMLElement): string {
  return [...container.querySelectorAll('.chat-text')].map(el => el.textContent ?? '').join('');
}

describe('ChatMessageView streaming reveal', () => {
  it('a burst spreads over the spring settle instead of appearing at once', () => {
    const view = render(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(20) }])} streaming />);
    frame(50);
    expect(bodyText(view.container)).toBe('a'.repeat(20));
    view.rerender(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(20) + 'b'.repeat(200) }])} streaming />);
    frame(50);
    const mid = bodyText(view.container);
    expect(mid.length).toBeGreaterThan(20);
    expect(mid.length).toBeLessThan(220); // 突发 200 字符没有整段蹦出
    let prev = mid.length;
    for (let i = 0; i < 60; i++) {
      frame(33);
      expect(bodyText(view.container).length).toBeGreaterThanOrEqual(prev); // 揭示只前进不回退
      prev = bodyText(view.container).length;
      if (prev >= 220) break;
    }
    expect(bodyText(view.container)).toBe('a'.repeat(20) + 'b'.repeat(200));
    view.unmount();
    expect(revealTickerIdle()).toBe(true);
  });

  it('tool rows wait for preceding text, then insert whole and exactly once', () => {
    const view = render(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(30) }])} streaming />);
    frame(50);
    expect(bodyText(view.container)).toBe('a'.repeat(30));
    view.rerender(
      <ChatMessageView
        message={msg([
          { kind: 'text', text: 'x'.repeat(200) },
          { kind: 'tool', toolCall: { id: 't1', name: 'fs.read', arguments: '{}', status: 'running' } }
        ])}
        streaming
      />
    );
    frame(50);
    expect(view.container.querySelector('.tool-call-block')).toBeNull(); // 前文未揭示完：整行未出现
    expect(bodyText(view.container).length).toBeGreaterThan(30);
    expect(bodyText(view.container).length).toBeLessThan(200);
    pumpFrames();
    const group = view.container.querySelector<HTMLDetailsElement>('.tool-call-group-details');
    expect(group).toBeTruthy(); // 分组一次性插入，不重复
    expect(group!.open).toBe(false);
    fireEvent.click(group!.querySelector('summary')!);
    expect(group!.querySelectorAll('.tool-call-block')).toHaveLength(1);
    expect(bodyText(view.container)).toBe('x'.repeat(200));
    view.unmount();
    expect(revealTickerIdle()).toBe(true);
  });

  it('ending the stream aligns immediately and leaves no residual ticker work', () => {
    const view = render(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(5) }])} streaming />);
    frame(50);
    expect(bodyText(view.container)).toBe('a'.repeat(5));
    view.rerender(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(40) }])} streaming />);
    frame(16);
    expect(bodyText(view.container).length).toBeLessThan(40); // 仍在弹簧途中
    view.rerender(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(40) }])} streaming={false} />);
    expect(bodyText(view.container)).toBe('a'.repeat(40)); // 无需泵帧：立即终态
    expect(revealTickerIdle()).toBe(true); // 任务已注销，无残余动画
    view.unmount();
  });

  it('reduced motion disables reveal smoothing (text lands per batch)', () => {
    state.reduced = true;
    const view = render(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(300) }])} streaming />);
    expect(bodyText(view.container)).toBe('a'.repeat(300)); // 直出，无截断
    expect(revealTickerIdle()).toBe(true);
    view.unmount();
  });

  it('attaching mid-stream shows existing text immediately, only new growth reveals', () => {
    const view = render(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(500) }])} streaming />);
    expect(bodyText(view.container)).toBe('a'.repeat(500)); // 已有内容即时对齐，不回放
    view.rerender(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(500) + 'b'.repeat(100) }])} streaming />);
    frame(50);
    expect(bodyText(view.container).length).toBeLessThan(600); // 新增量走弹簧
    pumpFrames();
    expect(bodyText(view.container)).toBe('a'.repeat(500) + 'b'.repeat(100));
    view.unmount();
  });

  it('hidden panel skips ticking; a large backlog snaps instead of playing catch-up', () => {
    const view = render(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(10) }])} streaming />);
    frame(50);
    const root = view.container.querySelector<HTMLElement>('.chat-msg')!;
    // 保活隐藏面板走 checkVisibility（display:none 祖先），任务级可见性暂停推进
    Object.defineProperty(root, 'checkVisibility', { configurable: true, value: () => false });
    view.rerender(<ChatMessageView message={msg([{ kind: 'text', text: 'a'.repeat(10) + 'b'.repeat(2000) }])} streaming />);
    pumpFrames(60);
    expect(bodyText(view.container)).toBe('a'.repeat(10)); // 隐藏期不推进
    Object.defineProperty(root, 'checkVisibility', { configurable: true, value: () => true });
    frame(50); // 重新可见：积压 > REVEAL_HIDDEN_SNAP_CHARS(600) → 吸附，不播长追赶
    expect(bodyText(view.container)).toBe('a'.repeat(10) + 'b'.repeat(2000));
    view.unmount();
  });
});
