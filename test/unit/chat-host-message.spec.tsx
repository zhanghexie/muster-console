/**
 * 宿主系统事件条渲染契约：
 * host 消息（宿主注入、进模型上下文）走通栏布局——is-host + host 类、不套 user
 * 右缩进；标「宿主」+ 时间戳、绝不显示「我」。普通用户消息仍缩进（user 类 +「我」）。
 * 背景：编排事件 / sessions.message 审计副本曾套用户气泡，左侧大片空白。
 * 运行: npx vitest run test/unit/chat-host-message.spec.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
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

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: '【编排事件 · 1 条】\n- [提交落树]：commit: fix(ui): adjust workspace badge (0123456)',
    createdAt: Date.now(),
    ...partial
  };
}

const model: TranscriptModelBinding<ChatMessage> = {
  toDisplay: (m) => m
};

describe('ChatMessageView 宿主系统事件条', () => {
  it('host 消息 → 通栏（host/is-host、无 user）+ 「宿主」标签，不显示「我」', () => {
    const { container } = render(
      <ChatMessageView message={msg({ host: true })} quiet timeLabel="19:11" />
    );
    const el = container.querySelector('.chat-msg');
    expect(el?.classList.contains('is-host')).toBe(true);
    expect(el?.classList.contains('host')).toBe(true);
    expect(el?.classList.contains('user')).toBe(false);
    expect(el?.classList.contains('assistant')).toBe(false);
    expect(screen.getByText('宿主')).toBeTruthy();
    expect(container.querySelector('.chat-msg-avatar')?.getAttribute('data-avatar-sender')).toBe(
      'host'
    );
    expect(container.querySelector('.chat-time')?.textContent).toBe('19:11');
    expect(screen.getByText(/\[提交落树\]/)).toBeTruthy();
    expect(screen.queryByText('我')).toBeNull();
  });

  it('普通用户消息 → user 缩进类、无 is-host、显示「我」（非 quiet）', () => {
    const { container } = render(<ChatMessageView message={msg({})} />);
    const el = container.querySelector('.chat-msg');
    expect(el?.classList.contains('user')).toBe(true);
    expect(el?.classList.contains('is-host')).toBe(false);
    expect(el?.classList.contains('host')).toBe(false);
    expect(screen.queryByText('宿主')).toBeNull();
    expect(screen.getByText('我')).toBeTruthy();
  });

  it('quiet 普通用户消息 → 仍带 user 缩进类、无角色行', () => {
    const { container } = render(<ChatMessageView message={msg({})} quiet />);
    const el = container.querySelector('.chat-msg');
    expect(el?.classList.contains('user')).toBe(true);
    expect(el?.classList.contains('is-host')).toBe(false);
    expect(screen.queryByText('宿主')).toBeNull();
    expect(screen.queryByText('我')).toBeNull();
  });
});

describe('ChatTranscript 宿主消息不分用户回合', () => {
  it('宿主通栏且不进历史停靠点；用户消息仍缩进并可右键出历史', () => {
    const host = msg({
      id: 'h1',
      host: true,
      content: '【审计副本】sessions.message 已直投',
      parts: [{ kind: 'text', text: '【审计副本】sessions.message 已直投' }]
    });
    const user = msg({
      id: 'u1',
      content: '请改布局',
      parts: [{ kind: 'text', text: '请改布局' }]
    });
    const { container } = render(
      <ChatTranscript
        busy={false}
        sessionId="s-host"
        model={model}
        messages={[host, user]}
      />
    );
    const hostAnchor = container.querySelector('[data-mid="h1"]');
    const userAnchor = container.querySelector('[data-mid="u1"]');
    expect(hostAnchor?.getAttribute('data-role')).toBe('host');
    expect(hostAnchor?.className).not.toContain('is-history-trigger');
    expect(hostAnchor?.querySelector('.chat-msg')?.classList.contains('is-host')).toBe(true);
    expect(hostAnchor?.querySelector('.chat-msg')?.classList.contains('user')).toBe(false);

    expect(userAnchor?.getAttribute('data-role')).toBe('user');
    expect(userAnchor?.className).toContain('is-history-trigger');
    expect(userAnchor?.querySelector('.chat-msg')?.classList.contains('user')).toBe(true);
    expect(userAnchor?.querySelector('.chat-msg')?.classList.contains('is-host')).toBe(false);
  });
});
