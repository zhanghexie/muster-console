/**
 * 自由视图画布 · 相机：屏幕↔世界坐标换算、以光标为中心缩放、适配取景、滚轮缩放。
 * 滚轮用 native 监听（passive:false 才能 preventDefault），active 为假时停用。
 * 从 FreeCanvas.tsx 原样拆出；缩放/平移的写盘口径不变。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { getFreeViewLayout, updateFreeViewLayout } from '../freeViewStore';
import { bboxOf, clampZoom, fitToRect, nodeRect, stickyRect, type FreePoint, type FreeSticky } from '../freeViewGeom';
import type { FreeCanvasItem } from './types';

export interface CanvasCameraOptions {
  /** 视图当前是否在场（xfade 隐藏侧停用滚轮） */
  active: boolean;
  /** 可见会话节点（fit 视野用） */
  items: FreeCanvasItem[];
  /** 常驻渲染的便签（fit 视野用） */
  stickies: FreeSticky[];
  hOf: (id: string) => number;
  /** fitView 顺手清掉连线选集（与拆分前同一行为） */
  setSelEdges: Dispatch<SetStateAction<string[]>>;
}

export function useCanvasCamera(options: CanvasCameraOptions): {
  vpRef: MutableRefObject<HTMLDivElement | null>;
  toWorld: (sx: number, sy: number) => FreePoint;
  localPoint: (e: { clientX: number; clientY: number }) => FreePoint;
  zoomAt: (cx: number, cy: number, factor: number) => void;
  fitView: () => void;
} {
  const { active, items, stickies, hOf, setSelEdges } = options;
  const vpRef = useRef<HTMLDivElement>(null);

  const toWorld = useCallback(
    (sx: number, sy: number): FreePoint => {
      const l = getFreeViewLayout();
      return { x: (sx - l.pan.x) / l.zoom, y: (sy - l.pan.y) / l.zoom };
    },
    []
  );

  const localPoint = useCallback((e: { clientX: number; clientY: number }): FreePoint => {
    const r = vpRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }, []);

  const zoomAt = useCallback((cx: number, cy: number, factor: number): void => {
    updateFreeViewLayout((l) => {
      const z1 = clampZoom(l.zoom * factor);
      const wx = (cx - l.pan.x) / l.zoom;
      const wy = (cy - l.pan.y) / l.zoom;
      return { ...l, zoom: z1, pan: { x: cx - wx * z1, y: cy - wy * z1 } };
    });
  }, []);

  const fitView = useCallback((): void => {
    const el = vpRef.current;
    if (!el) return;
    const l = getFreeViewLayout();
    const visibleRects = [
      ...items.flatMap((i) => {
        const p = l.nodes[i.id];
        return p ? [nodeRect(p, hOf(i.id))] : [];
      }),
      ...(l.stickies ?? []).map((s) => stickyRect(s))
    ];
    const box = bboxOf(visibleRects);
    const f = box
      ? fitToRect(box, el.clientWidth, el.clientHeight)
      : { pan: { x: el.clientWidth / 2, y: el.clientHeight / 2 }, zoom: 1 };
    updateFreeViewLayout((x) => ({ ...x, ...f }));
    setSelEdges([]);
  }, [items, hOf, stickies, setSelEdges]);

  // ---------- 滚轮缩放（native 监听才能 preventDefault） ----------

  useEffect(() => {
    if (!active) return;
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0016);
      zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [active, zoomAt]);

  return { vpRef, toWorld, localPoint, zoomAt, fitView };
}
