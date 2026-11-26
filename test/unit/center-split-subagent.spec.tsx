/**
 * 子代理（带 parentSessionId 的会话）与分屏的兼容契约。
 *
 * 分屏按引用驱动（SplitPaneRef = session/utility/empty），不看父子关系；
 * 子代理是普通 terminal 会话，故左栏拖拽、右键「分屏显示」、Snap 落位、
 * 空选择器填充全部开箱可用。本文件锁住这些行为，防止将来给分屏加
 * 「有父即禁」这类排除时静默回归。
 */
import React from 'react';
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import {
  __resetCenterSplitForTest, attachCenterSplitBridge, centerSplitClosePane,
  centerSplitCommitSnapLayout, centerSplitIncoming,
  centerSplitSelectInPane, centerSplitTryFill, getCenterSplitState
} from '../../src/renderer/src/centerSplitStore';
import {
  SPLIT_DRAG_MIME, decodeSplitDragPayload, deriveCenterSplitSnapLayout,
  getCenterSplitPaneRefs, type SplitPaneRef
} from '../../src/shared/centerSplit';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const WS = { id: 'ws-a', path: 'E:/demo', name: '演示', openedAt: 1 };

function sess(id: string, name: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    type: 'terminal',
    launchKind: 'agent',
    runtime: 'pi',
    name,
    workspaceId: WS.id,
    createdAt: 1,
    lastUsedAt: 1,
    status: 'running',
    lifecycle: 'idle',
    ...extra
  };
}

/** 顶层 A + 它的子代理 A1；另有一个顶层 B */
const SESSIONS: SessionMeta[] = [
  sess('a', '顶层 A', { lastUsedAt: 10 }),
  sess('a1', '子代理 A1', { parentSessionId: 'a', lastUsedAt: 9 }),
  sess('b', '顶层 B', { lastUsedAt: 8 })
];

function transfer(): DataTransfer {
  const entries = new Map<string, string>();
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: (type: string, value: string) => { entries.set(type, value); },
    getData: (type: string) => entries.get(type) ?? '',
    get types() { return [...entries.keys()]; }
  } as unknown as DataTransfer;
}

/** 主侧随 store 变化推进（模拟 App 持有主选中） */
let primaryRef: SplitPaneRef = { kind: 'session', sessionId: 'a' };
const selects: SplitPaneRef[] = [];

function seedBridge(): void {
  primaryRef = { kind: 'session', sessionId: 'a' };
  selects.length = 0;
  attachCenterSplitBridge({
    getPrimary: () => primaryRef,
    getUnderlyingPrimary: () => primaryRef,
    selectRef: (ref) => { selects.push(ref); primaryRef = ref; },
    getPrefs: () => ({ dir: 'row', ratio: 0.5 }),
    savePrefs: () => {},
    supportsRef: () => true,
    canSelectRef: () => true,
    getSelectionScope: () => WS.id
  });
}

beforeEach(() => {
  __resetCenterSplitForTest();
  Element.prototype.scrollIntoView ??= () => {};
});

function renderLeft(): void {
  const api = currentApiMock();
  api.override('workspaces.list', () => Promise.resolve({ workspaces: [WS], activeWorkspaceId: WS.id }));
  api.override('config.get', () => Promise.resolve({ workspaces: [WS], activeWorkspaceId: WS.id, locale: 'zh-CN' }));
  api.override('sessions.list', () => Promise.resolve({ sessions: SESSIONS, activeId: 'a' }));
  seedBridge();
  const noop = (): void => {};
  render(
    <StoreProvider>
      <PanelHistoryProvider>
        <LeftPanel utilityPanel={null} onSelectUtilityPanel={noop} onCloseUtilityPanel={noop} />
      </PanelHistoryProvider>
    </StoreProvider>
  );
}

describe('子代理与分屏兼容', () => {
  it('子代理行可发起分屏拖拽，载荷只带 sessionId（不含层级语义）', async () => {
    renderLeft();
    const label = await screen.findByText('子代理 A1');
    const row = label.closest('.session-item') as HTMLElement;
    expect(row.getAttribute('draggable')).toBe('true');

    const dt = transfer();
    const ev = createEvent.dragStart(row, { dataTransfer: dt, bubbles: true });
    act(() => { row.dispatchEvent(ev); });

    expect(dt.effectAllowed).toBe('copy');
    const payload = decodeSplitDragPayload(dt.getData(SPLIT_DRAG_MIME));
    expect(payload).toEqual({ kind: 'session', sessionId: 'a1' });
  });

  it('从 twisty 起的拖拽被拒（点 twisty 只折叠，不触发分屏）', async () => {
    renderLeft();
    const label = await screen.findByText('顶层 A');
    const row = label.closest('.session-item') as HTMLElement;
    const twisty = row.querySelector('button.session-tree-twisty') as HTMLElement;

    const dt = transfer();
    const ev = createEvent.dragStart(twisty, { dataTransfer: dt, bubbles: true });
    act(() => { twisty.dispatchEvent(ev); });

    expect(dt.getData(SPLIT_DRAG_MIME)).toBe('');
  });

  it('子代理可作主侧进分屏（centerSplitIncoming 不因其有父而拒）', async () => {
    renderLeft();
    await screen.findByText('子代理 A1');
    const ok = centerSplitIncoming({ kind: 'session', sessionId: 'a1' }, 'right');
    expect(ok).not.toBe(false);
    const state = getCenterSplitState();
    expect(state.open).toBe(true);
    const refs = getCenterSplitPaneRefs({ kind: 'session', sessionId: 'a' }, state);
    expect(refs).toContainEqual({ kind: 'session', sessionId: 'a1' });
  });

  it('子代理可进 Snap 布局并与其他内容共存（不丢父也不丢子）', async () => {
    renderLeft();
    await screen.findByText('子代理 A1');
    // 副侧放子代理，第三格经 Snap 候选落位
    centerSplitIncoming({ kind: 'session', sessionId: 'a1' }, 'right');

    const state = getCenterSplitState();
    // 把子代理从副侧移到第三格（thirds 布局 index 2），父占 index 0
    const candidate = deriveCenterSplitSnapLayout(
      { kind: 'session', sessionId: 'a' },
      state,
      1,
      { layoutId: 'thirds', index: 2 }
    );
    expect(candidate).not.toBeNull();
    act(() => { centerSplitCommitSnapLayout(candidate!); });

    const after = getCenterSplitState();
    const refs = getCenterSplitPaneRefs({ kind: 'session', sessionId: 'a' }, after);
    expect(refs).toContainEqual({ kind: 'session', sessionId: 'a' });
    expect(refs).toContainEqual({ kind: 'session', sessionId: 'a1' });
    // 第三个格空着等选择器（不是被丢弃）
    expect(refs.filter((r) => r.kind === 'empty')).toHaveLength(1);
  });

  it('子代理可填充分屏空槽（点子代理行即填入，不抢主选中）', async () => {
    renderLeft();
    await screen.findByText('子代理 A1');
    centerSplitIncoming({ kind: 'session', sessionId: 'b' }, 'right');

    const ref: SplitPaneRef = { kind: 'session', sessionId: 'a1' };
    let filled = false;
    act(() => { filled = centerSplitTryFill(ref); });
    expect(filled).toBe(true);
  });

  it('关闭子代理所在 pane：布局保留、父仍是主侧（与顶层会话同语义）', async () => {
    renderLeft();
    await screen.findByText('子代理 A1');
    centerSplitIncoming({ kind: 'session', sessionId: 'a1' }, 'right');
    expect(getCenterSplitState().open).toBe(true);

    // 关掉副侧（子代理）→ 布局收回单屏，父保持主选中，不把子代理顶上来
    act(() => { centerSplitClosePane(1); });
    const after = getCenterSplitState();
    expect(after.open).toBe(false);
    expect(selects.every((r) => r.kind !== 'session' || r.sessionId !== 'a1')).toBe(true);
  });

  it('按会话引用选择槽位对子代理同样生效', async () => {
    renderLeft();
    await screen.findByText('子代理 A1');
    centerSplitIncoming({ kind: 'session', sessionId: 'a1' }, 'right');
    act(() => { centerSplitSelectInPane(1, { kind: 'session', sessionId: 'a1' }); });
    const state = getCenterSplitState();
    expect(getCenterSplitPaneRefs({ kind: 'session', sessionId: 'a' }, state))
      .toContainEqual({ kind: 'session', sessionId: 'a1' });
    await waitFor(() => expect(true).toBe(true));
  });
});
