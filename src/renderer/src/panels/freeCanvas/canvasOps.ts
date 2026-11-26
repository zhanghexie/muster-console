/**
 * 自由视图画布 · 手势内抽出的纯函数：框选命中、拖拽吸附位移、同对连线去重。
 * 只依赖入参（几何回调经参数注入），零 React / DOM 依赖，test/unit 可直接单测。
 * 语义与拆分前 FreeCanvas.tsx 的内联实现逐字一致。
 */
import {
  bboxOf,
  nodeRect,
  snapDrag,
  stickyRect,
  SNAP_THRESHOLD_PX,
  type FreeEdge,
  type FreeGuide,
  type FreePoint,
  type FreeRect,
  type FreeSticky
} from '../freeViewGeom';

/** 两矩形相交（框选命中判定：严格小于，贴边不算命中） */
export function rectHits(r: FreeRect, rect: FreeRect): boolean {
  return r.x < rect.x + rect.w && rect.x < r.x + r.w && r.y < rect.y + rect.h && rect.y < r.y + r.h;
}

/**
 * 框选命中：从候选（布局节点 entries + 便签位置）里筛出可见且与框选矩形相交的 id。
 * 便签按便签实际尺寸取矩形，会话卡按 hOf(id) 取矩形（与拆分前一致）。
 */
export function marqueeHits(
  candidates: ReadonlyArray<readonly [string, FreePoint]>,
  rect: FreeRect,
  opts: {
    visibleIdSet: ReadonlySet<string>;
    stickyById: ReadonlyMap<string, FreeSticky>;
    hOf: (id: string) => number;
  }
): string[] {
  return candidates
    .filter(([id, np]) => {
      if (!opts.visibleIdSet.has(id)) return false;
      const r = opts.stickyById.has(id)
        ? stickyRect(opts.stickyById.get(id)!)
        : nodeRect(np, opts.hOf(id));
      return rectHits(r, rect);
    })
    .map(([id]) => id);
}

export interface DragMoveInput {
  /** 各被拖节点起始位（node/group 手势按下时快照） */
  nodeStarts: Record<string, FreePoint>;
  /** 拖拽起始的指针世界坐标 */
  startWorld: FreePoint;
  /** 当前指针世界坐标 */
  cur: FreePoint;
  zoom: number;
  /** 被拖节点 id 集合（吸附时排除自身） */
  dragIds: ReadonlySet<string>;
  /** 布局里的全部会话节点位置 */
  layoutNodes: Record<string, FreePoint>;
  /** 全部便签 */
  stickies: FreeSticky[];
  visibleIdSet: ReadonlySet<string>;
  rectOf: (id: string) => FreeRect | null;
  hOf: (id: string) => number;
}

/**
 * 节点/组拖拽位移：整体跟手平移 + Figma 式对齐吸附（被拖 bbox 对静态节点参考线修正）。
 * 返回移动后的各节点位置与参考线；写回布局由调用方负责（与拆分前一致）。
 */
export function dragMovePositions(input: DragMoveInput): {
  moved: Record<string, FreePoint>;
  guides: FreeGuide[];
} {
  const { nodeStarts, startWorld, cur, zoom, dragIds, layoutNodes, stickies, visibleIdSet, rectOf, hOf } =
    input;
  const dx = cur.x - startWorld.x;
  const dy = cur.y - startWorld.y;
  const moved: Record<string, FreePoint> = {};
  for (const [id, start] of Object.entries(nodeStarts)) {
    moved[id] = { x: start.x + dx, y: start.y + dy };
  }
  const movedRects = Object.entries(moved).map(([id, start]) => {
    const r = rectOf(id);
    return r ? { ...r, x: start.x, y: start.y } : nodeRect(start, hOf(id));
  });
  const dragBox = bboxOf(movedRects);
  let guides: FreeGuide[] = [];
  let adjX = 0;
  let adjY = 0;
  if (dragBox) {
    const statics = [
      ...Object.entries(layoutNodes)
        .filter(([id]) => !dragIds.has(id) && visibleIdSet.has(id))
        .map(([id, np]) => nodeRect(np, hOf(id))),
      ...stickies
        .filter((s) => !dragIds.has(s.id))
        .map((s) => stickyRect(s))
    ];
    const snap = snapDrag(dragBox, statics, SNAP_THRESHOLD_PX / zoom);
    adjX = snap.dx;
    adjY = snap.dy;
    guides = snap.guides;
  }
  if (adjX !== 0 || adjY !== 0) {
    for (const id of Object.keys(moved)) {
      moved[id] = { x: moved[id].x + adjX, y: moved[id].y + adjY };
    }
  }
  return { moved, guides };
}

/** 同对（无向）连线已存在判定：from→to 或 to→from 任一方向命中即重复 */
export function findDuplicateEdge(edges: readonly FreeEdge[], from: string, to: string): boolean {
  return edges.some(
    (x) => (x.from === from && x.to === to) || (x.from === to && x.to === from)
  );
}
