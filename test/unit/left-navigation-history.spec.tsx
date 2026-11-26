import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelHistoryProvider, usePanelHistory } from '../../src/renderer/src/panelHistory';
import { LeftNavigationRecorder, useLeftNavigationHistory, type LeftNavigationController } from '../../src/renderer/src/hooks/useLeftNavigationHistory';
import { __resetCenterSplitForTest, attachCenterSplitBridge, centerSplitClosePane, centerSplitReconcilePrimary,
  centerSplitSelectInPane, centerSplitSetFocused, centerSplitSetRatio, centerSplitSetDividerRatio, centerSplitToggleShortcut, centerSplitTryFill,
  centerSplitCommitSnapLayout, getCenterSplitState } from '../../src/renderer/src/centerSplitStore';
import { deriveCenterSplitSnapLayout, type SplitPaneRef } from '../../src/shared/centerSplit';

const session = (sessionId: string): SplitPaneRef => ({ kind: 'session', sessionId });
const tool = (sel: string): SplitPaneRef => ({ kind: 'utility', sel });
const unavailable = new Set<string>();
let select: (ref: SplitPaneRef) => void | Promise<void>;
let move: ReturnType<typeof useLeftNavigationHistory>;
let setPrimary: (ref: SplitPaneRef) => void;
let show: (page: 'git' | 'terminal') => void;
const canSelect = (ref: SplitPaneRef) => ref.kind !== 'session' || !unavailable.has(ref.sessionId);

function Harness({ workspaceId, enabled = true }: { workspaceId: string; enabled?: boolean }) {
  const [primary, updatePrimary] = useState<SplitPaneRef>(session('a'));
  const [page, setPage] = useState<'terminal' | 'git'>('terminal');
  const latest = useRef({ primary, workspaceId }); latest.current = { primary, workspaceId };
  setPrimary = updatePrimary; show = setPage;
  useEffect(() => {
    attachCenterSplitBridge({ getPrimary: () => latest.current.primary,
      getSelectionScope: () => latest.current.workspaceId, selectRef: ref => select(ref),
      getPrefs: () => ({ dir: 'row', ratio: .6 }), savePrefs: () => {},
      supportsRef: canSelect, canSelectRef: canSelect });
    return () => attachCenterSplitBridge(null);
  }, []);
  useLayoutEffect(() => { centerSplitReconcilePrimary(); }, [primary]);
  move = useLeftNavigationHistory({ workspaceId, enabled, page, primary, showPage: setPage });
  const h = usePanelHistory();
  const navigate = (ref: SplitPaneRef) => { if (!centerSplitTryFill(ref)) { setPage('terminal'); updatePrimary(ref); } };
  return <><output data-testid="state">{JSON.stringify({ primary, page, split: getCenterSplitState(),
    back: h.leftBackDepth(workspaceId), forward: h.leftForwardDepth(workspaceId) })}</output>
    <button onClick={move.back}>后退</button><button onClick={move.forward}>前进</button>
    <button onClick={() => navigate(tool('tasks'))}>任务</button>
    <button onClick={() => navigate(tool('usage'))}>统计</button>
    <button onClick={() => navigate(session('b'))}>会话B</button>
    <button onClick={() => setPage('git')}>右侧</button>
    <button onClick={() => setPage('terminal')}>左侧</button>
    <button onClick={centerSplitToggleShortcut}>分屏</button></>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);
const click = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));
const mount = () => render(<PanelHistoryProvider><Harness workspaceId="ws"/></PanelHistoryProvider>);
beforeEach(() => { __resetCenterSplitForTest(); unavailable.clear(); select = ref => setPrimary(ref); });
afterEach(() => { cleanup(); __resetCenterSplitForTest(); });

describe('生产左导航 Hook + 分屏 store + 历史 Provider', () => {
  it('录制器独立订阅，不因分屏焦点/调宽/历史变化重渲 App 父级', () => {
    let renders = 0;
    function AppParent() {
      renders++;
      const navigationRef = useRef<LeftNavigationController | null>(null);
      return <LeftNavigationRecorder workspaceId="ws" enabled page="terminal" primary={session('a')}
        showPage={() => {}} navigationRef={navigationRef}/>;
    }
    render(<PanelHistoryProvider><AppParent/></PanelHistoryProvider>);
    act(() => attachCenterSplitBridge({ getPrimary: () => session('a'), selectRef: () => {},
      getPrefs: () => ({ dir: 'row', ratio: .6 }), savePrefs: () => {} }));
    act(() => centerSplitToggleShortcut()); act(() => centerSplitSetFocused(0));
    act(() => centerSplitSetRatio(.72));
    expect(renders).toBe(1);
  });

  it('工具和会话按完整访问回放，不会把工具关闭误当作另一次会话导航', () => {
    mount(); click('任务'); click('会话B');
    expect(state().back).toBe(2);
    click('后退'); expect(state().primary).toEqual(tool('tasks')); expect(state().forward).toBe(1);
    click('后退'); expect(state().primary).toEqual(session('a')); expect(state().back).toBe(0);
    click('前进'); expect(state().primary).toEqual(tool('tasks'));
    click('前进'); expect(state().primary).toEqual(session('b')); expect(state().forward).toBe(0);
  });

  it('进入右侧只记一步，右侧内部变化不入左栈；回放右侧不触碰左边内容', () => {
    mount(); click('任务'); click('右侧'); expect(state().back).toBe(2);
    act(() => setPrimary(session('b'))); // Background selection while the right remains visible.
    expect(state().back).toBe(2);
    click('后退'); expect(state().page).toBe('terminal'); expect(state().primary).toEqual(tool('tasks'));
    click('前进'); expect(state().page).toBe('git'); expect(state().primary).toEqual(tool('tasks'));
    click('左侧'); expect(state().forward).toBe(0);
    click('后退'); expect(state().page).toBe('git');
  });

  it('分屏的副槽内容切换可回放，焦点在副槽时也恢复原逻辑槽', () => {
    mount(); click('分屏'); click('会话B'); click('任务');
    expect(state().primary).toEqual(session('a')); expect(state().split.secondary).toEqual(tool('tasks'));
    const depth = state().back;
    act(() => centerSplitSetFocused(0)); act(() => centerSplitSetRatio(.72));
    expect(state().back).toBe(depth);
    click('后退'); expect(state().primary).toEqual(session('a')); expect(state().split.secondary).toEqual(session('b'));
    expect(state().split.focused).toBe(1);
    click('前进'); expect(state().split.secondary).toEqual(tool('tasks')); expect(state().split.focused).toBe(0);
    expect(state().split.ratio).toBe(.72);
  });

  it('三格物理重排和关闭可以往返恢复，内容不重复、不受当前焦点影响', () => {
    mount(); click('分屏'); click('会话B');
    act(() => {
      const candidate = deriveCenterSplitSnapLayout(session('a'), getCenterSplitState(), 0, { layoutId: 'thirds', index: 2 });
      centerSplitCommitSnapLayout(candidate!); centerSplitSelectInPane(2, tool('tasks'));
    });
    const depth = state().back;
    act(() => { centerSplitSetDividerRatio(0, .25); centerSplitSetDividerRatio(1, .7); });
    expect(state().back).toBe(depth);
    const before = state().split;
    act(() => centerSplitClosePane(1)); expect(state().split.tertiary).toBeUndefined();
    click('后退'); expect(state().split.secondary).toEqual(session('b'));
    expect(state().split.tertiary).toEqual(tool('tasks')); expect(state().split.order).toEqual(before.order);
    expect(state().split.ratios).toEqual([.25, .7]);
    expect(state().primary).toEqual(session('a'));
    click('前进'); expect(state().split.tertiary).toBeUndefined();
  });

  it('慢于旧 250ms 窗口的异步回放也不反入栈，完成后的快速真导航立即记录', async () => {
    mount(); click('任务'); click('会话B');
    let finish!: () => void;
    select = ref => new Promise<void>(resolve => { finish = () => { setPrimary(ref); resolve(); }; });
    click('后退'); expect(getCenterSplitState().pendingLayout).toBeTruthy();
    expect(state().back).toBe(1); expect(state().forward).toBe(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); finish(); });
    expect(state().primary).toEqual(tool('tasks')); expect(state().back).toBe(1); expect(state().forward).toBe(1);
    click('会话B'); expect(state().back).toBe(2); expect(state().forward).toBe(0);
  });

  it('失败的会话回放保留原视图，并撤销历史游标移动', async () => {
    mount(); click('任务'); click('会话B'); click('后退');
    let fail!: (error: Error) => void;
    select = () => new Promise<void>((_, reject) => { fail = reject; });
    click('后退');
    await act(async () => { fail(new Error('select failed')); });
    expect(state().primary).toEqual(tool('tasks')); expect(state().back).toBe(1); expect(state().forward).toBe(1);
    select = ref => setPrimary(ref);
    click('前进'); expect(state().primary).toEqual(session('b'));
  });

  it('从右侧回放失败时恢复右页；新用户选择打断回放仍作为真实导航记录', async () => {
    mount(); click('任务'); click('右侧');
    let fail!: (error: Error) => void;
    select = () => new Promise<void>((_, reject) => { fail = reject; });
    // The previous left tool is still primary, so first go farther back to a different primary.
    click('后退'); click('后退');
    await act(async () => { fail(new Error('selection failed')); });
    expect(state().primary).toEqual(tool('tasks')); expect(state().forward).toBe(1);
    click('前进'); expect(state().page).toBe('git');
    act(() => setPrimary(session('b')));
    click('后退');
    await act(async () => { fail(new Error('selection failed')); });
    expect(state().page).toBe('git');
    // A new main navigation cancels the old request rather than suppressing the user's visit.
    click('后退');
    click('统计');
    expect(state().page).toBe('terminal'); expect(state().primary).toEqual(tool('usage'));
    expect(state().forward).toBe(0);
    click('后退'); expect(state().page).toBe('git');
  });

  it('失源的主目标跳过；失源的副格恢复为空选择器', () => {
    mount(); click('分屏'); click('会话B'); click('右侧');
    unavailable.add('b'); click('后退'); expect(state().split.secondary).toEqual({ kind: 'empty' });
    click('前进'); click('后退'); expect(state().primary).toEqual(session('a'));
    unavailable.add('a'); click('后退'); expect(state().page).toBe('terminal');
    expect(state().back).toBe(0);
  });

  it('切工作区、水合和待确认布局不制造访问；工作区历史各自保留', () => {
    const element = (workspaceId: string, enabled: boolean) => <PanelHistoryProvider><Harness workspaceId={workspaceId} enabled={enabled}/></PanelHistoryProvider>;
    const view = render(element('a', false));
    act(() => show('git')); view.rerender(element('a', true)); expect(state().back).toBe(0);
    click('左侧'); click('任务'); const aDepth = state().back;
    view.rerender(element('b', false)); act(() => setPrimary(session('b')));
    view.rerender(element('b', true)); expect(state().back).toBe(0);
    click('任务'); expect(state().back).toBe(1);
    view.rerender(element('a', true)); expect(state().back).toBe(aDepth);
  });
});
