/**
 * 自由视图画布 · 会话集同步：自动补位 / 修剪（含连线与分组成员）；首次从空到有自动适配取景。
 * 修剪口径是 aliveIds（全量未归档），不是当前过滤后的 items——过滤不得丢掉位置。
 * 从 FreeCanvas.tsx 原样拆出；effect 依赖（aliveKey/visibleKey）与执行时序不变。
 */
import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { getFreeViewLayout, updateFreeViewLayout } from '../freeViewStore';
import { bboxOf, fitToRect, nodeHeightOf, nodeRect, syncLayoutNodes, type FreePoint } from '../freeViewGeom';
import type { FreeCanvasItem } from './types';

export interface CanvasSyncOptions {
  aliveIds: string[];
  /** 可见会话 id key（items 变化才重跑选集清洗；与拆分前同口径） */
  visibleKey: string;
  visibleIdSet: ReadonlySet<string>;
  setSelNodes: Dispatch<SetStateAction<string[]>>;
  items: FreeCanvasItem[];
  vpRef: MutableRefObject<HTMLDivElement | null>;
  /** 建会话落位意向（与 useCanvasCreate 共享同一 ref） */
  pendingPlaceRef: MutableRefObject<Record<string, FreePoint>>;
}

export function useCanvasSync(options: CanvasSyncOptions): void {
  const { aliveIds, visibleKey, visibleIdSet, setSelNodes, items, vpRef, pendingPlaceRef } = options;
  const aliveKey = aliveIds.join('\n');

  // 会话集变化：自动补位 / 修剪（含连线与分组成员）；首次从空到有自动适配取景。
  // 修剪口径是 aliveIds（全量未归档），不是当前过滤后的 items——过滤不得丢掉位置。
  useEffect(() => {
    const cur = getFreeViewLayout();
    const nodes = { ...cur.nodes };
    let seeded = false;
    for (const [id, p] of Object.entries(pendingPlaceRef.current)) {
      if (aliveIds.includes(id) && !nodes[id]) {
        nodes[id] = p;
        seeded = true;
      }
    }
    const base = seeded ? { ...cur, nodes } : cur;
    const next = syncLayoutNodes(base, aliveIds);
    setSelNodes((sel) => sel.filter((id) => visibleIdSet.has(id)));
    if (!next && !seeded) return;
    const applied = next ?? base;
    const firstFill = Object.keys(cur.nodes).length === 0 && Object.keys(applied.nodes).length > 0;
    updateFreeViewLayout(() => applied);
    if (firstFill) {
      const el = vpRef.current;
      const visibleRects = items.flatMap((i) => {
        const p = applied.nodes[i.id];
        return p ? [nodeRect(p, nodeHeightOf(
          applied.notes?.[i.id],
          !!i.branch,
          false,
          0
        ))] : [];
      });
      const box = bboxOf(visibleRects);
      if (el && box) {
        const f = fitToRect(box, el.clientWidth, el.clientHeight);
        updateFreeViewLayout((l) => ({ ...l, ...f }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aliveKey, visibleKey]);
}
