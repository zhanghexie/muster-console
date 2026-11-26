/**
 * 自由视图画布 · 视口统一指针手势（Obsidian canvas 式分类派发）。
 * onPointerDown 按 closest('[data-fc-handle]') → 拉线、[data-cnode] → 节点拖拽、
 * [data-fc-edge] → 选中连线、[data-fcgroup] → 组拖拽、否则空白 = 平移/框选 一次分类；
 * pointer capture 后 e.target 失真，DragState 自带 primaryId/nodeStarts。
 * 从 FreeCanvas.tsx 原样拆出；命中/吸附的纯计算在 canvasOps.ts（可单测）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { getFreeViewLayout, updateFreeViewLayout } from '../freeViewStore';
import { isPort, nearestPort, portAnchor, uid, type FreeGuide, type FreePoint, type FreePort } from '../freeViewGeom';
import { dragMovePositions, findDuplicateEdge, marqueeHits } from './canvasOps';
import type { CanvasPointerApi, CanvasPointerOptions, DragState, LinkDragState } from './types';

export function useCanvasPointer(options: CanvasPointerOptions): CanvasPointerApi {
  const {
    active,
    selNodes,
    setSelNodes,
    setSelEdges,
    setSelGroups,
    visibleIdSet,
    sessionIdSet,
    stickyById,
    stickies,
    hOf,
    rectOf,
    localPoint,
    toWorld,
    noteEdit,
    commitNoteEdit,
    interruptArrange,
    onSelectSession,
    isLinkMenuOpen,
    cancelLinkMenuRequest,
    requestLinkMenu,
    spaceRef
  } = options;

  const dragRef = useRef<DragState | null>(null);
  const rightPanMovedRef = useRef(false);
  const blankMovedRef = useRef(false);
  const lastNodeClickRef = useRef<{ id: string; t: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [guides, setGuides] = useState<FreeGuide[]>([]);
  const [hotZone, setHotZone] = useState<string | null>(null);
  const [linkDrag, setLinkDrag] = useState<LinkDragState | null>(null);
  /** P1-2：拖拽帧合帧——最新事件入 ref，rAF 每显示帧至多应用一次（几何+store+state
   *  写从事件率封顶到帧率）；pointerup/cancel 同步 flush 尾值。回滚=还原单 commit。 */
  const pendingMoveRef = useRef<{ d: DragState; e: ReactPointerEvent<HTMLDivElement> } | null>(null);
  const moveRafRef = useRef<number | null>(null);

  const clearTransient = useCallback((): void => {
    dragRef.current = null;
    setMarquee(null);
    setGuides([]);
    setLinkDrag(null);
  }, []);

  // 切回状态视图时清手势态（键盘/滚轮由 active 守卫）
  useEffect(() => {
    if (!active) clearTransient();
  }, [active, clearTransient]);

  // ---------- 视口统一手势 ----------

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (e.button === 1) return; // 中键 = 全局开关看板
      cancelLinkMenuRequest();
      // 菜单开着时不要 capture：否则点项会被视口吞掉，只关菜单不触发动作
      if (isLinkMenuOpen()) return;
      const raw = e.target;
      const el = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null;
      if (!el) return;
      if (el.closest('.fc-ui')) return;
      if (el.closest('input, textarea')) return;
      if (noteEdit) commitNoteEdit();
      // 任何画布操作：提前摘掉自动布局的 transform 过渡（拖拽绝不能带粘滞）并收撤销 toast
      interruptArrange();
      const p = localPoint(e);
      const handle = el.closest('[data-fc-handle]');
      const nodeEl = el.closest('[data-cnode]');
      const edgeEl = el.closest('[data-fc-edge]');
      const groupEl = el.closest('[data-fcgroup]');
      const base: DragState = {
        mode: 'marquee',
        pointerId: e.pointerId,
        button: e.button,
        startScreen: p,
        moved: false
      };
      e.currentTarget.setPointerCapture(e.pointerId);

      if (e.button === 0 && handle && nodeEl) {
        const raw = handle.getAttribute('data-fc-handle');
        const fromPort: FreePort = isPort(raw) ? raw : 'e';
        dragRef.current = {
          ...base,
          mode: 'link',
          linkFrom: nodeEl.getAttribute('data-cnode') ?? '',
          linkFromPort: fromPort
        };
        setSelEdges([]);
        return;
      }
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-cnode') ?? '';
        if (e.button !== 0) return; // 右键交给 contextmenu
        setSelEdges([]);
        setSelGroups([]);
        let sel = selNodes;
        if (e.ctrlKey || e.metaKey) {
          sel = selNodes.includes(id) ? selNodes.filter((x) => x !== id) : [...selNodes, id];
          setSelNodes(sel);
          if (!sel.includes(id)) return; // ctrl 点掉了选中：只改选集，不起拖
        } else if (!sel.includes(id)) {
          sel = [id];
          setSelNodes(sel);
        }
        const l = getFreeViewLayout();
        const dragIds = sel.length > 1 && sel.includes(id) ? sel : [id];
        const nodeStarts: Record<string, FreePoint> = {};
        for (const nid of dragIds) {
          const np = l.nodes[nid] ?? (l.stickies ?? []).find((s) => s.id === nid);
          if (np) nodeStarts[nid] = { x: np.x, y: np.y };
        }
        dragRef.current = {
          ...base,
          mode: 'node',
          startWorld: toWorld(p.x, p.y),
          nodeStarts,
          ids: Object.keys(nodeStarts),
          primaryId: id
        };
        return;
      }
      if (edgeEl) {
        const id = edgeEl.getAttribute('data-fc-edge') ?? '';
        setSelEdges([id]);
        setSelNodes([]);
        setSelGroups([]);
        return;
      }
      if (groupEl) {
        const gid = groupEl.getAttribute('data-fcgroup') ?? '';
        if (e.button !== 0) return;
        const l = getFreeViewLayout();
        const g = l.groups.find((x) => x.id === gid);
        if (!g) return;
        setSelGroups([gid]);
        setSelNodes(g.members);
        setSelEdges([]);
        const nodeStarts: Record<string, FreePoint> = {};
        for (const m of g.members) {
          const np = l.nodes[m];
          if (np) nodeStarts[m] = np;
        }
        dragRef.current = {
          ...base,
          mode: 'group',
          startWorld: toWorld(p.x, p.y),
          nodeStarts,
          ids: Object.keys(nodeStarts)
        };
        return;
      }
      // 空白：space / 右键 = 平移；否则框选
      if (e.button === 2 || spaceRef.current) {
        dragRef.current = { ...base, mode: 'pan', startPan: getFreeViewLayout().pan };
        if (e.button === 2) rightPanMovedRef.current = false;
        return;
      }
      const baseSel = e.shiftKey ? selNodes : [];
      if (!e.shiftKey) {
        setSelNodes([]);
        setSelEdges([]);
        setSelGroups([]);
      }
      blankMovedRef.current = false;
      dragRef.current = { ...base, mode: 'marquee', baseSel };
      setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    },
    [localPoint, selNodes, toWorld, noteEdit, commitNoteEdit, interruptArrange, cancelLinkMenuRequest, isLinkMenuOpen, spaceRef, setSelNodes, setSelEdges, setSelGroups]
  );

  /** P1-2：几何计算 + store 写 + state 写（每显示帧至多执行一次） */
  const applyPointerMove = useCallback(
    (d: DragState, e: ReactPointerEvent<HTMLDivElement>): void => {
      const p = localPoint(e);
      if (d.mode === 'pan' && d.startPan) {
        updateFreeViewLayout((l) => ({
          ...l,
          pan: {
            x: d.startPan!.x + (p.x - d.startScreen.x),
            y: d.startPan!.y + (p.y - d.startScreen.y)
          }
        }));
        return;
      }
      if (d.mode === 'marquee') {
        setMarquee({ x0: d.startScreen.x, y0: d.startScreen.y, x1: p.x, y1: p.y });
        const l = getFreeViewLayout();
        const a = toWorld(Math.min(d.startScreen.x, p.x), Math.min(d.startScreen.y, p.y));
        const b = toWorld(Math.max(d.startScreen.x, p.x), Math.max(d.startScreen.y, p.y));
        const rect = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
        const hits = marqueeHits(
          [...Object.entries(l.nodes), ...stickies.map((s) => [s.id, { x: s.x, y: s.y }] as const)],
          rect,
          { visibleIdSet, stickyById, hOf }
        );
        const base = new Set(d.baseSel ?? []);
        setSelNodes([...base, ...hits.filter((id) => !base.has(id))]);
        return;
      }
      if (d.mode === 'link' && d.linkFrom) {
        const fromRect = rectOf(d.linkFrom);
        if (!fromRect) return;
        const fromPort = d.linkFromPort ?? 'e';
        const to = toWorld(p.x, p.y);
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const hit = under?.closest('[data-cnode]');
        const hoverId = hit?.getAttribute('data-cnode') ?? '';
        if (hoverId && hoverId !== d.linkFrom) {
          const hoverRect = rectOf(hoverId);
          if (hoverRect) {
            const handleEl = under?.closest('[data-fc-handle]');
            const handlePort =
              handleEl && hit?.contains(handleEl) && isPort(handleEl.getAttribute('data-fc-handle'))
                ? handleEl.getAttribute('data-fc-handle')
                : null;
            const hoverPort: FreePort = handlePort && isPort(handlePort) ? handlePort : nearestPort(hoverRect, to);
            const b = portAnchor(hoverRect, hoverPort);
            setLinkDrag({
              from: d.linkFrom,
              fromPort,
              to: b.p,
              toOut: b.out,
              hoverId,
              hoverPort
            });
            return;
          }
        }
        const a = portAnchor(fromRect, fromPort);
        const vx = a.p.x - to.x;
        const vy = a.p.y - to.y;
        const len = Math.hypot(vx, vy) || 1;
        setLinkDrag({ from: d.linkFrom, fromPort, to, toOut: { x: vx / len, y: vy / len } });
        return;
      }
      if ((d.mode === 'node' || d.mode === 'group') && d.startWorld && d.nodeStarts) {
        const l = getFreeViewLayout();
        const cur = toWorld(p.x, p.y);
        const { moved, guides: guidesNow } = dragMovePositions({
          nodeStarts: d.nodeStarts,
          startWorld: d.startWorld,
          cur,
          zoom: l.zoom,
          dragIds: new Set(d.ids ?? []),
          layoutNodes: l.nodes,
          stickies,
          visibleIdSet,
          rectOf,
          hOf
        });
        updateFreeViewLayout((x) => {
          const nextNodes = { ...x.nodes };
          const nextStickies = (x.stickies ?? []).map((s) => {
            const p = moved[s.id];
            return p ? { ...s, x: p.x, y: p.y } : s;
          });
          for (const [id, p] of Object.entries(moved)) {
            if (!stickyById.has(id)) nextNodes[id] = p;
          }
          return { ...x, nodes: nextNodes, stickies: nextStickies };
        });
        setGuides(guidesNow);
      }
    },
    [localPoint, toWorld, visibleIdSet, hOf, rectOf, stickies, stickyById, setGuides]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) {
        const zoneEl = (e.target as Element).closest?.('[data-cnode]');
        setHotZone(zoneEl ? (zoneEl.getAttribute('data-fc-zone') ?? '') : null);
        return;
      }
      // moved 阈值判定保留在事件路径（廉价，且 3px 内抖动不吞手势）
      const p0 = localPoint(e);
      if (
        !d.moved &&
        Math.abs(p0.x - d.startScreen.x) + Math.abs(p0.y - d.startScreen.y) > 3
      ) {
        d.moved = true;
      }
      // P1-2：最新事件入 ref + rAF 合帧；已有待应用帧则只换事件（每帧至多一次）
      pendingMoveRef.current = { d, e };
      if (moveRafRef.current == null) {
        moveRafRef.current = requestAnimationFrame(() => {
          moveRafRef.current = null;
          const pend = pendingMoveRef.current;
          pendingMoveRef.current = null;
          if (pend && dragRef.current === pend.d) applyPointerMove(pend.d, pend.e);
        });
      }
    },
    [localPoint, applyPointerMove, setHotZone]
  );

  /** pointerup/cancel：同步 flush 拖拽尾值（rAF 被节流也不丢末位） */
  const flushPendingMove = useCallback((): void => {
    if (moveRafRef.current != null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    const pend = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (pend && dragRef.current === pend.d) applyPointerMove(pend.d, pend.e);
  }, [applyPointerMove]);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      // P1-2：先同步 flush 拖拽尾值（rAF 未跑也不丢末位），再走收口逻辑
      flushPendingMove();
      dragRef.current = null;
      if (d.mode === 'link' && d.linkFrom) {
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const drop = under?.closest('[data-cnode]');
        const toId = drop?.getAttribute('data-cnode') ?? '';
        setLinkDrag(null);
        if (toId && toId !== d.linkFrom) {
          const from = d.linkFrom;
          const fromPort = d.linkFromPort ?? 'e';
          const dropWorld = toWorld(localPoint(e).x, localPoint(e).y);
          const toRect = rectOf(toId);
          const handleEl = under?.closest('[data-fc-handle]');
          const handlePort =
            handleEl && drop?.contains(handleEl) && isPort(handleEl.getAttribute('data-fc-handle'))
              ? handleEl.getAttribute('data-fc-handle')
              : null;
          const toPort: FreePort =
            handlePort && isPort(handlePort)
              ? handlePort
              : toRect
                ? nearestPort(toRect, dropWorld)
                : 'w';
          updateFreeViewLayout((l) => {
            if (findDuplicateEdge(l.edges, from, toId)) return l;
            return { ...l, edges: [...l.edges, { id: uid('e'), from, to: toId, fromPort, toPort }] };
          });
        } else if (!toId && sessionIdSet.has(d.linkFrom) && d.moved) {
          const payload = {
            x: e.clientX,
            y: e.clientY,
            from: d.linkFrom,
            fromPort: d.linkFromPort ?? 'e',
            world: toWorld(localPoint(e).x, localPoint(e).y)
          };
          // 等本轮 pointerup/click 结束后再挂菜单，避免松手点击打在刚出现的第一项上
          requestLinkMenu(payload);
        }
        return;
      }
      if (d.mode === 'marquee') {
        if (d.moved) blankMovedRef.current = true;
        setMarquee(null);
        return;
      }
      if (d.mode === 'pan') {
        if (d.button === 2 && d.moved) rightPanMovedRef.current = true;
        return;
      }
      if (d.mode === 'node' && !d.moved) {
        // 单击已多选的节点：收拢选集到该节点（未拖动时；capture 后 e.target 失真用 primaryId）
        if (d.primaryId && !e.ctrlKey && !e.metaKey && selNodes.length > 1) {
          setSelNodes([d.primaryId]);
        }
        // pointer capture 会吃掉原生 dblclick，用两次 pointerup 识别双击跳转
        if (d.primaryId && sessionIdSet.has(d.primaryId) && !e.ctrlKey && !e.metaKey) {
          const now = Date.now();
          const prev = lastNodeClickRef.current;
          if (prev && prev.id === d.primaryId && now - prev.t < 450) {
            lastNodeClickRef.current = null;
            onSelectSession(d.primaryId);
          } else {
            lastNodeClickRef.current = { id: d.primaryId, t: now };
          }
        }
      }
      setGuides([]);
    },
    [selNodes, localPoint, toWorld, rectOf, sessionIdSet, onSelectSession, requestLinkMenu, setLinkDrag, setMarquee, setGuides, setSelNodes, flushPendingMove]
  );

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      // P1-2：cancel 同步 flush 尾值（处方口径），再清手势态
      flushPendingMove();
      dragRef.current = null;
      setMarquee(null);
      setGuides([]);
      setLinkDrag(null);
    },
    [flushPendingMove]
  );

  return {
    dragRef,
    marquee,
    guides,
    linkDrag,
    hotZone,
    setHotZone,
    rightPanMovedRef,
    blankMovedRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel
  };
}
