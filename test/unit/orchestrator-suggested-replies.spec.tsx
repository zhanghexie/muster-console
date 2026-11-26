/**
 * R-20 调度会话建议输入（docs/features/suggestion-capsules.md 调度节）：
 * - askQuestion 待答选项仅显示在提问卡，不进入建议输入；
 * - 发送即作答：挂起单题卡的普通发送改走 chat.respondUserQuestion（选项命中
 *   →selected / 自由文本、批注、多题卡回落普通发送）。
 * 运行: npx vitest run test/unit/orchestrator-suggested-replies.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, beforeEach } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { clearDraft } from '../../src/renderer/src/composerDrafts';
import {
  getOrchestratorSurface,
  resetOrchestratorListenersForTest
} from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { expandNoteToken } from '../../src/shared/noteAnnotations';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta, ChatMessage } from '../../src/shared/types';
import type { ChatSurface } from '../../src/shared/chatSurface';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function seed(): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  // 会话列表为空，独立验证调度表面。
  mock.override(
    'sessions.list',
    () => Promise.resolve({ sessions: [] as SessionMeta[], activeId: null })
  );
}

beforeEach(() => {
  clearDraft('ws-d');
  localStorage.removeItem('muster.tosend.v1:ws-d');
  resetOrchestratorListenersForTest();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof document.execCommand !== 'function') {
    document.execCommand = () => false;
  }
});

/* ── 渲染链路：经 ChatSurfaceView（dispatch 表面）走真实接线 ── */

function makeDispatchSurface(
  messages: ChatMessage[],
  busy = false,
  sendSpy: (text: string) => Promise<boolean> = async () => true
): ChatSurface {
  const snap = {
    messages,
    busy,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: null as null,
    preset: null
  };
  return {
    sessionId: 'ws-d',
    caps: { surfaceKind: 'dispatch' as const, draftKey: 'ws-d' },
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

function pendingAskMessage(extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    parts: [{ kind: 'text', text: '请选择方案。' }],
    createdAt: 2,
    userQuestion: {
      questionId: 'q-1',
      questions: [
        {
          id: 'arch',
          question: '用哪种架构？',
          options: [{ label: '方案A' }, { label: '方案B' }, { label: '方案C' }]
        }
      ],
      status: 'pending',
      anchorPartIndex: 1
    },
    ...extra
  };
}

function userTurn(): ChatMessage {
  return { id: 'u1', role: 'user', content: '开始吧', createdAt: 1 };
}

function suggestionLabels(): string[] {
  const row = document.querySelector('.composer-reply-suggestions');
  return row
    ? [...row.querySelectorAll('button.suggestion-capsule')].map((b) => b.textContent)
    : [];
}

describe('调度表面：提问卡不进入建议输入', () => {
  it.each([true, false])('待答卡及旧版遗留建议在 busy=%s 时不显示建议行或灰字', async busy => {
    seed();
    const message = pendingAskMessage({ suggestedReplies: ['方案A', '方案B', '方案C'] });
    render(<StoreProvider><ChatSurfaceView surface={makeDispatchSurface([userTurn(), message], busy)} workspaceId="ws-a" /></StoreProvider>);
    expect(await screen.findByText('用哪种架构？')).toBeTruthy();
    expect(suggestionLabels()).toEqual([]);
    expect(document.querySelector('.composer-ghost-suggestion')).toBeNull();
    expect(screen.getByRole('button', { name: '方案A' })).toBeTruthy();
  });

  it('待答单题即使手动队列非空，输入答案仍走作答发送通道', async () => {
    seed();
    localStorage.setItem('muster.tosend.v1:ws-d', JSON.stringify([{ id: 'queued', text: '之前待确认', ts: 1 }]));
    localStorage.removeItem('muster.queuePanel.minimized');
    const send = vi.fn(async () => true);
    const view = render(<StoreProvider><ChatSurfaceView surface={makeDispatchSurface([userTurn(), pendingAskMessage()], true, send)} workspaceId="ws-a" /></StoreProvider>);
    await screen.findByText('之前待确认');
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    expect(editor.getAttribute('data-placeholder')).toContain('发送新消息');
    await userEvent.setup().click(editor);
    await userEvent.setup().type(editor, '我的答案');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('我的答案', undefined));
    expect(localStorage.getItem('muster.tosend.v1:ws-d')).toContain('之前待确认');
  });

  it('普通模型建议仍可预览并填入草稿，且不自动发送', async () => {
    seed();
    const send = vi.fn(async () => true);
    const message: ChatMessage = { id: 'a2', role: 'assistant', content: '完成。', createdAt: 2, suggestedReplies: ['继续检查', '整理结果'] };
    render(<StoreProvider><ChatSurfaceView surface={makeDispatchSurface([userTurn(), message], false, send)} workspaceId="ws-a" /></StoreProvider>);
    await userEvent.setup().click(await screen.findByRole('button', { name: '整理结果' }));
    const editor = document.querySelector<HTMLElement>('.composer-editable')!;
    expect(editor.textContent).toBe('');
    expect(document.querySelector('.composer-ghost-suggestion')?.textContent).toBe('整理结果');
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe('整理结果');
    expect(send).not.toHaveBeenCalled();
  });
});

/* ── 发送即作答：真实调度表面（orchestratorSurface store + send 动作） ── */

describe('调度表面：发送即作答（挂起单题卡 → chat.respondUserQuestion）', () => {
  const WS_ASK = 'ws-ask';
  const WS_MULTI = 'ws-multi';

  function seedAskSurface(wsId: string, message: ChatMessage): ChatSurface {
    const mock = currentApiMock();
    mock.override('chat.respondUserQuestion', () => Promise.resolve({ ok: true }));
    mock.override('chat.send', () => Promise.resolve({ accepted: true }));
    const surface = getOrchestratorSurface(wsId);
    // 主进程推送历史（挂卡后主进程 emit 的 agent:history 同款载荷）
    mock.emit('agent:history', { workspaceId: wsId, messages: [userTurn(), message] });
    return surface;
  }

  it('选项命中 → selected 作答；chat.send 不被调用', async () => {
    seed();
    const surface = seedAskSurface(WS_ASK, pendingAskMessage());
    const ok = await surface.actions.send?.('方案A');
    expect(ok).toBe(true);
    expect(currentApiMock().mockOf('chat.respondUserQuestion')).toHaveBeenCalledWith({
      workspaceId: WS_ASK,
      questionId: 'q-1',
      action: 'answer',
      answers: [{ id: 'arch', selected: ['方案A'] }]
    });
    expect(currentApiMock().mockOf('chat.send')).not.toHaveBeenCalled();
  });

  it.each(['方案A，但先补测试', '方案A\n顺便检查', '> 方案A'])('自由文本 %s 通过真实输入框走普通发送', async (text) => {
    seed();
    const surface = seedAskSurface(WS_ASK, pendingAskMessage());
    render(<StoreProvider><ChatSurfaceView surface={surface} /></StoreProvider>);
    const editor = document.querySelector<HTMLElement>('.composer-editable')!;
    fireEvent.input(editor, { target: { textContent: text } });
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(currentApiMock().mockOf('chat.send')).toHaveBeenCalledWith(text, WS_ASK, undefined));
    expect(currentApiMock().mockOf('chat.respondUserQuestion')).not.toHaveBeenCalled();
  });

  it('批注即使完整命中选项也不得作答', async () => {
    seed();
    const text = expandNoteToken({ seq: 1, quote: '方案A', note: '为什么用我的？' });
    const message = pendingAskMessage();
    message.userQuestion!.questions[0]!.options = [{ label: text }];
    const surface = seedAskSurface(WS_ASK, message);
    render(<StoreProvider><ChatSurfaceView surface={surface} /></StoreProvider>);
    const editor = document.querySelector<HTMLElement>('.composer-editable')!;
    fireEvent.input(editor, { target: { textContent: text } });
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(currentApiMock().mockOf('chat.send')).toHaveBeenCalled());
    expect(currentApiMock().mockOf('chat.respondUserQuestion')).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('chat.send')).toHaveBeenCalledWith(text, WS_ASK, undefined);
  });

  it('带图片的选项文本仍走普通发送', async () => {
    seed();
    const surface = seedAskSurface(WS_ASK, pendingAskMessage());
    const images = [{ id: 'img-1', data: 'YQ==', mimeType: 'image/png' }];
    await surface.actions.send('方案A', images);
    expect(currentApiMock().mockOf('chat.respondUserQuestion')).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('chat.send')).toHaveBeenCalledWith('方案A', WS_ASK, images);
  });

  it('多题卡不抢发送通道：回落普通 chat.send', async () => {
    seed();
    const multi = pendingAskMessage({
      userQuestion: {
        questionId: 'q-3',
        questions: [
          { id: 'q1', question: '一？', options: [{ label: 'x' }] },
          { id: 'q2', question: '二？', options: [{ label: 'y' }] }
        ],
        status: 'pending'
      }
    });
    const surface = seedAskSurface(WS_MULTI, multi);
    await surface.actions.send?.('x');
    expect(currentApiMock().mockOf('chat.respondUserQuestion')).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('chat.send')).toHaveBeenCalledWith(
      'x',
      WS_MULTI,
      undefined
    );
  });
});
