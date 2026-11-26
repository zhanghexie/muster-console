/**
 * 会话等待与工具运行态：活跃时使用场景对应图形，内容到达或执行结束即收口。
 * 样式动画另由 CSS 守卫；此处覆盖真实组件的状态流转。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { currentApiMock } from './helpers/api-mock';
import type { ChatMessage } from '../../src/shared/types';

describe('会话状态图标（组件级）', () => {
  it('空 assistant 流式中：显示三点和努力工作中', async () => {
    const message: ChatMessage = { id: 'm1', role: 'assistant', content: '', createdAt: 1 };
    const { container } = render(<ChatMessageView message={message} streaming />);
    expect(container.querySelectorAll('.chat-pending-lite .waiting-activity-dot')).toHaveLength(3);
    expect(container.querySelector('.waiting-tip-working')?.textContent).toBe('努力工作中');
    expect(container.querySelector('.chat-pending-lite .typing-dots')).toBeNull();
    await waitFor(() => expect(currentApiMock().mockOf('config.waitingTips')).toHaveBeenCalled());
  });

  it('空 assistant 消息未流式：不显示等待动效', () => {
    const message: ChatMessage = { id: 'm2', role: 'assistant', content: '', createdAt: 1 };
    const { container } = render(<ChatMessageView message={message} />);
    expect(container.querySelector('.waiting-tip, .typing-dots')).toBeNull();
  });

  it('正文到达后三点消失（不该一直跳）', () => {
    const message: ChatMessage = {
      id: 'm3',
      role: 'assistant',
      content: '',
      createdAt: 1,
      parts: [{ kind: 'text', text: '你好，已收到。' }]
    };
    const { container } = render(<ChatMessageView message={message} streaming />);
    expect(container.querySelector('.typing-dots')).toBeNull();
  });

  it('命令运行时显示无边框的执行图标，完成后静止并移除运行状态', () => {
    const tool = (status: 'running' | 'ok'): ChatMessage => ({
      id: 'm4',
      role: 'assistant',
      content: '',
      createdAt: 1,
      parts: [
        { kind: 'tool', toolCall: { id: 't1', name: 'bash', arguments: '{"command":"npm test"}', status } }
      ]
    });
    const running = render(<ChatMessageView message={tool('running')} streaming />);
    expect(running.container.querySelector('.terminal-activity.is-active .terminal-activity-command')).toBeTruthy();
    expect(running.container.querySelectorAll('.terminal-activity-glyph path')).toHaveLength(2);
    expect(running.container.querySelector('.terminal-activity rect, .terminal-activity-frame')).toBeNull();
    expect(running.container.querySelector('.tool-lite-detail')?.textContent).toBe('npm test');
    expect(running.container.querySelector('.tool-activity-label')?.textContent).toBe('执行中');
    expect(running.container.querySelector('.tool-card .typing-dots')).toBeNull();

    running.rerender(<ChatMessageView message={tool('ok')} streaming />);
    expect(running.container.querySelector('.tool-call-group')).toBeTruthy();
    expect(running.container.querySelector('.tool-call-group-label')?.textContent).toBe('调用了工具');
    expect(running.container.querySelector('.tool-call-block')).toBeNull();
    running.rerender(<ChatMessageView message={tool('ok')} streaming={false} />);
    expect(running.container.querySelector('.tool-call-group')).toBeTruthy();
    expect(running.container.querySelector('.tool-call-group-label')?.textContent).toBe('调用了工具');
    expect(running.container.querySelector('.tool-activity-label')).toBeNull();
  });

  it('连续工具调用归并为两层折叠，外层显示最新调用，列表项可展开详情', () => {
    const tool = (id: string, status: 'running' | 'ok', command: string) => ({
      kind: 'tool' as const,
      toolCall: { id, name: 'bash', arguments: JSON.stringify({ command }), status }
    });
    const view = render(
      <ChatMessageView
        message={{
          id: 'streaming-stack',
          role: 'assistant',
          content: '',
          createdAt: 1,
          parts: [
            tool('done-1', 'ok', 'git status'),
            tool('done-2', 'ok', 'git diff'),
            tool('current', 'running', 'npm test')
          ]
        }}
        streaming
      />
    );
    const group = view.container.querySelector<HTMLDetailsElement>('.tool-call-group-details');
    expect(group).toBeTruthy();
    expect(view.container.querySelector('.tool-lite-detail')?.textContent).toBe('npm test');
    expect(view.container.textContent).not.toContain('git status');
    expect(view.container.textContent).not.toContain('git diff');
    expect(group!.open).toBe(false);

    fireEvent.click(group!.querySelector('summary')!);
    expect(group!.open).toBe(true);
    expect(group!.querySelectorAll('.tool-call-block')).toHaveLength(3);
    const first = group!.querySelector<HTMLDetailsElement>('.tool-card')!;
    fireEvent.click(first.querySelector('summary')!);
    expect(first.open).toBe(true);

    view.rerender(
      <ChatMessageView
        message={{
          id: 'streaming-stack',
          role: 'assistant',
          content: '',
          createdAt: 1,
          parts: [
            tool('done-1', 'ok', 'git status'),
            tool('done-2', 'ok', 'git diff'),
            tool('current', 'ok', 'npm test')
          ]
        }}
        streaming={false}
      />
    );
    expect(view.container.querySelectorAll('.tool-call-block')).toHaveLength(3);
    view.unmount();
  });

  it('隐藏的思考片段不留下看不见的工具分组边界', () => {
    const message: ChatMessage = {
      id: 'hidden-thinking-between-tools',
      role: 'assistant',
      content: '',
      createdAt: 1,
      parts: [
        { kind: 'tool', toolCall: { id: 'first', name: 'bash', arguments: '{"command":"one"}', status: 'ok' } },
        { kind: 'thinking', text: '隐藏的中间思考' },
        { kind: 'tool', toolCall: { id: 'second', name: 'bash', arguments: '{"command":"two"}', status: 'ok' } }
      ]
    };
    const { container } = render(<ChatMessageView message={message} streaming={false} />);
    expect(container.querySelectorAll('.tool-call-group-details')).toHaveLength(1);
    const group = container.querySelector<HTMLDetailsElement>('.tool-call-group-details')!;
    fireEvent.click(group.querySelector('summary')!);
    expect(group.querySelectorAll('.tool-call-block')).toHaveLength(2);
  });

  it('正文打断连续调用后保留两个工具分组，并按原始顺序排列', () => {
    const tool = (id: string, command: string) => ({
      kind: 'tool' as const,
      toolCall: { id, name: 'bash', arguments: JSON.stringify({ command }), status: 'ok' as const }
    });
    const { container } = render(
      <ChatMessageView
        message={{
          id: 'ordered-tools',
          role: 'assistant',
          content: '',
          createdAt: 1,
          parts: [
            { kind: 'text', text: '开始' },
            tool('first', 'git status'),
            tool('second', 'git diff'),
            { kind: 'text', text: '中间说明' },
            tool('third', 'npm test'),
            { kind: 'text', text: '最终结果' }
          ]
        }}
        streaming={false}
      />
    );
    const markers = [...container.querySelectorAll<HTMLElement>('.chat-body > .turn-fold-item')]
      .map((item) => item.querySelector('.chat-text')?.textContent ?? (item.querySelector('.tool-call-group') ? '调用了工具' : ''))
      .filter(Boolean);
    expect(markers).toEqual(['开始', '调用了工具', '中间说明', '调用了工具', '最终结果']);
  });

  it('会话折叠头同时显示回合时长和工具数量', () => {
    const tool = (id: string) => ({
      kind: 'tool' as const,
      toolCall: { id, name: 'bash', arguments: '{"command":"npm test"}', status: 'ok' as const }
    });
    const { container } = render(
      <ChatMessageView
        message={{
          id: 'fold-duration',
          role: 'assistant',
          content: '完成',
          createdAt: 1_000,
          finishedAt: 5_500,
          parts: [tool('first'), tool('second'), { kind: 'text', text: '完成' }]
        }}
        collapsedTurn
      />
    );
    const label = container.querySelector('.turn-fold-label')?.textContent ?? '';
    expect(label).toContain('工作了 5 秒');
    expect(label).toContain('2 个工具调用');
  });

  it('非命令工具运行中保留其图标并显示运行状态，结束后状态消失', () => {
    const tool = (status: 'running' | 'ok'): ChatMessage => ({
      id: 'm6', role: 'assistant', content: '', createdAt: 1,
      parts: [{ kind: 'tool', toolCall: { id: 't2', name: 'read_file', arguments: '{"path":"a.txt"}', status } }]
    });
    const view = render(<ChatMessageView message={tool('running')} streaming />);
    expect(view.container.querySelector('.wrench-activity.tool-activity-icon')).toBeTruthy();
    expect(view.container.querySelector('.tool-lite-detail')?.textContent).toBe('a.txt');
    expect(view.container.querySelector('.tool-activity-label')?.textContent).toBe('执行中');
    view.rerender(<ChatMessageView message={tool('ok')} streaming />);
    expect(view.container.querySelector('.tool-activity-icon')).toBeNull();
    expect(view.container.querySelector('.tool-activity-label')).toBeNull();
  });

  it.each([
    ['write', '{"path":"a.txt","content":"hello"}', 'write'],
    ['edit', '{"path":"a.txt","old_string":"a","new_string":"b"}', 'write'],
    ['apply_patch', '{}', 'write'],
    ['file_change', '{"changes":[{"path":"a.txt","kind":"update"}]}', 'write'],
    ['write_file', '{}', 'write'],
    ['command_execution', '{}', 'terminal'],
    ['grep', '{}', 'tool'],
    ['bgtasks.wait', '{}', 'tool'],
    ['askquestion', '{}', 'tool']
  ])('工具 %s 使用场景对应图标', (name, args, kind) => {
    const message: ChatMessage = {
      id: `kind-${name}`, role: 'assistant', content: '', createdAt: 1,
      parts: [{ kind: 'tool', toolCall: { id: 'call', name, arguments: args, status: 'running' } }]
    };
    const { container, rerender } = render(<ChatMessageView message={message} streaming />);
    const icons = { terminal: '.terminal-activity', write: '.write-activity', tool: '.wrench-activity' };
    expect(container.querySelector(icons[kind as keyof typeof icons])).toBeTruthy();
    rerender(<ChatMessageView message={{ ...message, parts: [{ kind: 'tool', toolCall: { id: 'call', name, arguments: args, status: 'ok' } }] }} streaming />);
    expect(container.querySelector('.terminal-activity.is-active, .write-activity.is-active, .wrench-activity.tool-activity-icon')).toBeNull();
  });

  it('运行中没有命令或路径时只显示一次状态', () => {
    const message: ChatMessage = {
      id: 'm7', role: 'assistant', content: '', createdAt: 1,
      parts: [{ kind: 'tool', toolCall: { id: 't3', name: 'custom_tool', arguments: '{}', status: 'running' } }]
    };
    const { container } = render(<ChatMessageView message={message} streaming />);
    expect(container.querySelector('.tool-lite-detail')).toBeNull();
    expect(container.querySelector('.tool-activity-label')?.textContent).toBe('执行中');
  });

  it('当前思考段为空时显示轨道动画和思考提示；回合结束后消失', () => {
    const message: ChatMessage = { id: 'm5', role: 'assistant', content: '', createdAt: 1,
      parts: [{ kind: 'thinking', text: '' }] };
    const live = render(<ChatMessageView message={message} streaming />);
    expect(live.container.querySelector('.thinking-live .thinking-orbit')).toBeTruthy();
    expect(live.container.querySelector('.thinking-live-text')?.textContent).toBe('思考中…');
    expect(live.container.querySelector('.thinking-body')).toBeNull();
    live.rerender(<ChatMessageView message={message} />);
    expect(live.container.querySelector('.thinking-live')).toBeNull();
    expect(live.container.querySelector('.waiting-tip, .typing-dots')).toBeNull();
  });
});
