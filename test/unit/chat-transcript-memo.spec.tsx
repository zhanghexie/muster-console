/**
 * ChatTranscript 行级 memo 契约（2026-09-14 性能专项回归）：
 * 真机 profile 显示一次无关点击可让转录列表重渲 13-22 次，逐行击穿 ChatMessageView
 * 的 memo（~40 t()/行·次）。两处身份修复的守卫：
 * 1) getInlineCards 结果缓存——宿主每次事件克隆 messages 引用，若卡槽每次新建 JSX
 *    元素，带卡行必破 memo；
 * 2) handlers 引用稳定（onFileLink 等）时，消息内容等价的重渲不得触发行重渲。
 * 同时守过度缓存：内容真变的行必须重渲。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';

const { msgMock } = vi.hoisted(() => ({
  msgMock: vi.fn(({ message }: { message: { id: string } }) => (
    <div data-msg={message.id} />
  ))
}));

// mock 必须保留 React.memo 语义：被测契约是「ChatTranscript 传出的 props 稳定 ⇒
// memo 浅比较命中 ⇒ 行组件不重渲」，裸函数 mock 会被父渲染连带着全部重跑，测不出
vi.mock('../../src/renderer/src/components/ChatMessageView', async () => {
  const React = await import('react');
  return { ChatMessageView: React.memo(msgMock) };
});

// jsdom 无 ResizeObserver（ChatTranscript 挂载时量列宽用），空桩即可
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
  toDisplay: (m) => m as unknown as ChatMessage,
  messagesEqual: (a, b) => a.id === b.id && a.content === b.content,
  getInlineCards: (m) =>
    (m as { approval?: object }).approval ? { approval: <div data-card="approval" /> } : {}
};

const baseProps = {
  busy: false,
  sessionId: 's-perf',
  model,
  onFileLink: (): void => {}
};

function mount(messages: Src[]) {
  return render(<ChatTranscript {...baseProps} messages={messages} />);
}

/** 按消息 id 分账的渲染计数（总量受 React 调度次数影响，按行断言契约） */
const callsFor = (id: string): number =>
  msgMock.mock.calls.filter((c: [{ message: { id: string } }]) => c[0].message.id === id)
    .length;

describe('ChatTranscript 行级 memo（性能回归）', () => {
  beforeEach(() => {
    msgMock.mockClear();
  });

  it('messages 换引用但内容等价 → ChatMessageView 不重渲（含 getInlineCards 新元素场景）', () => {
    const m1: Src = { id: 'm1', role: 'user', content: '看 `npm run dev`' };
    const m2: Src = { id: 'm2', role: 'assistant', content: '已执行', approval: {} } as Src;
    const view = mount([m1, m2]);
    expect(callsFor('m1')).toBeGreaterThan(0);
    expect(callsFor('m2')).toBeGreaterThan(0);
    // 宿主事件克隆出全新对象（引用不同、内容等价）；卡槽即使每次调用都产出新 JSX
    // 元素，也必须复用缓存，不得击穿行 memo
    view.rerender(
      <ChatTranscript {...baseProps} messages={[{ ...m1 }, { ...m2 } as Src]} />
    );
    expect(callsFor('m1')).toBe(1);
    expect(callsFor('m2')).toBe(1);
  });

  it('消息内容真变 → 对应行重渲（不过度缓存）', () => {
    const m1: Src = { id: 'm1', role: 'user', content: '第一版' };
    const m2: Src = { id: 'm2', role: 'assistant', content: '回复' };
    const view = mount([m1, m2]);
    expect(callsFor('m1')).toBe(1);
    view.rerender(
      <ChatTranscript
        {...baseProps}
        messages={[m1, { ...m2, content: '回复（已更新）' }]}
      />
    );
    // m1 等价复用不再渲；m2 内容变化必须重渲
    expect(callsFor('m1')).toBe(1);
    expect(callsFor('m2')).toBeGreaterThan(1);
    view.unmount();
  });
});

/* ── harness 回合计量（B1-5）：hMetrics 消息级缓存守卫 ──
 * harnessOf 产出的计量经字面量传给 ChatMessageView.harnessMetrics；不缓存时
 * 每次 messages 换引用（流式 delta 每批）都换新对象，带 usage 的行全部击穿 memo。
 * 还原即红：去掉 hMetricsCacheRef 缓存（退回行内对象字面量），下方「带 usage 行
 * 不重渲」转红；只按 id 缓存不比 src 等价，则「计量真变换新值」转红。 */

interface HSrc {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  harness?: {
    usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
    durationMs?: number;
  };
}

const harnessModel: TranscriptModelBinding<HSrc> = {
  toDisplay: (m) => m as unknown as ChatMessage,
  // 与真实 guiChatMessageEqual 同口径：harness 摘要参与等价（计量盖章必失配）
  messagesEqual: (a, b) =>
    a.id === b.id &&
    a.content === b.content &&
    JSON.stringify(a.harness) === JSON.stringify(b.harness),
  harnessOf: (m) => (m.role === 'assistant' ? m.harness : undefined)
};

const harnessBase = {
  busy: false,
  sessionId: 's-hmetrics',
  model: harnessModel,
  harness: { on: true }
};

function mountHarness(messages: HSrc[]) {
  return render(<ChatTranscript {...harnessBase} messages={messages} />);
}

const metricsCallsFor = (id: string): Array<Record<string, unknown> | undefined> =>
  msgMock.mock.calls
    .filter((c: [{ message: { id: string } }]) => c[0].message.id === id)
    .map((c) => (c[0] as { harnessMetrics?: Record<string, unknown> }).harnessMetrics);

describe('ChatTranscript 行级 memo：harness 计量（B1-5）', () => {
  beforeEach(() => {
    msgMock.mockClear();
  });

  it('messages 换引用但计量未变 → 带 usage 行不重渲（hMetrics 复用旧对象）', () => {
    const a1: HSrc = {
      id: 'a1',
      role: 'assistant',
      content: '结论',
      harness: { usage: { inputTokens: 100, outputTokens: 200 }, durationMs: 1234 }
    };
    const u1: HSrc = { id: 'u1', role: 'user', content: '问' };
    const view = mountHarness([u1, a1]);
    expect(callsFor('a1')).toBe(1);
    // 宿主流式期每批克隆出全新 messages/src（引用不同、内容与计量等价）：
    // hMetrics 必须复用缓存对象让 memo 命中，行不得重渲
    view.rerender(<ChatTranscript {...harnessBase} messages={[{ ...u1 }, { ...a1 }]} />);
    expect(callsFor('a1')).toBe(1);
    view.unmount();
  });

  it('计量真变（usage 盖章）→ 行重渲且拿到新计量（不过度缓存）', () => {
    const a1: HSrc = {
      id: 'a1',
      role: 'assistant',
      content: '结论',
      harness: { usage: { inputTokens: 100, outputTokens: 200 }, durationMs: 1234 }
    };
    const u1: HSrc = { id: 'u1', role: 'user', content: '问' };
    const view = mountHarness([u1, a1]);
    const first = metricsCallsFor('a1')[0];
    expect(first).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 1234
    });
    // turn-complete 盖章：usage 变化 → harness 等价失配 → 行重渲并换新计量对象
    view.rerender(
      <ChatTranscript
        {...harnessBase}
        messages={[
          { ...u1 },
          {
            ...a1,
            harness: { usage: { inputTokens: 150, outputTokens: 260 }, durationMs: 1300 }
          }
        ]}
      />
    );
    const calls = metricsCallsFor('a1');
    expect(calls.length).toBeGreaterThan(1);
    const latest = calls[calls.length - 1];
    expect(latest).toEqual({ inputTokens: 150, outputTokens: 260, durationMs: 1300 });
    expect(latest).not.toBe(first);
    view.unmount();
  });
});

/* ── 流式行 display 节流（B1-7）：micromark 解析降档 ≤10 次/秒 ──
 * streaming 行的 display 重映射限频 ~100ms：窗内批次复用旧映射（行 memo 命中，
 * micromark 不跑），过窗批次落地新文本；streaming 翻 false 强制终渲（尾值必落地）；
 * 非流式路径零变化。还原即红：去掉节流分支后「窗内批次行不重渲」转红。 */
describe('ChatTranscript 流式行 display 节流（B1-7）', () => {
  beforeEach(() => {
    msgMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const lastMsgFor = (id: string): Src | undefined => {
    const hits = msgMock.mock.calls.filter(
      (c: [{ message: { id: string } }]) => c[0].message.id === id
    );
    return (hits[hits.length - 1] as [{ message: Src }] | undefined)?.[0].message;
  };

  it('窗内流式批次复用旧映射；过窗落地；busy 翻 false 终渲尾值', () => {
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const v1: Src = { id: 'a1', role: 'assistant', content: '第一版' };
    const v2: Src = { id: 'a1', role: 'assistant', content: '第二版更长' };
    const v3: Src = { id: 'a1', role: 'assistant', content: '第三版最终' };
    const streamingProps = { ...baseProps, busy: true };
    const view = render(<ChatTranscript {...streamingProps} messages={[u, v1]} />);
    expect(callsFor('a1')).toBeGreaterThan(0);
    expect(lastMsgFor('a1')).toBe(v1);
    const calls1 = callsFor('a1');
    // 节流窗内的批次（内容已变）：复用旧映射，行不重渲（micromark 不跑）
    view.rerender(<ChatTranscript {...streamingProps} messages={[u, v2]} />);
    expect(callsFor('a1')).toBe(calls1);
    expect(lastMsgFor('a1')).toBe(v1);
    // 过窗批次：新文本落地
    vi.advanceTimersByTime(150);
    view.rerender(<ChatTranscript {...streamingProps} messages={[u, v3]} />);
    expect(callsFor('a1')).toBeGreaterThan(calls1);
    expect(lastMsgFor('a1')).toBe(v3);
    // busy 翻转 false：streaming 标志变化强制重映射，终渲一帧（尾值完整）
    view.rerender(<ChatTranscript {...baseProps} messages={[u, v3]} busy={false} />);
    expect(callsFor('a1')).toBeGreaterThan(calls1);
    expect(lastMsgFor('a1')).toBe(v3);
    view.unmount();
  });

  it('非流式路径零变化：窗内连续内容变化仍逐次重映射', () => {
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const a1: Src = { id: 'a1', role: 'assistant', content: '已完成' };
    const view = render(<ChatTranscript {...baseProps} messages={[u, a1]} />);
    const calls1 = callsFor('a1');
    const a2: Src = { id: 'a1', role: 'assistant', content: '已完成（更新）' };
    view.rerender(<ChatTranscript {...baseProps} messages={[u, a2]} />);
    expect(callsFor('a1')).toBe(calls1 + 1);
    expect(lastMsgFor('a1')).toBe(a2);
    view.unmount();
  });
});

// ---------- 停靠点随新回合出现（P2-1② 签名门控不得冻结新增）----------
describe('停靠点签名门控（P2-1②）', () => {
  beforeEach(() => {
    msgMock.mockClear();
  });

  it('新 user 回合出现：新停靠点/触发位照常出现', () => {
    // 停靠点 prompt 取 parts 里的 text（buildTurnRailStops textOf 口径）
    const u1: Src = {
      id: 'u1',
      role: 'user',
      content: '问题一',
      parts: [{ kind: 'text', text: '问题一' }]
    } as Src;
    const a1: Src = { id: 'a1', role: 'assistant', content: '答' };
    const view = render(<ChatTranscript {...baseProps} messages={[u1, a1]} />);
    expect(
      view.container.querySelector('[data-mid="u1"]')?.classList.contains('is-history-trigger')
    ).toBe(true);
    // 新回合（长度+末条 user id 变化）：签名门控必须放行重建
    const u2: Src = {
      id: 'u2',
      role: 'user',
      content: '问题二',
      parts: [{ kind: 'text', text: '问题二' }]
    } as Src;
    view.rerender(<ChatTranscript {...baseProps} messages={[u1, a1, u2]} />);
    expect(
      view.container.querySelector('[data-mid="u2"]')?.classList.contains('is-history-trigger')
    ).toBe(true);
    expect(
      view.container.querySelector('[data-mid="u1"]')?.classList.contains('is-history-trigger')
    ).toBe(true);
    view.unmount();
  });
});
