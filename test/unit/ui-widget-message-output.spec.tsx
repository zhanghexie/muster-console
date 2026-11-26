import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import type { ChatMessage, ToolCallRecord } from '../../src/shared/types';

const path = 'E:/fixture/agent-sessions/a/ui/01-example.inline.html';
const markdown = `[预算](<${path}>)`;
const tool = (): ToolCallRecord => ({ id: 'render', name: 'ui.render', arguments: '{}', result: JSON.stringify({ link: path, markdown }), status: 'ok' });
function message(parts = true, text = '已生成。'): ChatMessage {
  return {
    id: 'message', role: 'assistant', createdAt: Date.now(), content: parts ? '' : text,
    ...(parts ? { parts: [{ kind: 'tool', toolCall: tool() }, { kind: 'text', text }] } : { toolCalls: [tool()] })
  } as ChatMessage;
}
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
async function renderReady(node: React.ReactElement) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(node); });
  return view;
}

describe('persistent artifact message placement', () => {
  it('scheduler directory artifacts render from the scheduler tool envelope and deduplicate the final link', async () => {
    const schedulerPath = 'E:/fixture/agent-sessions/orchestrator.12345678-1234-1234-1234-123456789abc/ui/01-scheduler.inline.html';
    const m = message(true, `[Scheduler](<${schedulerPath}>)`);
    const call = (m.parts![0] as { toolCall: ToolCallRecord }).toolCall;
    call.name = 'ui_render';
    call.result = JSON.stringify({ ok: true, result: { link: schedulerPath, version: 1 } });
    const view = await renderReady(<ChatMessageView message={m} collapsedTurn staleTurn />);
    expect(view.container.querySelectorAll('iframe.ma-ui-frame')).toHaveLength(1);
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toContain('orchestrator.12345678');
  });
  it.each([true, false])('tool-only output survives completed/stale activity folding; parts=%s', async (parts) => {
    const m = message(parts);
    const view = await renderReady(<ChatMessageView message={m} collapsedTurn staleTurn />);
    expect(view.container.querySelectorAll('iframe.ma-ui-frame')).toHaveLength(1);
    expect(view.container.querySelector('.turn-fold-body .ma-ui-card')).toBeNull();
    view.rerender(<ChatMessageView message={m} collapsedTurn forceFoldOpen />);
    expect(view.container.querySelectorAll('iframe.ma-ui-frame')).toHaveLength(1);
  });

  it.each([true, false])('final reference and tool result mount once; parts=%s', async (parts) => {
    const m = message(parts, markdown);
    const view = await renderReady(<ChatMessageView message={m} collapsedTurn />);
    expect(view.container.querySelectorAll('iframe.ma-ui-frame')).toHaveLength(1);
    view.rerender(<ChatMessageView message={m} collapsedTurn forceFoldOpen />);
    expect(view.container.querySelectorAll('iframe.ma-ui-frame')).toHaveLength(1);
  });

  it('intermediate references do not duplicate the persistent output when activity expands', async () => {
    const m = message();
    m.parts = [{ kind: 'text', text: markdown }, { kind: 'tool', toolCall: tool() }, { kind: 'text', text: '完成。' }];
    const view = await renderReady(<ChatMessageView message={m} collapsedTurn forceFoldOpen />);
    expect(view.container.querySelectorAll('iframe.ma-ui-frame')).toHaveLength(1);
  });

  it('keeps the artifact after its tool run and outside the folded activity body', async () => {
    const m = message();
    m.parts = [
      { kind: 'text', text: '开始准备。' },
      { kind: 'tool', toolCall: tool() },
      { kind: 'text', text: '完成。' }
    ];
    const view = await renderReady(<ChatMessageView message={m} collapsedTurn />);
    const card = view.container.querySelector('.ma-ui-card');
    const finalText = [...view.container.querySelectorAll('.chat-text')].at(-1);
    expect(card).toBeTruthy();
    expect(card?.closest('.turn-fold-body')).toBeNull();
    expect(finalText).toBeTruthy();
    expect(card!.compareDocumentPosition(finalText!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a streamed tool result survives completion outside the folded activity body', async () => {
    const m = message();
    const view = await renderReady(<ChatMessageView message={m} streaming />);
    const frame = view.container.querySelector('iframe');
    view.rerender(<ChatMessageView message={m} collapsedTurn />);
    await waitFor(() => expect(view.container.querySelector('iframe')).toBeTruthy());
    expect(view.container.querySelector('.turn-fold-body .ma-ui-card')).toBeNull();
    expect(view.container.querySelector('iframe')).toBeTruthy();
  });

  it('MCP text envelopes are accepted as artifact outputs', async () => {
    const m = message(false);
    m.toolCalls![0].name = 'mcp__muster__ui_render';
    m.toolCalls![0].result = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ link: path }) }] });
    const view = await renderReady(<ChatMessageView message={m} collapsedTurn />);
    expect(view.container.querySelector('iframe')).toBeTruthy();
  });
  it('the real Pi host execution envelope is displayed even without a final link', async () => {
    const m = message(true);
    const call = (m.parts![0] as { toolCall: ToolCallRecord }).toolCall;
    call.name = 'ui_render'; call.result = JSON.stringify({ ok: true, result: { link: path, version: 1 } });
    const view = await renderReady(<ChatMessageView message={m} collapsedTurn staleTurn />);
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('paragraph/strong-wrapped artifacts become blocks; repeated links are deduplicated', async () => {
    const spaced = 'E:/with spaces/agent-sessions/a/ui/01-example.inline.html';
    const view = await renderReady(<MarkdownBody text={`前文 **[预算](<${spaced}>)** 后文\n\n再次 [预算](<${spaced}>).`} />);
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(view.container.querySelectorAll('p .ma-ui-card')).toHaveLength(0);
    expect(view.container.textContent).toContain('前文');
    expect(view.container.textContent).toContain('后文');
  });
  it.each(['fenced', 'inline', 'bare'])('a path quoted as %s does not hide the tool output', async kind => {
    const text = kind === 'fenced' ? '```markdown\n' + markdown + '\n```' : kind === 'inline' ? '`' + markdown + '`' : path;
    const view = await renderReady(<ChatMessageView message={message(true, text)} collapsedTurn />);
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1);
  });
  it('reference-style Markdown links become one independent artifact block', async () => {
    const text = `[预算][ui]\n\n再次 [预算][ui]\n\n[ui]: <${path}>`;
    const view = await renderReady(<ChatMessageView message={message(true, text)} collapsedTurn />);
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1);
    expect(view.container.querySelectorAll('p .ma-ui-card')).toHaveLength(0);
  });
});
