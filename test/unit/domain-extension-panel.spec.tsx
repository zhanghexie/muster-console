import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { currentApiMock } from './helpers/api-mock';
import { applyTheme, BUILTIN_THEMES } from '../../src/renderer/src/theme';
import * as webGateway from '../../src/renderer/src/webGatewayEnvironment';
import { setGatewayStatus } from '../../src/renderer/src/webGatewayStatus';

vi.mock('../../src/renderer/src/agentChat/AgentChatView', () => ({ AgentChatView: ({ sessionId }: { sessionId: string }) => <div data-testid={`current-agent-${sessionId}`} /> }));
vi.mock('../../src/renderer/src/components/ExtensionSurface', () => ({ ExtensionSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { TooltipHost } from '../../src/renderer/src/components/Tooltip';
import { DomainExtensionPanel } from '../../src/renderer/src/panels/DomainExtensionPanel';

it('opens the current sidebar and keeps its session alive across hide/show', async () => {
  const calls: Array<{ method?: string }> = [];
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', version: '0.1.0', surface: { entry: 'ui/panel.html' } } }));
  currentApiMock().override('extensionSurface.call', async (input: { method?: string }) => { calls.push(input); return { ok: true }; });
  currentApiMock().override('extensionSurface.reloadExtension', async () => ({ token: 'current-token', entry: 'ui/panel.html', sessionId: 'current-agent-reloaded', manifest: { name: '书架', version: '0.1.1', surface: { entry: 'ui/panel.html' } } }));
  const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} />);
  expect(await screen.findByTestId('current-agent-current-agent')).toBeTruthy();
  // AI 侧栏：非窄屏用内联列宽（默认 344px，280–560 之间）；嵌入态布局层拖拽热区在，
  // 底栏有四态布局选择框（样式与「当前屏」一致）。
  const layout = container.querySelector('.ext-agent-layout') as HTMLElement;
  expect(layout.getAttribute('style') ?? '').toMatch(/344px/);
  expect(container.querySelector('.ext-agent-resizer')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'AI 侧栏布局' })).toBeTruthy();
  const toggle = screen.getByRole('button', { name: '关闭 AI' });
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByTestId('current-agent-current-agent')).toBeNull());
  // 隐藏仅切可见性：不 agent.release，会话后台常驻（状态胶囊的数据源）；选择框一并隐藏。
  expect(screen.queryByRole('button', { name: 'AI 侧栏布局' })).toBeNull();
  expect(calls).toEqual([]);
  const reopen = screen.getByRole('button', { name: '打开 AI' });
  expect(reopen).toBeTruthy();
  fireEvent.click(reopen);
  expect(await screen.findByTestId('current-agent-current-agent')).toBeTruthy();
  expect(calls).toEqual([]);
  const previousFrame = container.querySelector('iframe');
  fireEvent.click(screen.getByRole('button', { name: '重载' }));
  await waitFor(() => expect(currentApiMock().mockOf('extensionSurface.reloadExtension')).toHaveBeenCalledWith('current-token'));
  expect(await screen.findByTestId('current-agent-current-agent-reloaded')).toBeTruthy();
  expect(container.querySelector('iframe')).not.toBe(previousFrame);
  expect(container.querySelector('iframe')?.getAttribute('sandbox') ?? '').toContain('allow-forms');
  expect(container.querySelector('iframe')?.getAttribute('src') ?? '').toContain('__ma_reload=1');
});

it('reloads a panel without a host Agent and drops the old AI controls', async () => {
  const panel = { token: 'media-token', entry: 'ui/panel.html', manifest: { name: '媒体创作台', surface: { entry: 'ui/panel.html' } } };
  currentApiMock().override('extensionSurface.openExtension', async () => ({ ...panel, sessionId: 'old-agent' }));
  currentApiMock().override('extensionSurface.reloadExtension', async () => panel);
  const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="dsh-media-desk" onClose={vi.fn()} />);
  await screen.findByTestId('current-agent-old-agent');
  const oldFrame = screen.getByLabelText('扩展面板 媒体创作台');
  fireEvent.click(screen.getByRole('button', { name: '重载' }));
  await waitFor(() => expect(screen.getByLabelText('扩展面板 媒体创作台')).not.toBe(oldFrame));
  expect(screen.queryByTestId('extension-agent-toggle')).toBeNull();
  expect(screen.queryByRole('button', { name: 'AI 侧栏布局' })).toBeNull();
  expect(container.querySelector('.ext-agent-sidebar')).toBeNull();
  const frame = container.querySelector('iframe')!;
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
  currentApiMock().emit('extensionSurface:event', { token: panel.token, topic: 'desk.changed', value: {} });
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'event', topic: 'desk.changed' }), '*');
});

it('reveals the existing hidden conversation only when the host opens that sidebar work', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'token', entry: 'ui/panel.html', sessionId: 'owner', manifest: { name: '设计', surface: { entry: 'ui/panel.html' } } }));
  let result = { sessionId: 'other', sidebar: true };
  currentApiMock().override('extensionSurface.call', async () => result);
  const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="design" onClose={vi.fn()} />);
  await screen.findByTestId('current-agent-owner');
  fireEvent.click(screen.getByRole('button', { name: '关闭 AI' }));
  const invoke = () => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: container.querySelector('iframe')!.contentWindow,
      data: { __ma: true, type: 'call', id: 'resume', method: 'tasks.open', args: [result.sessionId] } }));
  });
  await invoke();
  expect(screen.queryByTestId('current-agent-owner')).toBeNull();
  result = { sessionId: 'owner', sidebar: true };
  await invoke();
  expect(await screen.findByTestId('current-agent-owner')).toBeTruthy();
});

it('keeps the extension frame named without a panel-wide hover tooltip', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'hover-token', entry: 'ui/panel.html', sessionId: 'hover-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
  const { container } = render(<><TooltipHost /><DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} /></>);
  await screen.findByTestId('current-agent-hover-agent');
  const frame = container.querySelector('iframe')!;
  vi.useFakeTimers();
  try {
    fireEvent.mouseOver(frame);
    act(() => vi.advanceTimersByTime(400));
    expect(container.ownerDocument.querySelector('.app-tooltip')).toBeNull();
    expect(frame.getAttribute('aria-label')).toBe('扩展面板 书架');
  } finally { vi.useRealTimers(); }
});

it('retries the init handshake when the iframe announces readiness', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
  const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} />);
  await screen.findByTestId('current-agent-current-agent');
  const frame = container.querySelector('iframe') as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
  window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'null', data: { __ma: true, type: 'ready' } }));
  expect(postMessage).not.toHaveBeenCalled();
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { __ma: true, type: 'ready' } }));
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ __ma: true, type: 'init' }), '*');
});

it('reopens the browser panel on a new connection and closes only its current token', async () => {
  const gateway = vi.spyOn(webGateway, 'isWebGateway').mockReturnValue(true);
  try {
    setGatewayStatus(true, '');
    let opens = 0;
    currentApiMock().override('extensionSurface.openExtension', async () => ({
      token: `web-view-${++opens}`, entry: 'ui/panel.html', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } }
    }));
    const close = currentApiMock().mockOf('extensionSurface.closeExtension');
    const { unmount } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" placement="window" onClose={vi.fn()} />);
    expect((await screen.findByLabelText('扩展面板 书架')).getAttribute('src')).toContain('/media/extension/web-view-1/view/');
    await waitFor(() => expect(currentApiMock().mockOf('workbench.panelPlacement')).toHaveBeenCalledWith({ token: 'web-view-1', placement: 'center' }));

    act(() => setGatewayStatus(false, ''));
    expect(screen.queryByLabelText('扩展面板 书架')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    act(() => setGatewayStatus(true, ''));
    expect((await screen.findByLabelText('扩展面板 书架')).getAttribute('src')).toContain('/media/extension/web-view-2/view/');

    unmount();
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith('web-view-2');
  } finally {
    gateway.mockRestore();
    setGatewayStatus(false, '');
  }
});

it('forwards domain events to the active extension iframe', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
  const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} />);
  await screen.findByTestId('current-agent-current-agent');
  const frame = container.querySelector('iframe') as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
  currentApiMock().emit('extensionSurface:event', { token: 'current-token', topic: 'state.changed', value: { type: 'state.changed', extensionId: 'bookshelf', extensionInstanceId: 'ws:bookshelf:main', workspaceId: 'ws', version: 2, requestId: 'r1', actor: 'human', payload: { changed: true } } });
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ __ma: true, type: 'event', topic: 'state.changed' }), '*');
});

it.each(['global', 'project'] as const)('shows the %s panel error with only a close action', async scope => {
  const open = currentApiMock().mockOf('extensionSurface.openExtension').mockRejectedValueOnce(new Error('请在扩展管理中启用此扩展'));
  const onClose = vi.fn();
  render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" scope={scope} onClose={onClose} />);
  expect((await screen.findByRole('alert')).textContent).toContain('请在扩展管理中启用此扩展');
  expect(screen.getAllByRole('button')).toEqual([screen.getByRole('button', { name: '关闭面板' })]);
  fireEvent.click(screen.getByRole('button', { name: '关闭面板' }));
  expect(open).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it('forwards host appearance changes to the current iframe', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-theme-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
  const { container, unmount } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} />);
  await screen.findByTestId('current-agent-current-agent');
  const frame = container.querySelector('iframe') as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
  act(() => applyTheme(BUILTIN_THEMES.find(theme => theme.id === 'light')!, { persist: false }));
  await waitFor(() => expect(postMessage.mock.calls.some(([message]) => message.type === 'appearance' && message.colorScheme === 'light')).toBe(true));
  expect(postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'appearance', colorScheme: 'light' });
  unmount();
  act(() => applyTheme(BUILTIN_THEMES.find(theme => theme.id === 'dark')!, { persist: false }));
});

it('pins to the right tab with an away placeholder and recalls to the center', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-pin-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
  const onPlacement = vi.fn();
  render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" placement="tab" surfaceKey='["ws","node-1"]' onPlacement={onPlacement} onClose={vi.fn()} />);
  expect(await screen.findByText(/当前显示在虚拟屏右侧标签页/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '一键召回' }));
  expect(onPlacement).toHaveBeenCalledWith('center');
});

it('detaches the whole panel with its AI to the standalone window', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-win-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
  const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" placement="window" surfaceKey='["ws","node-1"]' onPlacement={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByText(/面板与 AI 已移至独立窗口/)).toBeTruthy();
  await waitFor(() => expect(currentApiMock().mockOf('workbench.panelPlacement')).toHaveBeenCalledWith({ token: 'current-win-token', placement: 'window' }));
  expect((container.querySelector('iframe') as HTMLIFrameElement).style.display).toBe('none');
  // 主窗口不再渲染 AI 侧栏——它与面板一起进了独立窗口（ExtensionDetachedWindow）。
  expect(container.querySelector('.ext-agent-sidebar')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '一键召回' }));
});

it('renders the detached window shell without placement IPC', async () => {
  const placements: unknown[] = [];
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-detached-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
  currentApiMock().override('workbench.panelPlacement', async (input: unknown) => { placements.push(input); });
  render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" active detachedWindow onClose={vi.fn()} />);
  expect(await screen.findByTestId('current-agent-current-agent')).toBeTruthy();
  await waitFor(() => expect(placements).toEqual([]));
  expect(document.querySelector('.ext-agent-sidebar')).toBeTruthy();
});

it('switches sidebar layout (float left/right, dock left/right) via the footer select', async () => {
  localStorage.removeItem('ext-agent-layout-mode');
  try {
    currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-layout-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
    const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} />);
    await screen.findByTestId('current-agent-current-agent');
    const layout = container.querySelector('.ext-agent-layout') as HTMLElement;
    const pick = async (label: string): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: 'AI 侧栏布局' }));
      fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: label }));
    };
    // 默认嵌入右；悬浮左：扩展占满整行、侧栏浮层压上（宽度沿用持久值），无拖拽热区
    expect(layout.getAttribute('style') ?? '').toMatch(/minmax\(0, 1fr\) 344px/);
    await pick('悬浮在左');
    expect(layout.className).toContain('float-left');
    expect(layout.classList.contains('docked')).toBe(false);
    expect(layout.getAttribute('style') ?? '').not.toMatch(/grid-template-columns/);
    expect((container.querySelector('.ext-agent-sidebar.floating') as HTMLElement).getAttribute('style') ?? '').toMatch(/344px/);
    expect(container.querySelector('.ext-agent-resizer')).toBeNull();
    expect(localStorage.getItem('ext-agent-layout-mode')).toBe('float-left');
    await pick('悬浮在右');
    expect(layout.className).toContain('float-right');
    // 嵌入左：列宽模板反转，拖拽热区回到布局层
    await pick('嵌入在左');
    expect(layout.className).toContain('dock-left');
    expect(layout.classList.contains('docked')).toBe(true);
    expect(container.querySelector<HTMLElement>('.ext-agent-resizer')?.style.left).toBe('344px');
    expect(layout.className).not.toContain('float');
    expect(layout.getAttribute('style') ?? '').toMatch(/344px minmax/);
    expect(container.querySelector('.ext-agent-resizer')).toBeTruthy();
    expect(localStorage.getItem('ext-agent-layout-mode')).toBe('dock-left');
    await pick('嵌入在右');
    expect(layout.getAttribute('style') ?? '').toMatch(/minmax\(0, 1fr\) 344px/);
    expect(localStorage.getItem('ext-agent-layout-mode')).toBe('dock-right');
    expect(container.querySelector<HTMLElement>('.ext-agent-resizer')?.style.right).toBe('344px');
  } finally {
    localStorage.removeItem('ext-agent-layout-mode');
  }
});

it('holds the dock divider while dragging across the extension iframe and releases it on pointerup', async () => {
  localStorage.removeItem('ext-agent-layout-mode');
  localStorage.removeItem('ext-agent-sidebar-width');
  try {
    currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'dock', entry: 'ui/panel.html', sessionId: 'dock-agent', manifest: { name: '书架' } }));
    const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} />);
    await screen.findByTestId('current-agent-dock-agent');
    const layout = container.querySelector<HTMLElement>('.ext-agent-layout')!;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1200, 700));
    const handle = screen.getByRole('separator', { name: '调整 AI 侧栏宽度' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 856 });
    expect(layout.classList.contains('resizing')).toBe(true);
    expect(handle.classList.contains('active')).toBe(true);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 });
    expect(handle.style.right).toBe('400px');
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(layout.classList.contains('resizing')).toBe(false);
    expect(handle.classList.contains('active')).toBe(false);
    expect(localStorage.getItem('ext-agent-sidebar-width')).toBe('400');
  } finally {
    localStorage.removeItem('ext-agent-sidebar-width');
  }
});

it('resizes the floating card from its corner grip (left → top-right, right → mirrored top-left)', async () => {
  localStorage.removeItem('ext-agent-layout-mode');
  localStorage.setItem('ext-agent-float-geometry', JSON.stringify({ w: 400, h: 375, top: 190 }));
  try {
    currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-resize-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
    const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} />);
    await screen.findByTestId('current-agent-current-agent');
    const pick = async (label: string): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: 'AI 侧栏布局' }));
      fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: label }));
    };
    await pick('悬浮在左');
    // 悬浮左：把手在右上角（无 mirror 类）
    const grip = container.querySelector('.ext-agent-resizer-corner') as HTMLElement;
    expect(grip).toBeTruthy();
    expect(grip.className).not.toContain('mirror');
    const card = container.querySelector('.ext-agent-sidebar.floating') as HTMLElement;
    expect(card.style.height).toBe('375px');
    expect(card.style.top).toBe('');
    const layout = container.querySelector('.ext-agent-layout') as HTMLElement;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 100, 800, 600));
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(28, 317, 400, 375));
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 428, clientY: 317 });
    fireEvent.pointerMove(grip, { clientX: 428, clientY: 370 });
    expect(card.style.height).toBe('322px');
    fireEvent.pointerUp(grip, { clientX: 428, clientY: 370 });
    expect(JSON.parse(localStorage.getItem('ext-agent-float-geometry') ?? '{}')).toEqual({ w: 400, h: 322 });
    // 悬浮右：把手镜像到左上角
    await pick('悬浮在右');
    expect((container.querySelector('.ext-agent-resizer-corner') as HTMLElement).className).toContain('mirror');
    // 换布局不清悬浮几何，切回悬浮仍用持久值
    await pick('嵌入在右');
    await pick('悬浮在右');
    expect((container.querySelector('.ext-agent-sidebar.floating') as HTMLElement).getAttribute('style') ?? '').toMatch(/400px/);
  } finally {
    localStorage.removeItem('ext-agent-layout-mode');
    localStorage.removeItem('ext-agent-float-geometry');
  }
});

it('shows a live status pill with the tail of the unread reply while the sidebar is hidden', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'current-pill-token', entry: 'ui/panel.html', sessionId: 'current-agent', manifest: { name: '书架', surface: { entry: 'ui/panel.html' } } }));
  const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="bookshelf" onClose={vi.fn()} />);
  await screen.findByTestId('current-agent-current-agent');
  fireEvent.click(screen.getByRole('button', { name: '关闭 AI' }));
  expect(screen.queryByTestId('current-agent-current-agent')).toBeNull();
  // 回合进行中：胶囊显示实时状态（与调度气泡同源文案）；emit 触发的是状态更新，需包 act 才同步落 DOM
  act(() => currentApiMock().emit('agentSession:event', { kind: 'busy', sessionId: 'current-agent', busy: true, queued: 0 }));
  const pillDuring = container.querySelector('.ext-agent-pill') as HTMLElement;
  expect(pillDuring).toBeTruthy();
  expect(pillDuring.textContent).toContain('思考中…');
  // 收口：该轮最后一条助手正文的末段截尾成为未读摘要，状态回到空闲
  act(() => currentApiMock().emit('agentSession:event', { kind: 'delta', sessionId: 'current-agent', messageId: 'm1', partIndex: 0, deltaKind: 'text', delta: `${'一'.repeat(80)}\n${'二'.repeat(100)}` }));
  act(() => currentApiMock().emit('agentSession:event', { kind: 'busy', sessionId: 'current-agent', busy: false, queued: 0 }));
  const pill = container.querySelector('.ext-agent-pill') as HTMLElement;
  expect(pill).toBeTruthy();
  expect(pill.querySelector('.ext-agent-pill-status')).toBeNull();
  const snippet = pill.querySelector('.ext-agent-pill-reply') as HTMLElement;
  expect(snippet.textContent).toBe(`…${'二'.repeat(64)}`);
  // 点击胶囊重开侧栏：未读清空、胶囊消失
  fireEvent.click(pill);
  expect(await screen.findByTestId('current-agent-current-agent')).toBeTruthy();
  expect(container.querySelector('.ext-agent-pill')).toBeNull();
});
it('uses the host confirmation dialog and replies only after a choice', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'confirm-token', entry: 'panel.html', sessionId: 'confirm-agent', manifest: { name: 'Design', surface: { entry: 'panel.html' } } }));
  const { container } = render(<DomainExtensionPanel workspaceId="ws" extensionId="design" onClose={vi.fn()} />);
  await screen.findByTestId('current-agent-confirm-agent');
  const frame = container.querySelector('iframe')!;
  const reply = vi.spyOn(frame.contentWindow!, 'postMessage');
  const request = (id: string) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { __ma: true, type: 'call', id, method: 'ui.confirm', args: [{ title: 'Remove work?', confirmLabel: 'Remove', cancelLabel: 'Keep', danger: true }] } }));
  });
  await request('cancel');
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(reply).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'reply', id: 'cancel' }), '*');
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ id: 'cancel', ok: true, result: false }), '*');
  await request('accept');
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ id: 'accept', ok: true, result: true }), '*');
  expect(currentApiMock().mockOf('extensionSurface.call')).not.toHaveBeenCalled();
});
it('rejects malformed and concurrent confirmation and cancels on panel disposal', async () => {
  currentApiMock().override('extensionSurface.openExtension', async () => ({ token: 'dispose-token', entry: 'panel.html', sessionId: 'dispose-agent', manifest: { name: 'Design', surface: { entry: 'panel.html' } } }));
  const { container, unmount } = render(<DomainExtensionPanel workspaceId="ws" extensionId="design" onClose={vi.fn()} />);
  await screen.findByTestId('current-agent-dispose-agent');
  const source = container.querySelector('iframe')!.contentWindow!;
  const reply = vi.spyOn(source, 'postMessage');
  const request = (id: string, options: unknown) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source, data: { __ma: true, type: 'call', id, method: 'ui.confirm', args: [options] } }));
  });
  await request('invalid', {title:''});
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({id:'invalid',ok:false}), '*');
  await request('first', {title:'Remove?'});
  await request('second', {title:'Another?'});
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({id:'second',ok:false}), '*');
  unmount();
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({id:'first',ok:true,result:false}), '*');
});
