/**
 * 自由视图画布 · 一键自动布局：快照 → autoArrange（确定性纯函数）→ 写盘 →
 * `.is-arranging` transform 过渡（MOTION.moveMs 兜底摘除、画布按下提前摘）→ fit 视野 →
 * 一次性撤销 toast（mp-pop 进出场，6 秒自动消失）。
 * 从 FreeCanvas.tsx 原样拆出；只动 nodes/stickies 位置与边端口朝向，其余字段不动。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { getFreeViewLayout, updateFreeViewLayout } from '../freeViewStore';
import {
  autoArrange,
  bboxOf,
  fitToRect,
  nearestPort,
  nodeRect,
  resolveArrangeHeights,
  stickyRect,
  FREE_NODE_H,
  type FreePoint,
  type FreePort,
  type FreeRect,
  type FreeSticky
} from '../freeViewGeom';
import { MOTION, usePresence } from '../../components/motion';
import { readCanvasCardHeights } from './cardHeights';
import type { FreeCanvasItem } from './types';

export interface CanvasArrangeOptions {
  aliveIds: string[];
  /** 全量会话分区归属（聚簇用，含过滤隐藏的） */
  zones: Record<string, string>;
  /** 侧栏工作区顺序（簇排布顺序） */
  workspaceOrder: string[];
  items: FreeCanvasItem[];
  /** 画布实测高度（resolveArrangeHeights 实测优先） */
  measuredH: Record<string, number>;
  hOf: (id: string) => number;
  vpRef: MutableRefObject<HTMLDivElement | null>;
  worldRef: MutableRefObject<HTMLDivElement | null>;
}

export function useCanvasArrange(options: CanvasArrangeOptions): {
  arranging: boolean;
  interruptArrange: () => void;
  toastPresence: ReturnType<typeof usePresence>;
  undoArrange: () => void;
  runAutoArrange: () => void;
} {
  const { aliveIds, zones, workspaceOrder, items, measuredH, hOf, vpRef, worldRef } = options;

  // ---------- 一键自动布局（作用范围=全部节点；一次性撤销 + transform 过渡 + fit） ----------

  /** 重排过渡：给 .fc-node/.fc-sticky 临时挂 is-arranging（只 transition transform），到点摘除 */
  const [arranging, setArranging] = useState(false);
  const arrangeTimerRef = useRef(0);
  const clearArrangeTimer = useCallback((): void => {
    if (arrangeTimerRef.current) {
      window.clearTimeout(arrangeTimerRef.current);
      arrangeTimerRef.current = 0;
    }
  }, []);
  useEffect(() => clearArrangeTimer, [clearArrangeTimer]);

  /** 撤销快照（一次性）：布局前的 nodes/stickies 位置、各边端口与相机（pan/zoom——
   * 布局末尾 fit 了视野，撤销只还位置不还相机会停在 fit 态，F-03）；6 秒后或任何画布操作时清除 */
  const [arrangeToast, setArrangeToast] = useState<{
    nodes: Record<string, FreePoint>;
    stickies: FreeSticky[];
    edgePorts: Record<string, { fromPort?: FreePort; toPort?: FreePort }>;
    view: { pan: FreePoint; zoom: number };
  } | null>(null);
  const toastTimerRef = useRef(0);
  const clearToastTimer = useCallback((): void => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = 0;
    }
  }, []);
  useEffect(() => clearToastTimer, [clearToastTimer]);
  const toastPresence = usePresence(arrangeToast != null);

  /** 任何后续画布操作提前收掉撤销 toast（.fc-ui 上的点击在视口手势里已拦截，不受影响） */
  const dismissArrangeToast = useCallback((): void => {
    clearToastTimer();
    setArrangeToast((cur) => (cur ? null : cur));
  }, []);

  /** 画布按下：提前摘自动布局的 transform 过渡（拖拽绝不能带粘滞）并收撤销 toast */
  const interruptArrange = useCallback((): void => {
    setArranging((cur) => (cur ? false : cur));
    dismissArrangeToast();
  }, [dismissArrangeToast]);

  const undoArrange = useCallback((): void => {
    clearToastTimer();
    setArrangeToast((snap) => {
      if (snap) {
        updateFreeViewLayout((l) => ({
          ...l,
          // F-03：相机随快照一并恢复——布局末尾的 fit 不再把视野留在 fit 态
          pan: { ...snap.view.pan },
          zoom: snap.view.zoom,
          nodes: { ...l.nodes, ...snap.nodes },
          stickies: (l.stickies ?? []).map((s) => {
            const p = snap.stickies.find((x) => x.id === s.id);
            return p ? { ...s, x: p.x, y: p.y } : s;
          }),
          edges: l.edges.map((e) => {
            const p = snap.edgePorts[e.id];
            return p ? { ...e, fromPort: p.fromPort, toPort: p.toPort } : e;
          })
        }));
      }
      return null;
    });
  }, [clearToastTimer]);

  const runAutoArrange = useCallback((): void => {
    const l = getFreeViewLayout();
    const stickies = l.stickies ?? [];
    const heightMap = resolveArrangeHeights({
      sessionIds: aliveIds,
      notes: l.notes ?? {},
      hasBranch: Object.fromEntries(items.map((i) => [i.id, !!i.branch])),
      measured: { ...measuredH, ...readCanvasCardHeights(worldRef.current) }
    });
    const result = autoArrange({
      sessions: aliveIds.map((id) => ({ id, zoneId: zones[id] ?? '' })),
      stickies,
      edges: l.edges,
      workspaceOrder,
      heights: heightMap
    });
    if (Object.keys(result.nodes).length === 0 && Object.keys(result.stickyPos).length === 0) return;
    // 布局只挪位置会让拉线时固定的出/入面不再朝向对端——按新位置重算端口朝向，
    // 避免重排后连线打大弯（只动 fromPort/toPort；from/to/label/kind 不动）
    const rectById = new Map<string, FreeRect>();
    for (const [id, p] of Object.entries(result.nodes)) {
      rectById.set(id, nodeRect(p, heightMap[id] ?? FREE_NODE_H));
    }
    for (const [id, p] of Object.entries(result.stickyPos)) {
      rectById.set(id, stickyRect(p));
    }
    // 快照（撤销用）→ 整体替换位置与端口（edges 其余字段、groups/notes 原样）
    const snapNodes = { ...l.nodes };
    const snapStickies = stickies.map((s) => ({ ...s }));
    const snapEdgePorts: Record<string, { fromPort?: FreePort; toPort?: FreePort }> = {};
    for (const e of l.edges) snapEdgePorts[e.id] = { fromPort: e.fromPort, toPort: e.toPort };
    updateFreeViewLayout((cur) => ({
      ...cur,
      nodes: { ...cur.nodes, ...result.nodes },
      stickies: (cur.stickies ?? []).map((s) => {
        const p = result.stickyPos[s.id];
        return p ? { ...s, x: p.x, y: p.y } : s;
      }),
      edges: cur.edges.map((e) => {
        const ra = rectById.get(e.from);
        const rb = rectById.get(e.to);
        if (!ra || !rb) return e;
        const fromPort = nearestPort(ra, { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 });
        const toPort = nearestPort(rb, { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 });
        if (e.fromPort === fromPort && e.toPort === toPort) return e;
        return { ...e, fromPort, toPort };
      })
    }));
    // 过渡动画（MOTION.moveMs 兜底摘除；拖拽会在 onPointerDown 提前摘）
    clearArrangeTimer();
    setArranging(true);
    arrangeTimerRef.current = window.setTimeout(() => {
      arrangeTimerRef.current = 0;
      setArranging(false);
    }, MOTION.moveMs + 80);
    // fit 视野：与缩放条「适配」同口径——「仅当前工作区」过滤开启时只居中当前工作区的可见内容
    // （+常驻渲染的便签），未过滤时即全部内容
    const el = vpRef.current;
    if (el) {
      const rects = [
        ...items.flatMap((i) => {
          const p = result.nodes[i.id] ?? l.nodes[i.id];
          return p ? [nodeRect(p, heightMap[i.id] ?? hOf(i.id))] : [];
        }),
        ...stickies.flatMap((s) => {
          const p = result.stickyPos[s.id] ?? s;
          return [stickyRect(p)];
        })
      ];
      const box = bboxOf(rects);
      if (box) updateFreeViewLayout((cur) => ({ ...cur, ...fitToRect(box, el.clientWidth, el.clientHeight) }));
    }
    // 撤销 toast：6 秒后自动消失（快照含布局前相机 pan/zoom，见 F-03）
    clearToastTimer();
    setArrangeToast({
      nodes: snapNodes,
      stickies: snapStickies,
      edgePorts: snapEdgePorts,
      view: { pan: { ...l.pan }, zoom: l.zoom }
    });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = 0;
      setArrangeToast(null);
    }, 6000);
  }, [aliveIds, zones, workspaceOrder, clearArrangeTimer, clearToastTimer, items, hOf, measuredH, vpRef, worldRef]);

  return { arranging, interruptArrange, toastPresence, undoArrange, runAutoArrange };
}
