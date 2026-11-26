/**
 * 会话历史面板交互契约（2026-09-15 改版回归）：
 * 旧交互「悬浮划览实时滚动 + 点击跳转即关面板」改为：
 * 1) 悬浮条目不触发滚动，只在面板上方统一显示该条完整内容预览气泡；
 * 2) 点击条目平滑跳转且面板不自动关闭（可连续翻看）；
 * 3) 关闭只走点面板外空白 / ✕（Escape 由 useOverlayDismiss 栈兜底，此处不重测）。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';
import { ChatHistoryPanel } from '../../src/renderer/src/chatSurface/ChatHistoryPanel';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import { dispatchTranscriptBinding } from '../../src/renderer/src/chatSurface/guiMessageView';
import type { TurnRailStop } from '../../src/shared/chatTurnRail';
import type { ChatMessage } from '../../src/shared/types';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

vi.stubGlobal('ResizeObserver', class {
  observe(): void {}
  disconnect(): void {}
});

const stops: TurnRailStop[] = [
  { id: 'u1', ts: 1, prompt: '第一轮的完整提问内容，比较长一些用于预览气泡验证', reply: 'r1', hasImages: false },
  { id: 'u2', ts: 2, prompt: '第二轮提问', reply: 'r2', hasImages: false }
];

function setup() {
  const list = document.createElement('div');
  for (const s of stops) {
    const anchor = document.createElement('div');
    anchor.setAttribute('data-mid', s.id);
    list.appendChild(anchor);
  }
  document.body.appendChild(list);
  const scrollTo = vi.fn();
  list.scrollTo = scrollTo;
  const scrollRef = { current: list };
  const onClose = vi.fn();
  const view = render(
    <ChatHistoryPanel stage="in" historyId="test-history" stops={stops} scrollRef={scrollRef} onClose={onClose} />
  );
  return { view, scrollTo, onClose, list };
}

describe('会话历史面板（悬浮预览 + 点击跳转不关面板）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    localStorage.clear();
    dismissTip();
    vi.useRealTimers();
  });

  it('收藏按钮独立于跳转，筛选可开启或关闭，取消最后一条收藏后保留键盘焦点', () => {
    const { scrollTo, onClose } = setup();
    const filter = screen.getByRole('button', { name: '仅看收藏' });
    const star = screen.getByRole('button', { name: '收藏消息「第二轮提问」' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(star);
    expect(star.getAttribute('aria-pressed')).toBe('true');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: stops[0]!.prompt })).toBeNull();
    expect(screen.getByRole('button', { name: '第二轮提问' })).toBeTruthy();
    star.focus();
    fireEvent.click(star);
    expect(document.activeElement).toBe(filter);
    expect(screen.queryByRole('button', { name: '第二轮提问' })).toBeNull();
    expect(screen.getByText('暂无收藏的消息')).toBeTruthy();
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: stops[0]!.prompt })).toBeTruthy();
    expect(screen.getByRole('button', { name: '收藏消息「第二轮提问」' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('复制旁的收藏按钮与历史筛选双向同步，点击时不触发复制或分叉', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: '要收藏的提问', createdAt: 1 },
      { id: 'u2', role: 'user', content: '另一条提问', createdAt: 2 }
    ];
    const onFork = vi.fn();
    const model = dispatchTranscriptBinding('ws-history');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const { container } = render(
        <ChatTranscript sessionId="quick-favorite" model={model} messages={messages} busy={false} onFork={onFork} />
      );
      const anchor = container.querySelector<HTMLElement>('[data-mid="u1"]')!;
      const actions = within(anchor);
      const copy = actions.getByRole('button', { name: '复制内容' });
      const bookmark = actions.getByRole('button', { name: '收藏' });
      expect(copy.nextElementSibling).toBe(bookmark);
      expect(bookmark.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(bookmark);
      expect(bookmark.getAttribute('aria-pressed')).toBe('true');

      fireEvent.contextMenu(anchor);
      const history = within(screen.getByRole('dialog', { name: '会话历史' }));
      fireEvent.click(history.getByRole('button', { name: '仅看收藏' }));
      expect(history.getByRole('button', { name: '要收藏的提问' })).toBeTruthy();
      expect(history.queryByRole('button', { name: '另一条提问' })).toBeNull();
      const historyBookmark = history.getByRole('button', { name: '收藏消息「要收藏的提问」' });
      expect(historyBookmark.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(historyBookmark);
      expect(history.getByText('暂无收藏的消息')).toBeTruthy();
      expect(bookmark.getAttribute('aria-pressed')).toBe('false');
      expect(writeText).not.toHaveBeenCalled();
      expect(onFork).not.toHaveBeenCalled();
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('消息操作条读取已有历史收藏，且只给可进入历史的人工提问提供收藏', () => {
    localStorage.setItem('muster.chat-history-favorites.v1:history-with-existing-favorites', JSON.stringify([
      { id: 'user', ts: 1, prompt: '已收藏的提问' }
    ]));
    const messages: ChatMessage[] = [
      { id: 'user', role: 'user', content: '已收藏的提问', createdAt: 1 },
      { id: 'reply', role: 'assistant', content: '回复', createdAt: 2 },
      { id: 'scheduled', role: 'user', content: '调度注入', createdAt: 3, source: 'scheduler' },
      { id: 'queued', role: 'user', content: '还在排队', createdAt: 4, queued: true }
    ];
    const props = {
      sessionId: 'history-with-existing-favorites',
      model: dispatchTranscriptBinding('ws-history'),
      busy: false
    };
    const { container, rerender } = render(<ChatTranscript {...props} messages={messages} />);
    const bookmark = screen.getByRole('button', { name: '收藏' });
    expect(bookmark.closest('[data-mid]')).toBe(container.querySelector('[data-mid="user"]'));
    expect(bookmark.getAttribute('aria-pressed')).toBe('true');

    const sent = [...messages.slice(0, -1), { ...messages[3]!, queued: false }];
    rerender(<ChatTranscript {...props} messages={sent} />);
    const sentAnchor = container.querySelector<HTMLElement>('[data-mid="queued"]')!;
    expect(within(sentAnchor).getByRole('button', { name: '收藏' })).toBeTruthy();
    fireEvent.contextMenu(sentAnchor);
    expect(within(screen.getByRole('dialog', { name: '会话历史' }))
      .getByRole('button', { name: '还在排队' })).toBeTruthy();
  });

  it('收藏按会话持久化，重挂后从收藏尝试加载旧消息并提示找不到的结果', async () => {
    const first: ChatMessage = { id: 'u1', role: 'user', content: '较早的提问', createdAt: 1 };
    const last: ChatMessage = { id: 'u2', role: 'user', content: '最新的提问', createdAt: 2 };
    const model = dispatchTranscriptBinding('ws-history');
    const ensureMessageLoaded = vi.fn(async () => false);
    const transcript = (sessionId: string, messages: ChatMessage[]) =>
      <ChatTranscript sessionId={sessionId} model={model} messages={messages} busy={false} onEnsureMessageLoaded={ensureMessageLoaded} />;
    const openHistory = (view: ReturnType<typeof render>, id: string) => {
      fireEvent.contextMenu(view.container.querySelector(`[data-mid="${id}"]`)!);
    };
    const firstView = render(transcript('history-a', [first, last]));
    openHistory(firstView, 'u1');
    fireEvent.click(screen.getByRole('button', { name: '收藏消息「较早的提问」' }));
    firstView.unmount();

    const otherView = render(transcript('history-b', [first, last]));
    openHistory(otherView, 'u1');
    fireEvent.click(screen.getByRole('button', { name: '仅看收藏' }));
    expect(screen.getByText('暂无收藏的消息')).toBeTruthy();
    otherView.unmount();

    const reopened = render(transcript('history-a', [last]));
    openHistory(reopened, 'u2');
    expect(screen.queryByRole('button', { name: first.content })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '仅看收藏' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: first.content }));
    });
    expect(ensureMessageLoaded).toHaveBeenCalledExactlyOnceWith(first.id);
    expect(getTipSnapshot()?.text).toBe('无法打开这条历史消息');
    expect(screen.getByRole('dialog', { name: '会话历史' })).toBeTruthy();
  });

  it('收藏保存失败时提示错误并保留原有状态', () => {
    setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('No storage space', 'QuotaExceededError');
    });
    try {
      const star = screen.getByRole('button', { name: '收藏消息「第二轮提问」' });
      fireEvent.click(star);
      expect(star.getAttribute('aria-pressed')).toBe('false');
      expect(getTipSnapshot()?.text).toBe('无法保存会话历史收藏');
    } finally {
      setItem.mockRestore();
    }
  });

  it('悬浮条目不滚动转写，预览气泡显示该条完整内容', () => {
    const { scrollTo } = setup();
    fireEvent.mouseEnter(screen.getByText('第二轮提问'));
    expect(scrollTo).not.toHaveBeenCalled(); // 划览已取消：悬浮零滚动
    const preview = document.querySelector('.chat-history-preview');
    expect(preview).toBeTruthy();
    expect(preview?.textContent).toContain('第二轮提问');
    expect(preview?.textContent).toContain('r2');
    // 离开列表：气泡走 mp-pop 退场（menuMs+兜底），动画结束后卸载，全程无滚动
    fireEvent.mouseLeave(document.querySelector('.chat-history-list')!);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.querySelector('.chat-history-preview')).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('提问和回复预览渲染 Markdown，悬浮切换时更新内容且不触发导航', () => {
    const markdownStops: TurnRailStop[] = [
      { id: 'md1', ts: 1, prompt: '请看 **重点**', reply: '**结论**\n\n| 项目 | 状态 |\n| --- | --- |\n| 功能 | 完成 |\n\n[链接](https://example.com)', hasImages: false },
      { id: 'md2', ts: 2, prompt: '另一条', reply: '`代码`', hasImages: false }
    ];
    const onNavigate = vi.fn();
    const view = render(<ChatHistoryPanel stage="in" historyId="test-history" stops={markdownStops} scrollRef={{ current: document.createElement('div') }} onNavigate={onNavigate} onClose={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: '请看 **重点**' }));
    const prompt = view.container.querySelector('.chat-history-preview-prompt')!;
    const reply = view.container.querySelector('.chat-history-preview-reply')!;
    expect(prompt.querySelector('strong')?.textContent).toBe('重点');
    expect(reply.querySelector('strong')?.textContent).toBe('结论');
    expect(reply.querySelector('table')?.textContent).toContain('完成');
    expect(reply.querySelector('a')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: '另一条' }));
    expect(view.container.querySelector('.chat-history-preview-reply code')?.textContent).toBe('代码');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('点击条目跳转且面板不自动关闭', () => {
    const { scrollTo, onClose } = setup();
    fireEvent.click(screen.getByText('第一轮的完整提问内容，比较长一些用于预览气泡验证'));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    expect(onClose).not.toHaveBeenCalled(); // 不自动关
    expect(document.querySelector('.chat-history')).toBeTruthy();
  });

  it('提供转写导航时，已挂载和未挂载目标均交给统一控制器且不关闭面板', () => {
    const list = document.createElement('div');
    const anchor = document.createElement('div'); anchor.dataset.mid = 'u1'; list.append(anchor); document.body.append(list);
    list.scrollTo = vi.fn(); const onNavigate = vi.fn(), onClose = vi.fn();
    const reveal = vi.fn(); list.addEventListener('chat-clip:reveal', reveal);
    render(<ChatHistoryPanel stage="in" historyId="test-history" stops={stops} scrollRef={{ current: list }} onNavigate={onNavigate} onClose={onClose} />);
    fireEvent.click(screen.getByText(stops[0]!.prompt)); fireEvent.click(screen.getByText(stops[1]!.prompt));
    expect(onNavigate.mock.calls).toEqual([['u1'], ['u2']]);
    expect(list.scrollTo).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  it('目标锚点不在 DOM（长转录窗口裁剪）：派发 chat-clip:reveal 请转写层扩窗，不直接滚动', () => {
    // 只挂 u1 的锚点：u2 在未挂载区（裁剪态），点击应走 reveal 兜底
    const list = document.createElement('div');
    const anchor = document.createElement('div');
    anchor.setAttribute('data-mid', 'u1');
    list.appendChild(anchor);
    document.body.appendChild(list);
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo;
    const revealSpy = vi.fn();
    list.addEventListener('chat-clip:reveal', revealSpy);
    render(
      <ChatHistoryPanel
        stage="in"
        historyId="test-history"
        stops={stops}
        scrollRef={{ current: list }}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('第二轮提问'));
    expect(revealSpy).toHaveBeenCalledTimes(1);
    expect((revealSpy.mock.calls[0]![0] as CustomEvent<string>).detail).toBe('u2');
    expect(scrollTo).not.toHaveBeenCalled(); // 未挂载目标不盲滚
  });

  it('点击面板外空白关闭', () => {
    const { onClose } = setup();
    fireEvent.mouseDown(document.body); // body 不在 .chat-history 内
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('✕ 关闭', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('打开时只滚动历史列表到来源消息，重复打开时重新闪烁', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains('chat-history-list') ? 100 : this.textContent?.includes('第二轮提问') ? 400 : 150;
      return { top, height: 30, bottom: top + 30, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) };
    });
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(130);
    const list = document.createElement('div');
    const view = render(<ChatHistoryPanel stage="in" historyId="test-history" stops={stops} origin={{ id: 'u2', sequence: 1 }} scrollRef={{ current: list }} onClose={vi.fn()} />);
    const historyList = view.container.querySelector<HTMLDivElement>('.chat-history-list')!;
    expect(historyList.scrollTop).toBe(250);
    const second = screen.getByRole('button', { name: '第二轮提问' });
    const flash = second.querySelector('.chat-history-origin-flash');
    expect(flash).toBeTruthy();
    expect(list.scrollTop).toBe(0);
    view.rerender(<ChatHistoryPanel stage="in" historyId="test-history" stops={stops} origin={{ id: 'u2', sequence: 2 }} scrollRef={{ current: list }} onClose={vi.fn()} />);
    expect(second.querySelector('.chat-history-origin-flash')).not.toBe(flash);
    view.rerender(<ChatHistoryPanel stage="in" historyId="test-history" stops={stops} origin={{ id: 'u1', sequence: 3 }} scrollRef={{ current: list }} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: stops[0]!.prompt }).querySelector('.chat-history-origin-flash')).toBeTruthy();
    expect(second.querySelector('.chat-history-origin-flash')).toBeNull();
    rect.mockRestore();
    height.mockRestore();
  });

  it('调度 Agent 转写右键提问可打开历史，悬浮显示最后一段 AI 正文并随同条消息更新', () => {
    const user: ChatMessage = {
      id: 'dispatch-u1', role: 'user', content: '帮我检查',
      createdAt: 1
    };
    const assistant = (last: string): ChatMessage => ({
      id: 'dispatch-a1', role: 'assistant', content: `开头${last}`,
      parts: [{ kind: 'text', text: '开头' }, { kind: 'thinking', text: '分析' }, { kind: 'text', text: last }],
      createdAt: 2
    });
    const model = dispatchTranscriptBinding('ws-history');
    const view = render(
      <ChatTranscript sessionId="dispatch-history" model={model} messages={[user, assistant('原末段')]} busy={false} />
    );
    const anchor = view.container.querySelector('[data-mid="dispatch-u1"]')!;
    expect(anchor.classList.contains('is-history-trigger')).toBe(true);
    fireEvent.contextMenu(anchor);
    expect(screen.getByRole('dialog', { name: '会话历史' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '帮我检查' }).querySelector('.chat-history-origin-flash')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole('button', { name: '帮我检查' }));
    expect(view.container.querySelector('.chat-history-preview-reply')?.textContent).toBe('原末段');
    view.rerender(
      <ChatTranscript sessionId="dispatch-history" model={model} messages={[user, assistant('新末段')]} busy={false} />
    );
    expect(view.container.querySelector('.chat-history-preview-reply')?.textContent).toBe('新末段');
  });
});
