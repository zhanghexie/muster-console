import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { currentApiMock } from './helpers/api-mock';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { SideToolsPanel } from '../../src/renderer/src/panels/SideToolsPanel';
import { TurnChangesCard } from '../../src/renderer/src/chatSurface/TurnChangesCard';
import { openTurnReview } from '../../src/renderer/src/chatSurface/turnReviewNavigation';
import type { TurnChanges } from '../../src/shared/turnChanges';

vi.mock('../../src/renderer/src/panels/FilesPanel', () => ({ FilesPanel: React.forwardRef(() => null) }));
vi.mock('../../src/renderer/src/panels/GitPanel', () => ({ GitPanel: () => null }));
vi.mock('../../src/renderer/src/components/BrowserPage', () => ({ BrowserPage: () => null }));
vi.mock('../../src/renderer/src/panels/FileDiffView', () => ({ FileDiffView: ({ diffText }: { diffText: string }) => <pre>{diffText}</pre> }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useKeybinding() {}, useOverlayDismiss() {}, useChordLabel: () => '' }));
const summary: TurnChanges = { id: 'snapshot', state: 'ready', warnings: [], files: [{ path: 'a.ts', kind: 'modified', added: 1, removed: 1, revertible: true }] };
const target = { kind: 'gui' as const, id: 's', messageId: 'm' };
function DockRequest() { const ui = useUiStore(); return <output data-testid="dock-request">{ui.sideDockRequest?.dock}</output>; }
beforeEach(() => {
  const api = currentApiMock();
  const workspace = { id: 'ws-a', path: 'E:/workspace', name: 'Project', rootsRevision: 0, roots: [{ id: 'root', path: 'E:/workspace' }], defaultRootId: 'root' };
  api.mockOf('workspaces.list').mockResolvedValue({ workspaces: [workspace], activeWorkspaceId: 'ws-a' });
  api.mockOf('sessions.list').mockResolvedValue({ sessions: [{ id: 's', workspaceId: 'ws-a', name: 'Chat' }], activeId: 's' });
  api.mockOf('config.get').mockResolvedValue({ workspaces: [workspace], activeWorkspaceId: 'ws-a' });
  api.mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries: [{ target, summary, label: '本轮输入', createdAt: 1 }] });
  api.mockOf('turnChanges.diff').mockResolvedValue({ ok: true, diff: 'review snapshot' });
});
it('a chat file opens the actual right workspace review and requests the hidden dock', async () => {
  render(<StoreProvider><PanelHistoryProvider><TurnChangesCard target={target} summary={summary}/><SideToolsPanel active gitEverActive/><DockRequest/></PanelHistoryProvider></StoreProvider>);
  await waitFor(() => expect(currentApiMock().mockOf('sessions.list')).toHaveBeenCalled());
  // Wait for StoreProvider hydration before a genuine click (not a synthetic store request).
  await waitFor(() => expect(document.querySelector('.right-workspace')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /a.ts/ }));
  const review = await screen.findByRole('region', { name: '轮次审阅' });
  await within(review).findByText('review snapshot');
  expect(screen.getByTestId('dock-request').textContent).toBe('git');
  expect(within(screen.getByRole('tablist', { name: '内容标签页' })).getAllByRole('tab')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '审阅改动' }));
  expect(within(screen.getByRole('tablist', { name: '内容标签页' })).getAllByRole('tab')).toHaveLength(1);
});
it('rejects requests for another workspace instead of placing them in this chat', async () => {
  render(<StoreProvider><DockRequest/></StoreProvider>);
  await waitFor(() => expect(currentApiMock().mockOf('sessions.list')).toHaveBeenCalled());
  openTurnReview({ kind: 'dispatch', id: 'other-workspace', messageId: 'm' });
  expect(screen.getByTestId('dock-request').textContent).toBe('');
});
