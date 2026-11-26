/**
 * ChatTranscript 把 compaction 标记插进消息流（不贴输入框）。
 * 运行: npx vitest run test/unit/chat-transcript-compact.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';

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
}

const model: TranscriptModelBinding<Src> = {
  toDisplay: (m) => m as unknown as ChatMessage
};

const baseProps = {
  busy: false,
  sessionId: 's-compact',
  model
};

function msg(id: string, createdAt: number, content = id): Src {
  return { id, role: 'user', content, createdAt };
}

describe('ChatTranscript 压缩分割线插槽', () => {
  it('进行中分割线画在消息流末尾（不在输入框）', () => {
    const { container } = render(
      <ChatTranscript
        {...baseProps}
        messages={[msg('m1', 100, '你好')]}
        compactions={[{ id: 'c1', status: 'running', createdAt: 200 }]}
      />
    );
    expect(screen.getByText('你好')).toBeTruthy();
    expect(screen.getByText('正在压缩上下文')).toBeTruthy();
    expect(container.querySelector('.chat-compact-sep')).toBeTruthy();
    expect(container.querySelector('.agent-composer-hint')).toBeNull();
  });

  it('完成分割线插在两条消息之间（按 createdAt）', () => {
    const { container } = render(
      <ChatTranscript
        {...baseProps}
        messages={[msg('m1', 100, '之前'), msg('m2', 300, '之后')]}
        compactions={[{ id: 'c1', status: 'complete', createdAt: 200 }]}
      />
    );
    const col = container.querySelector('.agent-chat-col');
    expect(col).toBeTruthy();
    const texts = [...col!.querySelectorAll('.chat-compact-sep, [data-mid]')].map((el) => {
      if (el.classList.contains('chat-compact-sep')) return 'COMPACT';
      return el.getAttribute('data-mid');
    });
    expect(texts).toEqual(['m1', 'COMPACT', 'm2']);
    expect(screen.getByText('上下文已压缩')).toBeTruthy();
    expect(container.querySelector('.chat-compact-sep-icon')).toBeTruthy();
  });

  it('完成后历史线停在压缩点，不跟在最新消息后面', () => {
    const { container } = render(
      <ChatTranscript
        {...baseProps}
        messages={[msg('m1', 100, '压前'), msg('m2', 300, '压时'), msg('m3', 800, '压后')]}
        compactions={[{ id: 'c1', status: 'complete', createdAt: 300 }]}
      />
    );
    const col = container.querySelector('.agent-chat-col');
    const texts = [...col!.querySelectorAll('.chat-compact-sep, [data-mid]')].map((el) => {
      if (el.classList.contains('chat-compact-sep')) return 'COMPACT';
      return el.getAttribute('data-mid');
    });
    expect(texts).toEqual(['m1', 'm2', 'COMPACT', 'm3']);
    expect(texts[texts.length - 1]).toBe('m3');
  });
});

/** jsdom 无布局：直接钉 scrollHeight/clientHeight，scrollTop 是普通属性不夹紧 */
function mockMetrics(el: HTMLElement, scrollTop: number, height: number, client = 400): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: client });
  el.scrollTop = scrollTop;
}

describe('ChatTranscript running 压缩线与贴底', () => {
  // 关键：render/rerender 必须共用同一 messages 引用——手动 /compact 期间
  // 主进程不改 messages 也不推 busy，唯一变化是 compactions 里的 running 标记
  const STABLE_MSGS = [msg('m1', 100, '你好')];

  it('底部跟随时出现 running 压缩线：重新贴底使其可见（不被输入条盖住）', () => {
    const { container, rerender } = render(
      <ChatTranscript {...baseProps} messages={STABLE_MSGS} />
    );
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    expect(list).toBeTruthy();
    // 用户本就在底部跟随
    mockMetrics(list, 1600, 2000);
    // 手动 /compact：只有 compactions 多了 running 标记；内容长高后
    // 用户停在原位，分割线落在 composer 覆盖区
    mockMetrics(list, 1600, 2400);
    rerender(
      <ChatTranscript
        {...baseProps}
        messages={STABLE_MSGS}
        compactions={[{ id: 'c1', status: 'running', createdAt: 200 }]}
      />
    );
    // 贴底 effect 因 running 标记出现而重跑 → scrollTop 贴到新底，分割线可见
    expect(list.scrollTop).toBe(2400);
  });

  it('用户上翻阅读时 running 压缩线出现，不强制拉底', () => {
    const { container, rerender } = render(
      <ChatTranscript {...baseProps} messages={STABLE_MSGS} />
    );
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    mockMetrics(list, 1600, 2000);
    fireEvent.scroll(list); // 建立方向基线（此时在底部）
    mockMetrics(list, 200, 2000);
    fireEvent.scroll(list); // 上翻逃出容差带 → 摘除贴底跟随
    mockMetrics(list, 200, 2400);
    rerender(
      <ChatTranscript
        {...baseProps}
        messages={STABLE_MSGS}
        compactions={[{ id: 'c1', status: 'running', createdAt: 200 }]}
      />
    );
    // marker 出现只是补触发时机：贴底仍受 stickBottom 门控，不许打断上翻阅读
    expect(list.scrollTop).toBe(200);
  });

  it('running 压缩线消失（完成/摘线）同样重跑贴底判定', () => {
    const { container, rerender } = render(
      <ChatTranscript
        {...baseProps}
        sessionId="s-compact-removal"
        messages={STABLE_MSGS}
        compactions={[{ id: 'c1', status: 'running', createdAt: 200 }]}
      />
    );
    const list = container.querySelector('.chat-list') as HTMLDivElement;
    mockMetrics(list, 1600, 2000);
    // 失败摘线：compactions 少了一条，messages/busy 依旧不变
    mockMetrics(list, 1600, 2000);
    rerender(<ChatTranscript {...baseProps} sessionId="s-compact-removal" messages={STABLE_MSGS} />);
    expect(list.scrollTop).toBe(2000);
  });
});
