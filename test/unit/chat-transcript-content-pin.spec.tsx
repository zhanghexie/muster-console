/**
 * 贴底第 4 触发器：内容高度观察（2026-09-26 滚动 review 回归）。
 * 既有三个贴底触发器——messages/busy 贴底 effect、onScroll 补钉、容器 RO——
 * 都覆盖不到「内容长高而 scrollTop 不动」：折叠思考块展开/收起（行内本地
 * state，不碰 messages/busy）、异步内容（图片/mermaid/高亮）加载完成、
 * content-visibility 估算结算、流式节流落地——全都不产生 scroll 事件、
 * 不改容器盒，视口停在旧底（用户感知：滚到底了但最新内容不在/滚不到底）。
 * 契约：跟随态下内容 RO 触发即补钉到底；上翻摘跟随后的内容长高不强行拉底。
 * 还原即红：去掉 ChatTranscript 里的内容 RO（.agent-chat-col 观察）后，
 * 用例 1 找不到内容观察器、用例 2 的补钉断言转红。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, screen } from '@testing-library/react';
import { ChatTranscript, resetTranscriptScrollMemoryForTest } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';
vi.mock('../../src/renderer/src/interactionPreferences', () => ({
  getInteractionPreferences: () => ({ scrollFeel: 'native', scrollDistance: 1, motion: 'reduced' }),
  prefersReducedMotionPreference: () => true,
  subscribeInteractionPreferences: () => () => {}
}));

// 可控 ResizeObserver：记录实例与被观察元素，供测试定向触发（jsdom 无实现）
const { roInstances } = vi.hoisted(() => ({
  roInstances: [] as Array<{ el: Element | null; fire: () => void }>
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    private cb: () => void;
    el: Element | null = null;
    fire: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      this.fire = () => this.cb();
      roInstances.push(this);
    }
    observe(el: Element): void {
      this.el = el;
    }
    unobserve(): void {}
    disconnect(): void {}
  }
);

vi.mock('../../src/renderer/src/components/ChatMessageView', () => ({
  ChatMessageView: ({ message }: { message: { id: string; content: string } }) => (
    <div data-msg={message.id}>{message.content}</div>
  )
}));

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

function mockMetrics(el: HTMLElement, scrollTop: number, height = 2000, client = 400): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: client });
  el.scrollTop = scrollTop;
}

function contentRo(): { fire: () => void } {
  const found = roInstances.find((ro) => ro.el?.classList.contains('agent-chat-col'));
  expect(found, '内容观察器（.agent-chat-col RO）应已注册').toBeTruthy();
  return found!;
}

describe('ChatTranscript 内容高度贴底兜底', () => {
  beforeEach(() => {
    roInstances.length = 0;
    vi.clearAllMocks();
    resetTranscriptScrollMemoryForTest();
  });

  it('跟随态下内容长高而无 scroll 事件：补钉新底', () => {
    const view = render(
      <ChatTranscript messages={msgs} busy={false} sessionId="s-pin" model={model} />
    );
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    const ro = contentRo();

    // 挂载即跟随（stickBottom 初值 true）；此时贴在 2000 的旧底
    mockMetrics(list, 1600, 2000);
    // 内容长高（折叠展开/异步图片/估算结算）：scrollHeight 2000→2400，
    // scrollTop 仍停在 1600——真实世界此路径无任何 scroll 事件
    mockMetrics(list, 1600, 2400);
    act(() => ro.fire());
    expect(list.scrollTop).toBe(2400);
    view.unmount();
  });

  it('上翻摘跟随后的内容长高：不强行拉底', () => {
    const view = render(
      <ChatTranscript messages={msgs} busy={false} sessionId="s-nopin" model={model} />
    );
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    const ro = contentRo();

    mockMetrics(list, 1600, 2000);
    fireEvent.scroll(list); // 记基线
    mockMetrics(list, 400, 2000);
    fireEvent.wheel(list, { deltaY: -40 });
    fireEvent.scroll(list); // 上翻摘跟随
    expect(list.scrollTop).toBe(400);

    // 阅读中内容长高：不得把用户拽回底部
    mockMetrics(list, 400, 2400);
    act(() => ro.fire());
    expect(list.scrollTop).toBe(400);
    view.unmount();
  });
  it('内嵌 UI 的滚轮/折叠信号摘跟随，异步高度变化不把读者拉走', () => {
    const view = render(<ChatTranscript messages={msgs} busy={false} sessionId="s-widget" model={model} />);
    const list = document.querySelector('.chat-list') as HTMLDivElement, ro = contentRo();
    mockMetrics(list, 1550, 2000);
    act(() => list.dispatchEvent(new CustomEvent('chat-scroll:user-interaction')));
    mockMetrics(list, 1550, 2400);
    act(() => ro.fire());
    expect(list.scrollTop).toBe(1550); view.unmount();
  });

  it('跟随态下内容缩短（折叠收起）：同样补钉贴住新底', () => {
    const view = render(
      <ChatTranscript messages={msgs} busy={false} sessionId="s-shrink" model={model} />
    );
    const list = document.querySelector('.chat-list') as HTMLDivElement;
    const ro = contentRo();

    mockMetrics(list, 1800, 2000);
    // 收起思考块：scrollHeight 2000→1400，原 scrollTop 1800 已越界
    mockMetrics(list, 1800, 1400);
    act(() => ro.fire());
    expect(list.scrollTop).toBe(1400);
    view.unmount();
  });

  function nestedScroller(list: HTMLElement, top: number, overscroll = 'auto'): HTMLElement {
    const nested = document.createElement('div');
    nested.style.overflowY = 'auto';
    nested.style.overscrollBehaviorY = overscroll;
    mockMetrics(nested, top, 1000, 200);
    list.querySelector('.agent-chat-col')!.append(nested);
    return nested;
  }

  it('内部滚动区可上翻：冒泡 wheel 不解除外层跟随', () => {
    render(<ChatTranscript messages={msgs} busy={false} sessionId="s-inner" model={model} />);
    const list = document.querySelector('.chat-list') as HTMLElement;
    mockMetrics(list, 1600);
    fireEvent.scroll(list);
    const nested = nestedScroller(list, 300);
    const child = document.createElement('span'); nested.append(child);
    fireEvent.wheel(child, { deltaY: -40 });
    // 外层没有 scroll 事件；内部思考滚动后 assistant 正文长高。
    mockMetrics(list, 1600, 2400);
    act(() => contentRo().fire());
    expect(list.scrollTop).toBe(2400);
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull();
  });

  it('内部到顶且允许滚动链：外层上翻仍解除跟随', () => {
    render(<ChatTranscript messages={msgs} busy={false} sessionId="s-chain" model={model} />);
    const list = document.querySelector('.chat-list') as HTMLElement;
    mockMetrics(list, 1600); fireEvent.scroll(list);
    fireEvent.wheel(nestedScroller(list, 0), { deltaY: -40 });
    mockMetrics(list, 1560); fireEvent.scroll(list);
    mockMetrics(list, 1560, 2400);
    act(() => contentRo().fire());
    expect(list.scrollTop).toBe(1560);
    expect(screen.getByRole('button', { name: '滚动到底部' })).toBeTruthy();
  });

  it('内部到顶但禁止滚动链：保持外层跟随', () => {
    render(<ChatTranscript messages={msgs} busy={false} sessionId="s-contained" model={model} />);
    const list = document.querySelector('.chat-list') as HTMLElement;
    mockMetrics(list, 1600); fireEvent.scroll(list);
    fireEvent.wheel(nestedScroller(list, 0, 'contain'), { deltaY: -40 });
    mockMetrics(list, 1600, 2400);
    act(() => contentRo().fire());
    expect(list.scrollTop).toBe(2400);
  });

  it('连续上翻已摘跟随时不再量祖先样式，回底后仍重新检查内部滚动链', () => {
    render(<ChatTranscript messages={msgs} busy={false} sessionId="s-wheel-cost" model={model} />);
    const list = document.querySelector('.chat-list') as HTMLElement;
    mockMetrics(list, 1600); fireEvent.scroll(list);
    const nested = nestedScroller(list, 0);
    const child = document.createElement('span'); nested.append(child);
    const styles = vi.spyOn(window, 'getComputedStyle');
    try {
      fireEvent.wheel(child, { deltaY: -40 }); // 到顶可传递，首次摘跟随
      expect(styles).toHaveBeenCalled();
      styles.mockClear();
      fireEvent.wheel(child, { deltaY: -40 });
      fireEvent.wheel(child, { deltaY: -40 });
      expect(styles).not.toHaveBeenCalled(); // 还原短路即红：每个 wheel 都会扫描祖先
      mockMetrics(list, 1200, 2400);
      fireEvent.scroll(list);
      act(() => contentRo().fire());
      expect(list.scrollTop).toBe(1200); // 仍保留阅读位

      mockMetrics(list, 2000, 2400); fireEvent.scroll(list); // 回底恢复跟随
      nested.scrollTop = 300; // 内部尚可上翻，此次不应再摘外层跟随
      styles.mockClear();
      fireEvent.wheel(child, { deltaY: -40 });
      expect(styles).toHaveBeenCalled();
      mockMetrics(list, 2000, 2800);
      act(() => contentRo().fire());
      expect(list.scrollTop).toBe(2800);
    } finally {
      styles.mockRestore();
    }
  });

  it('底部容差内上翻后内容长高：保留阅读位并显示回底按钮', () => {
    render(<ChatTranscript messages={msgs} busy={false} sessionId="s-near" model={model} />);
    const list = document.querySelector('.chat-list') as HTMLElement;
    mockMetrics(list, 1600); fireEvent.scroll(list);
    fireEvent.wheel(list, { deltaY: -20 });
    mockMetrics(list, 1580); fireEvent.scroll(list);
    expect(screen.queryByRole('button', { name: '滚动到底部' })).toBeNull();
    mockMetrics(list, 1580, 2400);
    act(() => contentRo().fire());
    expect(list.scrollTop).toBe(1580);
    expect(screen.getByRole('button', { name: '滚动到底部' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' }));
    expect(list.scrollTop).toBe(2000); // navigation clamps to the true maximum
  });

  it('摘跟随后容器变矮：保留阅读位并更新回底按钮', () => {
    render(<ChatTranscript messages={msgs} busy={false} sessionId="s-viewport" model={model} />);
    const list = document.querySelector('.chat-list') as HTMLElement;
    mockMetrics(list, 1600); fireEvent.scroll(list);
    fireEvent.wheel(list, { deltaY: -20 });
    mockMetrics(list, 1580); fireEvent.scroll(list);
    mockMetrics(list, 1580, 2000, 200);
    act(() => roInstances.find(ro => ro.el === list)!.fire());
    expect(list.scrollTop).toBe(1580);
    expect(screen.getByRole('button', { name: '滚动到底部' })).toBeTruthy();
  });
});
