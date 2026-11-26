import { useCallback, useEffect, useRef, useState } from 'react';

/** 悬停展开延迟：防列表快速划过误开 */
export const HOVER_PIN_OPEN_MS = 400;
/** 离开宽限：按钮与 portal 菜单之间有空隙，给指针一段穿越时间 */
export const HOVER_PIN_LEAVE_MS = 120;

export type HoverPinHold = 'hover' | 'fixed';

export type HoverPinEntry<T> = {
  hold: HoverPinHold;
  data: T;
};

/** 触屏 / 无 hover 指针回落为纯点击（不排期悬停展开） */
export function prefersHoverPreview(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );
}

/**
 * 悬停预览 + 点击固定的菜单状态机。
 * - hover：延迟展开，指针离开触发器∪浮层后收起
 * - fixed：点击/右键打开，离开不关；再点同一目标切换收起
 * 定时器均可清理：快速划过不展开。
 */
export function useHoverPinMenu<T>(
  sameTarget: (a: T, b: T) => boolean = Object.is,
  canHover: () => boolean = prefersHoverPreview
): {
  entry: HoverPinEntry<T> | null;
  open: boolean;
  hold: HoverPinHold | null;
  data: T | null;
  onTriggerEnter: (data: T) => void;
  onTriggerLeave: () => void;
  onSurfaceEnter: () => void;
  onSurfaceLeave: () => void;
  onTriggerClick: (data: T) => void;
  openFixed: (data: T) => void;
  close: () => void;
} {
  const [entry, setEntry] = useState<HoverPinEntry<T> | null>(null);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const sameRef = useRef(sameTarget);
  sameRef.current = sameTarget;
  const canHoverRef = useRef(canHover);
  canHoverRef.current = canHover;
  const openTimerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<T | null>(null);

  const clearOpenTimer = useCallback((): void => {
    if (openTimerRef.current != null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  const clearLeaveTimer = useCallback((): void => {
    if (leaveTimerRef.current != null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const clearTimers = useCallback((): void => {
    clearOpenTimer();
    clearLeaveTimer();
  }, [clearLeaveTimer, clearOpenTimer]);

  const close = useCallback((): void => {
    clearTimers();
    setEntry(null);
  }, [clearTimers]);

  const openFixed = useCallback(
    (data: T): void => {
      clearTimers();
      setEntry({ hold: 'fixed', data });
    },
    [clearTimers]
  );

  const scheduleLeaveClose = useCallback((): void => {
    clearOpenTimer();
    if (entryRef.current?.hold !== 'hover') return;
    clearLeaveTimer();
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      if (entryRef.current?.hold === 'hover') setEntry(null);
    }, HOVER_PIN_LEAVE_MS);
  }, [clearLeaveTimer, clearOpenTimer]);

  const onTriggerEnter = useCallback(
    (data: T): void => {
      clearLeaveTimer();
      if (!canHoverRef.current()) return;
      const cur = entryRef.current;
      if (cur?.hold === 'fixed') return;
      if (cur && sameRef.current(cur.data, data)) return;
      if (cur?.hold === 'hover') {
        clearOpenTimer();
        setEntry({ hold: 'hover', data });
        return;
      }
      clearOpenTimer();
      pendingRef.current = data;
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null;
        const next = pendingRef.current;
        pendingRef.current = null;
        if (!next || entryRef.current?.hold === 'fixed') return;
        setEntry({ hold: 'hover', data: next });
      }, HOVER_PIN_OPEN_MS);
    },
    [clearLeaveTimer, clearOpenTimer]
  );

  const onTriggerLeave = useCallback((): void => {
    scheduleLeaveClose();
  }, [scheduleLeaveClose]);

  const onSurfaceEnter = useCallback((): void => {
    clearLeaveTimer();
  }, [clearLeaveTimer]);

  const onSurfaceLeave = useCallback((): void => {
    scheduleLeaveClose();
  }, [scheduleLeaveClose]);

  const onTriggerClick = useCallback(
    (data: T): void => {
      clearTimers();
      setEntry((cur) => {
        if (cur?.hold === 'fixed' && sameRef.current(cur.data, data)) return null;
        return { hold: 'fixed', data };
      });
    },
    [clearTimers]
  );

  useEffect(() => () => clearTimers(), [clearTimers]);

  return {
    entry,
    open: entry != null,
    hold: entry?.hold ?? null,
    data: entry?.data ?? null,
    onTriggerEnter,
    onTriggerLeave,
    onSurfaceEnter,
    onSurfaceLeave,
    onTriggerClick,
    openFixed,
    close
  };
}
