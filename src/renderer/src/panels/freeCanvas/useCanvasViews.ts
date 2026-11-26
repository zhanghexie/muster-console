/**
 * 自由视图画布 · 视图推导：连线几何（锚点/贝塞尔/中点/箭头角）、分组包围盒、
 * 工作区分区 hull（凸包气泡）、拖出中的连线预览路径。
 * 从 FreeCanvas.tsx 原样拆出；不可见两端的连线与空组照旧跳过。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  bezierMidpoint,
  bezierPath,
  edgeAnchors,
  endTangent,
  groupBoxOf,
  portAnchor,
  workspaceHullOf,
  type FreeEdge,
  type FreeGroup,
  type FreePoint,
  type FreePort,
  type FreeRect,
  type FreeSticky
} from '../freeViewGeom';
import type { FreeCanvasItem } from './types';

export interface CanvasViewsOptions {
  edges: FreeEdge[];
  groups: FreeGroup[];
  items: FreeCanvasItem[];
  /** 布局里的会话节点位置 */
  nodes: Record<string, FreePoint>;
  visibleIdSet: ReadonlySet<string>;
  rectOf: (id: string) => FreeRect | null;
  hOf: (id: string) => number;
  stickyById: ReadonlyMap<string, FreeSticky>;
  linkDrag: {
    from: string;
    fromPort: FreePort;
    to: FreePoint;
    toOut: FreePoint;
    hoverId?: string;
    hoverPort?: FreePort;
  } | null;
}

export interface EdgeView {
  e: FreeEdge;
  path: string;
  an: ReturnType<typeof edgeAnchors>;
  mid: FreePoint;
  angle: number;
  aName: string;
  bName: string;
}

export interface GroupView {
  g: FreeGroup;
  box: NonNullable<ReturnType<typeof groupBoxOf>>;
}

export interface HullView {
  id: string;
  label: string;
  unzoned: boolean;
  path: string;
  labelX: number;
  labelY: number;
}

export function useCanvasViews(options: CanvasViewsOptions): {
  edgeViews: EdgeView[];
  groupViews: GroupView[];
  hullViews: HullView[];
  linkPath: { path: string } | null;
} {
  const { edges, groups, items, nodes, visibleIdSet, rectOf, hOf, stickyById, linkDrag } = options;
  const { t } = useTranslation();

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const nodePos = nodes;

  const edgeViews = useMemo(() => {
    return edges.flatMap((e) => {
      if (!visibleIdSet.has(e.from) || !visibleIdSet.has(e.to)) return [];
      const ra = rectOf(e.from);
      const rb = rectOf(e.to);
      if (!ra || !rb) return [];
      const an = edgeAnchors(ra, rb, e.fromPort, e.toPort);
      const path = bezierPath(an.a, an.aOut, an.b, an.bOut);
      const mid = bezierMidpoint(an.a, an.aOut, an.b, an.bOut);
      const tan = endTangent(an.b, an.bOut);
      const angle = (Math.atan2(tan.y, tan.x) * 180) / Math.PI;
      const aName = byId.get(e.from)?.name ?? stickyById.get(e.from)?.text ?? '';
      const bName = byId.get(e.to)?.name ?? stickyById.get(e.to)?.text ?? '';
      return [{ e, path, an, mid, angle, aName, bName }];
    });
  }, [edges, byId, visibleIdSet, rectOf, stickyById]);

  const groupViews = useMemo(() => {
    return groups.flatMap((g) => {
      const members = g.members.filter((m) => visibleIdSet.has(m) && nodePos[m]);
      const pos = members.map((m) => nodePos[m]) as FreePoint[];
      const heights = members.map((m) => hOf(m));
      const box = groupBoxOf(pos, heights);
      return box ? [{ g, box }] : [];
    });
  }, [groups, nodePos, visibleIdSet, hOf]);

  const hullViews = useMemo(() => {
    const byZone = new Map<string, { pts: FreePoint[]; hs: number[] }>();
    const labels = new Map<string, string>();
    for (const item of items) {
      const p = nodePos[item.id];
      if (!p) continue;
      const zid = item.zoneId;
      let list = byZone.get(zid);
      if (!list) {
        list = { pts: [], hs: [] };
        byZone.set(zid, list);
      }
      list.pts.push(p);
      list.hs.push(hOf(item.id));
      if (!labels.has(zid)) {
        labels.set(zid, zid === '' ? t('未分区') : (item.workspaceName ?? t('未分区')));
      }
    }
    return [...byZone.entries()].flatMap(([id, members]) => {
      const h = workspaceHullOf(members.pts, members.hs);
      return h ? [{ id, label: labels.get(id) ?? '', unzoned: id === '', ...h }] : [];
    });
  }, [items, nodePos, t, hOf]);

  const linkPath = useMemo(() => {
    if (!linkDrag) return null;
    const fromRect = rectOf(linkDrag.from);
    if (!fromRect) return null;
    const a = portAnchor(fromRect, linkDrag.fromPort);
    return { path: bezierPath(a.p, a.out, linkDrag.to, linkDrag.toOut) };
  }, [linkDrag, rectOf]);

  return { edgeViews, groupViews, hullViews, linkPath };
}
