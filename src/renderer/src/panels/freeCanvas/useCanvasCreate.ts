/**
 * 自由视图画布 · 建会话：拉线落空白弹菜单（Fork / 交接 / 思路便签）、placeSession 落位、
 * 交接准备期间展示占位；历史快照就绪后打开新建任务窗口。
 * fork / 交接走 window.api.sessions.canvasFork / canvasHandover（协议见 free-canvas-create.md）。
 * 从 FreeCanvas.tsx 原样拆出；raf 延挂菜单与 job 生命周期不变。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { updateFreeViewLayout } from '../freeViewStore';
import {
  nearestPort,
  nodeRect,
  stickyRect,
  uid,
  type FreeEdgeKind,
  type FreePoint,
  type FreePort
} from '../freeViewGeom';
import { findDuplicateEdge } from './canvasOps';
import type { FreeCanvasProps, LinkMenuPayload } from './types';
import type { EditStateSetter, SelListSetter } from './useCanvasEdits';
import { t } from '../../../../shared/i18n';

export interface CanvasCreateOptions {
  /** 取源节点当前位置（连线锚点用；便签与会话卡都查） */
  posOf: (id: string) => FreePoint | undefined;
  /** 全局 flash 提示（fork/交接失败时） */
  flashTip: (msg: string) => void;
  /** 「思路便签」：建便签后立即进入编辑 */
  setStickyEdit: EditStateSetter;
  setSelNodes: SelListSetter;
  setSelEdges: SelListSetter;
  setSelGroups: SelListSetter;
  onRequestCreate?: FreeCanvasProps['onRequestCreate'];
}

export function useCanvasCreate(options: CanvasCreateOptions): {
  placeSessionNode: (
    sessionId: string,
    world: FreePoint,
    from?: { id: string; port?: FreePort; kind?: FreeEdgeKind }
  ) => void;
  linkMenu: LinkMenuPayload | null;
  closeLinkMenu: () => void;
  onLinkMenu: (id: string) => void;
  isLinkMenuOpen: () => boolean;
  cancelLinkMenuRequest: () => void;
  requestLinkMenu: (payload: LinkMenuPayload) => void;
  cancelHandover: (jobId: string) => void;
  handoverJobs: Record<string, string>;
  handoverStubs: Record<string, { world: FreePoint; from: string; fromPort: FreePort }>;
  /** 会话落位意向（拆分前即只声明/读取/删除、从不写入——按原样保留，行为不变） */
  pendingPlaceRef: MutableRefObject<Record<string, FreePoint>>;
} {
  const { posOf, flashTip, setStickyEdit, setSelNodes, setSelEdges, setSelGroups, onRequestCreate } = options;
  const linkMenuRef = useRef<LinkMenuPayload | null>(null);
  const linkMenuRafRef = useRef(0);
  const pendingPlaceRef = useRef<Record<string, FreePoint>>({});
  const preparations = useRef(new Map<string, { cancelled: boolean }>());
  const mounted = useRef(true);
  const [linkMenu, setLinkMenu] = useState<LinkMenuPayload | null>(null);
  const [handoverJobs, setHandoverJobs] = useState<Record<string, string>>({});
  /** 交接文档准备期间的画布占位：jobId → 落点与来源；准备完成、失败或取消时移除 */
  const [handoverStubs, setHandoverStubs] = useState<
    Record<string, { world: FreePoint; from: string; fromPort: FreePort }>
  >({});

  const placeSessionNode = useCallback(
    (sessionId: string, world: FreePoint, from?: { id: string; port?: FreePort; kind?: FreeEdgeKind }): void => {
      const srcPos = from ? posOf(from.id) : undefined;
      const toPort: FreePort = srcPos ? nearestPort(nodeRect(world), srcPos) : 'w';
      updateFreeViewLayout((l) => {
        const nodesNext = { ...l.nodes, [sessionId]: world };
        let edgesNext = l.edges;
        if (from && !findDuplicateEdge(l.edges, from.id, sessionId)) {
          edgesNext = [
            ...l.edges,
            {
              id: uid('e'),
              from: from.id,
              to: sessionId,
              fromPort: from.port ?? 'e',
              toPort,
              ...(from.kind ? { kind: from.kind } : {})
            }
          ];
        }
        return { ...l, nodes: nodesNext, edges: edgesNext };
      });
      setSelNodes([sessionId]);
      setSelEdges([]);
      setSelGroups([]);
    },
    [posOf, setSelNodes, setSelEdges, setSelGroups]
  );

  const closeLinkMenu = useCallback((): void => {
    cancelAnimationFrame(linkMenuRafRef.current);
    linkMenuRafRef.current = 0;
    linkMenuRef.current = null;
    setLinkMenu(null);
  }, []);

  /** 等本轮 pointerup/click 结束后再挂菜单，避免松手点击打在刚出现的第一项上 */
  const requestLinkMenu = useCallback((payload: LinkMenuPayload): void => {
    cancelAnimationFrame(linkMenuRafRef.current);
    linkMenuRafRef.current = requestAnimationFrame(() => {
      linkMenuRafRef.current = 0;
      linkMenuRef.current = payload;
      setLinkMenu(payload);
    });
  }, []);

  const cancelLinkMenuRequest = useCallback((): void => {
    if (linkMenuRafRef.current) {
      cancelAnimationFrame(linkMenuRafRef.current);
      linkMenuRafRef.current = 0;
    }
  }, []);

  const isLinkMenuOpen = useCallback((): boolean => linkMenuRef.current != null, []);

  const onLinkMenu = useCallback(
    (id: string): void => {
      const menu = linkMenuRef.current;
      linkMenuRef.current = null;
      setLinkMenu(null);
      if (!menu) return;
      if (id === 'note') {
        const nid = uid('note');
        updateFreeViewLayout((l) => ({
          ...l,
          stickies: [...(l.stickies ?? []), { id: nid, x: menu.world.x, y: menu.world.y, text: '' }],
          edges: [
            ...l.edges,
            {
              id: uid('e'),
              from: menu.from,
              to: nid,
              fromPort: menu.fromPort,
              toPort: nearestPort(stickyRect({ x: menu.world.x, y: menu.world.y }), posOf(menu.from) ?? menu.world)
            }
          ]
        }));
        setStickyEdit({ id: nid, value: '' });
        setSelNodes([nid]);
        setSelEdges([]);
        setSelGroups([]);
        return;
      }
      if (id === 'fork') {
        void window.api.sessions
          .canvasFork(menu.from)
          .then((r) => {
            placeSessionNode(r.session.id, menu.world, {
              id: menu.from,
              port: menu.fromPort,
              kind: 'fork'
            });
          })
          .catch((err: unknown) => {
            flashTip(err instanceof Error ? err.message : String(err));
          });
        return;
      }
      if (id === 'handover') {
        if (!onRequestCreate) { flashTip(t('无法打开新建任务窗口')); return; }
        if ([...preparations.current.values()].some(request => !request.cancelled)) { flashTip(t('正在准备交接，请稍候')); return; }
        const requestId = uid('handover');
        const request = { cancelled: false };
        preparations.current.set(requestId, request);
        setHandoverStubs(m => ({ ...m, [requestId]: { world: menu.world, from: menu.from, fromPort: menu.fromPort } }));
        setHandoverJobs(m => ({ ...m, [menu.from]: requestId }));
        void (async () => {
          let prepared = false;
          try {
            const draft = await window.api.sessions.canvasHandover(menu.from);
            prepared = true;
            if (request.cancelled || !mounted.current) {
              await window.api.sessions.canvasHandoverCancel(draft.id);
              return;
            }
            try { onRequestCreate({ world: menu.world, handover: { draft, fromPort: menu.fromPort } }); }
            catch (error) { await window.api.sessions.canvasHandoverCancel(draft.id); throw error; }
          } catch (err) {
            if (!request.cancelled || prepared) flashTip(err instanceof Error ? err.message : String(err));
          } finally {
            preparations.current.delete(requestId);
            if (mounted.current) {
              setHandoverJobs(m => { const next = { ...m }; if (next[menu.from] === requestId) delete next[menu.from]; return next; });
              setHandoverStubs(m => { const next = { ...m }; delete next[requestId]; return next; });
            }
          }
        })();
      }
    },
    [placeSessionNode, posOf, flashTip, setStickyEdit, setSelNodes, setSelEdges, setSelGroups, onRequestCreate]
  );

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelAnimationFrame(linkMenuRafRef.current); for (const request of preparations.current.values()) request.cancelled = true; };
  }, []);

  const cancelHandover = useCallback((jobId: string): void => {
    const request = preparations.current.get(jobId);
    if (request) request.cancelled = true;
    setHandoverJobs(m => Object.fromEntries(Object.entries(m).filter(([, id]) => id !== jobId)));
    setHandoverStubs(m => { const next = { ...m }; delete next[jobId]; return next; });
  }, []);

  return {
    placeSessionNode,
    linkMenu,
    closeLinkMenu,
    onLinkMenu,
    isLinkMenuOpen,
    cancelLinkMenuRequest,
    requestLinkMenu,
    cancelHandover,
    handoverJobs,
    handoverStubs,
    pendingPlaceRef
  };
}
