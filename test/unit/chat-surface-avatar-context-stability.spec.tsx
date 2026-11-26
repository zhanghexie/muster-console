import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { ChatAvatarContext } from '../../src/shared/userAvatar';
import type { AgentRuntimeEntry, SessionMeta, WorkspaceInfo } from '../../src/shared/types';
import { StoreProvider, useUiActionsStore, useUiStore } from '../../src/renderer/src/store';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { currentApiMock } from './helpers/api-mock';

const fixture = vi.hoisted(() => ({ contexts: [] as ChatAvatarContext[] }));
vi.mock('../../src/renderer/src/chatSurface/ChatTranscript', () => ({
  ChatTranscript: (props: { avatarContext: ChatAvatarContext }) => { fixture.contexts.push(props.avatarContext); return null; }
}));
vi.mock('../../src/renderer/src/components/AgentComposer', () => ({ AgentComposer: () => null }));
vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });

const workspace: WorkspaceInfo = { id: 'ws', path: 'E:/workspace', name: 'Workspace', openedAt: 1, avatar: '🐙' };
const session: SessionMeta = { id: 'a', type: 'terminal', name: 'My chat', runtime: 'pi', createdAt: 1, workspaceId: 'ws' };
const other: SessionMeta = { id: 'b', type: 'terminal', name: 'Background chat', runtime: 'pi', createdAt: 2, workspaceId: 'ws' };
const pi: AgentRuntimeEntry = { id: 'pi', label: 'Pi', script: '', builtin: true, enabled: true, updatedAt: 1, surface: 'chat' };
const cursor: AgentRuntimeEntry = { ...pi, id: 'cursor', label: 'Cursor' };

function makeSurface(): ChatSurface {
  const snap = { messages: [], busy: false, queuedItems: [], queuedCount: 0, status: null, mode: null, preset: null };
  return {
    sessionId: 'a', caps: { surfaceKind: 'gui-session', draftKey: 'a' },
    subscribe: () => () => {}, getSnapshot: () => snap,
    actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} }
  };
}
const latest = () => fixture.contexts.at(-1)!;
beforeEach(() => {
  fixture.contexts = [];
  const mock = currentApiMock();
  mock.override('config.get', async () => ({ workspaces: [workspace], activeWorkspaceId: 'ws', locale: 'zh-CN' }));
  mock.override('workspaces.list', async () => ({ workspaces: [workspace], activeWorkspaceId: 'ws' }));
  mock.override('sessions.list', async () => ({ sessions: [session, other], activeId: 'a' }));
  mock.override('runtimes.list', async () => [pi, cursor]);
});

describe('chat surface unrelated state propagation', () => {
  it('retains avatar context through background status and equivalent workspace/runtime refreshes', async () => {
    const surface = makeSurface();
    await act(async () => { render(<StoreProvider><ChatSurfaceView surface={surface} workspaceId="ws" findEnabled={false} /></StoreProvider>); });
    await waitFor(() => expect(latest().sessionName).toBe('My chat'));
    const first = latest();
    act(() => currentApiMock().emit('sessions:changed', {
      sessions: [{ ...session, lastUsedAt: 500 }, { ...other, name: 'Other renamed' }], activeId: 'a'
    }));
    expect(latest()).toBe(first);
    act(() => currentApiMock().emit('workspaces:changed', { workspaces: [{ ...workspace, openedAt: 99 }], activeWorkspaceId: 'ws' }));
    expect(latest()).toBe(first);
    act(() => currentApiMock().emit('runtimes:changed', [{ ...pi, updatedAt: 99 }, { ...cursor, label: 'Other runtime renamed' }]));
    expect(latest()).toBe(first);

    act(() => currentApiMock().emit('workspaces:changed', { workspaces: [{ ...workspace, name: 'Renamed', avatar: '🦊' }], activeWorkspaceId: 'ws' }));
    expect(latest()).not.toBe(first);
    expect(latest()).toMatchObject({ workspaceName: 'Renamed', workspaceAvatar: '🦊' });
    act(() => currentApiMock().emit('sessions:changed', { sessions: [{ ...session, name: 'New session', runtime: 'cursor' }, other], activeId: 'a' }));
    expect(latest()).toMatchObject({ sessionName: 'New session', runtimeId: 'cursor', runtimeLabel: 'Other runtime renamed' });
    act(() => currentApiMock().emit('runtimes:changed', [{ ...pi }, { ...cursor, label: 'Cursor updated' }]));
    expect(latest().runtimeLabel).toBe('Cursor updated');
  });

  it('ignores unrelated UI state and stable actions still target the newest workspace', async () => {
    const surface = makeSurface();
    let ui!: ReturnType<typeof useUiStore>;
    let actions!: ReturnType<typeof useUiActionsStore>;
    function Driver(): null { ui = useUiStore(); actions = useUiActionsStore(); return null; }
    await act(async () => { render(<StoreProvider><Driver /><ChatSurfaceView surface={surface} workspaceId="ws" findEnabled={false} /></StoreProvider>); });
    const count = fixture.contexts.length;
    const stableActions = actions;
    act(() => ui.openCommandPalette('goto'));
    expect(ui.commandPalette?.mode).toBe('goto');
    expect(fixture.contexts).toHaveLength(count);
    act(() => actions.requestComposerInsert('directed', { target: 'a' }));
    expect(ui.composerInsert?.text).toBe('directed');
    expect(fixture.contexts).toHaveLength(count);
    act(() => actions.requestOpenWorkspaceFile({ path: 'E:/workspace/a.md' }));
    expect(ui.openWorkspaceFile?.path).toBe('E:/workspace/a.md');
    expect(fixture.contexts).toHaveLength(count);

    act(() => currentApiMock().emit('workspaces:changed', { workspaces: [{ ...workspace, id: 'next' }], activeWorkspaceId: 'next' }));
    expect(actions).toBe(stableActions);
    act(() => stableActions.requestOpenWorkspaceFile({ path: 'next.md', fileRef: { workspaceId: 'next', rootId: 'root', relativePath: 'next.md' } }));
    expect(ui.openWorkspaceFile?.fileRef?.workspaceId).toBe('next');
  });
});
