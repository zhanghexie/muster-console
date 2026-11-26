import { useCallback, useEffect, useRef } from 'react';
import { moveListIndex } from '../../../shared/listTreeKeyboardNav';

export function useListKeyboardNav(opts: {
  items: string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  isItemDisabled?: (id: string) => boolean;
  /** Delay automatic reveal while a workspace transition is covering the list. */
  pauseReveal?: boolean;
}): {
  onListKeyDown: (e: React.KeyboardEvent) => void;
  getItemProps: (id: string) => {
    tabIndex: 0 | -1;
    ref?: (el: HTMLElement | null) => void;
  };
  activeId: string | null;
} {
  const { items, selectedId, onSelect, disabled, isItemDisabled, pauseReveal = false } = opts;
  const activeId = selectedId != null && items.includes(selectedId) ? selectedId : null;
  const itemRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (pauseReveal) return;
    itemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeId, pauseReveal]);

  const findEnabledFrom = useCallback(
    (start: number, direction: 1 | -1): number => {
      if (!isItemDisabled) {
        return start;
      }
      for (let i = start; i >= 0 && i < items.length; i += direction) {
        if (!isItemDisabled(items[i])) {
          return i;
        }
      }
      return -1;
    },
    [items, isItemDisabled]
  );

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled || items.length === 0) {
        return;
      }
      if (
        e.key !== 'ArrowUp' &&
        e.key !== 'ArrowDown' &&
        e.key !== 'Home' &&
        e.key !== 'End'
      ) {
        return;
      }
      e.preventDefault();
      const cur = activeId != null ? items.indexOf(activeId) : -1;
      let next = moveListIndex(cur, e.key, items.length);

      if (e.key === 'Home') {
        next = findEnabledFrom(0, 1);
      } else if (e.key === 'End') {
        next = findEnabledFrom(items.length - 1, -1);
      } else {
        const delta = e.key === 'ArrowUp' ? -1 : 1;
        while (next >= 0 && isItemDisabled?.(items[next])) {
          const n2 = moveListIndex(
            next,
            delta < 0 ? 'ArrowUp' : 'ArrowDown',
            items.length
          );
          if (n2 === next) {
            break;
          }
          next = n2;
        }
      }

      if (next < 0 || isItemDisabled?.(items[next])) {
        return;
      }
      onSelect(items[next]);
    },
    [disabled, items, activeId, onSelect, isItemDisabled, findEnabledFrom]
  );

  const getItemProps = useCallback(
    (id: string) => ({
      tabIndex: (activeId === id ? 0 : -1) as 0 | -1,
      ref: (el: HTMLElement | null) => {
        if (id === activeId) {
          itemRef.current = el;
        }
      }
    }),
    [activeId]
  );

  return { onListKeyDown, getItemProps, activeId };
}
