/**
 * 调度 askQuestion 提问卡：渲染 / 点选回注 chat.respondUserQuestion。
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DispatchUserQuestionCard,
  UserQuestionCard
} from '../../src/renderer/src/chatSurface/guiApprovalCards';
import { dispatchTranscriptBinding } from '../../src/renderer/src/chatSurface/guiMessageView';
import { currentApiMock } from './helpers/api-mock';
import { cursorPlanQuestion } from '../../src/main/agentSession/drivers/acp/cursor';
import type { ChatMessage, ChatUserQuestionView } from '../../src/shared/types';

const pending: ChatUserQuestionView = {
  questionId: 'q-orch-1',
  questions: [
    {
      id: 'arch',
      header: '选方案',
      question: '用哪种架构？',
      options: [{ label: 'A' }, { label: 'B', description: '更简单' }]
    }
  ],
  status: 'pending',
  anchorPartIndex: 1
};

const assistant: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  content: '',
  createdAt: 1,
  userQuestion: pending
};

describe('调度 askQuestion 提问卡', () => {
  it('Worker 文本提问保留默认值、多行和首尾空格', async () => {
    const user = userEvent.setup(), respond = vi.fn().mockResolvedValue({ ok: true });
    render(<UserQuestionCard sessionId="worker" onRespond={respond} card={{ questionId: 'text-1', status: 'pending',
      questions: [{ id: 'text', question: '请输入', textInput: { defaultValue: '初始值', placeholder: '输入内容', multiline: true } }] }} />);
    const input = screen.getByPlaceholderText('输入内容') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.value).toBe('初始值');
    await user.clear(input); await user.type(input, '  A{Enter}B  ');
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(respond).toHaveBeenCalledWith({ questionId: 'text-1', action: 'answer',
      answers: [{ id: 'text', selected: [], custom: '  A\nB  ' }] });
  });

  it('Worker 文本提问可以显式提交空字符串', async () => {
    const user = userEvent.setup(), respond = vi.fn().mockResolvedValue({ ok: true });
    render(<UserQuestionCard sessionId="worker" onRespond={respond} card={{ questionId: 'text-2', status: 'pending',
      questions: [{ id: 'text', question: '请输入', textInput: {} }] }} />);
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(respond).toHaveBeenCalledWith({ questionId: 'text-2', action: 'answer', answers: [{ id: 'text', selected: [], custom: '' }] });
  });
  it('已提交的空白和多行文本不会显示为未作答', () => {
    const { rerender } = render(<UserQuestionCard sessionId="worker" onRespond={vi.fn()} card={{ questionId: 'text-3', status: 'answered',
      questions: [{ id: 'text', question: '请输入', textInput: {} }], answers: [{ id: 'text', selected: [], custom: '  ' }] }} />);
    expect(screen.getByText('空白文本')).toBeTruthy();
    rerender(<UserQuestionCard sessionId="worker" onRespond={vi.fn()} card={{ questionId: 'text-3', status: 'answered',
      questions: [{ id: 'text', question: '请输入', textInput: { multiline: true } }], answers: [{ id: 'text', selected: [], custom: ' A\nB ' }] }} />);
    expect(screen.getByText((_, node) => node?.className === 'ac-uq-settled-a' && node.textContent === ' A\nB ')).toBeTruthy();
  });
  it('shows the full Cursor ACP plan before submitting explicit approval', async () => {
    const user = userEvent.setup();
    const request = cursorPlanQuestion({ name: '检查计划', plan: '1. 检查文件\n2. 运行测试' });
    render(<UserQuestionCard sessionId="cursor-session" card={{ questionId: 'cursor-request', status: 'pending',
      anchorPartIndex: 0, questions: request.questions }} />);
    expect(screen.getByText(/1\. 检查文件/).textContent).toContain('2. 运行测试');
    await user.click(screen.getByRole('button', { name: '批准' }));
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(currentApiMock().mockOf('agentSession.respondUserQuestion')).toHaveBeenCalledWith({
      sessionId: 'cursor-session', questionId: 'cursor-request', action: 'answer',
      answers: [{ id: 'cursor-plan', selected: ['批准'] }]
    });
  });

  it('dispatch binding 报告提问等待态并提供卡插槽', () => {
    const binding = dispatchTranscriptBinding('ws-1');
    expect(binding.waitStateOf?.(assistant)).toBe('question');
    expect(typeof binding.getInlineCards).toBe('function');
  });

  it('pending 卡渲染题干与选项；提交走 chat.respondUserQuestion', async () => {
    const user = userEvent.setup();
    const { container } = render(<DispatchUserQuestionCard workspaceId="ws-1" card={pending} />);

    expect(container.querySelector('.ac-uq-head.chat-card-header .chat-card-header-icon svg')).toBeTruthy();
    expect(screen.getByText('Agent 提问')).toBeTruthy();
    expect(screen.getByText('待回答')).toBeTruthy();
    expect(screen.queryByText('Agent 需要你的回答')).toBeNull();
    expect(screen.queryByText('选项')).toBeNull();
    expect(screen.getByRole('button', { name: 'A' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('选方案')).toBeTruthy();
    expect(screen.getByText('用哪种架构？')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'A' }));
    expect(screen.getByRole('button', { name: 'A' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: '提交回答' }));

    const call = currentApiMock().mockOf('chat.respondUserQuestion').mock.calls[0];
    expect(call[0]).toEqual({
      workspaceId: 'ws-1',
      questionId: 'q-orch-1',
      action: 'answer',
      answers: [{ id: 'arch', selected: ['A'] }]
    });
  });

  it('未作答时禁止提交：多选全不选、单选取消选中都不能空提交', async () => {
    const user = userEvent.setup();
    const multi: ChatUserQuestionView = {
      ...pending,
      questions: [{ ...pending.questions[0]!, multiSelect: true }]
    };
    render(<DispatchUserQuestionCard workspaceId="ws-1" card={multi} />);
    const submitBtn = screen.getByRole('button', { name: '提交回答' }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'A' }));
    expect(submitBtn.disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'A' }));
    expect(submitBtn.disabled).toBe(true);

    await user.type(screen.getByPlaceholderText('自定义回答…'), '  ');
    expect(submitBtn.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText('自定义回答…'), '都不要');
    expect(submitBtn.disabled).toBe(false);
    expect(currentApiMock().mockOf('chat.respondUserQuestion').mock.calls).toHaveLength(0);
  });

  it('取消作答走 abort', async () => {
    const user = userEvent.setup();
    render(<DispatchUserQuestionCard workspaceId="ws-1" card={pending} />);
    await user.click(screen.getByRole('button', { name: '取消作答' }));
    const call = currentApiMock().mockOf('chat.respondUserQuestion').mock.calls[0];
    expect(call[0]).toEqual({
      workspaceId: 'ws-1',
      questionId: 'q-orch-1',
      action: 'abort'
    });
  });

  it('已回答只读回显，不调 IPC', () => {
    render(
      <UserQuestionCard
        sessionId="ws-1"
        card={{
          ...pending,
          status: 'answered',
          answers: [{ id: 'arch', selected: ['B'] }]
        }}
      />
    );
    expect(screen.getByText('Agent 提问')).toBeTruthy();
    expect(screen.getByText('已回答')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.queryByText('Q')).toBeNull();
    expect(screen.queryByText('A')).toBeNull();
    expect(currentApiMock().mockOf('chat.respondUserQuestion').mock.calls).toHaveLength(0);
    expect(currentApiMock().mockOf('agentSession.respondUserQuestion').mock.calls).toHaveLength(0);
  });

  it('分页后仍保留选项与自定义答案，提交内容不受新表头影响', async () => {
    const user = userEvent.setup();
    render(<DispatchUserQuestionCard workspaceId="ws-1" card={{ ...pending, questions: [
      pending.questions[0]!, { id: 'output', question: '输出方式？', options: [{ label: '简短' }] }
    ] }} />);
    expect(screen.getByText('第 1 题 / 共 2 题')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'A' }));
    await user.click(screen.getByRole('button', { name: '下一题' }));
    expect(screen.getByText('第 2 题 / 共 2 题')).toBeTruthy();
    await user.type(screen.getByPlaceholderText('自定义回答…'), '文字回答');
    await user.click(screen.getByRole('button', { name: '上一题' }));
    expect(screen.getByRole('button', { name: 'A' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: '下一题' }));
    expect((screen.getByPlaceholderText('自定义回答…') as HTMLInputElement).value).toBe('文字回答');
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(currentApiMock().mockOf('chat.respondUserQuestion')).toHaveBeenCalledWith({
      workspaceId: 'ws-1', questionId: pending.questionId, action: 'answer',
      answers: [{ id: 'arch', selected: ['A'] }, { id: 'output', selected: [], custom: '文字回答' }]
    });
  });

  it.each(['dispatch', 'gui'])('连续两张 %s 卡完全隔离答案与分页', async channel => {
    const user = userEvent.setup();
    const first: ChatUserQuestionView = { ...pending, questions: [
      { ...pending.questions[0]!, multiSelect: true },
      { id: 'second', question: '第二题？', options: [{ label: '旧选项' }] }
    ] };
    const cardView = (card: ChatUserQuestionView) => channel === 'dispatch'
      ? <DispatchUserQuestionCard workspaceId="ws-1" card={card} />
      : <UserQuestionCard sessionId="session-1" card={card} />;
    const { rerender } = render(cardView(first));
    await user.click(screen.getByRole('button', { name: 'A' }));
    await user.type(screen.getByPlaceholderText('自定义回答…'), '上一张的草稿');
    await user.click(screen.getByRole('button', { name: '下一题' }));
    await user.click(screen.getByRole('button', { name: '旧选项' }));
    // 题目内部 id 可重复；外层 questionId 才是一次请求的身份。
    const next: ChatUserQuestionView = { ...first, questionId: 'q-orch-2' };
    rerender(cardView(next));
    expect(screen.getByText('第 1 题 / 共 2 题')).toBeTruthy();
    expect((screen.getByPlaceholderText('自定义回答…') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'A' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'B更简单' }));
    await user.click(screen.getByRole('button', { name: '下一题' }));
    expect(screen.getByRole('button', { name: '旧选项' }).getAttribute('aria-pressed')).toBe('false');
    await user.type(screen.getByPlaceholderText('自定义回答…'), '本题答案');
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(currentApiMock().mockOf(channel === 'dispatch' ? 'chat.respondUserQuestion' : 'agentSession.respondUserQuestion')).toHaveBeenCalledWith(expect.objectContaining({
      questionId: 'q-orch-2', action: 'answer', answers: [
        { id: 'arch', selected: ['B'] }, { id: 'second', selected: [], custom: '本题答案' }
      ]
    }));
  });

  it('新消息取代后展示明确状态并禁用作答', () => {
    const { rerender } = render(<DispatchUserQuestionCard workspaceId="ws-1" card={pending} />);
    expect(screen.getByText('待回答')).toBeTruthy();
    rerender(<DispatchUserQuestionCard workspaceId="ws-1" card={{ ...pending, status: 'aborted', abortReason: 'superseded' }} />);
    expect(screen.getByText('已被新消息取代')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('已取消保留题目及未作答提示，隐藏可编辑控件', () => {
    const { container } = render(<UserQuestionCard sessionId="ws-1" card={{ ...pending, status: 'aborted' }} />);
    expect(screen.getByText('已取消')).toBeTruthy();
    expect(screen.getByText('用哪种架构？')).toBeTruthy();
    expect(screen.getByText('未作答')).toBeTruthy();
    expect(container.querySelector('.ac-uq-head.chat-card-header')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
