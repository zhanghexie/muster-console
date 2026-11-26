import { useCallback, useEffect, useState } from 'react';
import type React from 'react';

/**
 * 扩展面板 AI 侧栏宽度：280–560px，localStorage 持久化；窄屏（≤760px，CSS 切换为
 * 上下布局）不用固定列宽。停靠方向由 DomainExtensionPanel 的四态布局选择（悬浮/嵌入 ×
 * 左/右）持有，本 hook 只管宽度。
 */
const STORAGE_KEY = 'ext-agent-sidebar-width';
export const AGENT_SIDEBAR_MIN = 280;
export const AGENT_SIDEBAR_MAX = 560;

function clampWidth(value: number): number {
  return Math.round(Math.min(AGENT_SIDEBAR_MAX, Math.max(AGENT_SIDEBAR_MIN, value)));
}

/** 侧栏宽度统一夹取（280–560），悬浮尺寸调节与停靠拖拽热区共用。 */
export function clampAgentSidebarWidth(value: number): number {
  return clampWidth(value);
}

function initialWidth(): number {
  const stored = Number(localStorage.getItem(STORAGE_KEY) ?? '');
  return Number.isFinite(stored) && stored >= AGENT_SIDEBAR_MIN ? clampWidth(stored) : 344;
}

function persistWidth(current: number): number {
  localStorage.setItem(STORAGE_KEY, String(current));
  return current;
}

function attachResize(handle: HTMLElement, event: React.PointerEvent, onMove: (moveEvent: PointerEvent) => void, onEnd: () => void, setResizing: (value: boolean) => void): void {
  event.preventDefault();
  handle.setPointerCapture?.(event.pointerId);
  setResizing(true);
  const end = (): void => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    setResizing(false);
    onEnd();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

export function useAgentSidebarWidth(layoutRef: React.RefObject<HTMLElement | null>): {
  width: number;
  narrow: boolean;
  resizing: boolean;
  columns: string | undefined;
  /** 扩展布局层拖拽热区：以 layout 右边为固定边。 */
  beginResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** 从对侧固定边起算的宽度：宽度 = |光标 − fixedX|，左右停靠通用。 */
  startResize: (event: React.PointerEvent<HTMLDivElement>, fixedX: number) => void;
} {
  const [width, setWidth] = useState(initialWidth);
  const [resizing, setResizing] = useState(false);
  const [narrow, setNarrow] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 760px)').matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 760px)');
    const onChange = (): void => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>, fixedX: number) => {
    attachResize(
      event.currentTarget,
      event,
      moveEvent => setWidth(clampWidth(Math.abs(moveEvent.clientX - fixedX))),
      () => setWidth(persistWidth),
      setResizing
    );
  }, []);
  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const layout = layoutRef.current;
    if (!layout) return;
    const right = layout.getBoundingClientRect().right;
    attachResize(
      event.currentTarget,
      event,
      moveEvent => setWidth(clampWidth(right - moveEvent.clientX)),
      () => setWidth(persistWidth),
      setResizing
    );
  }, [layoutRef]);
  return {
    width,
    narrow,
    resizing,
    columns: narrow ? undefined : `minmax(0, 1fr) ${width}px`,
    beginResize,
    startResize
  };
}

