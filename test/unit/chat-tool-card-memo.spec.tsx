import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { resetRevealTickerForTest } from '../../src/renderer/src/chatSurface/revealTicker';
import type { ChatMessage, ToolCallRecord } from '../../src/shared/types';

vi.mock('../../src/renderer/src/chatSurface/ChatMarkdownBody', () => ({
  ChatMarkdownBody: ({ text }: { text: string }) => <div>{text}</div>
}));

let now = 0;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  now = 0; nextFrame = 0; frames.clear();
  resetRevealTickerForTest();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function frame(ms = 16): void {
  now += ms;
  const pending = [...frames.values()]; frames.clear();
  act(() => { for (const fn of pending) fn(now); });
}
/** 流式揭示（2026-10-30）后正文增长不再同步落地：泵帧到期望文本出现 */
function pumpUntilText(container: HTMLElement, want: string, limit = 200): void {
  for (let i = 0; i < limit && !(container.textContent ?? '').includes(want); i++) frame(33);
}

describe('unchanged tool card rendering', () => {
  it('末段正文增长不重渲旧工具卡；正文按弹簧揭示，工具终态与输出到达即显示', () => {
    const previewRead = vi.fn(() => undefined);
    const tool: ToolCallRecord = {
      id: 't', name: 'shell', arguments: '{}', input: {}, status: 'running',
      get previewPath() { return previewRead(); }
    };
    const message = (text: string, toolCall = tool): ChatMessage => ({
      id: 'm', role: 'assistant', createdAt: Date.now(), content: text,
      parts: [{ kind: 'tool', toolCall }, { kind: 'text', text }]
    });
    const view = render(<ChatMessageView message={message('first')} streaming />);
    fireEvent.click(view.container.querySelector('.tool-call-group-details > summary')!);
    expect(previewRead).toHaveBeenCalled();
    previewRead.mockClear();
    view.rerender(<ChatMessageView message={message('first plus delta')} streaming />);
    expect(previewRead).not.toHaveBeenCalled(); // 还原 ToolCallCard memo 即红（揭示截断保留工具 part 引用）
    pumpUntilText(view.container, 'first plus delta');
    expect(view.container.textContent).toContain('first plus delta');
    view.rerender(<ChatMessageView message={message('done', { ...tool, status: 'error', result: 'failed output' })} streaming />);
    expect(view.container.querySelector('.tool-card.error')).toBeTruthy();
    // 2026-10-31 起工具详情收起态不进 DOM（AnimatedDetails）：终态先在摘要行显示，
    // 点开 summary 展开后输出可见
    fireEvent.click(view.container.querySelector('.tool-card.error summary')!);
    expect(view.container.textContent).toContain('failed output');
  });
});
