/**
 * ChatTranscript ResizeObserver 防抖契约（2026-09-15 卡顿普查回归）：
 * 普查发现任何面板开/合动画让中央列宽度逐帧变化，转录自挂的 ResizeObserver
 * 逐帧触发 layoutTick/notePos setState，全部常驻 surface 一次折叠风暴式重渲
 * ~100 次（会话栏折叠长任务 475ms 的主因之一）。契约：
 * 1) RO 逐帧风暴（动画形态）期间转录不得重渲；
 * 2) 尺寸静默 120ms 后补测恰好一轮（批注角标最终归位），不丢失重测量。
 * 这里 ChatMessageView 用裸函数 mock（本测的是转录自身渲染频率，与行级 memo 契约
 * 分开分账——那边必须保 memo 语义，见 chat-transcript-memo.spec.tsx）。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { TranscriptModelBinding, TranscriptNote } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';

const { msgMock } = vi.hoisted(() => ({
  // 裸函数：随宿主每次渲染连跑，充当转录渲染次数计数器
  msgMock: vi.fn(({ message }: { message: { id: string } }) => (
    <div data-msg={message.id}>
      <span className="msg-note-anchor" data-note-id={`note-${message.id}`} />
    </div>
  ))
}));

vi.mock('../../src/renderer/src/components/ChatMessageView', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/renderer/src/components/ChatMessageView')
  >('../../src/renderer/src/components/ChatMessageView');
  return { ...actual, ChatMessageView: msgMock };
});

// 可控 ResizeObserver：记录实例供测试逐帧触发（jsdom 无实现）
const { roInstances } = vi.hoisted(() => ({ roInstances: [] as Array<{ fire: () => void }> }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    private cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      roInstances.push({ fire: () => this.cb() });
    }
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
  toDisplay: (m) => m as unknown as ChatMessage,
  messagesEqual: (a, b) => a.id === b.id && a.content === b.content,
  getInlineCards: () => ({})
};

const notes: TranscriptNote[] = [
  { id: 'note-m1', seq: 1, quote: 'q', note: 'n', messageId: 'm1' }
];

const baseProps = {
  busy: false,
  sessionId: 's-perf',
  model,
  notes,
  onFileLink: (): void => {}
};

const callsFor = (id: string): number =>
  msgMock.mock.calls.filter((c: [{ message: { id: string } }]) => c[0].message.id === id)
    .length;

describe('ChatTranscript RO 防抖（性能回归）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    msgMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('RO 逐帧风暴（面板开合动画形态）不得触发转录重渲', () => {
    const m1: Src = { id: 'm1', role: 'user', content: 'a' };
    const m2: Src = { id: 'm2', role: 'assistant', content: 'b' };
    const view = render(<ChatTranscript {...baseProps} messages={[m1, m2]} />);
    expect(callsFor('m1')).toBeGreaterThan(0);
    msgMock.mockClear();
    // 50 帧连续触发（帧间隔 16ms，远不满 120ms 静默阈值）
    act(() => {
      for (let i = 0; i < 50; i++) {
        roInstances.forEach((ro) => ro.fire());
        vi.advanceTimersByTime(16);
      }
    });
    expect(callsFor('m1')).toBe(0);
    expect(callsFor('m2')).toBe(0);
    view.unmount();
  });

  it('尺寸静默 120ms 后补测恰好一轮（角标归位不丢失）', () => {
    const m1: Src = { id: 'm1', role: 'user', content: 'a' };
    const view = render(<ChatTranscript {...baseProps} messages={[m1]} />);
    const root = view.container.querySelector('.chat-list') as HTMLElement;
    const qs = vi.spyOn(root, 'querySelectorAll');
    msgMock.mockClear();
    qs.mockClear();
    act(() => {
      roInstances.forEach((ro) => ro.fire());
      vi.advanceTimersByTime(119);
    });
    expect(callsFor('m1')).toBe(0); // 未过静默阈值不补测
    expect(qs).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2); // 越过 120ms：layoutTick 触发一轮量位
    });
    expect(qs.mock.calls.some((c) => String(c[0]).includes('msg-note-anchor'))).toBe(true);
    // 量位与上次相同（jsdom 矩形恒 0）则不必再打穿 ChatMessageView
    expect(callsFor('m1')).toBeLessThanOrEqual(2);
    view.unmount();
  });
});

// ---------- 批注量位流式节流（P1-1）----------
// 契约：流式期（busy=true）消息逐批变化不再逐批强制量位（deps 已无 messages）；
// busy 翻 false 终帧补量恰一轮（角标校正到最终正文位置）。
// 还原即红：deps 加回 messages（回滚一行）→「流式期不重跑」断言转红；
// 摘掉 busy 翻转补量 →「终帧 +1」断言转红。
describe('批注量位流式节流（P1-1）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    msgMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式期消息逐批变化不重跑量位；busy 翻 false 终帧补量恰一轮', () => {
    const u: Src = { id: 'u1', role: 'user', content: 'q' };
    const m1: Src = { id: 'm1', role: 'assistant', content: 'a' };
    const streamingProps = { ...baseProps, busy: true };
    const view = render(<ChatTranscript {...streamingProps} messages={[u, m1]} />);
    const root = view.container.querySelector('.chat-list') as HTMLElement;
    const qs = vi.spyOn(root, 'querySelectorAll');
    const anchorRuns = () =>
      qs.mock.calls.filter((c) => String(c[0]).includes('msg-note-anchor')).length;
    const mountRuns = anchorRuns(); // 挂载轮（notes 在场即量位一次）
    msgMock.mockClear();
    // 流式期：三批正文变化（旧实现每批一次强制量位）
    view.rerender(<ChatTranscript {...streamingProps} messages={[u, { ...m1, content: 'a1' }]} />);
    view.rerender(<ChatTranscript {...streamingProps} messages={[u, { ...m1, content: 'a2' }]} />);
    view.rerender(<ChatTranscript {...streamingProps} messages={[u, { ...m1, content: 'a3' }]} />);
    expect(anchorRuns()).toBe(mountRuns);
    // 终帧校正：busy 翻 false 恰好补量一轮
    view.rerender(<ChatTranscript {...baseProps} messages={[u, { ...m1, content: 'a3' }]} />);
    expect(anchorRuns()).toBe(mountRuns + 1);
    view.unmount();
  });
});
