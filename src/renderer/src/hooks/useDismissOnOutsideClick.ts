import { useEffect, useRef, type RefObject } from 'react';

/**
 * 点浮层外部关闭（mousedown：先于 click，切换按钮的点击不会被先关再开）。
 * open=false 不挂监听；close 经 ref 取用，调用方传内联箭头也不会造成重复挂/卸。
 * ref 可传数组（浮层与触发器不在同一 DOM 子树时，如 portal 进宿主容器的面板）。
 */
export function useDismissOnOutsideClick(
  open: boolean,
  ref: RefObject<Element | null> | Array<RefObject<Element | null>>,
  close: () => void
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      const refs = Array.isArray(ref) ? ref : [ref];
      const inside = refs.some((r) => r.current?.contains(e.target as Node));
      if (!inside) closeRef.current();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
    // ref(s) 是 useRef 产物恒稳定；close 走 ref，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref]);
}
