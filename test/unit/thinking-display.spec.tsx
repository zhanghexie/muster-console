import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { GeneralPane } from '../../src/renderer/src/components/settings/GeneralPane';
import { setLiveThinkingOnly } from '../../src/renderer/src/thinkingDisplayPreference';
import { withoutDisplayThinking } from '../../src/shared/thinkingDisplay';
import type { AppConfig, ChatDisplayPart, ChatMessage } from '../../src/shared/types';

const thinking = { kind: 'thinking' as const, text: 'private thought' };
const text = { kind: 'text' as const, text: 'answer' };
const message: ChatMessage = { id: 'a', role: 'assistant', content: '', createdAt: Date.now(), parts: [thinking] };
const tool = (id: string, status: 'ok' | 'running' = 'ok'): ChatDisplayPart => ({
  kind: 'tool', toolCall: { id, name: 'bash', arguments: JSON.stringify({ command: id }), status }
});
afterEach(() => act(() => setLiveThinkingOnly(true)));

describe('thinking display preference', () => {
  it('defaults to enabled in General and toggles the saved draft', async () => {
    const set = vi.fn();
    render(<GeneralPane cfg={{} as AppConfig} set={set} />);
    const toggle = screen.getByRole('checkbox', { name: '只显示当前思考' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ liveThinkingOnly: false });
    fireEvent.click(screen.getByRole('button', { name: '查看全部提示' }));
    await waitFor(() => expect(screen.getByText('暂无功能提示')).toBeTruthy());
  });
  it('shows only the active thinking segment and keeps text and legacy history behavior', () => {
    setLiveThinkingOnly(true);
    const view = render(<ChatMessageView message={message} streaming />);
    expect(view.container.querySelector('.thinking-card')).not.toBeNull();
    view.rerender(<ChatMessageView message={{ ...message, parts: [thinking, text] }} streaming />);
    expect(view.container.querySelector('.thinking-card')).toBeNull();
    expect(screen.getByText('answer')).toBeTruthy();
    view.rerender(<ChatMessageView message={message} streaming={false} />);
    expect(view.container.querySelector('.thinking-card')).toBeNull();
    act(() => setLiveThinkingOnly(false));
    expect(view.container.querySelector('.thinking-card')).not.toBeNull();
    expect(view.container.querySelector('.thinking-title')?.textContent).toBe('正在思考中');
    expect(view.container.querySelectorAll('.thinking-orbit.is-history path')).toHaveLength(2);
    view.rerender(<ChatMessageView message={{ ...message, parts: undefined, thinking: 'old thought', content: 'answer' }} />);
    expect(view.container.querySelector('.thinking-card')).not.toBeNull();
    act(() => setLiveThinkingOnly(true));
    expect(view.container.querySelector('.thinking-card')).toBeNull();
  });
  it('streams thinking in reading order without cutting off its beginning', () => {
    const view = render(<ChatMessageView message={message} streaming />);
    expect(view.container.querySelector('.thinking-orbit')).not.toBeNull();
    expect(view.container.querySelector('.chat-pending-lite')).toBeNull();
    expect(view.container.querySelector('.thinking-live details, .thinking-live summary, .thinking-live .thinking-body')).toBeNull();
    const longThought = '开头：' + '前文 '.repeat(100) + '\n最新思考';
    view.rerender(<ChatMessageView message={{ ...message, parts: [{ kind: 'thinking', text: longThought }] }} streaming />);
    const preview = view.container.querySelector('.thinking-live-text')!;
    expect(preview.querySelector('.thinking-live-content')?.textContent).toBe(longThought.replace(/\s+/g, ' ').trim());
    view.rerender(<ChatMessageView message={{ ...message, parts: [thinking, text] }} streaming />);
    expect(view.container.querySelector('.thinking-live')).toBeNull();
  });
  it('reuses the tool summary for live thinking and leaves a summary in chronological order', () => {
    const first = tool('first');
    const second = tool('second', 'running');
    const view = render(<ChatMessageView message={{ ...message, parts: [first] }} streaming />);
    const group = view.container.querySelector<HTMLDetailsElement>('.tool-call-group-details')!;
    const summary = group.querySelector('summary')!;

    view.rerender(<ChatMessageView message={{ ...message, parts: [first, thinking] }} streaming />);
    expect(view.container.querySelectorAll('.chat-body > .turn-fold-item')).toHaveLength(1);
    expect(group.querySelector('summary')).toBe(summary);
    expect(summary.querySelector('.thinking-live-content')?.textContent).toBe(thinking.text);
    fireEvent.click(summary);
    expect(group.open).toBe(true);
    expect(group.querySelectorAll('.thinking-live-content')).toHaveLength(1);

    view.rerender(<ChatMessageView message={{ ...message, parts: [first, thinking, second] }} streaming />);
    expect(view.container.querySelectorAll('.chat-body > .turn-fold-item')).toHaveLength(1);
    expect(group.open).toBe(true);
    expect(summary.querySelector('.tool-lite-detail')?.textContent).toBe('second');
    const entries = [...group.querySelector('.tool-call-group-list')!.children];
    expect(entries.map(entry => entry.textContent)).toEqual([
      expect.stringContaining('first'), '进行了一段思考', expect.stringContaining('second')
    ]);
    expect(group.textContent).not.toContain(thinking.text);

    view.rerender(<ChatMessageView
      message={{ ...message, parts: [first, thinking, tool('second'), text] }}
      collapsedTurn
    />);
    fireEvent.click(view.container.querySelector('.turn-fold')!);
    fireEvent.click(view.container.querySelector('.tool-call-group-details > summary')!);
    expect(screen.getByText('进行了一段思考')).toBeTruthy();
    expect(screen.getByText('answer')).toBeTruthy();
  });

  it('keeps historical thinking accessible inside the group when enabled and respects inline card boundaries', () => {
    setLiveThinkingOnly(false);
    const first = tool('first');
    const second = tool('second');
    const view = render(<ChatMessageView message={{ ...message, parts: [first, thinking, second] }} />);
    expect(view.container.querySelectorAll('.tool-call-group-details')).toHaveLength(1);
    fireEvent.click(view.container.querySelector('.tool-call-group-details > summary')!);
    fireEvent.click(screen.getByText('进行了一段思考'));
    expect(screen.getByText(thinking.text)).toBeTruthy();

    view.rerender(<ChatMessageView
      message={{ ...message, parts: [first, thinking, second] }}
      inlineApproval={<div>待审批</div>}
      approvalAnchor={1}
    />);
    expect(view.container.querySelectorAll('.tool-call-group-details')).toHaveLength(2);
    expect(screen.getByText('待审批').compareDocumentPosition(screen.getByText('正在思考中')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('advances the fixed viewport when a line wraps and recalculates on resize', () => {
    let contentHeight = 24;
    let onResize: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) { onResize = callback; }
      observe() {}
      disconnect() { disconnect(); }
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('thinking-live-content') ? contentHeight : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('thinking-live-text') ? 24 : 0;
    });
    try {
      const view = render(<ChatMessageView message={message} streaming />);
      const preview = view.container.querySelector('.thinking-live-content') as HTMLElement;
      expect(preview.style.transform).toBe('translateY(0px)');
      contentHeight = 48;
      view.rerender(<ChatMessageView message={{ ...message, parts: [{ kind: 'thinking', text: 'more text' }] }} streaming />);
      expect(preview.style.transform).toBe('translateY(-24px)');
      contentHeight = 72;
      act(() => onResize?.([], {} as ResizeObserver));
      expect(preview.style.transform).toBe('translateY(-48px)');
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      height.mockRestore();
      client.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it('流式换行时保留上一行并向左淡出，连续更新不丢失最新文本', () => {
    let contentHeight = 24;
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('thinking-live-content') ? contentHeight : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('thinking-live-text') ? 24 : 0;
    });
    try {
      const first = '第一行';
      const view = render(<ChatMessageView message={{ ...message, parts: [{ kind: 'thinking', text: first }] }} streaming />);
      contentHeight = 48;
      view.rerender(<ChatMessageView message={{ ...message, parts: [{ kind: 'thinking', text: first + '第二行' }] }} streaming />);
      const leaving = view.container.querySelector('.thinking-live-exit');
      expect(leaving?.textContent).toBe(first);
      expect(leaving?.getAttribute('aria-hidden')).toBe('true');
      view.rerender(<ChatMessageView message={{ ...message, parts: [{ kind: 'thinking', text: first + '第二行追加' }] }} streaming />);
      expect(view.container.querySelector('.thinking-live-content')?.textContent).toBe(first + '第二行追加');
      view.unmount();
    } finally { height.mockRestore(); client.mockRestore(); }
  });
  it('projects only assistant thinking and adjusts card anchors without changing the source', () => {
    const input = [{ role: 'assistant', thinking: 'legacy', parts: [thinking, text, thinking], approval: { anchorPartIndex: 2 }, userQuestion: { anchorPartIndex: 3 } },
      { role: 'user', thinking: 'user value', parts: [thinking] }];
    const result = withoutDisplayThinking(input);
    expect(result[0].parts).toEqual([text]);
    expect(result[0].thinking).toBeUndefined();
    expect(result[0].approval?.anchorPartIndex).toBe(1);
    expect(result[0].userQuestion?.anchorPartIndex).toBe(1);
    expect(result[1]).toBe(input[1]);
    expect(input[0].parts).toHaveLength(3);
  });
});
