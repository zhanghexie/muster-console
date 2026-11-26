import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiWorkerHistory } from '../../src/shared/guiWorker';
import { currentApiMock } from './helpers/api-mock';
import { overrideGuiHistory } from './helpers/gui-history-range';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

const history: GuiWorkerHistory = {
  messages: [{ id: 'fixture', role: 'user', ts: 1, parts: [{ kind: 'text', text: 'Permission fixture' }] }],
  mode: 'auto', busy: false
};

function mount(id: string) {
  const ref: { current: ChatSurface | null } = { current: null };
  function Probe({ sessionId }: { sessionId: string }) {
    ref.current = useAgentSessionSurface({ sessionId, runtimeId: 'pi', visible: true });
    return null;
  }
  const ui = (sessionId: string) => <StoreProvider><Probe sessionId={sessionId} /></StoreProvider>;
  const view = render(ui(id));
  return { ref, view, switchTo: (sessionId: string) => view.rerender(ui(sessionId)) };
}

describe('Core permission configuration mode synchronization', () => {
  it('applies the confirmed manual mode immediately and retains it after switching sessions', async () => {
    const api = currentApiMock();
    let current: GuiWorkerHistory = history;
    overrideGuiHistory(api, async id => id === 'core' ? current : history);
    const client = mount('core');
    await waitFor(() => expect(client.ref.current!.getSnapshot().messages).toHaveLength(1));
    current = { ...history, mode: 'standard' };
    act(() => api.emit('agentSession:event', { kind: 'permission-mode', sessionId: 'core', mode: 'standard' }));
    expect(client.ref.current!.getSnapshot().mode).toBe('standard');
    act(() => client.switchTo('other'));
    await waitFor(() => expect(client.ref.current!.getSnapshot().messages).toHaveLength(1));
    act(() => client.switchTo('core'));
    await waitFor(() => expect(client.ref.current!.getSnapshot().mode).toBe('standard'));
  });

  it('does not let a history response captured before the toggle restore automatic mode', async () => {
    const api = currentApiMock();
    const pending = deferred<GuiWorkerHistory>();
    overrideGuiHistory(api, () => pending.promise);
    const client = mount('late-history');
    await waitFor(() => expect(api.mockOf('agentSession.historyRange')).toHaveBeenCalled());
    act(() => api.emit('agentSession:event', { kind: 'permission-mode', sessionId: 'late-history', mode: 'standard' }));
    await act(async () => pending.resolve(history));
    await waitFor(() => expect(client.ref.current!.getSnapshot().messages).toHaveLength(1));
    expect(client.ref.current!.getSnapshot().mode).toBe('standard');
  });

  it('invalidates pre-toggle mode requests and uses the confirmed mode for later failures', async () => {
    const api = currentApiMock();
    overrideGuiHistory(api, async () => history);
    const pending = deferred<{ ok: boolean }>();
    api.override('agentSession.setMode', () => pending.promise);
    const client = mount('late-selection');
    await waitFor(() => expect(client.ref.current!.getSnapshot().messages).toHaveLength(1));
    act(() => client.ref.current!.actions.setMode?.('plan'));
    await waitFor(() => expect(api.mockOf('agentSession.setMode')).toHaveBeenCalledTimes(1));
    act(() => {
      client.ref.current!.actions.setMode?.('accept-edits');
      api.emit('agentSession:event', { kind: 'permission-mode', sessionId: 'late-selection', mode: 'standard' });
    });
    await act(async () => pending.resolve({ ok: true }));
    expect(api.mockOf('agentSession.setMode')).toHaveBeenCalledTimes(1);
    expect(client.ref.current!.getSnapshot().mode).toBe('standard');
    api.override('agentSession.setMode', async () => ({ ok: false, error: 'Fixture persistence failure' }));
    await act(async () => { client.ref.current!.actions.setMode?.('plan'); });
    await waitFor(() => expect(client.ref.current!.getSnapshot().mode).toBe('standard'));
  });
});
