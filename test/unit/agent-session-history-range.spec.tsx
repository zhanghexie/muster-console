/** GUI Worker history range is used for initial tail loading and older-page prepend. */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage, GuiWorkerHistoryPage } from '../../src/shared/guiWorker';
import { currentApiMock } from './helpers/api-mock';

function message(id: string, ts: number): GuiChatMessage {
  return { id, role: 'user', ts, parts: [{ kind: 'text', text: id }] } as GuiChatMessage;
}

describe('agentSessionSurface GUI history range', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    });
  });

  it.each(['pi', 'acp', 'codex-gui', 'claude'] as const)('loads %s history without requiring an external host mode', async (runtimeId) => {
    const hostMode = runtimeId === 'pi' ? { mode: 'auto' as const } : {};
    const pages: GuiWorkerHistoryPage[] = [
      { messages: [message('m1', 1), message('m2', 2)], ...hostMode, busy: false, before: 1, total: 3, hasEarlier: true },
      { messages: [message('m0', 0)], ...hostMode, busy: false, before: 0, total: 3, hasEarlier: false }
    ];
    const range = currentApiMock().mockOf('agentSession.historyRange');
    range.mockImplementation(async (_sessionId: string, before?: number) => before === undefined ? pages[0] : pages[1]);
    currentApiMock().override('agentSession.getHistory', async () => ({ messages: [], mode: 'auto', busy: false }));

    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-range', visible: true, runtimeId });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1', 'm2']));
    expect(surfaceRef.current?.getSnapshot().historyHasEarlier).toBe(true);

    await act(async () => { await surfaceRef.current?.actions.loadEarlier?.(); });
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2']));
    expect(surfaceRef.current?.getSnapshot().historyHasEarlier).toBe(false);
    expect(surfaceRef.current?.getSnapshot().historyError).toBeFalsy();
    expect(range).toHaveBeenNthCalledWith(1, 'gui-range', undefined, 120);
    expect(range).toHaveBeenNthCalledWith(2, 'gui-range', 1, 120);
  });

  it.each(['pi', 'acp'] as const)('loads an unloaded %s navigation target in one bounded request', async (runtimeId) => {
    const hostMode = runtimeId === 'pi' ? { mode: 'auto' as const } : {};
    const pages: GuiWorkerHistoryPage[] = [
      { messages: [message('m2', 2)], ...hostMode, busy: false, before: 2, total: 3, hasEarlier: true },
      { messages: [message('m0', 0), message('m1', 1)], ...hostMode, busy: false, before: 0, total: 3, hasEarlier: false }
    ];
    const api = currentApiMock();
    const range = api.mockOf('agentSession.historyRange');
    range.mockImplementation(async (_sessionId: string, _before?: number, _limit?: number, target?: string) => target ? pages[1] : pages[0]);
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-range-target', visible: true, runtimeId });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m2']));

    await act(async () => {
      await expect(surfaceRef.current?.actions.ensureMessageLoaded?.('m0')).resolves.toBe(true);
    });
    expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2']);
    expect(range).toHaveBeenNthCalledWith(2, 'gui-range-target', undefined, 120, 'm0');
  });

  it.each([null, 42])('rejects malformed history mode %s when present', async (mode) => {
    const api = currentApiMock();
    api.override('agentSession.historyRange', async () => ({
      messages: [message('invalid-mode', 1)], mode, busy: false, before: 0, total: 1, hasEarlier: false
    }));
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    function Harness() {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-invalid-mode', visible: true, runtimeId: 'acp' });
      return null;
    }
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().historyError).toContain('Invalid GUI history range response'));
    expect(surfaceRef.current?.getSnapshot().messages).toHaveLength(0);
    expect(api.mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
  });

  it('reports failed range loading without reading a complete snapshot', async () => {
    const api = currentApiMock();
    const range = api.mockOf('agentSession.historyRange');
    range.mockRejectedValue(new Error('range unavailable'));
    const full = message('full', 1);
    api.override('agentSession.getHistory', async () => ({ messages: [full], mode: 'auto', busy: false }));
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-range-fallback', visible: true, runtimeId: 'pi' });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().historyError).toContain('range unavailable'));
    expect(surfaceRef.current?.getSnapshot().messages).toHaveLength(0);
    expect(api.mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
    expect(range).toHaveBeenCalledTimes(1);
  });

  it('rejects a delayed older page after a newer authoritative sync removes its IDs',async()=>{
    const api=currentApiMock();let finish!:(page:GuiWorkerHistoryPage)=>void;
    api.override('agentSession.historyRange',(_id:string,before?:number)=>before===undefined
      ?Promise.resolve({messages:[message('tail',3)],mode:'auto',busy:false,before:2,total:3,hasEarlier:true})
      :new Promise<GuiWorkerHistoryPage>(resolve=>{finish=resolve;}));
    const ref:{current:ChatSurface|null}={current:null};
    function Probe(){ref.current=useAgentSessionSurface({sessionId:'gui-page-sync-race',visible:true,runtimeId:'pi'});return null;}
    render(<StoreProvider><Probe/></StoreProvider>);
    await waitFor(()=>expect(ref.current?.getSnapshot().messages.map(row=>(row as GuiChatMessage).id)).toEqual(['tail']));
    let loading!:Promise<void>;act(()=>{loading=ref.current!.actions.loadEarlier!();});
    act(()=>api.emit('agentSession:event',{kind:'sync',sessionId:'gui-page-sync-race',messages:[message('fresh',4)],before:0,total:1,hasEarlier:false}));
    await act(async()=>{finish({messages:[message('removed-older',1),message('removed-middle',2)],mode:'auto',busy:false,before:0,total:3,hasEarlier:false});await loading;});
    expect(ref.current?.getSnapshot().messages.map(row=>(row as GuiChatMessage).id)).toEqual(['fresh']);
    expect(ref.current?.actions.messageIndex?.('removed-older')).toBeUndefined();
    expect(ref.current?.actions.messageIndex?.('fresh')).toBe(0);
  });

  it('overlapping older pages refresh an already loaded message instead of dropping it', async () => {
    const api = currentApiMock();
    const range = api.mockOf('agentSession.historyRange');
    const refreshed = { ...message('m1', 1), parts: [{ kind: 'text', text: 'm1-new' }] } as GuiChatMessage;
    range.mockImplementation(async (_sessionId: string, before?: number) => before === undefined
      ? { messages: [message('m1', 1), message('m2', 2)], mode: 'auto', busy: false, before: 1, total: 3, hasEarlier: true }
      : { messages: [message('m0', 0), refreshed], mode: 'auto', busy: false, before: 0, total: 3, hasEarlier: false });
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-range-overlap', visible: true, runtimeId: 'pi' });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1', 'm2']));
    await act(async () => { await surfaceRef.current?.actions.loadEarlier?.(); });
    const messages = surfaceRef.current?.getSnapshot().messages as GuiChatMessage[];
    expect(messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(messages[1]?.parts?.[0]).toEqual({ kind: 'text', text: 'm1-new' });
  });

  it('does not let a stale older page overwrite a live update received in flight', async () => {
    const api = currentApiMock();
    const range = api.mockOf('agentSession.historyRange');
    let releasePage: ((page: GuiWorkerHistoryPage) => void) | undefined;
    range.mockImplementation(async (_sessionId: string, before?: number) => {
      if (before === undefined) {
        return {
          messages: [message('m1', 1), message('m2', 2)],
          mode: 'auto', busy: false, before: 1, total: 3, hasEarlier: true, liveSeq: 1
        };
      }
      return new Promise<GuiWorkerHistoryPage>((resolve) => { releasePage = resolve; });
    });
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-range-live-overlap', visible: true, runtimeId: 'pi' });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1', 'm2']));

    act(() => { void surfaceRef.current?.actions.loadEarlier?.(); });
    await waitFor(() => expect(range).toHaveBeenCalledTimes(2));
    act(() => api.emit('agentSession:event', {
      sessionId: 'gui-range-live-overlap', kind: 'delta', messageId: 'm1', partIndex: 0,
      deltaKind: 'text', delta: '-live', liveSeq: 2
    }));
    await waitFor(() => expect((surfaceRef.current?.getSnapshot().messages[0] as GuiChatMessage).parts?.[0]).toEqual({ kind: 'text', text: 'm1-live' }));

    await act(async () => {
      releasePage?.({
        messages: [message('m0', 0), message('m1', 1)],
        mode: 'auto', busy: false, before: 0, total: 3, hasEarlier: false, liveSeq: 1
      });
    });
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2']));
    expect((surfaceRef.current?.getSnapshot().messages[1] as GuiChatMessage).parts?.[0]).toEqual({ kind: 'text', text: 'm1-live' });
  });

  it('keeps a live full sync bounded to the tail page', async () => {
    const api = currentApiMock();
    api.override('agentSession.historyRange', async () => ({
      messages: [message('tail', 1)], mode: 'auto', busy: false, before: 1, total: 2, hasEarlier: true
    }));
    api.override('agentSession.getHistory', async () => ({ messages: [], mode: 'auto', busy: false }));
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-range-sync', visible: true, runtimeId: 'pi' });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages).toHaveLength(1));
    const full = api.mockOf('agentSession.getHistory');
    full.mockClear();
    act(() => api.emit('agentSession:event', {
      sessionId: 'gui-range-sync', kind: 'part', messageId: 'older-unloaded', partIndex: 0,
      part: { kind: 'text', text: 'late older update' }
    }));
    expect(full).not.toHaveBeenCalled();
    const fullSync = Array.from({ length: 300 }, (_, i) => message(`sync-${i}`, i));
    act(() => api.emit('agentSession:event', { sessionId: 'gui-range-sync', kind: 'sync', messages: fullSync }));
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages).toHaveLength(120));
    expect((surfaceRef.current?.getSnapshot().messages.at(-1) as { id: string }).id).toBe('sync-299');
    expect(surfaceRef.current?.getSnapshot().historyHasEarlier).toBe(true);
  });

  it.each(['pi', 'acp'] as const)('recovers a missing %s live revision through the bounded history range', async (runtimeId) => {
    const hostMode = runtimeId === 'pi' ? { mode: 'auto' as const } : {};
    const api = currentApiMock();
    const epoch = '00000000-0000-4000-8000-000000000001';
    const range = api.mockOf('agentSession.historyRange');
    range.mockImplementation(async () => range.mock.calls.length === 1
      ? { messages: [message('m1', 1)], messagesVersion: `${epoch}:1`, liveSeq: 1, ...hostMode, busy: false, before: 0, total: 1, hasEarlier: false }
      : { messages: [message('m2', 2)], messagesVersion: `${epoch}:3`, liveSeq: 3, ...hostMode, busy: false, before: 0, total: 1, hasEarlier: false });
    api.override('agentSession.getHistory', async () => ({ messages: [], mode: 'auto', busy: false }));
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-gap', visible: true, runtimeId });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1']));

    act(() => api.emit('agentSession:event', {
      sessionId: 'gui-gap',
      kind: 'delta',
      messageId: 'm1',
      partIndex: 0,
      deltaKind: 'text',
      delta: 'lost-prefix',
      liveSeq: 3
    }));

    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m2']));
    expect(range).toHaveBeenCalledTimes(2);
    expect(api.mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
  });

  it('retries recovery when a higher live revision arrives while the page is in flight', async () => {
    const api = currentApiMock();
    const range = api.mockOf('agentSession.historyRange');
    let releaseRecovery: ((page: GuiWorkerHistoryPage) => void) | undefined;
    range.mockImplementation(async () => {
      if (range.mock.calls.length === 1) {
        return { messages: [message('m1', 1)], mode: 'auto', busy: false, before: 0, total: 1, hasEarlier: false, liveSeq: 1 };
      }
      if (range.mock.calls.length === 2) {
        return new Promise<GuiWorkerHistoryPage>((resolve) => { releaseRecovery = resolve; });
      }
      return { messages: [message('m3', 3)], mode: 'auto', busy: false, before: 0, total: 1, hasEarlier: false, liveSeq: 4 };
    });
    api.override('agentSession.getHistory', async () => ({ messages: [], mode: 'auto', busy: false }));
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-recovery-latch', visible: true, runtimeId: 'pi' });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1']));

    act(() => api.emit('agentSession:event', {
      sessionId: 'gui-recovery-latch', kind: 'delta', messageId: 'm1', partIndex: 0,
      deltaKind: 'text', delta: '-gap', liveSeq: 3
    }));
    await waitFor(() => expect(range).toHaveBeenCalledTimes(2));
    act(() => api.emit('agentSession:event', {
      sessionId: 'gui-recovery-latch', kind: 'delta', messageId: 'm1', partIndex: 0,
      deltaKind: 'text', delta: '-newer', liveSeq: 4
    }));

    await act(async () => {
      releaseRecovery?.({ messages: [message('m2', 2)], mode: 'auto', busy: false, before: 0, total: 1, hasEarlier: false, liveSeq: 2 });
    });
    await waitFor(() => expect(range).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m3']));
  });

  it('keeps already loaded older pages when a bounded live tail arrives', async () => {
    const api = currentApiMock();
    const range = api.mockOf('agentSession.historyRange');
    range.mockImplementation(async (_sessionId: string, before?: number) => before === undefined
      ? { messages: [message('m1', 1), message('m2', 2)], mode: 'auto', busy: false, before: 1, total: 3, hasEarlier: true }
      : { messages: [message('m0', 0)], mode: 'auto', busy: false, before: 0, total: 3, hasEarlier: false });
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-sync-tail', visible: true, runtimeId: 'pi' });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1', 'm2']));
    await act(async () => { await surfaceRef.current?.actions.loadEarlier?.(); });
    expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2']);

    act(() => api.emit('agentSession:event', {
      sessionId: 'gui-sync-tail', kind: 'sync',
      messages: [message('m2', 2), message('m3', 3)], before: 2, total: 4, hasEarlier: true
    }));
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2', 'm3']));
  });

  it('keeps loaded older pages when a live-seq gap recovers the bounded tail', async () => {
    const api = currentApiMock();
    const epoch = '00000000-0000-4000-8000-000000000002';
    const range = api.mockOf('agentSession.historyRange');
    range.mockImplementation(async (_sessionId: string, before?: number) => {
      if (range.mock.calls.length === 1) {
        return { messages: [message('m1', 1), message('m2', 2)], messagesVersion: `${epoch}:1`, liveSeq: 1, mode: 'auto', busy: false, before: 1, total: 3, hasEarlier: true };
      }
      if (before === 1) {
        return { messages: [message('m0', 0)], messagesVersion: `${epoch}:1`, liveSeq: 1, mode: 'auto', busy: false, before: 0, total: 3, hasEarlier: false };
      }
      return { messages: [message('m1', 1), message('m2', 2)], messagesVersion: `${epoch}:3`, liveSeq: 3, mode: 'auto', busy: false, before: 1, total: 3, hasEarlier: true };
    });
    api.override('agentSession.getHistory', async () => ({ messages: [], mode: 'auto', busy: false }));
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-gap-loaded-older', visible: true, runtimeId: 'pi' });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1', 'm2']));
    await act(async () => { await surfaceRef.current?.actions.loadEarlier?.(); });
    expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2']);

    act(() => api.emit('agentSession:event', {
      sessionId: 'gui-gap-loaded-older', kind: 'delta', messageId: 'm2', partIndex: 0,
      deltaKind: 'text', delta: 'lost', liveSeq: 3
    }));
    await waitFor(() => expect(range).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2']));
    expect(surfaceRef.current?.getSnapshot().historyHasEarlier).toBe(false);
  });

  it('drops a stale GUI sync while its bounded recovery is still pending', async () => {
    const api = currentApiMock();
    const range = api.mockOf('agentSession.historyRange');
    let releaseRecovery: ((page: GuiWorkerHistoryPage) => void) | undefined;
    range.mockImplementation(async () => range.mock.calls.length === 1
      ? { messages: [message('m1', 1)], mode: 'auto', busy: false, before: 0, total: 1, hasEarlier: false, liveSeq: 5 }
      : new Promise<GuiWorkerHistoryPage>((resolve) => { releaseRecovery = resolve; }));
    api.override('agentSession.getHistory', async () => ({ messages: [], mode: 'auto', busy: false }));
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    const Harness = (): null => {
      surfaceRef.current = useAgentSessionSurface({ sessionId: 'gui-stale-sync', visible: true, runtimeId: 'pi' });
      return null;
    };
    render(<StoreProvider><Harness /></StoreProvider>);
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1']));

    act(() => api.emit('agentSession:event', {
      sessionId: 'gui-stale-sync', kind: 'sync', messages: [message('stale', 0)],
      before: 0, total: 1, hasEarlier: false, liveSeq: 4
    }));
    await waitFor(() => expect(range).toHaveBeenCalledTimes(2));
    expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m1']);

    await act(async () => {
      releaseRecovery?.({ messages: [message('m2', 2)], mode: 'auto', busy: false, before: 0, total: 1, hasEarlier: false, liveSeq: 6 });
    });
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.map(m => (m as { id: string }).id)).toEqual(['m2']));
  });
});
