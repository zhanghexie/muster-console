/**
 * 列表多选纯逻辑（文件管理器语义）：
 * Ctrl/⌘+点击切换单项、Shift+点击取锚点到点击项的可见行范围（Ctrl+Shift 并集）、
 * Shift+方向键扩展、Ctrl+A 全选；普通点击清空选区并把锚点移到点击行。
 * 状态由渲染层 hook 持有，这里只做无副作用计算，便于 test/*.mjs 直接覆盖。
 */

export type ListSelectionState = {
  ids: Set<string>;
  anchorId: string | null;
};

export type SelectionClickMode = 'plain' | 'toggle' | 'range';

export type SelectionModifiers = { ctrl: boolean; shift: boolean };

export const EMPTY_LIST_SELECTION: ListSelectionState = { ids: new Set(), anchorId: null };

/** [min(a,b), max(a,b)] 闭区间；任一端不在 orderedIds 时退化为 [toId] */
export function idRange(
  fromId: string,
  toId: string,
  orderedIds: readonly string[]
): string[] {
  const a = orderedIds.indexOf(fromId);
  const b = orderedIds.indexOf(toId);
  if (a < 0 || b < 0) return [toId];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return orderedIds.slice(lo, hi + 1);
}

/**
 * 行点击分流。返回 mode 供调用方决定是否执行原有主操作：
 * plain = 现状单选行为（选区已清空、锚点已移动）；toggle/range = 只改选区，主操作跳过。
 */
export function selectionClick(
  state: ListSelectionState,
  id: string,
  mods: SelectionModifiers,
  orderedIds: readonly string[]
): { state: ListSelectionState; mode: SelectionClickMode } {
  if (mods.ctrl && !mods.shift) {
    const ids = new Set(state.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { state: { ids, anchorId: id }, mode: 'toggle' };
  }
  if (mods.shift) {
    // 无锚点（首击）退化为单项；Ctrl+Shift 把范围并入现有选区
    if (state.anchorId == null) {
      const ids = mods.ctrl ? new Set([...state.ids, id]) : new Set([id]);
      return { state: { ids, anchorId: id }, mode: 'range' };
    }
    const range = idRange(state.anchorId, id, orderedIds);
    const ids = mods.ctrl ? new Set([...state.ids, ...range]) : new Set(range);
    return { state: { ids, anchorId: state.anchorId }, mode: 'range' };
  }
  return {
    state: { ids: new Set(), anchorId: id },
    mode: 'plain'
  };
}

/** Shift+方向键：焦点移到 targetId，选区=锚点到 target 的范围（additive 时并入） */
export function extendSelection(
  state: ListSelectionState,
  targetId: string,
  orderedIds: readonly string[],
  additive: boolean
): ListSelectionState {
  const anchorId = state.anchorId ?? targetId;
  const range = idRange(anchorId, targetId, orderedIds);
  const ids = additive ? new Set([...state.ids, ...range]) : new Set(range);
  return { ids, anchorId };
}

/** Ctrl+A：全选可见行；无锚点时锚点落在首行，让随后的 Shift+点击从顶部取范围 */
export function selectAll(
  state: ListSelectionState,
  orderedIds: readonly string[]
): ListSelectionState {
  return {
    ids: new Set(orderedIds),
    anchorId: state.anchorId ?? orderedIds[0] ?? null
  };
}

/** 数据变化（文件增删/标签关闭/折叠）后剪掉不可见/已消失的项；锚点失效置空 */
export function pruneSelection(
  state: ListSelectionState,
  validIds: ReadonlySet<string>
): ListSelectionState {
  let changed = false;
  const ids = new Set<string>();
  for (const id of state.ids) {
    if (validIds.has(id)) ids.add(id);
    else changed = true;
  }
  const anchorId = state.anchorId != null && validIds.has(state.anchorId) ? state.anchorId : null;
  if (!changed && anchorId === state.anchorId) return state;
  return { ids, anchorId };
}

/** 批量删除去重：祖先目录已选中时吸收其全部子路径（空串先被过滤，根不会入集） */
export function removeCoveredPaths(paths: readonly string[]): string[] {
  if (paths.length <= 1) return [...paths];
  const set = new Set(paths.map((p) => p.replace(/\\/g, '/')).filter(Boolean));
  const out: string[] = [];
  for (const p of set) {
    let covered = false;
    let idx = p.lastIndexOf('/');
    while (idx > 0) {
      if (set.has(p.slice(0, idx))) {
        covered = true;
        break;
      }
      idx = p.lastIndexOf('/', idx - 1);
    }
    if (!covered) out.push(p);
  }
  return out;
}
