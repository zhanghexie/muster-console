import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { getTipSnapshot, subscribeTips } from '../../src/renderer/src/tips';
import { setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { currentApiMock } from './helpers/api-mock';
import type { FreeCanvasProps } from '../../src/renderer/src/panels/freeCanvas/types';

const fixture = vi.hoisted(() => ({
  canvas: null as FreeCanvasProps | null,
  dialog: null as null | { open: boolean; onDelegate: (args: any) => Promise<unknown> }
}));
vi.mock('../../src/renderer/src/panels/FreeCanvas', () => ({
  FreeCanvas: React.forwardRef((props: FreeCanvasProps, _ref) => { fixture.canvas = props; return <div/>; })
}));
vi.mock('../../src/renderer/src/components/NewTaskDialog', () => ({
  NewTaskDialog: (props: typeof fixture.dialog) => { fixture.dialog = props; return null; }
}));
vi.mock('../../src/renderer/src/panels/freeCanvas/useQueuedHandoverPlacement', () => ({
  rememberQueuedHandover: () => false,
  useQueuedHandoverPlacement: () => {}
}));

function Bubble() {
  const tip = React.useSyncExternalStore(subscribeTips, getTipSnapshot);
  return <div data-testid="bubble">{tip?.text ?? ''}</div>;
}

it('reports queued handover placement failure in English while preserving the queued request', async () => {
  const api = currentApiMock();
  const workspaces = [{ id: 'ws', path: 'E:/fixture', name: 'Workspace', openedAt: 1 }];
  api.override('workspaces.list', async () => ({ workspaces, activeWorkspaceId: 'ws' }));
  api.override('config.get', async () => ({ workspaces, activeWorkspaceId: 'ws', locale: 'zh-CN' }));
  api.override('sessions.delegate', async () => ({ queued: true }));
  setFreeViewMode('free');
  render(<StoreProvider><BoardPanel/><Bubble/></StoreProvider>);
  await waitFor(() => expect(fixture.canvas?.onRequestCreate).toBeTruthy());
  const draft = { id: 'draft', sourceId: 'source', workspaceId: 'ws', sourceRoot: { rootId: 'root', path: 'E:/fixture' },
    name: 'handover', documentPath: 'E:/data/history.md', lockedTask: 'read history' };
  try {
    act(() => { applyLocaleSetting('en'); });
    act(() => { fixture.canvas!.onRequestCreate!({ world: { x: 1, y: 2 }, handover: { draft, fromPort: 'e' } }); });
    expect(fixture.dialog?.open).toBe(true);
    expect(() => fixture.canvas!.onRequestCreate!({ world: { x: 3, y: 4 } })).toThrow('Finish or close the current new-task window first.');
    await act(async () => { await fixture.dialog!.onDelegate({ task: 'continue', runtime: 'pi', isolate: false, source: {}, advanced: {} }); });
    expect(api.mockOf('sessions.delegate')).toHaveBeenCalledWith(expect.objectContaining({ handoverDraftId: 'draft', task: 'continue' }));
    expect(screen.getByTestId('bubble').textContent).toBe('The handover is queued, but its canvas position could not be saved. Open the session from the list after it is created.');
  } finally { act(() => { applyLocaleSetting('zh-CN'); setFreeViewMode('status'); }); }
});
