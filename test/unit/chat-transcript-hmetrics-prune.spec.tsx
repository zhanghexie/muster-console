/**
 * hMetricsCacheRef 剪枝回归（chat-transcript 审计 F-01，2026-10-25）：
 * harness 回合计量缓存只在 set 从不删——消息移除（clear()/撤轮/压缩替换）后旧条目
 * 永久残留。本用例取其可观测后果：残留条目会让「同 id 消息重新出现且 messagesEqual
 * 等价（宿主克隆引用）」时按等价门复用已移除回合的旧计量值。修复在 renderedWindow
 * 尾部剪枝循环（seenIds 同口径）删除移除消息的条目；还原修复本用例应转红
 * （旧值 1 冒充新值 9）。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';

const { msgMock } = vi.hoisted(() => ({
  msgMock: vi.fn(
    ({
      message,
      harnessMetrics
    }: {
      message: { id: string };
      harnessMetrics?: { inputTokens?: number };
    }) => <div data-msg={message.id} data-in={harnessMetrics?.inputTokens ?? 'none'} />
  )
}));

// 保留 React.memo 语义：被测的是「缓存条目复用/剪枝」，裸函数 mock 会连带头全部重跑
vi.mock('../../src/renderer/src/components/ChatMessageView', async () => {
  const React = await import('react');
  return { ChatMessageView: React.memo(msgMock) };
});

// jsdom 无 ResizeObserver（挂载时量列宽用），空桩即可
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
  usage: { inputTokens: number; outputTokens: number };
}

const model = {
  toDisplay: (m: Src): ChatMessage => m as unknown as ChatMessage,
  // 宿主克隆口径：内容等价即等价（不看 usage——计量是回合收口盖章，随 src 更新）
  messagesEqual: (a: Src, b: Src) => a.id === b.id && a.content === b.content,
  harnessOf: (m: Src) => ({
    usage: { inputTokens: m.usage.inputTokens, outputTokens: m.usage.outputTokens }
  })
};

const baseProps = {
  busy: false,
  sessionId: 's-hmetrics-prune',
  model,
  onFileLink: (): void => {},
  harness: { on: true }
};

const lastMetrics = (
  id: string
): { inputTokens?: number } | undefined =>
  msgMock.mock.calls
    .filter((c: [{ message: { id: string }; harnessMetrics?: { inputTokens?: number } }]) => c[0].message.id === id)
    .at(-1)?.[0].harnessMetrics;

describe('ChatTranscript hMetricsCacheRef 剪枝（F-01）', () => {
  beforeEach(() => {
    msgMock.mockClear();
  });

  it('消息移除后同 id 重新出现：不复用已移除回合的旧计量', () => {
    const x1: Src = { id: 'x', role: 'assistant', content: 'a', usage: { inputTokens: 1, outputTokens: 2 } };
    const view = render(<ChatTranscript {...baseProps} messages={[x1]} />);
    expect(lastMetrics('x')?.inputTokens).toBe(1);
    // 消息移除（clear()/撤轮/压缩替换同族）——hMetrics 缓存须随之剪枝
    view.rerender(<ChatTranscript {...baseProps} messages={[]} />);
    // 同 id 重新出现、messagesEqual 等价（新引用）：旧实现残留条目按等价门复用旧
    // hMetrics（inputTokens 1），修复后必须按新 src 重算
    const x2: Src = { id: 'x', role: 'assistant', content: 'a', usage: { inputTokens: 9, outputTokens: 9 } };
    view.rerender(<ChatTranscript {...baseProps} messages={[x2]} />);
    expect(lastMetrics('x')?.inputTokens).toBe(9);
  });
});
