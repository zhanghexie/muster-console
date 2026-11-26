import { useCallback, useEffect, useRef } from 'react';
import {
  moveListIndex,
  nextTreeIndexOnArrow,
  type TreeNavRow
} from '../../../shared/listTreeKeyboardNav';

/** 非活动行共享的静态 props（tabIndex -1、无 ref），配合缓存避免每 render 新对象 */
const inactiveItemProps: { tabIndex: 0 | -1; ref?: (el: HTMLElement | null) => void } = {
  tabIndex: -1
};

export function useTreeKeyboardNav(opts: {
  rows: TreeNavRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  disabled?: boolean;
}): {
  onTreeKeyDown: (e: React.KeyboardEvent) => void;
  getItemProps: (id: string) => {
    tabIndex: 0 | -1;
    ref?: (el: HTMLElement | null) => void;
  };
  activeId: string | null;
} {
  const { rows, selectedId, onSelect, onToggleExpand, disabled } = opts;
  const ids = rows.map((r) => r.id);
  const activeId = selectedId != null && ids.includes(selectedId) ? selectedId : null;
  const itemRef = useRef<HTMLElement | null>(null);

  // getItemProps 身份保持稳定 + 按 id 缓存返回对象：
  // 否则每次 render 新对象会击穿 memo 行组件（memo 比较 props 引用），
  // 焦点移动时也只会让新旧两个活动行拿到新 props。
  const activeIdRef = useRef<string | null>(activeId);
  const itemPropsCacheRef = useRef(new Map<string, { tabIndex: 0 | -1; ref?: (el: HTMLElement | null) => void }>());
  if (activeIdRef.current !== activeId) {
    activeIdRef.current = activeId;
    itemPropsCacheRef.current.clear();
  }

  useEffect(() => {
    itemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const onTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled || rows.length === 0) {
        return;
      }

      const cur = activeId != null ? ids.indexOf(activeId) : -1;

      if (
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'Home' ||
        e.key === 'End'
      ) {
        e.preventDefault();
        const next = moveListIndex(cur, e.key, ids.length);
        if (next < 0) {
          return;
        }
        onSelect(ids[next]);
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (cur < 0) {
          return;
        }
        e.preventDefault();
        const result = nextTreeIndexOnArrow(
          rows,
          cur,
          e.key as 'ArrowLeft' | 'ArrowRight'
        );
        // 源根行 id 是空字符串，不能用真值判断，否则左右键不会开合这两个文件夹
        if (result.toggleId !== undefined) {
          onToggleExpand(result.toggleId);
        }
        if (result.index !== cur && result.index >= 0) {
          onSelect(rows[result.index].id);
        }
      }
    },
    [disabled, rows, ids, activeId, onSelect, onToggleExpand]
  );

  const getItemProps = useCallback((id: string) => {
    const cache = itemPropsCacheRef.current;
    let props = cache.get(id);
    if (!props) {
      if (activeIdRef.current === id) {
        props = {
          tabIndex: 0,
          ref: (el: HTMLElement | null) => {
            if (activeIdRef.current === id) itemRef.current = el;
          }
        };
      } else {
        // 非活动行不需要 ref，全部共享同一个对象即可
        props = inactiveItemProps;
      }
      cache.set(id, props);
    }
    return props;
  }, []);

  return { onTreeKeyDown, getItemProps, activeId };
}
