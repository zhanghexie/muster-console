import {overrideGuiHistory} from './helpers/gui-history-range';
/** Metadata changes must not invalidate a complete unchanged transcript. */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage } from '../../src/shared/guiWorker';
import { currentApiMock } from './helpers/api-mock';

const message = (id: string, text: string, extra: Partial<GuiChatMessage> = {}): GuiChatMessage => ({
  id, role: 'user', parts: [{ kind: 'text', text }], ts: 1, ...extra
});

async function mount(messages: GuiChatMessage[]) {
  const ref: { current: ChatSurface | null } = { current: null };
  overrideGuiHistory(currentApiMock(), async () => ({ messages, mode: 'auto', busy: false }));
  function Harness(): null {
    ref.current = useAgentSessionSurface({ sessionId: 'stable-transcript', runtimeId: 'pi', visible: true });
    return null;
  }
  await act(async () => { render(<StoreProvider><Harness /></StoreProvider>); });
  await waitFor(() => expect(ref.current!.getSnapshot().messages.length).toBeGreaterThan(0));
  return ref.current!;
}

describe('GUI snapshot transcript identity', () => {
  it('preserves visible messages and queued items through busy, usage and parameter notifications', async () => {
    const surface = await mount([
      message('u', 'visible'),
      message('host', 'hidden', { steering: 'host' }),
      message('q', 'queued', { queued: true })
    ]);
    const first = surface.getSnapshot();
    expect(first.messages.map(item => (item as GuiChatMessage).id)).toEqual(['u', 'q']);
    expect(first.queuedCount).toBe(1);
    const events = [
      { kind: 'busy', busy: true },
      { kind: 'context', usage: { tokens: 25, contextWindow: 1000 } },
      { kind: 'parameters', controls: [] },
      { kind: 'engine-meta', slashCommands: [{ name: 'status' }] }
    ];
    for (const event of events) {
      act(() => currentApiMock().emit('agentSession:event', { sessionId: surface.sessionId, ...event }));
      const next = surface.getSnapshot();
      expect(next.messages).toBe(first.messages);
      expect(next.queuedItems).toBe(first.queuedItems);
      expect(next.queuedCount).toBe(1);
    }
    expect(surface.getSnapshot().busy).toBe(true);
    expect(surface.getSnapshot().engineSlashCommands).toEqual([{ name: 'status' }]);
  });

  it('refreshes actual message edits and Harness filtering including hidden queued messages', async () => {
    const surface = await mount([
      message('u', 'old'),
      message('host', 'hidden queued', { steering: 'host', queued: true })
    ]);
    const first = surface.getSnapshot();
    expect(first.queuedCount).toBe(0);
    act(() => currentApiMock().emit('agentSession:event', {
      sessionId: surface.sessionId, kind: 'part', messageId: 'u', partIndex: 0,
      part: { kind: 'text', text: 'edited' }
    }));
    const edited = surface.getSnapshot();
    expect(edited.messages).not.toBe(first.messages);
    expect((edited.messages[0] as GuiChatMessage).parts[0]).toEqual({ kind: 'text', text: 'edited' });
    act(() => surface.actions.setHarnessOn!(true));
    expect(surface.getSnapshot().messages).toHaveLength(2);
    expect(surface.getSnapshot().queuedCount).toBe(1);
    expect(surface.getSnapshot().queuedItems[0]?.text).toBe('hidden queued');
    act(() => surface.actions.setHarnessOn!(false));
    expect(surface.getSnapshot().messages).toHaveLength(1);
    expect(surface.getSnapshot().queuedItems).toHaveLength(0);
  });

  it('keeps the harness catalog identity on message changes and replaces it when the catalog changes', async () => {
    const mock = currentApiMock();
    overrideGuiHistory(mock, async () => ({ messages: [message('u', 'old')], mode: 'auto', busy: false }));
    mock.override('agentSession.getHarnessModelSelections', async () => ({}));
    mock.override('agentSession.getSessionHarnessModelState', async () => ({ ok: true, expected: {
      runtimeId: 'acp', cwd: 'E:/worktree', catalogCwd: 'E:/fixture', workspaceFingerprint: 'w', engineFingerprint: 'e',
      presetId: 'kimi', agentId: 'kimi', modelOverride: null
    } }));
    let model = 'first';
    let failed = false;
    mock.override('agentSession.listSessionHarnessModels', async () => failed
      ? { ok: false, error: 'catalog refresh failed' }
      : { ok: true, runtimeId: 'acp', agentId: 'kimi', items: [{ id: model, name: model }] });
    const ref: { current: ChatSurface | null } = { current: null };
    function Harness(): null {
      ref.current = useAgentSessionSurface({ sessionId: 'stable-catalog', runtimeId: 'acp', visible: true });
      return null;
    }
    await act(async () => { render(<StoreProvider><Harness /></StoreProvider>); });
    await waitFor(() => expect(ref.current?.getSnapshot().messages).toHaveLength(1));
    expect(mock.mockOf('agentSession.listSessionHarnessModels')).not.toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
    await act(async () => { await ref.current!.actions.reloadHarnessCatalog!(); });
    await waitFor(() => expect(ref.current?.getSnapshot().status?.harnessModelCatalog?.state).toBe('ready'));
    const first = ref.current!.getSnapshot().status!.harnessModelCatalog!;
    expect(first.items[0].id).toBe('first');
    act(() => mock.emit('agentSession:event', {
      sessionId: 'stable-catalog', kind: 'part', messageId: 'u', partIndex: 0,
      part: { kind: 'text', text: 'edited' }
    }));
    expect(ref.current!.getSnapshot().status!.harnessModelCatalog).toBe(first);
    model = 'second';
    await act(async () => { await ref.current!.actions.reloadHarnessCatalog!(); });
    const updated = ref.current!.getSnapshot().status!.harnessModelCatalog!;
    expect(updated).not.toBe(first);
    expect(updated.items[0].id).toBe('second');
    model = 'source-update';
    act(() => mock.emit('agentSession:modelCatalogUpdated', { runtimeId: 'acp', agentId: 'kimi', cwd: 'E:/fixture' }));
    await waitFor(() => expect(ref.current!.getSnapshot().status!.harnessModelCatalog!.items[0].id).toBe('source-update'));
    expect(mock.mockOf('agentSession.listSessionHarnessModels')).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: false }));
    failed = true;
    await act(async () => { await ref.current!.actions.reloadHarnessCatalog!(); });
    const retained = ref.current!.getSnapshot().status!.harnessModelCatalog!;
    expect(retained.error).toBe('catalog refresh failed');
    expect(retained.items[0].id).toBe('source-update');
  });
});
