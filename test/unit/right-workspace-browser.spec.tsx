import React, { useMemo, useReducer, useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrowserPage } from '../../src/renderer/src/components/BrowserPage';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { RightWorkspaceContext } from '../../src/renderer/src/rightWorkspace';
import { activeRightTab, initialRightWorkspace, reduceRightWorkspace, visibleRightTabs, type RightAction, type RightWorkspaceModel } from '../../src/shared/rightWorkspace';
import { currentApiMock } from './helpers/api-mock';
let send: React.Dispatch<RightAction>, state: RightWorkspaceModel;
const web = (id: string, url = `https://test.local/${id}`) => ({ id, url, title: id, workspaceId: 'ws', sessionId: 's1', favicon: null, loading: false, canGoBack: false, canGoForward: false });
function Harness({ visible = true }: { visible?: boolean }): React.JSX.Element {
  const { sideDockRequest } = useUiStore();
  const [model, dispatch] = useReducer(reduceRightWorkspace, undefined, () => {
    let model = reduceRightWorkspace(initialRightWorkspace('ws', 's1'), { type: 'hydrate', workspaceId: 'ws' });
    return reduceRightWorkspace(model, { type: 'open', content: { kind: 'file', path: 'review.ts', fileRef: { workspaceId: 'ws', rootId: 'a', relativePath: 'review.ts' } } });
  });
  send = dispatch; state = model;
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [location, setLocation] = useState<HTMLDivElement | null>(null);
  const current = activeRightTab(model);
  const bridge = useMemo(() => ({ model, current, toolbar, location, resourceHosts: { files: null, git: null, browser: null }, dispatch, registerFile: () => {}, open: () => {} }), [model, current, toolbar, location]);
  return <RightWorkspaceContext.Provider value={bridge}><output data-testid="workspace-show-request">{sideDockRequest?.dock ?? ''}</output><div ref={setToolbar}/><div ref={setLocation}/><BrowserPage active={visible && current?.content.kind === 'web'} shown={visible && current?.content.kind === 'web'} sideTab="browser" onSideTab={() => {}}/></RightWorkspaceContext.Provider>;
}
describe('unified browser owner', () => {
  it.each(['session', 'workspace'] as const)('inherits the %s scope of a popup opener independently of pinning', async (scope) => {
    const api = currentApiMock();
    const parentPage = { ...web('parent'), scope };
    api.override('browser.restore', async () => ({ tabs: [parentPage], activeId: 'parent' }));
    render(<StoreProvider><Harness/></StoreProvider>);
    await waitFor(() => expect(state.tabs.some(tab => tab.content.kind === 'web')).toBe(true));
    const parent = state.tabs.find(tab => tab.content.kind === 'web')!;
    if (scope === 'session') act(() => send({ type: 'pin', id: parent.id }));
    expect(api.mockOf('browser.setOwner')).not.toHaveBeenCalled();
    act(() => api.emit('browser:tabs', { tabs: [parentPage, { ...web('child'), scope, openerId: 'parent' }], activeId: 'child' }));
    await waitFor(() => expect(state.tabs.find(tab => tab.content.kind === 'web' && tab.content.browserId === 'child')).toMatchObject({ scope, pinned: false, sessionId: 's1' }));
    act(() => send({ type: 'scope', workspaceId: 'ws', sessionId: 's2' }));
    expect(visibleRightTabs(state).filter(tab => tab.content.kind === 'web')).toHaveLength(scope === 'workspace' ? 2 : 0);
  });
  it('does not rebind a retired guest from a late native snapshot after unarchiving', async () => {
    const api = currentApiMock();
    api.override('browser.restore', async () => ({ tabs: [web('old')], activeId: 'old' }));
    api.override('browser.open', async () => ({ id: 'replacement' }));
    render(<StoreProvider><Harness/></StoreProvider>);
    await waitFor(() => expect(state.tabs.some(tab => tab.content.kind === 'web')).toBe(true));
    const id = state.tabs.find(tab => tab.content.kind === 'web')!.id;
    act(() => {
      send({ type: 'suspend', id });
      send({ type: 'releaseWeb', id, browserId: 'old' });
      send({ type: 'resume', id });
      send({ type: 'select', id });
    });
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledWith({ url: 'https://test.local/old', workspaceId: 'ws', sessionId: 's1', scope: 'session', background: true, restoreShell: true }));
    expect(state.tabs.find(tab => tab.id === id)?.content).not.toMatchObject({ browserId: 'old' });
  });
  it('tracks session-owned background pages from a workspace that is not hydrated', async () => {
    const api = currentApiMock(); api.override('browser.restore', async () => ({ tabs: [], activeId: null }));
    render(<StoreProvider><Harness/></StoreProvider>);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    act(() => api.emit('browser:tabs', { tabs: [{ ...web('remote'), workspaceId: 'other', sessionId: 'remote-chat', scope: 'session', openInBackground: true }], activeId: null }));
    await waitFor(() => expect(state.tabs.find(tab => tab.content.kind === 'web' && tab.content.browserId === 'remote')).toMatchObject({ workspaceId: 'other', sessionId: 'remote-chat', pinned: false }));
    expect(activeRightTab(state)?.content.kind).toBe('file');
  });
  it('renders the user new tab inside the workbench without creating a guest or exposing its internal address', async () => {
    const api = currentApiMock(), home = web('home', 'muster-home://new/example-home');
    api.override('browser.restore', async () => ({ tabs: [home], activeId: 'home' }));
    const view = render(<StoreProvider><Harness/></StoreProvider>);
    await waitFor(() => expect(state.tabs).toHaveLength(2));
    act(() => send({ type: 'select', id: state.tabs.find(tab => tab.content.kind === 'web')!.id }));
    expect(await view.findByRole('textbox', { name: '搜索收藏或网页' })).toBeTruthy();
    expect(view.container.querySelector('webview')).toBeNull();
    expect((view.getByRole('textbox', { name: '地址栏' }) as HTMLInputElement).value).toBe('');
    expect((view.getByRole('button', { name: '收藏当前网页' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('automatically reveals the CLI UI page and reuses native GUI cards without creating a webview', async () => {
    const api = currentApiMock();
    const tab = web('ui', 'muster-ui://session/s1');
    api.override('browser.restore', async () => ({ tabs: [tab], activeId: 'ui' }));
    api.override('uiWidgets.list', async () => []);
    const view = render(<StoreProvider><Harness/></StoreProvider>);
    await waitFor(() => expect(state.tabs).toHaveLength(2));
    await act(async () => api.emit('uiWidget:present', { sessionId: 's1', tabId: 'ui' }));
    await waitFor(() => expect(activeRightTab(state)?.content).toMatchObject({ browserId: 'ui' }));
    await waitFor(() => expect(view.container.querySelector('.ui-session-page')).toBeTruthy());
    expect(view.container.querySelector('webview')).toBeNull();
    expect(view.getByTestId('workspace-show-request').textContent).toBe('git');
    act(() => send({ type: 'scope', workspaceId: 'ws', sessionId: 's2' }));
    await act(async () => api.emit('uiWidget:present', { sessionId: 's1', tabId: 'ui' }));
    expect(activeRightTab(state)).toBeUndefined();
  });
  it('after an empty restore, the first newly opened artifact focuses and mounts its page', async () => {
    const api = currentApiMock(); api.override('browser.restore', async () => ({ tabs: [], activeId: null }));
    const view = render(<StoreProvider><Harness/></StoreProvider>);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    act(() => api.emit('browser:tabs', { tabs: [web('artifact-first', 'muster-ext://f/fixture.html')], activeId: 'artifact-first' }));
    await waitFor(() => expect(activeRightTab(state)?.content).toMatchObject({ kind: 'web', browserId: 'artifact-first' }));
    await waitFor(() => expect(view.container.querySelector('webview[data-tab-id="artifact-first"]')).toBeTruthy());
    expect(view.getByTestId('workspace-show-request').textContent).toBe('git');
  });
  it('restores another project\'s pinned page once after that project hydrates', async () => {
    const api = currentApiMock();
    api.override('browser.restore', async () => ({ tabs: [{ ...web('bt-other'), workspaceId: 'other' }], activeId: 'bt-other' }));
    render(<StoreProvider><Harness/></StoreProvider>);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    act(() => {
      send({ type: 'scope', workspaceId: 'other', sessionId: 's2' });
      send({ type: 'hydrate', workspaceId: 'other', saved: { version: 1, tabs: [{ id: 'saved', workspaceId: 'other', sessionId: 's1', scope: 'workspace', pinned: true, preview: false, content: { kind: 'web', browserId: '', url: 'https://test.local/bt-other', title: 'Pinned page' } }], selected: { s2: 'saved' }, panel: 'browser', collapsed: false, bookmarks: [] } });
    });
    await waitFor(() => expect(activeRightTab(state)?.content).toMatchObject({ browserId: 'bt-other' }));
    expect(state.tabs.filter(tab => tab.workspaceId === 'other' && tab.content.kind === 'web')).toHaveLength(1);
    expect(activeRightTab(state)!.pinned).toBe(true);
    expect(api.mockOf('browser.open')).not.toHaveBeenCalled();
  });
  it('restored browser shells do not select over a review file; native guests survive chat changes', async () => {
    currentApiMock().override('browser.restore', async () => ({ tabs: [web('bt1')], activeId: 'bt1' }));
    const view = render(<StoreProvider><Harness/></StoreProvider>);
    await waitFor(() => expect(state.tabs).toHaveLength(2)); expect(activeRightTab(state)!.content.kind).toBe('file');
    expect(view.getByTestId('workspace-show-request').textContent).toBe('');
    const tab = state.tabs.find(tab => tab.content.kind === 'web')!;
    act(() => send({ type: 'select', id: tab.id })); await waitFor(() => expect(view.container.querySelector('webview')).toBeTruthy());
    const guest = view.container.querySelector('webview');
    act(() => send({ type: 'scope', workspaceId: 'ws', sessionId: 's2' })); expect(guest!.isConnected).toBe(true); expect((guest as HTMLElement).style.visibility).toBe('hidden');
    act(() => send({ type: 'scope', workspaceId: 'ws', sessionId: 's1' })); expect(view.container.querySelector('webview')).toBe(guest); expect((guest as HTMLElement).style.visibility).toBe('visible');
  });
  it('native opens after switching chats retain their original owner', async () => {
    const api = currentApiMock(); api.override('browser.restore', async () => ({ tabs: [], activeId: null }));
    render(<StoreProvider><Harness/></StoreProvider>);
    act(() => send({ type: 'scope', workspaceId: 'ws', sessionId: 's2' }));
    act(() => api.emit('browser:tabs', { tabs: [web('bt2')], activeId: 'bt2' }));
    await waitFor(() => expect(state.tabs.some(tab => tab.content.kind === 'web')).toBe(true));
    expect(activeRightTab(state)).toBeUndefined(); expect(state.tabs.find(tab => tab.content.kind === 'web')!.sessionId).toBe('s1');
  });
  it('projects only committed native positions, including same-URL navigation, without loading a URL on replay', async () => {
    const api = currentApiMock(), page = { ...web('bt1'), panelHistoryKey: 'initial', panelHistoryUserNavigation: true };
    api.override('browser.restore', async () => ({ tabs: [page], activeId: 'bt1' }));
    render(<StoreProvider><Harness/></StoreProvider>);
    await waitFor(() => expect(state.tabs).toHaveLength(2)); const id = state.tabs.find(tab => tab.content.kind === 'web')!.id;
    act(() => send({ type: 'select', id }));
    const scope = JSON.stringify(['ws', 's1']);
    act(() => api.emit('browser:tabs', { tabs: [{ ...page, panelHistoryKey: undefined, url: 'https://test.local/pending' }], activeId: 'bt1' }));
    expect(activeRightTab(state)?.content).toMatchObject({ url: page.url });
    expect(state.histories[scope].index).toBe(1);
    act(() => api.emit('browser:tabs', { tabs: [{ ...page, panelHistoryKey: 'same-url' }], activeId: 'bt1' }));
    expect(activeRightTab(state)?.webHistoryKey).toBe('same-url');
    expect(state.histories[scope].index).toBe(2);
    act(() => {
      send({ type: 'history', dir: -1 });
      api.emit('browser:tabs', { tabs: [{ ...page, panelHistoryUserNavigation: false }], activeId: 'bt1' });
    });
    expect(activeRightTab(state)).toMatchObject({ id, webHistoryKey: 'initial' });
    expect(state.histories[scope]).toMatchObject({ index: 1, entries: expect.arrayContaining([expect.anything(), expect.anything()]) });
    expect(api.mockOf('browser.navigate')).not.toHaveBeenCalled();
  });
  it('shows a readable address until focus and retains the full URL for navigation', async () => {
    const api = currentApiMock(), url = 'https://test.local/%E8%AE%BE%E8%AE%A1?q=prototype';
    api.override('browser.restore', async () => ({ tabs: [web('bt1', url)], activeId: 'bt1' }));
    const view = render(<StoreProvider><Harness/></StoreProvider>); await waitFor(() => expect(state.tabs).toHaveLength(2));
    act(() => send({ type: 'select', id: state.tabs.find(tab => tab.content.kind === 'web')!.id }));
    const input = await view.findByRole('textbox', { name: '地址栏' }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(url));
    expect(view.container.querySelector('.browser-address-display')?.textContent).toBe('https://test.local/设计?q=prototype');
    fireEvent.focus(input); expect(view.container.querySelector('.browser-address-display')).toBeNull(); expect(input.value).toBe(url);
    fireEvent.change(input, { target: { value: 'https://test.local/next' } }); fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.mockOf('browser.navigate')).toHaveBeenCalledWith({ id: 'bt1', input: 'https://test.local/next' }));
  });
  it('native activation selects an existing web tab without stealing another chat', async () => {
    const api = currentApiMock(); api.override('browser.restore', async () => ({ tabs: [web('bt1'), web('bt2')], activeId: 'bt1' }));
    render(<StoreProvider><Harness/></StoreProvider>); await waitFor(() => expect(state.tabs).toHaveLength(3));
    act(() => api.emit('browser:tabs', { tabs: [web('bt1'), web('bt2')], activeId: 'bt2' }));
    await waitFor(() => expect(activeRightTab(state)!.content).toMatchObject({ browserId: 'bt2' }));
    act(() => send({ type: 'scope', workspaceId: 'ws', sessionId: 's2' }));
    act(() => api.emit('browser:tabs', { tabs: [web('bt1'), web('bt2')], activeId: 'bt1' }));
    expect(activeRightTab(state)).toBeUndefined();
  });
  it('a native close removes its content tab and restores the neighboring review file', async () => {
    const api = currentApiMock(); api.override('browser.restore', async () => ({ tabs: [web('bt1')], activeId: 'bt1' }));
    render(<StoreProvider><Harness/></StoreProvider>); await waitFor(() => expect(state.tabs).toHaveLength(2));
    act(() => send({ type: 'select', id: state.tabs.find(tab => tab.content.kind === 'web')!.id }));
    act(() => api.emit('browser:tabs', { tabs: [], activeId: null }));
    await waitFor(() => expect(state.tabs).toHaveLength(1)); expect(activeRightTab(state)!.content.kind).toBe('file');
  });
  it('keeps one native allocation for an unbound right tab when visibility changes', async () => {
    const api = currentApiMock(), original = web('original');
    api.override('browser.restore', async () => ({ tabs: [], activeId: null }));
    let finishOpen!: (result: { id: string }) => void;
    api.override('browser.open', () => new Promise(resolve => { finishOpen = resolve; }));
    const tree = (visible: boolean) => <StoreProvider><Harness visible={visible}/></StoreProvider>;
    const view = render(tree(true));
    await waitFor(() => expect(api.mockOf('browser.restore')).toHaveBeenCalled());
    act(() => send({ type: 'open', content: { kind: 'web', browserId: '', url: original.url, title: original.title } }));
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledTimes(1));
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect(api.mockOf('browser.open')).toHaveBeenCalledTimes(1);
    act(() => api.emit('browser:tabs', { tabs: [{ ...original, id: 'restored', scope: 'session', openInBackground: true }], activeId: null }));
    expect(state.tabs.filter(tab => tab.content.kind === 'web')).toHaveLength(1);
    await act(async () => finishOpen({ id: 'restored' }));
    expect(activeRightTab(state)?.content).toMatchObject({ browserId: 'restored' });
  });
  it('closes a late native allocation if its pending right tab was closed', async () => {
    const api = currentApiMock(), original = web('original');
    api.override('browser.restore', async () => ({ tabs: [], activeId: null }));
    api.override('browser.close', async () => ({ ok: true }));
    let finishOpen!: (result: { id: string }) => void;
    api.override('browser.open', () => new Promise(resolve => { finishOpen = resolve; }));
    render(<StoreProvider><Harness/></StoreProvider>);
    await waitFor(() => expect(api.mockOf('browser.restore')).toHaveBeenCalled());
    act(() => send({ type: 'open', content: { kind: 'web', browserId: '', url: original.url, title: original.title } }));
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledTimes(1));
    const rightId = activeRightTab(state)!.id;
    act(() => send({ type: 'close', ids: [rightId] }));
    act(() => api.emit('browser:tabs', { tabs: [{ ...original, id: 'late', scope: 'session', openInBackground: true }], activeId: null }));
    await act(async () => finishOpen({ id: 'late' }));
    expect(api.mockOf('browser.close')).toHaveBeenCalledWith({ id: 'late' });
    expect(activeRightTab(state)?.content.kind).toBe('file');
    expect(state.tabs.filter(tab => tab.content.kind === 'web')).toHaveLength(0);
  });
});
