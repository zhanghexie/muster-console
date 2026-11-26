/**
 * 列表多选 hook（文件管理器语义，纯逻辑在 shared/listSelection.ts）：
 * 行点击经 click(id, e) 分流——返回 plain 时调用方执行原有主操作，
 * toggle/range 只改选区；容器键盘经 handleKeyDown 挂 Ctrl+A / Esc / Shift+方向键。
 * 回调用 ref 取最新状态，保证传给 memo 行组件的函数身份稳定。
 * 选区随 orderedIds 变化自动剪枝（折叠/删除/关闭后不可见的项被移除）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_LIST_SELECTION,
  extendSelection,
  pruneSelection,
  selectAll,
  selectionClick,
  type ListSelectionState,
  type SelectionClickMode
} from '../../../shared/listSelection';
import { moveListIndex } from '../../../shared/listTreeKeyboardNav';

type ModifierSource = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

export function useListSelection(opts: {
  /** 可见行 id（选择与范围序都基于它；不想参与选择的行不要放进来，锚点指向表外 id 时范围退化为单项） */
  orderedIds: readonly string[];
  /** Shift+方向键扩展的轴：树/列表默认 vertical，横向标签条用 horizontal */
  axis?: 'vertical' | 'horizontal';
}): {
  selectedIds: ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  click: (id: string, e: ModifierSource) => SelectionClickMode;
  clear: () => void;
  handleKeyDown: (
    e: React.KeyboardEvent,
    focus: { currentId: string | null; onMoveFocus: (id: string) => void }
  ) => boolean;
} {
  const { orderedIds, axis = 'vertical' } = opts;

  const [state, setState] = useState<ListSelectionState>(EMPTY_LIST_SELECTION);
  const stateRef = useRef(state);
  const orderedRef = useRef(orderedIds);
  orderedRef.current = orderedIds;

  const apply = useCallback((next: ListSelectionState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  // 数据/可见行变化 → 剪掉消失项（同引用返回时 React 跳过渲染）
  useEffect(() => {
    apply(pruneSelection(stateRef.current, new Set(orderedIds)));
  }, [orderedIds, apply]);

  const click = useCallback((id: string, e: ModifierSource): SelectionClickMode => {
    const { state: next, mode } = selectionClick(
      stateRef.current,
      id,
      { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey },
      orderedRef.current
    );
    apply(next);
    return mode;
  }, [apply]);

  const clear = useCallback((): void => {
    apply(EMPTY_LIST_SELECTION);
  }, [apply]);

  const isSelected = useCallback((id: string): boolean => stateRef.current.ids.has(id), []);

  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent,
      focus: { currentId: string | null; onMoveFocus: (id: string) => void }
    ): boolean => {
      const ids = orderedRef.current;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        if (ids.length === 0) return false;
        e.preventDefault();
        apply(selectAll(stateRef.current, ids));
        return true;
      }
      if (e.key === 'Escape') {
        if (stateRef.current.ids.size === 0) return false;
        e.preventDefault();
        e.stopPropagation();
        apply(EMPTY_LIST_SELECTION);
        return true;
      }
      if (!e.shiftKey) return false;
      const navKey =
        axis === 'horizontal'
          ? e.key === 'ArrowLeft'
            ? 'ArrowUp'
            : e.key === 'ArrowRight'
              ? 'ArrowDown'
              : e.key
          : e.key;
      if (navKey !== 'ArrowUp' && navKey !== 'ArrowDown' && navKey !== 'Home' && navKey !== 'End') {
        return false;
      }
      const cur = focus.currentId != null ? ids.indexOf(focus.currentId) : -1;
      const next = moveListIndex(cur, navKey, ids.length);
      if (next < 0) return false;
      e.preventDefault();
      focus.onMoveFocus(ids[next]);
      apply(
        extendSelection(stateRef.current, ids[next], ids, e.ctrlKey || e.metaKey)
      );
      return true;
    },
    [axis, apply]
  );

  return { selectedIds: state.ids, isSelected, click, clear, handleKeyDown };
}
