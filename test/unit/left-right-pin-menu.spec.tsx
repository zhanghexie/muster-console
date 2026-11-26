import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { ExtensionNavigationTree } from '../../src/renderer/src/components/ExtensionNavigationTree';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { __resetCenterSplitForTest } from '../../src/renderer/src/centerSplitStore';
import { onCenterUtilityRequest, onRightPinRequest, publishRightPins, useRightPin, type RightPinRequest } from '../../src/renderer/src/rightDock';
import type { ExtensionNavigationNode } from '../../src/shared/extensionNavigation';
import type { SessionMeta } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

const workspace = { id: 'ws', path: 'E:/demo', name: '演示', openedAt: 1 };
const session: SessionMeta = { id: 'chat', type: 'terminal', launchKind: 'agent', runtime: 'cursor',
  name: '真实会话', workspaceId: 'ws', createdAt: 1, status: 'running', lifecycle: 'idle' } as SessionMeta;
const extension: ExtensionNavigationNode = { id: 'entry', kind: 'extension', parentId: null, title: '扩展入口', extensionId: 'demo', viewId: 'panel' };
let requests: RightPinRequest[];
let stop: () => void;

beforeEach(() => {
  __resetCenterSplitForTest();
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  requests = []; stop = onRightPinRequest(request => requests.push(request));
  const api = currentApiMock();
  api.override('workspaces.list', () => Promise.resolve({ workspaces: [workspace], activeWorkspaceId: 'ws' }));
  api.override('config.get', () => Promise.resolve({ workspaces: [workspace], activeWorkspaceId: 'ws', locale: 'zh-CN' }));
  api.override('sessions.list', () => Promise.resolve({ sessions: [session], activeId: session.id }));
  api.override('workbench.navigation', () => Promise.resolve({ workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 0, revision: 1, nodes: [extension], libraryExpanded: false }));
});
afterEach(() => { stop(); act(() => publishRightPins('', [])); vi.unstubAllGlobals(); });

const left = () => render(<StoreProvider><PanelHistoryProvider><LeftPanel utilityPanel={null} onSelectUtilityPanel={() => {}} onCloseUtilityPanel={() => {}} /></PanelHistoryProvider></StoreProvider>);
// 左栏常驻一个「新建终端」下拉 role=menu，这里直接按菜单项查找
const menuItem = (name: string) => screen.findByRole('menuitemcheckbox', { name });

describe('左栏「固定到右侧」入口', () => {
  it('会话右键菜单固定到右侧；已固定时改为移回中栏并在中栏选中', async () => {
    left();
    fireEvent.contextMenu((await screen.findByText('真实会话')).closest('.session-item')!);
    fireEvent.click(await menuItem('固定到右侧'));
    await waitFor(() => expect(requests).toEqual([{ workspaceId: 'ws', ref: { kind: 'session', sessionId: 'chat' }, command: 'pin' }]));
    act(() => publishRightPins('ws', ['session:chat']));
    fireEvent.contextMenu(screen.getByText('真实会话').closest('.session-item')!);
    fireEvent.click(await menuItem('移回中栏'));
    expect(requests.at(-1)?.command).toBe('unpin');
    await waitFor(() => expect(currentApiMock().mockOf('sessions.select')).toHaveBeenCalledWith('chat'));
  });

  it('实用工具磁贴右键提供固定到右侧与分屏显示；已固定时移回中栏交给中栏选择', async () => {
    const center = vi.fn();
    const off = onCenterUtilityRequest(center);
    const view = left();
    await screen.findByText('真实会话');
    const tile = view.container.querySelector<HTMLElement>('.utility-feature-item')!;
    fireEvent.contextMenu(tile);
    const menu = within((await menuItem('固定到右侧')).closest<HTMLElement>('[role="menu"]')!);
    expect(menu.getAllByRole('menuitemcheckbox').map(item => item.textContent?.replace('›', ''))).toEqual(['固定到右侧', '分屏显示']);
    fireEvent.click(menu.getByRole('menuitemcheckbox', { name: '固定到右侧' }));
    expect(requests).toEqual([{ workspaceId: 'ws', ref: { kind: 'utility', sel: 'tasks' }, command: 'pin' }]);
    act(() => publishRightPins('ws', ['utility:tasks']));
    fireEvent.keyDown(tile, { key: 'F10', shiftKey: true });
    fireEvent.click(await menuItem('移回中栏'));
    expect(requests.at(-1)?.command).toBe('unpin');
    expect(center).toHaveBeenCalledWith('tasks');
    off();
  });

  it('扩展导航树只给非文件夹入口提供固定项，状态与切换由宿主提供', async () => {
    const toggle = vi.fn();
    const nodes: ExtensionNavigationNode[] = [extension, { id: 'folder', kind: 'folder', parentId: null, title: '文件夹', expanded: false }];
    render(<ExtensionNavigationTree nodes={nodes} selectedId={null} onSelect={() => {}} onChange={() => {}}
      rightPin={{ canPin: ref => ref.kind === 'utility' && ref.sel === 'nav:entry', isPinned: () => true }} onToggleRightPin={toggle} />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '文件夹' }));
    expect(within(await screen.findByRole('menu')).queryByRole('menuitem', { name: '移回中栏' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: '扩展入口' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '移回中栏' }));
    expect(toggle).toHaveBeenCalledWith({ kind: 'utility', sel: 'nav:entry' });
  });

  it('扩展入口固定沿用 navigation placement，需要 moveBefore 保活 iframe', async () => {
    const save = vi.fn(async (snapshot: { nodes: ExtensionNavigationNode[] }) => ({ ...snapshot, workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 0, revision: 2, libraryExpanded: false }));
    currentApiMock().override('workbench.saveNavigation', save);
    const { result } = renderHook(() => useRightPin(), { wrapper: ({ children }) => <StoreProvider>{children}</StoreProvider> });
    const ref = { kind: 'utility' as const, sel: 'nav:entry' };
    await waitFor(() => expect(result.current.canPin(ref)).toBe(true));
    expect(result.current.canPin({ kind: 'utility', sel: 'ext:demo' })).toBe(false);
    act(() => result.current.pin(ref));
    expect(save).not.toHaveBeenCalled();
    Object.defineProperty(document.body, 'moveBefore', { configurable: true, value: () => {} });
    try {
      act(() => result.current.pin(ref));
      await waitFor(() => expect(save).toHaveBeenCalled());
      expect(save.mock.calls[0][0].nodes[0].placement).toBe('tab');
      expect(requests.at(-1)).toEqual({ workspaceId: 'ws', ref, command: 'reveal' });
      await waitFor(() => expect(result.current.isPinned(ref)).toBe(true));
    } finally { Reflect.deleteProperty(document.body, 'moveBefore'); }
  });
});
