/**
 * 自由视图画布 · 度量层：会话/便签集合派生 + 卡片实测高度 + hOf/posOf/rectOf 几何存取。
 * 从 FreeCanvas.tsx 原样拆出；依赖关系：edits（noteEdit 抬高编辑中的卡）→ metrics。
 */
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { MutableRefObject } from 'react';
import {
  FREE_STICKY_H,
  nodeHeightOf,
  nodeRect,
  stickyRect,
  type FreePoint,
  type FreeRect,
  type FreeSticky
} from '../freeViewGeom';
import { readCanvasCardHeights } from './cardHeights';
import type { FreeCanvasItem } from './types';

export interface CanvasMetricsOptions {
  items: FreeCanvasItem[];
  stickies: FreeSticky[];
  /** 布局里的卡片备注（layout.notes ?? {}） */
  notes: Record<string, string>;
  /** 进行中的备注编辑（编辑中的卡按折行抬高） */
  noteEdit: { id: string; value: string } | null;
  /** 布局里的会话节点位置（layout.nodes） */
  nodes: Record<string, FreePoint>;
  /** 世界层容器 ref（实测高度从这里读） */
  worldRef: MutableRefObject<HTMLDivElement | null>;
  /** 视图是否在场（隐藏侧不实测，靠估算兜底） */
  active: boolean;
}

export function useCanvasMetrics(options: CanvasMetricsOptions): {
  itemIds: string[];
  stickyIds: string[];
  stickyById: Map<string, FreeSticky>;
  visibleIdSet: ReadonlySet<string>;
  sessionIdSet: ReadonlySet<string>;
  visibleKey: string;
  measuredH: Record<string, number>;
  heightById: Record<string, number>;
  hOf: (id: string) => number;
  posOf: (id: string) => FreePoint | undefined;
  rectOf: (id: string) => FreeRect | null;
} {
  const { items, stickies, notes, noteEdit, nodes, worldRef, active } = options;
  const [measuredH, setMeasuredH] = useState<Record<string, number>>({});

  const itemIds = useMemo(() => items.map((i) => i.id), [items]);
  const stickyIds = useMemo(() => stickies.map((s) => s.id), [stickies]);
  const stickyById = useMemo(() => new Map(stickies.map((s) => [s.id, s])), [stickies]);
  const visibleIdSet = useMemo(() => new Set([...itemIds, ...stickyIds]), [itemIds, stickyIds]);
  const sessionIdSet = useMemo(() => new Set(itemIds), [itemIds]);
  const visibleKey = useMemo(() => itemIds.join('\n'), [itemIds]);
  const heightById = useMemo(() => {
    const m: Record<string, number> = {};
    for (const item of items) {
      const note = noteEdit?.id === item.id ? noteEdit.value : notes[item.id];
      m[item.id] = nodeHeightOf(
        note,
        !!item.branch,
        noteEdit?.id === item.id,
        0
      );
    }
    return m;
  }, [items, notes, noteEdit]);
  useLayoutEffect(() => {
    const next = readCanvasCardHeights(worldRef.current);
    setMeasuredH((prev) => {
      let same = true;
      const ids = new Set([...Object.keys(prev), ...Object.keys(next)]);
      for (const id of ids) {
        if ((prev[id] ?? 0) !== (next[id] ?? 0)) {
          same = false;
          break;
        }
      }
      return same ? prev : next;
    });
  }, [items, notes, noteEdit, visibleKey, active, worldRef]);
  const hOf = useCallback(
    (id: string): number => {
      if (stickyById.has(id)) return FREE_STICKY_H;
      return measuredH[id] ?? heightById[id] ?? nodeHeightOf(notes[id]);
    },
    [measuredH, heightById, notes, stickyById]
  );
  const posOf = useCallback(
    (id: string): FreePoint | undefined => {
      const st = stickyById.get(id);
      if (st) return { x: st.x, y: st.y };
      return nodes[id];
    },
    [nodes, stickyById]
  );
  const rectOf = useCallback(
    (id: string): FreeRect | null => {
      const st = stickyById.get(id);
      if (st) return stickyRect(st);
      const p = nodes[id];
      return p ? nodeRect(p, hOf(id)) : null;
    },
    [nodes, stickyById, hOf]
  );

  return {
    itemIds,
    stickyIds,
    stickyById,
    visibleIdSet,
    sessionIdSet,
    visibleKey,
    measuredH,
    heightById,
    hOf,
    posOf,
    rectOf
  };
}
