import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ChatTranscript, type TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage } from '../../src/shared/types';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const model: TranscriptModelBinding<ChatMessage> = { toDisplay: (message) => message };
const user = (id: string, queued = false): ChatMessage => ({ id, role: 'user', content: id, createdAt: Date.now(), queued });
const reply = (id: string): ChatMessage => ({
  id, role: 'assistant', content: '', createdAt: Date.now(),
  parts: [
    { kind: 'text', text: `${id} 开头` },
    { kind: 'tool', toolCall: { id: `${id}-tool`, name: 'sessions.list', arguments: '{}', result: 'ok', status: 'ok' } },
    { kind: 'text', text: `${id} 结尾` }
  ]
});

describe('当前轮次正文折叠', () => {
  it('结束和排队期间保留当前轮所有正文；下一轮发送后折叠，仍可展开', () => {
    const u1 = user('问题一');
    const a1 = reply('回复一');
    const a2 = reply('回复二');
    const queued = user('问题二', true);
    const props = { sessionId: 'fold-current', model };
    const view = render(<ChatTranscript {...props} busy messages={[u1, a1, a2]} />);
    expect(screen.getByText('回复一 开头')).toBeTruthy();
    expect(screen.getByText('回复二 开头')).toBeTruthy();
    view.rerender(<ChatTranscript {...props} busy={false} messages={[u1, a1, a2, queued]} />);
    expect(screen.getByText('回复一 开头')).toBeTruthy();
    expect(screen.getByText('回复二 开头')).toBeTruthy();
    view.rerender(<ChatTranscript {...props} busy messages={[u1, a1, a2, { ...queued, queued: false }]} />);
    expect(screen.queryByText('回复一 开头')).toBeNull();
    expect(screen.queryByText('回复二 开头')).toBeNull();
    expect(screen.getByText('回复一 结尾')).toBeTruthy();
    expect(screen.getByText('回复二 结尾')).toBeTruthy();
    const firstRow = document.querySelector('[data-mid="回复一"]') as HTMLElement;
    fireEvent.click(firstRow.querySelector('.turn-fold')!);
    expect(within(firstRow).getByText('回复一 开头')).toBeTruthy();
  });

  it('重载时恢复当前轮，静默插话和超期时间不提前折叠', () => {
    const oldReply = { ...reply('超期回复'), createdAt: Date.now() - 25 * 3600_000 };
    const hostMessage = { ...user('宿主插话'), steering: 'host' as const };
    render(<ChatTranscript sessionId="reload-current" model={model} busy={false}
      messages={[user('问题'), oldReply, hostMessage]} />);
    expect(screen.getByText('超期回复 开头')).toBeTruthy();
    expect(screen.getByText('超期回复 结尾')).toBeTruthy();
  });

  it('读信后的当前回复结束时折叠已完成工具，保留正文和信件；展开可查看工具', () => {
    const mail = { id: 'mail-read', name: 'sessions.readMessages', arguments: '{}', status: 'ok' as const,
      result: JSON.stringify({ messages: [{ id: 'letter', from: 'host', fromName: 'host', text: '通知正文', read: true }] }) };
    const message: ChatMessage = { id: 'mail-reply', role: 'assistant', content: '', createdAt: Date.now(), parts: [
      { kind: 'text', text: '阅读之前' }, { kind: 'tool', toolCall: mail },
      { kind: 'text', text: '阅读之后' }, { kind: 'tool', toolCall: { ...mail, id: 'suggest', name: 'ui.suggestReplies' } },
      { kind: 'text', text: '最终答复' }
    ] };
    const props = { sessionId: 'mail-current', model, messages: [user('问题'), { ...user('宿主提醒'), host: true }, message] };
    const view = render(<ChatTranscript {...props} busy />);
    expect(document.querySelectorAll('.tool-call-group-details')).toHaveLength(2);
    expect(document.querySelectorAll('.tool-card')).toHaveLength(0);
    view.rerender(<ChatTranscript {...props} busy={false} />);
    const row = document.querySelector('[data-mid="mail-reply"]') as HTMLElement;
    expect(within(row).getByText('阅读之前')).toBeTruthy();
    expect(within(row).getByText('阅读之后')).toBeTruthy();
    expect(within(row).getByText('最终答复')).toBeTruthy();
    expect(within(row).getByText('通知正文')).toBeTruthy();
    expect(row.querySelectorAll('.tool-card')).toHaveLength(0);
    const fold = row.querySelector('.turn-fold') as HTMLElement;
    expect(fold).toBeTruthy();
    fireEvent.click(fold);
    const summaries = row.querySelectorAll('.tool-call-group-details > summary');
    expect(summaries).toHaveLength(2);
    summaries.forEach(summary => fireEvent.click(summary));
    expect(row.querySelectorAll('.tool-card')).toHaveLength(2);
    expect(within(row).getAllByText('通知正文')).toHaveLength(1);
    const [first, second] = row.querySelectorAll('.tool-card');
    expect(first.compareDocumentPosition(within(row).getByText('通知正文')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(row).getByText('阅读之后').compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('没有用户消息的旧记录只保留最后一条回复展开', () => {
    render(<ChatTranscript sessionId="legacy-current" model={model} busy={false}
      messages={[reply('旧回复'), reply('最新回复')]} />);
    expect(screen.queryByText('旧回复 开头')).toBeNull();
    expect(screen.getByText('最新回复 开头')).toBeTruthy();
  });
});
