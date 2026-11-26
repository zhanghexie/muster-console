/**
 * 转写「滚动到底部」浮钮：上翻解除贴底后出现，点击重新贴底并退场卸载。
 * 把 stickBottom 判定从「只改 ref 无 UI」补成可见交互（对标 Cursor jump）。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ChatTranscript,
  isTranscriptAtBottom,
  resetTranscriptScrollMemoryForTest
} from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';
import { MOTION } from '../../src/renderer/src/components/motion';
// This suite covers follow state/presence; animation/cancellation has a real-rAF
// clock in transcript-scroll-controller.spec.tsx. Reduced motion is immediate.
vi.mock('../../src/renderer/src/interactionPreferences', () => ({
  getInteractionPreferences: () => ({ scrollFeel: 'native', scrollDistance: 1, motion: 'reduced' }),
  prefersReducedMotionPreference: () => true,
  subscribeInteractionPreferences: () => () => {}
}));

vi.mock('../../src/renderer/src/components/ChatMessageView', () => ({
  ChatMessageView: ({ message }: { message: { id: string; content: string } }) => (
    <div data-msg={message.id}>{message.content}</div>
  )
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

interface Src {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const model: TranscriptModelBinding<Src> = {
  toDisplay: (m) => m as unknown as ChatMessage
};

const msgs: Src[] = [
  { id: 'u1', role: 'user', content: '你好' },
  { id: 'a1', role: 'assistant', content: '在的' }
];

function mount() {
  return render(
    <ChatTranscript messages={msgs} busy={false} sessionId="s-jump" model={model} />
  );
}

function mockMetrics(el: HTMLElement, scrollTop: number, height = 2000, client = 400): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: client });
  el.scrollTop = scrollTop;
}

describe('ChatTranscript 滚动到底部按钮', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTranscriptScrollMemoryForTest();
  });

  it('atBottom：距底 <60px 为真，含贴底回弹', () => {
    expect(isTranscriptAtBottom({ scrollHeight: 2000, scrollTop: 1600, clientHeight: 400 })).toBe(
      true
    );
    expect(isTranscriptAtBottom({ scrollHeight: 2000, scrollTop: 1598, clientHeight: 400 })).toBe(
      true
    );
    expect(isTranscriptAtBottom({ scrollHeight: 2000, scrollTop: 200, clientHeight: 400 })).toBe(
      false
    );
  });

  it('上翻后出现按钮；点击贴回底部并退场卸载', async () => {
    const user = userEvent.setup();
    mount();
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    expect(list).toBeTruthy();
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull();

    // 首个 scroll 只记基线（lastScrollTop 初值 -1）
    mockMetrics(list, 1540);
    fireEvent.scroll(list);
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull();

    // 向上翻出容差带 → 浮钮出现
    mockMetrics(list, 200);
    fireEvent.scroll(list);
    const btn = await screen.findByRole('button', { name: '滚动到底部' });
    expect(btn).toBeTruthy();
    expect(document.querySelector('.chat-jump-bottom-pos')).toBeTruthy();

    await user.click(btn);
    expect(list.scrollTop).toBe(1600);

    await waitFor(
      () => {
        expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull();
      },
      { timeout: MOTION.menuMs + 2000 }
    );
  });

  it('滚回底部容差带内则自动收起浮钮', async () => {
    mount();
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    mockMetrics(list, 1540);
    fireEvent.scroll(list);
    mockMetrics(list, 120);
    fireEvent.scroll(list);
    expect(await screen.findByRole('button', { name: '滚动到底部' })).toBeTruthy();

    mockMetrics(list, 1960);
    fireEvent.scroll(list);
    await waitFor(
      () => {
        expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull();
      },
      { timeout: MOTION.menuMs + 2000 }
    );
  });

  it('发新消息自动贴底后浮钮消失；贴底微抖不再当上翻', async () => {
    const view = render(
      <ChatTranscript messages={msgs} busy={false} sessionId="s-jump" model={model} />
    );
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    mockMetrics(list, 1540);
    fireEvent.scroll(list);
    mockMetrics(list, 200);
    fireEvent.scroll(list);
    expect(await screen.findByRole('button', { name: '滚动到底部' })).toBeTruthy();

    view.rerender(
      <ChatTranscript
        messages={[...msgs, { id: 'u2', role: 'user', content: '继续' }]}
        busy={false}
        sessionId="s-jump"
        model={model}
      />
    );
    // 自动贴底：scrollTop=scrollHeight（jsdom 不夹紧），距底为负也算 atBottom
    mockMetrics(list, list.scrollHeight);
    fireEvent.scroll(list);
    // 贴底后 2px 回弹仍在 60px 带内——旧逻辑按「上翻」会把浮钮再打开
    mockMetrics(list, list.scrollHeight - 2);
    fireEvent.scroll(list);
    expect(isTranscriptAtBottom(list)).toBe(true);
    await waitFor(
      () => {
        expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull();
      },
      { timeout: MOTION.menuMs + 2000 }
    );
  });

  it('上翻后重挂恢复阅读位置，并显示回底按钮', () => {
    const view = render(
      <ChatTranscript messages={msgs} busy={false} sessionId="s-reopen" model={model} />
    );
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    mockMetrics(list, 1540);
    fireEvent.scroll(list);
    mockMetrics(list, 200);
    fireEvent.wheel(list, { deltaY: -40 });
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(200);

    view.unmount();
    const again = render(
      <ChatTranscript messages={msgs} busy={false} sessionId="s-reopen" model={model} />
    );
    const list2 = document.querySelector('.chat-list') as HTMLDivElement;
    // jsdom 无布局：几何后到，用 messages 引用变化触发记忆恢复。
    mockMetrics(list2, 200);
    again.rerender(
      <ChatTranscript messages={[...msgs]} busy={false} sessionId="s-reopen" model={model} />
    );
    expect(list2.scrollTop).toBe(200);
    expect(screen.getByRole('button', { name: '滚动到底部' })).toBeTruthy();
  });

  it('切 sessionId 也贴底（与中栏切回对齐），不沿用上一会话的上翻位置', () => {
    const view = render(
      <ChatTranscript messages={msgs} busy={false} sessionId="s-a" model={model} />
    );
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    mockMetrics(list, 1540);
    fireEvent.scroll(list);
    mockMetrics(list, 200);
    fireEvent.wheel(list, { deltaY: -40 });
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(200);

    mockMetrics(list, 200);
    view.rerender(
      <ChatTranscript messages={[...msgs]} busy={false} sessionId="s-b" model={model} />
    );
    expect(list.scrollTop).toBe(2000); // first position is immediate browser-clamped follow
  });

  it('贴底时输入条让位/内容长高：scroll 不摘跟随，钉到新底', () => {
    mount();
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    mockMetrics(list, 1600);
    fireEvent.scroll(list);
    expect(isTranscriptAtBottom(list)).toBe(true);

    // composer overlay 写入：scrollHeight 从 2000 → 2200，scrollTop 仍 1600（旧底）
    mockMetrics(list, 1600, 2200);
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(2200);
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull();
  });
});
