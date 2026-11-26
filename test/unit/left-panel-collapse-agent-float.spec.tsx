/**
 * ⑤ 点击左侧栏会话/工具入口自动收起调度浮动面板（2026-10-07 报单⑤）。
 * 断言：会话行点击与实用工具入口（含导航树节点）打开都会置空 chatWorkspaceId
 * （与手动收起同语义，非销毁）；再点同一工具关闭面板不额外触发。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createApiMock } from './helpers/api-mock';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';
import type { ExtensionNavigationNode } from '../../src/shared/extensionNavigation';

const state = vi.hoisted(() => ({
  sessions: [] as SessionMeta[],
  activeId: null as string | null,
  workspaces: [] as WorkspaceInfo[],
  workspaceId: 'ws',
  navigation: [] as ExtensionNavigationNode[],
  libraryExpanded: false,
  setChatWorkspaceId: vi.fn()
}));
vi.mock('../../src/renderer/src/store', () => ({
  useSessionStore: () => ({ visibleSessions: state.sessions, activeId: state.activeId, displayActiveId: state.activeId }),
  useRuntimesStore: () => ({ runtimes: [] }),
  useWorkspaceStore: () => ({ workspaces: state.workspaces, activeWorkspaceId: state.workspaceId }),
  useChatStore: () => ({ setChatWorkspaceId: state.setChatWorkspaceId }),
  useUiStore: () => ({ flashTip: vi.fn() })
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
  useExtensionWorkbenchNavigation: () => ({ nodes: state.navigation, libraryExpanded: state.libraryExpanded }),
  saveExtensionNavigation: vi.fn().mockResolvedValue(undefined)
}));
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';

beforeEach(() => {
  localStorage.clear();
  state.setChatWorkspaceId.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  state.activeId = 's-1';
  state.workspaceId = 'ws';
  state.navigation = [];
  state.libraryExpanded = false;
  state.workspaces = [{ id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, defaultRootId: 'a', controlRoot: 'E:/A', rootsRevision: 0, roots: [] }];
  state.sessions = [{
    id: 's-1', type: 'terminal', launchKind: 'agent', runtime: 'pi', name: '会话一',
    createdAt: 1, lastUsedAt: 1, status: 'idle', lifecycle: 'idle', workspaceId: 'ws'
  }];
  window.api = createApiMock().api;
});

function mount(onSelectUtilityPanel = vi.fn()) {
  return render(
    <LeftPanel
      utilityPanel={null}
      onSelectUtilityPanel={onSelectUtilityPanel}
      onCloseUtilityPanel={vi.fn()}
    />
  );
}

it.each(['实用工具', '工作会话', '终端'])('%s 只由独立箭头按钮折叠，点击标题文字不切换', async label => {
  const view = mount();
  await waitFor(() => expect(screen.getByText('会话一')).toBeTruthy());
  const title = screen.getByText(label, { selector: 'span' });
  const header = title.closest('.utility-navigation-title, .panel-header.sub')!;
  const toggle = header.matches('.panel-header-toggle') ? header : header.querySelector('.panel-header-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(title);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(title);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(view.container.contains(toggle)).toBe(true);
});

it('点击会话行 → 置空 chatWorkspaceId（收起调度浮窗，同手动收起语义）', async () => {
  mount();
  const row = await waitFor(() => {
    const el = screen.getByText('会话一').closest('.session-item') as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  });
  fireEvent.click(row);
  expect(state.setChatWorkspaceId).toHaveBeenCalledWith(null);
});

it('点击实用工具入口打开面板 → 同样收起；再点关闭不重复触发', async () => {
  const view = mount();
  await waitFor(() => expect(screen.getByText('会话一')).toBeTruthy());
  // 实用工具族入口（任务/用量/记忆/扩展管理…）在导航区，任选一项点击打开
  const feature = await waitFor(() => {
    const el = view.container.querySelector('.utility-feature-item') as HTMLButtonElement;
    expect(el).toBeTruthy();
    return el;
  });
  state.setChatWorkspaceId.mockClear();
  fireEvent.click(feature);
  expect(state.setChatWorkspaceId).toHaveBeenCalledWith(null);
});

it.each([3, 4])('展开每行有 %i 个入口时，收起只保留第一行并维持按钮身份', columns => {
  state.navigation = [{ id: 'favorite', kind: 'extension', parentId: null, title: '示例工具',
    extensionId: 'demo', viewId: 'main', favorite: true }];
  state.libraryExpanded = true;
  const gridOffsets = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    const parent = this.parentElement;
    return parent?.classList.contains('utility-feature-list')
      ? 4 + Math.floor([...parent.children].indexOf(this) / columns) * 62 : 0;
  });
  try {
    const onSelect = vi.fn();
    render(<LeftPanel utilityPanel="nav:favorite" onSelectUtilityPanel={onSelect} onCloseUtilityPanel={vi.fn()} />);
    const shortcuts = within(screen.getByRole('group', { name: '常用工具' }));
    const entries = ['定时任务', '使用统计', '记忆整理', '扩展管理', '示例工具'];
    const tiles = entries.map(label => shortcuts.getByText(label).closest('button')!);
    expect(screen.getByRole('treeitem', { name: '示例工具' })).toBeTruthy();
    expect(tiles[4].getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '折叠实用工具' }));
    expect(screen.queryByRole('treeitem', { name: '示例工具' })).toBeNull();
    const visibleTiles = tiles.filter(tile => !tile.closest('[inert], [aria-hidden="true"]'));
    expect(visibleTiles).toEqual(tiles.slice(0, columns));
    expect(shortcuts.queryByRole('button', { name: '展开更多工具' })).toBeNull();
    visibleTiles.forEach(tile => fireEvent.click(tile));
    expect(onSelect.mock.calls.map(([id]) => id)).toEqual(['tasks', 'usage', 'memory', 'ext-manager'].slice(0, columns));

    fireEvent.click(screen.getByRole('button', { name: '展开实用工具' }));
    expect(screen.getByRole('treeitem', { name: '示例工具' })).toBeTruthy();
    expect(shortcuts.getByRole('button', { name: '收起更多工具' })).toBeTruthy();
    expect(entries.map(label => shortcuts.getByText(label).closest('button'))).toEqual(tiles);
  } finally {
    gridOffsets.mockRestore();
  }
});

it('实际会话和终端分组折叠后保留当前项', async () => {
  state.sessions.push(
    { ...state.sessions[0], id: 's-2', name: '会话二', createdAt: 2 },
    { ...state.sessions[0], id: 'shell-1', name: '终端一', launchKind: 'shell' },
    { ...state.sessions[0], id: 'shell-2', name: '终端二', launchKind: 'shell' }
  );
  const view = mount();
  await waitFor(() => expect(screen.getByText('会话二')).toBeTruthy());
  expect(view.container.querySelectorAll('.left-section-scroll .rail-stack').length).toBe(2);
  for (const label of ['工作会话', '终端']) {
    fireEvent.click(screen.getByRole('button', { name: `折叠${label}` }));
  }
  expect(view.container.querySelectorAll('.left-section-scroll .rail-stack.is-collapsed').length).toBe(2);
  const previews = [...view.container.querySelectorAll('.left-section-scroll .rail-stack .is-preview')];
  expect(previews.length).toBe(2);
  expect(previews.some(el => el.textContent?.includes('会话一'))).toBe(true);
  expect(previews.some(el => el.textContent?.includes('终端一'))).toBe(true);
});

it('LeftPanel 切工作区恢复各自三组开合，重挂载也不丢失', async () => {
  const view = mount();
  await waitFor(() => expect(screen.getByText('会话一')).toBeTruthy());
  for (const label of ['工作会话', '终端', '实用工具']) fireEvent.click(screen.getByRole('button', { name: `折叠${label}` }));
  state.workspaceId = 'other';
  view.rerender(<LeftPanel utilityPanel={null} onSelectUtilityPanel={vi.fn()} onCloseUtilityPanel={vi.fn()} />);
  for (const label of ['工作会话', '终端', '实用工具']) expect(screen.getByRole('button', { name: `折叠${label}` }).getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '折叠终端' }));
  state.workspaceId = 'ws';
  view.rerender(<LeftPanel utilityPanel={null} onSelectUtilityPanel={vi.fn()} onCloseUtilityPanel={vi.fn()} />);
  for (const label of ['工作会话', '终端', '实用工具']) expect(screen.getByRole('button', { name: `展开${label}` }).getAttribute('aria-expanded')).toBe('false');
  view.unmount();
  mount();
  await waitFor(() => expect(screen.getByText('会话一')).toBeTruthy());
  expect(screen.getByRole('button', { name: '展开工作会话' }).getAttribute('aria-expanded')).toBe('false');
});
