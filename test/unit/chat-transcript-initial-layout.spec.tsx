import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript, resetTranscriptScrollMemoryForTest } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';
import type { ChatSurface } from '../../src/shared/chatSurface';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/components/ChatMessageView', () => ({
  ChatMessageView: ({ message }: { message: ChatMessage }) => <p>{message.content}</p>
}));
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
vi.mock('../../src/renderer/src/components/AgentComposer', () => ({ AgentComposer: () => <div>输入条</div> }));

const model = { toDisplay: (message: ChatMessage) => message };
const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, role: 'user', createdAt: 1, content: `正文 ${i}` }));
let frames: Map<number, FrameRequestCallback>;
let writes: string[][];
let overlayWrites: string[];
let composerHeight: number;
function frame() {
  const batch = [...frames.values()]; frames.clear();
  act(() => batch.forEach(callback => callback(performance.now())));
}

beforeEach(() => {
  resetTranscriptScrollMemoryForTest(); frames = new Map(); writes = []; overlayWrites = []; composerHeight = 124;
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++next, callback); return next; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.chat-list') ? 400 : 0; });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.matches('.agent-chat-composer-wrap')) return composerHeight;
    return this.matches('.chat-turn-anchor') ? (this.classList.contains('chat-positioning-row') ? 250 : 88) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    const root = this.closest<HTMLElement>('.chat-surface-view');
    const overlay = root ? Number.parseFloat(root.style.getPropertyValue('--composer-overlay-h') || '120') : 0;
    return this.matches('.chat-list') ? this.querySelectorAll('[data-mid]').length * 250 + overlay : 0;
  });
  const tops = new WeakMap<HTMLElement, number>();
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value) {
    tops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
    if (this.matches('.chat-list') && this.querySelector('[data-mid]')) {
      writes.push([...this.querySelectorAll<HTMLElement>('.chat-positioning-row')].map(row => row.dataset.mid!));
      overlayWrites.push(this.closest<HTMLElement>('.chat-surface-view')?.style.getPropertyValue('--composer-overlay-h') ?? '');
    }
  });
});
afterEach(() => vi.restoreAllMocks());

describe('首次贴底的真实高度准备', () => {
  it('带文件卡的会话等快照校验完成后即时定位再显示', async () => {
    const summary = { id: 'snapshot', state: 'ready' as const, warnings: [], files: [
      { path: 'file.ts', kind: 'modified' as const, added: 1, removed: 0, revertible: true }
    ] };
    const withSnapshot = [...messages, { id: 'review', role: 'assistant' as const, createdAt: 1, content: '完成', turnChanges: summary }];
    let resolve!: (result: unknown) => void;
    currentApiMock().mockOf('turnChanges.list').mockReturnValue(new Promise(result => { resolve = result; }));
    const snapshot = { messages: withSnapshot, busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null };
    const surface: ChatSurface = { sessionId: 'snapshot-first', caps: { surfaceKind: 'dispatch', draftKey: 'snapshot-first', images: false },
      subscribe: () => () => {}, getSnapshot: () => snapshot,
      actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} } };
    const view = render(<StoreProvider><ChatSurfaceView surface={surface} findEnabled={false} /></StoreProvider>);
    const list = view.container.querySelector<HTMLElement>('.chat-list')!;
    expect(list.style.visibility).toBe('hidden');
    await act(async () => { resolve({ ok: true, entries: [{ target: { kind: 'dispatch', id: 'snapshot-first', messageId: 'review' }, summary }] }); });
    expect(list.style.visibility).toBe('');
    expect(list.scrollTop).toBe(list.scrollHeight - list.clientHeight);
    view.unmount();
  });
  it('重会话折叠后首批不足一屏：绘制前补足视口，其余历史继续分帧', () => {
    const heavy = messages.map(message => ({ ...message,
      parts: Array.from({ length: 50 }, () => ({ kind: 'text' as const, text: '折叠步骤' })) }));
    const view = render(<ChatTranscript sessionId="initial-heavy" model={model} busy={false} messages={heavy} />);
    const list = view.container.querySelector<HTMLElement>('.chat-list')!;
    // One 50-part row fits the 64-part budget but is only 250px high in a 400px viewport.
    expect(list.querySelectorAll('[data-mid]').length).toBeGreaterThan(1);
    expect(list.querySelectorAll('[data-mid]').length).toBeLessThan(heavy.length);
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(list.scrollTop).toBe(list.scrollHeight - list.clientHeight);
    frame();
    expect(list.scrollTop).toBe(list.scrollHeight - list.clientHeight);
    view.unmount();
  });

  it('单条消息超出分帧预算时仍推进到下一整行，隐藏期不填充视口', () => {
    const heavy = messages.map(message => ({ ...message,
      parts: Array.from({ length: 1000 }, () => ({ kind: 'text' as const, text: '折叠步骤' })) }));
    const props = { sessionId: 'initial-large-row', model, busy: false, messages: heavy };
    const view = render(<ChatTranscript {...props} interactionActive={false} />);
    const list = view.container.querySelector<HTMLElement>('.chat-list')!;
    expect(list.querySelectorAll('[data-mid]')).toHaveLength(1);
    view.rerender(<ChatTranscript {...props} interactionActive />);
    expect(list.querySelectorAll('[data-mid]')).toHaveLength(2);
    expect(list.scrollTop).toBe(100);
    view.unmount();
  });

  it('分帧补入历史时，跟随态在绘制前贴底，不让浏览器的旧阅读锚点接管', () => {
    const heavy = messages.map(message => ({ ...message,
      parts: Array.from({ length: 50 }, () => ({ kind: 'text' as const, text: '步骤' })) }));
    const view = render(<ChatTranscript sessionId="initial-follow" model={model} busy={false} messages={heavy} />);
    const list = view.container.querySelector<HTMLElement>('.chat-list')!;
    const previous = document.elementFromPoint;
    // Model browser anchoring keeping the same visible message in place after a prepend.
    document.elementFromPoint = () => list.querySelector('[data-mid]');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top: this === list ? 100 : 92, left: 0, width: 500, height: 400 } as DOMRect;
    });
    try {
      const before = list.scrollTop;
      frame();
      expect(list.scrollTop).toBeGreaterThan(before);
      expect(list.scrollTop).toBe(list.scrollHeight - list.clientHeight);
    } finally {
      document.elementFromPoint = previous;
      view.unmount();
    }
  });

  it.each([124, 188])('真实 ChatSurface 首次贴底前已同步 %ipx 输入条高度，重挂不再用 120px 占位', height => {
    composerHeight = height;
    const snapshot = { messages, busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null };
    const surface: ChatSurface = { sessionId: 'overlay-first', caps: { surfaceKind: 'dispatch', draftKey: 'overlay-first', images: false },
      subscribe: () => () => {}, getSnapshot: () => snapshot,
      actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} } };
    const mount = () => render(<StoreProvider><ChatSurfaceView surface={surface} findEnabled={false} /></StoreProvider>);
    for (let i = 0; i < 2; i++) {
      overlayWrites = [];
      const view = mount();
      expect(overlayWrites[0]).toBe(`${height}px`); // Parent layout effects alone run too late.
      expect(view.container.querySelector<HTMLElement>('.chat-list')!.scrollTop).toBe(4600 + height);
      frame(); frame();
      expect(view.container.querySelector<HTMLElement>('.chat-list')!.scrollTop).toBe(4600 + height);
      view.unmount();
    }
  });

  it('打开后异步历史到达：在第一次写 scrollTop 前仅实现尾部一屏，并在首帧后释放', () => {
    const props = { sessionId: 'initial', model, busy: false };
    const view = render(<ChatTranscript {...props} messages={[]} interactionActive={false} />);
    view.rerender(<ChatTranscript {...props} messages={[]} interactionActive />);
    view.rerender(<ChatTranscript {...props} messages={messages} interactionActive />);
    expect(writes[0]).toEqual(['m18', 'm19']); // Removing the fix must fail here.
    const list = view.container.querySelector<HTMLElement>('.chat-list')!;
    expect(list.scrollTop).toBe(4600);
    frame(); expect(list.querySelectorAll('.chat-positioning-row')).toHaveLength(2);
    frame(); expect(list.querySelector('.chat-positioning-row')).toBeNull();
    // Normal streaming updates do not repeatedly realize skipped rows.
    writes = [];
    view.rerender(<ChatTranscript {...props} messages={[...messages]} interactionActive />);
    expect(writes.at(-1)).toEqual([]);
    view.unmount();
  });

  it.each(['hide', 'unmount', 'pointer'] as const)('%s 及时取消首屏准备与待释放帧', kind => {
    const props = { sessionId: 'cancel-initial', model, messages, busy: false };
    const view = render(<ChatTranscript {...props} />);
    const list = view.container.querySelector<HTMLElement>('.chat-list')!;
    expect(list.querySelectorAll('.chat-positioning-row')).toHaveLength(2);
    if (kind === 'hide') view.rerender(<ChatTranscript {...props} interactionActive={false} />);
    else if (kind === 'pointer') fireEvent.pointerDown(list);
    else view.unmount();
    expect(list.querySelector('.chat-positioning-row')).toBeNull();
    const remaining = frames.size;
    frame(); expect(frames.size).toBeLessThanOrEqual(remaining);
    if (kind === 'hide') {
      writes = [];
      view.rerender(<ChatTranscript {...props} interactionActive />);
      expect(writes.at(-1)).toEqual(['m18', 'm19']);
    }
    if (kind !== 'unmount') view.unmount();
  });
});
