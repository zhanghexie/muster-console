import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useWorkspaceReorder, WORKSPACE_ORDER_KEY, WORKSPACE_SORT_HOLD_MS } from '../../src/renderer/src/hooks/useWorkspaceReorder';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import { MOTION } from '../../src/renderer/src/components/motion';
import * as motion from '../../src/renderer/src/components/motion';

const workspaces = ['a','b','c'].map((id, i) => ({ id, name: id.toUpperCase(), path: `E:/${id}`, openedAt: i }));
class TestPointerEvent extends MouseEvent {
  pointerId: number; isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true;
  }
}
beforeEach(() => { localStorage.removeItem(WORKSPACE_ORDER_KEY); vi.stubGlobal('PointerEvent', TestPointerEvent); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const select = vi.fn();
function Fixture({ disabled = false, items = workspaces } = {}) {
  const sort = useWorkspaceReorder(items, disabled, () => {});
  return <div data-testid="list" {...sort.props}>
    {sort.ordered.map(w => <button key={w.id} data-workspace-sort-id={w.id} data-sorting={sort.dragging === w.id || undefined} data-sort-pressing={sort.pressing === w.id || undefined} onClick={() => select(w.id)}>{w.id}</button>)}
    <output>{sort.position}</output>
    {sort.saveFailed && <span role="alert">save failed</span>}
  </div>;
}
function ids(root: HTMLElement) { return [...root.querySelectorAll<HTMLElement>('[data-workspace-sort-id]')].map(el => el.dataset.workspaceSortId); }
function geometry(root: HTMLElement) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.dataset.workspaceSortId || !root.contains(this)) return original.call(this);
      const index = ids(root).indexOf(this.dataset.workspaceSortId);
      return { top: index * 40, height: 40, left: 0, right: 200, width: 200, bottom: index * 40 + 40, x: 0, y: index * 40, toJSON: () => ({}) };
  });
}
function down(el: Element) { fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 20, clientY: 20 }); }
function move(y: number) { fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: y }); }
function up() { fireEvent.pointerUp(window, { pointerId: 1 }); act(() => vi.advanceTimersByTime(MOTION.panelMs)); }

it('长按拖动实时重排，松手保存，抑制误点击，重新挂载恢复', () => {
  select.mockClear(); vi.useFakeTimers();
  const view = render(<Fixture />); const root = screen.getByTestId('list'); geometry(root);
  down(screen.getByText('a'));
  act(() => vi.advanceTimersByTime(WORKSPACE_SORT_HOLD_MS)); move(110); up();
  expect(ids(root)).toEqual(['b','c','a']);
  fireEvent.click(screen.getByText('a')); expect(select).not.toHaveBeenCalled();
  down(screen.getByText('b')); fireEvent.pointerUp(window, { pointerId: 1 });
  fireEvent.click(screen.getByText('b')); expect(select).toHaveBeenCalledWith('b');
  expect(JSON.parse(localStorage.getItem(WORKSPACE_ORDER_KEY)!)).toEqual(['b','c','a']);
  view.unmount(); render(<Fixture />);
  expect(ids(screen.getByTestId('list'))).toEqual(['b','c','a']);
});

it('短按保留点击，长按前移动取消，Escape 与 pointercancel 回滚不写盘', () => {
  select.mockClear(); vi.useFakeTimers(); render(<Fixture />);
  const root = screen.getByTestId('list'); geometry(root);
  down(screen.getByText('a')); up(); fireEvent.click(screen.getByText('a'));
  expect(select).toHaveBeenCalledWith('a');
  down(screen.getByText('a')); move(50);
  act(() => vi.advanceTimersByTime(500)); move(110); up();
  expect(ids(root)).toEqual(['a','b','c']);
  for (const cancel of [() => fireEvent.keyDown(window, { key: 'Escape' }), () => fireEvent.pointerCancel(window, { pointerId: 1 })]) {
    down(screen.getByText('a')); act(() => vi.advanceTimersByTime(500)); move(110); cancel();
    act(() => vi.advanceTimersByTime(MOTION.panelMs));
    expect(ids(root)).toEqual(['a','b','c']);
    expect(localStorage.getItem(WORKSPACE_ORDER_KEY)).toBeNull();
  }
});

it('按住立即反馈；拖动保持原节点跟手、邻居让位、落点稳定，松手吸附后才更新 DOM', () => {
  vi.useFakeTimers(); render(<Fixture />);
  const root = screen.getByTestId('list'); geometry(root);
  const a = screen.getByText('a'), b = screen.getByText('b');
  down(a); expect(a.dataset.sortPressing).toBe('true');
  act(() => vi.advanceTimersByTime(WORKSPACE_SORT_HOLD_MS));
  expect(a.dataset.sortPressing).toBeUndefined(); expect(a.dataset.sorting).toBe('true');
  move(90); act(() => vi.advanceTimersByTime(20));
  expect(ids(root)).toEqual(['a','b','c']);
  expect(a.style.transform).toBe('translateY(70px)');
  expect(b.style.transform).toBe('translateY(-40px)');
  expect(root.style.getPropertyValue('--ws-drop-top')).toBe('80px');
  // Oscillation around an animated neighbour cannot change the fixed target slots.
  move(91); act(() => vi.advanceTimersByTime(20));
  expect(screen.getByRole('status').textContent).toBe('3');
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(root.dataset.sortSettling).toBe('true');
  expect(a.style.transform).toBe('translateY(80px)');
  expect(ids(root)).toEqual(['a','b','c']);
  act(() => vi.advanceTimersByTime(MOTION.panelMs));
  expect(ids(root)).toEqual(['b','c','a']);
  expect(a.style.transform).toBe('');
});

it('取消、失去指针捕获、卸载与工作区变化清理手势，其他指针不干扰', () => {
  vi.useFakeTimers(); const view = render(<Fixture />);
  const root = screen.getByTestId('list'); geometry(root);
  down(screen.getByText('a')); act(() => vi.advanceTimersByTime(500));
  fireEvent.pointerCancel(window, { pointerId: 2 });
  expect(screen.getByText('a').dataset.sorting).toBe('true');
  move(110); act(() => vi.advanceTimersByTime(20));
  fireEvent.lostPointerCapture(root, { pointerId: 1 });
  act(() => vi.advanceTimersByTime(MOTION.panelMs));
  expect(ids(root)).toEqual(['a','b','c']);
  expect(localStorage.getItem(WORKSPACE_ORDER_KEY)).toBeNull();
  down(screen.getByText('a')); act(() => vi.advanceTimersByTime(500));
  view.rerender(<Fixture items={workspaces.slice(1)} />);
  expect(root.querySelector('[data-sorting]')).toBeNull();
  expect(root.style.getPropertyValue('--ws-drop-top')).toBe('');
  down(screen.getByText('b')); view.unmount();
  act(() => vi.advanceTimersByTime(1000));
  expect(localStorage.getItem(WORKSPACE_ORDER_KEY)).toBeNull();
});

it('减少动态效果下同一帧移动并松手，迟到 RAF 不得重新施加拖动样式', () => {
  vi.useFakeTimers(); vi.spyOn(motion, 'prefersReducedMotion').mockReturnValue(true);
  render(<Fixture />); const root = screen.getByTestId('list'); geometry(root);
  down(screen.getByText('a')); act(() => vi.advanceTimersByTime(500));
  move(110); fireEvent.pointerUp(window, { pointerId: 1 });
  expect(ids(root)).toEqual(['b','c','a']);
  act(() => vi.advanceTimersByTime(50));
  expect(screen.getByText('a').style.transform).toBe('');
  expect(root.style.getPropertyValue('--ws-drop-top')).toBe('');
});

it('顺序过滤已关闭工作区，新工作区追加；键盘可排，存储失败可见', () => {
  localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify(['gone','c','a']));
  render(<Fixture />); const root = screen.getByTestId('list');
  expect(ids(root)).toEqual(['c','a','b']);
  fireEvent.keyDown(screen.getByText('b'), { altKey: true, key: 'ArrowUp' });
  expect(ids(root)).toEqual(['c','b','a']);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  fireEvent.keyDown(screen.getByText('b'), { altKey: true, key: 'ArrowUp' });
  expect(screen.getByRole('alert')).toBeTruthy(); write.mockRestore();
});

it('真实调度列表从折叠态长按展开并排序，不切工作区或打开对话', async () => {
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces, activeWorkspaceId:'b' }));
  mock.override('config.get', () => Promise.resolve({ workspaces, activeWorkspaceId:'b', locale:'zh-CN' }));
  localStorage.setItem('muster.sidebarCollapsed.v1:b:workspaces', '1');
  render(<StoreProvider><AgentFloat stackInline /></StoreProvider>);
  await waitFor(() => expect(document.querySelectorAll('[data-workspace-sort-id]').length).toBe(3));
  const root = document.querySelector<HTMLElement>('.agent-ws-stack:not(.agent-ws-stack-ghost)')!;
  geometry(root); vi.useFakeTimers();
  down(root.querySelector('[data-workspace-sort-id="b"] button')!);
  expect(root.querySelector('.agent-ws-sort-hint')!.textContent).toBe('');
  act(() => vi.advanceTimersByTime(200));
  expect(root.querySelector('.agent-ws-sort-hint')!.textContent).toBe('');
  act(() => vi.advanceTimersByTime(500));
  expect(root.querySelector('.agent-ws-sort-hint')!.textContent).toContain('Esc');
  expect(root.classList.contains('is-collapsed')).toBe(false);
  expect(root.querySelector<HTMLElement>('[data-workspace-sort-id="b"]')!.style.transform).toBe('translateY(-40px)');
  up();
  expect(ids(root)).toEqual(['a','b','c']);
  const button = root.querySelector('[data-workspace-sort-id="a"] .agent-notify-body')!;
  down(button); fireEvent.mouseDown(button); fireEvent.focus(button);
  act(() => vi.advanceTimersByTime(900));
  expect(document.querySelector('.session-details-card')).toBeNull();
  move(110); up();
  expect(ids(root)).toEqual(['b','c','a']);
  fireEvent.click(root.querySelector('[data-workspace-sort-id="a"] button')!);
  expect(mock.mockOf('workspaces.switch')).not.toHaveBeenCalled();
  expect(document.querySelector('.agent-float-panel.is-open')).toBeNull();
  localStorage.removeItem('muster.sidebarCollapsed.v1:b:workspaces');
});
