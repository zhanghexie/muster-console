import React from 'react';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionNavigationTree } from '../../src/renderer/src/components/ExtensionNavigationTree';
import { UtilityNavigationSection } from '../../src/renderer/src/components/UtilityNavigationSection';
import { LeftPanel, type UtilitySelection } from '../../src/renderer/src/panels/LeftPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import {
  __resetCenterSplitForTest, attachCenterSplitBridge, centerSplitClosePane,
  centerSplitCommitSnapLayout, centerSplitDissolve,
  centerSplitIncoming, centerSplitSelectInPane, centerSplitSetFocused,
  centerSplitTryFill, getCenterSplitState
} from '../../src/renderer/src/centerSplitStore';
import {
  SPLIT_DRAG_MIME, decodeSplitDragPayload, deriveCenterSplitSnapLayout,
  getCenterSplitPaneRefs, type CenterPaneSlot, type SplitPaneRef
} from '../../src/shared/centerSplit';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import type { ExtensionNavigationNode } from '../../src/shared/extensionNavigation';
import type { SessionMeta } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

function transfer(): DataTransfer {
  const entries = new Map<string, string>();
  return {
    effectAllowed: 'uninitialized', dropEffect: 'none',
    setData: (type: string, value: string) => { entries.set(type, value); },
    getData: (type: string) => entries.get(type) ?? '',
    get types() { return [...entries.keys()]; }
  } as unknown as DataTransfer;
}

beforeEach(() => {
  __resetCenterSplitForTest();
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('实际分屏拖拽来源的原生操作语义', () => {
  it('会话行与工具保持 copy，导航入口保持 move 并携带双目标负载', async () => {
    const workspace = { id: 'ws-a', path: 'E:/demo', name: '演示', openedAt: 1 };
    const session: SessionMeta = { id: 'chat', type: 'terminal', launchKind: 'agent', runtime: 'cursor',
      name: '真实会话', workspaceId: workspace.id, createdAt: 1, status: 'running', lifecycle: 'idle' };
    const api = currentApiMock();
    api.override('workspaces.list', () => Promise.resolve({ workspaces: [workspace], activeWorkspaceId: workspace.id }));
    api.override('config.get', () => Promise.resolve({ workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' }));
    api.override('sessions.list', () => Promise.resolve({ sessions: [session], activeId: session.id }));
    const noop = (): void => {};
    const view = render(<StoreProvider><PanelHistoryProvider><LeftPanel utilityPanel={null}
      onSelectUtilityPanel={noop} onCloseUtilityPanel={noop} />
    </PanelHistoryProvider></StoreProvider>);
    const row = (await screen.findByText('真实会话')).closest('.session-item')!;
    const sessionTransfer = transfer();
    fireEvent.dragStart(row, { dataTransfer: sessionTransfer });
    expect(sessionTransfer.effectAllowed).toBe('copy');
    expect(decodeSplitDragPayload(sessionTransfer.getData(SPLIT_DRAG_MIME))).toEqual({ kind: 'session', sessionId: 'chat' });
    const utility = view.container.querySelector('.utility-feature-item')!;
    const utilityTransfer = transfer();
    fireEvent.dragStart(utility, { dataTransfer: utilityTransfer });
    expect(utilityTransfer.effectAllowed).toBe('copy');
    expect(decodeSplitDragPayload(utilityTransfer.getData(SPLIT_DRAG_MIME))?.kind).toBe('utility');
    view.unmount();

    const nodes: ExtensionNavigationNode[] = [{ id: 'entry', kind: 'extension', parentId: null,
      title: '扩展入口', extensionId: 'demo', viewId: 'panel' }];
    render(<ExtensionNavigationTree nodes={nodes} selectedId={null} onSelect={noop} onChange={noop} />);
    const navigationTransfer = transfer();
    fireEvent.dragStart(screen.getByRole('treeitem', { name: '扩展入口' }), { dataTransfer: navigationTransfer });
    expect(navigationTransfer.effectAllowed).toBe('move');
    expect(navigationTransfer.getData('application/x-muster-navigation')).toBe('entry');
    expect(decodeSplitDragPayload(navigationTransfer.getData(SPLIT_DRAG_MIME))).toEqual({ kind: 'utility', sel: 'nav:entry' });
  });

  it('文件夹只携带目录移动负载，最外层落点明确协商 move', () => {
    const nodes: ExtensionNavigationNode[] = [{ id: 'folder', kind: 'folder', parentId: null, title: '文件夹', expanded: false }];
    render(<ExtensionNavigationTree nodes={nodes} selectedId={null} onSelect={() => {}} onChange={() => {}} />);
    const dt = transfer();
    fireEvent.dragStart(screen.getByRole('treeitem', { name: '文件夹' }), { dataTransfer: dt });
    expect(dt.effectAllowed).toBe('move');
    expect(dt.getData(SPLIT_DRAG_MIME)).toBe('');
    const over = createEvent.dragOver(screen.getByText('移到最外层'), { dataTransfer: dt });
    fireEvent(screen.getByText('移到最外层'), over);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('move');
  });
});

describe('侧栏同步中央工作面的打开与聚焦状态', () => {
  const sessionRef: SplitPaneRef = { kind: 'session', sessionId: 'shown-chat' };
  const taskRef: SplitPaneRef = { kind: 'utility', sel: 'tasks' };
  const navigationRef: SplitPaneRef = { kind: 'utility', sel: 'nav:shown-entry' };

  function expectPaneState(element: Element, opened: boolean, focused: boolean): void {
    expect(element.getAttribute('data-pane-open') === 'true').toBe(opened);
    expect(element.classList.contains('is-pane-open')).toBe(opened);
    expect(element.getAttribute('data-pane-focused') === 'true').toBe(focused);
    expect(element.classList.contains('is-pane-focused')).toBe(focused);
  }

  async function mountMixedRail(singleTool = false) {
    // Use a distinct workspace so the production navigation cache cannot inherit
    // entries from another LeftPanel test in this file.
    const workspace = { id: singleTool ? 'ws-sidebar-tool' : 'ws-sidebar-split', path: 'E:/sidebar', name: '侧栏状态', openedAt: 1 };
    const sessions: SessionMeta[] = [
      { id: 'shown-chat', type: 'terminal', launchKind: 'agent', runtime: 'cursor', name: '已打开会话',
        workspaceId: workspace.id, createdAt: 1, status: 'running', lifecycle: 'idle' },
      { id: 'hidden-shell', type: 'terminal', launchKind: 'shell', runtime: 'powershell', name: '未打开终端',
        workspaceId: workspace.id, createdAt: 2, status: 'running', lifecycle: 'idle' }
    ];
    const nodes: ExtensionNavigationNode[] = [
      { id: 'shown-entry', kind: 'extension', parentId: null, title: '已打开导航',
        extensionId: 'demo', viewId: 'panel', favorite: true },
      { id: 'hidden-entry', kind: 'extension', parentId: null, title: '未打开导航',
        extensionId: 'demo', viewId: 'other', favorite: true }
    ];
    const api = currentApiMock();
    api.override('workspaces.list', () => Promise.resolve({ workspaces: [workspace], activeWorkspaceId: workspace.id }));
    api.override('config.get', () => Promise.resolve({ workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' }));
    api.override('sessions.list', () => Promise.resolve({ sessions, activeId: 'shown-chat' }));
    api.override('workbench.navigation', () => Promise.resolve({ workspaceId: workspace.id, sourceRootId: 'root', selectionRevision: 0, revision: 1, nodes, libraryExpanded: true }));
    const primary = singleTool ? taskRef : sessionRef;
    const selectRef = vi.fn();
    attachCenterSplitBridge({ getPrimary: () => primary, getUnderlyingPrimary: () => sessionRef,
      selectRef, getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {} });
    if (!singleTool) {
      centerSplitIncoming(taskRef, 'right');
      const candidate = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'focus', index: 0 });
      expect(candidate).not.toBeNull();
      expect(centerSplitCommitSnapLayout(candidate!)).toBe(true);
      expect(centerSplitSelectInPane(2, navigationRef)).toBe(true);
    }
    const onClose = vi.fn();
    const onSelect = vi.fn((sel: UtilitySelection): void => { centerSplitTryFill({ kind: 'utility', sel }); });
    const view = render(<StoreProvider><PanelHistoryProvider><LeftPanel utilityPanel={singleTool ? 'tasks' : null}
      onSelectUtilityPanel={onSelect} onCloseUtilityPanel={onClose} />
    </PanelHistoryProvider></StoreProvider>);
    const row = (await screen.findByText('已打开会话')).closest<HTMLElement>('.session-item')!;
    const hiddenRow = (await screen.findByText('未打开终端')).closest<HTMLElement>('.session-item')!;
    const tree = await screen.findByRole('treeitem', { name: '已打开导航' });
    const favorite = screen.getByRole('button', { name: '已打开导航' });
    const task = screen.getByText('定时任务').closest('button')!;
    return { view, primary, selectRef, onSelect, onClose, row, hiddenRow, tree, favorite, task };
  }

  it.each([0, 1, 2] as const)('三槽同时标记已打开，仅第 %i 槽聚焦并承担选中语义', async focused => {
    const rail = await mountMixedRail();
    act(() => centerSplitSetFocused(focused));
    expectPaneState(rail.row, true, focused === 0);
    expect(rail.row.classList.contains('active')).toBe(focused === 0);
    expect(rail.row.getAttribute('aria-current') === 'true').toBe(focused === 0);
    expect(rail.row.tabIndex).toBe(focused === 0 ? 0 : -1);
    expectPaneState(rail.task, true, focused === 1);
    expect(rail.task.classList.contains('active')).toBe(focused === 1);
    expect(rail.task.getAttribute('aria-pressed')).toBe(String(focused === 1));
    expectPaneState(rail.tree, true, focused === 2);
    expect(rail.tree.getAttribute('aria-selected')).toBe(String(focused === 2));
    expectPaneState(rail.favorite, true, focused === 2);
    expect(rail.favorite.getAttribute('aria-pressed')).toBe(String(focused === 2));
    expectPaneState(rail.hiddenRow, false, false);
    expectPaneState(screen.getByRole('treeitem', { name: '未打开导航' }), false, false);
    expectPaneState(screen.getByRole('button', { name: '未打开导航' }), false, false);
  });

  it('焦点快速反向只切换标记，三个已打开来源与按钮/会话 DOM 全程保活', async () => {
    const rail = await mountMixedRail();
    const references = [rail.row, rail.task, rail.tree, rail.favorite];
    const refs = getCenterSplitPaneRefs(rail.primary, getCenterSplitState());
    for (const focused of [0, 2, 1, 2, 0] as const) {
      act(() => centerSplitSetFocused(focused));
      expectPaneState(rail.row, true, focused === 0);
      expectPaneState(rail.task, true, focused === 1);
      expectPaneState(rail.tree, true, focused === 2);
      expectPaneState(rail.favorite, true, focused === 2);
      expect([
        screen.getByText('已打开会话').closest('.session-item'),
        screen.getByText('定时任务').closest('button'),
        screen.getByRole('treeitem', { name: '已打开导航' }),
        screen.getByRole('button', { name: '已打开导航' })
      ]).toEqual(references);
      expect(getCenterSplitPaneRefs(rail.primary, getCenterSplitState())).toEqual(refs);
    }
    expect(rail.selectRef).not.toHaveBeenCalled();
    expect(rail.onSelect).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
  });

  it('重排按引用保留标记，点击已有条目只聚焦，收起和解散及时移除打开标记', async () => {
    const rail = await mountMixedRail();
    const refs = getCenterSplitPaneRefs(rail.primary, getCenterSplitState());
    const candidate = deriveCenterSplitSnapLayout(rail.primary, getCenterSplitState(), 2, { layoutId: 'thirds', index: 0 });
    expect(candidate).not.toBeNull();
    act(() => { expect(centerSplitCommitSnapLayout(candidate!)).toBe(true); });
    expect(getCenterSplitState().order?.[2]).toBe(0);
    expectPaneState(rail.tree, true, true);
    expectPaneState(rail.row, true, false);
    fireEvent.click(rail.row);
    expect(getCenterSplitState().focused).toBe(0);
    expectPaneState(rail.row, true, true);
    expectPaneState(rail.tree, true, false);
    fireEvent.click(rail.task);
    expect(getCenterSplitState().focused).toBe(1);
    expectPaneState(rail.task, true, true);
    fireEvent.click(rail.favorite);
    expect(getCenterSplitState().focused).toBe(2);
    expectPaneState(rail.tree, true, true);
    expect(getCenterSplitPaneRefs(rail.primary, getCenterSplitState())).toEqual(refs);
    expect(rail.selectRef).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
    expect(rail.onClose).not.toHaveBeenCalled();
    act(() => centerSplitClosePane(2));
    expectPaneState(rail.tree, false, false);
    expectPaneState(rail.favorite, false, false);
    expectPaneState(rail.row, true, true);
    expectPaneState(rail.task, true, false);
    act(() => centerSplitDissolve(0));
    expect(getCenterSplitState().open).toBe(false);
    expectPaneState(rail.task, false, false);
    expectPaneState(rail.row, true, true);
  });

  it('单屏主工具遮盖背后会话时，仅工具标记为已打开和聚焦', async () => {
    const rail = await mountMixedRail(true);
    expectPaneState(rail.task, true, true);
    expect(rail.task.getAttribute('aria-pressed')).toBe('true');
    expectPaneState(rail.row, false, false);
    expect(rail.row.classList.contains('active')).toBe(false);
    expect(rail.row.getAttribute('aria-current')).not.toBe('true');
    expect(rail.row.tabIndex).toBe(-1);
    expectPaneState(rail.tree, false, false);
    expectPaneState(rail.favorite, false, false);
  });

  it('导航树和常用入口支持多项打开、无导航聚焦；旧单选调用保留默认状态', () => {
    const nodes: ExtensionNavigationNode[] = ['one', 'two'].map(id => ({ id, kind: 'extension', parentId: null,
      title: `入口${id}`, extensionId: 'demo', viewId: id, favorite: true }));
    const noop = (): void => {};
    const view = render(<UtilityNavigationSection nodes={nodes} selectedId="one" openedIds={['one', 'two']}
      onChange={noop} onSelect={noop} libraryExpanded onLibraryExpandedChange={noop} />);
    expectPaneState(screen.getByRole('treeitem', { name: '入口one' }), true, true);
    expectPaneState(screen.getByRole('button', { name: '入口two' }), true, false);
    view.rerender(<UtilityNavigationSection nodes={nodes} selectedId={null} openedIds={['one', 'two']}
      onChange={noop} onSelect={noop} libraryExpanded onLibraryExpandedChange={noop} />);
    for (const name of ['入口one', '入口two']) {
      expectPaneState(screen.getByRole('treeitem', { name }), true, false);
      expect(screen.getByRole('treeitem', { name }).getAttribute('aria-selected')).toBe('false');
      expectPaneState(screen.getByRole('button', { name }), true, false);
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false');
    }
    view.rerender(<UtilityNavigationSection nodes={nodes} selectedId="two"
      onChange={noop} onSelect={noop} libraryExpanded onLibraryExpandedChange={noop} />);
    expectPaneState(screen.getByRole('treeitem', { name: '入口one' }), false, false);
    expectPaneState(screen.getByRole('button', { name: '入口one' }), false, false);
    expectPaneState(screen.getByRole('treeitem', { name: '入口two' }), true, true);
    expectPaneState(screen.getByRole('button', { name: '入口two' }), true, true);
  });
});

describe('已有主工具的侧栏 toggle 路由', () => {
  async function mountRail(focused: CenterPaneSlot) {
    const primary: SplitPaneRef = { kind: 'utility', sel: 'tasks' };
    const a: SplitPaneRef = { kind: 'session', sessionId: 'chat-a' };
    const b: SplitPaneRef = { kind: 'session', sessionId: 'chat-b' };
    attachCenterSplitBridge({
      getPrimary: () => primary, selectRef: () => {},
      getPrefs: () => ({ dir: 'row', ratio: .5 }), savePrefs: () => {}
    });
    centerSplitIncoming(a, 'right');
    if (focused === 2) {
      const candidate = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'focus', index: 0 });
      expect(candidate).not.toBeNull();
      expect(centerSplitCommitSnapLayout(candidate!)).toBe(true);
      expect(centerSplitSelectInPane(2, b)).toBe(true);
    }
    centerSplitSetFocused(focused);
    const originalRefs = getCenterSplitPaneRefs(primary, getCenterSplitState());
    const onClose = vi.fn();
    // This is the production App callback route: an already displayed utility
    // focuses its existing binding rather than selecting another primary.
    const onSelect = vi.fn((sel: UtilitySelection): void => {
      centerSplitTryFill({ kind: 'utility', sel });
    });
    await act(async () => {
      render(<KeybindingProvider><StoreProvider><PanelHistoryProvider>
        <LeftPanel utilityPanel="tasks" onSelectUtilityPanel={onSelect} onCloseUtilityPanel={onClose} />
      </PanelHistoryProvider></StoreProvider></KeybindingProvider>);
    });
    expect(getCenterSplitState().focused).toBe(focused);
    return { primary, originalRefs, onClose, onSelect };
  }

  it.each([1, 2] as const)('第 %i 槽聚焦时点击已显示主工具先聚焦主槽，再点击保留关闭行为', async focused => {
    const { primary, originalRefs, onClose, onSelect } = await mountRail(focused);
    const tile = screen.getByText('定时任务').closest('button')!;
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('tasks');
    expect(onClose).not.toHaveBeenCalled();
    expect(getCenterSplitState().focused).toBe(0);
    expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual(originalRefs);
    fireEvent.click(tile);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2] as const)('第 %i 槽聚焦时真实主工具快捷键沿用聚焦优先及主槽关闭行为', async focused => {
    const { primary, originalRefs, onClose, onSelect } = await mountRail(focused);
    fireEvent.keyDown(document.body, { key: 't', code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('tasks');
    expect(onClose).not.toHaveBeenCalled();
    expect(getCenterSplitState().focused).toBe(0);
    expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual(originalRefs);
    fireEvent.keyDown(document.body, { key: 't', code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
