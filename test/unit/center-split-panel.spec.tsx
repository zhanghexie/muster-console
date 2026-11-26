/** Production CenterPanel event/geometry contract. CSS hit testing, Gaussian blur,
 * native DataTransfer and iframe routing are verified by center-split-production-visual.mjs. */
import React from 'react';
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { CenterPanel } from '../../src/renderer/src/panels/CenterPanel';
import {
  __resetCenterSplitForTest, attachCenterSplitBridge, centerSplitIncoming,
  centerSplitSetRatio, centerSplitSetFocused, centerSplitClose, centerSplitClosePane, centerSplitTryFill,
  getCenterSplitState, centerSplitReconcilePrimary, centerSplitFlip, centerSplitSelectInPane, centerSplitDockPane, centerSplitToggleShortcut,
  centerSplitCommitSnapLayout, centerSplitSetDividerRatio
} from '../../src/renderer/src/centerSplitStore';
import { SPLIT_DRAG_MIME, encodeSplitDragPayload, deriveCenterSplitSnapLayout, getCenterSplitPaneRefs,
  type CenterPaneSlot, type CenterSnapLayoutId, type SplitPaneRef } from '../../src/shared/centerSplit';
import type { SessionMeta } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';
import { touchSessionView } from '../../src/renderer/src/sessionViewLru';
import { getChatFindShared, patchChatFindShared, resetChatFindSharedForTest } from '../../src/renderer/src/chatSurface/chatFindRegistry';
import { RightDockHost, onRightPinRequest, publishRightPins, type RightPinRequest } from '../../src/renderer/src/rightDock';

function Content({ sessionId, visible, style, chat = false }: {
  sessionId: string; visible: boolean; style?: React.CSSProperties; chat?: boolean
}) {
  const [draft, setDraft] = React.useState('');
  return <div data-testid={`content-${sessionId}`} data-session-id={sessionId} data-visible={String(visible)} style={style}
    className={`${chat ? 'agent-chat-view' : 'terminal-wrap'} xfade xfade-instant${visible ? ' is-shown' : ''}`}>
    <button onClick={() => setDraft(previous => previous + '!')}>正文 {sessionId}</button>
    <textarea aria-label={`输入 ${sessionId}`} value={draft} onChange={event => setDraft(event.target.value)} />
  </div>;
}
vi.mock('../../src/renderer/src/components/TerminalView', () => ({ TerminalView: (props: any) => <Content {...props} /> }));
// CLI panes receive geometry on CliSessionView's outer root, not its nested TerminalView.
vi.mock('../../src/renderer/src/components/CliSessionView', () => ({ CliSessionView: ({ session, visible, style }: { session: SessionMeta; visible: boolean; style?: React.CSSProperties }) => <Content sessionId={session.id} visible={visible} style={style} /> }));
vi.mock('../../src/renderer/src/agentChat/AgentChatView', () => ({ AgentChatView: (props: any) => <Content {...props} chat /> }));
vi.mock('../../src/renderer/src/components/PromptTaskPanel', () => ({
  PromptTaskPanel: (props: { onNavigateToSession?: () => void }) => <section data-testid="tasks-panel">
    <input aria-label="工具输入" /><button onClick={props.onNavigateToSession}>工具内部关闭</button>
  </section>
}));
vi.mock('../../src/renderer/src/panels/WorkbenchNavigationPanel', () => ({
  WorkbenchNavigationPanel: (props: { nodeId: string; active: boolean; centerOnly?: boolean; onSelect?: (sel: string) => void; onClose?: () => void }) =>
    <section data-testid={`nav-${props.nodeId}`} data-active={String(props.active)} data-center-only={String(props.centerOnly)}>
      <input aria-label={`导航输入 ${props.nodeId}`} />
      <button onClick={() => props.onSelect?.('nav:child')}>打开文件夹子项</button>
      <button onClick={props.onClose}>导航内部关闭</button>
      <iframe data-testid={`guest-${props.nodeId}`} title={`导航guest ${props.nodeId}`} />
    </section>
}));

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType = 'mouse';
  readonly isPrimary = true;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 7; }
}
const session = (id: string, runtime?: string): SessionMeta => ({
  id, type: 'terminal', name: { a: '会话甲', b: '会话乙', c: '会话丙' }[id], launchKind: 'agent', runtime
}) as SessionMeta;
let rows: SessionMeta[];
let primary: SplitPaneRef;
let selected: SplitPaneRef[];
let prefs: { dir: 'row' | 'col'; ratio: number };
let saved: { dir?: string; ratio?: number }[];
let setUtility: (selection: string | null) => void;
let width: number;
let height: number;
let observers: ResizeObserverCallback[];
let fullscreenElement: Element | null;
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;
const fullscreenDescriptors = [
  [document, 'fullscreenElement'], [document, 'fullscreenEnabled'], [document, 'exitFullscreen'],
  [document.documentElement, 'requestFullscreen']
].map(([object, property]) => ({ object: object as object, property: property as string,
  descriptor: Object.getOwnPropertyDescriptor(object, property as string) }));
const originalCapture = {
  set: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'setPointerCapture'),
  release: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'releasePointerCapture')
};

function selectPrimary(ref: SplitPaneRef) {
  primary = ref;
  setUtility(ref.kind === 'utility' ? ref.sel : null);
  if (ref.kind === 'session') currentApiMock().emit('sessions:changed', { sessions: rows, activeId: ref.sessionId });
}
function Harness({ initialUtility = null }: { initialUtility?: string | null }) {
  const [utility, updateUtility] = React.useState(initialUtility);
  setUtility = updateUtility;
  return <StoreProvider><CenterPanel utilityPanel={utility as never}
    onCloseUtilityPanel={() => selectPrimary({ kind: 'session', sessionId: 'a' })}
    onSelectUtilityPanel={selection => selectPrimary({ kind: 'utility', sel: selection! })} /></StoreProvider>;
}
const main = () => screen.getByTestId('center-panel');
const content = (id: string) => screen.getByTestId(`content-${id}`);
const input = (id: string) => screen.getByRole('textbox', { name: `输入 ${id}` }) as HTMLTextAreaElement;
const handle = (slot: CenterPaneSlot) => screen.getByTestId(`center-pane-handle-${slot}`);
// These are the miniature DOM rectangles, not normalized destination geometry.
// Captured events keep their handle target; the production hook must hit-test
// these actual cells by client coordinates rather than event.target.
const snapCellRects: Record<CenterSnapLayoutId, number[][]> = {
  halves: [[160, 20, 35, 40], [199, 20, 35, 40]],
  wide: [[244, 20, 46, 40], [294, 20, 24, 40]],
  stack: [[329, 20, 70, 18], [329, 42, 70, 18]],
  focus: [[410, 20, 34, 40], [448, 20, 34, 18], [448, 42, 34, 18]],
  'focus-mirror': [[486, 20, 34, 18], [486, 42, 34, 18], [524, 20, 34, 40]],
  thirds: [[564, 20, 20, 40], [588, 20, 20, 40], [612, 20, 20, 40]]
};
const cellPoint = (layout: CenterSnapLayoutId, index: number) => {
  const [x, y, w, h] = snapCellRects[layout][index]; return [x + w / 2, y + h / 2] as const;
};
const cell = (layout: CenterSnapLayoutId, index: number) => screen.getByTestId(`center-snap-cell-${layout}-${index}`);
const dimensions = (element: HTMLElement) => ({ left: Number.parseFloat(element.style.left) || 0,
  top: Number.parseFloat(element.style.top) || 0, width: Number.parseFloat(element.style.width), height: Number.parseFloat(element.style.height) });

beforeEach(() => {
  vi.clearAllMocks();
  __resetCenterSplitForTest();
  resetChatFindSharedForTest();
  rows = [session('a'), session('b'), session('c')];
  primary = { kind: 'session', sessionId: 'a' }; selected = []; saved = [];
  prefs = { dir: 'row', ratio: 0.5 }; setUtility = () => {}; width = 800; height = 600; observers = [];
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  requestFullscreen = vi.fn(async () => {
    fullscreenElement = document.documentElement; document.dispatchEvent(new Event('fullscreenchange'));
  });
  exitFullscreen = vi.fn(async () => {
    fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange'));
  });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('center-panel') ? width : Number.parseFloat(this.style.width) || width;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('center-panel') ? height : Number.parseFloat(this.style.height) || height;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.dataset.testid === 'center-snap-bar') return new DOMRect(150, 10, 520, 64);
    const layout = this.dataset.centerSnapLayout as CenterSnapLayoutId | undefined;
    if (layout && this.dataset.centerSnapIndex != null) {
      const [x, y, w, h] = snapCellRects[layout][Number(this.dataset.centerSnapIndex)]; return new DOMRect(x, y, w, h);
    }
    return new DOMRect(Number.parseFloat(this.style.left) || 0, Number.parseFloat(this.style.top) || 0,
      this.classList.contains('center-panel') ? width : Number.parseFloat(this.style.width) || width,
      this.classList.contains('center-panel') ? height : Number.parseFloat(this.style.height) || height);
  });
  currentApiMock().override('sessions.list', () => Promise.resolve({ sessions: rows, activeId: 'a' }));
  currentApiMock().override('runtimes.list', () => Promise.resolve([{ id: 'gui', label: 'GUI', surface: 'chat', enabled: true }]));
  currentApiMock().override('workbench.navigation', () => Promise.resolve({ workspaceId: '', sourceRootId: '', selectionRevision: 0, revision: 0, nodes: [], libraryExpanded: false }));
  attachCenterSplitBridge({ getPrimary: () => primary, selectRef: ref => { selected.push(ref); selectPrimary(ref); },
    getPrefs: () => prefs, savePrefs: next => saved.push(next) });
});
afterEach(() => {
  act(() => __resetCenterSplitForTest());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const { object, property, descriptor } of fullscreenDescriptors) {
    if (descriptor) Object.defineProperty(object, property, descriptor); else Reflect.deleteProperty(object, property);
  }
  for (const [property, descriptor] of [['setPointerCapture', originalCapture.set], ['releasePointerCapture', originalCapture.release]] as const) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, property);
  }
});

async function mount(utility: string | null = null) {
  if (utility) primary = { kind: 'utility', sel: utility };
  render(<Harness initialUtility={utility} />);
  await waitFor(() => expect(content('a')).toBeTruthy());
}
async function splitWith(ref: SplitPaneRef = { kind: 'session', sessionId: 'b' }, side: 'right' | 'bottom' = 'right') {
  act(() => centerSplitIncoming(ref, side));
  await waitFor(() => expect(getCenterSplitState().open).toBe(true));
}

it('切换内容保活扩展 iframe，明确关闭后释放并重新打开', async () => {
  const workspace = { id: 'extension-close-test', name: '扩展关闭', path: 'E:/extension-close-test' };
  const selection = { kind: 'utility', sel: 'nav:close-test' } as const;
  rows = rows.map(row => ({ ...row, workspaceId: workspace.id }));
  currentApiMock().override('workspaces.list', async () => ({ workspaces: [workspace], activeWorkspaceId: workspace.id }));
  currentApiMock().override('config.get', async () => ({ locale: 'zh-CN', workspaces: [workspace], activeWorkspaceId: workspace.id }));
  currentApiMock().override('workbench.navigation', async () => ({
    workspaceId: workspace.id, sourceRootId: 'root', selectionRevision: 0, revision: 1, libraryExpanded: false,
    nodes: [{ id: 'close-test', kind: 'extension', title: '扩展关闭', extensionId: 'close-test', parentId: null }]
  }));
  await mount(selection.sel);
  await screen.findByRole('toolbar', { name: '扩展关闭' });
  const guest = screen.getByTestId('guest-close-test');
  act(() => selectPrimary({ kind: 'session', sessionId: 'a' }));
  await waitFor(() => expect(guest.closest<HTMLElement>('.center-utility-layer')?.style.display).toBe('none'));
  act(() => selectPrimary(selection));
  expect(screen.getByTestId('guest-close-test')).toBe(guest);

  fireEvent.click(within(screen.getByTestId('nav-close-test')).getByRole('button', { name: '导航内部关闭' }));
  await waitFor(() => expect(screen.queryByTestId('guest-close-test')).toBeNull());
  act(() => selectPrimary(selection));
  expect(await screen.findByTestId('guest-close-test')).not.toBe(guest);
});

it('后台工具从标签进入中栏时保留同一个实例', async () => {
  function BackgroundHarness() {
    const [utility, updateUtility] = React.useState<string | null>(null);
    return <StoreProvider><CenterPanel utilityPanel={utility as never} onCloseUtilityPanel={() => updateUtility(null)}
      backgroundViews={[{ id: 'bg', label: '定时任务', target: { kind: 'utility', sel: 'tasks' },
        onSelect: () => updateUtility('tasks'), onClose: () => {} }]}/></StoreProvider>;
  }
  render(<BackgroundHarness/>);
  const before = await screen.findByTestId('tasks-panel');
  const draft = before.querySelector('input')!;
  fireEvent.change(draft, { target: { value: '保留的内容' } });
  fireEvent.click(screen.getByRole('button', { name: '定时任务' }));
  await waitFor(() => expect(screen.getByTestId('tasks-panel')).toBe(before));
  expect((screen.getByTestId('tasks-panel').querySelector('input') as HTMLInputElement).value).toBe('保留的内容');
});

it('后台 GUI 会话从标签进入中栏时保留同一个会话实例', async () => {
  rows[2] = session('c', 'gui');
  function BackgroundSessionHarness() {
    const [utility, updateUtility] = React.useState<string | null>(null);
    const [shown, setShown] = React.useState(true);
    setUtility = updateUtility;
    return <StoreProvider><CenterPanel utilityPanel={utility as never} onCloseUtilityPanel={() => updateUtility(null)}
      backgroundViews={shown ? [{ id: 'bg-session', label: '会话丙', target: { kind: 'session', sessionId: 'c' },
        onSelect: () => selectPrimary({ kind: 'session', sessionId: 'c' }), onClose: () => setShown(false) }] : []}/></StoreProvider>;
  }
  render(<BackgroundSessionHarness/>);
  const before = await screen.findByTestId('content-c');
  const draft = before.querySelector('textarea')!;
  fireEvent.change(draft, { target: { value: '会话草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '会话丙' }));
  await waitFor(() => expect(screen.getByTestId('content-c')).toBe(before));
  expect((screen.getByTestId('content-c').querySelector('textarea') as HTMLTextAreaElement).value).toBe('会话草稿');
});

it('空分屏只列当前工作区未归档会话和终端，仍保留工具并支持搜索', async () => {
  rows = [session('a'), { ...session('b'), workspaceId: 'ws' }, { ...session('c'), workspaceId: 'other' },
    { ...session('archived'), workspaceId: 'ws', archived: true },
    { ...session('shell'), name: 'PowerShell', launchKind: 'shell', workspaceId: 'ws' }];
  rows[0].workspaceId = 'ws';
  currentApiMock().override('workspaces.list', async () => ({ workspaces: [{ id: 'ws', name: '当前', path: 'E:/test' }], activeWorkspaceId: 'ws' }));
  currentApiMock().override('config.get', async () => ({ workspaces: [{ id: 'ws', name: '当前', path: 'E:/test' }], activeWorkspaceId: 'ws', locale: 'zh-CN' }));
  await mount(); act(() => { centerSplitToggleShortcut(); });
  expect(screen.getByTestId('center-snap-fill-1-b')).toBeTruthy();
  expect(screen.getByTestId('center-snap-fill-1-shell')).toBeTruthy();
  expect(screen.queryByTestId('center-snap-fill-1-c')).toBeNull();
  expect(screen.queryByTestId('center-snap-fill-1-archived')).toBeNull();
  expect(screen.getByTestId('center-snap-fill-1-tasks')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'powershell' } });
  expect(screen.queryByTestId('center-snap-fill-1-b')).toBeNull();
  fireEvent.click(screen.getByTestId('center-snap-fill-1-shell'));
  expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'shell' });
});
function resize(nextWidth: number) {
  act(() => {
    width = nextWidth;
    for (const callback of observers) callback([], {} as ResizeObserver);
    window.dispatchEvent(new Event('resize'));
  });
}
function expectFull(element: HTMLElement) {
  expect(Number.parseFloat(element.style.left) || 0).toBe(0);
  expect(Number.parseFloat(element.style.top) || 0).toBe(0);
  expect(Number.parseFloat(element.style.width) || width).toBe(width);
  expect(Number.parseFloat(element.style.height) || height).toBe(height);
}
async function menuAction(slot: CenterPaneSlot, label: string) {
  fireEvent.click(handle(slot), { detail: 1 });
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());
  await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: label })); });
}
function dragEvent(type: 'dragStart' | 'dragOver' | 'drop', target: HTMLElement, x: number, y: number, payload: string, protectedMode = false, effectAllowed = 'copy') {
  const dataTransfer = { types: [SPLIT_DRAG_MIME], effectAllowed, dropEffect: 'none',
    getData: (mime: string) => !protectedMode && mime === SPLIT_DRAG_MIME ? payload : '' };
  const event = createEvent[type](target, { dataTransfer });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
  fireEvent(target, event);
  return { event, dataTransfer };
}
function startNativeDrag(payload: string, effect = 'copy') {
  dragEvent('dragStart', main(), 0, 0, payload, false, effect);
  dragEvent('dragOver', main(), 400, 18, payload, true, effect);
}
function pointer(target: HTMLElement, type: string, x: number, y: number, pointerId = 7, buttons?: number) {
  fireEvent(target, new TestPointerEvent(type, { bubbles: true, cancelable: true, button: 0,
    buttons: buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1), clientX: x, clientY: y, pointerId }));
}
async function threePanes(layoutId: 'focus' | 'thirds' = 'focus') {
  await splitWith();
  act(() => {
    const candidate = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId, index: 0 });
    expect(candidate).not.toBeNull(); expect(centerSplitCommitSnapLayout(candidate!)).toBe(true);
    centerSplitSelectInPane(2, { kind: 'session', sessionId: 'c' });
  });
  expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual(['a', 'b', 'c'].map(sessionId => ({ kind: 'session', sessionId })));
}

describe('网页式面板全屏', () => {
  it.each(['cli', 'gui', 'tasks', 'extension'] as const)('%s全屏保留两侧实例、草稿和原比例，退出恢复', async kind => {
    if (kind === 'gui') rows[1] = session('b', 'gui');
    if (kind === 'extension') {
      rows = rows.map(row => ({ ...row, workspaceId: 'fullscreen-test' }));
      currentApiMock().override('workspaces.list', () => Promise.resolve({ workspaces: [{ id: 'fullscreen-test', name: '测试', roots: [] }], activeWorkspaceId: 'fullscreen-test' }));
      currentApiMock().override('config.get', () => Promise.resolve({ workspaces: [{ id: 'fullscreen-test', name: '测试', roots: [] }], activeWorkspaceId: 'fullscreen-test', locale: 'zh-CN' }));
      currentApiMock().override('workbench.navigation', () => Promise.resolve({
      workspaceId: 'fullscreen-test', sourceRootId: 'root', selectionRevision: 0, revision: 0, libraryExpanded: false,
      nodes: [{ id: 'full', kind: 'extension', title: '全屏扩展', parentId: null, extensionId: 'fixture', viewId: 'pane' }]
      }));
    }
    await mount();
    await splitWith(kind === 'tasks' ? { kind: 'utility', sel: 'tasks' } : kind === 'extension'
      ? { kind: 'utility', sel: 'nav:full' } : { kind: 'session', sessionId: 'b' });
    act(() => centerSplitSetRatio(.63));
    const a = content('a'); fireEvent.change(input('a'), { target: { value: '原侧草稿' } });
    const other = kind === 'tasks' ? screen.getByTestId('tasks-panel') : kind === 'extension' ? screen.getByTestId('guest-full') : content('b');
    const before = getCenterSplitState();
    await menuAction(1, '全屏显示');
    await waitFor(() => expect(main().classList.contains('is-pane-fullscreen')).toBe(true));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(document.fullscreenElement).toBe(document.documentElement);
    expect(content('a')).toBe(a); expect(content('a').dataset.visible).toBe('false');
    expect(dimensions(screen.getByTestId('center-pane-1'))).toEqual({ left: 0, top: 0, width, height });
    expect(screen.queryByRole('separator', { name: '调整分屏比例' })).toBeNull();
    expect(getCenterSplitState()).toEqual({ ...before, focused: 1 });
    await menuAction(1, '退出全屏');
    await waitFor(() => expect(main().classList.contains('is-pane-fullscreen')).toBe(false));
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(getCenterSplitState()).toEqual({ ...before, focused: 1 });
    expect(content('a')).toBe(a); expect(input('a').value).toBe('原侧草稿');
    expect(kind === 'tasks' ? screen.getByTestId('tasks-panel') : kind === 'extension' ? screen.getByTestId('guest-full') : content('b')).toBe(other);
    expect(dimensions(screen.getByTestId('center-pane-1')).left).toBeCloseTo(width * .63);
  });

  it('单屏也可全屏，浏览器原生退出事件恢复布局', async () => {
    await mount('tasks');
    await menuAction(0, '全屏显示');
    await waitFor(() => expect(main().classList.contains('is-pane-fullscreen')).toBe(true));
    act(() => { fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange')); });
    expect(main().classList.contains('is-pane-fullscreen')).toBe(false);
    expect(getCenterSplitState().open).toBe(false);
  });

  it('Escape退出全屏；仅可见的本面板iframe能中继退出，陌生来源被忽略', async () => {
    const { PANEL_ESCAPE_EVENT } = await import('../../src/shared/panelRelay');
    await mount(); await splitWith({ kind: 'utility', sel: 'nav:folder' });
    // Primary is a supported terminal; the guest remains mounted in the other pane.
    await menuAction(0, '全屏显示');
    const guest = screen.getByTestId('guest-folder') as HTMLIFrameElement;
    const data = { __ma: true, type: PANEL_ESCAPE_EVENT };
    fireEvent(window, new MessageEvent('message', { data, source: guest.contentWindow }));
    expect(main().classList.contains('is-pane-fullscreen')).toBe(true);
    fireEvent(window, new MessageEvent('message', { data, source: window }));
    expect(main().classList.contains('is-pane-fullscreen')).toBe(true);
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(main().classList.contains('is-pane-fullscreen')).toBe(false);
  });

  it('三分屏全屏退出后完整保留顺序与引用，切换内容自动退出', async () => {
    await mount(); await threePanes('thirds');
    const before = getCenterSplitState();
    await menuAction(2, '全屏显示');
    await waitFor(() => expect(main().classList.contains('is-pane-fullscreen')).toBe(true));
    await menuAction(2, '退出全屏');
    expect(getCenterSplitState()).toEqual({ ...before, focused: 2 });
    await menuAction(1, '全屏显示');
    await waitFor(() => expect(main().classList.contains('is-pane-fullscreen')).toBe(true));
    act(() => centerSplitClosePane(1));
    await waitFor(() => expect(document.fullscreenElement).toBeNull());
    expect(main().classList.contains('is-pane-fullscreen')).toBe(false);
  });

  it('全屏被拒绝时保持原布局并显示可见错误', async () => {
    const { getTipSnapshot, dismissTip } = await import('../../src/renderer/src/tips');
    requestFullscreen.mockRejectedValueOnce(new Error('Fullscreen denied'));
    await mount(); await splitWith(); const before = getCenterSplitState();
    await menuAction(0, '全屏显示');
    await waitFor(() => expect(getTipSnapshot()?.text).toContain('Fullscreen denied'));
    expect(main().classList.contains('is-pane-fullscreen')).toBe(false);
    expect(getCenterSplitState()).toEqual({ ...before, focused: 0 }); dismissTip();
  });

  it('等待全屏期间布局变化，迟到的进入回执立即退出', async () => {
    let finish!: () => void;
    requestFullscreen.mockImplementationOnce(() => new Promise<void>(resolve => { finish = () => {
      fullscreenElement = document.documentElement; document.dispatchEvent(new Event('fullscreenchange')); resolve();
    }; }));
    await mount(); await splitWith(); await menuAction(0, '全屏显示');
    act(() => centerSplitClose());
    await act(async () => { finish(); });
    expect(document.fullscreenElement).toBeNull();
    expect(main().classList.contains('is-pane-fullscreen')).toBe(false);
  });
});

describe('hover pane toolbar', () => {
  it.each(['button', 'menu'] as const)('从%s进入全屏后清除旧悬停状态，无需先进入再离开顶栏', async entry => {
    await mount(); await splitWith();
    const toolbar = screen.getByRole('toolbar', { name: '会话乙' });
    const host = toolbar.closest('.center-pane-toolbar-host')!;
    fireEvent.pointerEnter(host);
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('in'));
    if (entry === 'menu') await menuAction(1, '全屏显示');
    else await act(async () => { fireEvent.click(within(toolbar).getByRole('button', { name: '全屏显示' })); });
    expect(main().classList.contains('is-pane-fullscreen')).toBe(true);
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('out'));
    // No pointerleave is synthesized by jsdom's fullscreen geometry change.
    fireEvent.pointerMove(host.querySelector('.center-pane-toolbar-hotzone')!);
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('in'));
    fireEvent.pointerLeave(host);
    expect(toolbar.dataset.mpStage).toBe('out');
  });

  it.each(['pointerDown', 'pointerMove'] as const)('%s正文清除未收到leave的悬停与键盘驻留，但不抢正文焦点', async event => {
    await mount();
    const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    fireEvent.pointerEnter(toolbar.closest('.center-pane-toolbar-host')!);
    const matches = handle(0).matches.bind(handle(0));
    vi.spyOn(handle(0), 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    act(() => handle(0).focus());
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('in'));
    fireEvent[event](content('a'));
    expect(toolbar.dataset.mpStage).toBe('out');
    expect(document.activeElement).toBe(handle(0));
  });

  it('键盘进入全屏后仍保留顶栏可见性，切回鼠标操作才解除键盘驻留', async () => {
    await mount();
    const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    const action = within(toolbar).getByRole('button', { name: '全屏显示' });
    const matches = action.matches.bind(action);
    vi.spyOn(action, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    act(() => action.focus());
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('in'));
    await act(async () => { fireEvent.keyDown(action, { key: 'Enter' }); fireEvent.click(action, { detail: 0 }); });
    expect(main().classList.contains('is-pane-fullscreen')).toBe(true);
    expect(toolbar.dataset.mpStage).toBe('in');
    fireEvent.pointerMove(content('a'));
    expect(toolbar.dataset.mpStage).toBe('out');
  });

  it.each(['guest', 'blur'] as const)('%s跨文档离开清除驻留，工具栏子元素之间移动仍显示', async destination => {
    await mount();
    const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    const matches = handle(0).matches.bind(handle(0));
    vi.spyOn(handle(0), 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    act(() => handle(0).focus());
    fireEvent.pointerEnter(toolbar.closest('.center-pane-toolbar-host')!);
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('in'));
    fireEvent.pointerOut(handle(0), { relatedTarget: within(toolbar).getByRole('button', { name: '全屏显示' }) });
    expect(toolbar.dataset.mpStage).toBe('in');
    if (destination === 'guest') {
      const iframe = document.createElement('iframe'); content('a').appendChild(iframe);
      fireEvent.pointerOut(handle(0), { relatedTarget: iframe });
    } else fireEvent(window, new Event('blur'));
    expect(toolbar.dataset.mpStage).toBe('out');
  });

  it('三分屏调宽期间Escape优先取消，不被输入区或浮层的按键拦截阻断', async () => {
    await mount(); await threePanes();
    act(() => centerSplitSetDividerRatio(0, .6));
    const original = [...getCenterSplitState().ratios!];
    const divider = screen.getAllByRole('separator')[1];
    const swallow = (event: KeyboardEvent) => { if (event.key === 'Escape') event.stopPropagation(); };
    document.addEventListener('keydown', swallow, true);
    try {
      act(() => input('b').focus());
      pointer(divider, 'pointerdown', 600, 300); pointer(divider, 'pointermove', 600, 180);
      expect(getCenterSplitState().ratios).not.toEqual(original);
      fireEvent.keyDown(input('b'), { key: 'Escape' });
      expect(getCenterSplitState().ratios).toEqual(original);
    } finally { document.removeEventListener('keydown', swallow, true); }
  });

  it.each(['thirds', 'focus', 'focus-mirror'] as const)('三分屏%s提供两条可拖动分隔条，保留全部内容与草稿', async layoutId => {
    await mount(); await threePanes(layoutId === 'thirds' ? 'thirds' : 'focus');
    if (layoutId === 'focus-mirror') act(() => {
      const candidate = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId, index: 2 });
      expect(centerSplitCommitSnapLayout(candidate!)).toBe(true);
    });
    const roots = ['a', 'b', 'c'].map(content); const draft = input('b');
    fireEvent.change(draft, { target: { value: '三分屏调宽保留草稿' } });
    const dividers = screen.getAllByRole('separator'); expect(dividers).toHaveLength(2);
    expect(dividers.map(divider => divider.getAttribute('aria-orientation'))).toEqual(['vertical', layoutId === 'thirds' ? 'vertical' : 'horizontal']);
    pointer(dividers[0], 'pointerdown', 400, 200); pointer(dividers[0], 'pointermove', layoutId === 'thirds' ? 360 : 520, 200);
    pointer(dividers[0], 'pointerup', 520, 200);
    expect(getCenterSplitState().ratios?.[0]).toBeCloseTo(layoutId === 'thirds' ? .45 : .65);
    pointer(dividers[1], 'pointerdown', 600, 300); pointer(dividers[1], 'pointermove', 640, 180); pointer(dividers[1], 'pointerup', 640, 180);
    expect(getCenterSplitState().ratios?.[1]).toBeCloseTo(layoutId === 'thirds' ? .8 : .3);
    ['a', 'b', 'c'].forEach((id, index) => expect(content(id)).toBe(roots[index]));
    expect(input('b')).toBe(draft); expect(draft.value).toBe('三分屏调宽保留草稿');
    const original = [...getCenterSplitState().ratios!];
    pointer(dividers[1], 'pointerdown', 640, 180); pointer(dividers[1], 'pointermove', 700, 450);
    fireEvent.keyDown(dividers[1], { key: 'Escape' }); expect(getCenterSplitState().ratios).toEqual(original);
    fireEvent.keyDown(dividers[1], { key: 'Home' });
    const clamped = getCenterSplitState().ratios![1];
    expect(clamped).toBeCloseTo(layoutId === 'thirds' ? .65 : .2);
    fireEvent.doubleClick(dividers[1]); expect(getCenterSplitState().ratios![1]).toBeGreaterThan(clamped);
    resize(320); expect(screen.queryAllByRole('separator')).toHaveLength(0); resize(800);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('默认隐藏，顶部悬停展开，离开退出且快速返回可反向恢复', async () => {
    await mount();
    const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    const host = toolbar.closest('.center-pane-toolbar-host')!;
    expect(toolbar.dataset.mpStage).toBe('out');
    fireEvent.pointerEnter(host);
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('in'));
    fireEvent.pointerLeave(host); expect(toolbar.dataset.mpStage).toBe('out');
    fireEvent.pointerEnter(host);
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('in'));
    expect(screen.getByTestId('center-pane-handle-0')).toBe(handle(0));
  });

  it('菜单打开或指针捕获期间离开热区不收起，结束后恢复默认隐藏', async () => {
    await mount();
    const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    const host = toolbar.closest('.center-pane-toolbar-host')!;
    fireEvent.pointerEnter(host); fireEvent.click(handle(0)); fireEvent.pointerLeave(host);
    expect(toolbar.dataset.mpStage).toBe('in');
    fireEvent.click(handle(0)); expect(toolbar.dataset.mpStage).toBe('out');
    fireEvent.pointerEnter(host); pointer(handle(0), 'pointerdown', 400, 16); fireEvent.pointerLeave(host);
    expect(toolbar.dataset.mpStage).toBe('in');
    pointer(handle(0), 'pointercancel', 400, 16); expect(toolbar.dataset.mpStage).toBe('out');
  });

  it('键盘聚焦把手可展开，焦点离开工具栏后收起', async () => {
    await mount();
    const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    // jsdom has no browser input-modality model; native Tab is covered in Chromium.
    const matches = handle(0).matches.bind(handle(0));
    vi.spyOn(handle(0), 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    act(() => handle(0).focus());
    await waitFor(() => expect(toolbar.dataset.mpStage).toBe('in'));
    act(() => input('a').focus());
    expect(toolbar.dataset.mpStage).toBe('out');
  });
  it('名称区域只聚焦所属面板，拖动与长按由独立中央把手接管', async () => {
    await mount(); await splitWith();
    const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    const name = within(toolbar).getByText('会话甲');
    pointer(name, 'pointerdown', 20, 16);
    expect(getCenterSplitState().focused).toBe(0);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    pointer(name, 'pointerup', 20, 16);
    expect(handle(0).contains(name)).toBe(false);
    pointer(handle(0), 'pointerdown', 200, 16);
    expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
    pointer(handle(0), 'pointercancel', 200, 16);
  });

  it('顶角跟随物理位置，交换后外角圆、接缝直，窄屏恢复两个外角', async () => {
    await mount();
    const corners = (slot: CenterPaneSlot) => {
      const pane = screen.getByTestId(`center-pane-${slot}`);
      return [pane.dataset.topLeft === 'true', pane.dataset.topRight === 'true'];
    };
    expect(corners(0)).toEqual([true, true]);
    await splitWith();
    expect(corners(0)).toEqual([true, false]); expect(corners(1)).toEqual([false, true]);
    await menuAction(0, '与对面交换');
    expect(corners(0)).toEqual([true, false]); expect(corners(1)).toEqual([false, true]);
    // Swap changes references; a Snap reorder changes physical slot positions.
    act(() => {
      const candidate = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 0, { layoutId: 'halves', index: 1 });
      expect(candidate).not.toBeNull(); expect(centerSplitCommitSnapLayout(candidate!)).toBe(true);
    });
    expect(corners(0)).toEqual([false, true]); expect(corners(1)).toEqual([true, false]);
    resize(320); expect(corners(getCenterSplitState().focused)).toEqual([true, true]);
    resize(800); await menuAction(0, '转为上下分屏');
    const top = [0, 1].find(slot => Number.parseFloat(screen.getByTestId(`center-pane-${slot}`).style.top) === 0) as CenterPaneSlot;
    expect(corners(top)).toEqual([true, true]); expect(corners(top === 0 ? 1 : 0)).toEqual([false, false]);
  });

  it('三列中间顶栏不加外角，提起时中央把手所属栏恢复独立双圆角', async () => {
    await mount(); await threePanes('thirds');
    const middle = ([0, 1, 2] as const).map(slot => screen.getByTestId(`center-pane-${slot}`))
      .sort((a, b) => Number.parseFloat(a.style.left) - Number.parseFloat(b.style.left))[1];
    const slot = Number(middle.dataset.pane) as CenterPaneSlot;
    expect(middle.dataset.topLeft).toBeUndefined(); expect(middle.dataset.topRight).toBeUndefined();
    pointer(handle(slot), 'pointerdown', 400, 16); pointer(handle(slot), 'pointermove', 420, 100);
    expect(middle.dataset.topLeft).toBe('true'); expect(middle.dataset.topRight).toBe('true');
    pointer(handle(slot), 'pointercancel', 420, 100);
    expect(middle.dataset.topLeft).toBeUndefined(); expect(middle.dataset.topRight).toBeUndefined();
  });

  it('顶栏展示会话名、规范状态、运行时和进展，推送后同步更新', async () => {
    rows[0] = { ...session('a', 'gui'), lifecycle: 'working', liveStatus: { label: '正在检查顶栏', kind: 'active', ts: Date.now() } };
    await mount();
    const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    expect(within(toolbar).getByText('会话甲')).toBeTruthy();
    expect(within(toolbar).getByText('工作中')).toBeTruthy();
    expect(within(toolbar).getByText('GUI')).toBeTruthy();
    expect(within(toolbar).getByText('正在检查顶栏')).toBeTruthy();
    rows = rows.map((row, index) => index === 0 ? { ...row, phase: { value: 'needs_you', source: 'model', ts: Date.now() }, lifecycle: 'idle',
      liveStatus: { label: '等待验收', kind: 'info', ts: Date.now() } } : row);
    act(() => currentApiMock().emit('sessions:changed', { sessions: [...rows], activeId: 'a' }));
    await waitFor(() => expect(within(toolbar).getByText('需要你')).toBeTruthy());
    expect(within(toolbar).getByText('等待验收')).toBeTruthy();
  });

  it('查找按钮精确指向所属分屏，重开聚焦并复用搜索词；终端和工具不显示', async () => {
    rows[1] = session('b', 'gui');
    await mount(); await splitWith();
    expect(within(screen.getByRole('toolbar', { name: '会话甲' })).queryByRole('button', { name: '查找会话消息' })).toBeNull();
    const find = within(screen.getByRole('toolbar', { name: '会话乙' })).getByRole('button', { name: '查找会话消息' });
    act(() => patchChatFindShared({ scope: 'all', query: '原查询', ownerId: 'a' }));
    fireEvent.click(find);
    expect(getCenterSplitState().focused).toBe(1);
    expect(getChatFindShared()).toMatchObject({ open: true, ownerId: 'b', scope: 'current', query: '原查询', activeHitId: null, focusEpoch: 1 });
    fireEvent.click(find); expect(getChatFindShared().focusEpoch).toBe(2);
    act(() => centerSplitSelectInPane(1, { kind: 'utility', sel: 'tasks' }));
    expect(within(screen.getByRole('toolbar', { name: '定时任务' })).queryByRole('button', { name: '查找会话消息' })).toBeNull();
  });

  it('分屏按钮直接打开布局条并支持Escape返回，中央三点保留菜单', async () => {
    await mount(); const toolbar = screen.getByRole('toolbar', { name: '会话甲' });
    fireEvent.click(within(toolbar).getByRole('button', { name: '选择分屏布局' }));
    expect(screen.getByTestId('center-snap-bar')).toBeTruthy();
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    fireEvent.keyDown(cell('halves', 0), { key: 'Escape' });
    expect(document.activeElement).toBe(handle(0));
    const more = handle(0);
    fireEvent.click(more); expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
  });

  it.each([0, 1] as const)('右侧关闭按钮收起slot%s，中央三点仍打开菜单且不丢草稿', async slot => {
    await mount();
    expect(within(screen.getByRole('toolbar', { name: '会话甲' })).queryByRole('button', { name: '关闭面板' })).toBeNull();
    await splitWith();
    fireEvent.change(input('a'), { target: { value: '甲草稿' } });
    fireEvent.change(input('b'), { target: { value: '乙草稿' } });
    const survivor = content(slot === 0 ? 'b' : 'a');
    fireEvent.click(handle(slot)); expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(handle(slot));
    const close = within(screen.getByRole('toolbar', { name: slot === 0 ? '会话甲' : '会话乙' })).getByRole('button', { name: '关闭面板' });
    pointer(close, 'pointerdown', 390, 16);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    fireEvent.click(close);
    await waitFor(() => expect(getCenterSplitState().open).toBe(false));
    expect(content(slot === 0 ? 'b' : 'a')).toBe(survivor);
    expect(input(slot === 0 ? 'b' : 'a').value).toBe(slot === 0 ? '乙草稿' : '甲草稿');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('只剩一个会话时隐藏关闭，分屏关闭一侧后剩余侧立即隐藏', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: '关闭面板' })).toBeNull();
    await splitWith();
    fireEvent.click(within(screen.getByRole('toolbar', { name: '会话乙' })).getByRole('button', { name: '关闭面板' }));
    await waitFor(() => expect(getCenterSplitState().open).toBe(false));
    expect(screen.queryByRole('button', { name: '关闭面板' })).toBeNull();
    expect(currentApiMock().mockOf('sessions.deselect')).not.toHaveBeenCalled();
  });

  it('单个会话加空选择器时也隐藏会话关闭，空格仍可收起', async () => {
    await mount(); act(() => centerSplitToggleShortcut());
    expect(within(screen.getByRole('toolbar', { name: '会话甲' })).queryByRole('button', { name: '关闭面板' })).toBeNull();
    expect(within(screen.getByRole('toolbar', { name: '选择内容' })).getByRole('button', { name: '关闭面板' })).toBeTruthy();
  });

  it('单屏工具右侧关闭返回背后会话', async () => {
    await mount('tasks');
    fireEvent.click(within(screen.getByRole('toolbar', { name: '定时任务' })).getByRole('button', { name: '关闭面板' }));
    expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
  });

  it('窄屏只在可见工具栏放置切换入口，切换后草稿和实例保留', async () => {
    await mount(); await splitWith(); resize(320);
    const root = content('a'); const draft = input('a');
    fireEvent.change(draft, { target: { value: '窄屏草稿' } });
    const switcher = screen.getByTestId('center-pane-switch-1');
    expect(switcher.closest('[role="toolbar"]')?.getAttribute('aria-label')).toBe('会话乙');
    fireEvent.click(screen.getByTestId('center-pane-switch-0'));
    expect(screen.getByTestId('center-pane-switch-1').closest('[role="toolbar"]')?.getAttribute('aria-label')).toBe('会话甲');
    expect(content('a')).toBe(root); expect(input('a')).toBe(draft); expect(draft.value).toBe('窄屏草稿');
  });
});

describe('production split: full-size and fixed content roots (R1/R4/R5)', () => {
  it.each([0, 1] as const)('收起slot%s后对侧满幅、原DOM和草稿保留', async slot => {
    await mount(); await splitWith();
    const a = content('a'); const b = content('b'); const draftA = input('a'); const draftB = input('b');
    fireEvent.change(draftA, { target: { value: '甲保活' } }); fireEvent.change(draftB, { target: { value: '乙保活' } });
    expect(Number.parseFloat(a.style.width)).toBe(400);
    await menuAction(slot, '收起此侧');
    await waitFor(() => expect(getCenterSplitState().open).toBe(false));
    expectFull(content(slot === 0 ? 'b' : 'a'));
    expect(content('a')).toBe(a); expect(content('b')).toBe(b);
    expect(input('a')).toBe(draftA); expect(input('b')).toBe(draftB);
    expect(draftA.value).toBe('甲保活'); expect(draftB.value).toBe('乙保活');
  });
  it.each([0, 1] as const)('解散保留slot%s后内容恢复完整工作面', async slot => {
    await mount(); await splitWith();
    await menuAction(slot, '解散分屏（保留此侧）');
    await waitFor(() => expect(getCenterSplitState().open).toBe(false));
    expectFull(content(slot === 0 ? 'a' : 'b'));
  });
  it('切区收起分屏后不应用原工作区的旧半屏定位', async () => {
    await mount(); await splitWith();
    const original = content('a');
    act(() => {
      centerSplitClose();
      currentApiMock().emit('workspaces:changed', { workspaces: [], activeWorkspaceId: 'new-ws' });
    });
    await waitFor(() => expectFull(content('a')));
    expect(content('a')).toBe(original);
  });
  it('三个常驻会话中A+工具只显示A，B/C仍遵守hidden契约', async () => {
    await mount();
    // 会话视图 LRU（性能专项）只保活最近访问的会话：B/C 作为常驻需先计入池
    act(() => { touchSessionView('b'); touchSessionView('c'); });
    await splitWith({ kind: 'utility', sel: 'tasks' });
    expect(content('a').dataset.visible).toBe('true');
    for (const id of ['b', 'c']) {
      expect(content(id).dataset.visible).toBe('false'); expect(content(id).classList.contains('is-shown')).toBe(false);
    }
    expect(screen.getByTestId('tasks-panel')).toBeTruthy();
  });
  it.each(['terminal', 'chat'] as const)('窄屏%s会话按焦点满幅，切换和恢复比例不重挂内容', async surface => {
    if (surface === 'chat') rows[1] = session('b', 'gui');
    await mount(); await splitWith();
    act(() => centerSplitSetRatio(0.65));
    const a = content('a'); const b = content('b');
    resize(400);
    await waitFor(() => expect(content('b').dataset.visible).toBe('true'));
    expect(content('a').dataset.visible).toBe('false'); expectFull(content('b'));
    fireEvent.click(screen.getByTestId('center-pane-switch-0'));
    expect(getCenterSplitState().focused).toBe(0); expectFull(content('a'));
    expect(content('b').dataset.visible).toBe('false');
    resize(900);
    await waitFor(() => expect(content('b').dataset.visible).toBe('true'));
    expect(Number.parseFloat(content('a').style.width)).toBe(585);
    expect(Number.parseFloat(content('b').style.width)).toBe(315);
    expect(getCenterSplitState().ratio).toBe(0.65); expect(content('a')).toBe(a); expect(content('b')).toBe(b);
  });
  it.each([0, 1] as const)('窄屏session+utility切到slot%s仍开着且满幅，拖宽恢复双侧', async focused => {
    await mount(); await splitWith({ kind: 'utility', sel: 'tasks' });
    act(() => { centerSplitSetRatio(0.6); centerSplitSetFocused(focused); }); resize(400);
    const layer = screen.getByTestId('tasks-panel').closest('.center-utility-layer') as HTMLElement;
    if (focused === 1) { await waitFor(() => expect(layer.dataset.mpStage).toBe('in')); expectFull(layer); }
    else expectFull(content('a'));
    fireEvent.click(screen.getByTestId(`center-pane-switch-${focused === 0 ? 1 : 0}`));
    if (focused === 0) { await waitFor(() => expect(layer.dataset.mpStage).toBe('in')); expectFull(layer); }
    else expectFull(content('a'));
    resize(800);
    await waitFor(() => expect(layer.dataset.mpStage).toBe('in'));
    expect(Number.parseFloat(layer.style.width)).toBe(320);
    expect(getCenterSplitState().ratio).toBe(0.6);
  });
});

describe('production split: native drop contract and content focus (R2/R8/R9/R12)', () => {
  it('侧栏提起先露提示边，经过提示区才展开完整布局，继续上移收回布局条', async () => {
    await mount(); const payload = encodeSplitDragPayload({ kind: 'session', sessionId: 'b' });
    dragEvent('dragStart', main(), 0, 0, payload);
    const picker = screen.getByTestId('center-snap-peek');
    expect(picker.classList.contains('center-snap-bar')).toBe(true);
    expect(picker.hasAttribute('inert')).toBe(true);
    expect(picker.querySelectorAll('.center-snap-layout')).toHaveLength(5);
    expect(screen.queryByTestId('center-snap-bar')).toBeNull();
    dragEvent('dragOver', main(), 80, 18, payload, true);
    expect(screen.queryByTestId('center-snap-bar')).toBeNull();
    dragEvent('dragOver', main(), 400, 18, payload, true);
    expect(screen.getByTestId('center-snap-bar')).toBe(picker);
    expect(picker.hasAttribute('inert')).toBe(false);
    dragEvent('dragOver', main(), 400, 4, payload, true);
    expect(screen.getByTestId('center-snap-peek')).toBe(picker);
  });
  it.each(['copy', 'move'])('侧栏提起显示同一Snap条，protected dragover协商%s，drop重算实际小格', async effect => {
    await mount();
    const payload = encodeSplitDragPayload({ kind: 'session', sessionId: 'b' });
    startNativeDrag(payload, effect);
    expect(screen.getByTestId('center-snap-bar')).toBeTruthy();
    expect(cell('halves', 1).dataset.snapRefId).toBe('b');
    const over = dragEvent('dragOver', main(), ...cellPoint('halves', 1), payload, true, effect);
    expect(over.event.defaultPrevented).toBe(true); expect(over.dataTransfer.dropEffect).toBe(effect);
    expect(screen.getByTestId('center-native-drop-shield')).toBeTruthy();
    expect(main().dataset.snapTarget).toBe('halves:1');
    expect(screen.getByTestId('center-snap-preview').style.left).toBe('400px');
    expect(getCenterSplitState().open).toBe(false);
    dragEvent('drop', main(), ...cellPoint('stack', 0), payload, false, effect);
    expect(getCenterSplitState().open).toBe(true); expect(getCenterSplitState().layoutId).toBe('stack');
    expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
    expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'b' });
    expect(getCenterSplitState().order).toEqual([1, 0]);
    expect(screen.queryByTestId('center-native-drop-shield')).toBeNull();
  });
  it.each([['left', 60, 0], ['right', 740, 1]] as const)('侧栏卡片碰%s边支持快速分屏，drop按释放点重算', async (_side, x, index) => {
    await mount(); const payload = encodeSplitDragPayload({ kind: 'session', sessionId: 'b' });
    startNativeDrag(payload);
    const over = dragEvent('dragOver', main(), x, 300, payload, true);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    expect(main().dataset.snapTarget).toBe('halves:' + index);
    expect(screen.getByTestId('center-snap-preview')).toBeTruthy();
    dragEvent('drop', main(), 800 - x, 300, payload);
    expect(getCenterSplitState().layoutId).toBe('halves');
    expect(getCenterSplitState().order?.[1]).toBe(1 - index);
  });
  it('侧栏快速分屏不能丢弃已有两个内容', async () => {
    await mount(); await splitWith(); const payload = encodeSplitDragPayload({ kind: 'session', sessionId: 'c' });
    startNativeDrag(payload);
    const over = dragEvent('dragOver', main(), 740, 300, payload, true);
    expect(over.dataTransfer.dropEffect).toBe('none');
    dragEvent('drop', main(), 740, 300, payload);
    expect(getCenterSplitState().tertiary).toBeUndefined();
    expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'b' });
  });
  it('侧栏拖入已双屏时只允许三格布局，原两项和草稿保留', async () => {
    await mount(); await splitWith();
    const original = content('a'); fireEvent.change(input('a'), { target: { value: '保留草稿' } });
    const payload = encodeSplitDragPayload({ kind: 'session', sessionId: 'c' });
    startNativeDrag(payload);
    expect((cell('halves', 0) as HTMLButtonElement).disabled).toBe(true);
    const over = dragEvent('dragOver', main(), ...cellPoint('thirds', 2), payload, true);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    dragEvent('drop', main(), ...cellPoint('thirds', 2), payload);
    expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual(['a', 'b', 'c'].map(sessionId => ({ kind: 'session', sessionId })));
    expect(content('a')).toBe(original); expect(input('a').value).toBe('保留草稿');
  });
  it.each(['gap', 'escape', 'blur', 'dragend', 'stale'])('侧栏Snap%s取消，不能沿用旧四方向或上次候选', async reason => {
    await mount();
    const payload = encodeSplitDragPayload({ kind: 'session', sessionId: 'b' });
    startNativeDrag(payload);
    dragEvent('dragOver', main(), ...cellPoint('halves', 1), payload, true);
    if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (reason === 'blur') fireEvent.blur(window);
    else if (reason === 'dragend') fireEvent.dragEnd(main());
    else if (reason === 'stale') act(() => centerSplitSetRatio(.6));
    dragEvent('drop', main(), ...(reason === 'gap' ? [237, 30] as const : cellPoint('halves', 1)), payload);
    expect(getCenterSplitState().open).toBe(false); expect(screen.queryByTestId('center-native-drop-shield')).toBeNull();
  });
  it('非分屏mime不接受、不显示盾层', async () => {
    await mount();
    fireEvent.dragOver(main(), { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByTestId('center-native-drop-shield')).toBeNull(); expect(getCenterSplitState().open).toBe(false);
  });
  it.each([0, 1] as const)('slot%s文件夹卡片回调保留并只导航所属槽位', async slot => {
    await mount(slot === 0 ? 'nav:folder' : null);
    await splitWith(slot === 0 ? { kind: 'session', sessionId: 'b' } : { kind: 'utility', sel: 'nav:folder' });
    const folder = screen.getByTestId('nav-folder');
    expect(folder.dataset.centerOnly).toBe('true');
    fireEvent.click(folder.querySelector('button')!);
    await waitFor(() => expect(screen.getByTestId('nav-child')).toBeTruthy());
    if (slot === 0) expect(primary).toEqual({ kind: 'utility', sel: 'nav:child' });
    else expect(getCenterSplitState().secondary).toEqual({ kind: 'utility', sel: 'nav:child' });
  });
  it.each([0, 1] as const)('slot%s内置工具内部关闭遵循收起该侧、保留对面', async slot => {
    await mount(slot === 0 ? 'tasks' : null);
    await splitWith(slot === 0 ? { kind: 'session', sessionId: 'b' } : { kind: 'utility', sel: 'tasks' });
    fireEvent.click(screen.getByRole('button', { name: '工具内部关闭' }));
    await waitFor(() => expect(getCenterSplitState().open).toBe(false));
    expectFull(content(slot === 0 ? 'b' : 'a'));
  });
  it('实际正文focusin切换逻辑槽位，列表tryFill填键盘焦点侧', async () => {
    await mount(); await splitWith();
    act(() => input('a').focus()); expect(getCenterSplitState().focused).toBe(0);
    act(() => input('b').focus()); expect(getCenterSplitState().focused).toBe(1);
    act(() => { expect(centerSplitTryFill({ kind: 'session', sessionId: 'c' })).toBe(true); });
    expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'c' });
  });
  it('guest焦点中继只接受当前可见iframe来源，拒绝foreign/错误消息/窄屏隐藏与保留旧frame', async () => {
    await mount('nav:folder'); await splitWith({ kind: 'utility', sel: 'nav:child' });
    const left = screen.getByTestId('guest-folder') as HTMLIFrameElement;
    const right = screen.getByTestId('guest-child') as HTMLIFrameElement;
    const focusGuest = (source: Window | null, data: unknown = { __ma: true, type: 'panelFocus' }) =>
      fireEvent(window, new MessageEvent('message', { source, data }));
    focusGuest(left.contentWindow); expect(getCenterSplitState().focused).toBe(0);
    focusGuest(right.contentWindow); expect(getCenterSplitState().focused).toBe(1);
    focusGuest(window); expect(getCenterSplitState().focused).toBe(1);
    focusGuest(left.contentWindow, { __ma: false, type: 'panelFocus' }); expect(getCenterSplitState().focused).toBe(1);
    focusGuest(left.contentWindow, { __ma: true, type: 'other' }); expect(getCenterSplitState().focused).toBe(1);
    resize(400);
    const leftLayer = left.closest('.center-utility-layer')!;
    expect(leftLayer.getAttribute('data-center-slot')).toBe('0');
    expect(leftLayer.getAttribute('aria-hidden')).toBe('true'); expect(leftLayer.hasAttribute('inert')).toBe(true);
    focusGuest(left.contentWindow); expect(getCenterSplitState().focused).toBe(1);
    resize(800);
    act(() => { expect(centerSplitSelectInPane(0, { kind: 'utility', sel: 'tasks' })).toBe(true); });
    expect(screen.getByTestId('guest-folder')).toBe(left);
    expect(leftLayer.hasAttribute('inert')).toBe(true);
    act(() => centerSplitSetFocused(1));
    focusGuest(left.contentWindow); expect(getCenterSplitState().focused).toBe(1);
  });
  it('handle键盘focus也同步槽位、点击菜单可换向', async () => {
    await mount(); await splitWith();
    act(() => handle(0).focus()); expect(getCenterSplitState().focused).toBe(0);
    await menuAction(0, '转为上下分屏');
    expect(getCenterSplitState().dir).toBe('col'); expect(saved.some(value => value.dir === 'col')).toBe(true);
  });
  it.each(['row', 'col'] as const)('单屏菜单请求%s时以记忆col打开后的实际方向判断翻转', async direction => {
    prefs = { dir: 'col', ratio: 0.65 };
    await mount();
    // Closed UI initially carries row, while opening restores the saved col.
    expect(getCenterSplitState().open).toBe(false); expect(getCenterSplitState().dir).toBe('row');
    await menuAction(0, direction === 'row' ? '转为左右分屏' : '转为上下分屏');
    expect(getCenterSplitState().open).toBe(true); expect(getCenterSplitState().dir).toBe(direction);
    expect(getCenterSplitState().secondary).toEqual({ kind: 'empty' });
    expect(getCenterSplitState().focused).toBe(1);
  });
  it('separator方向键/Home/End调比例，双击居中', async () => {
    await mount(); await splitWith();
    const divider = screen.getByRole('separator', { name: '调整分屏比例' });
    fireEvent.keyDown(divider, { key: 'ArrowRight' }); expect(getCenterSplitState().ratio).toBeGreaterThan(0.5);
    fireEvent.keyDown(divider, { key: 'Home' }); expect(getCenterSplitState().ratio).toBe(0.2);
    fireEvent.keyDown(divider, { key: 'End' }); expect(getCenterSplitState().ratio).toBe(0.8);
    fireEvent.doubleClick(divider); expect(getCenterSplitState().ratio).toBe(0.5);
  });
});

describe('production split: 6px pointer handle and reversible candidate layout', () => {
  const rect = (id: string) => {
    const style = content(id).style;
    return { left: style.left, top: style.top, width: style.width, height: style.height, transform: style.transform };
  };
  it('按下先保护iframe命中，阈值前不浮起或模糊；普通click打开菜单并释放保护层', async () => {
    await mount(); await splitWith();
    const original = { a: rect('a'), b: rect('b') };
    pointer(handle(0), 'pointerdown', 200, 16);
    expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
    expect(screen.queryByTestId('center-drag-scrim')).toBeNull();
    expect(screen.getByTestId('center-pane-0').dataset.floating).toBeUndefined();
    pointer(handle(0), 'pointermove', 204, 16);
    expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
    pointer(handle(0), 'pointerup', 204, 16);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    expect(handle(0).releasePointerCapture).toHaveBeenCalledWith(7);
    fireEvent.click(handle(0), { detail: 1 });
    expect(screen.getByRole('menu')).toBeTruthy(); expect(screen.queryByTestId('center-drag-scrim')).toBeNull();
  });
  it('三点长按直接弹出 Snap 选择条，无需拖到顶缘；未选松手即收起且不弹菜单', async () => {
    await mount(); await splitWith();
    const original = { a: rect('a'), b: rect('b') };
    vi.useFakeTimers();
    try {
      pointer(handle(0), 'pointerdown', 200, 16);
      // 按住未满时长：无 Snap 条
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.queryByTestId('center-snap-bar')).toBeNull();
      // 长按 400ms 到点：选择条即刻出现，pane 进入条区浮起形态（无需拖到顶缘）
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.getByTestId('center-snap-bar')).toBeTruthy();
      // 条区形态下移动保持选择条（g.bar 锁定）
      pointer(handle(0), 'pointermove', 220, 20);
      expect(screen.getByTestId('center-snap-bar')).toBeTruthy();
      // 松手未选：收起、不提交布局、不弹菜单
      pointer(handle(0), 'pointerup', 200, 16);
      // presence 退场动画（exitMs+80ms 兜底）在假定时器下需手动推进
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.queryByTestId('center-snap-bar')).toBeNull();
      expect(getCenterSplitState().open).toBe(true);
      expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
      fireEvent.click(handle(0), { detail: 1 });
      expect(screen.queryByRole('menu')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it.each(['single', 'empty-secondary'] as const)('%s可以提起已有内容，再由顶部布局条建立分屏', async scope => {
    await mount();
    if (scope === 'empty-secondary') act(() => centerSplitToggleShortcut());
    const original = content('a'), draft = input('a'); fireEvent.change(draft, { target: { value: '单屏也不重挂' } });
    pointer(handle(0), 'pointerdown', 200, 16);
    expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
    pointer(handle(0), 'pointermove', 400, 120);
    pointer(handle(0), 'pointermove', 400, 18);
    expect(screen.getByTestId('center-snap-bar')).toBeTruthy();
    pointer(handle(0), 'pointermove', ...cellPoint('focus', 0));
    expect(main().dataset.snapTarget).toBe('focus:0');
    pointer(handle(0), 'pointerup', ...cellPoint('focus', 0));
    expect(getCenterSplitState().layoutId).toBe('focus');
    expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual([
      { kind: 'session', sessionId: 'a' }, { kind: 'empty' }, { kind: 'empty' }
    ]);
    expect(content('a')).toBe(original); expect(input('a')).toBe(draft); expect(draft.value).toBe('单屏也不重挂');
    expect(content('a').style.transform).toBe('');
  });
  it.each([['left', 150], ['right', 650]] as const)('卡片碰%s边即预览，指针尚未进入18px边缘带', async (side, x) => {
    await mount(); await splitWith();
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', x, 120);
    expect(main().dataset.edgeAction).toBe(side);
    expect(screen.getByTestId('center-snap-preview').classList.contains('center-pane-preview')).toBe(true);
    expect(screen.getByText(side === 'left' ? '松开后左侧分屏' : '松开后右侧分屏')).toBeTruthy();
    pointer(handle(0), 'pointerup', x, 120);
    expect(getCenterSplitState().layoutId).toBe('halves');
    expect(getCenterSplitState().order?.[0]).toBe(side === 'left' ? 0 : 1);
  });
  it.each(['fullscreen', 'close'] as const)('上/下边缘%s预览不提前提交，松手后保留正确内容和草稿', async action => {
    await mount(); await splitWith();
    const a = content('a'), b = content('b'); fireEvent.change(input('b'), { target: { value: '边缘操作草稿' } });
    pointer(handle(1), 'pointerdown', 600, 16); pointer(handle(1), 'pointermove', 400, action === 'fullscreen' ? 4 : 145);
    expect(main().dataset.edgeAction).toBe(action);
    expect(getCenterSplitState().open).toBe(true);
    expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
    expect(screen.getByText(action === 'fullscreen' ? '松开后全屏显示' : '松开后关闭面板')).toBeTruthy();
    pointer(handle(1), 'pointerup', 400, action === 'fullscreen' ? 4 : 145);
    await waitFor(() => expect(action === 'fullscreen' ? main().classList.contains('is-pane-fullscreen') : !getCenterSplitState().open).toBe(true));
    expect(getCenterSplitState().open).toBe(action === 'fullscreen');
    expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
    expect(content('a')).toBe(a); expect(content('b')).toBe(b); expect(input('b').value).toBe('边缘操作草稿');
    expect(currentApiMock().mockOf('sessions.close')).not.toHaveBeenCalled();
  });
  it('底部关闭可移开取消或Esc取消；单屏禁用关闭预览与提交', async () => {
    await mount(); await splitWith(); const before = getCenterSplitState();
    pointer(handle(1), 'pointerdown', 600, 16); pointer(handle(1), 'pointermove', 400, 145);
    expect(main().dataset.edgeAction).toBe('close');
    pointer(handle(1), 'pointermove', 400, 120); expect(main().dataset.edgeAction).toBeUndefined();
    pointer(handle(1), 'pointerup', 400, 120); expect(getCenterSplitState()).toEqual(before);
    pointer(handle(1), 'pointerdown', 600, 16, 8); pointer(handle(1), 'pointermove', 400, 145, 8);
    fireEvent.keyDown(window, { key: 'Escape' }); pointer(handle(1), 'pointerup', 400, 145, 8);
    expect(getCenterSplitState()).toEqual(before);
    act(() => centerSplitClose());
    pointer(handle(0), 'pointerdown', 400, 16, 9); pointer(handle(0), 'pointermove', 400, 145, 9);
    expect(main().dataset.edgeAction).toBeUndefined(); pointer(handle(0), 'pointerup', 400, 145, 9);
    expect(currentApiMock().mockOf('sessions.deselect')).not.toHaveBeenCalled();
  });
  it('拖起先提示、接近展开、继续上移全屏；初始就在提示区不会立刻展开', async () => {
    await mount();
    pointer(handle(0), 'pointerdown', 400, 16); pointer(handle(0), 'pointermove', 420, 16);
    const picker = screen.getByTestId('center-snap-peek');
    expect(screen.queryByTestId('center-snap-bar')).toBeNull();
    pointer(handle(0), 'pointermove', 400, 120);
    pointer(handle(0), 'pointermove', 400, 18);
    expect(screen.getByTestId('center-snap-bar')).toBe(picker);
    pointer(handle(0), 'pointermove', 400, 4);
    expect(main().dataset.edgeAction).toBe('fullscreen');
    expect(picker.dataset.mpStage).toBe('out');
    expect(screen.getByText('松开后全屏显示')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
  });
  it('窄屏不接受pane拖动，不生成iframe保护层或候选', async () => {
    await mount(); await splitWith(); resize(400);
    pointer(handle(1), 'pointerdown', 200, 16);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    expect(screen.queryByTestId('center-drag-scrim')).toBeNull();
  });
  it('阈值前无视觉遮罩；拖起真实内容不重挂、中央取消后立即满原槽', async () => {
    await mount(); await splitWith();
    const original = content('a'); const draft = input('a'); fireEvent.change(draft, { target: { value: '保留真实草稿' } });
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 204, 16);
    expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
    expect(screen.queryByTestId('center-drag-scrim')).toBeNull();
    pointer(handle(0), 'pointermove', 400, 120);
    expect(screen.queryByTestId('center-snap-preview')).toBeNull(); expect(content('a').style.transform).toContain('scale(0.78)');
    expectFull(content('b')); expect(content('a')).toBe(original); expect(input('a')).toBe(draft);
    pointer(handle(0), 'pointerup', 400, 120);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    expect(content('a').style.transform).toBe(''); expect(Number.parseFloat(content('a').style.width)).toBe(400);
    expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'b' }); expect(draft.value).toBe('保留真实草稿');
  });
  it('顶部只开布局条，小格产生单落点磨砂；真实源始终浮起，Esc恢复原布局', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(0.65));
    pointer(handle(1), 'pointerdown', 660, 16); pointer(handle(1), 'pointermove', 400, 120);
    pointer(handle(1), 'pointermove', 400, 18);
    expect(screen.getByTestId('center-snap-bar')).toBeTruthy();
    expect(main().dataset.previewSide).toBeUndefined(); expect(main().dataset.snapTarget).toBeUndefined();
    expect(screen.queryByTestId('center-snap-preview')).toBeNull();
    pointer(handle(1), 'pointermove', ...cellPoint('focus', 2));
    expect(main().dataset.snapTarget).toBe('focus:2');
    expect(content('b').style.transform).toContain('scale(0.32)'); expectFull(content('a'));
    expect(dimensions(screen.getByTestId('center-snap-preview'))).toEqual({ left: 400, top: 300, width: 400, height: 300 });
    expect(getCenterSplitState().dir).toBe('row'); expect(getCenterSplitState().ratio).toBe(0.65);
    fireEvent.keyDown(handle(1), { key: 'Escape' });
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    expect(screen.getByTestId('center-snap-bar').dataset.mpStage).toBe('out');
    expect(cell('focus', 2).getAttribute('aria-pressed')).toBe('true'); // Frozen until the bar finishes exiting.
    expect(main().dataset.snapTarget).toBeUndefined();
    expect(main().dataset.previewSide).toBeUndefined(); expect(Number.parseFloat(content('a').style.width)).toBe(520);
    expect(Number.parseFloat(content('b').style.width)).toBe(280); expect(getCenterSplitState().dir).toBe('row');
    await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('center-snap-bar')).toBeNull());
  });
  it.each(['Enter', ' '] as const)('拖动后%s的键盘click(detail0)立即打开菜单，不误吞首次键盘激活', async key => {
    await mount(); await splitWith();
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 400, 120);
    pointer(handle(0), 'pointerup', 400, 120);
    fireEvent.keyDown(handle(0), { key });
    // jsdom doesn't generate the browser's default click on Enter/Space. Its
    // detail=0 activation is emitted explicitly after the genuine key event.
    fireEvent.click(handle(0), { detail: 0 });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'b' });
  });
  it('6px之前Esc取消也抑制随后mouseup的指针click，不误弹菜单', async () => {
    await mount(); await splitWith();
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 204, 16);
    fireEvent.keyDown(handle(0), { key: 'Escape' });
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    pointer(handle(0), 'pointerup', 204, 16); fireEvent.click(handle(0), { detail: 1 });
    expect(screen.queryByRole('menu')).toBeNull(); expect(screen.queryByTestId('center-drag-scrim')).toBeNull();
    expect(handle(0).releasePointerCapture).toHaveBeenCalledWith(7);
    fireEvent.click(handle(0), { detail: 0 }); expect(screen.getByRole('menu')).toBeTruthy();
  });
  it.each(['pointercancel', 'lostpointercapture', 'blur', 'outside-up', 'buttons0', 'primary-ref', 'secondary-ref', 'close', 'narrow'] as const)(
    '%s终止pane捕获时立即移除保护层，迟到的事件不提交布局', async reason => {
      await mount(); await splitWith(); act(() => centerSplitSetRatio(0.65));
      const source = handle(0);
      pointer(source, 'pointerdown', 260, 16); pointer(source, 'pointermove', 400, 200);
      expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
      if (reason === 'blur') fireEvent(window, new Event('blur'));
      else if (reason === 'outside-up') pointer(document.body, 'pointerup', 900, 300);
      else if (reason === 'buttons0') pointer(document.body, 'pointermove', 900, 300, 7, 0);
      else if (reason === 'primary-ref') act(() => { selectPrimary({ kind: 'session', sessionId: 'c' }); centerSplitReconcilePrimary(); });
      else if (reason === 'secondary-ref') act(() => centerSplitSelectInPane(1, { kind: 'session', sessionId: 'c' }));
      else if (reason === 'close') act(() => centerSplitClose());
      else if (reason === 'narrow') resize(400);
      else pointer(source, reason, 400, 200);
      expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
      expect(source.releasePointerCapture).toHaveBeenCalledWith(7);
      expect(main().dataset.previewSide).toBeUndefined();
      const afterCancel = getCenterSplitState();
      pointer(source, 'pointermove', 792, 300); pointer(source, 'pointerup', 792, 300);
      expect(getCenterSplitState()).toEqual(afterCancel);
      await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
    });
  it('window观察到已松开buttons0时取消提起，真实内容和比例立即恢复', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(0.65));
    const original = { a: rect('a'), b: rect('b') };
    pointer(handle(0), 'pointerdown', 260, 16); pointer(handle(0), 'pointermove', 400, 120);
    expect(content('a').style.transform).toContain('scale(0.78)');
    pointer(document.body, 'pointermove', 900, 300, 7, 0);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
    expect(getCenterSplitState().ratio).toBe(0.65);
    pointer(handle(0), 'pointerup', 792, 300); fireEvent.click(handle(0), { detail: 1 });
    expect(getCenterSplitState().ratio).toBe(0.65); expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
  });
  it('取消后旧scrim仍out时新pointer可重拖，二次取消正常退出且未提交候选', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(0.65));
    const original = { a: rect('a'), b: rect('b') };
    pointer(handle(1), 'pointerdown', 660, 16); pointer(handle(1), 'pointermove', 792, 300);
    await waitFor(() => expect(screen.getByTestId('center-drag-scrim').dataset.mpStage).toBe('in'));
    pointer(handle(1), 'pointercancel', 792, 300);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    expect(screen.getByTestId('center-drag-scrim').dataset.mpStage).toBe('out');
    expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
    pointer(handle(1), 'pointerdown', 660, 16, 8); pointer(handle(1), 'pointermove', 8, 300, 8);
    expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
    expect(main().dataset.previewSide).toBe('left'); expect(content('b').style.transform).toContain('scale(0.78)');
    expectFull(content('a')); expect(dimensions(screen.getByTestId('center-snap-preview'))).toEqual({ left: 0, top: 0, width: 400, height: 600 });
    await waitFor(() => expect(screen.getByTestId('center-drag-scrim').dataset.mpStage).toBe('in'));
    fireEvent.keyDown(handle(1), { key: 'Escape' }); pointer(handle(1), 'pointerup', 8, 300, 8);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    fireEvent.click(handle(1), { detail: 1 });
    expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
    expect(getCenterSplitState().dir).toBe('row'); expect(getCenterSplitState().ratio).toBe(0.65);
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
  });
  it('source1从col/.65拖向right，源持续浮起且保留A，提交后源矩形等于落点', async () => {
    prefs = { dir: 'col', ratio: 0.65 };
    await mount(); await splitWith({ kind: 'session', sessionId: 'b' }, 'bottom');
    const a = content('a'), b = content('b'), draft = input('b');
    fireEvent.change(draft, { target: { value: '乙从非等比上下布局拖动' } });
    expect(Number.parseFloat(b.style.height)).toBe(210);
    pointer(handle(1), 'pointerdown', 400, 406);
    pointer(handle(1), 'pointermove', 400, 120);
    pointer(handle(1), 'pointermove', 792, 300);
    expect(main().dataset.previewSide).toBe('right');
    const target = dimensions(screen.getByTestId('center-snap-preview'));
    expect(content('b').style.transform).toContain('scale(0.78)'); expectFull(content('a'));
    expect(getCenterSplitState().dir).toBe('col'); expect(getCenterSplitState().ratio).toBe(0.65);
    pointer(handle(1), 'pointerup', 792, 300); fireEvent.click(handle(1), { detail: 1 });
    expect(getCenterSplitState().dir).toBe('row'); expect(getCenterSplitState().ratio).toBe(0.5);
    expect(dimensions(content('b'))).toEqual(target); expect(dimensions(content('a'))).toEqual({ left: 0, top: 0, width: 400, height: 600 });
    expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
    expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'b' });
    expect(content('a')).toBe(a); expect(content('b')).toBe(b); expect(input('b')).toBe(draft);
    expect(draft.value).toBe('乙从非等比上下布局拖动'); expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
  });
  it('顶部条仅在实际小格命中时预览，保留带内不收起，离开后清候选并恢复.78', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetFocused(0)); const before = getCenterSplitState();
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 400, 120); pointer(handle(0), 'pointermove', 400, 18);
    pointer(handle(0), 'pointermove', ...cellPoint('focus', 2));
    expect(main().dataset.snapTarget).toBe('focus:2'); expect(content('a').style.transform).toContain('scale(0.32)');
    pointer(handle(0), 'pointermove', 446, 45); // Actual gap between focus cells.
    expect(main().dataset.snapTarget).toBeUndefined(); expect(screen.getByTestId('center-snap-bar')).toBeTruthy();
    pointer(handle(0), 'pointermove', 300, 93); // Mock top10+height64+18 retention ends at92.
    expect(main().dataset.snapTarget).toBeUndefined(); expect(content('a').style.transform).toContain('scale(0.78)');
    expect(getCenterSplitState()).toEqual(before); pointer(handle(0), 'pointerup', 400, 120);
    expect(getCenterSplitState()).toEqual(before);
    await waitFor(() => expect(screen.queryByTestId('center-snap-bar')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
  });
  it('mouseup按新坐标重算而非提交上个hover小格，内部大落点不是可选格', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetFocused(0)); const before = getCenterSplitState();
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 400, 120); pointer(handle(0), 'pointermove', 400, 18);
    pointer(handle(0), 'pointermove', ...cellPoint('focus', 2));
    pointer(handle(0), 'pointerup', 400, 120); // Away from picker and all thumbnail-contact edges.
    expect(getCenterSplitState()).toEqual(before); expect(content('a').style.transform).toBe('');
    pointer(handle(0), 'pointerdown', 200, 16, 8); pointer(handle(0), 'pointermove', 400, 120, 8); pointer(handle(0), 'pointermove', 400, 18, 8);
    pointer(handle(0), 'pointermove', ...cellPoint('focus', 2), 8);
    pointer(handle(0), 'pointerup', ...cellPoint('thirds', 0), 8);
    expect(getCenterSplitState().layoutId).toBe('thirds'); expect(getCenterSplitState().order?.[0]).toBe(0);
    expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
    expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'b' });
  });
  it('A+B改三格保留B，仅新增一个可填空位且不再重复填已占会话', async () => {
    await mount(); await splitWith(); const a = content('a'), b = content('b');
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 400, 120); pointer(handle(0), 'pointermove', 400, 18);
    pointer(handle(0), 'pointermove', ...cellPoint('focus', 0)); pointer(handle(0), 'pointerup', ...cellPoint('focus', 0));
    expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual([
      { kind: 'session', sessionId: 'a' }, { kind: 'session', sessionId: 'b' }, { kind: 'empty' }
    ]);
    expect(content('a')).toBe(a); expect(content('b')).toBe(b);
    expect(screen.queryByTestId('center-snap-fill-2-a')).toBeNull(); expect(screen.queryByTestId('center-snap-fill-2-b')).toBeNull();
    expect(screen.getByTestId('center-snap-fill-2-c')).toBeTruthy();
    act(() => { centerSplitSetFocused(2); centerSplitTryFill({ kind: 'session', sessionId: 'b' }); });
    expect(getCenterSplitState().tertiary).toEqual({ kind: 'empty' }); expect(getCenterSplitState().focused).toBe(1);
    fireEvent.click(screen.getByTestId('center-snap-fill-2-c'));
    expect(getCenterSplitState().tertiary).toEqual({ kind: 'session', sessionId: 'c' });
    expect(handle(2).getAttribute('aria-label')).toBe('会话丙：分屏操作');
  });
  it.each([0, 1, 2] as const)('三内容source%s只能选足够容量的布局，保留其他真DOM/草稿并提交对应大落点', async slot => {
    await mount(); await threePanes();
    const nodes = ['a', 'b', 'c'].map(content), drafts = ['a', 'b', 'c'].map(input);
    drafts.forEach((draft, index) => fireEvent.change(draft, { target: { value: `草稿${index}` } }));
    act(() => centerSplitSetFocused(slot)); const originalState = getCenterSplitState(); const source = handle(slot);
    pointer(source, 'pointerdown', 400, 16); pointer(source, 'pointermove', 400, 120); pointer(source, 'pointermove', 400, 18);
    // 'wide' 已从选择条移除（模型保留供旧工作区），两格预设剩 halves/stack
    for (const layout of ['halves', 'stack'] as const) {
      expect((cell(layout, 0) as HTMLButtonElement).disabled).toBe(true); expect((cell(layout, 1) as HTMLButtonElement).disabled).toBe(true);
    }
    pointer(source, 'pointermove', ...cellPoint('halves', 0));
    expect(main().dataset.snapTarget).toBeUndefined(); expect(getCenterSplitState()).toEqual(originalState);
    pointer(source, 'pointermove', ...cellPoint('thirds', 2));
    expect(main().dataset.snapTarget).toBe('thirds:2');
    expect(content(['a', 'b', 'c'][slot]).style.transform).toContain('scale(0.32)');
    const target = dimensions(screen.getByTestId('center-snap-preview'));
    expect(target.left).toBeCloseTo(800 * 2 / 3); expect(target.top).toBe(0);
    expect(target.width).toBeCloseTo(800 / 3); expect(target.height).toBe(600);
    expect(getCenterSplitState()).toEqual(originalState);
    pointer(source, 'pointerup', ...cellPoint('thirds', 2));
    expect(getCenterSplitState().layoutId).toBe('thirds'); expect(getCenterSplitState().order?.[slot]).toBe(2);
    expect(getCenterSplitState().focused).toBe(slot);
    expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual(['a', 'b', 'c'].map(sessionId => ({ kind: 'session', sessionId })));
    expect(dimensions(content(['a', 'b', 'c'][slot]))).toEqual(target);
    ['a', 'b', 'c'].forEach((id, index) => { expect(content(id)).toBe(nodes[index]); expect(input(id)).toBe(drafts[index]); expect(drafts[index].value).toBe(`草稿${index}`); });
  });
  it('主辅三格提起主侧后其余两内容上下填满，候选小格不提前改变背景矩形', async () => {
    await mount(); await threePanes(); act(() => centerSplitSetFocused(0)); const before = getCenterSplitState();
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 400, 120);
    const background = { b: dimensions(content('b')), c: dimensions(content('c')) };
    expect(background).toEqual({ b: { left: 0, top: 0, width: 800, height: 300 }, c: { left: 0, top: 300, width: 800, height: 300 } });
    pointer(handle(0), 'pointermove', 400, 18); pointer(handle(0), 'pointermove', ...cellPoint('thirds', 1));
    expect(dimensions(content('b'))).toEqual(background.b); expect(dimensions(content('c'))).toEqual(background.c);
    expect(getCenterSplitState()).toEqual(before); fireEvent.keyDown(handle(0), { key: 'Escape' });
    expect(content('a').style.transform).toBe(''); expect(getCenterSplitState()).toEqual(before);
    expect(dimensions(content('b'))).toEqual({ left: 400, top: 0, width: 400, height: 300 });
    expect(dimensions(content('c'))).toEqual({ left: 400, top: 300, width: 400, height: 300 });
  });
  it('focus order=[0,2,1]提起主侧按原物理位置铺背景，C仍上/B仍下，取消恢复原格', async () => {
    await mount(); await threePanes();
    act(() => {
      const candidate = deriveCenterSplitSnapLayout(primary, getCenterSplitState(), 1, { layoutId: 'focus', index: 2 });
      expect(candidate).not.toBeNull(); expect(centerSplitCommitSnapLayout(candidate!)).toBe(true); centerSplitSetFocused(0);
    });
    expect(getCenterSplitState().order).toEqual([0, 2, 1]);
    const before = { b: dimensions(content('b')), c: dimensions(content('c')) };
    const b = content('b'), c = content('c');
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 400, 120);
    expect(dimensions(content('c'))).toEqual({ left: 0, top: 0, width: 800, height: 300 });
    expect(dimensions(content('b'))).toEqual({ left: 0, top: 300, width: 800, height: 300 });
    pointer(handle(0), 'pointermove', 400, 18); pointer(handle(0), 'pointermove', ...cellPoint('thirds', 2));
    expect(dimensions(content('c'))).toEqual({ left: 0, top: 0, width: 800, height: 300 });
    expect(dimensions(content('b'))).toEqual({ left: 0, top: 300, width: 800, height: 300 });
    fireEvent.keyDown(handle(0), { key: 'Escape' });
    expect(dimensions(content('b'))).toEqual(before.b); expect(dimensions(content('c'))).toEqual(before.c);
    expect(content('b')).toBe(b); expect(content('c')).toBe(c); expect(getCenterSplitState().order).toEqual([0, 2, 1]);
  });
  it('单window工具提起只改变该工具，后台session不获得源尺寸/transform且输入DOM保持', async () => {
    const workspace = { id: 'single-window-snap', name: '单窗口夹具', path: 'E:/single-window-snap' };
    rows = rows.map(row => ({ ...row, workspaceId: workspace.id }));
    currentApiMock().override('workspaces.list', () => Promise.resolve({ workspaces: [workspace], activeWorkspaceId: workspace.id }));
    // StoreProvider also reads config.get during boot. Both IPC acknowledgments
    // must name this workspace, or the default config resets it back to null.
    currentApiMock().override('config.get', () => Promise.resolve({ locale: 'zh-CN', workspaces: [workspace], activeWorkspaceId: workspace.id }));
    currentApiMock().override('workbench.navigation', () => Promise.resolve({ workspaceId: workspace.id, sourceRootId: 'root', selectionRevision: 0, revision: 1, libraryExpanded: false,
      nodes: [{ id: 'child', kind: 'extension', title: '窗口工具', extensionId: 'fixture', viewId: 'pane', parentId: null, placement: 'window' }] }));
    await mount('nav:child');
    await waitFor(() => expect(screen.getByTestId('center-pane-0').dataset.placement).toBe('center'));
    const backing = content('a'), draft = input('a'); fireEvent.change(draft, { target: { value: '后台PTY不被工具缩放' } });
    expect(backing.dataset.visible).toBe('true'); // CSS covers this backing session; its DOM and geometry stay intact.
    const before = backing.getAttribute('style');
    expect(backing.style.width).toBe(''); expect(backing.style.height).toBe(''); expect(backing.style.transform).toBe('');
    pointer(handle(0), 'pointerdown', 200, 16); pointer(handle(0), 'pointermove', 400, 120);
    const tool = screen.getByTestId('nav-child').closest<HTMLElement>('.center-utility-layer')!;
    expect(tool.style.transform).toContain('scale(0.78)');
    expect(content('a')).toBe(backing); expect(input('a')).toBe(draft); expect(backing.getAttribute('style')).toBe(before);
    fireEvent.keyDown(handle(0), { key: 'Escape' });
    expect(backing.getAttribute('style')).toBe(before); expect(draft.value).toBe('后台PTY不被工具缩放');
    expect(screen.getByTestId('center-pane-0').dataset.placement).toBe('center');
  });
  it('third-slot正文focus、窄屏切换和逐侧收起仍保持全部内容实例', async () => {
    await mount(); await threePanes('thirds'); const nodes = ['a', 'b', 'c'].map(content);
    fireEvent.focus(input('c')); expect(getCenterSplitState().focused).toBe(2);
    resize(320); expectFull(content('c')); expect(content('a').dataset.visible).toBe('false'); expect(content('b').dataset.visible).toBe('false');
    fireEvent.click(screen.getByTestId('center-pane-switch-1')); expectFull(content('b'));
    resize(800); await menuAction(2, '收起此侧');
    expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual([{ kind: 'session', sessionId: 'a' }, { kind: 'session', sessionId: 'b' }]);
    await menuAction(1, '收起此侧'); expectFull(content('a')); expect(getCenterSplitState().open).toBe(false);
    ['a', 'b', 'c'].forEach((id, index) => expect(content(id)).toBe(nodes[index]));
  });
  it('第三槽文件夹回调与可见iframe中继归属第三槽，关闭该工具保留原A/B', async () => {
    await mount(); await threePanes();
    act(() => centerSplitSelectInPane(2, { kind: 'utility', sel: 'nav:folder' }));
    const folder = screen.getByTestId('nav-folder'); expect(folder.dataset.centerOnly).toBe('true');
    fireEvent.click(folder.querySelector('button')!);
    expect(getCenterSplitState().tertiary).toEqual({ kind: 'utility', sel: 'nav:child' });
    const guest = screen.getByTestId('guest-child') as HTMLIFrameElement;
    act(() => centerSplitSetFocused(0));
    fireEvent(window, new MessageEvent('message', { source: guest.contentWindow, data: { __ma: true, type: 'panelFocus' } }));
    expect(getCenterSplitState().focused).toBe(2);
    resize(320); await waitFor(() => expect(screen.getByTestId('nav-child').closest<HTMLElement>('.center-utility-layer')!.dataset.mpStage).toBe('in'));
    expectFull(screen.getByTestId('nav-child').closest<HTMLElement>('.center-utility-layer')!);
    fireEvent.click(screen.getByTestId('center-pane-switch-0'));
    fireEvent(window, new MessageEvent('message', { source: guest.contentWindow, data: { __ma: true, type: 'panelFocus' } }));
    expect(getCenterSplitState().focused).toBe(0); resize(800);
    fireEvent.click(screen.getByRole('button', { name: '导航内部关闭' }));
    expect(getCenterSplitPaneRefs(primary, getCenterSplitState())).toEqual([{ kind: 'session', sessionId: 'a' }, { kind: 'session', sessionId: 'b' }]);
  });
  it('菜单布局选择器支持键盘焦点与退出，thumbnail展示实际保留refs', async () => {
    await mount(); await threePanes(); const before = getCenterSplitState();
    await menuAction(2, '选择分屏布局');
    expect(document.activeElement).toBe(cell('focus', 0));
    const refs = [0, 1, 2].map(index => cell('thirds', index).dataset.snapRefId);
    expect([...refs].sort()).toEqual(['a', 'b', 'c']);
    fireEvent.keyDown(cell('focus', 0), { key: 'End' }); expect(document.activeElement).toBe(cell('thirds', 2));
    expect(main().dataset.snapTarget).toBe('thirds:2');
    fireEvent.blur(cell('thirds', 2), { relatedTarget: handle(2) });
    expect(main().dataset.snapTarget).toBeUndefined(); expect(getCenterSplitState()).toEqual(before);
    act(() => cell('thirds', 2).focus()); fireEvent.pointerLeave(screen.getByTestId('center-snap-bar'));
    expect(main().dataset.snapTarget).toBeUndefined();
    fireEvent.keyDown(cell('thirds', 2), { key: 'Escape' }); expect(document.activeElement).toBe(handle(2));
    expect(getCenterSplitState()).toEqual(before);
    await waitFor(() => expect(screen.queryByTestId('center-snap-bar')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
  });
  it('空槽菜单禁用布局选择入口，点击不能挂载无可选格的布局条', async () => {
    await mount(); act(() => centerSplitToggleShortcut());
    expect(getCenterSplitState().secondary).toEqual({ kind: 'empty' });
    fireEvent.click(handle(1), { detail: 0 });
    const item = screen.getByRole('menuitemcheckbox', { name: '选择分屏布局' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item);
    expect(screen.queryByTestId('center-snap-bar')).toBeNull();
    expect(screen.queryByTestId('center-snap-preview')).toBeNull();
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    expect(getCenterSplitState().secondary).toEqual({ kind: 'empty' });
  });
  it('picker打开后焦点移入正文，window Escape仍退出并返回原source handle', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(.65));
    const before = getCenterSplitState(); const a = content('a'), b = content('b'), draft = input('a');
    fireEvent.change(draft, { target: { value: '正文焦点保持草稿' } });
    await menuAction(1, '选择分屏布局');
    const bar = screen.getByTestId('center-snap-bar');
    await waitFor(() => expect(bar.dataset.mpStage).toBe('in'));
    expect(document.activeElement).toBe(cell('halves', 0));
    act(() => draft.focus()); expect(document.activeElement).toBe(draft); expect(getCenterSplitState().focused).toBe(0);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(window, escape);
    expect(escape.defaultPrevented).toBe(true); expect(document.activeElement).toBe(handle(1));
    expect(bar.dataset.mpStage).toBe('out'); expect(main().dataset.snapTarget).toBeUndefined();
    expect(getCenterSplitState()).toEqual(before); expect(content('a')).toBe(a); expect(content('b')).toBe(b); expect(input('a')).toBe(draft);
    expect(draft.value).toBe('正文焦点保持草稿');
    await waitFor(() => expect(screen.queryByTestId('center-snap-bar')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
  });
  it('异步主侧选择确认之前保留候选两侧几何，确认后原DOM直接成为已提交布局', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(0.65));
    let acknowledge: (() => void) | undefined;
    let requested: SplitPaneRef | undefined;
    act(() => attachCenterSplitBridge({
      getPrimary: () => primary, getPrefs: () => prefs, savePrefs: next => saved.push(next),
      selectRef: ref => new Promise<void>(resolve => {
        requested = ref;
        acknowledge = () => { selectPrimary(ref); centerSplitReconcilePrimary(); resolve(); };
      })
    }));
    const a = content('a'), b = content('b');
    fireEvent.change(input('a'), { target: { value: '等待IPC也保留甲' } });
    fireEvent.change(input('b'), { target: { value: '等待IPC也保留乙' } });
    // Legacy explicit side exchange still changes the primary asynchronously;
    // Snap itself preserves logical bindings and must not request that exchange.
    act(() => centerSplitDockPane(1, 'left'));
    const preview = { a: rect('a'), b: rect('b') };
    expect(requested).toEqual({ kind: 'session', sessionId: 'b' });
    expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
    expect(getCenterSplitState().ratio).toBe(0.65);
    expect(getCenterSplitState().pendingLayout?.pane0).toEqual({ kind: 'session', sessionId: 'b' });
    expect(rect('a')).toEqual(preview.a); expect(rect('b')).toEqual(preview.b);
    // Presence can finish before the asynchronous selection is acknowledged.
    await waitFor(() => expect(screen.queryByTestId('center-drag-scrim')).toBeNull());
    expect(rect('a')).toEqual(preview.a); expect(rect('b')).toEqual(preview.b);
    resize(400);
    expectFull(content('b')); expect(content('b').dataset.visible).toBe('true');
    expect(content('a').dataset.visible).toBe('false');
    expect(getCenterSplitState().pendingLayout?.pane0).toEqual({ kind: 'session', sessionId: 'b' });
    resize(800);
    expect(rect('a')).toEqual(preview.a); expect(rect('b')).toEqual(preview.b);
    await act(async () => { acknowledge!(); await Promise.resolve(); });
    expect(getCenterSplitState().pendingLayout).toBeNull(); expect(getCenterSplitState().ratio).toBe(0.5);
    expect(primary).toEqual({ kind: 'session', sessionId: 'b' });
    expect(getCenterSplitState().secondary).toEqual({ kind: 'session', sessionId: 'a' });
    expect(rect('a')).toEqual(preview.a); expect(rect('b')).toEqual(preview.b);
    expect(content('a')).toBe(a); expect(content('b')).toBe(b);
    expect(input('a').value).toBe('等待IPC也保留甲'); expect(input('b').value).toBe('等待IPC也保留乙');
  });
  it.each(['ack', 'reject'] as const)('关闭主槽等待%s时锁定divider与pane捕获，保留确认前几何，事务结束后解锁', async outcome => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(.65));
    const a = content('a'), b = content('b'), original = { a: rect('a'), b: rect('b') };
    fireEvent.change(input('a'), { target: { value: '关闭待确认甲' } }); fireEvent.change(input('b'), { target: { value: '关闭待确认乙' } });
    let acknowledge: (() => void) | undefined, reject: (() => void) | undefined;
    act(() => attachCenterSplitBridge({ getPrimary: () => primary, getPrefs: () => prefs, savePrefs: next => saved.push(next),
      selectRef: ref => new Promise<void>((resolve, fail) => {
        acknowledge = () => { selectPrimary(ref); centerSplitReconcilePrimary(); resolve(); };
        reject = () => fail(new Error('Fixture denied the held primary selection'));
      })
    }));
    expect(screen.getByRole('separator', { name: '调整分屏比例' })).toBeTruthy();
    pointer(handle(1), 'pointerdown', 660, 16); pointer(handle(1), 'pointermove', 400, 120);
    expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
    expect(screen.getByTestId('center-pane-1').dataset.floating).toBe('true');
    expect(handle(1).setPointerCapture).toHaveBeenCalledTimes(1);
    // A close requested elsewhere in the app must terminate the active handle
    // gesture too; the pending marker alone doesn't change its geometryKey.
    act(() => centerSplitClosePane(0));
    expect(getCenterSplitState().open).toBe(true); expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
    expect(getCenterSplitState().pendingLayout?.panes).toEqual([{ kind: 'session', sessionId: 'b' }]);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull();
    expect(screen.getByTestId('center-pane-1').dataset.floating).toBeUndefined(); expect(content('b').style.transform).toBe('');
    expect(handle(1).releasePointerCapture).toHaveBeenCalledWith(7);
    pointer(handle(1), 'pointerup', 792, 300);
    expect(getCenterSplitState().pendingLayout?.panes).toEqual([{ kind: 'session', sessionId: 'b' }]);
    expect(screen.queryByRole('separator', { name: '调整分屏比例' })).toBeNull();
    expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
    pointer(handle(1), 'pointerdown', 660, 16); pointer(handle(1), 'pointermove', 792, 300); pointer(handle(1), 'pointerup', 792, 300);
    expect(screen.queryByTestId('center-pane-capture-shield')).toBeNull(); expect(main().dataset.snapTarget).toBeUndefined();
    expect(handle(1).setPointerCapture).toHaveBeenCalledTimes(1); // Locked pointerdown cannot acquire a new capture.
    expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
    fireEvent.click(handle(1), { detail: 0 });
    const layoutItem = screen.getByRole('menuitemcheckbox', { name: '选择分屏布局' });
    expect(layoutItem.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(layoutItem);
    expect(screen.queryByTestId('center-snap-bar')).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await act(async () => { if (outcome === 'ack') acknowledge!(); else reject!(); await Promise.resolve(); });
    expect(getCenterSplitState().pendingLayout).toBeNull();
    if (outcome === 'ack') {
      expect(getCenterSplitState().open).toBe(false); expect(primary).toEqual({ kind: 'session', sessionId: 'b' });
      expectFull(content('b')); expect(handle(0).getAttribute('aria-label')).toBe('会话乙：分屏操作');
      pointer(handle(0), 'pointerdown', 400, 16); expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
      pointer(handle(0), 'pointercancel', 400, 16);
    } else {
      expect(getCenterSplitState().open).toBe(true); expect(primary).toEqual({ kind: 'session', sessionId: 'a' });
      expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
      expect(screen.getByRole('separator', { name: '调整分屏比例' })).toBeTruthy();
      pointer(handle(1), 'pointerdown', 660, 16); expect(screen.getByTestId('center-pane-capture-shield')).toBeTruthy();
      pointer(handle(1), 'pointercancel', 660, 16);
    }
    expect(content('a')).toBe(a); expect(content('b')).toBe(b);
    expect(input('a').value).toBe('关闭待确认甲'); expect(input('b').value).toBe('关闭待确认乙');
  });
  it('原主槽empty/source B的Snap选主待确认期间空槽映射互补格，不与B重叠', async () => {
    await mount(); await splitWith();
    act(() => {
      primary = { kind: 'empty' }; currentApiMock().emit('sessions:changed', { sessions: rows, activeId: null });
      centerSplitReconcilePrimary(primary);
    });
    expect(handle(0).getAttribute('aria-label')).toBe('选择内容：分屏操作');
    expect(content('a').dataset.visible).toBe('false');
    const b = content('b'), draft = input('b'); fireEvent.change(draft, { target: { value: '空主槽晋升B的草稿' } });
    let acknowledge: (() => void) | undefined;
    act(() => attachCenterSplitBridge({ getPrimary: () => primary, getPrefs: () => prefs, savePrefs: next => saved.push(next),
      selectRef: ref => new Promise<void>(resolve => { acknowledge = () => { selectPrimary(ref); centerSplitReconcilePrimary(); resolve(); }; })
    }));
    pointer(handle(1), 'pointerdown', 600, 16); pointer(handle(1), 'pointermove', 792, 300);
    const target = dimensions(screen.getByTestId('center-snap-preview'));
    pointer(handle(1), 'pointerup', 792, 300);
    expect(primary).toEqual({ kind: 'empty' }); expect(getCenterSplitState().pendingLayout?.panes).toEqual([
      { kind: 'session', sessionId: 'b' }, { kind: 'empty' }
    ]);
    expect(dimensions(content('b'))).toEqual(target);
    expect(dimensions(screen.getByTestId('center-pane-0'))).toEqual({ left: 0, top: 0, width: 400, height: 600 });
    expect(content('b').style.transform).toBe(''); expect(screen.queryByRole('separator', { name: '调整分屏比例' })).toBeNull();
    await act(async () => { acknowledge!(); await Promise.resolve(); });
    expect(primary).toEqual({ kind: 'session', sessionId: 'b' }); expect(getCenterSplitState().secondary).toEqual({ kind: 'empty' });
    expect(getCenterSplitState().order).toEqual([1, 0]); expect(getCenterSplitState().pendingLayout).toBeNull();
    expect(dimensions(content('b'))).toEqual(target);
    expect(dimensions(screen.getByTestId('center-pane-1'))).toEqual({ left: 0, top: 0, width: 400, height: 600 });
    expect(content('b')).toBe(b); expect(input('b')).toBe(draft); expect(draft.value).toBe('空主槽晋升B的草稿');
  });
  it.each(['Escape', 'pointercancel', 'lostpointercapture', 'blur'])('%s取消separator调整还原原始比例和内容矩形', async cancel => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(0.6));
    const divider = screen.getByRole('separator', { name: '调整分屏比例' });
    const original = { a: rect('a'), b: rect('b') };
    pointer(divider, 'pointerdown', 480, 300); pointer(divider, 'pointermove', 600, 300);
    expect(getCenterSplitState().ratio).toBe(0.75);
    if (cancel === 'Escape') fireEvent.keyDown(divider, { key: 'Escape' });
    else if (cancel === 'blur') fireEvent(window, new Event('blur'));
    else pointer(divider, cancel, 600, 300);
    expect(getCenterSplitState().ratio).toBe(0.6);
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(rect('a')).toEqual(original.a); expect(rect('b')).toEqual(original.b);
    pointer(divider, 'pointerup', 600, 300);
    expect(getCenterSplitState().ratio).toBe(0.6);
  });
  it('separator的window buttons0取消还原比例并释放capture，迟来的up无提交', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(0.6));
    const divider = screen.getByRole('separator', { name: '调整分屏比例' });
    pointer(divider, 'pointerdown', 480, 300); pointer(divider, 'pointermove', 600, 300);
    pointer(document.body, 'pointermove', 900, 300, 7, 0);
    expect(getCenterSplitState().ratio).toBe(0.6); expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    pointer(divider, 'pointerup', 600, 300); expect(getCenterSplitState().ratio).toBe(0.6);
  });
  it('separator调整中进入pending布局事务时释放旧capture，确认后的.5不被旧gesture覆写', async () => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(0.6));
    const oldDivider = screen.getByRole('separator', { name: '调整分屏比例' });
    pointer(oldDivider, 'pointerdown', 480, 300); pointer(oldDivider, 'pointermove', 600, 300);
    let acknowledge: (() => void) | undefined;
    act(() => attachCenterSplitBridge({ getPrimary: () => primary, getPrefs: () => prefs, savePrefs: next => saved.push(next),
      selectRef: ref => new Promise<void>(resolve => { acknowledge = () => { selectPrimary(ref); centerSplitReconcilePrimary(); resolve(); }; })
    }));
    act(() => centerSplitDockPane(1, 'left'));
    expect(getCenterSplitState().pendingLayout?.ratio).toBe(0.5);
    expect(getCenterSplitState().ratio).toBe(0.75); expect(oldDivider.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(screen.queryByRole('separator', { name: '调整分屏比例' })).toBeNull();
    await act(async () => { acknowledge!(); await Promise.resolve(); });
    expect(getCenterSplitState().pendingLayout).toBeNull(); expect(getCenterSplitState().ratio).toBe(0.5);
    pointer(oldDivider, 'pointermove', 720, 500); pointer(oldDivider, 'pointerup', 720, 500);
    fireEvent.keyDown(document.body, { key: 'Escape' }); expect(getCenterSplitState().ratio).toBe(0.5);
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整分屏比例' }), { key: 'ArrowRight' });
    expect(getCenterSplitState().ratio).toBe(0.52);
  });
  it.each(['direction', 'narrow', 'close', 'workspace'] as const)('%s失效时终止separator旧gesture，不覆盖新布局或新工作区比例', async change => {
    await mount(); await splitWith(); act(() => centerSplitSetRatio(0.6));
    const divider = screen.getByRole('separator', { name: '调整分屏比例' });
    pointer(divider, 'pointerdown', 480, 300); pointer(divider, 'pointermove', 600, 300);
    expect(getCenterSplitState().ratio).toBe(0.75);
    if (change === 'direction') act(() => centerSplitFlip());
    else if (change === 'narrow') resize(400);
    else if (change === 'close') act(() => centerSplitClose());
    else act(() => {
      currentApiMock().emit('workspaces:changed', { workspaces: [{ id: 'next', name: '下一个', path: 'E:/next' }], activeWorkspaceId: 'next' });
      centerSplitSetRatio(0.35);
    });
    const expectedRatio = change === 'workspace' ? 0.35 : 0.75;
    expect(getCenterSplitState().ratio).toBe(expectedRatio);
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    pointer(divider, 'pointermove', 700, 550); pointer(divider, 'pointerup', 700, 550);
    expect(getCenterSplitState().ratio).toBe(expectedRatio);
    if (change === 'direction') expect(getCenterSplitState().dir).toBe('col');
    if (change === 'narrow') expectFull(content('b'));
    if (change === 'close') { expect(getCenterSplitState().open).toBe(false); expectFull(content('a')); }
  });
});

describe('固定到右侧', () => {
  const activate = () => act(() => { currentApiMock().emit('workspaces:changed', { workspaces: [{ id: 'ws', name: '当前', path: 'E:/test' }], activeWorkspaceId: 'ws' }); });
  const rightHost = (dockKey: string) => render(<div data-testid="right-host"><RightDockHost dockKey={dockKey} hostKey="t1" shown /></div>);
  let requests: RightPinRequest[];
  let stop: () => void;
  beforeEach(() => { requests = []; stop = onRightPinRequest(request => requests.push(request)); });
  afterEach(() => { stop(); act(() => publishRightPins('', [])); });

  it('三点把手菜单发出固定请求；固定后同一视图移到右侧，中栏原位显示去向与召回', async () => {
    rows = [{ ...session('a', 'gui'), workspaceId: 'ws' }, { ...session('b'), workspaceId: 'ws' }];
    await mount(); activate();
    await waitFor(() => expect(screen.getByTestId('center-pane-0').getAttribute('aria-hidden')).toBeNull());
    await menuAction(0, '固定到右侧');
    expect(requests).toEqual([{ workspaceId: 'ws', ref: { kind: 'session', sessionId: 'a' }, command: 'pin' }]);
    const chat = content('a');
    expect(chat.classList.contains('agent-chat-view')).toBe(true);
    const right = rightHost('session:a');
    act(() => publishRightPins('ws', ['session:a']));
    // GUI 会话同一 DOM（含草稿）移入右侧，显隐跟随右侧宿主
    expect(right.getByTestId('right-host').contains(chat)).toBe(true);
    expect(content('a')).toBe(chat);
    expect(chat.dataset.visible).toBe('true');
    expect(chat.getAttribute('style')).toBeNull();
    const placeholder = screen.getByTestId('center-docked-placeholder');
    expect(main().contains(placeholder)).toBe(true);
    expect(placeholder.textContent).toContain('此内容正在右侧面板中显示');
    fireEvent.click(within(placeholder).getByRole('button', { name: '在右侧查看' }));
    fireEvent.click(within(placeholder).getByRole('button', { name: '移回中栏' }));
    expect(requests.slice(1).map(request => request.command)).toEqual(['reveal', 'unpin']);
    await menuAction(0, '移回中栏');
    expect(requests.at(-1)).toEqual({ workspaceId: 'ws', ref: { kind: 'session', sessionId: 'a' }, command: 'unpin' });
    right.unmount();
    expect(main().contains(chat)).toBe(true);
    expect(screen.queryByTestId('center-docked-placeholder')).toBeNull();
  });

  it('内置工具固定后保留实例并移到右侧；面板自带关闭只取下右侧标签', async () => {
    await mount('tasks'); activate();
    const panel = screen.getByTestId('tasks-panel');
    const right = rightHost('utility:tasks');
    expect(right.getByTestId('right-host').contains(panel)).toBe(true);
    expect(screen.getByTestId('center-docked-placeholder')).toBeTruthy();
    // 中栏切回会话后工具层关闭，固定在右侧的实例不能被卸载
    act(() => selectPrimary({ kind: 'session', sessionId: 'a' }));
    await waitFor(() => expect(screen.queryByTestId('center-docked-placeholder')).toBeNull());
    expect(screen.getByTestId('tasks-panel')).toBe(panel);
    fireEvent.click(within(panel).getByRole('button', { name: '工具内部关闭' }));
    expect(requests).toEqual([{ workspaceId: 'ws', ref: { kind: 'utility', sel: 'tasks' }, command: 'unpin' }]);
    right.unmount();
  });

  it('设置的同一个宿主随固定移动，不销毁其已有内容', async () => {
    await mount('settings'); activate();
    const host = document.querySelector<HTMLElement>('.settings-center-host')!;
    expect(host).toBeTruthy();
    const field = document.createElement('input'); field.value = 'pending'; host.appendChild(field);
    const right = rightHost('utility:settings');
    expect(right.getByTestId('right-host').contains(host)).toBe(true);
    expect(host.querySelector('input')).toBe(field);
    expect(field.value).toBe('pending');
    right.unmount();
    expect(main().contains(host)).toBe(true);
    expect(host.querySelector('input')).toBe(field);
  });
});
