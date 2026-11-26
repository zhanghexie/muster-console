/**
 * 中央区通用分屏：最多三槽的 Snap 布局候选与兼容的二叉树纯状态机。
 *
 * UI 使用最多三个固定内容槽及 Snap 预设；二叉树 API 保留给旧两侧入口。
 * 渲染层把 pane0 绑定为「当前选中内容」（displayActiveId 会话 / utilityPanel 工具层），
 * pane1/pane2 由 centerSplitStore 持有；各槽内容统称 SplitPaneRef。
 * 本文件不依赖渲染层，供组件与单测共用。
 */

export type SplitDir = 'row' | 'col';
export type CenterPaneSlot = 0 | 1 | 2;
export type CenterSnapLayoutId = 'halves' | 'wide' | 'stack' | 'focus' | 'focus-mirror' | 'thirds';
export type SnapLayoutId = CenterSnapLayoutId;
export interface CenterSnapCell { x: number; y: number; width: number; height: number }
export interface CenterSnapTarget { layoutId: CenterSnapLayoutId; index: number }
export const CENTER_SNAP_LAYOUTS: readonly { id: CenterSnapLayoutId; cells: readonly CenterSnapCell[] }[] = [
  { id: 'halves', cells: [{ x: 0, y: 0, width: .5, height: 1 }, { x: .5, y: 0, width: .5, height: 1 }] },
  { id: 'wide', cells: [{ x: 0, y: 0, width: 2 / 3, height: 1 }, { x: 2 / 3, y: 0, width: 1 / 3, height: 1 }] },
  { id: 'stack', cells: [{ x: 0, y: 0, width: 1, height: .5 }, { x: 0, y: .5, width: 1, height: .5 }] },
  { id: 'focus', cells: [{ x: 0, y: 0, width: .5, height: 1 }, { x: .5, y: 0, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 }] },
  { id: 'focus-mirror', cells: [{ x: 0, y: 0, width: .5, height: .5 }, { x: 0, y: .5, width: .5, height: .5 }, { x: .5, y: 0, width: .5, height: 1 }] },
  { id: 'thirds', cells: [{ x: 0, y: 0, width: 1 / 3, height: 1 }, { x: 1 / 3, y: 0, width: 1 / 3, height: 1 }, { x: 2 / 3, y: 0, width: 1 / 3, height: 1 }] }
];

/** 新内容落点（相对现有内容） */
export type SplitSide = 'left' | 'right' | 'top' | 'bottom';

/** pane 内容引用：会话 / 实用工具与导航（UtilitySelection 字面量）/ 空选择器 */
export type SplitPaneRef =
  | { kind: 'session'; sessionId: string }
  | { kind: 'utility'; sel: string }
  | { kind: 'empty' };

export type RightSplitRef = { kind: 'tab'; tabId: string };
export type SnapPaneRef = SplitPaneRef | RightSplitRef;
type EmptyPaneRef = Extract<SplitPaneRef, { kind: 'empty' }>;

/** 二叉 split 树节点：split=分组，pane=内容引用 */
export type SplitNode =
  | { type: 'pane'; ref: SplitPaneRef }
  | { type: 'split'; dir: SplitDir; ratio: number; children: [SplitNode, SplitNode] };

export const SPLIT_RATIO_MIN = 0.2;
export const SPLIT_RATIO_MAX = 0.8;
/** 窄屏降级阈值（中央区像素宽）：低于则临时回单栏 */
export const SPLIT_NARROW_PX = 560;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

export function samePaneRef(a: SnapPaneRef, b: SnapPaneRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId;
  if (a.kind === 'utility' && b.kind === 'utility') return a.sel === b.sel;
  if (a.kind === 'tab' && b.kind === 'tab') return a.tabId === b.tabId;
  return a.kind === 'empty' && b.kind === 'empty';
}

export interface CenterSplitPaneState<Ref extends SnapPaneRef = SplitPaneRef> {
  open: boolean;
  secondary: Ref;
  tertiary?: Ref;
  dir?: SplitDir;
  ratio?: number;
  /** Physical divider coordinates for three-pane layouts (x/x for thirds, x/y for focus). */
  ratios?: [number, number];
  layoutId?: CenterSnapLayoutId;
  /** Logical binding index -> physical layout cell index. */
  order?: number[];
  /** Workspace scope captured with this state, never read from a newer bridge at commit. */
  selectionScope?: string | null;
}
export function getCenterSplitPaneRefs(primary: SplitPaneRef, state: CenterSplitPaneState): SplitPaneRef[] {
  if (!state.open) return [primary];
  const capacity = CENTER_SNAP_LAYOUTS.find(item => item.id === state.layoutId)?.cells.length ?? (state.tertiary ? 3 : 2);
  return capacity === 3 ? [primary, state.secondary, state.tertiary ?? { kind: 'empty' }] : [primary, state.secondary];
}
function paneOrder(state: CenterSplitPaneState<SnapPaneRef>, count: number): number[] {
  const order = state.order;
  return order?.length === count && order.every((value, index) => Number.isInteger(value) && value >= 0 && value < count && order.indexOf(value) === index)
    ? [...order] : Array.from({ length: count }, (_, index) => index);
}
/** Normalized geometry for each logical binding; closed state is one full rectangle. */
export function getCenterSplitPaneCells(state: CenterSplitPaneState<SnapPaneRef>): CenterSnapCell[] {
  if (!state.open) return [{ x: 0, y: 0, width: 1, height: 1 }];
  const preset = CENTER_SNAP_LAYOUTS.find(item => item.id === state.layoutId);
  const ratio = clampRatio(state.ratio ?? .5);
  let cells = preset?.cells ?? (state.tertiary ? CENTER_SNAP_LAYOUTS.find(item => item.id === 'thirds')!.cells
    : state.dir === 'col'
      ? [{ x: 0, y: 0, width: 1, height: ratio }, { x: 0, y: ratio, width: 1, height: 1 - ratio }]
      : [{ x: 0, y: 0, width: ratio, height: 1 }, { x: ratio, y: 0, width: 1 - ratio, height: 1 }]);
  if (cells.length === 3 && state.ratios) {
    const [a, b] = getCenterSplitRatios(state);
    cells = state.layoutId === 'focus'
      ? [{ x: 0, y: 0, width: a, height: 1 }, { x: a, y: 0, width: 1 - a, height: b }, { x: a, y: b, width: 1 - a, height: 1 - b }]
      : state.layoutId === 'focus-mirror'
        ? [{ x: 0, y: 0, width: a, height: b }, { x: 0, y: b, width: a, height: 1 - b }, { x: a, y: 0, width: 1 - a, height: 1 }]
        : [{ x: 0, y: 0, width: a, height: 1 }, { x: a, y: 0, width: b - a, height: 1 }, { x: b, y: 0, width: 1 - b, height: 1 }];
  }
  return paneOrder(state, cells.length).map(index => ({ ...cells[index] }));
}
export function getCenterSplitRatios(state: CenterSplitPaneState<SnapPaneRef>): [number, number] {
  if (state.layoutId === 'focus' || state.layoutId === 'focus-mirror') return [clampRatio(state.ratios?.[0] ?? .5), clampRatio(state.ratios?.[1] ?? .5)];
  const a = Math.min(.6, Math.max(.2, Number.isFinite(state.ratios?.[0]) ? state.ratios![0] : 1 / 3));
  const b = Math.min(.8, Math.max(a + .2, Number.isFinite(state.ratios?.[1]) ? state.ratios![1] : 2 / 3));
  return [a, b];
}
export interface CenterSplitDivider {
  index: 0 | 1;
  dir: SplitDir;
  ratio: number;
  min: number;
  max: number;
  x: number; y: number; width: number; height: number;
}
/** Physical boundaries are independent of the logical content order. */
export function getCenterSplitDividers(state: CenterSplitPaneState<SnapPaneRef>): CenterSplitDivider[] {
  const cells = getCenterSplitPaneCells(state);
  if (cells.length < 2) return [];
  if (cells.length === 2) {
    const col = state.layoutId === 'stack' || (!state.layoutId && state.dir === 'col');
    const cut = col ? Math.max(...cells.map(cell => cell.y)) : Math.max(...cells.map(cell => cell.x));
    return [{ index: 0, dir: col ? 'col' : 'row', ratio: cut, min: .2, max: .8,
      x: col ? 0 : cut, y: col ? cut : 0, width: col ? 1 : 0, height: col ? 0 : 1 }];
  }
  const [a, b] = getCenterSplitRatios(state);
  if (state.layoutId === 'focus' || state.layoutId === 'focus-mirror') return [
    { index: 0, dir: 'row', ratio: a, min: .2, max: .8, x: a, y: 0, width: 0, height: 1 },
    { index: 1, dir: 'col', ratio: b, min: .2, max: .8, x: state.layoutId === 'focus' ? a : 0, y: b,
      width: state.layoutId === 'focus' ? 1 - a : a, height: 0 }
  ];
  return [
    { index: 0, dir: 'row', ratio: a, min: .2, max: b - .2, x: a, y: 0, width: 0, height: 1 },
    { index: 1, dir: 'row', ratio: b, min: a + .2, max: .8, x: b, y: 0, width: 0, height: 1 }
  ];
}
export interface CenterSplitPresentationLayout<Ref extends SnapPaneRef = SplitPaneRef> {
  pane0: Ref;
  pane1: Ref;
  pane2?: Ref;
  dir: SplitDir;
  ratio: number;
  ratios?: [number, number];
  focused: CenterPaneSlot;
  layoutId?: CenterSnapLayoutId;
  panes?: Ref[];
  order?: number[];
}
export interface CenterSplitSnapLayout<Ref extends SnapPaneRef = SplitPaneRef> extends CenterSplitPresentationLayout<Ref> {
  layoutId: CenterSnapLayoutId;
  panes: Ref[];
  order: number[];
  /** All original logical bindings, including empty selectors. */
  original: Ref[];
  originalState: { open: boolean; dir: SplitDir; ratio: number; ratios?: [number, number]; layoutId?: CenterSnapLayoutId; order: number[] };
  selectionScope?: string | null;
}
export interface CenterSplitIncomingSnapLayout extends CenterSplitSnapLayout {
  /** The native sidebar payload, which may already be displayed in an original slot. */
  incoming: SplitPaneRef;
}
/** Preserve every displayed content instance; insufficient-capacity presets have no candidate. */
export function deriveCenterSplitSnapLayout(
  primary: SplitPaneRef, state: CenterSplitPaneState, sourceSlot: CenterPaneSlot, target: CenterSnapTarget | null
): CenterSplitSnapLayout | null {
  const original = getCenterSplitPaneRefs(primary, state);
  const source = original[sourceSlot];
  return deriveSnapLayout(state, original, source, target);
}
/** Native sidebar sources use the same Snap targets without replacing displayed content. */
export function deriveCenterSplitIncomingSnapLayout(
  primary: SplitPaneRef, state: CenterSplitPaneState, incoming: SplitPaneRef, target: CenterSnapTarget | null
): CenterSplitIncomingSnapLayout | null {
  if (incoming.kind === 'empty') return null;
  const layout = deriveSnapLayout(state, getCenterSplitPaneRefs(primary, state), incoming, target, true);
  return layout ? { ...layout, incoming: { ...incoming } } : null;
}
export function deriveSnapLayout<Ref extends SnapPaneRef>(
  state: CenterSplitPaneState<Ref>, original: (Ref | EmptyPaneRef)[], source: Ref | EmptyPaneRef | undefined,
  target: CenterSnapTarget | null, allowIncoming = false
): CenterSplitSnapLayout<Ref | EmptyPaneRef> | null {
  const preset = CENTER_SNAP_LAYOUTS.find(item => item.id === target?.layoutId);
  if (!target || !preset || !Number.isInteger(target.index) || target.index < 0 || target.index >= preset.cells.length || !source || source.kind === 'empty') return null;
  const panes: (Ref | EmptyPaneRef)[] = original.filter(ref => ref.kind !== 'empty');
  if (allowIncoming && !panes.some(ref => samePaneRef(ref, source))) panes.push({ ...source });
  if (panes.length > preset.cells.length || panes.some((ref, index) => panes.slice(0, index).some(other => samePaneRef(ref, other)))) return null;
  const sourceIndex = panes.findIndex(ref => samePaneRef(ref, source));
  const oldCells = getCenterSplitPaneCells(state);
  const oldOrder = paneOrder(state, original.length);
  const order = panes.map(() => -1); order[sourceIndex] = target.index;
  const otherIndices = panes.map((_, index) => index).filter(index => index !== sourceIndex);
  const available = preset.cells.map((_, index) => index).filter(index => index !== target.index);
  let bestCost = Infinity, best: number[] = [];
  const visit = (picked: number[], remaining: number[]) => {
    if (picked.length === otherIndices.length) {
      const cost = picked.reduce((sum, cellIndex, index) => {
        const originalIndex = original.findIndex(ref => samePaneRef(ref, panes[otherIndices[index]]));
        const before = oldCells[originalIndex], after = preset.cells[cellIndex];
        return sum + (before.x + before.width / 2 - after.x - after.width / 2) ** 2 +
          (before.y + before.height / 2 - after.y - after.height / 2) ** 2 +
          (state.layoutId === target.layoutId && available.includes(oldOrder[originalIndex]) && oldOrder[originalIndex] !== cellIndex ? 10 : 0) +
          (oldOrder[originalIndex] === cellIndex ? 0 : .000001);
      }, 0);
      if (cost < bestCost) { bestCost = cost; best = picked; }
      return;
    }
    for (const cell of remaining) visit([...picked, cell], remaining.filter(value => value !== cell));
  };
  visit([], available);
  otherIndices.forEach((index, offset) => { order[index] = best[offset]; });
  for (const cell of available.filter(index => !order.includes(index))) { panes.push({ kind: 'empty' }); order.push(cell); }
  const dir = target.layoutId === 'stack' ? 'col' : 'row';
  const ratio = target.layoutId === 'wide' ? 2 / 3 : .5;
  return { layoutId: target.layoutId, panes, order, focused: sourceIndex as CenterPaneSlot,
    pane0: panes[0], pane1: panes[1], ...(panes.length === 3 ? { pane2: panes[2] } : {}), dir, ratio,
    original: original.map(ref => ({ ...ref })), selectionScope: state.selectionScope,
    originalState: { open: state.open, dir: state.dir ?? 'row', ratio: state.ratio ?? .5,
      layoutId: state.layoutId, order: oldOrder, ...(state.ratios ? { ratios: [...state.ratios] as [number, number] } : {}) } };
}

/** side → {dir, 落在哪个槽位}：left/top=槽0，right/bottom=槽1 */
export function sideToSlot(side: SplitSide): { dir: SplitDir; slot: 0 | 1 } {
  if (side === 'left' || side === 'right') return { dir: 'row', slot: side === 'left' ? 0 : 1 };
  return { dir: 'col', slot: side === 'top' ? 0 : 1 };
}

/** 两侧最终落位结果；pane0 仍由 App 选中提供，候选不另持有主选中状态。 */
export interface CenterSplitDockLayout {
  pane0: SplitPaneRef;
  pane1: SplitPaneRef;
  dir: SplitDir;
  ratio: number;
  focused: 0 | 1;
}

/** 已有两侧内容的边缘停靠：预览与提交共用同一候选，中央与空侧不产生布局。 */
export function deriveCenterSplitDockLayout(
  primary: SplitPaneRef,
  current: CenterSplitPaneState,
  sourceSlot: CenterPaneSlot,
  side: SplitSide | null
): CenterSplitDockLayout | null {
  if (!side || !current.open || sourceSlot === 2 || getCenterSplitPaneRefs(primary, current).length !== 2 || primary.kind === 'empty' || current.secondary.kind === 'empty' ||
      samePaneRef(primary, current.secondary)) return null;
  const source = sourceSlot === 0 ? primary : current.secondary;
  const other = sourceSlot === 0 ? current.secondary : primary;
  const { dir, slot } = sideToSlot(side);
  return { pane0: slot === 0 ? source : other, pane1: slot === 0 ? other : source,
    dir, ratio: 0.5, focused: slot };
}

/** 工作面四边停靠区域（24–56px）；中央和工作面外均取消，角落取最近边。 */
export function splitDockSideFromPoint(x: number, y: number, width: number, height: number): SplitSide | null {
  if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height) ||
      !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x > width || y > height) return null;
  const edgeX = Math.min(56, Math.max(24, width * 0.12));
  const edgeY = Math.min(56, Math.max(24, height * 0.12));
  const edges: [SplitSide, number][] = [
    ['left', x / edgeX], ['right', (width - x) / edgeX],
    ['top', y / edgeY], ['bottom', (height - y) / edgeY]
  ];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0][1] <= 1 ? edges[0][0] : null;
}

/**
 * 把新内容按 side 放进现有布局（纯函数）：
 * - 现有无内容（null）→ 新内容直接成为唯一 pane（不构成 split）；
 * - 现有是单 pane → split(dir)[existing, incoming] 或 [incoming, existing]；
 * - 现有已是 split（V1 只有一层）→ 新内容替换 side 对应槽位的 pane，另一侧保留。
 */
export function insertPane(
  root: SplitNode | null,
  incoming: SplitPaneRef,
  side: SplitSide,
  ratio = 0.5
): SplitNode {
  const { dir, slot } = sideToSlot(side);
  if (!root) return { type: 'pane', ref: incoming };
  if (root.type === 'pane') {
    if (samePaneRef(root.ref, incoming)) return root;
    if (root.ref.kind === 'empty') return { type: 'pane', ref: incoming };
    const pair: [SplitNode, SplitNode] =
      slot === 0
        ? [{ type: 'pane', ref: incoming }, root]
        : [root, { type: 'pane', ref: incoming }];
    return { type: 'split', dir, ratio: clampRatio(ratio), children: pair };
  }
  const refs = splitSlots(root);
  if (refs && samePaneRef(refs[0], refs[1]) && refs[0].kind !== 'empty') {
    return insertPane({ type: 'pane', ref: refs[0] }, incoming, side, ratio);
  }
  const children: [SplitNode, SplitNode] = [...root.children] as [SplitNode, SplitNode];
  const opposite = slot === 0 ? 1 : 0;
  if (refs && incoming.kind !== 'empty' && samePaneRef(refs[opposite], incoming)) {
    children[slot] = root.children[opposite];
    children[opposite] = root.children[slot];
  } else children[slot] = { type: 'pane', ref: incoming };
  // 方向变了就整体换向（一层分屏下内容都在，只是重排）
  return { type: 'split', dir, ratio: clampRatio(root.ratio), children };
}

/** 替换指定槽位内容（一层分屏；槽越界忽略） */
export function replaceSlot(root: SplitNode, slot: 0 | 1, ref: SplitPaneRef): SplitNode {
  if (root.type !== 'split') return root;
  const children: [SplitNode, SplitNode] = [...root.children] as [SplitNode, SplitNode];
  const refs = splitSlots(root), opposite = slot === 0 ? 1 : 0;
  if (refs && ref.kind !== 'empty' && samePaneRef(refs[opposite], ref)) {
    children[slot] = root.children[opposite];
    children[opposite] = root.children[slot];
  } else children[slot] = { type: 'pane', ref };
  return { ...root, children };
}

/** 交换两侧（一层） */
export function swapSlots(root: SplitNode): SplitNode {
  if (root.type !== 'split') return root;
  const [a, b] = root.children;
  return { ...root, children: [b, a] };
}

/** 换向（左右↔上下），比例与内容不动 */
export function flipDir(root: SplitNode): SplitNode {
  if (root.type !== 'split') return root;
  return { ...root, dir: root.dir === 'row' ? 'col' : 'row' };
}

export function setTreeRatio(root: SplitNode, ratio: number): SplitNode {
  if (root.type !== 'split') return root;
  return { ...root, ratio: clampRatio(ratio) };
}

/** 解散：保留 keep 槽位内容成为唯一 pane */
export function dissolveKeep(root: SplitNode, keep: 0 | 1): SplitNode {
  if (root.type !== 'split') return root;
  return root.children[keep];
}

/** 一层分屏的两侧内容引用（非 split 树返回 null） */
export function splitSlots(root: SplitNode | null): [SplitPaneRef, SplitPaneRef] | null {
  if (!root || root.type !== 'split') return null;
  const [a, b] = root.children;
  if (a.type !== 'pane' || b.type !== 'pane') return null;
  return [a.ref, b.ref];
}

/** 会话关闭/归档等失源清理：把失效引用降为 empty（保持布局） */
export function pruneTree(root: SplitNode, alive: (ref: SplitPaneRef) => boolean): SplitNode {
  if (root.type === 'pane') return { type: 'pane', ref: alive(root.ref) ? root.ref : { kind: 'empty' } };
  return {
    ...root,
    children: [
      pruneTree(root.children[0], alive),
      pruneTree(root.children[1], alive)
    ] as [SplitNode, SplitNode]
  };
}

/** 拖拽落点分区：相对容器中心，横向偏移大→左右，否则上下 */
export function dropZoneFromPoint(
  x: number,
  y: number,
  width: number,
  height: number
): SplitSide {
  const dx = width > 0 ? x / width - 0.5 : 0;
  const dy = height > 0 ? y / height - 0.5 : 0;
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom';
}

/** 矩形相交（像素，含边界相接不算） */
export function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}

/** 拖拽负载（LeftPanel/导航树 → 中央区）的 dataTransfer mime */
export const SPLIT_DRAG_MIME = 'application/x-muster-pane';

export function encodeSplitDragPayload(ref: SplitPaneRef): string {
  return JSON.stringify(ref);
}

/** 解析拖拽负载；不合法返回 null（不抛） */
export function decodeSplitDragPayload(raw: unknown): SplitPaneRef | null {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const ref = parsed as Record<string, unknown>;
  if (ref.kind === 'session' && typeof ref.sessionId === 'string' && ref.sessionId) {
    return { kind: 'session', sessionId: ref.sessionId };
  }
  if (ref.kind === 'utility' && typeof ref.sel === 'string' && ref.sel) {
    return { kind: 'utility', sel: ref.sel };
  }
  if (ref.kind === 'empty') return { kind: 'empty' };
  return null;
}
