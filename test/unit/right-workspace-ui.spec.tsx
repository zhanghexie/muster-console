import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from '../../src/shared/types';
import type { RightPanelLayoutChange } from '../../src/shared/panelState';
import type { RightTab } from '../../src/shared/rightWorkspace';
import { applyBookmarkChange, type BookmarkChange, type WorkspaceBookmarks } from '../../src/shared/bookmarks';
import { mergeDefaultBookmarks } from '../../src/shared/defaultBookmarks';
import { currentApiMock } from './helpers/api-mock';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';

const state = vi.hoisted(() => ({ sessionId: 's1', sessions: [] as Array<{ id: string; name: string; archived?: boolean }>, workspaces: [] as WorkspaceInfo[], tip: vi.fn(), request: null as null | { path: string; nonce: number; source?: 'preview' | 'keep'; replacePreview?: boolean; scope?: 'workspace' | 'session'; ownerSessionId?: string }, cfg: {} as any, ready: true, patchOk: true, patchReason: undefined as undefined | 'stale-owner', patchError: null as string | null, patchCalls: [] as any[] }));
vi.mock('../../src/renderer/src/store', () => ({ useSessionStore: () => ({ activeId: state.sessionId, visibleSessions: [], sessions: state.sessions }), useRuntimesStore: () => ({ runtimes: [] }), useWorkspaceStore: () => ({ activeWorkspaceId: 'ws', workspaces: state.workspaces }), useUiStore: () => ({ flashTip: state.tip, requestShowWorkspace: vi.fn(), openCommandPalette: vi.fn(), openWorkspaceFile: state.request, clearOpenWorkspaceFile: () => { state.request = null; } }) }));
vi.mock('../../src/renderer/src/hooks/useWorkspaceFile', () => ({ useWorkspaceFile: () => ({ cfg: state.cfg, cfgRef: { current: state.cfg }, workspaceId: 'ws', ready: state.ready, patch: async (patch: unknown) => { state.patchCalls.push(patch); if (state.patchError) throw new Error(state.patchError); return { ok: state.patchOk, reason: state.patchReason, config: state.patchOk ? Object.assign(state.cfg, patch) : state.cfg }; } }) }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useKeybinding: () => {}, useChordLabel: () => '', useOverlayDismiss: () => {} }));
vi.mock('../../src/renderer/src/components/BrowserPage', () => ({ BrowserPage: () => <div data-testid="native-owner"><webview/></div> }));
vi.mock('../../src/renderer/src/webGatewayEnvironment', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/renderer/src/webGatewayEnvironment')>(),
  isWebGateway: vi.fn(() => false)
}));
vi.mock('../../src/renderer/src/panels/GitPanel', () => ({ GitPanel: ({ layout }: { layout: string }) => layout === 'resources' ? null : <div>Git content</div> }));
import { SideToolsPanel } from '../../src/renderer/src/panels/SideToolsPanel';
import { RightWorkspaceToolbar } from '../../src/renderer/src/components/RightWorkspaceToolbar';
import { captureFileNote } from '../../src/renderer/src/agentChat/noteBridge';
import { applyAgentRightLayout, closeAgentRightTab, focusAgentRightTab, openAgentRightContent, prepareAgentCenterFile, readAgentCenterFile, readRightPanelState, releaseAgentCenterFile, subscribeAgentCenterFiles } from '../../src/renderer/src/rightPanelState';
import { centerFileHostKey, DockSurface, RightDockHost, requestRightPin, rightDockSnapshot } from '../../src/renderer/src/rightDock';
import { registerFileEditorState } from '../../src/renderer/src/fileEditorState';
import { isWorkspaceFileClosePending, prepareWorkspaceFileClose } from '../../src/renderer/src/workspaceFileClose';
import { isWebGateway } from '../../src/renderer/src/webGatewayEnvironment';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

beforeEach(() => {
  dismissTip();
  vi.mocked(isWebGateway).mockReturnValue(false);
  localStorage.removeItem('muster.right-workspace.archived-tabs.v1');
  state.sessionId = 's1'; state.sessions = []; state.cfg = {}; state.request = null; state.ready = true; state.patchOk = true; state.patchReason = undefined; state.patchError = null; state.patchCalls.length = 0; state.tip.mockClear();
  state.workspaces = [{ id: 'ws', name: 'Project', path: 'E:/ws', openedAt: 0, rootsRevision: 0, defaultRootId: 'a', controlRoot: 'E:/ws', roots: [{ id: 'a', path: 'E:/ws' }] }];
  const api = currentApiMock();
  bookmarks = { version: 1, bookmarkDefaultsVersion: 1, bookmarks: [] };
  bookmarkWriteError = null;
  api.override('workspaceBookmarks.read', async () => {
    const legacy = state.cfg.rightWorkspace;
    const nodes = legacy?.bookmarks ?? [];
    const seeded = legacy?.bookmarkDefaultsVersion >= 1 ? { nodes, complete: true } : mergeDefaultBookmarks(nodes);
    bookmarks = { version: 1, bookmarkDefaultsVersion: seeded.complete ? 1 : 0, bookmarks: seeded.nodes };
    return { ok: true, snapshot: bookmarks };
  });
  api.override('workspaceBookmarks.change', async (_id: string, change: BookmarkChange) => {
    if (bookmarkWriteError) return { ok: false, error: bookmarkWriteError };
    const result = applyBookmarkChange(bookmarks.bookmarks, change);
    if (result.error) throw new Error(result.error);
    bookmarks = { ...bookmarks, bookmarks: result.nodes };
    return { ok: true, snapshot: bookmarks };
  });
  api.override('fs.listTreeDirRef', async () => ({ entries: ['a.txt', 'b.txt', 'c.txt'].map(name => ({ name, relativePath: name, isDirectory: false })) }));
  api.override('fs.resolveRef', async (_ws: string, path: string) => ({ ok: true, fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: path } }));
  api.override('fs.statRef', async () => ({ ok: true, isDirectory: false, isFile: true, size: 16 }));
  api.override('fs.readTextRef', async (ref: { relativePath: string }) => ({ ok: true, content: `content ${ref.relativePath}`, mtimeMs: 1 }));
  api.override('fs.writeTextRef', async () => ({ ok: true, mtimeMs: 2 }));
  Element.prototype.scrollIntoView = () => {};
});
let bookmarks: WorkspaceBookmarks;
let bookmarkWriteError: string | null;
const tree = (active = true, pageVisible = true) => <PanelHistoryProvider><SideToolsPanel active={active} gitEverActive pageVisible={pageVisible}/></PanelHistoryProvider>;
const contentTabs = () => within(screen.getByRole('tablist', { name: '内容标签页' })).getAllByRole('tab');

describe('right tab document fullscreen', () => {
  let element: Element | null, enter: ReturnType<typeof vi.fn>, exit: ReturnType<typeof vi.fn>;
  let descriptors: Array<{ object: object; key: string; descriptor?: PropertyDescriptor }>;
  beforeEach(() => {
    element = null;
    descriptors = [[document, 'fullscreenElement'], [document, 'fullscreenEnabled'], [document, 'exitFullscreen'], [document.documentElement, 'requestFullscreen']]
      .map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
    enter = vi.fn(async () => { element = document.documentElement; document.dispatchEvent(new Event('fullscreenchange')); });
    exit = vi.fn(async () => { element = null; document.dispatchEvent(new Event('fullscreenchange')); });
    Object.defineProperties(document, { fullscreenElement: { configurable: true, get: () => element }, fullscreenEnabled: { configurable: true, get: () => true }, exitFullscreen: { configurable: true, value: exit } });
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: enter });
  });
  afterEach(() => { for (const { object, key, descriptor } of descriptors) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } });
  const seed = (web = false) => {
    state.cfg.rightWorkspace = { version: 1, resources: { panel: 'files', collapsed: false }, tabs: ['a', 'b'].map(id => ({ id, workspaceId: 'ws', sessionId: 's1', scope: 'workspace', preview: false, pinned: false,
      content: web ? { kind: 'web', browserId: id, url: `https://${id}.test/`, title: `${id}.txt` } : { kind: 'file', path: `${id}.txt`, fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: `${id}.txt` } } })), selected: { s1: 'b' } };
  };
  const selectMenu = async (name: string, label: string) => {
    fireEvent.contextMenu(await screen.findByRole('tab', { name: new RegExp(name) }));
    await act(async () => { fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: label })); });
  };
  it('right-clicking a background tab selects and fullscreens that tab; exit preserves editor and layout preferences', async () => {
    render(tree()); await openFile('a.txt'); fireEvent.doubleClick(contentTabs()[0]); await openFile('b.txt');
    const preferences = JSON.stringify(state.cfg.rightWorkspace.resources);
    await selectMenu('a.txt', '全屏显示');
    await waitFor(() => expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy());
    expect(screen.getByRole('tab', { name: /a.txt/ }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.querySelector('.right-content-page.is-shown .file-editor')).toBeTruthy());
    const editor = document.querySelector('.right-content-page.is-shown .file-editor');
    expect(enter).toHaveBeenCalledOnce();
    const bar = document.querySelector<HTMLElement>('.right-workspace-toolbar')!;
    await waitFor(() => expect(bar.dataset.mpStage).toBe('out'));
    fireEvent.pointerMove(document.querySelector('.right-fullscreen-hotzone')!);
    await waitFor(() => expect(bar.dataset.mpStage).toBe('in'));
    await selectMenu('a.txt', '退出全屏');
    expect(document.querySelector('.is-tab-fullscreen')).toBeNull();
    expect(document.querySelector('.right-content-page.is-shown .file-editor')).toBe(editor);
    expect(JSON.stringify(state.cfg.rightWorkspace.resources)).toBe(preferences); expect(exit).toHaveBeenCalledOnce();
  });
  it('Escape exits even from a native webview, and a background guest cannot exit it', async () => {
    seed(true); render(tree()); await selectMenu('a.txt', '全屏显示');
    await waitFor(() => expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy());
    act(() => currentApiMock().emit('browser:escape', { tabId: 'b' }));
    expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy();
    await act(async () => { currentApiMock().emit('browser:escape', { tabId: 'a' }); });
    expect(document.querySelector('.is-tab-fullscreen')).toBeNull();
  });
  it('switching tabs keeps fullscreen; a delayed enter cannot fullscreen a different tab', async () => {
    seed(); render(tree()); await selectMenu('a.txt', '全屏显示');
    await waitFor(() => expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy());
    fireEvent.pointerMove(document.querySelector('.right-fullscreen-hotzone')!);
    await waitFor(() => expect(document.querySelector<HTMLElement>('.right-workspace-toolbar')!.dataset.mpStage).toBe('in'));
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /b.txt/ })); });
    expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy();
    expect(document.querySelector<HTMLElement>('.right-workspace-toolbar')!.dataset.mpStage).toBe('in');
    expect(exit).not.toHaveBeenCalled(); expect(enter).toHaveBeenCalledOnce();
    await selectMenu('b.txt', '退出全屏');
    let done!: () => void;
    enter.mockImplementationOnce(() => new Promise<void>(resolve => { done = () => { element = document.documentElement; resolve(); }; }));
    await selectMenu('a.txt', '全屏显示');
    fireEvent.click(screen.getByRole('tab', { name: /b.txt/ }));
    await act(async () => done());
    expect(element).toBeNull(); expect(document.querySelector('.is-tab-fullscreen')).toBeNull();
  });
  it('can fullscreen another tab from its context menu without exiting native fullscreen', async () => {
    seed(true); render(tree()); await selectMenu('a.txt', '全屏显示');
    await waitFor(() => expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy());
    await selectMenu('b.txt', '全屏显示');
    expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy(); expect(enter).toHaveBeenCalledOnce(); expect(exit).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /b.txt/ }).getAttribute('aria-selected')).toBe('true');
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  });
  it('keyboard tab selection and closing back to another tab keep fullscreen; closing the last tab exits', async () => {
    seed(); render(tree()); await selectMenu('a.txt', '全屏显示');
    await waitFor(() => expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy());
    await act(async () => { fireEvent.keyDown(screen.getByRole('tab', { name: /a.txt/ }), { key: 'ArrowRight' }); });
    expect(screen.getByRole('tab', { name: /b.txt/ }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy();
    await selectMenu('b.txt', '关闭标签页');
    await waitFor(() => expect(contentTabs()).toHaveLength(1));
    expect(document.querySelector('.is-tab-fullscreen')).toBeTruthy(); expect(exit).not.toHaveBeenCalled();
    await selectMenu('a.txt', '关闭标签页');
    await waitFor(() => expect(document.querySelector('.is-tab-fullscreen')).toBeNull());
    expect(exit).toHaveBeenCalledOnce(); expect(enter).toHaveBeenCalledOnce();
  });
});
const resources = () => within(screen.getByRole('tablist', { name: '资源面板' }));
async function openFile(path: string): Promise<void> { await waitFor(() => expect(document.querySelector('.right-files-resources')).toBeTruthy(), { timeout: 5000 }); fireEvent.click(await within(document.querySelector('.right-files-resources')!).findByTitle(path, {}, { timeout: 5000 })); await waitFor(() => expect(document.querySelector('.right-tab[aria-selected="true"]')?.textContent).toContain(path)); }
async function editCurrent(): Promise<EditorView> { const button = await screen.findByRole('button', { name: '编辑' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button); const node = document.querySelector('.right-content-page.is-shown .cm-editor') as HTMLElement; return EditorView.findFromDOM(node)!; }

describe('right workspace split', () => {
  const splitButton = () => screen.getByRole('button', { name: '选择分屏布局' });
  const shownFiles = () => [...document.querySelectorAll<HTMLElement>('.right-workspace-content .files-panel.is-shown')];

  it('fills a second pane, changes focus and geometry, and returns to single view without replacing editors', async () => {
    render(tree());
    await openFile('a.txt');
    fireEvent.doubleClick(contentTabs()[0]);
    await openFile('b.txt');
    const [editor] = shownFiles();
    fireEvent.click(splitButton());
    fireEvent.click(await screen.findByTestId('right-snap-cell-halves-0'));
    const slot = document.querySelector<HTMLElement>('[data-right-split-slot="1"]')!;
    fireEvent.click(within(slot).getByRole('button', { name: 'a.txt' }));
    expect(shownFiles()).toHaveLength(2);
    expect(shownFiles()).toContain(editor);
    const divider = screen.getByRole('separator', { name: '调整分屏比例' });
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(divider.getAttribute('aria-valuenow')).toBe('52');
    expect(editor.style.inset).toContain('48%');

    const first = within(document.querySelector<HTMLElement>('[data-right-split-slot="0"]')!);
    const second = within(slot);
    expect(first.getByRole('toolbar', { name: '当前内容工具' }).textContent).toContain('b.txt');
    expect(second.getByRole('toolbar', { name: '当前内容工具' }).textContent).toContain('a.txt');
    const edit = first.getByRole<HTMLButtonElement>('button', { name: '编辑' });
    await waitFor(() => expect(edit.disabled).toBe(false));
    fireEvent.pointerDown(edit);
    fireEvent.click(edit);
    expect(document.querySelector('.right-tab[aria-selected="true"]')?.textContent).toContain('b.txt');
    const edited = EditorView.findFromDOM(editor.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(edited.state.doc.toString()).toContain('content b.txt');
    expect(second.getByRole('button', { name: '预览' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(slot).getByRole('button', { name: '收起此侧' }));
    expect(shownFiles()).toEqual([editor]);
    expect(contentTabs()).toHaveLength(2);
    expect(screen.queryByRole('separator', { name: '调整分屏比例' })).toBeNull();
  });

  it('applies the agent layout to the same panes and refuses stale or dirty replacements', async () => {
    render(tree());
    await openFile('a.txt');
    fireEvent.doubleClick(contentTabs()[0]);
    await openFile('b.txt');
    const initial = readRightPanelState('ws');
    const [a, b] = initial.tabs;
    expect(initial.selectedTabId).toBe(b.id);
    const change: RightPanelLayoutChange = {
      sessionId: initial.sessionId, expected: { selectedTabId: b.id, split: null },
      next: { selectedTabId: b.id, split: { layoutId: 'stack', tabIds: [b.id, a.id], ratio: 0.65 } },
      tabs: [a, b].map(tab => ({ id: tab.id, content: JSON.stringify(tab.content) }))
    };
    act(() => applyAgentRightLayout('ws', change));
    const divider = screen.getByRole('separator', { name: '调整分屏比例' });
    expect(divider.getAttribute('aria-orientation')).toBe('horizontal');
    expect(divider.getAttribute('aria-valuenow')).toBe('65');
    expect(shownFiles()).toHaveLength(2);
    expect(readRightPanelState('ws').split).toEqual(change.next.split);
    const close = { ...change, expected: change.next, next: { selectedTabId: b.id, split: null } };
    const stop = registerFileEditorState(() => ({ workspaceId: 'ws', path: 'a.txt',
      fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: 'a.txt' }, active: false, editing: true, unsaved: true }));
    try {
      expect(() => applyAgentRightLayout('ws', close)).toThrow(/affected editor has unsaved changes/);
      expect(shownFiles()).toHaveLength(2);
    } finally { stop(); }
    fireEvent.keyDown(divider, { key: 'ArrowDown' });
    expect(() => applyAgentRightLayout('ws', close)).toThrow(/split or tab identity changed/);
    const actual = readRightPanelState('ws').split!;
    act(() => applyAgentRightLayout('ws', { ...close, expected: { ...close.expected, split: actual } }));
    expect(readRightPanelState('ws').split).toBeNull();
    expect(shownFiles()).toHaveLength(1);
    expect(contentTabs()).toHaveLength(2);
  });

  it('drops a third tab onto a shared Snap target and clears the split when the session changes', async () => {
    const view = render(tree());
    await openFile('a.txt');
    fireEvent.doubleClick(contentTabs()[0]);
    await openFile('b.txt');
    fireEvent.doubleClick(contentTabs().find(tab => tab.textContent?.includes('b.txt'))!);
    await openFile('c.txt');
    fireEvent.click(contentTabs().find(tab => tab.textContent?.includes('b.txt'))!);
    fireEvent.contextMenu(contentTabs().find(tab => tab.textContent?.includes('a.txt'))!);
    fireEvent.click(await screen.findByText('选择分屏布局', { exact: true }));
    fireEvent.click(await screen.findByTestId('right-snap-cell-stack-0'));
    expect(within(document.querySelector<HTMLElement>('[data-right-split-slot="1"]')!).getByRole('toolbar', { name: '当前内容工具' }).textContent).toContain('b.txt');

    const third = contentTabs().find(tab => tab.textContent?.includes('c.txt'))!;
    const dataTransfer = { setData: vi.fn(), dropEffect: 'none' };
    fireEvent.dragStart(third, { dataTransfer });
    const target = await screen.findByTestId('right-snap-cell-thirds-2');
    expect((screen.getByTestId('right-snap-cell-halves-0') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragEnd(third, { dataTransfer });
    expect(shownFiles()).toHaveLength(3);
    expect(screen.getByTestId('right-split-divider-1')).toBeTruthy();
    state.sessionId = 's2';
    view.rerender(tree(false));
    expect(shownFiles()).toHaveLength(1);
    expect(contentTabs()).toHaveLength(3);
    expect(screen.queryByTestId('right-split-divider')).toBeNull();
  });
});

describe('production right workspace interactions', () => {
  it('defers selected-tab reveal until the workspace transition is over', () => {
    vi.useFakeTimers();
    const tab: RightTab = { id: 'tab-1', workspaceId: 'ws', sessionId: 's1', scope: 'workspace', pinned: false, preview: false, content: { kind: 'utility', sel: 'memory', title: '记忆整理' } };
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const props = { tabs: [tab], current: tab, panel: 'files' as const, collapsed: false, backDepth: 0, forwardDepth: 0,
      onHistory: vi.fn(), onSelect: vi.fn(), onClose: vi.fn(), onAction: vi.fn(), onMove: vi.fn(), onResource: vi.fn(), onCollapse: vi.fn() };
    const view = render(<RightWorkspaceToolbar {...props} transitioning />);
    expect(scroll).not.toHaveBeenCalled();
    view.rerender(<RightWorkspaceToolbar {...props} transitioning={false} />);
    expect(scroll).not.toHaveBeenCalled();
    act(() => { vi.runOnlyPendingTimers(); });
    expect(scroll).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('keeps the editor instance when its workspace disappears before close cleanup', async () => {
    state.workspaces[0] = { ...state.workspaces[0], rootsRevision: 7 };
    const view = render(tree());
    await openFile('a.txt');
    const editor = document.querySelector('.right-content-page.is-shown .file-editor');
    expect(editor).toBeTruthy();
    state.workspaces = [];
    view.rerender(tree());
    await waitFor(() => expect(document.querySelector('.file-editor')).toBe(editor));
    view.unmount();
  });
  it('prepares every file for workspace close and retains it if close rolls back', async () => {
    const view = render(tree());
    await openFile('a.txt');
    const editor = document.querySelector('.right-content-page.is-shown .file-editor');
    expect(editor).toBeTruthy();
    let transaction!: Awaited<ReturnType<typeof prepareWorkspaceFileClose>>;
    await act(async () => { transaction = await prepareWorkspaceFileClose('ws'); });
    expect(isWorkspaceFileClosePending('ws')).toBe(true);
    expect(() => prepareAgentCenterFile('ws', { kind: 'file', path: 'b.txt', fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: 'b.txt' } })).toThrow(/close is pending/);
    expect(document.querySelector('.right-content-page.is-shown .file-editor')).toBe(editor);
    act(() => transaction.rollback());
    expect(isWorkspaceFileClosePending('ws')).toBe(false);
    expect(document.querySelector('.right-content-page.is-shown .file-editor')).toBe(editor);
    const stop = registerFileEditorState(() => ({ workspaceId: 'ws', path: 'a.txt', active: true, editing: true, unsaved: true }));
    await expect(prepareWorkspaceFileClose('ws')).rejects.toThrow(/unsaved/);
    expect(isWorkspaceFileClosePending('ws')).toBe(false);
    stop(); view.unmount();
  });
  it('prepares one center file without changing the right tab and refuses a background move', async () => {
    const view = render(tree());
    await openFile('a.txt');
    const selected = readRightPanelState('ws').selectedTabId;
    const file = { kind: 'file' as const, path: 'b.txt', fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: 'b.txt' } };
    const changed = vi.fn(); const stop = subscribeAgentCenterFiles(changed);
    let prepared!: ReturnType<typeof prepareAgentCenterFile>;
    await act(async () => { prepared = prepareAgentCenterFile('ws', file); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(prepared).toMatchObject({ existing: false, centerOnly: true });
    const identity = readAgentCenterFile('ws', prepared.tabId)!;
    expect(identity).toEqual({ tabId: prepared.tabId, centerOnly: true, pinned: false, content: file });
    identity.content.path = 'tampered';
    expect(readAgentCenterFile('ws', prepared.tabId)?.content).toEqual(file);
    expect(() => readAgentCenterFile('other', prepared.tabId)).toThrow(/requested workspace/);
    expect(changed).toHaveBeenCalled();
    expect(prepareAgentCenterFile('ws', file)).toEqual({ ...prepared, existing: true });
    expect(readRightPanelState('ws').selectedTabId).toBe(selected);
    expect(readRightPanelState('ws').tabs.some(tab => tab.id === prepared.tabId)).toBe(false);
    await expect(openAgentRightContent('ws', file)).rejects.toThrow(/focus is required/);
    expect(readRightPanelState('ws').selectedTabId).toBe(selected);
    expect(() => releaseAgentCenterFile('ws', prepared.tabId, '{}')).toThrow(/changed/);
    const unregisterDirty = registerFileEditorState(() => ({ workspaceId: 'ws', path: 'b.txt', fileRef: file.fileRef, active: false, editing: true, unsaved: true }));
    expect(() => releaseAgentCenterFile('ws', prepared.tabId, JSON.stringify(file))).toThrow(/unsaved/);
    unregisterDirty();
    const disposable = { kind: 'file' as const, path: 'c.txt', fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: 'c.txt' } };
    let temporary!: ReturnType<typeof prepareAgentCenterFile>;
    await act(async () => { temporary = prepareAgentCenterFile('ws', disposable); await new Promise(resolve => setTimeout(resolve, 0)); });
    const temporaryHost = render(<RightDockHost dockKey={`center-file:${temporary.tabId}`} hostKey="temporary-center" shown />);
    expect(() => releaseAgentCenterFile('ws', temporary.tabId, JSON.stringify(disposable))).toThrow(/host is in use/);
    temporaryHost.unmount();
    act(() => expect(releaseAgentCenterFile('ws', temporary.tabId, JSON.stringify(disposable))).toEqual({ released: true }));
    expect(readAgentCenterFile('ws', temporary.tabId)).toBeNull();
    await waitFor(() => expect(document.querySelectorAll('.right-content-page .file-editor')).toHaveLength(2));
    const backing = document.querySelectorAll('.right-content-page .file-editor')[1];
    const host = render(<RightDockHost dockKey={`center-file:${prepared.tabId}`} hostKey="center-test" shown />);
    await waitFor(() => expect(host.container.querySelector('.file-editor')).toBe(backing));
    host.unmount();
    await waitFor(() => expect(document.querySelectorAll('.right-content-page .file-editor')[1]).toBe(backing));
    await openFile('b.txt');
    expect(readRightPanelState('ws').selectedTabId).toBe(prepared.tabId);
    expect(readAgentCenterFile('ws', prepared.tabId)).toMatchObject({ centerOnly: false, pinned: false });
    expect(document.querySelector('.right-content-page.is-shown .file-editor')).toBe(backing);
    const userContent = readRightPanelState('ws').tabs.find(tab => tab.id === prepared.tabId)!.content;
    expect(releaseAgentCenterFile('ws', prepared.tabId, JSON.stringify(userContent))).toEqual({ released: false });
    const iframe = document.createElement('iframe'); backing!.append(iframe);
    const failedHost = render(<RightDockHost dockKey={`center-file:${prepared.tabId}`} hostKey={centerFileHostKey(prepared.tabId)} shown />);
    await waitFor(() => expect(state.tip).toHaveBeenCalledWith(expect.stringContaining('reload embedded content')));
    expect(failedHost.container.querySelector('.file-editor')).toBeNull();
    expect(document.querySelector('.right-content-page.is-shown .file-editor')).toBe(backing);
    failedHost.unmount(); iframe.remove();
    const centerHost = render(<RightDockHost dockKey={`center-file:${prepared.tabId}`} hostKey={centerFileHostKey(prepared.tabId)} shown />);
    await waitFor(() => expect(centerHost.container.querySelector('.file-editor')).toBe(backing));
    fireEvent.click(within(screen.getByRole('tablist', { name: '内容标签页' })).getByRole('tab', { name: /b\.txt/ }));
    await waitFor(() => expect(document.querySelector('.right-content-page.is-shown .file-editor')).toBe(backing));
    expect(rightDockSnapshot().docked.has(`center-file:${prepared.tabId}`)).toBe(false);
    centerHost.unmount();
    stop();
    view.unmount();
  });
  it('updates an agent-owned review target without selecting it or losing the existing tab', async () => {
    const view = render(tree());
    await openFile('a.txt');
    const selected = readRightPanelState('ws').selectedTabId;
    const first = { kind: 'review' as const, owner: { kind: 'dispatch' as const, id: 'ws' }, messageId: 'turn-a', repoPath: 'E:/ws' };
    let pending!: ReturnType<typeof openAgentRightContent>;
    act(() => { pending = openAgentRightContent('ws', first); });
    let opened!: Awaited<typeof pending>;
    await act(async () => { opened = await pending; });
    expect(opened).toMatchObject({ existing: false, selected: false });
    const next = { ...first, messageId: 'turn-b', filePath: 'b.txt' };
    act(() => { pending = openAgentRightContent('ws', next); });
    let updated!: Awaited<typeof pending>;
    await act(async () => { updated = await pending; });
    expect(updated).toEqual({ tabId: opened.tabId, existing: true, selected: false });
    const snapshot = readRightPanelState('ws');
    expect(snapshot.selectedTabId).toBe(selected);
    expect(snapshot.tabs.find(tab => tab.id === opened.tabId)?.content).toEqual(next);
    expect(await openAgentRightContent('ws', next)).toEqual(updated);
    act(() => focusAgentRightTab('ws', opened.tabId));
    await expect(openAgentRightContent('ws', { ...next, messageId: 'turn-c' })).rejects.toThrow(/visible review/);
    expect(readRightPanelState('ws').tabs.find(tab => tab.id === opened.tabId)?.content).toEqual(next);
    await expect(openAgentRightContent('ws', { ...next, owner: { kind: 'dispatch', id: 'elsewhere' } })).rejects.toThrow(/review owner/);
    act(() => expect(closeAgentRightTab('ws', opened.tabId, JSON.stringify(next))).toEqual({ tabId: opened.tabId, closed: true }));
    expect(readRightPanelState('ws').tabs.some(tab => tab.id === opened.tabId)).toBe(false);
    view.unmount();
  });
  it('does not replace a pinned review owned by the user', async () => {
    const content = { kind: 'review' as const, owner: { kind: 'dispatch' as const, id: 'ws' }, messageId: 'turn-a', repoPath: 'E:/ws' };
    state.cfg.rightWorkspace = { version: 1, panel: 'git', collapsed: false, bookmarks: [], bookmarkDefaultsVersion: 1,
      tabs: [{ id: 'pinned-review', workspaceId: 'ws', sessionId: 's1', pinned: true, preview: false, origin: 'user', content }], selected: { s1: 'pinned-review' } };
    const view = render(tree());
    await waitFor(() => expect(readRightPanelState('ws').tabs.some(tab => tab.content.kind === 'review')).toBe(true));
    const tab = readRightPanelState('ws').tabs.find(item => item.content.kind === 'review')!;
    expect(tab.pinned).toBe(true);
    await expect(openAgentRightContent('ws', { ...content, messageId: 'turn-b' })).rejects.toThrow(/pinned or user-owned/);
    expect(() => closeAgentRightTab('ws', tab.id)).toThrow(/Pinned tabs/);
    expect(readRightPanelState('ws').tabs.find(item => item.id === tab.id)?.content).toEqual(content);
    view.unmount();
  });
  it('keeps a legacy review protected from background replacement after unpinning it', async () => {
    const content = { kind: 'review' as const, owner: { kind: 'dispatch' as const, id: 'ws' }, messageId: 'turn-a', repoPath: 'E:/ws' };
    state.cfg.rightWorkspace = { version: 1, panel: 'git', collapsed: false, bookmarks: [], bookmarkDefaultsVersion: 1,
      tabs: [{ id: 'legacy', workspaceId: 'ws', sessionId: 's1', pinned: true, preview: false, origin: 'agent', content }], selected: { s1: 'legacy' } };
    render(tree());
    fireEvent.click(await screen.findByRole('button', { name: '取消固定' }));
    await openFile('a.txt');
    await expect(openAgentRightContent('ws', { ...content, messageId: 'turn-b' })).rejects.toThrow(/workspace-scoped/);
    expect(readRightPanelState('ws').tabs.filter(tab => tab.content.kind === 'review')).toMatchObject([{ pinned: false, content }]);
  });
  it('keeps a background utility in the center until explicit tab selection', async () => {
    const view = render(<>{tree()}<DockSurface dockKey="utility:tasks"><input aria-label="中心草稿" defaultValue="保留" /></DockSurface></>);
    await waitFor(() => expect(readRightPanelState('ws')).toBeTruthy());
    const original = screen.getByLabelText('中心草稿');
    let pending!: ReturnType<typeof openAgentRightContent>;
    act(() => { pending = openAgentRightContent('ws', { kind: 'utility', sel: 'tasks', title: 'untrusted' }); });
    let opened!: Awaited<typeof pending>;
    await act(async () => { opened = await pending; });
    expect(opened.selected).toBe(false);
    expect(rightDockSnapshot().docked.has('utility:tasks')).toBe(false);
    expect(readRightPanelState('ws').tabs.find(tab => tab.id === opened.tabId)?.content).toMatchObject({ title: '定时任务' });
    expect(readRightPanelState('ws').tabs.find(tab => tab.id === opened.tabId)?.deferredDock).toBe(true);
    act(() => { focusAgentRightTab('ws', opened.tabId); });
    await waitFor(() => expect(rightDockSnapshot().docked.has('utility:tasks')).toBe(true));
    expect(readRightPanelState('ws').tabs.find(tab => tab.id === opened.tabId)?.deferredDock).toBe(false);
    expect(screen.getByLabelText('中心草稿')).toBe(original);
    expect((original as HTMLInputElement).value).toBe('保留');
    act(() => { closeAgentRightTab('ws', opened.tabId); });
    await waitFor(() => expect(rightDockSnapshot().docked.has('utility:tasks')).toBe(false));
    expect(screen.getByLabelText('中心草稿')).toBe(original);
    view.unmount();
  });
  it('keeps the settings surface mounted when its background tab is selected and closed', async () => {
    const view = render(<>{tree()}<DockSurface dockKey="utility:settings"><input aria-label="设置草稿" defaultValue="保留" /></DockSurface></>);
    await waitFor(() => expect(readRightPanelState('ws')).toBeTruthy());
    const original = screen.getByLabelText('设置草稿');
    let pending!: ReturnType<typeof openAgentRightContent>;
    act(() => { pending = openAgentRightContent('ws', { kind: 'utility', sel: 'settings', title: 'untrusted' }); });
    let opened!: Awaited<typeof pending>; await act(async () => { opened = await pending; });
    expect(opened.selected).toBe(false);
    expect(rightDockSnapshot().docked.has('utility:settings')).toBe(false);
    act(() => { focusAgentRightTab('ws', opened.tabId); });
    await waitFor(() => expect(rightDockSnapshot().docked.has('utility:settings')).toBe(true));
    expect(screen.getByLabelText('设置草稿')).toBe(original);
    expect((original as HTMLInputElement).value).toBe('保留');
    act(() => requestRightPin({ workspaceId: 'ws', ref: { kind: 'utility', sel: 'settings' }, command: 'pin' }));
    expect(() => closeAgentRightTab('ws', opened.tabId)).toThrow(/Pinned tabs/);
    act(() => requestRightPin({ workspaceId: 'ws', ref: { kind: 'utility', sel: 'settings' }, command: 'unpin' }));
    await waitFor(() => expect(rightDockSnapshot().docked.has('utility:settings')).toBe(false));
    expect(screen.getByLabelText('设置草稿')).toBe(original);
    view.unmount();
  });
  it('does not let an agent close user-docked views, including an agent tab the user pins', async () => {
    const view = render(tree());
    await waitFor(() => expect(readRightPanelState('ws')).toBeTruthy());
    act(() => requestRightPin({ workspaceId: 'ws', ref: { kind: 'utility', sel: 'tasks' }, command: 'pin' }));
    await waitFor(() => expect(readRightPanelState('ws').tabs.some(tab => tab.content.kind === 'utility')).toBe(true));
    const userTab = readRightPanelState('ws').tabs.find(tab => tab.content.kind === 'utility')!;
    expect(() => closeAgentRightTab('ws', userTab.id)).toThrow(/User-docked/);
    act(() => requestRightPin({ workspaceId: 'ws', ref: { kind: 'utility', sel: 'tasks' }, command: 'unpin' }));
    let pending!: ReturnType<typeof openAgentRightContent>;
    act(() => { pending = openAgentRightContent('ws', { kind: 'utility', sel: 'tasks', title: 'ignored' }); });
    let opened!: Awaited<typeof pending>; await act(async () => { opened = await pending; });
    act(() => requestRightPin({ workspaceId: 'ws', ref: { kind: 'utility', sel: 'tasks' }, command: 'pin' }));
    await waitFor(() => expect(readRightPanelState('ws').tabs.find(tab => tab.id === opened.tabId)?.pinned).toBe(true));
    expect(() => closeAgentRightTab('ws', opened.tabId)).toThrow(/Pinned tabs/);
    view.unmount();
  });
  it('reports actual visible tabs and live editor state for the current workspace', async () => {
    const view = render(tree());
    await openFile('a.txt');
    const snapshot = readRightPanelState('ws');
    expect(snapshot.tabs).toHaveLength(1);
    expect(snapshot.tabs[0]).toMatchObject({ pinned: false, content: { kind: 'file', path: 'a.txt' }, origin: 'user' });
    expect(snapshot.selectedTabId).toBe(snapshot.tabs[0].id);
    const editor = await editCurrent();
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved content' } }));
    expect(readRightPanelState('ws').editors).toMatchObject([{ path: 'a.txt', editing: true, unsaved: true }]);
    expect(() => readRightPanelState('other')).toThrow(/unavailable or ambiguous/);
    view.unmount();
    expect(() => readRightPanelState('ws')).toThrow(/unavailable or ambiguous/);
  });
  it('opens an agent file in the background, preserves user tabs, and protects unsaved editing', async () => {
    const view = render(tree());
    await openFile('a.txt');
    const editor = await editCurrent();
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved content' } }));
    const initial = readRightPanelState('ws');
    const makeFile = (name: string) => ({ kind: 'file' as const, path: name, fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: name } });
    let pending!: ReturnType<typeof openAgentRightContent>;
    act(() => { pending = openAgentRightContent('ws', makeFile('b.txt')); });
    let opened!: Awaited<typeof pending>;
    await act(async () => { opened = await pending; });
    expect(opened).toMatchObject({ existing: false, selected: false });
    const snapshot = readRightPanelState('ws');
    expect(snapshot.selectedTabId).toBe(initial.selectedTabId);
    expect(snapshot.tabs.find(tab => tab.id === opened.tabId)).toMatchObject({ origin: 'agent', pinned: false });
    expect(within(screen.getByRole('tab', { name: /b\.txt/ })).getByTitle('跟随会话')).toBeTruthy();
    expect(editor.state.doc.toString()).toBe('unsaved content');
    const same = await openAgentRightContent('ws', makeFile('a.txt'));
    expect(same).toMatchObject({ tabId: initial.selectedTabId, existing: true, selected: true });
    expect(readRightPanelState('ws').tabs.find(tab => tab.id === same.tabId)?.origin).toBe('user');
    act(() => { pending = openAgentRightContent('ws', { kind: 'git', repoPath: 'E:/ws' }); });
    let gitOpened!: Awaited<typeof pending>;
    await act(async () => { gitOpened = await pending; });
    expect(readRightPanelState('ws').tabs.find(tab => tab.id === gitOpened.tabId)).toMatchObject({ origin: 'agent', content: { kind: 'git', repoPath: 'E:/ws' } });
    expect(readRightPanelState('ws').selectedTabId).toBe(initial.selectedTabId);
    expect(() => focusAgentRightTab('ws', gitOpened.tabId)).toThrow(/unsaved changes/);
    expect(() => closeAgentRightTab('ws', initial.selectedTabId!)).toThrow(/Workspace tabs/);
    act(() => expect(closeAgentRightTab('ws', gitOpened.tabId)).toEqual({ tabId: gitOpened.tabId, closed: true }));
    expect(readRightPanelState('ws').tabs.some(tab => tab.id === gitOpened.tabId)).toBe(false);
    const diff = { kind: 'diff' as const, repoPath: 'E:/ws', filePath: 'b.txt', staged: false };
    act(() => { pending = openAgentRightContent('ws', diff); });
    let diffOpened!: Awaited<typeof pending>;
    await act(async () => { diffOpened = await pending; });
    expect(diffOpened.selected).toBe(false);
    expect(readRightPanelState('ws').selectedTabId).toBe(initial.selectedTabId);
    expect(await openAgentRightContent('ws', diff)).toMatchObject({ tabId: diffOpened.tabId, existing: true });
    act(() => expect(closeAgentRightTab('ws', diffOpened.tabId)).toEqual({ tabId: diffOpened.tabId, closed: true }));
    expect(editor.state.doc.toString()).toBe('unsaved content');
    await expect(openAgentRightContent('ws', makeFile('b.txt'), true)).rejects.toThrow(/unsaved changes/);
    await expect(openAgentRightContent('other', makeFile('b.txt'))).rejects.toThrow(/requested workspace/);
    view.unmount();
  });
  it('selects an existing right tab when the active editor is clean', async () => {
    const view = render(tree());
    await openFile('a.txt');
    let pending!: ReturnType<typeof openAgentRightContent>;
    act(() => { pending = openAgentRightContent('ws', { kind: 'git', repoPath: 'E:/ws' }); });
    let opened!: Awaited<typeof pending>;
    await act(async () => { opened = await pending; });
    const content = readRightPanelState('ws').tabs.find(tab => tab.id === opened.tabId)!.content;
    expect(() => focusAgentRightTab('ws', opened.tabId, JSON.stringify({ kind: 'git', repoPath: 'E:/other' }))).toThrow(/changed/);
    expect(() => closeAgentRightTab('ws', opened.tabId, JSON.stringify({ kind: 'git', repoPath: 'E:/other' }))).toThrow(/changed/);
    expect(readRightPanelState('ws').tabs.some(tab => tab.id === opened.tabId)).toBe(true);
    act(() => expect(focusAgentRightTab('ws', opened.tabId, JSON.stringify(content))).toEqual({ tabId: opened.tabId, selected: true }));
    expect(readRightPanelState('ws').selectedTabId).toBe(opened.tabId);
    view.unmount();
  });
  it('does not close an unpinned file with unsaved changes', async () => {
    const view = render(tree());
    state.request = { path: 'a.txt', nonce: 1, scope: 'session' };
    view.rerender(tree(false));
    await waitFor(() => expect(contentTabs()).toHaveLength(1));
    const editor = await editCurrent();
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved' } }));
    const tabId = readRightPanelState('ws').selectedTabId!;
    expect(readRightPanelState('ws').tabs[0].pinned).toBe(false);
    expect(() => closeAgentRightTab('ws', tabId)).toThrow(/unsaved changes/);
    expect(editor.state.doc.toString()).toBe('unsaved');
    expect(readRightPanelState('ws').tabs.some(tab => tab.id === tabId)).toBe(true);
    view.unmount();
  });
  it('opens sidebar files for the workspace while chat-opened files remain session scoped', async () => {
    const view = render(tree());
    await openFile('a.txt');
    const sharedTab = screen.getByRole('tab', { name: /a\.txt/ });
    expect(within(sharedTab).queryByTitle('跟随会话')).toBeNull();
    state.request = { path: 'b.txt', nonce: 1 };
    view.rerender(tree(false));
    const chatTab = await screen.findByRole('tab', { name: /b\.txt/ });
    expect(chatTab.getAttribute('aria-description')).toBe('跟随会话');
    expect(within(chatTab).getByTitle('跟随会话')).toBeTruthy();
    state.sessionId = 's2'; view.rerender(tree());
    await waitFor(() => expect(contentTabs()).toEqual([sharedTab]));
    state.sessionId = 's1'; view.rerender(tree(false));
    await waitFor(() => expect(contentTabs()).toHaveLength(2));
  });
  it('closes a manually opened workspace file with Close other tabs and preserves an explicit pin', async () => {
    const view = render(tree());
    await openFile('c.txt');
    fireEvent.click(screen.getByRole('button', { name: '固定标签页' }));
    const pinnedTab = screen.getByRole('tab', { name: /c\.txt/ });
    await openFile('a.txt');
    state.request = { path: 'b.txt', nonce: 1, scope: 'session', ownerSessionId: 's1' };
    view.rerender(tree(false));
    const chatTab = await screen.findByRole('tab', { name: /b\.txt/ });
    fireEvent.contextMenu(chatTab);
    fireEvent.click(await screen.findByText('关闭其他标签页'));
    await waitFor(() => expect(contentTabs()).toEqual([pinnedTab, chatTab]));
  });
  it('opens a late chat file under its originating session rather than the current one', async () => {
    state.sessionId = 's2';
    const view = render(tree());
    state.request = { path: 'b.txt', nonce: 1, scope: 'session', ownerSessionId: 's1' };
    view.rerender(tree(false));
    await waitFor(() => expect(state.request).toBeNull());
    await waitFor(() => expect(state.cfg.rightWorkspace?.tabs.some((tab: any) => tab.content.path === 'b.txt' && tab.sessionId === 's1')).toBe(true));
    expect(screen.queryByRole('tab', { name: /b.txt/ })).toBeNull();
    state.sessionId = 's1'; view.rerender(tree());
    await waitFor(() => expect(contentTabs().some(tab => tab.textContent?.includes('b.txt'))).toBe(true));
  });
  it('closes archived session webpages and restores their tab entries without closing shared webpages', async () => {
    const api = currentApiMock();
    api.override('browser.close', async () => ({ ok: true }));
    state.sessions = [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }];
    state.cfg.rightWorkspace = { version: 1, panel: 'browser', collapsed: false, bookmarks: [], bookmarkDefaultsVersion: 1,
      tabs: [
        { id: 'own', workspaceId: 'ws', sessionId: 's1', scope: 'session', pinned: true, preview: false, content: { kind: 'web', browserId: 'owned-web', url: 'https://session.test/', title: 'Session page' } },
        { id: 'shared', workspaceId: 'ws', sessionId: 's1', scope: 'workspace', pinned: false, preview: false, content: { kind: 'web', browserId: 'shared-web', url: 'https://workspace.test/', title: 'Workspace page' } }
      ], selected: { s1: 'own' } };
    const view = render(tree());
    await waitFor(() => expect(contentTabs()).toHaveLength(2));
    state.sessions = [{ id: 's1', name: 'One', archived: true }, { id: 's2', name: 'Two' }];
    state.sessionId = 's2'; view.rerender(tree(false));
    await waitFor(() => expect(api.mockOf('browser.close')).toHaveBeenCalledWith({ id: 'owned-web' }));
    expect(api.mockOf('browser.close')).not.toHaveBeenCalledWith({ id: 'shared-web' });
    await waitFor(() => expect(state.cfg.rightWorkspace.tabs.find((tab: any) => tab.content.url === 'https://session.test/')?.suspended).toBe(true));
    expect(contentTabs().map(tab => tab.textContent)).toEqual([expect.stringContaining('Workspace page')]);
    state.sessions = [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }];
    state.sessionId = 's1'; view.rerender(tree());
    await waitFor(() => expect(contentTabs()).toHaveLength(2));
    expect(contentTabs().some(tab => tab.textContent?.includes('Session page'))).toBe(true);
  });
  it('finishes an in-flight browser close before a quickly restored session becomes visible', async () => {
    const api = currentApiMock();
    let finishClose!: (value: { ok: boolean }) => void;
    api.override('browser.close', () => new Promise(resolve => { finishClose = resolve; }));
    state.sessions = [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }];
    state.cfg.rightWorkspace = { version: 1, panel: 'browser', collapsed: false, bookmarks: [], bookmarkDefaultsVersion: 1,
      tabs: [{ id: 'own', workspaceId: 'ws', sessionId: 's1', pinned: false, preview: false, content: { kind: 'web', browserId: 'closing-web', url: 'https://session.test/', title: 'Session page' } }], selected: { s1: 'own' } };
    const view = render(tree()); await waitFor(() => expect(contentTabs()).toHaveLength(1));
    state.sessions = [{ id: 's1', name: 'One', archived: true }, { id: 's2', name: 'Two' }];
    state.sessionId = 's2'; view.rerender(tree(false));
    await waitFor(() => expect(api.mockOf('browser.close')).toHaveBeenCalledWith({ id: 'closing-web' }));
    state.sessions = [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }];
    state.sessionId = 's1'; view.rerender(tree());
    expect(screen.queryByRole('tab', { name: /Session page/ })).toBeNull();
    await act(async () => finishClose({ ok: true }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Session page/ })).toBeTruthy());
    expect(api.mockOf('browser.close')).toHaveBeenCalledTimes(1);
  });
  it('reports a failed browser close instead of claiming archive cleanup succeeded', async () => {
    const api = currentApiMock(); api.override('browser.close', async () => { throw new Error('close failed'); });
    state.sessions = [{ id: 's1', name: 'One' }];
    state.cfg.rightWorkspace = { version: 1, panel: 'browser', collapsed: false, bookmarks: [], bookmarkDefaultsVersion: 1,
      tabs: [{ id: 'own', workspaceId: 'ws', sessionId: 's1', pinned: false, preview: false, content: { kind: 'web', browserId: 'failing-web', url: 'https://session.test/', title: 'Session page' } }], selected: { s1: 'own' } };
    const view = render(tree()); await waitFor(() => expect(contentTabs()).toHaveLength(1));
    state.sessions = [{ id: 's1', name: 'One', archived: true }]; state.sessionId = 's2'; view.rerender(tree(false));
    await waitFor(() => expect(state.tip).toHaveBeenCalledWith(expect.stringContaining('close failed')));
    expect(api.mockOf('browser.close')).toHaveBeenCalledTimes(1);
  });
  it('persists the one-time defaults alongside existing workspace bookmarks', async () => {
    state.cfg.rightWorkspace = { version: 1, tabs: [], selected: {}, panel: 'browser', collapsed: false, bookmarks: [{ id: 'mine', label: '我的网站', url: 'https://mine.test/' }] };
    render(tree());
    await screen.findByRole('button', { name: '我的网站' });
    expect(bookmarks.bookmarkDefaultsVersion).toBe(1);
    expect(bookmarks.bookmarks.map(node => node.label)).toEqual(['我的网站', '工作', '娱乐', '阅读学习', '实用工具']);
    expect(bookmarks.bookmarks.find(node => node.label === '工作')?.children?.find(node => node.label === 'AI 聊天')?.children?.map(node => node.label)).toEqual(expect.arrayContaining(['DeepSeek', 'ChatGPT']));
    expect(state.patchCalls.every(patch => !patch.rightWorkspace?.bookmarks)).toBe(true);
  });
  it('reports when existing bookmarks leave no room for defaults', async () => {
    state.cfg.rightWorkspace = { version: 1, tabs: [], selected: {}, panel: 'browser', collapsed: false, bookmarks: Array.from({ length: 200 }, (_, index) => ({ id: `custom-${index}`, label: `自定义 ${index}`, url: `https://site${index}.test/` })) };
    render(tree());
    await waitFor(() => expect(state.tip).toHaveBeenCalledWith('默认收藏未添加：收藏夹层级或数量超过上限'));
    expect(bookmarks.bookmarks).toHaveLength(200);
  });
  it('enables sidebar home only after workspace tabs hydrate', async () => {
    state.ready = false;
    const view = render(tree());
    fireEvent.click(await resources().findByRole('tab', { name: '浏览器' }));
    const create = await screen.findByRole('button', { name: '打开主页' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    state.ready = true;
    view.rerender(tree(false));
    await waitFor(() => expect((screen.getByRole('button', { name: '打开主页', hidden: true }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('has no new-tab entry in the tab toolbar', async () => {
    render(tree());
    const toolbar = (await screen.findByRole('tablist', { name: '内容标签页' })).closest<HTMLElement>('.right-workspace-toolbar')!;
    expect(within(toolbar).queryByRole('button', { name: /新建/ })).toBeNull();
  });
  it('moves a sidebar bookmark into a folder through the context menu', async () => {
    state.cfg.rightWorkspace = { version: 1, tabs: [], selected: {}, panel: 'browser', collapsed: false, bookmarkDefaultsVersion: 1, bookmarks: [
      { id: 'folder', label: '项目资料', children: [] }, { id: 'page', label: '设计参考', url: 'https://design.test/' }
    ] };
    render(tree());
    fireEvent.contextMenu(await screen.findByRole('button', { name: '设计参考' }));
    fireEvent.click(await screen.findByText('移动到'));
    const submenus = await screen.findAllByRole('menu');
    fireEvent.click(within(submenus[submenus.length - 1]).getByRole('menuitem', { name: '项目资料' }));
    await waitFor(() => expect(bookmarks.bookmarks[0].children?.[0].id).toBe('page'));
    expect(screen.getByRole('button', { name: '项目资料' }).getAttribute('aria-expanded')).toBe('true');
  });
  it('uses the bookmark acknowledgement and keeps bookmark edits out of layout patches', async () => {
    state.cfg.rightWorkspace = { version: 1, tabs: [], selected: {}, panel: 'browser', collapsed: false, bookmarkDefaultsVersion: 1, bookmarks: [] };
    render(tree());
    await waitFor(() => expect(document.querySelector('.right-bookmark-tree')).toBeTruthy());
    fireEvent.contextMenu(document.querySelector('.right-bookmark-tree')!);
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '新建文件夹' }));
    const first = within(await screen.findByRole('dialog', { name: '新建文件夹' })).getByRole('textbox', { name: '名称' });
    fireEvent.change(first, { target: { value: '已保存' } }); fireEvent.submit(first.closest('form')!);
    await screen.findByRole('button', { name: '已保存' });
    expect(bookmarks.bookmarks[0].label).toBe('已保存');
    expect(state.patchCalls.every(patch => !patch.rightWorkspace?.bookmarks)).toBe(true);
    expect(state.tip).not.toHaveBeenCalledWith('标签页状态保存失败');
    bookmarkWriteError = 'disk full';
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建文件夹' })).toBeNull());
    fireEvent.contextMenu(document.querySelector('.right-bookmark-tree')!);
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '新建文件夹' }));
    const second = within(await screen.findByRole('dialog', { name: '新建文件夹' })).getByRole('textbox', { name: '名称' });
    fireEvent.change(second, { target: { value: '失败' } }); fireEvent.submit(second.closest('form')!);
    await waitFor(() => expect(getTipSnapshot()).toMatchObject({ tone: 'error', text: expect.stringContaining('收藏夹保存失败') }));
    expect(screen.queryByRole('button', { name: '失败' })).toBeNull();
  });
  it('keeps layout navigation available when the dedicated bookmark file cannot be read', async () => {
    currentApiMock().override('workspaceBookmarks.read', async () => ({ ok: false, error: 'Invalid bookmarks.json' }));
    render(tree());
    await waitFor(() => expect(getTipSnapshot()).toMatchObject({ tone: 'error', text: expect.stringContaining('Invalid bookmarks.json') }));
    await openFile('a.txt');
    expect(currentApiMock().mockOf('workspaceBookmarks.change')).not.toHaveBeenCalled();
  });
  it('updates the undo and redo counts and reuses one preview after navigating a new branch', async () => {
    render(tree()); await openFile('a.txt'); await openFile('b.txt'); await openFile('c.txt');
    const undo = screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement;
    const redo = screen.getByRole('button', { name: '重做' }) as HTMLButtonElement;
    const original = contentTabs()[0];
    expect(undo.title).toBe('撤销（可撤销 3 步）'); expect(redo.disabled).toBe(true);
    fireEvent.click(undo);
    await waitFor(() => expect(redo.title).toBe('重做（可重做 1 步）'));
    expect(contentTabs()).toEqual([original]); expect(original.textContent).toContain('b.txt');
    expect(undo.title).toBe('撤销（可撤销 2 步）');
    fireEvent.click(redo);
    await waitFor(() => expect(undo.title).toBe('撤销（可撤销 3 步）'));
    expect(contentTabs()).toEqual([original]); expect(original.textContent).toContain('c.txt');
    fireEvent.click(undo); await waitFor(() => expect(redo.disabled).toBe(false));
    await openFile('a.txt');
    expect(contentTabs()).toEqual([original]); expect(original.textContent).toContain('a.txt');
    expect(undo.title).toBe('撤销（可撤销 3 步）'); expect(redo.disabled).toBe(true);
  });

  it('tree clicks reuse a preview; double click and editing keep it', async () => {
    render(tree()); await openFile('a.txt'); expect(contentTabs()).toHaveLength(1); expect(contentTabs()[0].classList.contains('is-preview')).toBe(true);
    await openFile('b.txt'); expect(contentTabs()).toHaveLength(1);
    fireEvent.doubleClick(await within(document.querySelector('.right-files-resources')!).findByTitle('b.txt'));
    await waitFor(() => expect(contentTabs()[0].classList.contains('is-preview')).toBe(false));
    await openFile('c.txt'); expect(contentTabs()).toHaveLength(2);
    await editCurrent(); await waitFor(() => expect(contentTabs()[1].classList.contains('is-preview')).toBe(false));
  });
  it('double clicking a different file replaces and keeps the pending preview', async () => {
    render(tree()); await openFile('a.txt');
    const row = await within(document.querySelector('.right-files-resources')!).findByTitle('b.txt');
    fireEvent.click(row); fireEvent.click(row); fireEvent.doubleClick(row);
    await waitFor(() => expect(contentTabs()[0].textContent).toContain('b.txt'));
    expect(contentTabs()).toHaveLength(1); expect(contentTabs()[0].classList.contains('is-preview')).toBe(false);
  });
  it('separates tabs from current tools and shows the full file path', async () => {
    render(tree()); await openFile('a.txt');
    expect(document.querySelector('.right-tabs-row .right-tab-strip')).toBeTruthy();
    const tools = screen.getByRole('toolbar', { name: '当前内容工具' });
    await within(tools).findByRole('button', { name: '保存' });
    expect(within(tools).getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(within(tools).getByRole('button', { name: '预览' })).toBeTruthy();
    expect(within(tools).getByRole('button', { name: '复制完整路径' })).toBeTruthy();
    expect(document.querySelector('.right-full-path')?.textContent).toBe('E:/ws/a.txt');
    expect(document.querySelector('.right-tabs-row .right-content-tools')).toBeNull();
    expect(document.querySelector('.right-tabs-row .right-history')).toBeTruthy();
    expect(within(tools).queryByRole('button', { name: '撤销' })).toBeNull();
    expect(tools.closest('.split-pane-secondary')).toBeTruthy();
    expect(document.querySelector('.split-pane-primary [role="toolbar"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '固定标签页' }));
    expect(contentTabs()[0].classList.contains('is-preview')).toBe(false);
    expect(screen.getByRole('button', { name: '取消固定' })).toBeTruthy();
  });
  it('accepts dragged file paths through the resource capsule without replacing a kept review', async () => {
    render(tree()); await openFile('a.txt'); await editCurrent();
    currentApiMock().override('fs.resolveRef', async (_ws: string, path: string) => ({ ok: true, fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: path.replace('E:/ws/', '') } }));
    fireEvent.drop(resources().getByRole('tab', { name: '文件' }), { dataTransfer: { types: ['application/x-muster-paths'], getData: (type: string) => type === 'application/x-muster-paths' ? '["E:/ws/b.txt"]' : '', files: [] } });
    await waitFor(() => expect(contentTabs()).toHaveLength(2)); expect(contentTabs()[1].textContent).toContain('b.txt');
    expect(contentTabs()[1].classList.contains('is-preview')).toBe(false);
  });
  it('does not attribute a hidden editor selection to the current file', async () => {
    render(tree()); await openFile('a.txt'); await editCurrent();
    const oldLine = document.querySelector('.right-content-page.is-shown .cm-line')!;
    await openFile('b.txt'); await waitFor(() => expect(document.querySelector('.right-content-page.is-shown .cm-line')?.textContent).toBe('content b.txt'));
    const selection = window.getSelection()!; const range = document.createRange(); range.selectNodeContents(oldLine); selection.removeAllRanges(); selection.addRange(range);
    expect(captureFileNote()).toBeNull();
    range.selectNodeContents(document.querySelector('.right-content-page.is-shown .cm-line')!); selection.removeAllRanges(); selection.addRange(range);
    expect(captureFileNote()?.fileRef).toMatchObject({ rootId: 'a', relativePath: 'b.txt' }); selection.removeAllRanges();
  });
  it('capsule only changes resources; tab selection follows resources without expanding a collapsed tree', async () => {
    const view = render(tree()); await openFile('a.txt');
    const editor = document.querySelector('.cm-editor'), native = screen.getByTestId('native-owner');
    fireEvent.click(resources().getByRole('tab', { name: '浏览器' })); expect(contentTabs()[0].getAttribute('aria-selected')).toBe('true'); expect(document.querySelector('.cm-editor')).toBe(editor);
    fireEvent.click(screen.getByRole('button', { name: '收起资源面板' }));
    fireEvent.click(contentTabs()[0]); expect(resources().getByRole('tab', { name: '文件' }).getAttribute('aria-selected')).toBe('true'); expect(screen.getByRole('button', { name: '展开资源面板' })).toBeTruthy();
    await act(async () => { view.rerender(tree(false)); }); expect(screen.getByTestId('native-owner')).toBe(native);
  });
  it('pinning a session tab preserves its owner and keeps its editor mounted across switches', async () => {
    const view = render(tree()); await openFile('a.txt'); await editCurrent();
    const editor = document.querySelector('.cm-editor');
    state.request = { path: 'b.txt', nonce: 1 }; view.rerender(tree(false));
    await waitFor(() => expect(contentTabs()).toHaveLength(2)); await editCurrent();
    const chatTab = screen.getByRole('tab', { name: /b\.txt/ });
    const chatEditor = document.querySelector('.right-content-page.is-shown .cm-editor');
    fireEvent.click(screen.getByRole('button', { name: '固定标签页' }));
    expect(within(chatTab).getByTitle('跟随会话')).toBeTruthy();
    state.sessionId = 's2'; view.rerender(tree());
    await waitFor(() => expect(contentTabs()).toHaveLength(1)); expect(contentTabs()[0].textContent).toContain('a.txt');
    expect(document.querySelector('.cm-editor')).toBe(editor);
    state.sessionId = 's1'; view.rerender(tree(false)); await waitFor(() => expect(contentTabs()).toHaveLength(2));
    expect(screen.getByRole('tab', { name: /b\.txt/ }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.right-content-page.is-shown .cm-editor')).toBe(chatEditor);
  });
  it('opening a chat attachment keeps the review file and deduplicates an existing tab', async () => {
    const view = render(tree()); await openFile('a.txt'); await editCurrent();
    state.request = { path: 'b.txt', nonce: 1 }; view.rerender(tree(false)); await waitFor(() => expect(contentTabs()).toHaveLength(2));
    expect(contentTabs()[1].classList.contains('is-preview')).toBe(false);
    state.request = { path: 'b.txt', nonce: 2 }; view.rerender(tree()); await waitFor(() => expect(state.request).toBeNull()); expect(contentTabs()).toHaveLength(2);
  });
  it('a search-result keep request promotes and replaces the temporary preview', async () => {
    const view = render(tree()); await openFile('a.txt');
    state.request = { path: 'b.txt', nonce: 1, source: 'keep', replacePreview: true, scope: 'workspace' }; view.rerender(tree(false));
    await waitFor(() => expect(contentTabs()[0].textContent).toContain('b.txt'));
    expect(contentTabs()).toHaveLength(1); expect(contentTabs()[0].classList.contains('is-preview')).toBe(false);
  });
  it('back restores a replaced preview without overwriting the current editor', async () => {
    render(tree()); await openFile('a.txt'); await openFile('b.txt'); const editor = await editCurrent();
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved review draft' } }));
    fireEvent.click(screen.getByRole('button', { name: '撤销' })); await waitFor(() => expect(contentTabs()).toHaveLength(2));
    expect(contentTabs().find(tab => tab.textContent?.includes('a.txt'))?.getAttribute('aria-selected')).toBe('true'); expect(editor.state.doc.toString()).toBe('unsaved review draft');
    fireEvent.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expect(contentTabs()).toHaveLength(1));
    expect(contentTabs()[0].textContent).toContain('b.txt');
  });
  it('a failed flush blocks closing and keeps the editor draft', async () => {
    render(tree()); await openFile('a.txt'); const editor = await editCurrent();
    currentApiMock().override('fs.writeTextRef', async () => ({ ok: false, error: 'disk full' }));
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'draft must survive' } }));
    fireEvent.click(screen.getByRole('button', { name: '关闭标签页 a.txt' }));
    await waitFor(() => expect(state.tip).toHaveBeenCalled()); expect(contentTabs()).toHaveLength(1); expect(editor.state.doc.toString()).toBe('draft must survive');
  });
  it('supports keyboard navigation, middle-click and Delete close, undo and drag ordering', async () => {
    render(tree());
    for (const path of ['a.txt', 'b.txt', 'c.txt']) { await openFile(path); await editCurrent(); }
    fireEvent.keyDown(contentTabs()[2], { key: 'Home' }); expect(contentTabs()[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(contentTabs()[0], { key: 'ArrowRight' }); expect(contentTabs()[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(contentTabs()[1], { key: 'End' }); expect(contentTabs()[2].getAttribute('aria-selected')).toBe('true');
    fireEvent(contentTabs()[1], new MouseEvent('auxclick', { button: 1, bubbles: true }));
    await waitFor(() => expect(contentTabs()).toHaveLength(2)); expect(contentTabs()[1].textContent).toContain('c.txt');
    fireEvent.keyDown(contentTabs()[1], { key: 'Delete' }); await waitFor(() => expect(contentTabs()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(contentTabs()).toHaveLength(2)); expect(contentTabs()[1].textContent).toContain('c.txt');
    fireEvent.dragStart(contentTabs()[1], { dataTransfer: { setData: vi.fn() } }); fireEvent.drop(contentTabs()[0]);
    expect(contentTabs()[0].textContent).toContain('c.txt'); expect(contentTabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(contentTabs()[1].textContent).toContain('a.txt');
  });
  it('opens remote bookmarks in a browser tab without calling the host', async () => {
    vi.mocked(isWebGateway).mockReturnValue(true);
    const api = currentApiMock();
    api.override('browser.open', async () => { throw new Error('网页访问不支持通道: browser:open'); });
    state.cfg.rightWorkspace = { version: 1, tabs: [], selected: {}, panel: 'browser', collapsed: false, bookmarkDefaultsVersion: 1, bookmarks: [
      { id: 'page', label: '设计参考', url: 'https://design.test/' },
      { id: 'file', label: '宿主文件', url: 'file:///example.txt' }
    ] };
    render(tree());
    const row = await screen.findByText('设计参考');
    expect(screen.queryByTestId('native-owner')).toBeNull();
    expect(api.mockOf('browser.retainPanelHistory')).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(row); });
    expect(api.mockOf('browser.open')).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: '设计参考' });
    expect(link.getAttribute('href')).toBe('https://design.test/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.click(screen.getByRole('button', { name: '宿主文件' }));
    expect(state.tip).toHaveBeenCalledWith('请在桌面应用中打开此收藏');
    fireEvent.click(screen.getByRole('button', { name: '打开主页' }));
    expect(state.tip).toHaveBeenCalledWith('内置浏览器仅在 Muster 桌面应用中可用。请在桌面应用中继续此操作。');
    expect(screen.queryByRole('tab', { name: '新建标签页' })).toBeNull();
    expect(api.mockOf('browser.open')).not.toHaveBeenCalled();
    fireEvent.contextMenu(link);
    expect(await screen.findByText('重命名', { exact: true })).toBeTruthy();
  });
  it('organizes bookmark folders and opens bookmarks with the current chat owner', async () => {
    state.cfg.rightWorkspace = { version: 1, tabs: [], selected: {}, panel: 'browser', collapsed: false, bookmarkDefaultsVersion: 1, bookmarks: [{ id: 'folder', label: '项目资料', children: [{ id: 'page', label: '设计参考', url: 'https://design.test/' }] }] };
    render(tree());
    const folder = await screen.findByRole('button', { name: '项目资料' });
    expect(screen.queryByRole('button', { name: '设计参考' })).toBeNull();
    fireEvent.click(folder); fireEvent.click(await screen.findByRole('button', { name: '设计参考' }));
    expect(currentApiMock().mockOf('browser.open')).toHaveBeenCalledWith({ url: 'https://design.test/', workspaceId: 'ws', sessionId: 's1', scope: 'workspace' });
    fireEvent.contextMenu(folder); fireEvent.click(await screen.findByText('重命名'));
    const input = await screen.findByRole('textbox', { name: '名称' }); fireEvent.change(input, { target: { value: '开发资料' } }); fireEvent.submit(input.closest('form')!);
    await screen.findByRole('button', { name: '开发资料' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '重命名' })).toBeNull());
    fireEvent.contextMenu(document.querySelector('.right-bookmark-tree')!);
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '新建文件夹' }));
    const name = await screen.findByRole('textbox', { name: '名称' }); fireEvent.change(name, { target: { value: '参考' } }); fireEvent.submit(name.closest('form')!);
    await screen.findByRole('button', { name: '参考' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建文件夹' })).toBeNull());
    fireEvent.contextMenu(screen.getByRole('button', { name: '开发资料' })); fireEvent.click(await screen.findByText('删除', { exact: true }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '删除收藏？' })).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '开发资料' })).toBeNull());
    expect(screen.queryByRole('button', { name: '设计参考' })).toBeNull(); expect(screen.getByRole('button', { name: '参考' })).toBeTruthy();
  });
  it('only shields the selected extension when the right screen is visible but inactive', async () => {
    const navigation = { workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 0, revision: 1, libraryExpanded: true, nodes: ['a', 'b'].map(id => ({ id, title: id, kind: 'extension' as const, extensionId: id, viewId: 'panel', parentId: null, placement: 'tab' as const })) };
    currentApiMock().override('workbench.navigation', async () => navigation);
    const view = render(tree(false));
    await waitFor(() => expect(view.container.querySelectorAll('.extension-tab-peek')).toHaveLength(1));
    expect(view.container.querySelector('.right-content-page.is-shown .extension-tab-peek')).toBeTruthy();
    expect(view.container.querySelector('[aria-hidden="true"] .extension-tab-peek')).toBeNull();
    await act(async () => view.rerender(tree(true))); expect(view.container.querySelector('.extension-tab-peek')).toBeNull();
    await act(async () => view.rerender(tree(false, false))); expect(view.container.querySelector('.extension-tab-peek')).toBeNull();
    await act(async () => view.rerender(tree(false))); expect(view.container.querySelectorAll('.extension-tab-peek')).toHaveLength(1);
    await act(async () => currentApiMock().emit('workbench:changed', { ...navigation, revision: 2, nodes: [] }));
  });
  it('undoes and redoes closing an extension through its placement', async () => {
    const api = currentApiMock();
    const node = { id: 'board', title: '扩展看板', kind: 'extension', extensionId: 'board', viewId: 'panel', parentId: null, placement: 'tab' } as const;
    let navigation = { workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 10, revision: 1, libraryExpanded: true,
      nodes: [{ ...node, placement: 'tab' as 'tab' | 'center' }] };
    api.override('workbench.navigation', async () => navigation);
    api.override('workbench.saveNavigation', async (next: typeof navigation) => {
      navigation = { ...next, revision: navigation.revision + 1 };
      return navigation;
    });
    render(tree());
    fireEvent.click(await screen.findByRole('button', { name: '关闭标签页 扩展看板' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /扩展看板/ })).toBeNull());
    expect(navigation.nodes[0].placement).toBe('center');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await screen.findByRole('tab', { name: /扩展看板/ });
    expect(navigation.nodes[0].placement).toBe('tab');
    fireEvent.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /扩展看板/ })).toBeNull());
    expect(navigation.nodes[0].placement).toBe('center');
  });
});
it('presents only the explicitly owned hidden browser tab without duplicating it', async () => {
  const content = {kind:'web' as const,browserId:'hidden-browser',url:'http://127.0.0.1:8734/index.html',title:'Preview'};
  state.cfg.rightWorkspace = {version:1,tabs:[{id:'hidden-tab',workspaceId:'ws',sessionId:'extension-agent',scope:'session',pinned:false,preview:false,origin:'agent',content}],selected:{}};
  render(tree());
  await waitFor(() => expect(readRightPanelState('ws')).toBeTruthy());
  expect(readRightPanelState('ws').tabs).toHaveLength(0);
  await expect(openAgentRightContent('ws',{...content,ownerSessionId:'someone-else'},true)).rejects.toThrow(/unavailable or changed/);
  await expect(openAgentRightContent('ws',{...content,ownerSessionId:'extension-agent'},false)).rejects.toThrow(/requires/);
  await expect(openAgentRightContent('ws',{...content,url:'https://changed.test/',ownerSessionId:'extension-agent'},true)).rejects.toThrow(/unavailable or changed/);
  const stopDirty = registerFileEditorState(() => ({workspaceId:'ws',path:'draft.txt',active:true,editing:true,unsaved:true}));
  try { await expect(openAgentRightContent('ws',{...content,ownerSessionId:'extension-agent'},true)).rejects.toThrow(/unsaved/); }
  finally {stopDirty();}
  expect(readRightPanelState('ws').tabs).toHaveLength(0);
  let result!: Awaited<ReturnType<typeof openAgentRightContent>>;
  await act(async () => {result = await openAgentRightContent('ws',{...content,ownerSessionId:'extension-agent'},true);});
  expect(result).toEqual({tabId:expect.any(String),existing:true,selected:true});
  expect(readRightPanelState('ws').tabs).toHaveLength(1);
  expect(readRightPanelState('ws').tabs[0].content).toEqual(content);
});
