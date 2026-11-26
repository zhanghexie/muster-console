/**
 * 消息底部操作行「批注N」必须是按钮（点击展开批注），不能退化成纯文字。
 * 回归：把 hoverbar 里的 button 改成 span/文本节点时本文件应转红。
 * 运行: npx vitest run test/unit/chat-hoverbar-note.spec.tsx
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type {
  TranscriptModelBinding,
  TranscriptNote
} from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const model: TranscriptModelBinding<ChatMessage> = { toDisplay: (m) => m };

function assistant(partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '这段可以批注',
    createdAt: 1_720_000_000_000,
    ...partial
  };
}

const note: TranscriptNote = {
  id: 'n1',
  seq: 1,
  quote: '这段可以批注',
  note: '这里写错了',
  messageId: 'a1'
};

describe('消息操作行「批注N」', () => {
  it('有批注时 hoverbar 渲染可点击的「批注1」按钮，不是纯文字', () => {
    const { container } = render(
      <ChatTranscript
        messages={[assistant()]}
        busy={false}
        sessionId="s-note"
        model={model}
        notes={[note]}
        onFork={() => {}}
      />
    );
    const bar = container.querySelector('.chat-hoverbar');
    expect(bar).toBeTruthy();
    const btn = within(bar as HTMLElement).getByRole('button', { name: '批注1' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.classList.contains('chat-hoverbar-btn')).toBe(true);
    expect(btn.textContent).toBe('批注1');
    // 同排还有复制；「批注1」不能只是 hoverbar 里的裸文本节点
    const bare = Array.from(bar!.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes('批注')
    );
    expect(bare).toHaveLength(0);
  });

  it('点击操作行「批注1」展开批注气泡（锚点未量到也能开）', async () => {
    const user = userEvent.setup();
    const onNoteUpdate = vi.fn();
    render(
      <ChatTranscript
        messages={[assistant()]}
        busy={false}
        sessionId="s-note"
        model={model}
        notes={[note]}
        onNoteUpdate={onNoteUpdate}
        onFork={() => {}}
      />
    );
    await user.click(screen.getByRole('button', { name: '批注1' }));
    expect(document.querySelector('.msg-note-bubble-quote')).toBeNull();
    expect(screen.getByPlaceholderText('批注内容…')).toBeTruthy();
    expect((screen.getByPlaceholderText('批注内容…') as HTMLInputElement).value).toBe('这里写错了');
    expect(document.querySelector('.msg-note-bubble')).toBeTruthy();
  });

  it('无批注时操作行不出现「批注N」', () => {
    render(
      <ChatTranscript
        messages={[assistant()]}
        busy={false}
        sessionId="s-note"
        model={model}
        onFork={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: '批注1' })).toBeNull();
    expect(screen.queryByText('批注1')).toBeNull();
  });
});
