/**
 * 批注三入口必须共用同一打开态：锚点被折叠/重挂卸掉后，角标、操作行、输入框药丸
 * 仍能打开同一气泡且指向正确批注。点外关气泡不得误伤这三入口（否则 mousedown 先关）。
 * 回归：去掉 data-note-entry / isSessionNoteEntryTarget 豁免，或把打开态拆回转写私有，本文件应转红。
 * 运行: npx vitest run test/unit/chat-note-entries.spec.tsx
 */
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import { PENDING_NOTE_ID } from '../../src/renderer/src/agentChat/noteAnchors';
import {
  isSessionNoteEntryTarget,
  revealNoteInView
} from '../../src/renderer/src/chatSurface/noteEntries';
import type {
  TranscriptModelBinding,
  TranscriptNote
} from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';

const noteEditorRenders = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/src/components/NoteEditor', async () => {
  const React = await import('react');
  const actual = await vi.importActual<typeof import('../../src/renderer/src/components/NoteEditor')>('../../src/renderer/src/components/NoteEditor');
  return { ...actual, NoteEditor: (props: React.ComponentProps<typeof actual.NoteEditor>) => {
    noteEditorRenders();
    return React.createElement(actual.NoteEditor, props);
  } };
});

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const model: TranscriptModelBinding<ChatMessage> = { toDisplay: (m) => m };

// 时间衰减（R-23）后写死 2024 时间戳会被判「超期归档」不可展开——
// 本 spec 测批注/折叠交互（非衰减），fixture 一律用近期时间戳
function assistant(id: string, content: string, createdAt = Date.now()): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    createdAt,
    parts: [{ kind: 'text', text: content }]
  };
}

const notes: TranscriptNote[] = [
  { id: 'n1', seq: 1, quote: '第一段原文', note: '批一', messageId: 'a1' },
  { id: 'n2', seq: 2, quote: '第二段原文', note: '批二', messageId: 'a1' },
  { id: 'n3', seq: 3, quote: '另一条消息', note: '批三', messageId: 'a2' }
];

function ThreeEntryHarness(props: {
  notes: TranscriptNote[];
  messages: ChatMessage[];
  sessionId?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <div data-testid="composer-notes">
        {props.notes.map((n) => (
          <span
            key={n.id}
            className="composer-token"
            data-token={`批注${n.seq}`}
            data-note-id={n.id}
            data-note-entry=""
            onMouseDown={() => setOpen(n.id)}
          >
            {`批注${n.seq}`}
          </span>
        ))}
      </div>
      <ChatTranscript
        messages={props.messages}
        busy={false}
        sessionId={props.sessionId ?? 's-notes'}
        model={model}
        notes={props.notes}
        openNoteId={open}
        onOpenNote={setOpen}
        onFork={() => {}}
      />
    </div>
  );
}

describe('isSessionNoteEntryTarget', () => {
  it('角标 / 操作行 / 输入框药丸 / 气泡算入口；复制钮和空白不算', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button class="msg-note-badge" data-note-entry>1</button>
      <button class="chat-hoverbar-btn is-note" data-note-entry>批注1</button>
      <button class="chat-hoverbar-btn">复制</button>
      <span class="composer-token" data-note-id="n1" data-note-entry>批注1<span class="composer-token-x">×</span></span>
      <div class="msg-note-bubble"><input /></div>
    `;
    document.body.appendChild(root);
    expect(isSessionNoteEntryTarget(root.querySelector('.msg-note-badge'))).toBe(true);
    expect(isSessionNoteEntryTarget(root.querySelector('.is-note'))).toBe(true);
    expect(isSessionNoteEntryTarget(root.querySelector('.composer-token'))).toBe(true);
    expect(isSessionNoteEntryTarget(root.querySelector('.composer-token-x'))).toBe(true);
    expect(isSessionNoteEntryTarget(root.querySelector('.msg-note-bubble input'))).toBe(true);
    expect(isSessionNoteEntryTarget(root.querySelector('.chat-hoverbar-btn:not(.is-note)'))).toBe(
      false
    );
    expect(isSessionNoteEntryTarget(document.body)).toBe(false);
    root.remove();
  });
});

describe('revealNoteInView', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('没有锚点时滚到所属消息，不静默 return', () => {
    const root = document.createElement('div');
    root.innerHTML = `<div data-mid="a2">另一条</div>`;
    document.body.appendChild(root);
    revealNoteInView(root, { noteId: 'n3', messageId: 'a2' });
    const wrap = root.querySelector('[data-mid="a2"]') as HTMLElement;
    expect(wrap.scrollIntoView).toHaveBeenCalled();
    root.remove();
  });

  it('有锚点时滚锚点并闪一下', () => {
    const root = document.createElement('div');
    root.innerHTML = `<span class="msg-note-anchor" data-note-id="n1">原文</span>`;
    document.body.appendChild(root);
    revealNoteInView(root, { noteId: 'n1', messageId: 'a1' });
    const anchor = root.querySelector('.msg-note-anchor') as HTMLElement;
    expect(anchor.scrollIntoView).toHaveBeenCalled();
    expect(anchor.classList.contains('is-flash')).toBe(true);
    root.remove();
  });
});

describe('批注三入口（锚点卸掉后）', () => {
  const messages = [assistant('a1', '第一段原文 第二段原文'), assistant('a2', '另一条消息')];

  it('切屏隐藏批注编辑器，返回原屏保留未提交文字', async () => {
    const user = userEvent.setup();
    const layout = (peek: boolean) => <div className="h-strip" data-testid="note-strip">
      <div data-h-page="terminal" data-h-peek={peek ? '' : undefined}>
        <ThreeEntryHarness notes={notes} messages={messages} />
      </div>
      <div data-h-page="git" data-h-peek={peek ? undefined : ''}><button>右屏操作</button></div>
    </div>;
    const view = render(layout(false));
    await user.click(view.container.querySelector('.msg-note-badge')!);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox');
    const bubble = input.closest('.msg-note-bubble');
    expect(bubble?.parentElement).toBe(screen.getByTestId('note-strip'));
    await user.type(input, '保留的草稿');
    view.rerender(layout(true));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(bubble?.hasAttribute('inert')).toBe(true);
    expect(bubble?.getAttribute('data-mp-stage')).toBe('out');
    await user.click(screen.getByRole('button', { name: '右屏操作' }));
    view.rerender(layout(false));
    await waitFor(() => expect(screen.getByRole('textbox')).toBe(input));
    expect(input.value).toContain('保留的草稿');
  });

  it('锚点不在 DOM 时角标仍在（is-from-bar），不是消失', () => {
    const { container } = render(<ThreeEntryHarness notes={notes} messages={messages} />);
    expect(container.querySelector('.msg-note-anchor')).toBeNull();
    const badges = container.querySelectorAll('.msg-note-badge.is-from-bar');
    expect(badges).toHaveLength(3);
    expect([...badges].map((b) => b.textContent)).toEqual(['1', '2', '3']);
  });

  it('无锚点时点角标也打开对应气泡（不是总开第一条）', async () => {
    const user = userEvent.setup();
    const { container } = render(<ThreeEntryHarness notes={notes} messages={messages} />);
    const badge2 = [...container.querySelectorAll('.msg-note-badge')].find((b) => b.textContent === '2');
    expect(badge2).toBeTruthy();
    await user.click(badge2!);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('批二');
  });

  it('相同位置的滚动不重绘编辑气泡，位置改变仍及时更新', async () => {
    const user = userEvent.setup();
    let left = 30;
    noteEditorRenders.mockClear();
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('msg-note-bubble-anchor')) return { x: left, y: 40, left, top: 40, right: left, bottom: 40, width: 0, height: 0, toJSON() {} };
      return original.call(this);
    });
    try {
      const { container } = render(<ThreeEntryHarness notes={notes} messages={messages} />);
      await user.click(container.querySelector('.msg-note-badge')!);
      const bubble = document.querySelector('.msg-note-bubble') as HTMLElement;
      expect(bubble.style.left).toBe('30px');
      const settled = noteEditorRenders.mock.calls.length;
      fireEvent.scroll(document);
      expect(noteEditorRenders).toHaveBeenCalledTimes(settled);
      left = 60;
      fireEvent.scroll(document);
      expect(bubble.style.left).toBe('60px');
    } finally { rect.mockRestore(); }
  });

  it('操作行与输入框药丸打开同一条批注的气泡（按原文对上，不是总开第一条）', async () => {
    const user = userEvent.setup();
    render(<ThreeEntryHarness notes={notes} messages={messages} />);
    const bar = document.querySelectorAll('.chat-hoverbar')[0] as HTMLElement;
    await user.click(within(bar).getByRole('button', { name: '批注2' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('批二');
    expect(document.querySelector('.msg-note-bubble')).toBeTruthy();

    const composer = screen.getByTestId('composer-notes');
    fireEvent.mouseDown(within(composer).getByText('批注3'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('批三');
    expect(screen.queryByDisplayValue('批二')).toBeNull();
    expect(document.querySelectorAll('.msg-note-bubble')).toHaveLength(1);
  });

  it('气泡已开时，mousedown 操作行/药丸不会被点外监听先关掉', async () => {
    const user = userEvent.setup();
    render(<ThreeEntryHarness notes={notes} messages={messages} />);
    const bar = document.querySelectorAll('.chat-hoverbar')[0] as HTMLElement;
    const btn = within(bar).getByRole('button', { name: '批注1' });
    await user.click(btn);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('批一');

    fireEvent.mouseDown(btn);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('批一');

    fireEvent.mouseDown(screen.getByTestId('composer-notes').querySelector('[data-note-id="n1"]')!);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('批一');
  });

  it('汇总条点开折叠轮上的批注时展开该轮并打开气泡', async () => {
    const folded: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '最终结论',
      createdAt: Date.now(),
      parts: [
        { kind: 'thinking', text: '盘算一下' },
        { kind: 'tool', toolCall: { id: 'tool', name: 'sessions.list', arguments: '{}', status: 'ok', result: 'ok' } },
        { kind: 'text', text: '中间说明' },
        { kind: 'text', text: '最终结论' }
      ]
    };
    const noteOnFold: TranscriptNote = {
      id: 'n3',
      seq: 3,
      quote: '中间说明',
      note: '改这里',
      messageId: 'a1'
    };
    // 折叠展开态记在模块级全局 Map（transcriptFoldState，按 transcriptKey+消息 id），
    // 前面用例打开批注会把 s-notes:0/a1 记成展开；用独立 sessionId 隔离，确保本轮初始真收起。
    render(
      <ThreeEntryHarness notes={[noteOnFold]} messages={[folded, assistant('a2', '后一轮')]} sessionId="s-fold-note" />
    );
    // 稳态收起的真实信号：折叠头 aria-expanded=false、折叠体随 usePresence mounted 结束卸载，
    // 而不是硬等一个（全局 fold 记忆污染时）永不发生的「中间说明消失」。
    await waitFor(() => {
      expect(document.querySelector('.turn-fold')?.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelector('.turn-fold-body')).toBeNull();
    });
    expect(screen.queryByText('中间说明')).toBeNull();
    expect(document.querySelector('.turn-fold')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('composer-notes').querySelector('[data-note-id="n3"]')!);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('改这里');
    expect(screen.getByText('中间说明')).toBeTruthy();
    expect(document.querySelector('.turn-fold')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('点空白才关气泡', async () => {
    const user = userEvent.setup();
    render(<ThreeEntryHarness notes={notes} messages={messages} />);
    const bar = document.querySelectorAll('.chat-hoverbar')[0] as HTMLElement;
    await user.click(within(bar).getByRole('button', { name: '批注1' }));
    expect(document.querySelector('.msg-note-bubble')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(document.querySelector('.msg-note-bubble')).toBeNull();
  });
});

describe('待录入气泡（pending）', () => {
  const messages = [assistant('a1', '第一段原文')];

  function PendingHarness(props: { onCancel: () => void; onConfirm: (note: string) => void }) {
    return (
      <ChatTranscript
        messages={messages}
        busy={false}
        sessionId="s-pending"
        model={model}
        pendingNote={{ quote: '第一段原文', messageId: 'a1', span: document.createElement('span') }}
        onPendingConfirm={props.onConfirm}
        onPendingCancel={props.onCancel}
        onFork={() => {}}
      />
    );
  }

  /** jsdom 无布局：手挂 pending 锚点并桩矩形，再经 resize 触发量位 effect */
  async function mountWithMeasuredPending(container: HTMLElement): Promise<void> {
    const mid = container.querySelector('[data-mid="a1"]') as HTMLElement;
    expect(mid).toBeTruthy();
    const anchor = document.createElement('span');
    anchor.className = 'msg-note-anchor';
    anchor.setAttribute('data-note-id', PENDING_NOTE_ID);
    mid.appendChild(anchor);
    mid.getBoundingClientRect = () =>
      ({ width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100 }) as DOMRect;
    anchor.getBoundingClientRect = () =>
      ({ width: 50, height: 20, top: 10, left: 5, right: 55, bottom: 30 }) as DOMRect;
    window.dispatchEvent(new Event('resize'));
    // bump 有 RO_SETTLE_MS 防抖：waitFor 等量位完成渲染出 pending 气泡，不与具体时长耦合
    await waitFor(() => {
      expect(document.querySelector('[data-note-pending]')).toBeTruthy();
    });
  }

  it('气泡内 mousedown（聚焦输入框 / 点 ✓）不取消录入，✓ 点击能保存', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(<PendingHarness onCancel={onCancel} onConfirm={onConfirm} />);
    await mountWithMeasuredPending(container);

    const input = document.querySelector('.msg-note-bubble-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.mouseDown(input);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.querySelector('[data-note-pending]')).toBeTruthy();

    await user.type(input, '改成这样');
    const ok = document.querySelector('.msg-note-bubble-ok') as HTMLButtonElement;
    await user.click(ok);
    expect(onConfirm).toHaveBeenCalledWith('改成这样');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('底部锚点的编辑卡挂到 body，实际高度变化后仍能点保存且不重复原文', async () => {
    let height = 220;
    const rect = (top: number, left: number, width: number, h: number) =>
      ({ top, left, width, height: h, bottom: top + h, right: left + width }) as DOMRect;
    const original = HTMLElement.prototype.getBoundingClientRect;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('msg-note-bubble-anchor')) return rect(600, 900, 0, 0);
      if (this.classList.contains('chat-list-shell')) return rect(80, 200, 800, 600);
      if (this.classList.contains('agent-chat-composer-wrap')) return rect(620, 200, 800, 120);
      return original.call(this);
    });
    const size = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('msg-note-bubble') ? height : 0;
    });
    try {
      const onConfirm = vi.fn();
      const { container } = render(<div className="chat-surface-view">
        <PendingHarness onCancel={() => {}} onConfirm={onConfirm}/>
        <div className="agent-chat-composer-wrap"/>
      </div>);
      await mountWithMeasuredPending(container);
      const card = document.querySelector<HTMLElement>('[data-note-pending]')!;
      expect(card.parentElement).toBe(document.body);
      expect(within(card).queryByText('第一段原文')).toBeNull();
      expect(Number.parseFloat(card.style.top) + height).toBeLessThanOrEqual(620);
      expect(Number.parseFloat(card.style.left) + 420).toBeLessThanOrEqual(1000);
      height = 410;
      fireEvent(window, new Event('resize'));
      expect(Number.parseFloat(card.style.top) + height).toBeLessThanOrEqual(620);
      fireEvent.change(within(card).getByRole('textbox'), { target: { value: '批注正文' } });
      fireEvent.mouseDown(within(card).getByRole('button', { name: '保存' }));
      fireEvent.click(within(card).getByRole('button', { name: '保存' }));
      expect(onConfirm).toHaveBeenCalledWith('批注正文');
    } finally { bounds.mockRestore(); size.mockRestore(); }
  });

  it('点入口（药丸/角标）或空白仍取消录入', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(
      <>
        <span data-testid="pill" data-note-entry="">
          批注
        </span>
        <PendingHarness onCancel={onCancel} onConfirm={onConfirm} />
      </>
    );
    await mountWithMeasuredPending(container);
    expect(document.querySelector('[data-note-pending]')).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId('pill'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
