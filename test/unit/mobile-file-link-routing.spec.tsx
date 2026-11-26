import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { MobileApp } from '../../src/renderer/src/mobile/MobileApp';

const state = vi.hoisted(() => ({ request: null as any, activeId: 'first', gateway: { connected: true, note: '' },
  workspaces: [{ id: 'first', name: 'First', path: 'E:/First', openedAt: 0 }, { id: 'second', name: 'Second', path: 'D:/Second', openedAt: 0 }] }));
vi.mock('../../src/renderer/src/store', () => ({
  useUiStore: () => ({ confirms: [], dialogs: [], respondDialog: vi.fn(), openWorkspaceFile: state.request, clearOpenWorkspaceFile: () => { state.request = null; } }),
  useWorkspaceStore: () => ({ workspaces: state.workspaces, activeWorkspaceId: state.activeId, switchWorkspace: vi.fn() }),
  useSessionStore: () => ({ sessions: [] }), useChatStore: () => ({ bubblesByWs: {} })
}));
vi.mock('../../src/renderer/src/webApiShim', () => ({ getWebGatewayStatus: () => state.gateway,
  subscribeWebGatewayStatus: () => () => {}, isWebGateway: () => false, setWebGatewayOverlaySuppressed: vi.fn() }));
vi.mock('../../src/renderer/src/mobile/useSessionStatusPush', () => ({ useSessionStatusPush: () => {} }));
vi.mock('../../src/renderer/src/mobile/useHashDeepLink', () => ({ useHashDeepLink: () => {} }));
vi.mock('../../src/renderer/src/mobile/pages/WorkspaceListPage', () => ({ WorkspaceListPage: () => null }));
vi.mock('../../src/renderer/src/mobile/pages/WorkspaceDetailPage', () => ({ WorkspaceDetailPage: () => null }));
vi.mock('../../src/renderer/src/mobile/pages/ChatPage', () => ({ ChatPage: () => null }));
vi.mock('../../src/renderer/src/mobile/MobileFiles', () => ({ MobileFiles: (props: any) => props.open
  ? <output data-testid="file-request">{JSON.stringify({ wsId: props.wsId, workspace: props.workspace?.id, target: props.target })}</output> : null }));

beforeEach(() => { localStorage.clear(); state.activeId = 'first'; });
describe('手机壳消费 FileRef 的工作区归属', () => {
  it('显式 FileRef 优先于活动工作区，完整传给抽屉', async () => {
    const fileRef = { workspaceId: 'second', rootId: 'b', relativePath: 'same.txt' };
    state.request = { path: 'same.txt', fileRef, line: 2, nonce: 1 };
    render(<MobileApp />);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('file-request').textContent!)).toEqual({ wsId: 'second', workspace: 'second',
      target: { path: 'same.txt', fileRef, line: 2 } }));
  });
  it('显式未知工作区不能回落到活动区', async () => {
    const fileRef = { workspaceId: 'removed', rootId: 'b', relativePath: 'same.txt' };
    state.request = { path: 'same.txt', fileRef, nonce: 1 };
    render(<MobileApp />);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('file-request').textContent!)).toEqual({ wsId: 'removed', target: { path: 'same.txt', fileRef } }));
  });
  it('无 FileRef 的旧请求只使用活动区，没有活动区时不猜第一项', async () => {
    state.request = { path: 'same.txt', nonce: 1 };
    const view = render(<MobileApp />);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('file-request').textContent!)).toEqual({ wsId: 'first', workspace: 'first', target: { path: 'same.txt' } }));
    view.unmount(); state.activeId = ''; state.request = { path: 'same.txt', nonce: 2 };
    render(<MobileApp />);
    expect(screen.queryByTestId('file-request')).toBeNull();
  });
});
