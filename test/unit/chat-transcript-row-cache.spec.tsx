/**
 * B1-6 行级元素缓存回归：renderedWindow 的行 JSX 按 msgId 缓存（deps 全等即复用
 * 旧 element），未受影响行在任意其他行/全局量变化时不再重建元素。
 *
 * 观测口径：本文件故意用**非 memo** 的 ChatMessageView 替身——React 对同引用
 * element 跳过整棵子树（连函数组件都不调用），所以「行元素被复用」⇔ 该行替身
 * 不被调用；「行元素重建」⇔ 被调用。memo 替身（chat-transcript-memo.spec.tsx
 * 基线）测不出这层差异，因 memo 命中同样跳过调用。
 *
 * 每条依赖项一条「变化必换行」断言：还原对应 deps 槽位（或退回单 useMemo 整窗）
 * 即转红。notePos 槽位与 noteOpenHere 同机制（行内批注位对象引用），jsdom 无法
 * 驱动测量路径，由 noteOpenHere 用例覆盖失效机制本身。
 * 运行: npx vitest run test/unit/chat-transcript-row-cache.spec.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';

const { msgMock } = vi.hoisted(() => ({
  // 刻意不加 React.memo：行级缓存的观测点就是「同引用 element 跳过子树调用」
  msgMock: vi.fn(({ message }: { message: { id: string } }) => <div data-msg={message.id} />)
}));

vi.mock('../../src/renderer/src/components/ChatMessageView', async () => {
  const React = await import('react');
  return { ChatMessageView: msgMock };
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
  createdAt?: number;
  approval?: object;
  aborted?: boolean;
  harness?: unknown;
}

const model: TranscriptModelBinding<Src> = {
  toDisplay: (m) => m as unknown as ChatMessage,
  messagesEqual: (a, b) =>
    a.id === b.id &&
    a.content === b.content &&
    a.approval === b.approval &&
    a.aborted === b.aborted,
  getInlineCards: (m) =>
    (m as { approval?: object }).approval ? { approval: <div data-card="approval" /> } : {}
};

const baseProps = {
  busy: false,
  sessionId: 's-row-cache',
  model
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const callsFor = (id: string): number =>
  msgMock.mock.calls.filter((c: [{ message: { id: string } }]) => c[0].message.id === id).length;

beforeEach(() => {
  msgMock.mockClear();
});

describe('B1-6 行级元素缓存：依赖变化必换行', () => {
  it('行内容变化：该行重建，未变行不重建', () => {
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const a: Src = { id: 'a1', role: 'assistant', content: '初版' };
    const view = render(<ChatTranscript {...baseProps} messages={[u, a]} />);
    expect(callsFor('a1')).toBe(1);
    // 另一行变化：a1 元素必须复用（不重渲）；u1 重建
    view.rerender(<ChatTranscript {...baseProps} messages={[{ ...u }, { ...a, content: '初版' }]} />);
    expect(callsFor('a1')).toBe(1);
    // a1 自己的内容变化：必须重建
    view.rerender(<ChatTranscript {...baseProps} messages={[{ ...u }, { ...a, content: '改版' }]} />);
    expect(callsFor('a1')).toBe(2);
  });

  it('busy 翻转（streaming/collapsed/planDisabled 链）：流式行重建', () => {
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const a: Src = { id: 'a1', role: 'assistant', content: '答案' };
    const view = render(<ChatTranscript {...baseProps} messages={[u, a]} />);
    expect(callsFor('a1')).toBe(1);
    view.rerender(<ChatTranscript {...baseProps} busy messages={[{ ...u }, { ...a }]} />);
    expect(callsFor('a1')).toBe(2);
  });

  it('staleTurn 时间翻转：自身数据未动的旧行也必须重建', () => {
    vi.useFakeTimers();
    try {
      const u: Src = { id: 'u1', role: 'user', content: '问' };
      const a1: Src = { id: 'a1', role: 'assistant', content: '两小时前', createdAt: Date.now() - 2 * 3600_000 };
      const a2: Src = { id: 'a2', role: 'assistant', content: '刚刚', createdAt: Date.now() - 60_000 };
      const view = render(<ChatTranscript {...baseProps} messages={[u, a1, a2]} />);
      const before = callsFor('a1');
      // 24h+ 时间流逝 + 另一行触发整窗重算：a1 自身 deps 未变但 staleTurn 翻转
      vi.advanceTimersByTime(25 * 3600_000);
      view.rerender(
        <ChatTranscript {...baseProps} messages={[{ ...u }, { ...a1 }, { ...a2, content: '刚刚（续）' }]} />
      );
      expect(callsFor('a1')).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('findActive/forceFoldOpen：命中行重建，未命中行不复用失效', () => {
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const a: Src = { id: 'a1', role: 'assistant', content: '答案' };
    const view = render(<ChatTranscript {...baseProps} messages={[u, a]} />);
    expect(callsFor('a1')).toBe(1);
    // findActive 落在 u1：a1 的 forceFoldOpen 未变 → a1 元素复用
    view.rerender(
      <ChatTranscript {...baseProps} messages={[u, a]} findActive={{ messageId: 'u1', indexInMessage: 0 }} />
    );
    expect(callsFor('a1')).toBe(1);
    // findActive 落在 a1：forceFoldOpen 翻 true → 重建
    view.rerender(
      <ChatTranscript {...baseProps} messages={[u, a]} findActive={{ messageId: 'a1', indexInMessage: 0 }} />
    );
    expect(callsFor('a1')).toBe(2);
  });

  it('cards（getInlineCards 产物）：审批卡出现必须重建该行', () => {
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const a: Src = { id: 'a1', role: 'assistant', content: '答案' };
    const view = render(<ChatTranscript {...baseProps} messages={[u, a]} />);
    expect(callsFor('a1')).toBe(1);
    view.rerender(
      <ChatTranscript {...baseProps} messages={[{ ...u }, { ...a, approval: { ok: 1 } }]} />
    );
    expect(callsFor('a1')).toBe(2);
  });

  it('hMetrics：计量盖章必重建，未变克隆不重建', () => {
    const a1v1: Src = {
      id: 'a1',
      role: 'assistant',
      content: '结论',
      harness: { usage: { inputTokens: 10, outputTokens: 20 } }
    } as Src;
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const harnessModel: TranscriptModelBinding<Src> = {
      toDisplay: model.toDisplay,
      messagesEqual: (x, y) =>
        x.id === y.id && x.content === y.content && JSON.stringify((x as Src).harness) === JSON.stringify((y as Src).harness),
      harnessOf: (m) => (m as { harness?: unknown }).harness as never
    };
    const view = render(
      <ChatTranscript {...baseProps} model={harnessModel} harness={{ on: true }} messages={[u, a1v1]} />
    );
    expect(callsFor('a1')).toBe(1);
    // 未变克隆：复用
    view.rerender(
      <ChatTranscript {...baseProps} model={harnessModel} harness={{ on: true }} messages={[{ ...u }, clone(a1v1)]} />
    );
    expect(callsFor('a1')).toBe(1);
    // 计量盖章：重建
    const a1v2 = {
      ...clone(a1v1),
      harness: { usage: { inputTokens: 11, outputTokens: 22 } }
    } as Src;
    view.rerender(
      <ChatTranscript {...baseProps} model={harnessModel} harness={{ on: true }} messages={[{ ...u }, a1v2]} />
    );
    expect(callsFor('a1')).toBe(2);
  });

  it('openBubbleId/noteOpenHere：批注气泡开合只重建带批注行', () => {
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const a: Src = { id: 'a1', role: 'assistant', content: '答案' };
    const notes = [{ id: 'n1', seq: 1, quote: '引', note: '批', messageId: 'a1' }];
    // 生产契约：onOpenNote 引用稳定（renderedWindow 依赖本就未含它）
    const onOpenNote = (): void => undefined;
    const view = render(
      <ChatTranscript
        {...baseProps}
        messages={[u, a]}
        notes={notes}
        openNoteId={null}
        onOpenNote={onOpenNote}
      />
    );
    expect(callsFor('a1')).toBe(1);
    // 气泡开在 a1 的批注上：a1 重建
    view.rerender(
      <ChatTranscript
        {...baseProps}
        messages={[{ ...u }, { ...a }]}
        notes={notes}
        openNoteId="n1"
        onOpenNote={onOpenNote}
      />
    );
    expect(callsFor('a1')).toBe(2);
    // 无关变化（别的行内容）不再连累：a1 元素复用
    view.rerender(
      <ChatTranscript
        {...baseProps}
        messages={[{ ...u, content: '问（改）' }, { ...a }]}
        notes={notes}
        openNoteId="n1"
        onOpenNote={onOpenNote}
      />
    );
    expect(callsFor('a1')).toBe(2);
  });

  it('全局量 cwd/mode 变化：所有行重建', () => {
    const u: Src = { id: 'u1', role: 'user', content: '问' };
    const a: Src = { id: 'a1', role: 'assistant', content: '答案' };
    const view = render(
      <ChatTranscript {...baseProps} messages={[u, a]} cwd="E:/a" mode="default" />
    );
    expect(callsFor('a1')).toBe(1);
    view.rerender(
      <ChatTranscript {...baseProps} messages={[{ ...u }, { ...a }]} cwd="E:/b" mode="default" />
    );
    expect(callsFor('a1')).toBe(2);
    view.rerender(
      <ChatTranscript {...baseProps} messages={[{ ...u }, { ...a }]} cwd="E:/b" mode="plan" />
    );
    expect(callsFor('a1')).toBe(3);
  });

  it('editAbortedIdx 变化（末轮翻 aborted）：对应用户行重建，早先用户行不重建', () => {
    const u1: Src = { id: 'u1', role: 'user', content: '第一问' };
    const a1: Src = { id: 'a1', role: 'assistant', content: '第一答' };
    const u2: Src = { id: 'u2', role: 'user', content: '第二问' };
    const a2: Src & { aborted?: boolean } = { id: 'a2', role: 'assistant', content: '半截' };
    const onEditAborted = (): void => undefined;
    const view = render(
      <ChatTranscript
        {...baseProps}
        onEditAborted={onEditAborted}
        messages={[u1, a1, u2, a2]}
      />
    );
    expect(callsFor('u1')).toBe(1);
    expect(callsFor('u2')).toBe(1);
    view.rerender(
      <ChatTranscript
        {...baseProps}
        onEditAborted={onEditAborted}
        messages={[u1, a1, u2, { ...a2, aborted: true }]}
      />
    );
    expect(callsFor('u1')).toBe(1);
    expect(callsFor('u2')).toBe(2);
  });
});
