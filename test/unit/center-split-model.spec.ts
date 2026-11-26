/**
 * 中央区分屏 V1：split 树纯状态机（shared/centerSplit）。
 * 拦状态机错误：side→槽位映射、一层分屏替换/交换/换向/解散、比例钳制、
 * 失源清理、拖拽负载编解码。
 */
import { describe, expect, it } from 'vitest';
import {
  SPLIT_DRAG_MIME,
  clampRatio,
  decodeSplitDragPayload,
  deriveCenterSplitDockLayout,
  deriveCenterSplitSnapLayout,
  deriveCenterSplitIncomingSnapLayout,
  CENTER_SNAP_LAYOUTS,
  getCenterSplitPaneCells,
  getCenterSplitDividers,
  getCenterSplitRatios,
  getCenterSplitPaneRefs,
  dissolveKeep,
  dropZoneFromPoint,
  encodeSplitDragPayload,
  flipDir,
  insertPane,
  pruneTree,
  rectsIntersect,
  replaceSlot,
  samePaneRef,
  setTreeRatio,
  sideToSlot,
  splitSlots,
  splitDockSideFromPoint,
  swapSlots,
  type SplitNode,
  type SplitPaneRef,
  type CenterSplitPaneState
} from '../../src/shared/centerSplit';

const session = (id: string): SplitPaneRef => ({ kind: 'session', sessionId: id });
const utility = (sel: string): SplitPaneRef => ({ kind: 'utility', sel });
const EMPTY: SplitPaneRef = { kind: 'empty' };

const pane = (ref: SplitPaneRef): SplitNode => ({ type: 'pane', ref });

describe('three-pane resize geometry', () => {
  it('三列边界随物理位置变化，逻辑重排不改变边界，两相邻面都有最小宽度', () => {
    const state: CenterSplitPaneState = { open: true, secondary: session('b'), tertiary: session('c'), layoutId: 'thirds', order: [2, 0, 1], ratios: [.25, .7] };
    const cells = getCenterSplitPaneCells(state);
    expect(cells[0].x).toBe(.7); expect(cells[1].width).toBe(.25); expect(cells[2].width).toBeCloseTo(.45);
    expect(cells.reduce((sum, cell) => sum + cell.width, 0)).toBeCloseTo(1);
    const dividers = getCenterSplitDividers(state);
    expect(dividers.map(divider => divider.ratio)).toEqual([.25, .7]);
    expect(dividers[0].max).toBeCloseTo(.5); expect(dividers[1].min).toBeCloseTo(.45);
    const bad = getCenterSplitRatios({ ...state, ratios: [.95, -.2] });
    expect(bad[0]).toBeLessThanOrEqual(.6); expect(bad[1] - bad[0]).toBeCloseTo(.2);
  });
  it.each(['focus', 'focus-mirror'] as const)('%s横分隔线只覆盖上下两格一侧', layoutId => {
    const state: CenterSplitPaneState = { open: true, secondary: session('b'), tertiary: session('c'), layoutId, ratios: [.6, .3] };
    const cells = getCenterSplitPaneCells(state), dividers = getCenterSplitDividers(state);
    expect(cells.reduce((sum, cell) => sum + cell.width * cell.height, 0)).toBeCloseTo(1);
    expect(dividers[1]).toMatchObject({ dir: 'col', y: .3, x: layoutId === 'focus' ? .6 : 0, width: layoutId === 'focus' ? .4 : .6 });
  });
});

describe('clampRatio', () => {
  it('钳到 [0.2, 0.8]，非法值回 0.5', () => {
    expect(clampRatio(0.05)).toBe(0.2);
    expect(clampRatio(0.95)).toBe(0.8);
    expect(clampRatio(0.42)).toBe(0.42);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe('sideToSlot', () => {
  it('左/右=row 槽 0/1；上/下=col 槽 0/1', () => {
    expect(sideToSlot('left')).toEqual({ dir: 'row', slot: 0 });
    expect(sideToSlot('right')).toEqual({ dir: 'row', slot: 1 });
    expect(sideToSlot('top')).toEqual({ dir: 'col', slot: 0 });
    expect(sideToSlot('bottom')).toEqual({ dir: 'col', slot: 1 });
  });
});

describe('insertPane', () => {
  it.each([session('a'), utility('memory')])('单屏自分屏保持唯一内容：%j', ref => {
    const root = pane(ref);
    for (const side of ['left', 'right', 'top', 'bottom'] as const) expect(insertPane(root, { ...ref }, side)).toBe(root);
  });

  it('已存在内容落到另一槽位时交换，方向随落点更新且内容保持唯一', () => {
    const root = insertPane(pane(session('a')), utility('memory'), 'right');
    const next = insertPane(root, utility('memory'), 'top');
    expect(splitSlots(next)).toEqual([utility('memory'), session('a')]);
    expect(next.type === 'split' && next.dir).toBe('col');
    expect(splitSlots(replaceSlot(root, 0, utility('memory')))).toEqual([utility('memory'), session('a')]);
  });

  it('无现有内容 → 新内容直接成唯一 pane（不构成 split）', () => {
    expect(insertPane(null, session('a'), 'right')).toEqual(pane(session('a')));
  });

  it('单 pane + 右侧 → [旧, 新] row', () => {
    const root = insertPane(pane(session('a')), session('b'), 'right');
    expect(splitSlots(root)).toEqual([session('a'), session('b')]);
    expect(root.type === 'split' && root.dir).toBe('row');
  });

  it('单 pane + 左侧 → [新, 旧]（新内容占 pane0）', () => {
    const root = insertPane(pane(session('a')), session('b'), 'left');
    expect(splitSlots(root)).toEqual([session('b'), session('a')]);
  });

  it('单 pane + 下方 → col 且新内容在槽 1', () => {
    const root = insertPane(pane(utility('tasks')), session('b'), 'bottom');
    expect(root.type === 'split' && root.dir).toBe('col');
    expect(splitSlots(root)).toEqual([utility('tasks'), session('b')]);
  });

  it('已是一层分屏：drop 右替换槽 1，另一侧保留；方向变了整体换向', () => {
    const root = insertPane(pane(session('a')), session('b'), 'right');
    const next = insertPane(root, utility('memory'), 'right');
    expect(splitSlots(next)).toEqual([session('a'), utility('memory')]);
    const flipped = insertPane(root, utility('memory'), 'top');
    expect(flipped.type === 'split' && flipped.dir).toBe('col');
    expect(splitSlots(flipped)).toEqual([utility('memory'), session('b')]);
  });

  it('比例走 clampRatio', () => {
    const root = insertPane(pane(session('a')), session('b'), 'right', 5);
    expect(root.type === 'split' && root.ratio).toBe(0.8);
  });
});

describe('existing pane edge docking candidate', () => {
  it.each([0, 1] as const)('来源槽位 %i 的四边候选同时确定顺序、方向、焦点和等分比例', source => {
    const primary = session('a'), secondary = utility('memory');
    const current: CenterSplitPaneState = { open: true, secondary, dir: 'col', ratio: 0.65 };
    const moved = source === 0 ? primary : secondary, other = source === 0 ? secondary : primary;
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const first = side === 'left' || side === 'top';
      expect(deriveCenterSplitDockLayout(primary, current, source, side)).toEqual({
        pane0: first ? moved : other, pane1: first ? other : moved,
        dir: side === 'left' || side === 'right' ? 'row' : 'col', ratio: 0.5, focused: first ? 0 : 1
      });
    }
    expect(current).toEqual({ open: true, secondary, dir: 'col', ratio: 0.65 });
  });

  it('中央取消、单屏、空侧和重复内容均不生成可提交候选', () => {
    const a = session('a');
    expect(deriveCenterSplitDockLayout(a, { open: true, secondary: session('b') }, 0, null)).toBeNull();
    expect(deriveCenterSplitDockLayout(a, { open: false, secondary: session('b') }, 0, 'right')).toBeNull();
    expect(deriveCenterSplitDockLayout(a, { open: true, secondary: EMPTY }, 0, 'right')).toBeNull();
    expect(deriveCenterSplitDockLayout(EMPTY, { open: true, secondary: a }, 1, 'left')).toBeNull();
    expect(deriveCenterSplitDockLayout(a, { open: true, secondary: session('a') }, 0, 'right')).toBeNull();
  });

  it('引用判等按内容标识而非对象身份；同名不同类不混淆', () => {
    expect(samePaneRef(session('a'), session('a'))).toBe(true);
    expect(samePaneRef(utility('a'), utility('a'))).toBe(true);
    expect(samePaneRef(session('a'), utility('a'))).toBe(false);
    expect(samePaneRef(EMPTY, { kind: 'empty' })).toBe(true);
  });

  it('工作面只在四边停靠，中央与越界取消，角落取最近边', () => {
    expect(splitDockSideFromPoint(400, 300, 800, 600)).toBeNull();
    expect(splitDockSideFromPoint(-1, 300, 800, 600)).toBeNull();
    expect(splitDockSideFromPoint(801, 300, 800, 600)).toBeNull();
    expect(splitDockSideFromPoint(10, 300, 800, 600)).toBe('left');
    expect(splitDockSideFromPoint(790, 300, 800, 600)).toBe('right');
    expect(splitDockSideFromPoint(400, 10, 800, 600)).toBe('top');
    expect(splitDockSideFromPoint(400, 590, 800, 600)).toBe('bottom');
    expect(splitDockSideFromPoint(40, 5, 800, 600)).toBe('top');
    expect(splitDockSideFromPoint(56, 300, 800, 600)).toBe('left');
    expect(splitDockSideFromPoint(57, 300, 800, 600)).toBeNull();
  });
});

describe('replaceSlot / swapSlots / flipDir / setTreeRatio / dissolveKeep', () => {
  const base = insertPane(pane(session('a')), session('b'), 'right');

  it('replaceSlot 换槽 1 内容', () => {
    expect(splitSlots(replaceSlot(base, 1, EMPTY))).toEqual([session('a'), EMPTY]);
  });

  it('swapSlots 交换两侧', () => {
    expect(splitSlots(swapSlots(base))).toEqual([session('b'), session('a')]);
  });

  it('flipDir 换向不动内容与比例', () => {
    const next = flipDir(base);
    expect(next.type === 'split' && next.dir).toBe('col');
    expect(splitSlots(next)).toEqual(splitSlots(base));
  });

  it('setTreeRatio 钳制', () => {
    const next = setTreeRatio(base, 0.01);
    expect(next.type === 'split' && next.ratio).toBe(0.2);
  });

  it('dissolveKeep 保留指定侧为唯一 pane', () => {
    expect(dissolveKeep(base, 1)).toEqual(pane(session('b')));
    expect(dissolveKeep(base, 0)).toEqual(pane(session('a')));
  });
});

describe('pruneTree', () => {
  it('失效引用降为 empty，布局保留', () => {
    const root = insertPane(pane(session('a')), session('gone'), 'right');
    const next = pruneTree(root, ref => ref.kind !== 'session' || ref.sessionId !== 'gone');
    expect(splitSlots(next)).toEqual([session('a'), EMPTY]);
  });
});

describe('dropZoneFromPoint', () => {
  it('横向偏移大 → 左右；否则上下；中线判定稳定', () => {
    expect(dropZoneFromPoint(10, 100, 400, 400)).toBe('left');
    expect(dropZoneFromPoint(390, 100, 400, 400)).toBe('right');
    expect(dropZoneFromPoint(200, 10, 400, 400)).toBe('top');
    expect(dropZoneFromPoint(200, 390, 400, 400)).toBe('bottom');
    // 对角线上 |dx|==|dy| 时取纵向（else 分支）
    expect(dropZoneFromPoint(100, 100, 400, 400)).toBe('top');
  });
});

describe('拖拽负载编解码', () => {
  it('session/utility/empty 往返；非法输入返回 null', () => {
    for (const ref of [session('x'), utility('nav:1'), EMPTY]) {
      expect(decodeSplitDragPayload(encodeSplitDragPayload(ref))).toEqual(ref);
    }
    expect(decodeSplitDragPayload('not json')).toBeNull();
    expect(decodeSplitDragPayload('{"kind":"evil"}')).toBeNull();
    expect(decodeSplitDragPayload(JSON.stringify({ kind: 'session' }))).toBeNull();
    expect(decodeSplitDragPayload('x'.repeat(600))).toBeNull();
  });

  it('mime 常量稳定（preload/渲染层契约）', () => {
    expect(SPLIT_DRAG_MIME).toBe('application/x-muster-pane');
  });
});

describe('rectsIntersect', () => {
  it('相交/相接/相离', () => {
    const a = { x: 0, y: 0, width: 100, height: 40 };
    expect(rectsIntersect(a, { x: 50, y: 20, width: 100, height: 40 })).toBe(true);
    expect(rectsIntersect(a, { x: 100, y: 0, width: 50, height: 40 })).toBe(false);
    expect(rectsIntersect(a, { x: 0, y: 40, width: 100, height: 40 })).toBe(false);
  });
});

describe('capacity-preserving Windows Snap model', () => {
  it('offers only two/three-cell presets and partitions the full work area', () => {
    expect(CENTER_SNAP_LAYOUTS.map(item => item.id)).toEqual(['halves', 'wide', 'stack', 'focus', 'focus-mirror', 'thirds']);
    for (const preset of CENTER_SNAP_LAYOUTS) {
      expect([2, 3]).toContain(preset.cells.length);
      expect(preset.cells.reduce((sum, cell) => sum + cell.width * cell.height, 0)).toBeCloseTo(1);
      preset.cells.forEach((cell, index) => {
        expect(cell.x + cell.width).toBeLessThanOrEqual(1); expect(cell.y + cell.height).toBeLessThanOrEqual(1);
        for (const other of preset.cells.slice(index + 1)) expect(rectsIntersect(cell, other)).toBe(false);
      });
    }
  });
  it.each([0, 1] as const)('two visible instances survive every enabled cell when dragging logical slot %i', source => {
    const current: CenterSplitPaneState = { open: true, secondary: utility('memory'), dir: 'col', ratio: .65 };
    for (const preset of CENTER_SNAP_LAYOUTS) for (let index = 0; index < preset.cells.length; index++) {
      const candidate = deriveCenterSplitSnapLayout(session('a'), current, source, { layoutId: preset.id, index })!;
      expect(candidate.panes.filter(ref => ref.kind !== 'empty')).toEqual([session('a'), utility('memory')]);
      expect(candidate.order[candidate.focused]).toBe(index);
      expect(candidate.panes[candidate.focused]).toEqual(source === 0 ? session('a') : utility('memory'));
      expect(new Set(candidate.order).size).toBe(preset.cells.length);
      expect(candidate.original).toEqual([session('a'), utility('memory')]);
    }
    expect(current).toEqual({ open: true, secondary: utility('memory'), dir: 'col', ratio: .65 });
  });
  it.each([0, 1, 2] as const)('three contents survive each three-cell target; two-cell capacity is disabled for source %i', source => {
    const current: CenterSplitPaneState = { open: true, secondary: session('b'), tertiary: utility('nav:c'), layoutId: 'focus', order: [2, 0, 1] };
    for (const preset of CENTER_SNAP_LAYOUTS) for (let index = 0; index < preset.cells.length; index++) {
      const candidate = deriveCenterSplitSnapLayout(session('a'), current, source, { layoutId: preset.id, index });
      if (preset.cells.length === 2) expect(candidate).toBeNull();
      else {
        expect(candidate!.panes).toEqual([session('a'), session('b'), utility('nav:c')]);
        expect(candidate!.order[source]).toBe(index); expect(candidate!.focused).toBe(source);
      }
    }
  });
  it('keeps unoccupied physical positions before moving other content to its nearest free cell', () => {
    const current: CenterSplitPaneState = { open: true, secondary: session('b'), tertiary: session('c'), layoutId: 'focus', order: [2, 0, 1] };
    const candidate = deriveCenterSplitSnapLayout(session('a'), current, 0, { layoutId: 'focus', index: 0 })!;
    expect(candidate.order).toEqual([0, 2, 1]);
    expect(candidate.panes).toEqual([session('a'), session('b'), session('c')]);
    const thirds = { ...current, layoutId: 'thirds' as const, order: [0, 1, 2] };
    const crossing = deriveCenterSplitSnapLayout(session('a'), thirds, 0, { layoutId: 'thirds', index: 2 })!;
    expect(crossing.order).toEqual([2, 1, 0]);
    expect(deriveCenterSplitDockLayout(session('a'), thirds, 0, 'right')).toBeNull();
  });
  it('supports single-pane snapping, preserves empty original slots, and compacts an empty primary', () => {
    const single = { open: false, secondary: EMPTY, dir: 'row' as const, ratio: .65, selectionScope: 'a' };
    const first = deriveCenterSplitSnapLayout(session('a'), single, 0, { layoutId: 'focus', index: 2 })!;
    expect(first.panes).toEqual([session('a'), EMPTY, EMPTY]); expect(first.order[0]).toBe(2);
    expect(first.original).toEqual([session('a')]); expect(first.selectionScope).toBe('a');
    const emptyPrimary = { open: true, secondary: session('b'), tertiary: session('c'), layoutId: 'focus' as const, order: [1, 0, 2] };
    const next = deriveCenterSplitSnapLayout(EMPTY, emptyPrimary, 2, { layoutId: 'halves', index: 1 })!;
    expect(next.original).toEqual([EMPTY, session('b'), session('c')]);
    expect(next.panes).toEqual([session('b'), session('c')]); expect(next.focused).toBe(1); expect(next.order).toEqual([0, 1]);
  });
  it('normalized logical geometry honors order, legacy ratio, and the wide preset initial 2:1 split', () => {
    const current = { open: true, secondary: session('b'), dir: 'col' as const, ratio: .65 };
    expect(getCenterSplitPaneCells(current)).toEqual([{ x: 0, y: 0, width: 1, height: .65 }, { x: 0, y: .65, width: 1, height: .35 }]);
    const candidate = deriveCenterSplitSnapLayout(session('a'), current, 0, { layoutId: 'wide', index: 1 })!;
    expect(candidate.ratio).toBe(2 / 3);
    const snapped = { ...current, layoutId: candidate.layoutId, ratio: candidate.ratio, order: candidate.order };
    expect(getCenterSplitPaneCells(snapped)).toEqual([...CENTER_SNAP_LAYOUTS.find(item => item.id === 'wide')!.cells].reverse());
    expect(getCenterSplitPaneRefs(session('a'), { ...current, layoutId: 'thirds' })).toEqual([session('a'), session('b'), EMPTY]);
    expect(getCenterSplitPaneCells({ ...snapped, open: false })).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);
  });
  it('rejects empty sources, out-of-range targets and duplicate existing content without mutating input', () => {
    const current = { open: true, secondary: EMPTY };
    expect(deriveCenterSplitSnapLayout(session('a'), current, 1, { layoutId: 'halves', index: 0 })).toBeNull();
    expect(deriveCenterSplitSnapLayout(session('a'), current, 0, { layoutId: 'halves', index: 2 })).toBeNull();
    expect(deriveCenterSplitSnapLayout(session('a'), current, 0, null)).toBeNull();
    expect(deriveCenterSplitSnapLayout(session('a'), { open: true, secondary: session('a') }, 0, { layoutId: 'halves', index: 0 })).toBeNull();
  });
});

describe('sidebar incoming Windows Snap model', () => {
  it('adds a new sidebar source at every preset target while keeping the primary content', () => {
    const current: CenterSplitPaneState = { open: false, secondary: EMPTY, dir: 'row', ratio: .65, selectionScope: 'workspace-a' };
    for (const preset of CENTER_SNAP_LAYOUTS) for (let index = 0; index < preset.cells.length; index++) {
      const candidate = deriveCenterSplitIncomingSnapLayout(session('a'), current, utility('memory'), { layoutId: preset.id, index })!;
      expect(candidate.panes.filter(ref => ref.kind !== 'empty')).toEqual([session('a'), utility('memory')]);
      expect(candidate.panes[candidate.focused]).toEqual(utility('memory'));
      expect(candidate.order[candidate.focused]).toBe(index);
      expect(candidate.incoming).toEqual(utility('memory'));
      expect(candidate.original).toEqual([session('a')]); expect(candidate.selectionScope).toBe('workspace-a');
      expect(new Set(candidate.order).size).toBe(preset.cells.length);
    }
    expect(current).toEqual({ open: false, secondary: EMPTY, dir: 'row', ratio: .65, selectionScope: 'workspace-a' });
  });
  it('preserves both occupied panes when adding a third source and disables every two-cell preset', () => {
    const current: CenterSplitPaneState = { open: true, secondary: session('b'), dir: 'row', ratio: .65 };
    for (const preset of CENTER_SNAP_LAYOUTS) for (let index = 0; index < preset.cells.length; index++) {
      const candidate = deriveCenterSplitIncomingSnapLayout(session('a'), current, utility('nav:c'), { layoutId: preset.id, index });
      if (preset.cells.length === 2) expect(candidate).toBeNull();
      else {
        expect(candidate!.panes).toEqual([session('a'), session('b'), utility('nav:c')]);
        expect(candidate!.order[2]).toBe(index); expect(candidate!.focused).toBe(2);
      }
    }
  });
  it('deduplicates an already displayed source and rejects a fourth distinct content', () => {
    const current: CenterSplitPaneState = { open: true, secondary: session('b'), tertiary: session('c'), layoutId: 'thirds', order: [2, 0, 1] };
    for (const preset of CENTER_SNAP_LAYOUTS) for (let index = 0; index < preset.cells.length; index++) {
      expect(deriveCenterSplitIncomingSnapLayout(session('a'), current, session('d'), { layoutId: preset.id, index })).toBeNull();
      const candidate = deriveCenterSplitIncomingSnapLayout(session('a'), current, session('c'), { layoutId: preset.id, index });
      if (preset.cells.length === 2) expect(candidate).toBeNull();
      else {
        expect(candidate!.panes).toEqual([session('a'), session('b'), session('c')]);
        expect(candidate!.order[2]).toBe(index);
      }
    }
  });
  it('fills empty slots and compacts an empty primary without losing original snapshot geometry', () => {
    const current: CenterSplitPaneState = { open: true, secondary: session('b'), tertiary: EMPTY, layoutId: 'focus', order: [2, 0, 1], dir: 'row', ratio: .5 };
    const candidate = deriveCenterSplitIncomingSnapLayout(EMPTY, current, utility('memory'), { layoutId: 'focus', index: 2 })!;
    expect(candidate.panes).toEqual([session('b'), utility('memory'), EMPTY]); expect(candidate.focused).toBe(1);
    expect(candidate.order).toEqual([0, 2, 1]); expect(candidate.original).toEqual([EMPTY, session('b'), EMPTY]);
    expect(candidate.originalState).toEqual({ open: true, layoutId: 'focus', order: [2, 0, 1], dir: 'row', ratio: .5 });
    const first = deriveCenterSplitIncomingSnapLayout(EMPTY, { open: false, secondary: EMPTY }, session('c'), { layoutId: 'halves', index: 1 })!;
    expect(first.panes).toEqual([session('c'), EMPTY]); expect(first.order).toEqual([1, 0]);
  });
  it('rejects empty sources, absent targets, invalid target indexes and duplicated originals', () => {
    const current = { open: true, secondary: EMPTY };
    expect(deriveCenterSplitIncomingSnapLayout(session('a'), current, EMPTY, { layoutId: 'halves', index: 0 })).toBeNull();
    expect(deriveCenterSplitIncomingSnapLayout(session('a'), current, session('b'), null)).toBeNull();
    expect(deriveCenterSplitIncomingSnapLayout(session('a'), current, session('b'), { layoutId: 'halves', index: 2 })).toBeNull();
    expect(deriveCenterSplitIncomingSnapLayout(session('a'), { open: true, secondary: session('a') }, session('b'), { layoutId: 'thirds', index: 0 })).toBeNull();
  });
});
