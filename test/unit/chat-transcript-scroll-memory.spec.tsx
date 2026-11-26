/**
 * 转写阅读位置记忆（2026-10-14 保活 LRU 配套）契约：
 * 1) 上翻阅读后卸载（LRU 逐出/父层关开重挂）→ 重挂恢复 scrollTop 与
 *    「加载更早」回填窗口（clipExtra），不贴底；
 * 2) 在底部卸载 → 重挂默认贴底（记忆被清）；
 * 3) 重挂后立即 reveal/查找显式跳转 → 显式导航优先，不做位置恢复；
 * 4) 重会话（渐进挂载中）重挂：挂满后一拍恢复位置。
 * jsdom 无布局：scrollHeight/clientHeight 手工 defineProperty（同 window spec）。
 * 还原即红：去掉恢复 effect 时「恢复 scrollTop」断言转红。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import {
  ChatTranscript,
  TRANSCRIPT_CLIP_THRESHOLD,
  resetTranscriptScrollMemoryForTest,
  takeTranscriptScroll
} from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';

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

function msgs(n: number, nParts = 1): Src[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: 'user' as const,
    content: `c${i}`,
    createdAt: i + 1,
    parts: Array.from({ length: nParts }, (_, p) => ({ kind: 'text' as const, text: `t${i}-${p}` }))
  }));
}

/** 挂布局几何：n 行 × 100px，视口 400px */
function layoutOf(n: number): { scrollHeight: number; clientHeight: number } {
  return { scrollHeight: n * 100, clientHeight: 400 };
}

const applyLayout = (list: HTMLElement, n: number): void => {
  const geo = layoutOf(n);
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => geo.scrollHeight });
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => geo.clientHeight });
};

const flushFrames = async (ms = 120): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

describe('转写阅读位置记忆', () => {
  beforeEach(() => resetTranscriptScrollMemoryForTest());

  it('上翻阅读后卸载重挂：恢复 scrollTop 与回填窗口', async () => {
    const messages = msgs(600); // 裁剪态：初始窗口 120
    const p = { busy: false, sessionId: 's-mem', model };
    const first = render(<ChatTranscript {...p} messages={messages} />);
    const list = first.container.querySelector('.chat-list') as HTMLDivElement;
    applyLayout(list, 120);
    // 用户点「加载更早」回填 240 → 窗口 360 行；再上翻到中部阅读位
    fireEvent.click(first.container.querySelector('.chat-clip-more-btn')!);
    applyLayout(list, 360);
    list.scrollTop = 120 * 100; // 阅读位置在中部（不在底部）
    fireEvent.scroll(list);
    expect(takeTranscriptScroll('s-mem')).toEqual({ top: 12000, clipExtra: 240, anchorMid: null, anchorOffset: 0 });
    first.unmount(); // LRU 逐出

    // 重挂：挂载期恢复 clipExtra（m240 在场），随后 scrollTop 恢复
    const second = render(<ChatTranscript {...p} messages={messages} />);
    const list2 = second.container.querySelector('.chat-list') as HTMLDivElement;
    applyLayout(list2, 360);
    // jsdom 挂载期几何后到：用一次 messages 引用变化重触发恢复 effect
    await act(async () => {
      second.rerender(<ChatTranscript {...p} messages={[...messages]} />);
    });
    expect(second.container.querySelector('[data-mid="m240"]')).toBeTruthy(); // 回填窗口恢复
    expect(list2.scrollTop).toBe(12000); // 阅读位置恢复（非贴底）
    second.unmount();
  });

  it('在底部卸载重挂：默认贴底（记忆清除）', async () => {
    const messages = msgs(50);
    const p = { busy: false, sessionId: 's-bottom', model };
    const first = render(<ChatTranscript {...p} messages={messages} />);
    const list = first.container.querySelector('.chat-list') as HTMLDivElement;
    applyLayout(list, 50);
    list.scrollTop = 50 * 100 - 400; // 底部（带内）
    fireEvent.scroll(list);
    expect(takeTranscriptScroll('s-bottom')).toBeNull(); // 底部不留记忆
    first.unmount();

    const second = render(<ChatTranscript {...p} messages={messages} />);
    const list2 = second.container.querySelector('.chat-list') as HTMLDivElement;
    applyLayout(list2, 50);
    // jsdom 挂载期布局属性尚未就位（贴底 effect 已跑过、读到 0）——用一次
    // messages 引用变化重触发贴底，验证默认贴底路径未被记忆逻辑破坏
    await act(async () => {
      second.rerender(<ChatTranscript {...p} messages={[...messages]} />);
    });
    expect(list2.scrollTop).toBe(50 * 100); // 贴底
    second.unmount();
  });

  it('重挂后显式 reveal 优先于位置恢复', () => {
    const messages = msgs(600);
    const p = { busy: false, sessionId: 's-reveal', model };
    const first = render(<ChatTranscript {...p} messages={messages} />);
    const list = first.container.querySelector('.chat-list') as HTMLDivElement;
    applyLayout(list, 120);
    list.scrollTop = 50 * 100;
    fireEvent.scroll(list);
    first.unmount();

    const second = render(<ChatTranscript {...p} messages={messages} />);
    const list2 = second.container.querySelector('.chat-list') as HTMLDivElement;
    applyLayout(list2, 120);
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    act(() => {
      list2.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'm10' }));
    });
    expect(second.container.querySelector('[data-mid="m10"]')).toBeTruthy(); // 显式跳转挂载
    expect(measured.mock.contexts).toContain(second.container.querySelector('[data-mid="m10"]')); // reveal navigation owns the target
    measured.mockRestore();
    second.unmount();
  });

  it('重会话（渐进挂载）重挂：挂满后一拍恢复位置', async () => {
    const messages = msgs(30, 50); // 1500 parts → 渐进
    const p = { busy: false, sessionId: 's-heavy', model };
    const first = render(<ChatTranscript {...p} messages={messages} />);
    const list = first.container.querySelector('.chat-list') as HTMLDivElement;
    applyLayout(list, 30);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    }); // 先走完渐进
    list.scrollTop = 10 * 100; // 上翻到中部
    fireEvent.scroll(list);
    first.unmount();

    const second = render(<ChatTranscript {...p} messages={messages} />);
    const list2 = second.container.querySelector('.chat-list') as HTMLDivElement;
    applyLayout(list2, 30);
    // jsdom 的 rAF 链每个 act 边界只走一步：轮询等渐进挂满（同 progressive spec）
    const deadline = Date.now() + 8000;
    while (second.container.querySelectorAll('[data-mid]').length < 30 && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    }
    expect(second.container.querySelectorAll('[data-mid]').length).toBe(30);
    expect(list2.scrollTop).toBe(1000); // 挂满后恢复到记忆位置
    second.unmount();
  });
});
