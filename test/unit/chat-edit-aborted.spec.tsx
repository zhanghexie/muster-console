import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * 会话终止后重新编辑终止消息（用户消息悬停操作条「重新编辑」按钮）：
 * - 仅当会话空闲且末轮 assistant 为 aborted 时，在该轮用户消息悬停栏渲染「重新编辑」按钮；
 * - 早先已完成/已终止的历史轮次不显示「重新编辑」按钮（仅保留复制/分叉）；
 * - 点击「重新编辑」调用 surface.actions.recallAborted，从会话流移除该轮用户消息与
 *   已终止助手回复，并将原消息文本与随文图片填回底部 Composer 输入框。
 * 运行: npx vitest run test/unit/chat-edit-aborted.spec.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { StoreProvider } from '../../src/renderer/src/store';
import type { ChatSurface, ChatSurfaceSnapshot } from '../../src/shared/chatSurface';
import type { GuiChatMessage } from '../../src/shared/guiWorker';
import type { TurnChanges } from '../../src/shared/turnChanges';
import { currentApiMock } from './helpers/api-mock';
import { useInterruptedTurnGuard } from '../../src/renderer/src/chatSurface/useInterruptedTurnGuard';
import { AgentChatView } from '../../src/renderer/src/agentChat/AgentChatView';

const keptSession = vi.hoisted(() => ({ surface: null as ChatSurface | null }));
vi.mock('../../src/renderer/src/chatSurface/agentSessionSurface', () => ({ useAgentSessionSurface: () => keptSession.surface }));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

let surfaceSequence = 0;
function makeStatefulGuiSurface(initialMessages: GuiChatMessage[], initialBusy = false, surfaceKind: 'gui-session' | 'dispatch' = 'gui-session'): {
  surface: ChatSurface;
  recallSpy: ReturnType<typeof vi.fn>;
  setState: (messages: GuiChatMessage[], busy?: boolean) => void;
} {
  let messages = initialMessages;
  let busy = initialBusy;
  const listeners = new Set<() => void>();
  const surfaceMessages = (): ChatSurfaceSnapshot['messages'] => surfaceKind === 'dispatch'
    ? messages.map(message => ({ id: message.id, role: message.role, createdAt: message.ts,
      content: message.parts.filter(part => part.kind === 'text').map(part => part.kind === 'text' ? part.text : '').join(''),
      aborted: message.aborted, turnChanges: message.turnChanges }))
    : messages;
  let snap: ChatSurfaceSnapshot = {
    messages: surfaceMessages(),
    busy,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: 'auto',
    preset: null
  };
  const notify = (): void => {
    snap = {
      ...snap,
      messages: surfaceMessages(),
      busy
    };
    for (const l of listeners) l();
  };
  const recallSpy = vi.fn(async (messageId?: string) => {
    const uIdx = messages.findIndex((m) => m.id === messageId && m.role === 'user');
    if (uIdx < 0) return { ok: false, error: '没有可重新编辑的终止消息' };
    const u = messages[uIdx]!;
    const text = u.parts
      .filter((p) => p.kind === 'text')
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join('');
    const images = u.images;
    messages = messages.slice(0, uIdx);
    notify();
    return { ok: true, text, ...(images?.length ? { images } : {}) };
  });

  const surface: ChatSurface = {
    sessionId: `sess-aborted-${++surfaceSequence}`,
    caps: {
      surfaceKind,
      draftKey: `agent-session:sess-aborted-${surfaceSequence}`,
      images: true,
      fork: true
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snap,
    actions: {
      send: async () => true,
      stop: () => undefined,
      clear: async () => undefined,
      retry: () => undefined,
      recallAborted: recallSpy,
      cancelQueued: () => undefined,
      fork: () => undefined
    }
  };

  return {
    surface,
    recallSpy,
    setState: (nextMessages, nextBusy = busy) => {
      messages = nextMessages;
      busy = nextBusy;
      notify();
    }
  };
}

describe('终止消息重新编辑（用户消息悬停操作条）', () => {
  const stopped = (): GuiChatMessage[] => [
    { id: 'u', role: 'user', parts: [{ kind: 'text', text: '修改原输入' }], ts: 1 },
    { id: 'a', role: 'assistant', parts: [], aborted: true, ts: 2, turnChanges: { id: 'snapshot', state: 'ready', warnings: [], files: [{ path: 'a.ts', kind: 'modified', added: 1, removed: 1, revertible: true }] } }
  ];
  const baseReview = stopped()[1].turnChanges!;
  const auxiliaryReviews: Array<{ name: string; summary: TurnChanges }> = [
    { name: 'preparing', summary: { ...baseReview, state: 'collecting', preparing: true, files: [] } },
    { name: 'collecting', summary: { ...baseReview, state: 'collecting', files: [] } },
    { name: 'finalizing', summary: { ...baseReview, state: 'collecting', finalizing: true, files: [] } },
    { name: 'unavailable', summary: { ...baseReview, state: 'error', warnings: ['模拟采集失败'], files: [] } },
    { name: 'unattributed', summary: { ...baseReview, files: baseReview.files.map(file => ({ ...file, revertible: false })) } },
    { name: 'already reverted', summary: { ...baseReview, files: baseReview.files.map(file => ({ ...file, revertible: false, reverted: true })) } }
  ];
  describe.each(['gui-session', 'dispatch'] as const)('%s auxiliary review', surfaceKind => {
    it.each([
      { name: 'preparing', summary: { ...baseReview, state: 'collecting' as const, preparing: true, files: [], warnings: ['模拟 Git ENOBUFS'] } },
      { name: 'collecting', summary: { ...baseReview, state: 'collecting' as const, files: [], warnings: ['模拟 Git ENOBUFS'] } },
      { name: 'finalizing', summary: { ...baseReview, state: 'collecting' as const, finalizing: true, files: [] } },
      { name: 'error', summary: { ...baseReview, state: 'error' as const, files: [], warnings: ['模拟 Git ENOBUFS'] } },
      { name: 'empty ready', summary: { ...baseReview, files: [], warnings: ['模拟 Git ENOBUFS'] } }
    ])('keeps the actual transcript quiet for $name without a file collision', ({ summary }) => {
      const messages = stopped();
      messages[1] = { ...messages[1], aborted: undefined, parts: [{ kind: 'text', text: '普通回复继续显示' }], turnChanges: summary };
      const { surface } = makeStatefulGuiSurface(messages, summary.state === 'collecting', surfaceKind);
      const { container } = render(<StoreProvider><ChatSurfaceView surface={surface}/></StoreProvider>);
      expect(screen.getByText('普通回复继续显示')).toBeTruthy();
      expect(container.querySelector('.turn-changes-note')).toBeNull();
      expect(container.querySelector('.turn-changes-card')).toBeNull();
      expect(container.textContent).not.toContain('模拟 Git ENOBUFS');
    });
    it('keeps a recorded file collision out of the streaming transcript', () => {
      const messages = stopped();
      messages[1] = { ...messages[1], aborted: undefined, parts: [{ kind: 'text', text: '正在处理任务' }],
        turnChanges: { ...baseReview, state: 'collecting', preparing: true, files: [],
          concurrentEdits: [{ path: 'a.ts', otherOwner: 'gui:peer', otherLabel: '同时编辑的会话' }] } };
      const { surface } = makeStatefulGuiSurface(messages, true, surfaceKind);
      render(<StoreProvider><ChatSurfaceView surface={surface}/></StoreProvider>);
      expect(screen.getByText('正在处理任务')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(/同时编辑的会话/)).toBeNull();
      expect(currentApiMock().mockOf('turnChanges.revert')).not.toHaveBeenCalled();
    });
    it.each(auxiliaryReviews)('allows send and re-edit while $name without a review decision', async ({ summary }) => {
      const messages = stopped(); messages[1].turnChanges = summary;
      const { surface, recallSpy } = makeStatefulGuiSurface(messages, false, surfaceKind);
      const send = vi.fn(async () => true); surface.actions.send = send;
      render(<StoreProvider><ChatSurfaceView surface={surface}/></StoreProvider>);
      const editor = screen.getByRole('textbox');
      editor.textContent = '继续任务'; fireEvent.input(editor); fireEvent.keyDown(editor, { key: 'Enter' });
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));
      await waitFor(() => expect(recallSpy).toHaveBeenCalledWith('u'));
      await waitFor(() => expect(screen.getByRole('textbox').textContent).toBe('修改原输入'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(currentApiMock().mockOf('turnChanges.revert')).not.toHaveBeenCalled();
    });
  });
  it('asks before discarding a stopped turn; cancelling keeps history and files', async () => {
    const { surface, recallSpy } = makeStatefulGuiSurface(stopped());
    render(<StoreProvider><ChatSurfaceView surface={surface}/></StoreProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));
    const dialog = await screen.findByRole('dialog'); expect(recallSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(recallSpy).not.toHaveBeenCalled(); expect(currentApiMock().mockOf('turnChanges.revert')).not.toHaveBeenCalled();
    expect(surface.getSnapshot().messages).toHaveLength(2);
  });
  it('hiding the actual kept-alive GUI shell cancels its old confirmation without recalling or reverting', async () => {
    const { surface, recallSpy } = makeStatefulGuiSurface(stopped());
    keptSession.surface = surface;
    const { rerender } = render(<StoreProvider><AgentChatView sessionId={surface.sessionId} visible runtimeLabel="GUI" /></StoreProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));
    await screen.findByRole('dialog');
    rerender(<StoreProvider><AgentChatView sessionId={surface.sessionId} visible={false} runtimeLabel="GUI" /></StoreProvider>);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    rerender(<StoreProvider><AgentChatView sessionId={surface.sessionId} visible runtimeLabel="GUI" /></StoreProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(recallSpy).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('turnChanges.revert')).not.toHaveBeenCalled();
    expect(surface.getSnapshot().messages).toHaveLength(2);
  });
  it('explicit keep recalls the input without undoing files', async () => {
    const { surface, recallSpy } = makeStatefulGuiSurface(stopped());
    render(<StoreProvider><ChatSurfaceView surface={surface}/></StoreProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));
    fireEvent.click(await screen.findByRole('button', { name: '保留改动并继续' }));
    await waitFor(() => expect(recallSpy).toHaveBeenCalledWith('u'));
    expect(currentApiMock().mockOf('turnChanges.revert')).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toBe('修改原输入'));
  });
  it('undo completes before recall removes the snapshot; conflicts require another explicit choice', async () => {
    const { surface, recallSpy } = makeStatefulGuiSurface(stopped());
    const api = currentApiMock(); let resolve!: (value: unknown) => void;
    api.mockOf('turnChanges.revert').mockReturnValue(new Promise(r => { resolve = r; }));
    render(<StoreProvider><ChatSurfaceView surface={surface}/></StoreProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));
    fireEvent.click(await screen.findByRole('button', { name: '回退后继续' }));
    expect(recallSpy).not.toHaveBeenCalled();
    expect(api.mockOf('turnChanges.revert')).toHaveBeenCalledWith({ kind: 'gui', id: surface.sessionId, messageId: 'a' });
    await act(async () => resolve({ ok: false, restored: [], conflicts: [{ path: 'a.ts', reason: '人工修改已保留' }] }));
    expect(recallSpy).not.toHaveBeenCalled(); expect(await screen.findByText(/人工修改已保留/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保留改动并继续' }));
    await waitFor(() => expect(recallSpy).toHaveBeenCalledTimes(1));
  });
  it('successful undo recalls once, and cancelling a new send preserves its draft', async () => {
    const { surface, recallSpy } = makeStatefulGuiSurface(stopped());
    const send = vi.fn(async () => true); surface.actions.send = send;
    currentApiMock().mockOf('turnChanges.revert').mockResolvedValue({ ok: true, restored: ['a.ts'], conflicts: [] });
    render(<StoreProvider><ChatSurfaceView surface={surface}/></StoreProvider>);
    const editor = screen.getByRole('textbox'); editor.textContent = '新的输入'; fireEvent.input(editor); fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(editor.textContent).toBe('新的输入'); expect(send).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));
    fireEvent.click(await screen.findByRole('button', { name: '回退后继续' }));
    await waitFor(() => expect(recallSpy).toHaveBeenCalledTimes(1));
    expect(currentApiMock().mockOf('turnChanges.revert')).toHaveBeenCalledTimes(1);
  });
  it('offers safe undo when the stop snapshot becomes ready before re-edit', async () => {
    const messages = stopped(); messages[1].turnChanges = { ...messages[1].turnChanges!, state: 'collecting', files: [] };
    const { surface, setState } = makeStatefulGuiSurface(messages);
    render(<StoreProvider><ChatSurfaceView surface={surface}/></StoreProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => setState(stopped()));
    fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));
    expect((await screen.findByRole('button', { name: '回退后继续' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('dispatch uses its own workspace identity and switching surfaces cancels an old decision', async () => {
    const original = makeStatefulGuiSurface(stopped()).surface;
    const surface: ChatSurface = { ...original, sessionId: 'dispatch-workspace', caps: { ...original.caps, surfaceKind: 'dispatch' } };
    const proceed = vi.fn();
    function Guard({ value }: { value: ChatSurface }) {
      const guard = useInterruptedTurnGuard(value, true);
      return <>{guard.dialog}<button onClick={() => void guard.confirm().then(allow => { if (allow) proceed(value.sessionId); })}>send</button></>;
    }
    const { rerender } = render(<Guard value={surface}/>);
    const api = currentApiMock(); api.mockOf('turnChanges.revert').mockResolvedValue({ ok: true, restored: ['a.ts'], conflicts: [] });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    fireEvent.click(await screen.findByRole('button', { name: '回退后继续' }));
    await waitFor(() => expect(proceed).toHaveBeenCalledWith('dispatch-workspace'));
    expect(api.mockOf('turnChanges.revert')).toHaveBeenCalledWith({ kind: 'dispatch', id: 'dispatch-workspace', messageId: 'a' });
    proceed.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await screen.findByRole('button', { name: '保留改动并继续' });
    rerender(<Guard value={original}/>);
    await act(async () => {});
    expect(proceed).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    localStorage.clear();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  it('仅末轮终止对应的用户消息显示「重新编辑」，点击后移除该轮并把文本与图片填回输入框', async () => {
    const initial: GuiChatMessage[] = [
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: '第一轮问题' }], ts: 100 },
      { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '第一轮正常回答' }], ts: 200 },
      {
        id: 'u2',
        role: 'user',
        parts: [{ kind: 'text', text: '需要重新编辑的终止问题' }],
        images: [
          {
            id: 'img-1',
            data: 'AAAA',
            mimeType: 'image/png',
            name: 'shot.png'
          }
        ],
        ts: 300
      },
      {
        id: 'a2',
        role: 'assistant',
        aborted: true,
        parts: [{ kind: 'text', text: '生成到一半被停止' }],
        ts: 400
      }
    ];
    const { surface, recallSpy } = makeStatefulGuiSurface(initial);
    const { container } = render(
      <StoreProvider>
        <ChatSurfaceView surface={surface} workspaceId="ws-1" />
      </StoreProvider>
    );

    const u1Node = container.querySelector<HTMLElement>('[data-mid="u1"]')!;
    const u2Node = container.querySelector<HTMLElement>('[data-mid="u2"]')!;
    expect(within(u1Node).queryByRole('button', { name: '重新编辑' })).toBeNull();
    const editBtn = within(u2Node).getByRole('button', { name: '重新编辑' });
    expect(editBtn.getAttribute('title')).toBe('重新编辑终止消息');

    fireEvent.click(editBtn);

    await waitFor(() => expect(recallSpy).toHaveBeenCalledWith('u2'));
    await waitFor(() => {
      expect(container.querySelector('[data-mid="u2"]')).toBeNull();
      expect(container.querySelector('[data-mid="a2"]')).toBeNull();
    });
    expect(container.querySelector('[data-mid="u1"]')).toBeTruthy();
    expect(container.querySelector('[data-mid="a1"]')).toBeTruthy();

    const editor = screen.getByRole('textbox');
    await waitFor(() => {
      expect(editor.textContent).toBe('需要重新编辑的终止问题');
    });
    expect(container.querySelector('.agent-composer-images img[alt="shot.png"]')).toBeTruthy();
  });

  it('busy 进行中或末轮正常完成时不显示「重新编辑」按钮', () => {
    const completed: GuiChatMessage[] = [
      { id: 'u1', role: 'user', parts: [{ kind: 'text', text: '早先被终止的问题' }], ts: 100 },
      { id: 'a1', role: 'assistant', aborted: true, parts: [], ts: 200 },
      { id: 'u2', role: 'user', parts: [{ kind: 'text', text: '后续正常完成的问题' }], ts: 300 },
      { id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: '正常完成的回复' }], ts: 400 }
    ];
    const { surface, setState } = makeStatefulGuiSurface(completed, false);
    const { container, rerender } = render(
      <StoreProvider>
        <ChatSurfaceView surface={surface} workspaceId="ws-1" />
      </StoreProvider>
    );
    expect(container.querySelectorAll('button[aria-label="重新编辑"]').length).toBe(0);

    // 即使末条标了 aborted，但 busy=true 时也不露出按钮
    setState(
      [
        { id: 'u1', role: 'user', parts: [{ kind: 'text', text: '进行中' }], ts: 100 },
        { id: 'a1', role: 'assistant', aborted: true, parts: [], ts: 200 }
      ],
      true
    );
    rerender(
      <StoreProvider>
        <ChatSurfaceView surface={surface} workspaceId="ws-1" />
      </StoreProvider>
    );
    expect(container.querySelectorAll('button[aria-label="重新编辑"]').length).toBe(0);
  });
});
