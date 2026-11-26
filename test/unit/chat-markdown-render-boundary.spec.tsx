import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import type { ChatMessage, ToolCallRecord } from '../../src/shared/types';

// Count real parser executions, including context updates through memoized children.
vi.mock('react-markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return { ...actual, default: vi.fn(actual.default) };
});
vi.mock('../../src/renderer/src/chatSurface/UiWidgetCard', () => ({
  UiWidgetCard: ({ match }: { match: { path: string } }) => <div data-artifact={match.path} />
}));

const parser = vi.mocked(ReactMarkdown);
const firstPath = 'E:/fixture/agent-sessions/a/ui/01-first.inline.html';
const nextPath = 'E:/fixture/agent-sessions/a/ui/02-next.inline.html';
const link = (path: string) => `[部件](<${path}>)`;
const tool = (path: string): ToolCallRecord => ({ id: 'ui', name: 'ui.render', arguments: '{}', result: JSON.stringify({ link: path }), status: 'ok' });
const base = { id: 'm', role: 'assistant', createdAt: 1, content: '' } as ChatMessage;
const callsFor = (text: string) => parser.mock.calls.filter(([props]) => props.children === text).length;

beforeEach(() => {
  parser.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('unchanged chat Markdown stays outside unrelated render work', () => {
  it('message chrome updates do not parse completed text again, including empty suppression', async () => {
    const message = { ...base, parts: [{ kind: 'text', text: '第一段正文' }, { kind: 'text', text: '最终正文' }] } as ChatMessage;
    const view = render(<ChatMessageView message={message} />);
    const before = parser.mock.calls.length;
    for (const quiet of [true, false, true]) {
      await act(async () => view.rerender(<ChatMessageView message={message} quiet={quiet} />));
    }
    expect(parser.mock.calls.length).toBe(before);
  });

  it('equivalent artifact outputs keep suppression stable when a message is cloned', async () => {
    const message = { ...base, parts: [{ kind: 'text', text: link(firstPath) }, { kind: 'tool', toolCall: tool(firstPath) }, { kind: 'text', text: '最终正文' }] } as ChatMessage;
    const view = render(<ChatMessageView message={message} />);
    const before = parser.mock.calls.length;
    await act(async () => view.rerender(<ChatMessageView message={{ ...message }} quiet />));
    expect(parser.mock.calls.length).toBe(before);
    expect(view.container.querySelectorAll('[data-artifact]')).toHaveLength(1);
  });

  it('real suppression changes reparse the affected part and preserve the final body', async () => {
    const text = link(nextPath);
    const message = { ...base, parts: [{ kind: 'text', text }, { kind: 'tool', toolCall: tool(firstPath) }, { kind: 'text', text: '最终正文' }] } as ChatMessage;
    const view = render(<ChatMessageView message={message} />);
    const before = callsFor(text), finalBefore = callsFor('最终正文');
    await act(async () => view.rerender(<ChatMessageView message={{ ...message, parts: [message.parts![0], { kind: 'tool', toolCall: tool(nextPath) }, message.parts![2]] }} />));
    expect(callsFor(text)).toBe(before + 1);
    // suppression 上下文全消息统一（部件改在 tool 位置渲染），集合变化使所有文本段各重解析一次。
    expect(callsFor('最终正文')).toBe(finalBefore + 1);
    expect(view.container.querySelectorAll('[data-artifact]')).toHaveLength(1);
    expect(view.container.querySelector('[data-artifact]')?.getAttribute('data-artifact')).toBe(nextPath);
  });

  it('wrapper styling is independent of parsing; text and file actions still update', () => {
    const action = vi.fn(), nextAction = vi.fn();
    const text = '[源码](muster-file:E%3A%2Ffixture%2Fa.ts)';
    const view = render(<MarkdownBody text={text} className="first" onFileLink={action} />);
    const before = parser.mock.calls.length;
    view.rerender(<MarkdownBody text={text} className="second" onFileLink={action} />);
    expect(parser.mock.calls.length).toBe(before);
    expect(view.container.querySelector('.md-body.second')).toBeTruthy();
    view.rerender(<MarkdownBody text={text} onFileLink={nextAction} />);
    fireEvent.click(view.container.querySelector('.ws-file-link')!);
    expect(nextAction).toHaveBeenCalledWith('muster-file:E%3A%2Ffixture%2Fa.ts');
    expect(action).not.toHaveBeenCalled();
    view.rerender(<MarkdownBody text="**更新的正文**" onFileLink={nextAction} />);
    expect(view.container.querySelector('strong')?.textContent).toBe('更新的正文');
    expect(parser.mock.calls.length).toBe(before + 2);
  });
});
