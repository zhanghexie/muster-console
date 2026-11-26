import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ChromeBar } from '../../src/renderer/src/components/ChromeBar';
import { currentApiMock } from './helpers/api-mock';

/** 面板历史深度可调（默认 0=按钮置灰）；ChromeBar 经 usePanelHistory/useHistoryWsId 消费 */
const mockDepth = { back: 0, forward: 0 };
const mockChords = vi.hoisted(() => ({ 'panel.back': 'Alt+←', 'panel.forward': 'Alt+→' } as Record<string, string>));
const mockOpenPalette = vi.fn();

vi.mock('../../src/renderer/src/store', () => ({
  useWorkspaceStore: () => ({ activeWorkspaceId: 'ws' }),
  useUiStore: () => ({ flashTip: vi.fn(), openCommandPalette: mockOpenPalette })
}));
vi.mock('../../src/renderer/src/panelHistory', () => ({
  usePanelHistory: () => ({
    leftBackDepth: () => mockDepth.back,
    leftForwardDepth: () => mockDepth.forward
  }),
  useHistoryWsId: () => 'ws'
}));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useChordLabel: (id: string) => mockChords[id] ?? '', useOverlayDismiss: () => {} }));
vi.mock('../../src/renderer/src/components/AppConfirmDialog', () => ({ AppConfirmDialog: () => null }));

beforeEach(() => currentApiMock().override('extensions.toolbar', async () => ({ workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 0, items: [{ id: 'build', name: '一键打包', icon: '📦', scope: 'project' }] })));

function renderBar(overrides?: { back?: () => void; forward?: () => void }): HTMLElement {
  return render(<ChromeBar onOpenSettings={vi.fn()} globalBoardOpen={false}
    onToggleGlobalBoard={vi.fn()} onToggleLeftDrawer={vi.fn()} onToggleRightDrawer={vi.fn()}
    sessionsOpen rightPanelOpen onToggleSessions={vi.fn()} onToggleRightPanel={vi.fn()}
    onBackPanelHistory={overrides?.back ?? vi.fn()} onForwardPanelHistory={overrides?.forward ?? vi.fn()} />).container;
}

it('顶栏纯图标入口：历史 ‹ ›、搜索、看板与右栏开关，不附带装饰图标', async () => {
  const run = currentApiMock().mockOf('extensions.runToolbar').mockResolvedValue({ ok: true });
  const board = vi.fn();
  const monitor = vi.fn();
  const { container } = render(<ChromeBar onOpenSettings={vi.fn()} globalBoardOpen={false}
    onToggleGlobalBoard={board} processMonitorOpen={false} onToggleProcessMonitor={monitor} onToggleLeftDrawer={vi.fn()} onToggleRightDrawer={vi.fn()}
    sessionsOpen rightPanelOpen onToggleSessions={vi.fn()} onToggleRightPanel={vi.fn()}
    onBackPanelHistory={vi.fn()} onForwardPanelHistory={vi.fn()} />);
  await act(async () => {});
  // 面板历史 ‹ ›（原左栏顶部行移改顶栏）：图标钮、无文字装饰
  const history = container.querySelector('.chrome-history') as HTMLElement;
  expect(history).toBeTruthy();
  expect(history.textContent).toBe('');
  expect(history.querySelectorAll('svg').length).toBe(2);
  expect(container.querySelector('.chrome-gboard-icon')).toBeNull();
  const extension = container.querySelector('.chrome-ext-btn') as HTMLButtonElement;
  expect(extension.textContent).toBe('一键打包');
  expect(extension.querySelector('.chrome-ext-icon')).toBeNull();
  expect(container.querySelector('.chrome-settings svg')).not.toBeNull();
  expect(container.querySelector('.chrome-right-toggle svg')).not.toBeNull();
  // 全局搜索入口：设置右侧的图标钮
  const searchBtn = container.querySelector('.chrome-search-btn') as HTMLButtonElement;
  expect(searchBtn.closest('.chrome-menus')).toBeTruthy();
  expect(searchBtn.previousElementSibling?.classList.contains('chrome-settings')).toBe(true);
  expect(searchBtn.querySelector('svg')).not.toBeNull();
  // ①a 全局看板入口：搜索旁的图标钮（无文字），toggle 语义 aria-pressed
  const gboardBtn = container.querySelector('.chrome-gboard-btn') as HTMLButtonElement;
  expect(gboardBtn.closest('.chrome-menus')).toBeTruthy();
  expect(gboardBtn.previousElementSibling?.classList.contains('chrome-search-btn')).toBe(true);
  expect(gboardBtn.querySelector('svg')).not.toBeNull();
  expect(gboardBtn.textContent).toBe('');
  expect(gboardBtn.getAttribute('aria-pressed')).toBe('false');
  const monitorBtn = container.querySelector('.chrome-process-monitor-btn') as HTMLButtonElement;
  expect(monitorBtn.getAttribute('aria-pressed')).toBe('false');
  expect(monitorBtn.querySelector('svg')).not.toBeNull();
  // ④ 右侧栏开合钮用共享面板图标（side 形态，展开 ›）
  const rightIcon = container.querySelector('.chrome-right-toggle svg.icon-panel-toggle')!;
  expect(rightIcon.getAttribute('data-placement')).toBe('side');
  expect(rightIcon.getAttribute('data-open')).toBe('true');
  fireEvent.click(container.querySelector('.chrome-gboard-btn')!);
  expect(board).toHaveBeenCalledOnce();
  fireEvent.click(monitorBtn);
  expect(monitor).toHaveBeenCalledOnce();
  await act(async () => { fireEvent.click(extension); });
  expect(run).toHaveBeenCalledWith({ workspaceId: 'ws', sourceRootId: 'root', selectionRevision: 0, extensionId: 'build', scope: 'project' });
});

it('面板历史按钮：栈空置灰；有历史时点击分别触发返回/前进回调', async () => {
  const back = vi.fn(), forward = vi.fn();
  const view = render(<ChromeBar onOpenSettings={vi.fn()} globalBoardOpen={false}
    onToggleGlobalBoard={vi.fn()} onToggleLeftDrawer={vi.fn()} onToggleRightDrawer={vi.fn()}
    sessionsOpen rightPanelOpen onToggleSessions={vi.fn()} onToggleRightPanel={vi.fn()}
    onBackPanelHistory={back} onForwardPanelHistory={forward} />);
  await act(async () => {});
  const btns = (): HTMLButtonElement[] =>
    Array.from(view.container.querySelectorAll<HTMLButtonElement>('.chrome-history-btn'));
  // 深度 0：置灰兜底，点击不触发
  expect(btns()[0].disabled).toBe(true);
  expect(btns()[1].disabled).toBe(true);
  expect(btns()[0].title).toBe('返回上一面板 · Alt+←');
  expect(btns()[1].title).toBe('前进下一面板 · Alt+→');
  fireEvent.click(btns()[0]);
  fireEvent.click(btns()[1]);
  expect(back).not.toHaveBeenCalled();
  expect(forward).not.toHaveBeenCalled();
  // 深度 > 0：解禁，title 带步数，点击触发对应回调
  mockDepth.back = 2;
  mockDepth.forward = 1;
  try {
    view.rerender(<ChromeBar onOpenSettings={vi.fn()} globalBoardOpen={false}
      onToggleGlobalBoard={vi.fn()} onToggleLeftDrawer={vi.fn()} onToggleRightDrawer={vi.fn()}
      sessionsOpen rightPanelOpen onToggleSessions={vi.fn()} onToggleRightPanel={vi.fn()}
      onBackPanelHistory={back} onForwardPanelHistory={forward} />);
    expect(btns()[0].disabled).toBe(false);
    expect(btns()[1].disabled).toBe(false);
    expect(btns()[0].title).toBe('返回上一面板（可退 2 步） · Alt+←');
    expect(btns()[1].title).toBe('前进下一面板（可进 1 步） · Alt+→');
    fireEvent.click(btns()[0]);
    fireEvent.click(btns()[1]);
    expect(back).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledOnce();
  } finally {
    mockDepth.back = 0;
    mockDepth.forward = 0;
  }
});

it('左侧历史提示跟随当前改绑/解绑，不显示固定默认键或多余分隔符', async () => {
  const back = mockChords['panel.back'], forward = mockChords['panel.forward'];
  mockChords['panel.back'] = 'Ctrl+Shift+J'; mockChords['panel.forward'] = '';
  try {
    const container = renderBar(); await act(async () => {});
    const buttons = container.querySelectorAll<HTMLButtonElement>('.chrome-history-btn');
    expect(buttons[0].title).toBe('返回上一面板 · Ctrl+Shift+J');
    expect(buttons[1].title).toBe('前进下一面板');
  } finally { mockChords['panel.back'] = back; mockChords['panel.forward'] = forward; }
});

it('全局搜索按钮打开命令面板「全部」档（Ctrl+P 同源）', async () => {
  mockOpenPalette.mockClear();
  const container = renderBar();
  await act(async () => {});
  fireEvent.click(container.querySelector('.chrome-search-btn')!);
  expect(mockOpenPalette).toHaveBeenCalledTimes(1);
  expect(mockOpenPalette).toHaveBeenCalledWith('goto');
});

it('沙箱隔离徽章即菜单入口：开启时展示三项操作，未开启不渲染', async () => {
  const openDir = currentApiMock().mockOf('sandbox.openDir').mockResolvedValue(undefined);
  const props = {
    onOpenSettings: vi.fn(), globalBoardOpen: false, onToggleGlobalBoard: vi.fn(),
    onToggleLeftDrawer: vi.fn(), onToggleRightDrawer: vi.fn(), sessionsOpen: true,
    rightPanelOpen: true, onToggleSessions: vi.fn(), onToggleRightPanel: vi.fn(),
    onBackPanelHistory: vi.fn(), onForwardPanelHistory: vi.fn()
  };
  // 未开启沙箱：徽章不渲染
  currentApiMock().override('sandbox.getInfo', () => Promise.resolve({ enabled: false }));
  const first = render(<ChromeBar {...props} />);
  await act(async () => {});
  expect(first.container.querySelector('.chrome-sandbox-badge')).toBeNull();
  first.unmount();
  // 开启沙箱：徽章常显，点开菜单含三项；「打开沙箱目录」走原动作
  currentApiMock().override('sandbox.getInfo', () =>
    Promise.resolve({ enabled: true, rootDir: 'E:/sandbox' })
  );
  const { container } = render(<ChromeBar {...props} />);
  await act(async () => {});
  const badge = container.querySelector('.chrome-sandbox-badge') as HTMLButtonElement;
  expect(badge.textContent).toBe('沙箱隔离');
  expect(badge.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(badge);
  expect(badge.getAttribute('aria-expanded')).toBe('true');
  const item = await screen.findByRole('menuitem', { name: '打开沙箱目录' });
  expect(screen.getByRole('menuitem', { name: '保存当前状态为默认基准' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: '重置沙箱到基准状态…' })).toBeTruthy();
  fireEvent.click(item);
  await act(async () => {});
  expect(openDir).toHaveBeenCalledOnce();
  expect(badge.getAttribute('aria-expanded')).toBe('false');
});

it('窄屏抽屉入口分别调用会话和工具面板回调，不触发桌面侧栏或看板', async () => {
  const left = vi.fn(), right = vi.fn(), desktop = vi.fn(), board = vi.fn();
  document.documentElement.classList.add('is-narrow');
  try {
    render(<ChromeBar onOpenSettings={vi.fn()} globalBoardOpen={false}
      onToggleGlobalBoard={board} onToggleLeftDrawer={left} onToggleRightDrawer={right}
      sessionsOpen rightPanelOpen onToggleSessions={desktop} onToggleRightPanel={desktop}
      onBackPanelHistory={vi.fn()} onForwardPanelHistory={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByTitle('唤出文件与 Git 面板'));
    expect(right).toHaveBeenCalledOnce(); expect(left).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('唤出会话栏'));
    expect(left).toHaveBeenCalledOnce(); expect(right).toHaveBeenCalledOnce();
    expect(desktop).not.toHaveBeenCalled(); expect(board).not.toHaveBeenCalled();
  } finally { document.documentElement.classList.remove('is-narrow'); }
});
