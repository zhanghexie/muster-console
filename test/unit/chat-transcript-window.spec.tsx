/**
 * 长转录窗口裁剪（R-23 一期）契约：
 * 1) 超阈值（>500 条）会话只挂尾部窗口（CLIP_WINDOW 条 stream 条目），首条不在 DOM、
 *    末条在 DOM，顶部出「加载更早」按钮；3000 条消息可正常渲染（性能门槛）；
 * 2) 短会话零行为差异：无按钮、全量挂载；
 * 3) 「加载更早」回填：窗口按 CHUNK 扩大，prepend 的视口由高度增量锚定还原（不跳位）；
 * 4) 裁剪态流式贴底不变：新增消息仍钉在底部（stickBottom 门控原样）；
 * 5) 压缩分割线随所在区段挂载/卸载：窗口内的插对位置，裁剪区的不渲染；
 * 6) 停靠点跳转 reveal：目标不在窗口时经 chat-clip:reveal 扩窗后挂载并滚动定位；
 * 7) 切会话重置窗口回初始大小。
 * ChatMessageView 以轻量 memo mock 替身（本 spec 只测转写层的挂载/裁剪/滚动语义；
 * 行内渲染行为由 chat-stale-turn / chat-fold-unmount / chat-transcript-memo 覆盖）。
 * 还原即红：移除裁剪（clipStart 恒 0）时，「首条不在 DOM」「按钮在场」等断言转红。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  ChatTranscript,
  TRANSCRIPT_CLIP_THRESHOLD,
  TRANSCRIPT_CLIP_WINDOW,
  TRANSCRIPT_CLIP_CHUNK,
  resetTranscriptScrollMemoryForTest
} from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';

// 阅读位置记忆是模块级：用例间清空，防上一用例的记忆串到同名 sessionId
beforeEach(() => resetTranscriptScrollMemoryForTest());

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

const baseProps = {
  busy: false,
  sessionId: 's-clip',
  model
};

/** n 条消息（createdAt 递增 1ms，间隔小于时间分隔阈值，无时间条噪音） */
function manyMessages(n: number): Src[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: 'user' as const,
    content: `c${i}`,
    createdAt: i + 1,
    parts: [{ kind: 'text' as const, text: `t${i}` }]
  }));
}

const midCount = (container: HTMLElement): number =>
  container.querySelectorAll('[data-mid]').length;

describe('长转录窗口裁剪（R-23 一期）', () => {
  it('3000 条：只挂尾部窗口——末条在 DOM、首条不在、有「加载更早」', () => {
    const { container } = render(<ChatTranscript {...baseProps} messages={manyMessages(3000)} />);
    expect(container.querySelector('[data-mid="m2999"]')).toBeTruthy(); // 末条在
    expect(container.querySelector('[data-mid="m0"]')).toBeNull(); // 首条不在
    expect(midCount(container)).toBeLessThanOrEqual(TRANSCRIPT_CLIP_WINDOW); // 只挂窗口量
    expect(container.querySelector('.chat-clip-more-btn')).toBeTruthy();
  });

  it('超长会话使用 measured window，并保留前后 spacer', () => {
    const { container } = render(<ChatTranscript {...baseProps} messages={manyMessages(1200)} />);
    expect(container.querySelector('.chat-virtual-spacer-before')).toBeTruthy();
    expect(container.querySelector('.chat-virtual-spacer-after')).toBeNull();
    expect(container.querySelector('[data-mid="m1199"]')).toBeTruthy();
    expect(container.querySelector('[data-mid="m0"]')).toBeNull();
    expect(midCount(container)).toBeLessThanOrEqual(TRANSCRIPT_CLIP_WINDOW);
  });

  it('短会话（<阈值）：无按钮、全量挂载（零行为差异）', () => {
    const { container } = render(
      <ChatTranscript {...baseProps} messages={manyMessages(TRANSCRIPT_CLIP_THRESHOLD)} />
    );
    expect(container.querySelector('.chat-clip-more-btn')).toBeNull();
    expect(midCount(container)).toBe(TRANSCRIPT_CLIP_THRESHOLD);
    expect(container.querySelector('[data-mid="m0"]')).toBeTruthy();
  });

  it('「加载更早」回填一个 CHUNK，视口按高度增量锚定还原', () => {
    const msgs = manyMessages(600);
    const { container } = render(<ChatTranscript {...baseProps} messages={msgs} />);
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    expect(list).toBeTruthy();
    // 高度随挂载行数推导（每行 100px）：模拟回填后内容长高
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => midCount(container) * 100
    });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    // 建立底部跟随基线（jsdom 无布局，mount 时 scrollHeight 尚为 0，手动补），
    // 随后用户滚到顶部点「加载更早」
    list.scrollTop = 120 * 100;
    fireEvent.scroll(list); // 底部带内：保持贴底跟随
    list.scrollTop = 0;
    fireEvent.scroll(list); // 上翻 → 摘除贴底跟随
    expect(container.querySelector('[data-mid="m240"]')).toBeNull(); // 回填边界外
    fireEvent.click(container.querySelector('.chat-clip-more-btn')!);
    // 窗口 120 → 120+240=360：m240 起挂载，m0 仍在裁剪区
    expect(container.querySelector('[data-mid="m240"]')).toBeTruthy();
    expect(container.querySelector('[data-mid="m0"]')).toBeNull();
    expect(midCount(container)).toBe(TRANSCRIPT_CLIP_WINDOW + TRANSCRIPT_CLIP_CHUNK);
    // 锚定还原：prepend 增量 240 行 ×100px，scrollTop 从 0 挪到 24000（阅读位置不跳）
    expect(list.scrollTop).toBe(240 * 100);
  });

  it('服务端仍有更早历史时，把顶部请求交给 range loader', () => {
    const onLoadEarlier = vi.fn();
    const { container } = render(
      <ChatTranscript
        {...baseProps}
        messages={manyMessages(120)}
        hasEarlier
        onLoadEarlier={onLoadEarlier}
      />
    );
    fireEvent.click(container.querySelector('.chat-clip-more-btn')!);
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });

  it('裁剪态流式追加仍贴底（stickBottom 原样）', () => {
    const msgs = manyMessages(600);
    const { container, rerender } = render(
      <ChatTranscript {...baseProps} messages={msgs} busy={false} />
    );
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 6000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    list.scrollTop = 5600; // 底部容差带内
    fireEvent.scroll(list); // 保持贴底跟随
    // 流式回合推进：新 user 消息 + 内容长高
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 9000 });
    rerender(
      <ChatTranscript
        {...baseProps}
        messages={[...msgs, { id: 'm600', role: 'user', content: 'c600', createdAt: 601, parts: [{ kind: 'text', text: 't600' }] }]}
        busy={true}
      />
    );
    expect(list.scrollTop).toBe(9000); // 新内容仍钉在底部
    expect(container.querySelector('[data-mid="m600"]')).toBeTruthy();
    expect(container.querySelector('[data-mid="m0"]')).toBeNull(); // 头部仍裁剪
  });

  it('非尾部阅读时，新增实时消息不会把正在阅读的窗口前缘移出', () => {
    const msgs = manyMessages(600);
    const { container, rerender } = render(
      <ChatTranscript {...baseProps} messages={msgs} busy={false} />
    );
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    let height = 60000;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });

    // Establish a bottom baseline, then move upward so the reader owns the
    // viewport. The old moving-tail window would drop m480 on the next live row.
    list.scrollTop = height - list.clientHeight;
    fireEvent.scroll(list);
    list.scrollTop = 0;
    fireEvent.wheel(list, { deltaY: -120 });
    fireEvent.scroll(list);
    expect(container.querySelector('[data-mid="m480"]')).toBeTruthy();

    height += 100;
    rerender(
      <ChatTranscript
        {...baseProps}
        messages={[
          ...msgs,
          { id: 'm600', role: 'assistant', content: 'live', createdAt: 601, parts: [{ kind: 'text', text: 'live' }] }
        ]}
        busy={false}
      />
    );
    expect(container.querySelector('[data-mid="m480"]')).toBeTruthy();
    expect(container.querySelector('[data-mid="m481"]')).toBeTruthy();
  });

  it('停靠点导航离开尾部时，新增实时消息不会移出当前前缘', () => {
    const msgs = manyMessages(600);
    const { container, rerender } = render(
      <ChatTranscript {...baseProps} messages={msgs} busy={false} />
    );
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    let height = 60000;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    list.scrollTop = height - list.clientHeight;
    fireEvent.scroll(list);

    // The target is already mounted, so this exercises navigateToElement
    // directly without relying on a later wheel/scroll event.
    act(() => {
      list.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'm480' }));
    });
    expect(container.querySelector('[data-mid="m480"]')).toBeTruthy();

    height += 100;
    rerender(
      <ChatTranscript
        {...baseProps}
        messages={[
          ...msgs,
          { id: 'm600', role: 'assistant', content: 'live', createdAt: 601, parts: [{ kind: 'text', text: 'live' }] }
        ]}
        busy={false}
      />
    );
    expect(container.querySelector('[data-mid="m480"]')).toBeTruthy();
  });

  it('压缩分割线：窗口内插对位置；裁剪区的不渲染；running 贴末尾', () => {
    const msgs = manyMessages(600);
    const { container } = render(
      <ChatTranscript
        {...baseProps}
        messages={msgs}
        compactions={[
          { id: 'c-old', status: 'complete', createdAt: 1.5 }, // 在裁剪区（m0/m1 之间）
          { id: 'c-win', status: 'complete', createdAt: 598.5 }, // 窗口内（m597/m598 之间）
          { id: 'c-run', status: 'running', createdAt: 601 }
        ]}
      />
    );
    const col = container.querySelector('.agent-chat-col') as HTMLElement;
    expect(col).toBeTruthy();
    const texts = [...col.querySelectorAll('.chat-compact-sep, [data-mid]')].map((el) => {
      if (el.classList.contains('chat-compact-sep')) return 'COMPACT';
      return el.getAttribute('data-mid');
    });
    // 裁剪区的 c-old 不渲染；c-win 插在 m597 与 m598 之间；c-run 贴流末尾
    expect(texts.filter((x) => x === 'COMPACT').length).toBe(2);
    const iWin = texts.indexOf('COMPACT');
    expect(texts[iWin - 1]).toBe('m597');
    expect(texts[iWin + 1]).toBe('m598');
    expect(texts[texts.length - 1]).toBe('COMPACT');
  });

  it('停靠点跳转 reveal：目标在裁剪区时扩窗挂载并滚动定位', () => {
    const msgs = manyMessages(600);
    const { container } = render(<ChatTranscript {...baseProps} messages={msgs} />);
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    expect(container.querySelector('[data-mid="m10"]')).toBeNull(); // 初始不在窗口
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    act(() => {
      list.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'm10' }));
    });
    // 扩窗覆盖目标：m10 挂载，并平滑滚动定位到其锚点
    expect(container.querySelector('[data-mid="m10"]')).toBeTruthy();
    const target = container.querySelector('[data-mid="m10"]');
    expect(measured.mock.contexts).toContain(target); // revealed row owns bounded navigation
    measured.mockRestore();
  });

  it('停靠点跳转 reveal：目标未加载时先回填，再重新定位', async () => {
    const all = manyMessages(600);
    const tail = all.slice(480);
    let rerender!: ReturnType<typeof render>['rerender'];
    let release!: () => void;
    const onEnsureMessageLoaded = vi.fn(() => new Promise<boolean>((resolve) => {
      release = () => {
        rerender(<ChatTranscript {...baseProps} messages={all} onEnsureMessageLoaded={onEnsureMessageLoaded} />);
        queueMicrotask(() => resolve(true));
      };
    }));
    const rendered = render(
      <ChatTranscript {...baseProps} messages={tail} onEnsureMessageLoaded={onEnsureMessageLoaded} />
    );
    rerender = rendered.rerender;
    const list = rendered.container.querySelector('.chat-list') as HTMLDivElement;
    expect(rendered.container.querySelector('[data-mid="m10"]')).toBeNull();

    act(() => {
      list.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'm10' }));
    });
    expect(onEnsureMessageLoaded).toHaveBeenCalledWith('m10');
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector('[data-mid="m10"]')).toBeTruthy();
  });

  it('search hit outside loaded history loads and reveals its message', async () => {
    const all = manyMessages(600);
    const findActive = { messageId: 'm10', indexInMessage: 0 };
    let rerender!: ReturnType<typeof render>['rerender'];
    const onEnsureMessageLoaded = vi.fn(async () => {
      rerender(<ChatTranscript {...baseProps} messages={all} findActive={findActive}
        findQuery="c10" onEnsureMessageLoaded={onEnsureMessageLoaded} />);
      return true;
    });
    const rendered = render(<ChatTranscript {...baseProps} messages={all.slice(480)}
      findActive={findActive} findQuery="c10" onEnsureMessageLoaded={onEnsureMessageLoaded} />);
    rerender = rendered.rerender;
    expect(rendered.container.querySelector('[data-mid="m10"]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(onEnsureMessageLoaded).toHaveBeenCalledWith('m10');
    expect(rendered.container.querySelector('[data-mid="m10"]')).toBeTruthy();
  });

  it('切会话：窗口重置回初始大小', () => {
    const msgs = manyMessages(600);
    const { container, rerender } = render(
      <ChatTranscript {...baseProps} messages={msgs} sessionId="s-a" />
    );
    fireEvent.click(container.querySelector('.chat-clip-more-btn')!);
    expect(container.querySelector('[data-mid="m240"]')).toBeTruthy(); // 已回填
    rerender(<ChatTranscript {...baseProps} messages={msgs} sessionId="s-b" />);
    expect(container.querySelector('[data-mid="m240"]')).toBeNull(); // 重置回初始窗口
    expect(midCount(container)).toBe(TRANSCRIPT_CLIP_WINDOW);
  });

  it('隐藏保活页停止行高观测，不把零高度写进虚拟坐标', () => {
    const observers: Array<{ targets: Element[] }> = [];
    const original = globalThis.ResizeObserver;
    vi.stubGlobal('ResizeObserver', class {
      targets: Element[] = [];
      constructor() { observers.push(this); }
      observe(target: Element) { this.targets.push(target); }
      unobserve() {}
      disconnect() { this.targets = []; }
    });
    const messages = manyMessages(3000);
    const rendered = render(<ChatTranscript {...baseProps} messages={messages} interactionActive />);
    const watchedRows = () => observers.flatMap(observer => observer.targets).filter(target => target.hasAttribute('data-stream-index'));
    expect(watchedRows().length).toBeGreaterThan(0);
    rendered.rerender(<ChatTranscript {...baseProps} messages={messages} interactionActive={false} />);
    expect(watchedRows()).toHaveLength(0);
    rendered.unmount();
    vi.stubGlobal('ResizeObserver', original);
  });

  it('稀疏行源：一次定位远处历史、释放正文后保持绝对占位、补页后原位显示', async () => {
    const all = manyMessages(10000);
    const tail = all.slice(-120);
    const target = all.slice(2340, 2460);
    const retain = vi.fn();
    let loaded = tail;
    const page = () => ({
      generation: 1, total: 10000,
      slots: loaded.map(message => ({ index: Number(message.id.slice(1)), messageId: message.id })),
      loadedRanges: [], cursor: {}, loadState: {
        tail: { status: 'loaded' as const, generation: 1 },
        earlier: { status: 'idle' as const, generation: 1 }, later: { status: 'idle' as const, generation: 1 }
      }
    });
    const index = (id: string) => loaded.some(message => message.id === id) ? Number(id.slice(1)) : undefined;
    let rerender!: ReturnType<typeof render>['rerender'];
    const ensure = vi.fn(async () => {
      loaded = [...target, ...tail];
      rerender(view());
      return true;
    });
    const view = () => <ChatTranscript {...baseProps} messages={loaded} page={page()} messageIndex={index}
      onEnsureMessageLoaded={ensure} onVirtualWindow={retain} />;
    const rendered = render(view());
    rerender = rendered.rerender;
    const list = rendered.container.querySelector('.chat-list') as HTMLElement;
    Object.defineProperties(list, { clientHeight: { get: () => 600 }, scrollHeight: { get: () => 1160000 } });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      return new DOMRect(0, this.dataset.streamIndex === undefined ? 0 : Number(this.dataset.streamIndex) * 116 - list.scrollTop,
        800, this === list ? 600 : 96);
    });
    expect(rendered.container.querySelector('[data-mid="m9999"]')).toBeTruthy();
    await act(async () => {
      rendered.container.querySelector('.chat-list')!.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'm2400' }));
      await Promise.resolve();
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector('[data-mid="m2400"]')?.getAttribute('data-stream-index')).toBe('2400');
    expect((rendered.container.querySelector('.chat-list') as HTMLElement).scrollTop).toBeGreaterThan(100000);
    expect(midCount(rendered.container)).toBeLessThanOrEqual(120);
    loaded = tail;
    rerender(view());
    expect(rendered.container.querySelector('[data-mid="m2400"]')).toBeNull();
    expect(rendered.container.querySelector('[data-history-gap="2400"]')?.getAttribute('data-stream-index')).toBe('2400');
    loaded = [...target, ...tail];
    rerender(view());
    expect(rendered.container.querySelector('[data-mid="m2400"]')).toBeTruthy();
    expect(retain.mock.lastCall?.[0].start).toBeLessThanOrEqual(2400);
    expect(retain.mock.lastCall?.[0].end).toBeGreaterThan(2400);
    geometry.mockRestore();
  });
});
