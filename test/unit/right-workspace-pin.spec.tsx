import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';

const shell = (id: string, name: string, workspaceId = 'ws', extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, name, type: 'terminal', launchKind: 'shell', workspaceId, cwd: `E:/ws/${id}`, createdAt: 0, status: 'running', ...extra }) as SessionMeta;
const state = vi.hoisted(() => ({ sessions: [] as unknown[], activeId: 's1', tip: vi.fn(), show: vi.fn() }));
vi.mock('../../src/renderer/src/store', () => ({
  useSessionStore: () => ({ activeId: state.activeId, visibleSessions: [], sessions: state.sessions }),
  useRuntimesStore: () => ({ runtimes: [
    { id: 'pi', label: 'Pi', surface: 'chat' },
    { id: 'qwen-cli', label: 'Qwen Code', surface: 'pty', enabled: true, terminalResume: 'by-id' },
    { id: 'fixture-cli', label: 'Fixture CLI', surface: 'pty', enabled: true }
  ] }),
  useWorkspaceStore: () => ({ activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', name: 'Project', path: 'E:/ws', openedAt: 0, rootsRevision: 0, defaultRootId: 'a', controlRoot: 'E:/ws', roots: [{ id: 'a', path: 'E:/ws' }] } satisfies WorkspaceInfo] }),
  useUiStore: () => ({ flashTip: state.tip, requestShowWorkspace: state.show, openCommandPalette: vi.fn(), openWorkspaceFile: null, clearOpenWorkspaceFile: () => {} })
}));
vi.mock('../../src/renderer/src/hooks/useWorkspaceFile', () => ({ useWorkspaceFile: () => ({ cfg: {}, cfgRef: { current: {} }, workspaceId: 'ws', ready: true, patch: async () => ({ ok: true }) }) }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useKeybinding: () => {}, useChordLabel: () => '', useOverlayDismiss: () => {} }));
vi.mock('../../src/renderer/src/components/BrowserPage', () => ({ BrowserPage: () => null }));
vi.mock('../../src/renderer/src/panels/GitPanel', () => ({ GitPanel: ({ layout, fixedRepoPath }: { layout: string; fixedRepoPath?: string }) => layout === 'resources' ? null : <div>Git {fixedRepoPath}</div> }));
import { SideToolsPanel } from '../../src/renderer/src/panels/SideToolsPanel';
import { DockSurface, RightDockHost, onCenterUtilityRequest, requestRightPin, rightDockSnapshot, rightPinsSnapshot } from '../../src/renderer/src/rightDock';

// SideToolsPanel 是 memo 组件：切换 active 让它重新读取 mock 的会话表
const tree = (active = true) => <PanelHistoryProvider><SideToolsPanel active={active} gitEverActive pageVisible/></PanelHistoryProvider>;
const contentTabs = () => within(screen.getByRole('tablist', { name: '内容标签页' })).queryAllByRole('tab');
const pin = (ref: Parameters<typeof requestRightPin>[0]['ref'], command: 'pin' | 'unpin' | 'reveal' = 'pin') => act(() => requestRightPin({ workspaceId: 'ws', ref, command }));

beforeEach(() => {
  state.sessions = [shell('sh1', 'PowerShell 1'), { ...shell('gui', 'Pi 会话'), launchKind: 'agent', runtime: 'pi' }];
  state.activeId = 's1';
  state.tip.mockClear(); state.show.mockClear();
  const api = currentApiMock();
  api.override('fs.listTreeDirRef', async () => ({ entries: [] }));
  Element.prototype.scrollIntoView = () => {};
});

describe('pin to right panel', () => {
  it('has no terminal resource page; the capsule keeps files, Git and browser', () => {
    render(tree());
    expect(within(screen.getByRole('tablist', { name: '资源面板' })).getAllByRole('tab').map(tab => tab.getAttribute('aria-label'))).toEqual(['文件', 'Git', '浏览器']);
  });

  it('pins a session as a project-wide tab, shows the right page and docks its view; unpin returns it', async () => {
    const view = render(tree());
    pin({ kind: 'session', sessionId: 'gui' });
    await waitFor(() => expect(contentTabs().map(tab => tab.textContent)).toEqual(['Pi 会话']));
    expect(state.show).toHaveBeenCalled();
    expect(rightDockSnapshot().docked.has('session:gui')).toBe(true);
    expect(rightDockSnapshot().shown.has('session:gui')).toBe(true);
    expect(rightPinsSnapshot()).toEqual({ workspaceId: 'ws', keys: new Set(['session:gui']) });
    // 切换中栏会话后仍保留在右侧
    state.activeId = 's2'; view.rerender(tree(false));
    expect(contentTabs().map(tab => tab.textContent)).toEqual(['Pi 会话']);
    pin({ kind: 'session', sessionId: 'gui' }, 'unpin');
    await waitFor(() => expect(contentTabs()).toHaveLength(0));
    expect(rightDockSnapshot().docked.has('session:gui')).toBe(false);
    expect(rightPinsSnapshot().keys.size).toBe(0);
  });

  it('pins a built-in utility; the toolbar moves it back to the center', async () => {
    const center = vi.fn();
    const stop = onCenterUtilityRequest(center);
    render(tree());
    pin({ kind: 'utility', sel: 'tasks' });
    await waitFor(() => expect(contentTabs().map(tab => tab.textContent)).toEqual(['定时任务']));
    expect(rightDockSnapshot().docked.has('utility:tasks')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '移回中栏' }));
    await waitFor(() => expect(contentTabs()).toHaveLength(0));
    expect(center).toHaveBeenCalledWith('tasks');
    stop();
  });

  it('offers exact resume for a bound terminal and explicit start for a launch-only terminal', async () => {
    state.sessions = [
      shell('qwen', 'Qwen 会话', 'ws', { launchKind: 'agent', runtime: 'qwen-cli', status: 'exited', externalSessionId: 'native-id' }),
      shell('fixture', '动态终端', 'ws', { launchKind: 'agent', runtime: 'fixture-cli', status: 'idle' })
    ];
    const api = currentApiMock();
    api.override('sessions.respawn', async () => {});
    render(tree());
    pin({ kind: 'session', sessionId: 'qwen' });
    expect(await screen.findByRole('button', { name: '开启新对话' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复原对话' }));
    expect(api.mockOf('sessions.respawn')).toHaveBeenCalledWith('qwen');
    pin({ kind: 'session', sessionId: 'fixture' });
    await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原对话' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '开启新对话' }));
    expect(api.mockOf('sessions.respawn').mock.calls).toEqual([['qwen'], ['fixture', 'new']]);
  });

  it('drops a pinned session only after it was seen and then removed or archived', async () => {
    state.sessions = [];
    const view = render(tree());
    pin({ kind: 'session', sessionId: 'sh1' });
    // 会话表尚未加载：请求无法解析内容，不创建标签
    expect(contentTabs()).toHaveLength(0);
    state.sessions = [shell('sh1', 'PowerShell 1')]; view.rerender(tree(false));
    pin({ kind: 'session', sessionId: 'sh1' });
    await waitFor(() => expect(contentTabs()).toHaveLength(1));
    state.sessions = [shell('sh1', 'PowerShell 1', 'ws', { archived: true })]; view.rerender(tree(true));
    await waitFor(() => expect(contentTabs()).toHaveLength(0));
  });

  it('tab context menu has no new-tab entry', async () => {
    render(tree());
    pin({ kind: 'utility', sel: 'tasks' });
    await waitFor(() => expect(contentTabs()).toHaveLength(1));
    fireEvent.contextMenu(contentTabs()[0]);
    const labels = within(await screen.findByRole('menu')).getAllByRole('menuitemcheckbox').map(item => item.textContent);
    expect(labels.some(label => label?.includes('新建'))).toBe(false);
  });
});

describe('right dock surface', () => {
  it('moves the same view DOM into the right host and back home', () => {
    const ui = (docked: boolean) => <>
      <div data-testid="center"><DockSurface dockKey="session:x"><div data-testid="view">live</div></DockSurface></div>
      <div data-testid="right">{docked ? <RightDockHost dockKey="session:x" hostKey="t1" shown/> : null}</div>
    </>;
    const view = render(ui(false));
    const node = screen.getByTestId('view');
    expect(screen.getByTestId('center').contains(node)).toBe(true);
    view.rerender(ui(true));
    expect(screen.getByTestId('right').contains(node)).toBe(true);
    expect(screen.getByTestId('view')).toBe(node);
    expect(rightDockSnapshot().shown.has('session:x')).toBe(true);
    view.rerender(ui(false));
    expect(screen.getByTestId('center').contains(node)).toBe(true);
    expect(rightDockSnapshot().docked.has('session:x')).toBe(false);
  });
});
