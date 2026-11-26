/**
 * 首开渐进挂载（2026-10-14 性能专项）契约：
 * 1) parts 总量超阈值（重会话）首渲染只挂尾部 part 预算（末条在、首条不在），
 *    rAF 分帧补齐到全量（最终行为等价：所有行都挂载）；
 * 2) reveal/查找跳转不受渐进影响：目标行立即放行挂载；
 * 3) 轻会话（parts ≤ 阈值）首渲染即全量挂载（零行为差异）；
 * 4) 切会话重置渐进预算（另一会话重新按自身 parts 决定是否渐进）。
 * ChatMessageView 以轻量 memo mock 替身（同 chat-transcript-window.spec）。
 * 还原即红：去掉渐进分支时，「首渲染只挂尾部」断言转红；把渐进阈值改成 0 时
 * 「轻会话全量挂载」转红。
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import {
  ChatTranscript,
  PROGRESSIVE_PARTS_THRESHOLD,
  PROGRESSIVE_FIRST_PARTS
} from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';
import { MOTION } from '../../src/renderer/src/components/motion';

const { msgMock } = vi.hoisted(() => ({
  msgMock: vi.fn(({ message }: { message: { id: string } }) => (
    <div data-msg-view={message.id} />
  ))
}));

vi.mock('../../src/renderer/src/components/ChatMessageView', async () => {
  const React = await import('react');
  return { ChatMessageView: React.memo(msgMock) };
});

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);
// jsdom 无 scrollIntoView（查找/reveal 定位路径会调用）：装 spy（同 find-scroll spec）
(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();

interface Src {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  parts?: Array<{ kind: 'text'; text: string }>;
}

const model: TranscriptModelBinding<Src> = {
  toDisplay: (m) => m as unknown as ChatMessage
};

const baseProps = { busy: false, sessionId: 's-prog', model };

/** 每条消息 nParts 个 text part；createdAt 递增 1ms 避免时间条噪音 */
function heavyMessages(count: number, nParts: number): Src[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: 'user' as const,
    content: `c${i}`,
    createdAt: i + 1,
    parts: Array.from({ length: nParts }, (_, p) => ({ kind: 'text' as const, text: `t${i}-${p}` }))
  }));
}

const midCount = (container: HTMLElement): number =>
  container.querySelectorAll('[data-mid]').length;

/** 等渐进预算走完：jsdom 的 rAF+React 处理每步 ~50ms（真机 ~1 帧），
 *  轮询直到行数到目标或超时 */
const flushUntilMounted = async (
  container: HTMLElement,
  target: number,
  timeoutMs = 4000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (midCount(container) < target && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
  }
};

describe('首开渐进挂载（重会话首开性能）', () => {
  it('重会话：首渲染只挂尾部 part 预算，rAF 补齐到全量', async () => {
    // 30 条 × 50 parts = 1500 parts（重会话档）
    const msgs = heavyMessages(30, 50);
    expect(30 * 50).toBeGreaterThan(PROGRESSIVE_PARTS_THRESHOLD);
    const { container } = render(<ChatTranscript {...baseProps} messages={msgs} />);
    const first = midCount(container);
    expect(first).toBeLessThan(30); // 首渲染只挂尾部预算（非全量）
    expect(first).toBeGreaterThan(0);
    expect(container.querySelector('[data-mid="m29"]')).toBeTruthy(); // 末条（视口侧）在场
    expect(container.querySelector('[data-mid="m0"]')).toBeNull(); // 首条暂不在
    await flushUntilMounted(container, 30);
    expect(midCount(container)).toBe(30); // 补齐后全量（行为等价）
    expect(container.querySelector('[data-mid="m0"]')).toBeTruthy();
  });

  it('重会话：reveal 同步放行目标行并在有界时长内定位到8px停靠点', () => {
    let clock = 0, next = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(fn => { frames.set(++next, fn); return next; });
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
    const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let top = 2400;
    const rectangles = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top: this.dataset.mid ? 100 + Number(this.dataset.mid.slice(1)) * 100 - top : 100,
        width: 500, height: this.classList.contains('chat-list') ? 400 : 100 } as DOMRect;
    });
    let view: ReturnType<typeof render> | undefined;
    try {
    const msgs = heavyMessages(30, 50);
    view = render(<ChatTranscript {...baseProps} messages={msgs} />);
    const { container } = view;
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 3000 }, clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(Number(value), 2600)); } }
    });
    expect(container.querySelector('[data-mid="m1"]')).toBeNull(); // 渐进期不在
    act(() => {
      list.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'm1' }));
    });
    expect(container.querySelector('[data-mid="m1"]')).toBeTruthy(); // 立即挂载
    expect(midCount(container)).toBe(30); // 显式跳转不等待渐进 rAF
    expect(top).toBe(492); // only the final viewport of a long jump is animated
    clock += MOTION.exitMs;
    act(() => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(clock); });
    expect(top).toBe(92);
    expect(container.querySelector('[data-mid="m1"]')!.getBoundingClientRect().top - list.getBoundingClientRect().top).toBe(8);
    expect(frames.size).toBe(0);
    } finally { view?.unmount(); rectangles.mockRestore(); time.mockRestore(); cancel.mockRestore(); raf.mockRestore(); }
  });

  it('重会话：查找命中旧行同样立即放行', async () => {
    const msgs = heavyMessages(30, 50);
    const { container, rerender } = render(
      <ChatTranscript {...baseProps} messages={msgs} />
    );
    expect(container.querySelector('[data-mid="m2"]')).toBeNull();
    // findActive 指向未挂载的旧行（Ctrl+F 命中）
    rerender(
      <ChatTranscript
        {...baseProps}
        messages={msgs}
        findQuery={'t2-0'}
        findActive={{ messageId: 'm2', indexInMessage: 0 }}
      />
    );
    expect(container.querySelector('[data-mid="m2"]')).toBeTruthy();
  });

  it('轻会话（parts ≤ 阈值）：首渲染即全量（零行为差异）', () => {
    // 400 条 × 1 part = 400 parts ≤ 600
    const msgs = heavyMessages(400, 1);
    const { container } = render(<ChatTranscript {...baseProps} messages={msgs} />);
    expect(midCount(container)).toBe(400);
    expect(container.querySelector('[data-mid="m0"]')).toBeTruthy();
  });

  it('切会话：渐进预算随新会话重算', async () => {
    const heavy = heavyMessages(30, 50);
    const light = heavyMessages(10, 1);
    const { container, rerender } = render(
      <ChatTranscript {...baseProps} messages={heavy} sessionId="s-heavy" />
    );
    expect(midCount(container)).toBeLessThan(30);
    await flushUntilMounted(container, 30);
    expect(midCount(container)).toBe(30);
    rerender(<ChatTranscript {...baseProps} messages={light} sessionId="s-light" />);
    expect(midCount(container)).toBe(10); // 轻会话不渐进
    rerender(<ChatTranscript {...baseProps} messages={heavy} sessionId="s-heavy" />);
    expect(midCount(container)).toBeLessThanOrEqual(PROGRESSIVE_FIRST_PARTS); // 重新渐进
  });
});
