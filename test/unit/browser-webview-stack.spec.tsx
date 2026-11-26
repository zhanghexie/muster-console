/**
 * BrowserPage webview 栈（2026-10-08 webview 化迁移）：
 * - 懒挂载：restore 载荷里只有激活 tab 挂 <webview>，未激活 tab 不挂；
 *   mount-request（agent 操作后台标签）补挂
 * - 可见性：激活+shown 原生可交互，后台仅停放样式（固定非零布局、inert、保同一 DOM）
 * - did-attach 上报：dom-ready 后按 getWebContentsId 调 browser.guestAttach；
 *   卸载（关 tab）时 guestDetach
 * - 露条手势层：shown&&!active 时截获 pointer（dispatchPeekPointer 转发 move/down），
 *   wheel 走 browser.wheelForward；active 时不命中
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React, { useReducer } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { currentApiMock } from './helpers/api-mock';
import { BrowserPage } from '../../src/renderer/src/components/BrowserPage';
import { setPeekPointerHandler } from '../../src/renderer/src/browserPointer';
import { StoreProvider, useUiStore, useWorkspaceStore } from '../../src/renderer/src/store';
import { getTipSnapshot, subscribeTips } from '../../src/renderer/src/tips';
import { RightWorkspaceContext } from '../../src/renderer/src/rightWorkspace';
import { activeRightTab, initialRightWorkspace, reduceRightWorkspace, type RightWorkspaceModel } from '../../src/shared/rightWorkspace';

type WebviewEl = HTMLElement & { getWebContentsId?: () => number };
const originalElementFromPoint = document.elementFromPoint;

function NavigationErrorProbe(): React.JSX.Element {
  const { activeWorkspaceId } = useWorkspaceStore();
  const tip = React.useSyncExternalStore(subscribeTips, getTipSnapshot)?.text ?? '';
  return <output data-testid="navigation-error" data-workspace={activeWorkspaceId ?? ''}>{activeWorkspaceId ? tip : ''}</output>;
}

function WorkspaceBrowserHarness({ initial }: { initial: RightWorkspaceModel }): React.JSX.Element {
  const [model, dispatch] = useReducer(reduceRightWorkspace, initial);
  const current = activeRightTab(model);
  const { sideDockRequest } = useUiStore();
  const shown = sideDockRequest?.dock === 'git' && current?.content.kind === 'web';
  return <RightWorkspaceContext.Provider value={{ model, current, dispatch, toolbar: null,
    resourceHosts: { files: null, git: null, browser: null }, open: () => {}, registerFile: () => {} }}>
    <output data-testid="current-content">{current?.content.kind}</output>
    <BrowserPage active={shown} shown={shown} sideTab="files" onSideTab={() => {}} />
  </RightWorkspaceContext.Provider>;
}

function browserBehindFile(sessionId = 'chat-a'): RightWorkspaceModel {
  let model = initialRightWorkspace('ws-a', sessionId);
  model = reduceRightWorkspace(model, { type: 'hydrate', workspaceId: 'ws-a' });
  model = reduceRightWorkspace(model, { type: 'open', content: { kind: 'web', browserId: 'bt1', url: 'https://example.com/bt1', title: 't-bt1' } });
  if (sessionId !== 'chat-a') model = reduceRightWorkspace(model, { type: 'scope', workspaceId: 'ws-a', sessionId: 'chat-a' });
  return reduceRightWorkspace(model, { type: 'open', content: { kind: 'file', path: 'file.txt' } });
}

function tabPayload(tabIds: string[], activeId: string) {
  return {
    tabs: tabIds.map((id) => ({
      id,
      title: `t-${id}`,
      url: `https://example.com/${id}`,
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false
    })),
    activeId,
    nav: { back: false, forward: false }
  };
}

/** 给 jsdom 里的 webview 元素补 Electron 专有 API */
function stubWebviewApi(el: WebviewEl, id: number): void {
  Object.defineProperty(el, 'getWebContentsId', { value: () => id, configurable: true });
}

describe('BrowserPage webview 栈', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    setPeekPointerHandler(null);
    document.elementFromPoint = originalElementFromPoint;
    vi.restoreAllMocks();
  });

  it('懒挂载：restore 后仅激活 tab 挂 webview；mount-request 补挂后台 tab', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1', 'bt2', 'bt3'], 'bt2')));
    const { unmount } = render(
      <StoreProvider>
        <div data-h-page="git"><BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} /></div>
      </StoreProvider>
    );
    await waitFor(() => {
      expect(document.querySelectorAll('webview')).toHaveLength(1);
    });
    let wv = document.querySelector('webview') as WebviewEl;
    // 初始 src 固定 about:blank：dom-ready 上报后主进程 wire 再 loadURL(tab.url)
    expect(wv.getAttribute('src')).toBe('about:blank');
    expect(wv.getAttribute('partition')).toBe('persist:browser');

    // agent 请求后台标签：mount-request → 补挂第三个（不重复挂已有）
    act(() => {
      mock.emit('browser:mount-request', { tabId: 'bt3' });
      mock.emit('browser:mount-request', { tabId: 'bt2' });
    });
    await waitFor(() => {
      expect(document.querySelectorAll('webview')).toHaveLength(2);
    });

    // 激活切换：新激活 tab 也懒挂载（browser:tabs 全量推送）
    act(() => {
      mock.emit('browser:tabs', tabPayload(['bt1', 'bt2', 'bt3'], 'bt1'));
    });
    await waitFor(() => {
      expect(document.querySelectorAll('webview')).toHaveLength(3);
    });
    // 激活可见、其余隐藏（visibility 切换保活，不卸载）
    const views = [...document.querySelectorAll('webview')] as WebviewEl[];
    const vis = new Map(views.map((el) => [el.getAttribute('data-tab-id'), el.style.visibility]));
    expect(vis.get('bt1')).toBe('visible');
    expect(vis.get('bt2')).toBe('hidden');
    expect(vis.get('bt3')).toBe('hidden');
    // 关 tab（载荷少一行）→ 对应 webview 卸载
    act(() => {
      mock.emit('browser:tabs', tabPayload(['bt1', 'bt2'], 'bt1'));
    });
    await waitFor(() => {
      expect(document.querySelectorAll('webview')).toHaveLength(2);
    });
    unmount();
  });

  it('did-attach 上报：dom-ready 后 guestAttach；关 tab 卸载时 guestDetach', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt9'], 'bt9')));
    const { unmount } = render(
      <StoreProvider>
        <div data-h-page="git"><BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} /></div>
      </StoreProvider>
    );
    await waitFor(() => {
      expect(document.querySelector('webview')).toBeTruthy();
    });
    const el = document.querySelector('webview') as WebviewEl;
    stubWebviewApi(el, 4242);
    act(() => {
      el.dispatchEvent(new Event('dom-ready'));
    });
    await waitFor(() => {
      expect(mock.mockOf('browser.guestAttach')).toHaveBeenCalledWith({
        tabId: 'bt9',
        webContentsId: 4242
      });
    });
    // 卸载（模拟关 tab 流程的组件侧）→ detach 上报（元素销毁后读不到 id，用缓存值）
    unmount();
    await waitFor(() => {
      expect(mock.mockOf('browser.guestDetach')).toHaveBeenCalledWith({
        tabId: 'bt9',
        webContentsId: 4242
      });
    });
  });

  it('露条手势层：shown&&!active 截获 pointer/wheel；active 时不命中', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1'], 'bt1')));
    const events: Array<{ type: string; page: string }> = [];
    setPeekPointerHandler((type, page) => events.push({ type, page }));
    // restore 只在 active 时发生（原语义）：先聚焦挂载，再切到露条态（可见但不聚焦）
    const { rerender } = render(
      <StoreProvider>
        <div data-h-page="git"><BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} /></div>
      </StoreProvider>
    );
    await waitFor(() => {
      expect(document.querySelector('webview')).toBeTruthy();
    });
    rerender(
      <StoreProvider>
        <div data-h-page="git"><BrowserPage active={false} shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} /></div>
      </StoreProvider>
    );
    const layer = document.querySelector('.browser-gesture-layer') as HTMLDivElement;
    expect(layer).toBeTruthy();
    const peekStyle = layer.style.pointerEvents; // rerender 复用同节点，先取露条态样式
    // 露条态：move/down 手势转发 + 滚轮走 wheelForward
    act(() => {
      layer.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 20, bubbles: true }));
      layer.dispatchEvent(new PointerEvent('pointerdown', { clientX: 30, clientY: 40, bubbles: true }));
      layer.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
    });
    expect(events).toEqual([{ type: 'move', page: 'git' }, { type: 'down', page: 'git' }]);
    expect(mock.mockOf('browser.wheelForward')).toHaveBeenCalledWith({ tabId: 'bt1', x: 0, y: 0, deltaX: 0, deltaY: 120 });

    // 激活态：覆盖层关闭命中（jsdom 合成事件不受 CSS pointer-events 约束，
    // 真实穿透行为由 e2e 验收覆盖；这里断言样式开关本身）
    events.length = 0;
    rerender(
      <StoreProvider>
        <div data-h-page="git"><BrowserPage active shown sideTab="browser" onSideTab={() => {}} onDropOnTab={() => {}} /></div>
      </StoreProvider>
    );
    expect(document.querySelector('.browser-gesture-layer')).toBeNull();
    // 露条态样式对照（默认 auto=截获）
    expect(peekStyle).not.toBe('none');
  });

  it('隐藏 owner 也同步标签；mount-request 不依赖先激活页面', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1', 'bt2'], 'bt1')));
    render(<StoreProvider><BrowserPage active={false} shown={false} sideTab="files" onSideTab={() => {}} /></StoreProvider>);
    await waitFor(() => expect(document.querySelectorAll('.browser-tab-item')).toHaveLength(2));
    expect(document.querySelectorAll('webview')).toHaveLength(0);
    act(() => mock.emit('browser:mount-request', { tabId: 'bt2' }));
    await waitFor(() => expect(document.querySelectorAll('webview')).toHaveLength(1));
    expect(document.querySelector('webview')?.getAttribute('data-tab-id')).toBe('bt2');
    expect((document.querySelector('webview') as HTMLElement).style.visibility).toBe('hidden');
  });

  it('首同步返回过晚不能覆盖较新的 tabs 推送', async () => {
    const mock = currentApiMock();
    let resolve!: (value: ReturnType<typeof tabPayload>) => void;
    mock.override('browser.restore', () => new Promise(r => { resolve = r; }));
    render(<StoreProvider><BrowserPage active shown sideTab="browser" onSideTab={() => {}} /></StoreProvider>);
    act(() => mock.emit('browser:tabs', tabPayload(['fresh'], 'fresh')));
    await waitFor(() => expect(document.querySelector('webview')?.getAttribute('data-tab-id')).toBe('fresh'));
    await act(async () => resolve(tabPayload(['stale'], 'stale')));
    expect(document.querySelector('webview')?.getAttribute('data-tab-id')).toBe('fresh');
  });

  it('地址栏提交等待导航，真实失败以提示呈现而不产生未处理拒绝', async () => {
    const mock = currentApiMock();
    mock.override('workspaces.list', () => Promise.resolve({ activeWorkspaceId: 'ws-a', workspaces: [{ id: 'ws-a', name: 'A', path: 'E:/a', openedAt: 0 }] }));
    mock.override('config.get', () => Promise.resolve({ activeWorkspaceId: 'ws-a', workspaces: [{ id: 'ws-a', name: 'A', path: 'E:/a', openedAt: 0 }] }));
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1'], 'bt1')));
    mock.override('browser.navigate', () => Promise.reject(new Error('ERR_CONNECTION_REFUSED')));
    const view = render(<StoreProvider><NavigationErrorProbe /><BrowserPage active shown sideTab="browser" onSideTab={() => {}} /></StoreProvider>);
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy());
    await waitFor(() => expect(view.getByTestId('navigation-error').getAttribute('data-workspace')).toBe('ws-a'));
    const addr = document.querySelector('.browser-addr') as HTMLInputElement;
    fireEvent.change(addr, { target: { value: 'https://unavailable.test/' } });
    fireEvent.keyDown(addr, { key: 'Enter' });
    expect(mock.mockOf('browser.navigate')).toHaveBeenCalledWith({ id: 'bt1', input: 'https://unavailable.test/' });
    await waitFor(() => expect(view.getByTestId('navigation-error').textContent).toContain('ERR_CONNECTION_REFUSED'));
  });

  it('只读状态与迟到的旧输入焦点请求都保留用户地址栏焦点', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1'], 'bt1')));
    const view = render(<StoreProvider><BrowserPage active shown sideTab="browser" onSideTab={() => {}} /></StoreProvider>);
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy());
    const el = document.querySelector('webview') as WebviewEl;
    stubWebviewApi(el, 4242);
    el.tabIndex = 0;
    const addr = document.querySelector('.browser-addr') as HTMLInputElement;
    addr.focus();
    act(() => mock.emit('browser:agentState', { active: true, action: 'snapshot', tabId: 'bt1' }));
    expect(document.activeElement).toBe(addr);
    const request = { requestId: 'focus-1', tabId: 'bt1', webContentsId: 4242 };
    act(() => mock.emit('browser:focus-request', request));
    expect(document.activeElement).toBe(addr);
    expect(mock.mockOf('browser.focusAck')).toHaveBeenLastCalledWith({ ...request, focused: false });
    addr.focus();
    act(() => mock.emit('browser:focus-request', { ...request, requestId: 'old', webContentsId: 99 }));
    expect(document.activeElement).toBe(addr);
    expect(mock.mockOf('browser.focusAck')).toHaveBeenLastCalledWith({ ...request, requestId: 'old', webContentsId: 99, focused: false });
    view.rerender(<StoreProvider><BrowserPage active={false} shown={false} sideTab="files" onSideTab={() => {}} /></StoreProvider>);
    act(() => mock.emit('browser:focus-request', { ...request, requestId: 'hidden' }));
    expect(document.activeElement).toBe(addr);
    expect(mock.mockOf('browser.focusAck')).toHaveBeenLastCalledWith({ ...request, requestId: 'hidden', focused: false });
  });

  it('旧 reveal 请求不能把用户文件切成网页、展开工作面或获取焦点', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1'], 'bt1')));
    const view = render(<StoreProvider><WorkspaceBrowserHarness initial={browserBehindFile()} /></StoreProvider>);
    await waitFor(() => expect(document.querySelectorAll('.browser-tab-item')).toHaveLength(0));
    act(() => mock.emit('browser:mount-request', { tabId: 'bt1' }));
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy());
    const el = document.querySelector('webview') as WebviewEl;
    stubWebviewApi(el, 4242); el.tabIndex = 0;
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 40, 400, 600));
    const focus = vi.spyOn(el, 'focus');
    expect(view.getByTestId('current-content').textContent).toBe('file');
    expect(el.style.visibility).toBe('hidden');
    const request = { requestId: 'reveal', tabId: 'bt1', webContentsId: 4242, reveal: true, expiresAt: Date.now() + 1500 };
    act(() => mock.emit('browser:focus-request', request));
    expect(mock.mockOf('browser.focusAck')).toHaveBeenCalledWith({ ...request, focused: false });
    expect(view.getByTestId('current-content').textContent).toBe('file');
    expect(el.style.visibility).toBe('hidden');
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(el);
  });

  it('拒绝其他会话和已过期的旧焦点请求', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1'], 'bt1')));
    const view = render(<StoreProvider><WorkspaceBrowserHarness initial={browserBehindFile('chat-b')} /></StoreProvider>);
    act(() => mock.emit('browser:mount-request', { tabId: 'bt1' }));
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy());
    const el = document.querySelector('webview') as WebviewEl;
    stubWebviewApi(el, 4242); el.tabIndex = 0;
    const request = { requestId: 'outside-scope', tabId: 'bt1', webContentsId: 4242, reveal: true, expiresAt: Date.now() + 1500 };
    act(() => mock.emit('browser:focus-request', request));
    expect(mock.mockOf('browser.focusAck')).toHaveBeenLastCalledWith({ ...request, focused: false });
    expect(view.getByTestId('current-content').textContent).toBe('file');
    expect(el.style.visibility).toBe('hidden');
    view.unmount();

    const legacy = render(<StoreProvider><BrowserPage active shown sideTab="browser" onSideTab={() => {}} /></StoreProvider>);
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy());
    const visibleEl = document.querySelector('webview') as WebviewEl;
    stubWebviewApi(visibleEl, 4242); visibleEl.tabIndex = 0;
    const expired = { ...request, requestId: 'expired', expiresAt: Date.now() - 1 };
    act(() => mock.emit('browser:focus-request', expired));
    expect(mock.mockOf('browser.focusAck')).toHaveBeenLastCalledWith({ ...expired, focused: false });
    expect(document.activeElement).not.toBe(visibleEl);
    legacy.unmount();
  });

  it('露条滚轮按缩放后的命中坐标转发双轴像素量，并阻止外层滚动', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1'], 'bt1')));
    render(<StoreProvider><BrowserPage active={false} shown sideTab="browser" onSideTab={() => {}} /></StoreProvider>);
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy());
    const layer = document.querySelector('.browser-gesture-layer') as HTMLElement;
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 200, left: 100, top: 200, width: 400, height: 300, right: 500, bottom: 500, toJSON() {} });
    Object.defineProperties(layer, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    const e = new WheelEvent('wheel', { clientX: 200, clientY: 250, deltaX: 2, deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true });
    act(() => { layer.dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(true);
    expect(mock.mockOf('browser.wheelForward')).toHaveBeenLastCalledWith({ tabId: 'bt1', x: 200, y: 100, deltaX: 32, deltaY: 48 });
    act(() => layer.dispatchEvent(new WheelEvent('wheel', { clientX: 200, clientY: 250, deltaX: 1, deltaY: 1, deltaMode: 2, bubbles: true, cancelable: true })));
    expect(mock.mockOf('browser.wheelForward')).toHaveBeenLastCalledWith({ tabId: 'bt1', x: 200, y: 100, deltaX: 800, deltaY: 600 });
  });

  it('前台使用真实 webview 原生输入，不创建图片流或转发用户按键', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1'], 'bt1')));
    render(<StoreProvider><BrowserPage active shown sideTab="browser" onSideTab={() => {}} /></StoreProvider>);
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy());
    const webview = document.querySelector('webview') as HTMLElement;
    expect(webview.dataset.browserPresentation).toBe('foreground');
    expect(webview.hasAttribute('inert')).toBe(false);
    expect(webview.tabIndex).toBe(0);
    expect(webview.style.position).toBe('');
    expect(document.querySelector('[data-browser-execution], [data-browser-execution-frame], canvas')).toBeNull();
    webview.focus();
    fireEvent.pointerDown(webview, { clientX: 20, clientY: 30, button: 0 });
    fireEvent.keyDown(webview, { key: '中', code: 'KeyA' });
    fireEvent.keyUp(webview, { key: '中', code: 'KeyA' });
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    fireEvent(webview, wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(mock.mockOf('browser.executionPreview')).not.toHaveBeenCalled();
    expect(mock.mockOf('browser.executionInput')).not.toHaveBeenCalled();
    expect(mock.mockOf('browser.wheelForward')).not.toHaveBeenCalled();
    expect(mock.mockOf('browser.focusAck')).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(webview);
  });

  it('切换和隐藏仅改样式，保留同一 guest 节点、挂载 id 和未保存状态；真正关闭才 detach', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['bt1', 'bt2'], 'bt1')));
    const view = render(<StoreProvider><BrowserPage active shown sideTab="browser" onSideTab={() => {}} /></StoreProvider>);
    await waitFor(() => expect(document.querySelector('webview[data-tab-id="bt1"]')).toBeTruthy());
    act(() => mock.emit('browser:mount-request', { tabId: 'bt2' }));
    await waitFor(() => expect(document.querySelectorAll('webview')).toHaveLength(2));
    const first = document.querySelector('webview[data-tab-id="bt1"]') as WebviewEl;
    const second = document.querySelector('webview[data-tab-id="bt2"]') as WebviewEl;
    stubWebviewApi(first, 101); stubWebviewApi(second, 102);
    first.dataset.testDraft = 'unsaved draft';
    act(() => { first.dispatchEvent(new Event('dom-ready')); second.dispatchEvent(new Event('dom-ready')); });
    expect(mock.mockOf('browser.guestAttach')).toHaveBeenCalledTimes(2);
    act(() => mock.emit('browser:tabs', tabPayload(['bt1', 'bt2'], 'bt2')));
    expect(document.querySelector('webview[data-tab-id="bt1"]')).toBe(first);
    expect(first.dataset.browserPresentation).toBe('background');
    expect(first.style.width).toBe('1280px');
    expect(first.style.height).toBe('900px');
    expect(first.style.pointerEvents).toBe('none');
    expect(first.style.visibility).toBe('hidden');
    expect(first.hasAttribute('inert')).toBe(true);
    expect(first.tabIndex).toBe(-1);
    expect(second.dataset.browserPresentation).toBe('foreground');
    expect(second.hasAttribute('inert')).toBe(false);
    view.rerender(<StoreProvider><BrowserPage active={false} shown={false} sideTab="files" onSideTab={() => {}} /></StoreProvider>);
    expect(document.querySelector('webview[data-tab-id="bt1"]')).toBe(first);
    expect(document.querySelector('webview[data-tab-id="bt2"]')).toBe(second);
    expect(first.dataset.testDraft).toBe('unsaved draft');
    expect(first.getWebContentsId?.()).toBe(101);
    expect(mock.mockOf('browser.guestAttach')).toHaveBeenCalledTimes(2);
    expect(mock.mockOf('browser.guestDetach')).not.toHaveBeenCalled();
    act(() => mock.emit('browser:tabs', tabPayload(['bt1'], 'bt1')));
    await waitFor(() => expect(mock.mockOf('browser.guestDetach')).toHaveBeenCalledWith({ tabId: 'bt2', webContentsId: 102 }));
    view.unmount();
    await waitFor(() => expect(mock.mockOf('browser.guestDetach')).toHaveBeenLastCalledWith({ tabId: 'bt1', webContentsId: 101 }));
  });

  it('StrictMode effect replay does not retire an attached live guest; real unmount detaches once', async () => {
    const mock = currentApiMock();
    const prototype = HTMLElement.prototype as WebviewEl;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getWebContentsId');
    Object.defineProperty(prototype, 'getWebContentsId', { configurable: true, value: () => 4242 });
    mock.override('browser.restore', () => Promise.resolve(tabPayload(['strict-tab'], 'strict-tab')));
    try {
      const view = render(<React.StrictMode><StoreProvider><BrowserPage active shown sideTab="browser" onSideTab={() => {}} /></StoreProvider></React.StrictMode>);
      await waitFor(() => expect(mock.mockOf('browser.guestAttach')).toHaveBeenCalledWith({ tabId: 'strict-tab', webContentsId: 4242 }));
      await act(async () => {});
      expect(document.querySelector('webview')?.isConnected).toBe(true);
      expect(mock.mockOf('browser.guestAttach')).toHaveBeenCalledTimes(1);
      expect(mock.mockOf('browser.guestDetach')).not.toHaveBeenCalled();
      view.unmount();
      await waitFor(() => expect(mock.mockOf('browser.guestDetach')).toHaveBeenCalledWith({ tabId: 'strict-tab', webContentsId: 4242 }));
      expect(mock.mockOf('browser.guestDetach')).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor) Object.defineProperty(prototype, 'getWebContentsId', descriptor);
      else delete prototype.getWebContentsId;
    }
  });
});
