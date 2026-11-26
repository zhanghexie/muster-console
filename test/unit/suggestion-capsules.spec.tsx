/**
 * R-20 建议胶囊（docs/features/suggestion-capsules.md）：
 * - 模型路建议回复：点击或 Shift+Tab 切换灰字预览，Tab 接受为草稿，不自动发送；数量上限 3。
 * 运行: npx vitest run test/unit/suggestion-capsules.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, beforeEach } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { clearDraft } from '../../src/renderer/src/composerDrafts';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage } from '../../src/shared/guiWorker';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function sess(partial: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'name'>): SessionMeta {
  return {
    type: 'terminal',
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    phase: { value: 'needs_you', source: 'model', ts: 1 },
    ...partial
  };
}

function seed(sessions: SessionMeta[]): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () =>
    Promise.resolve({ sessions, activeId: sessions[0]?.id ?? null })
  );
}

beforeEach(() => {
  clearDraft('agent-session:sg-1');
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof document.execCommand !== 'function') {
    document.execCommand = () => false;
  }
});

/* ── 模型路：经 ChatSurfaceView（gui-session 表面）走真实链路 ── */

function makeGuiSurface(
  messages: GuiChatMessage[],
  sendSpy: ChatSurface['actions']['send']
): ChatSurface {
  const snap = {
    messages,
    busy: false,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: null as null,
    preset: null
  };
  return {
    sessionId: 'sg-1',
    caps: { surfaceKind: 'gui-session' as const, draftKey: 'agent-session:sg-1' },
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    actions: {
      send: sendSpy,
      stop: () => undefined,
      clear: async () => undefined,
      retry: () => undefined,
      cancelQueued: () => undefined
    }
  };
}

describe('模型路 suggestedReplies（ChatSurfaceView 集成）', () => {
  it('GUI 输入区清除当前建议，不触发发送或验收动作', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const mock = currentApiMock();
    mock.override('suggestions.clear', async () => ({ ok: true, cleared: true }));
    const send = vi.fn(async () => true);
    const messages: GuiChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }],
      suggestedReplies: ['确认', '稍后'], ts: 2 }];
    const view = render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface(messages, send)} workspaceId="ws-a" /></StoreProvider>);
    const clear = await screen.findByRole('button', { name: '清除本轮建议' });
    const fold = clear.closest('.acc')!;
    expect(fold.classList.contains('is-open')).toBe(true);
    fireEvent.click(clear);
    await waitFor(() => expect(fold.classList.contains('is-open')).toBe(false));
    expect(fold.getAttribute('aria-hidden')).toBe('true'); // 保留退场内容直到折叠完成
    await waitFor(() => expect(mock.mockOf('suggestions.clear')).toHaveBeenCalledWith({
      kind: 'gui', targetId: 'sg-1', messageId: 'a1', replies: ['确认', '稍后']
    }));
    expect(view.container.querySelector('.composer-ghost-suggestion')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(mock.mockOf('sessions.review')).not.toHaveBeenCalled();
  });

  it('点击胶囊切换灰字预览，Tab 才填入且不自动发送', async () => {
    const user = userEvent.setup();
    seed([
      sess({ id: 'sg-1', name: 'GUI 会话', workspaceId: 'ws-a' })
    ]);
    const sendSpy = vi.fn(async (_text: string) => true);
    const messages: GuiChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ kind: 'text', text: '改动已完成，等验收。' }],
        suggestedReplies: ['通过并合入', '先跑一遍测试'],
        ts: 2
      }
    ];
    render(
      <StoreProvider>
        <ChatSurfaceView surface={makeGuiSurface(messages, sendSpy)} workspaceId="ws-a" />
      </StoreProvider>
    );

    // needs_you 时不再显示会话操作栏，普通回复建议仍可使用。
    expect(screen.queryByRole('toolbar', { name: '建议动作' })).toBeNull();
    expect(screen.queryByRole('button', { name: '标记已处理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '验收通过' })).toBeNull();
    expect(screen.queryByRole('button', { name: '打回' })).toBeNull();

    const row = await waitFor(() => {
      const el = document.querySelector('.composer-reply-suggestions');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const buttons = row.querySelectorAll('button.suggestion-capsule');
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.textContent).toBe('通过并合入');

    await user.click(screen.getByRole('button', { name: '先跑一遍测试' }));
    expect(document.querySelector('.composer-ghost-suggestion')?.textContent).toBe('先跑一遍测试');
    expect(screen.getByRole('textbox').textContent).toBe('');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
    const editor = await waitFor(() => {
      const el = screen.getByRole('textbox');
      expect(el.textContent).toBe('先跑一遍测试');
      return el;
    });
    expect(editor).toBeTruthy();
    // 填入 ≠ 发送：send 不被自动调用（终审编辑权保留）
    expect(sendSpy).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('sessions.review')).not.toHaveBeenCalled();
  });

  it('数量上限 3：五条建议只渲染三条（映射层规整去重截断）', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const messages: GuiChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ kind: 'text', text: '完成。' }],
        suggestedReplies: ['一', '二', '三', '四', '五', '二'],
        ts: 2
      }
    ];
    render(
      <StoreProvider>
        <ChatSurfaceView surface={makeGuiSurface(messages, vi.fn(async () => true))} workspaceId="ws-a" />
      </StoreProvider>
    );
    const row = await waitFor(() => {
      const el = document.querySelector('.composer-reply-suggestions');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const labels = [...row.querySelectorAll('button.suggestion-capsule')].map(
      (b) => b.textContent
    );
    expect(labels).toEqual(['一', '二', '三']);
  });

  it('Tab 接受建议后，Enter 才发送', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const sendSpy = vi.fn(async (_text: string) => true);
    const messages: GuiChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ kind: 'text', text: '完成。' }],
        suggestedReplies: ['收到'],
        ts: 2
      }
    ];
    render(
      <StoreProvider>
        <ChatSurfaceView surface={makeGuiSurface(messages, sendSpy)} workspaceId="ws-a" />
      </StoreProvider>
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: '收到' }));
    const editor = await waitFor(() => screen.getByRole('textbox'));
    expect(editor.textContent).toBe('');
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe('收到');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => {
      expect(sendSpy).toHaveBeenCalledWith('收到', undefined);
    });
  });

  it('长建议保留完整提示，填入后可编辑且不会自动发送', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const reply = '请先检查现有测试结果，再整理需要我确认的具体问题和建议的下一步。';
    const sendSpy = vi.fn(async (_text: string) => true);
    const messages: GuiChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }], suggestedReplies: [reply], ts: 2 }];
    render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface(messages, sendSpy)} workspaceId="ws-a" /></StoreProvider>);
    const button = await screen.findByRole('button', { name: reply });
    expect(button.querySelector('.composer-reply-label')?.textContent).toBe('请先检查现有测试结果…');
    expect(button.title).toContain(reply);
    await userEvent.setup().click(button);
    const editor = screen.getByRole('textbox');
    expect(editor.textContent).toBe('');
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe(reply);
    await userEvent.setup().type(editor, '谢谢');
    expect(editor.textContent).toContain('谢谢');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('短建议完整显示，组合字符按可见字符截断且保留完整无障碍名称', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const reply = '👨‍👩‍👧‍👦'.repeat(11);
    const messages: GuiChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }], suggestedReplies: ['好的', reply], ts: 2 }];
    render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface(messages, vi.fn(async () => true))} workspaceId="ws-a" /></StoreProvider>);
    expect((await screen.findByRole('button', { name: '好的' })).textContent).toBe('好的');
    expect(screen.getByRole('button', { name: reply }).textContent).toBe('👨‍👩‍👧‍👦'.repeat(10) + '…');
  });

  it('已有草稿包括空格时不显示建议，Tab 不覆盖草稿', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const messages: GuiChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }], suggestedReplies: ['收到'], ts: 2 }];
    render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface(messages, vi.fn(async () => true))} workspaceId="ws-a" /></StoreProvider>);
    const editor = await screen.findByRole('textbox');
    await userEvent.setup().click(editor);
    await userEvent.setup().type(editor, ' ');
    await waitFor(() => expect(document.querySelector('.composer-ghost-suggestion')).toBeNull());
    expect(fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true })).toBe(true);
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe(' ');
  });

  it('Shift+Tab 在多条建议间循环，Tab 接受当前建议', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const user = userEvent.setup();
    const sendSpy = vi.fn(async (_text: string) => true);
    const messages: GuiChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }], suggestedReplies: ['第一条建议内容很长', '第二条建议内容很长', '第三条建议'], ts: 2 }];
    render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface(messages, sendSpy)} workspaceId="ws-a" /></StoreProvider>);
    const editor = await screen.findByRole('textbox');
    const first = await screen.findByRole('button', { name: '第一条建议内容很长' });
    const second = screen.getByRole('button', { name: '第二条建议内容很长' });
    expect(first.title).toContain('第一条建议内容很长');
    await user.click(editor);
    expect(document.querySelector('.composer-ghost-suggestion')?.textContent).toBe('第一条建议内容很长');
    expect(fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(second.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.composer-ghost-suggestion')?.textContent).toBe('第二条建议内容很长');
    expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true, repeat: true });
    expect(second.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });
    expect(document.querySelector('.composer-ghost-suggestion')?.textContent).toBe('第三条建议');
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });
    expect(document.querySelector('.composer-ghost-suggestion')?.textContent).toBe('第一条建议内容很长');
    expect(sendSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe('第一条建议内容很长');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('只有一条建议时 Shift+Tab 保留焦点导航，输入法合成期不处理 Tab', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const sendSpy = vi.fn(async (_text: string) => true);
    const messages: GuiChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }], suggestedReplies: ['收到'], ts: 2 }];
    render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface(messages, sendSpy)} workspaceId="ws-a" /></StoreProvider>);
    const editor = await screen.findByRole('textbox');
    await screen.findByRole('button', { name: '收到' });
    expect(fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true })).toBe(true);
    fireEvent.keyDown(editor, { key: 'Tab', isComposing: true });
    expect(editor.textContent).toBe('');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('有建议时删光未选字的拼音，恢复空草稿和建议预览', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const messages: GuiChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }], suggestedReplies: ['收到'], ts: 2 }];
    render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface(messages, vi.fn(async () => true))} workspaceId="ws-a" /></StoreProvider>);
    const editor = await screen.findByRole('textbox');
    await screen.findByRole('button', { name: '收到' });
    await userEvent.setup().click(editor);
    fireEvent.compositionStart(editor);
    editor.textContent = 'ni';
    fireEvent.input(editor, { inputType: 'insertCompositionText', isComposing: true, data: 'ni' });
    expect(document.querySelector('.composer-ghost-suggestion')).toBeNull();

    // 模拟 Chromium 删完合成文本后留下的光标占位。
    editor.replaceChildren(document.createTextNode(''), document.createElement('br'));
    fireEvent.input(editor, { inputType: 'insertCompositionText', isComposing: true, data: '' });
    fireEvent.compositionEnd(editor, { data: '' });
    expect(editor.childNodes).toHaveLength(0);
    expect(editor.getAttribute('data-empty')).toBe('true');
    expect(document.querySelector('.composer-ghost-suggestion')?.textContent).toBe('收到');
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe('收到');
  });

  it('输入法合成期不通过 Shift+Tab 切换多条建议', async () => {
    seed([sess({ id: 'sg-1', name: 'GUI 会话' })]);
    const messages: GuiChatMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '完成。' }], suggestedReplies: ['第一条', '第二条'], ts: 2 }];
    render(<StoreProvider><ChatSurfaceView surface={makeGuiSurface(messages, vi.fn(async () => true))} workspaceId="ws-a" /></StoreProvider>);
    const editor = await screen.findByRole('textbox');
    await screen.findByRole('button', { name: '第一条' });
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true, isComposing: true });
    expect(document.querySelector('.composer-ghost-suggestion')?.textContent).toBe('第一条');
    expect(editor.textContent).toBe('');
  });
});
