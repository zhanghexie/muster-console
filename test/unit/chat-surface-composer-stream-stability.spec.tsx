import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { StoreProvider } from '../../src/renderer/src/store';
import type { ChatSurface, ChatSurfaceSnapshot } from '../../src/shared/chatSurface';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';

const fixture = vi.hoisted(() => ({ renders: vi.fn() }));
vi.mock('../../src/renderer/src/components/AgentComposer', async () => {
  const React = await import('react');
  return { AgentComposer: React.memo((props: unknown) => { fixture.renders(props); return null; }) };
});
vi.mock('../../src/renderer/src/chatSurface/ChatTranscript', () => ({ ChatTranscript: () => null }));
vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });

describe('composer isolation during a GUI stream', () => {
  it('translates a known history read error while retaining the original failure', async () => {
    const original = 'Error: 待投递的分叉上下文无法读取，请保留会话并检查本地数据';
    const snapshot: ChatSurfaceSnapshot = { messages: [], busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null, historyError: original };
    const surface: ChatSurface = { sessionId: 'history', caps: { surfaceKind: 'gui-session', draftKey: 'history' }, subscribe: () => () => {}, getSnapshot: () => snapshot,
      actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} } };
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<StoreProvider><ChatSurfaceView surface={surface} findEnabled={false}/></StoreProvider>); });
    try {
      expect(screen.getByRole('alert').textContent).toBe(original);
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByRole('alert').textContent).toBe('Could not read the pending fork context. Keep the session and check local data.');
      expect(snapshot.historyError).toBe(original);
    } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('does not re-render for message-only updates, but receives real permission changes', async () => {
    fixture.renders.mockClear();
    currentApiMock().override('sessions.list', async () => ({ sessions: [{ id: 'stream', name: 'fixture', runtime: 'pi', type: 'terminal', createdAt: 1, configurePermissions: true }], activeId: 'stream' }));
    let snapshot: ChatSurfaceSnapshot = { messages: [], busy: true, queuedCount: 0, queuedItems: [], status: null, mode: 'auto', preset: null };
    const listeners = new Set<() => void>();
    const surface: ChatSurface = {
      sessionId: 'stream', caps: { surfaceKind: 'gui-session', draftKey: 'stream' },
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      getSnapshot: () => snapshot,
      actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} }
    };
    await act(async () => { render(<StoreProvider><ChatSurfaceView surface={surface} findEnabled={false} /></StoreProvider>); });
    await waitFor(() => expect(fixture.renders.mock.lastCall?.[0]).toMatchObject({ mode: 'auto', harnessId: 'muster-core' }));
    const renders = fixture.renders.mock.calls.length;
    act(() => {
      snapshot = { ...snapshot, messages: [{ id: 'a', role: 'assistant', ts: 1, parts: [{ kind: 'text', text: 'one' }] }] };
      listeners.forEach(listener => listener());
    });
    expect(fixture.renders).toHaveBeenCalledTimes(renders);
    act(() => { snapshot = { ...snapshot, mode: 'ask' }; listeners.forEach(listener => listener()); });
    expect(fixture.renders.mock.lastCall?.[0]).toMatchObject({ mode: 'ask' });
    expect(fixture.renders.mock.calls.length).toBeGreaterThan(renders);
  });
});
