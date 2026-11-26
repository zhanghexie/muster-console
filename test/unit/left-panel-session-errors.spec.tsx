/**
 * X4-F02：左栏会话操作族（重命名/重启 等）IPC 失败必须上浮（flashTip），不得零反馈。
 * BoardPanel reportError 范式对齐：err.message 直接进 flashTip。
 * 红绿：LeftPanel 报告行 769/1317（rename/respawn 裸 void）——stash src 改动后本用例红。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createApiMock } from './helpers/api-mock';
import type { AgentRuntimeEntry, SessionMeta, WorkspaceInfo } from '../../src/shared/types';

const state = vi.hoisted(() => ({
  sessions: [] as SessionMeta[],
  activeId: null as string | null,
  workspaces: [] as WorkspaceInfo[],
  runtimes: [] as AgentRuntimeEntry[],
  workspaceId: 'ws',
  flashTip: vi.fn()
}));
vi.mock('../../src/renderer/src/store', () => ({
  useSessionStore: () => ({ visibleSessions: state.sessions, activeId: state.activeId, displayActiveId: state.activeId }),
  useRuntimesStore: () => ({ runtimes: state.runtimes }),
  useWorkspaceStore: () => ({ workspaces: state.workspaces, activeWorkspaceId: state.workspaceId }),
  useChatStore: () => ({ setChatWorkspaceId: vi.fn() }),
  useUiStore: () => ({ flashTip: state.flashTip })
}));
vi.mock('../../src/renderer/src/panelHistory', () => ({
  useHistoryWsId: () => 'ws',
  usePanelHistory: () => ({ leftBackDepth: () => 0, leftForwardDepth: () => 0 })
}));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({
  useKeybinding: () => {},
  useChordLabel: () => '',
  useOverlayDismiss: () => {},
  KeyChordHint: () => null
}));
vi.mock('../../src/renderer/src/sessionJump', () => ({ jumpToSession: vi.fn() }));
vi.mock('../../src/renderer/src/centerSplitStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/renderer/src/centerSplitStore')>(),
  centerSplitTryFill: () => false,
  centerSplitIncoming: () => null
}));
vi.mock('../../src/renderer/src/extensionWorkbench', () => ({
  useExtensionWorkbenchNavigation: () => ({ identity: null, nodes: [], error: null, saving: false }),
  saveExtensionNavigation: vi.fn()
}));
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';

let mock: ReturnType<typeof createApiMock>;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  state.flashTip.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  state.activeId = 's-1';
  state.workspaceId = 'ws';
  state.runtimes = [];
  state.workspaces = [{ id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, defaultRootId: 'a', controlRoot: 'E:/A', rootsRevision: 0, roots: [] }];
  state.sessions = [{
    id: 's-1', type: 'terminal', launchKind: 'agent', runtime: 'pi', name: '会话一',
    createdAt: 1, lastUsedAt: 1, status: 'idle', lifecycle: 'idle', workspaceId: 'ws'
  }];
  mock = createApiMock();
  window.api = mock.api;
});

async function mount() {
  const view = render(
    <LeftPanel
      utilityPanel={null}
      onSelectUtilityPanel={vi.fn()}
      onCloseUtilityPanel={vi.fn()}
    />
  );
  await waitFor(() => expect(screen.getByText('会话一')).toBeTruthy());
  return view;
}

async function openContextMenu(): Promise<void> {
  const item = (await screen.findByText('会话一')).closest('.session-item') as HTMLElement;
  fireEvent.contextMenu(item, { clientX: 40, clientY: 40 });
  await waitFor(() => expect(document.querySelector('.ctx-menu')).toBeTruthy());
}

it('会话右键和角标不再依赖旧飞书桥', async () => {
  await mount();
  await openContextMenu();
  expect(screen.queryByRole('menuitem', { name: '绑定到飞书' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: '解除飞书绑定' })).toBeNull();
  expect(document.getElementById('ctx-item-feishu-bind')).toBeNull();
  expect(document.getElementById('ctx-item-feishu-unbind')).toBeNull();
  expect(document.getElementById('ctx-item-rename')).not.toBeNull();
  expect(document.querySelector('.session-feishu-mark')).toBeNull();
  expect(mock.mockOf('feishu.get')).not.toHaveBeenCalled();
});

it('重命名失败：右键改名单回车后 sessions.rename reject → flashTip 上浮错误信息', async () => {
  mock.override('sessions.rename', () => Promise.reject(new Error('runtime 不可用')));
  await mount();
  await openContextMenu();
  fireEvent.click(document.getElementById('ctx-item-rename')!);
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: '新名字' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(mock.mockOf('sessions.rename')).toHaveBeenCalledWith('s-1', '新名字'));
  await waitFor(() => expect(state.flashTip).toHaveBeenCalledWith('runtime 不可用'));
});

it('重启失败：右键菜单 sessions.respawn reject → flashTip 上浮错误信息', async () => {
  mock.override('sessions.respawn', () => Promise.reject(new Error('重启失败测试')));
  await mount();
  await openContextMenu();
  fireEvent.click(document.getElementById('ctx-item-respawn')!);
  await waitFor(() => expect(mock.mockOf('sessions.respawn')).toHaveBeenCalledWith('s-1'));
  await waitFor(() => expect(state.flashTip).toHaveBeenCalledWith('重启失败测试'));
});

it('Qwen 恢复失败时单独提供开启新对话，只有显式点击才发起新启动', async () => {
  state.sessions[0] = { ...state.sessions[0], runtime: 'qwen-cli', externalSessionId: 'saved-id' };
  state.runtimes = [{ id: 'qwen-cli', label: 'Qwen Code CLI', script: 'qwen-cli.mjs', builtin: true,
    enabled: true, surface: 'pty', terminalResume: 'by-id', updatedAt: 0 }];
  mock.override('sessions.respawn', (_id, intent) => intent === 'new'
    ? Promise.resolve() : Promise.reject(new Error('找不到原对话的历史记录')));
  await mount();
  await openContextMenu();
  fireEvent.click(screen.getByText('恢复原对话'));
  await waitFor(() => expect(state.flashTip).toHaveBeenCalledWith('找不到原对话的历史记录'));
  expect(mock.mockOf('sessions.respawn').mock.calls).toEqual([['s-1']]);
  await openContextMenu();
  fireEvent.click(screen.getByText('开启新对话'));
  await waitFor(() => expect(mock.mockOf('sessions.respawn').mock.calls).toEqual([['s-1'], ['s-1', 'new']]));
});

it('动态终端即使带有旧占位 ID 也只显示开启新对话', async () => {
  state.sessions[0] = { ...state.sessions[0], runtime: 'registered-cli', externalSessionId: 'legacy-placeholder' };
  state.runtimes = [{ id: 'registered-cli', label: 'Registered CLI', script: '', builtin: false, enabled: true, surface: 'pty', updatedAt: 0 }];
  mock.override('sessions.respawn', () => Promise.resolve());
  await mount();
  await openContextMenu();
  expect(screen.queryByText('恢复原对话')).toBeNull();
  fireEvent.click(screen.getByText('开启新对话'));
  await waitFor(() => expect(mock.mockOf('sessions.respawn')).toHaveBeenCalledWith('s-1', 'new'));
});

it('清理 worktree 返回失败时展示具体原因', async () => {
  state.sessions[0] = { ...state.sessions[0], worktreePath: 'E:/tree', worktreeBranch: 'ao/task', meta: { orphanWorktree: 'locked' } };
  mock.override('sessions.discardWorktree', () => Promise.resolve({ ok: false, message: '仓库身份无法确认' }));
  await mount();
  await openContextMenu();
  fireEvent.click(document.getElementById('ctx-item-discard-worktree')!);
  fireEvent.click(await screen.findByRole('button', { name: '放弃并清理' }));
  expect(await screen.findByText('仓库身份无法确认')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '知道了' }));
});
