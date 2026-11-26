/**
 * 输入框打字不得带动会话流行重渲 / compact 交错重算。
 * ChatSurfaceView 把 Composer 与 Transcript 做成兄弟；按键只改 Composer 内部 ref，
 * 快照不变时 ChatMessageView 渲染次数必须冻结。
 * 运行: npx vitest run test/unit/chat-surface-composer-isolation.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { StoreProvider } from '../../src/renderer/src/store';
import type { ChatSurface, ChatSurfaceKind, ChatSurfaceSnapshot } from '../../src/shared/chatSurface';
import type { ChatMessage } from '../../src/shared/types';
import type { GuiChatMessage } from '../../src/shared/guiWorker';
import { currentApiMock } from './helpers/api-mock';

const { msgMock } = vi.hoisted(() => ({
  msgMock: vi.fn(({ message }: { message: { id: string } }) => (
    <div data-msg={message.id} />
  ))
}));

vi.mock('../../src/renderer/src/components/ChatMessageView', async () => {
  const React = await import('react');
  return { ChatMessageView: React.memo(msgMock) };
});

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

function typeInEditor(text: string): void {
  const editor = screen.getByRole('textbox');
  editor.textContent = text;
  fireEvent.input(editor);
}

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '问', createdAt: 100 },
  { id: 'a1', role: 'assistant', content: '答', createdAt: 200 }
];

const guiMessages: GuiChatMessage[] = [
  { id: 'u1', role: 'user', parts: [{ kind: 'text', text: '问' }], ts: 100 },
  { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '答' }], ts: 200 }
];

function makeSurface(
  kind: ChatSurfaceKind = 'dispatch',
  snapshotOverrides: Partial<ChatSurfaceSnapshot> = {},
  actionOverrides: Partial<ChatSurface['actions']> = {}
): ChatSurface {
  const snap = {
    messages: kind === 'gui-session' ? guiMessages : messages,
    busy: false,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: null as null,
    preset: null,
    compactions: [{ id: 'c1', status: 'complete' as const, createdAt: 150 }],
    ...snapshotOverrides
  };
  return {
    sessionId: 'iso-1',
    caps: {
      surfaceKind: kind,
      draftKey: 'iso-1',
      images: false,
      manualCompact: true
    },
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    actions: {
      send: async () => true,
      stop: () => undefined,
      clear: async () => undefined,
      compact: async () => ({ ok: true }),
      retry: () => undefined,
      cancelQueued: () => undefined,
      ...actionOverrides
    }
  };
}

describe('ChatSurface 打字不带动会话流', () => {
  beforeEach(() => {
    msgMock.mockClear();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('连打数键后 ChatMessageView 渲染次数不变', () => {
    render(
      <StoreProvider>
        <ChatSurfaceView surface={makeSurface()} workspaceId="ws-iso" />
      </StoreProvider>
    );
    expect(msgMock.mock.calls.length).toBeGreaterThan(0);
    const afterMount = msgMock.mock.calls.length;
    typeInEditor('a');
    typeInEditor('ab');
    typeInEditor('abc');
    typeInEditor('abcd');
    expect(msgMock.mock.calls.length).toBe(afterMount);
  });

  it.each([['claude', 'claude-gui'], ['codex', 'codex-gui'], ['cursor', 'cursor-gui'], ['pi', 'pi-gui']] as const)(
    'GUI surface %s 的技能菜单采用 %s', async (runtime, target) => {
      const mock = currentApiMock();
      mock.override('sessions.list', async () => ({ sessions: [{ id: 'iso-1', name: 'Runtime fixture', runtime, type: 'terminal', cwd: 'E:/isolated', createdAt: 0 }], activeId: 'iso-1' }));
      mock.override('runtimes.list', async () => [{ id: runtime, integrations: { skillTargets: [{ id: target, kind: 'gui' }] } }]);
      mock.override('agent.listSkills', async () => ({ skills: [{ name: 'journal', description: 'Journal' }] }));
      const surface = makeSurface('gui-session');
      render(<StoreProvider><ChatSurfaceView surface={surface} workspaceId="ws-iso" /></StoreProvider>);
      typeInEditor('/skill:journal');
      await waitFor(() => expect(mock.mockOf('agent.listSkills')).toHaveBeenLastCalledWith('ws-iso', target));
      expect(await screen.findByRole('option', { name: /\/skill:journal/ })).toBeTruthy();
    }
  );

  it('调度 surface 技能菜单采用 pi-dispatcher', async () => {
    const mock = currentApiMock();
    mock.override('agent.listSkills', async () => ({ skills: [{ name: 'journal', description: 'Journal' }] }));
    render(<StoreProvider><ChatSurfaceView surface={makeSurface()} workspaceId="ws-iso" /></StoreProvider>);
    typeInEditor('/skill:journal');
    await screen.findByRole('option', { name: /\/skill:journal/ });
    expect(mock.mockOf('agent.listSkills')).toHaveBeenLastCalledWith('ws-iso', 'pi-dispatcher');
  });

  it('GUI 兜底中断发送保留队列，并以 holdQueue 停止当前回合', async () => {
    const mock = currentApiMock();
    mock.override('sessions.list', async () => ({
      sessions: [{ id: 'iso-1', name: 'Muster Core', runtime: 'pi', type: 'terminal', cwd: 'E:/isolated', createdAt: 0 }],
      activeId: 'iso-1'
    }));
    mock.override('agentSession.abort', async () => undefined);
    mock.override('agentSession.send', async () => ({ ok: true }));
    const surface = makeSurface(
      'gui-session',
      { busy: true, queuedItems: [{ id: 'q1', text: '立即改做' }] },
      { sendNow: async () => 'unsupported' as const,
        sendNowFallback: async (text: string, method: 'mail' | 'interrupt') => {
          if (method === 'interrupt') {
            await window.api.agentSession.abort('iso-1', { holdQueue: true });
            await window.api.agentSession.send('iso-1', text, undefined, { steerOnBusy: false });
          }
          return true;
        } }
    );

    render(<StoreProvider><ChatSurfaceView surface={surface} workspaceId="ws-iso" /></StoreProvider>);
    fireEvent.click(screen.getByRole('button', { name: '立即发送' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '中断后发送' }));

    await waitFor(() => expect(mock.mockOf('agentSession.abort')).toHaveBeenCalledWith('iso-1', { holdQueue: true }));
    expect(mock.mockOf('agentSession.send')).toHaveBeenCalledWith(
      'iso-1', '立即改做', undefined, { steerOnBusy: false }
    );
  });
});
