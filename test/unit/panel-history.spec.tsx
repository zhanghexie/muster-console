/**
 * PanelHistoryProvider 浏览器语义（返回/前进双栈）行为测试：
 * 完整快照双栈与工作区隔离；回放隔离由生产 Hook 的行为用例覆盖。
 */
import React from 'react';
import { act, render, renderHook, screen, fireEvent } from '@testing-library/react';
import {
  PanelHistoryProvider,
  usePanelHistory,
  type LeftHistoryEntry,
  type LeftHistoryCurrent
} from '../../src/renderer/src/panelHistory';

const WS = 'ws-a';

function Probe({ onBack }: { onBack?: (e: LeftHistoryEntry | undefined) => void }) {
  const h = usePanelHistory();
  const current: LeftHistoryCurrent = { page: 'terminal', primary: { kind: 'session', sessionId: 's-now' } };
  return (
    <div>
      <span data-testid="back-depth">{h.leftBackDepth(WS)}</span>
      <span data-testid="forward-depth">{h.leftForwardDepth(WS)}</span>
      <button
        data-testid="push"
        onClick={() => h.pushLeft(WS, { page: 'terminal', primary: { kind: 'session', sessionId: 's-prev' } })}
      >
        push
      </button>
      <button data-testid="back" onClick={() => onBack?.(h.backLeft(WS, current))}>
        back
      </button>
    </div>
  );
}

function renderProbe(onBack?: (e: LeftHistoryEntry | undefined) => void) {
  return render(
    <PanelHistoryProvider>
      <Probe onBack={onBack} />
    </PanelHistoryProvider>
  );
}

describe('panelHistory 左侧时间线', () => {
  it('push 入栈可返回；back 弹出并把当前态倒进前进栈', () => {
    let returned: LeftHistoryEntry | undefined;
    renderProbe((e) => (returned = e));

    // 初始：两栈皆空
    expect(screen.getByTestId('back-depth').textContent).toBe('0');
    expect(screen.getByTestId('forward-depth').textContent).toBe('0');

    // push 一次 → 可返回 1 步
    fireEvent.click(screen.getByTestId('push'));
    expect(screen.getByTestId('back-depth').textContent).toBe('1');

    // back → 弹出 push 的条目，当前态(s-now)进前进栈
    fireEvent.click(screen.getByTestId('back'));
    expect(returned).toEqual({ page: 'terminal', primary: { kind: 'session', sessionId: 's-prev' } });
    expect(screen.getByTestId('back-depth').textContent).toBe('0');
    expect(screen.getByTestId('forward-depth').textContent).toBe('1');
  });

  it('快速新导航立即清空前进栈；不吞掉 250ms 内的真实点击', () => {
    const { result } = renderHook(() => usePanelHistory(), { wrapper: PanelHistoryProvider });
    const from: LeftHistoryCurrent = { page: 'terminal', primary: { kind: 'utility', sel: 'tasks' } };
    act(() => result.current.pushLeft(WS, from));
    act(() => result.current.backLeft(WS, { page: 'git' }));
    expect(result.current.leftForwardDepth(WS)).toBe(1);
    act(() => result.current.pushLeft(WS, from));
    expect(result.current.leftForwardDepth(WS)).toBe(0);
    expect(result.current.leftBackDepth(WS)).toBe(1);
    expect(result.current.leftBackDepth('ws-b')).toBe(0);
  });

});

describe('panelHistory 多根文件回放', () => {
  it('同名相对路径按根分别入栈，返回与前进保留 fileRef', () => {
    const { result } = renderHook(() => usePanelHistory(), { wrapper: PanelHistoryProvider });
    const file = (rootId: string) => ({ path: 'src/index.ts', external: false,
      fileRef: { workspaceId: WS, rootId, relativePath: 'src/index.ts' } });
    act(() => result.current.pushRight(WS, { kind: 'file', ...file('a') }));
    act(() => result.current.pushRight(WS, { kind: 'file', ...file('b') }));
    expect(result.current.rightBackDepth(WS)).toBe(2);
    let returned: unknown;
    act(() => { returned = result.current.backRight(WS, { tab: 'files', repo: null, file: file('c') }); });
    expect(returned).toEqual({ kind: 'file', ...file('b') });
    act(() => { returned = result.current.forwardRight(WS, { tab: 'files', repo: null, file: file('b') }); });
    expect(returned).toEqual({ kind: 'file', ...file('c') });
  });
});
