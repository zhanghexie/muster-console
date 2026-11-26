/** The kept shell consumes empty/nonempty transitions and stable UI actions only. */
import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSurface, ChatSurfaceSnapshot } from '../../src/shared/chatSurface';
import type { GuiChatMessage } from '../../src/shared/guiWorker';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { AgentChatView } from '../../src/renderer/src/agentChat/AgentChatView';
import { currentApiMock } from './helpers/api-mock';

const fixture = vi.hoisted(() => ({
  surface: null as ChatSurface | null,
  renders: vi.fn(),
  readers: [] as Array<(id: string) => 'user' | 'assistant' | undefined>
}));
vi.mock('../../src/renderer/src/chatSurface/agentSessionSurface', () => ({ useAgentSessionSurface: () => fixture.surface }));
vi.mock('../../src/renderer/src/chatSurface/useSessionNotes', () => ({
  useSessionNotes: (args: { getMessageRole: (id: string) => 'user' | 'assistant' | undefined }) => {
    fixture.readers.push(args.getMessageRole);
    return undefined;
  }
}));
vi.mock('../../src/renderer/src/chatSurface/ChatSurfaceView', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    ChatSurfaceView: (props: { header?: React.ReactNode }) => { fixture.renders(); return <>{props.header}</>; },
    // Kept so restoring the previous full-snapshot shell makes the contract test fail.
    useChatSurfaceSnapshot: (surface: ChatSurface) => useSyncExternalStore(surface.subscribe, surface.getSnapshot)
  };
});

function makeSurface() {
  let snap: ChatSurfaceSnapshot = { messages: [], busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null };
  const listeners = new Set<() => void>();
  const surface: ChatSurface = {
    sessionId: 'shell', caps: { surfaceKind: 'gui-session', draftKey: 'shell' },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snap,
    actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} }
  };
  return { surface, update: (patch: Partial<ChatSurfaceSnapshot>) => { snap = { ...snap, ...patch }; for (const listener of listeners) listener(); } };
}
const msg = (id: string, role: 'user' | 'assistant', text = id): GuiChatMessage => ({ id, role, ts: 1, parts: [{ kind: 'text', text }] });

beforeEach(() => { fixture.renders.mockClear(); fixture.readers = []; });

describe('GUI shell subscriptions', () => {
  it('keeps a live role reader while content, busy and message count changes avoid the nonempty shell', async () => {
    const state = makeSurface(); fixture.surface = state.surface;
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<StoreProvider><AgentChatView sessionId="shell" visible runtimeLabel="GUI" /></StoreProvider>); });
    const firstReader = fixture.readers[0]!;
    expect(view.container.querySelector('.chat-welcome')).not.toBeNull();
    act(() => state.update({ messages: [msg('a', 'assistant')] }));
    expect(view.container.querySelector('.chat-welcome')).toBeNull();
    expect(firstReader('a')).toBe('assistant');
    const count = fixture.renders.mock.calls.length;
    act(() => state.update({ messages: [msg('a', 'assistant', 'streamed')] }));
    act(() => state.update({ busy: true }));
    act(() => state.update({ messages: [msg('a', 'assistant'), msg('u', 'user')] }));
    expect(fixture.renders).toHaveBeenCalledTimes(count);
    expect(firstReader('u')).toBe('user');
    expect(fixture.readers.every(reader => reader === firstReader)).toBe(true);
    act(() => state.update({ messages: [] }));
    expect(view.container.querySelector('.chat-welcome')).not.toBeNull();
    expect(firstReader('u')).toBeUndefined();
  });

  it('does not rerender the kept chat shell for command palette, file or composer request state', async () => {
    const workspace = { id: 'ws', name: 'Workspace', path: 'E:/workspace', openedAt: 1 };
    currentApiMock().override('workspaces.list', async () => ({ workspaces: [workspace], activeWorkspaceId: 'ws' }));
    currentApiMock().override('config.get', async () => ({ workspaces: [workspace], activeWorkspaceId: 'ws', locale: 'zh-CN' }));
    const state = makeSurface(); fixture.surface = state.surface;
    let ui!: ReturnType<typeof useUiStore>;
    function Driver(): null { ui = useUiStore(); return null; }
    await act(async () => { render(<StoreProvider><Driver /><AgentChatView sessionId="shell" visible runtimeLabel="GUI" /></StoreProvider>); });
    const count = fixture.renders.mock.calls.length;
    act(() => ui.openCommandPalette('goto'));
    expect(ui.commandPalette?.mode).toBe('goto');
    expect(fixture.renders).toHaveBeenCalledTimes(count);
    act(() => ui.requestComposerInsert('directed', { target: 'shell' }));
    expect(ui.composerInsert?.text).toBe('directed');
    expect(fixture.renders).toHaveBeenCalledTimes(count);
    act(() => ui.requestOpenWorkspaceFile({ path: 'E:/workspace/readme.md' }));
    expect(ui.openWorkspaceFile?.path).toBe('E:/workspace/readme.md');
    expect(fixture.renders).toHaveBeenCalledTimes(count);
    act(() => ui.closeCommandPalette());
    expect(fixture.renders).toHaveBeenCalledTimes(count);
  });
});
