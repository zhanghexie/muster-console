/**
 * 自由视图画布 · 双击与右键：双击按 elementFromPoint 真实坐标重新命中分类
 * （视口 setPointerCapture 会重定向原生 dblclick 的 target）、右键节点弹会话菜单 /
 * 右键拖平移后的松开不弹菜单、双击空白打开 NewTaskDialog。
 * 从 FreeCanvas.tsx 原样拆出；onContextMenu prop 经 ref 断开依赖（BoardPanel 内联重建）。
 */
import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { getFreeViewLayout } from '../freeViewStore';
import type { FreePoint } from '../freeViewGeom';
import type { EditStateSetter, SelListSetter } from './useCanvasEdits';

export interface CanvasInteractionsOptions {
  active: boolean;
  /** 会话右键菜单（BoardPanel 提供，prop 稳定性不强） */
  onContextMenu: (e: ReactMouseEvent, sessionId: string) => void;
  /** 双击空白：打开 NewTaskDialog（不预填） */
  onRequestCreate: (opts: { world: FreePoint; initialTask?: string; stickyId?: string }) => void;
  /** 双击节点跳转会话 */
  onSelectSession: (id: string) => void;
  localPoint: (e: { clientX: number; clientY: number }) => FreePoint;
  toWorld: (sx: number, sy: number) => FreePoint;
  /** 按下后拖动超过位移阈值走框选，不触发新建（useCanvasPointer 持有） */
  blankMovedRef: { current: boolean };
  /** 右键拖动平移后的松开不弹菜单（useCanvasPointer 持有） */
  rightPanMovedRef: { current: boolean };
  setGroupRename: EditStateSetter;
  setEdgeLabelEdit: EditStateSetter;
  setStickyEdit: EditStateSetter;
  setSelNodes: SelListSetter;
  setSelEdges: SelListSetter;
  setSelGroups: SelListSetter;
}

export function useCanvasInteractions(options: CanvasInteractionsOptions): {
  onDoubleClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onCanvasContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => void;
} {
  const {
    active,
    onContextMenu,
    onRequestCreate,
    onSelectSession,
    localPoint,
    toWorld,
    blankMovedRef,
    rightPanMovedRef,
    setGroupRename,
    setEdgeLabelEdit,
    setStickyEdit,
    setSelNodes,
    setSelEdges,
    setSelGroups
  } = options;

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (!active) return;
      // 视口 setPointerCapture 会把原生 dblclick 的 target 重定向到视口——
      // e.target 失真会让双击节点落进「双击空白」分支误弹创建面板，
      // 按真实坐标重新命中分类（elementFromPoint 不受 capture 影响）
      const el = (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as Element;
      const label = el.closest('[data-fcglabel]');
      if (label) {
        const gid = label.closest('[data-fcgroup]')?.getAttribute('data-fcgroup') ?? '';
        const g = getFreeViewLayout().groups.find((x) => x.id === gid);
        if (g) setGroupRename({ id: gid, value: g.label });
        return;
      }
      const edgeEl = el.closest('[data-fc-edge]');
      if (edgeEl) {
        const id = edgeEl.getAttribute('data-fc-edge') ?? '';
        const edge = getFreeViewLayout().edges.find((x) => x.id === id);
        if (edge) setEdgeLabelEdit({ id, value: edge.label ?? '' });
        return;
      }
      const nodeEl = el.closest('[data-cnode]');
      if (nodeEl) {
        if (el.closest('[data-fc-note], textarea, button')) return;
        const id = nodeEl.getAttribute('data-cnode') ?? '';
        if (nodeEl.getAttribute('data-fc-kind') === 'sticky') {
          const st = getFreeViewLayout().stickies?.find((s) => s.id === id);
          if (st) {
            setStickyEdit({ id, value: st.text });
            setSelNodes([id]);
            setSelEdges([]);
            setSelGroups([]);
          }
          return;
        }
        if (id) onSelectSession(id);
        return;
      }
      if (el.closest('.fc-ui, .fc-world .fc-group, input, textarea')) return;
      if (blankMovedRef.current) return;
      const p = localPoint(e);
      onRequestCreate({ world: toWorld(p.x, p.y) });
    },
    [active, onSelectSession, onRequestCreate, localPoint, toWorld, setGroupRename, setEdgeLabelEdit, setStickyEdit, setSelNodes, setSelEdges, setSelGroups, blankMovedRef]
  );

  // onContextMenu prop 稳定性不强（BoardPanel 内联重建），走 ref 断开依赖——
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const activeRef = useRef(active);
  activeRef.current = active;

  const onCanvasContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (!activeRef.current) return;
    if (rightPanMovedRef.current) {
      rightPanMovedRef.current = false;
      return; // 右键拖动平移后的松开，不弹菜单
    }
    const el = e.target as Element;
    const nodeEl = el.closest('[data-cnode]');
    if (nodeEl) {
      if (nodeEl.getAttribute('data-fc-kind') === 'sticky') return;
      onContextMenuRef.current(e, nodeEl.getAttribute('data-cnode') ?? '');
      return;
    }
    // 空白/其他：无菜单，顺手清选集
    setSelNodes([]);
    setSelEdges([]);
    setSelGroups([]);
  }, []);

  return { onDoubleClick, onCanvasContextMenu };
}
