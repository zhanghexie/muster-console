/**
 * 一键自动布局的撤销回归（P3 board-free-view F-03）：
 * 布局末尾会 fit 视野（改写 pan/zoom）；旧实现 undoArrange 只恢复节点/便签位置与边端口，
 * 视野停在 fit 态——「恢复快照」语义不完整。新实现快照带布局前相机，撤销一并恢复。
 * 还原即红：把 undoArrange / 快照里的 view 字段删掉，pan/zoom 断言失败。
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasArrange } from '../../src/renderer/src/panels/freeCanvas/useCanvasArrange';
import { getFreeViewLayout, setFreeViewLayout } from '../../src/renderer/src/panels/freeViewStore';
import { emptyFreeViewLayout } from '../../src/renderer/src/panels/freeViewGeom';
import type { FreeCanvasItem } from '../../src/renderer/src/panels/freeCanvas/types';

function item(id: string, zoneId = 'ws-a'): FreeCanvasItem {
  return {
    id,
    name: id,
    runtimeLabel: 'GUI',
    status: { kind: 'none' },
    zoneId,
    isActive: false
  } as unknown as FreeCanvasItem;
}

function mount() {
  const fakeVp = { clientWidth: 800, clientHeight: 600 } as HTMLDivElement;
  return renderHook(() =>
    useCanvasArrange({
      aliveIds: ['s1', 's2'],
      zones: { s1: 'ws-a', s2: 'ws-a' },
      workspaceOrder: ['ws-a'],
      items: [item('s1'), item('s2')],
      measuredH: {},
      hOf: () => 70,
      vpRef: { current: fakeVp },
      worldRef: { current: null }
    })
  );
}

describe('useCanvasArrange 撤销恢复相机（F-03）', () => {
  beforeEach(() => {
    const base = emptyFreeViewLayout();
    base.nodes = { s1: { x: 400, y: 300 }, s2: { x: 900, y: 300 } };
    base.pan = { x: 111, y: 222 };
    base.zoom = 0.5;
    setFreeViewLayout(base);
  });

  it('布局会 fit 视野；撤销时节点位置与 pan/zoom 一并回到布局前', () => {
    const view = mount();
    act(() => view.result.current.runAutoArrange());

    const after = getFreeViewLayout();
    // 布局确实动了相机（fit），且节点位置变了——否则用例没有测到目标路径
    expect(after.pan).not.toEqual({ x: 111, y: 222 });
    expect(after.zoom).not.toBe(0.5);
    expect(after.nodes.s1).not.toEqual({ x: 400, y: 300 });

    act(() => view.result.current.undoArrange());
    const restored = getFreeViewLayout();
    expect(restored.nodes.s1).toEqual({ x: 400, y: 300 });
    expect(restored.nodes.s2).toEqual({ x: 900, y: 300 });
    // F-03 核心：相机随快照恢复，不再停在 fit 态
    expect(restored.pan).toEqual({ x: 111, y: 222 });
    expect(restored.zoom).toBe(0.5);
  });

  it('无快照时撤销是安全的 no-op（不碰当前布局）', () => {
    const view = mount();
    const before = getFreeViewLayout();
    act(() => view.result.current.undoArrange());
    expect(getFreeViewLayout()).toBe(before);
  });
});
