import React from 'react';
import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { currentApiMock } from './helpers/api-mock';
import { StoreProvider, useSessionStore } from '../../src/renderer/src/store';
import { MobileApp } from '../../src/renderer/src/mobile/MobileApp';
import { TurnChangesCard } from '../../src/renderer/src/chatSurface/TurnChangesCard';
import type { TurnChanges } from '../../src/shared/turnChanges';

const gateway = vi.hoisted(() => ({ connected: true, note: '' }));
vi.mock('../../src/renderer/src/webApiShim', () => ({ getWebGatewayStatus: () => gateway,
  subscribeWebGatewayStatus: () => () => {}, isWebGateway: () => false, setWebGatewayOverlaySuppressed: vi.fn() }));
vi.mock('../../src/renderer/src/mobile/pages/WorkspaceListPage', () => ({ WorkspaceListPage: () => null }));
vi.mock('../../src/renderer/src/mobile/pages/WorkspaceDetailPage', () => ({ WorkspaceDetailPage: () => null }));
vi.mock('../../src/renderer/src/mobile/pages/ChatPage', () => ({ ChatPage: () => null }));
vi.mock('../../src/renderer/src/mobile/MobileFiles', () => ({ MobileFiles: () => null }));
vi.mock('../../src/renderer/src/mobile/useSessionStatusPush', () => ({ useSessionStatusPush() {} }));
vi.mock('../../src/renderer/src/mobile/useHashDeepLink', () => ({ useHashDeepLink() {} }));
vi.mock('../../src/renderer/src/panels/FileDiffView', () => ({ FileDiffView: ({ diffText }: { diffText: string }) => <pre>{diffText}</pre> }));

const target = { kind: 'gui' as const, id: 's', messageId: 'm' };
const summary: TurnChanges = { id: 'snapshot', state: 'ready', warnings: [], files: ['a.ts', 'b.ts'].map(path => ({ path, kind: 'modified', added: 1, removed: 1, revertible: true })) };
function Ready() { return <output data-testid="ready">{useSessionStore().activeId}</output>; }
beforeEach(() => {
  localStorage.clear();
  const api = currentApiMock(), workspace = { id: 'ws', path: 'E:/workspace', name: 'Project' };
  api.mockOf('workspaces.list').mockResolvedValue({ workspaces: [workspace], activeWorkspaceId: 'ws' });
  api.mockOf('sessions.list').mockResolvedValue({ sessions: [{ id: 's', workspaceId: 'ws', name: 'Chat' }], activeId: 's' });
  api.mockOf('config.get').mockResolvedValue({ workspaces: [workspace], activeWorkspaceId: 'ws' });
  api.mockOf('turnChanges.list').mockResolvedValue({ ok: true, entries: [{ target, summary, label: '本轮输入', createdAt: 1 }] });
  api.mockOf('turnChanges.diff').mockImplementation(async (_target, file) => ({ ok: true, diff: `snapshot ${file}` }));
});

it('a mobile file tap opens a review drawer, switches snapshot files and closes', async () => {
  render(<StoreProvider><MobileApp /><Ready /><TurnChangesCard target={target} summary={summary} /></StoreProvider>);
  await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('s'));
  fireEvent.click(screen.getByRole('button', { name: /a.ts/ }));
  const dialog = await screen.findByRole('dialog', { name: '轮次审阅' });
  await within(dialog).findByText('snapshot a.ts');
  fireEvent.click(within(dialog).getByRole('button', { name: /b.ts/ }));
  await within(dialog).findByText('snapshot b.ts');
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('switching sessions closes the old review instead of showing another chat its snapshot', async () => {
  render(<StoreProvider><MobileApp /><Ready /><TurnChangesCard target={target} summary={summary} /></StoreProvider>);
  await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('s'));
  fireEvent.click(screen.getByRole('button', { name: '审阅改动' }));
  await screen.findByRole('dialog', { name: '轮次审阅' });
  act(() => currentApiMock().emit('sessions:changed', { sessions: [{ id: 'other', workspaceId: 'ws', name: 'Other' }], activeId: 'other' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
