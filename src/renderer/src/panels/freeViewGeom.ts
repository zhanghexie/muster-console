/**
 * 自由视图（全局看板画布）纯逻辑：类型、对齐吸附、自动布局、会话集同步、适配缩放、连线几何。
 * 自包含、无任何导入——test/free-view.mjs 用 typescript.transpileModule 直接转译导入，
 * 改这里的导出签名须同步改测试。
 */

export type FreeViewMode = 'status' | 'free';

/** Global board filter dimensions. `null` in the layout means select all. */
export type BoardFilterPanel = 'todo' | 'working' | 'needsYou' | 'done' | 'archived';
export const BOARD_FILTER_PANEL_ORDER: BoardFilterPanel[] = ['todo', 'working', 'needsYou', 'done', 'archived'];

export interface FreePoint {
  x: number;
  y: number;
}

export interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 节点间连线（会话/便签；fromPort/toPort 为四缘锚点，旧数据可缺省） */
export type FreePort = 'n' | 'e' | 's' | 'w';

/** 由创建来源写入：fork / 交接边常显类型徽标；缺省 = 纯连线或便签连线 */
export type FreeEdgeKind = 'fork' | 'handover';

export interface FreeEdge {
  id: string;
  from: string;
  to: string;
  fromPort?: FreePort;
  toPort?: FreePort;
  /** 自定义文本（自由层）；空/缺省不显示。类型徽标不存此字段 */
  label?: string;
  /** 仅 fork / 交接边写入；类型徽标由此派生，不另存展示文案 */
  kind?: FreeEdgeKind;
}

/** 思路便签（画布数据，与卡片备注 notes 分开：notes 是会话卡内备注） */
export interface FreeSticky {
  id: string;
  x: number;
  y: number;
  text: string;
}

/** 框选打组：组员各自保留位置，组框由成员 bbox 实时推导 */
export interface FreeGroup {
  id: string;
  label: string;
  members: string[];
}

export interface FreeViewLayout {
  version: 1;
  view: FreeViewMode;
  pan: FreePoint;
  zoom: number;
  /** 会话 id → 画布坐标（左上角，世界系） */
  nodes: Record<string, FreePoint>;
  edges: FreeEdge[];
  groups: FreeGroup[];
  /**
   * 全局看板「仅当前工作区」过滤。缺省 / 旧数据无此字段 = false（显示全部）。
   * 只影响渲染，不修剪 nodes。
   */
  filterActiveWorkspace: boolean;
  /** Selected workspace keys; null means all, empty string is the unassigned bucket. */
  filterWorkspaceIds: string[] | null;
  /** Selected board panels; null means all. */
  filterPanelIds: BoardFilterPanel[] | null;
  /** 会话 id → 画布备注（自由视图卡片内；缺省 {}） */
  notes: Record<string, string>;
  /**
   * 思路便签（独立节点，非会话）。缺省 / 旧数据无此字段 = []。
   * 不占用 `notes`：那是会话卡片内备注。
   */
  stickies: FreeSticky[];
}

export const FREE_NODE_W = 248;
/** 紧凑高度（无备注、无分支）：头像行 + meta + 内边距 */
export const FREE_NODE_H = 70;
/** 思路便签尺寸（与会话卡明显区分） */
export const FREE_STICKY_W = 176;
export const FREE_STICKY_H = 124;
export const FREE_NODE_GAP = 6;
export const FREE_NODE_BRANCH_H = 16;
/** 备注行高（与 caption 字阶对齐） */
export const FREE_NODE_NOTE_LINE = 16;
export const FREE_NODE_NOTE_MAX_LINES = 8;
/** 备注折行：内容宽约 224px，CJK=2 单位 / ASCII=1，满 40 单位换行 */
export const FREE_NODE_NOTE_WRAP = 40;
/** 自动布局网格步距（含 32px 间隙） */
export const FREE_GRID_X = FREE_NODE_W + 32;
export const FREE_GRID_Y = FREE_NODE_H + 32;
/** 自动布局每行节点数 */
export const FREE_GRID_COLS = 5;
export const FREE_ZOOM_MIN = 0.3;
export const FREE_ZOOM_MAX = 2;
/** 对齐吸附阈值（屏幕像素；世界系阈值 = 此值 / zoom） */
export const SNAP_THRESHOLD_PX = 6;
/** 组框外扩边距 */
export const GROUP_PADDING = 26;
/** 组框顶部标签区高度（含进组框总外扩） */
export const GROUP_LABEL_H = 28;
/** 工作区分区 hull 外扩（卡片 bbox → 气泡轮廓） */
export const HULL_PADDING = 28;
/** 分区凸包顶点圆角半径 */
export const HULL_CORNER_R = 22;
/** 分区标签相对 hull bbox 左上的内边距（对齐 .fc-group-label） */
export const HULL_LABEL_INSET_X = 10;
export const HULL_LABEL_INSET_Y = 5;
/** 一键自动布局：层间横向间距（连线方向左→右） */
export const AUTO_LAYER_GAP = 64;
/** 一键自动布局：同层纵向堆叠间距（孤立列同款）。卡片内部备注/分支行距用的是 FREE_NODE_GAP，别混用 */
export const AUTO_STACK_GAP = 20;
/** 一键自动布局：簇间呼吸间距（含 hull 标签空间，保证相邻气泡不粘连） */
export const AUTO_CLUSTER_GAP = 96;
/** 一键自动布局：行宽预算（世界坐标），簇排布超出则换行 */
export const AUTO_ARRANGE_ROW_W = 3200;

export function emptyFreeViewLayout(): FreeViewLayout {
  return {
    version: 1,
    view: 'status',
    pan: { x: 0, y: 0 },
    zoom: 1,
    nodes: {},
    edges: [],
    groups: [],
    filterActiveWorkspace: false,
    filterWorkspaceIds: null,
    filterPanelIds: null,
    notes: {},
    stickies: []
  };
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isPort(v: unknown): v is FreePort {
  return v === 'n' || v === 'e' || v === 's' || v === 'w';
}

export function isEdgeKind(v: unknown): v is FreeEdgeKind {
  return v === 'fork' || v === 'handover';
}

export function edgeKindOf(e: Pick<FreeEdge, 'kind'>): FreeEdgeKind | undefined {
  return isEdgeKind(e.kind) ? e.kind : undefined;
}

/**
 * 布局形状校验：只认严丝合缝的 v1 对象，否则整体弃用。
 * `filterActiveWorkspace` / new multi-select filters 缺省兼容——旧数据无此字段视为 false/all，不 bump version。
 * `notes` / `stickies` / 边上 fromPort/toPort / label / kind 同样缺省兼容
 * （无 notes → {}，无 stickies → []，无 port → 连线按中心自动选边，无 label/kind → 纯连线）。
 */
export function parseFreeViewLayout(v: unknown): FreeViewLayout | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return null;
  if (o.view !== 'status' && o.view !== 'free') return null;
  const pan = o.pan as Record<string, unknown> | undefined;
  if (
    typeof pan?.x !== 'number' ||
    typeof pan?.y !== 'number' ||
    typeof o.zoom !== 'number' ||
    typeof o.nodes !== 'object' ||
    o.nodes === null ||
    !Array.isArray(o.edges) ||
    !Array.isArray(o.groups)
  ) {
    return null;
  }
  const nodes: Record<string, FreePoint> = {};
  for (const [id, p] of Object.entries(o.nodes as Record<string, unknown>)) {
    const pt = p as Record<string, unknown>;
    if (typeof pt?.x === 'number' && typeof pt?.y === 'number') nodes[id] = { x: pt.x, y: pt.y };
  }
  const edges = (o.edges as unknown[]).flatMap((e): FreeEdge[] => {
    const x = e as Record<string, unknown>;
    if (!isId(x?.id) || !isId(x?.from) || !isId(x?.to)) return [];
    const edge: FreeEdge = { id: x.id, from: x.from, to: x.to };
    if (isPort(x.fromPort)) edge.fromPort = x.fromPort;
    if (isPort(x.toPort)) edge.toPort = x.toPort;
    if (typeof x.label === 'string' && x.label.trim()) edge.label = x.label;
    if (isEdgeKind(x.kind)) edge.kind = x.kind;
    return [edge];
  });
  const groups = (o.groups as unknown[]).filter(
    (g): g is FreeGroup => {
      const x = g as Record<string, unknown>;
      return isId(x?.id) && typeof x?.label === 'string' && Array.isArray(x?.members) && x.members.every(isId);
    }
  );
  const notes: Record<string, string> = {};
  if (typeof o.notes === 'object' && o.notes !== null && !Array.isArray(o.notes)) {
    for (const [id, n] of Object.entries(o.notes as Record<string, unknown>)) {
      if (typeof n === 'string') notes[id] = n;
    }
  }
  const stickies: FreeSticky[] = [];
  if (Array.isArray(o.stickies)) {
    for (const raw of o.stickies) {
      const x = raw as Record<string, unknown>;
      if (!isId(x?.id) || typeof x.x !== 'number' || typeof x.y !== 'number') continue;
      stickies.push({ id: x.id, x: x.x, y: x.y, text: typeof x.text === 'string' ? x.text : '' });
    }
  }
  return {
    version: 1,
    view: o.view,
    pan: { x: pan.x, y: pan.y },
    zoom: clampZoom(o.zoom),
    nodes,
    edges,
    groups,
    filterActiveWorkspace: o.filterActiveWorkspace === true,
    filterWorkspaceIds: Array.isArray(o.filterWorkspaceIds) && o.filterWorkspaceIds.every((id): id is string => typeof id === 'string')
      ? o.filterWorkspaceIds
      : null,
    filterPanelIds: Array.isArray(o.filterPanelIds) && o.filterPanelIds.every((id): id is BoardFilterPanel => BOARD_FILTER_PANEL_ORDER.includes(id as BoardFilterPanel))
      ? o.filterPanelIds as BoardFilterPanel[]
      : null,
    notes,
    stickies
  };
}

export function clampZoom(z: number): number {
  return Math.min(FREE_ZOOM_MAX, Math.max(FREE_ZOOM_MIN, z));
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function nodeRect(p: FreePoint, h = FREE_NODE_H, w = FREE_NODE_W): FreeRect {
  return { x: p.x, y: p.y, w, h };
}

export function stickyRect(s: Pick<FreeSticky, 'x' | 'y'>): FreeRect {
  return { x: s.x, y: s.y, w: FREE_STICKY_W, h: FREE_STICKY_H };
}

/** 备注折行行数（含显式换行；空串为 0；上限 NOTE_MAX_LINES） */
export function estimateNoteLines(text: string): number {
  const raw = text.replace(/\s+$/g, '');
  if (!raw) return 0;
  let n = 0;
  for (const line of raw.split('\n')) {
    n += Math.max(1, wrapUnits(line));
    if (n >= FREE_NODE_NOTE_MAX_LINES) return FREE_NODE_NOTE_MAX_LINES;
  }
  return n;
}

function wrapUnits(line: string): number {
  let units = 0;
  let rows = 1;
  for (const ch of line) {
    const u = ch.charCodeAt(0) > 0xff ? 2 : 1;
    if (units + u > FREE_NODE_NOTE_WRAP && units > 0) {
      rows++;
      units = u;
    } else {
      units += u;
    }
  }
  return rows;
}

/** 卡片高度：紧凑底 + 可选分支行 + 可选任务行；有备注或正在编辑时再加折行 */
export function nodeHeightOf(
  note?: string,
  hasBranch = false,
  editing = false,
  taskRows = 0
): number {
  let h = FREE_NODE_H;
  if (hasBranch) h += FREE_NODE_GAP + FREE_NODE_BRANCH_H;
  if (taskRows > 0) h += taskRows * (FREE_NODE_GAP + FREE_NODE_BRANCH_H);
  const lines = Math.max(editing ? 1 : 0, estimateNoteLines(note ?? ''));
  if (lines > 0) h += FREE_NODE_GAP + lines * FREE_NODE_NOTE_LINE;
  return h;
}

export interface ResolveArrangeHeightsInput {
  sessionIds: readonly string[];
  notes?: Record<string, string>;
  hasBranch?: Record<string, boolean>;
  /** 画布实测高度优先（内容撑开后的真实盒）；≤0 / 缺省回落估算 */
  measured?: Record<string, number>;
}

/**
 * 自动布局用高度表：每个会话都有值。
 * 实测优先（胶囊/折行/分支等估算对不上的情况），否则按备注+分支估算。
 * 调用方不得只遍历 notes——没备注的卡也要进表，否则会一律回落 FREE_NODE_H。
 */
export function resolveArrangeHeights(input: ResolveArrangeHeightsInput): Record<string, number> {
  const out: Record<string, number> = {};
  const notes = input.notes ?? {};
  const hasBranch = input.hasBranch ?? {};
  const measured = input.measured ?? {};
  for (const id of input.sessionIds) {
    const m = measured[id];
    out[id] = typeof m === 'number' && m > 0 ? m : nodeHeightOf(notes[id], hasBranch[id] === true);
  }
  return out;
}

export function rectsIntersect(a: FreeRect, b: FreeRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function bboxOf(rects: FreeRect[]): FreeRect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 对齐参考线：axis 轴上的吸附线坐标 at，另一轴上的可见区段 [from, to] */
export interface FreeGuide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: FreeGuide[];
}

/**
 * 拖拽吸附（Figma 式）：被拖 bbox 的左/中/右（上/中/下）对齐其他节点的对应参考线，
 * 阈值内取最近者；返回位置修正量与命中的参考线（供渲染）。
 */
export function snapDrag(
  dragRect: FreeRect,
  staticRects: FreeRect[],
  threshold: number
): SnapResult {
  let bestDx = 0;
  let bestDy = 0;
  let bestDxAbs = threshold + 1;
  let bestDyAbs = threshold + 1;
  let guideX: FreeGuide | null = null;
  let guideY: FreeGuide | null = null;
  const myX = [dragRect.x, dragRect.x + dragRect.w / 2, dragRect.x + dragRect.w];
  const myY = [dragRect.y, dragRect.y + dragRect.h / 2, dragRect.y + dragRect.h];
  for (const s of staticRects) {
    const sx = [s.x, s.x + s.w / 2, s.x + s.w];
    const sy = [s.y, s.y + s.h / 2, s.y + s.h];
    for (const a of myX) {
      for (const b of sx) {
        const dAbs = Math.abs(b - a);
        if (dAbs <= threshold && dAbs < bestDxAbs) {
          bestDxAbs = dAbs;
          bestDx = b - a;
          guideX = {
            axis: 'x',
            at: b,
            from: Math.min(s.y, dragRect.y),
            to: Math.max(s.y + s.h, dragRect.y + dragRect.h)
          };
        }
      }
    }
    for (const a of myY) {
      for (const b of sy) {
        const dAbs = Math.abs(b - a);
        if (dAbs <= threshold && dAbs < bestDyAbs) {
          bestDyAbs = dAbs;
          bestDy = b - a;
          guideY = {
            axis: 'y',
            at: b,
            from: Math.min(s.x, dragRect.x),
            to: Math.max(s.x + s.w, dragRect.x + dragRect.w)
          };
        }
      }
    }
  }
  const guides: FreeGuide[] = [];
  if (guideX) guides.push(guideX);
  if (guideY) guides.push(guideY);
  return { dx: bestDx, dy: bestDy, guides };
}

/**
 * 自动布局：给没有位置的会话分配网格位（行优先，跳过被占/相交的格子）。
 * 返回新增的节点位（不含 existing）。
 */
export function autoPlace(
  existing: Record<string, FreePoint>,
  ids: readonly string[],
  heights: Record<string, number> = {}
): Record<string, FreePoint> {
  const add: Record<string, FreePoint> = {};
  const taken: FreeRect[] = Object.entries(existing).map(([id, p]) => nodeRect(p, heights[id]));
  for (const id of ids) {
    if (existing[id] || add[id]) continue;
    let placed = false;
    const nh = heights[id] ?? FREE_NODE_H;
    for (let idx = 0; idx < 5000 && !placed; idx++) {
      const col = idx % FREE_GRID_COLS;
      const row = Math.floor(idx / FREE_GRID_COLS);
      const p = { x: col * FREE_GRID_X, y: row * FREE_GRID_Y };
      const r = nodeRect(p, nh);
      if (!taken.some((t) => rectsIntersect(t, r))) {
        add[id] = p;
        taken.push(r);
        placed = true;
      }
    }
    if (!placed) {
      // 兜底：格子耗尽（不可能路径），叠放到下一空行行首
      const fallback = { x: 0, y: Math.ceil(taken.length / FREE_GRID_COLS) * FREE_GRID_Y };
      add[id] = fallback;
      taken.push(nodeRect(fallback, nh));
    }
  }
  return add;
}

/**
 * 一键自动布局的输入：全部会话与便签、全部连线、工作区侧栏顺序。
 * 会话 zoneId 取空串或不在 workspaceOrder（已关闭工作区）→「未分区」簇。
 */
export interface AutoArrangeInput {
  /** 全部未归档工作会话（含被过滤隐藏的——作用范围=全部节点） */
  sessions: readonly { readonly id: string; readonly zoneId: string }[];
  /** 全部思路便签 */
  stickies: readonly FreeSticky[];
  /** 全部连线（跨区连线不参与聚簇与分层，布局后照常绘制） */
  edges: readonly FreeEdge[];
  /** 侧栏工作区顺序（决定簇排布顺序；「未分区」固定垫底） */
  workspaceOrder: readonly string[];
  /** 会话卡实际高度（resolveArrangeHeights / 实测）；缺省 FREE_NODE_H。便签恒 FREE_STICKY_H */
  heights?: Record<string, number>;
}

/** 一键自动布局的输出：会话与便签的新位置表（只动位置，edges/groups/notes 不变） */
export interface AutoArrangeResult {
  nodes: Record<string, FreePoint>;
  stickyPos: Record<string, FreePoint>;
}

/**
 * 一键自动布局（自包含纯函数，必须确定性：同样输入永远产出同样结果）。
 * 1) 会话按 workspaceId 聚簇，便签挂连线对端会话所在簇（多数票，平票取第一条边）；
 * 2) 簇内把连线当有向边（左→右）longest-path 分层（DFS 破环：回边不计层），
 *    便签视作图中节点参与分层；同层重心法扫掠降交叉（tie-break id 字典序）；
 *    同层纵向紧凑堆叠（实际高度 + AUTO_STACK_GAP）；簇内无连线节点在簇尾网格补位；
 * 3) 簇包围盒用 workspaceHullOf 的 bbox（已含 hull 外扩 28px），簇间按侧栏工作区顺序
 *    逐行排布（行宽超 AUTO_ARRANGE_ROW_W 换行），「未分区」垫底，簇间距 AUTO_CLUSTER_GAP。
 */
export function autoArrange(input: AutoArrangeInput): AutoArrangeResult {
  const nodes: Record<string, FreePoint> = {};
  const stickyPos: Record<string, FreePoint> = {};

  // ---------- 分簇（zone='' = 未分区） ----------
  const zoneOfSession = new Map<string, string>();
  const sessionH = new Map<string, number>();
  const order = input.workspaceOrder;
  const sessionIds = input.sessions
    .map((s) => s.id)
    .sort();
  for (const s of input.sessions) {
    zoneOfSession.set(s.id, order.includes(s.zoneId) ? s.zoneId : '');
    sessionH.set(s.id, input.heights?.[s.id] ?? FREE_NODE_H);
  }
  const stickyIds = input.stickies.map((s) => s.id).sort();
  const stickySet = new Set(stickyIds);

  // 便签归簇：对每条「便签↔会话」边向对端会话的簇投一票；多数取胜，平票保首见（edges 数组序）
  const zoneOfSticky = new Map<string, string>();
  const votes = new Map<string, Map<string, number>>();
  for (const e of input.edges) {
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from]
    ]) {
      const zone = zoneOfSession.get(b);
      if (zone === undefined || !stickySet.has(a)) continue;
      let m = votes.get(a);
      if (!m) {
        m = new Map();
        votes.set(a, m);
      }
      m.set(zone, (m.get(zone) ?? 0) + 1);
    }
  }
  for (const id of stickyIds) {
    const m = votes.get(id);
    let best: string | null = null;
    let bestN = 0;
    if (m) {
      for (const [zone, n] of m) {
        if (n > bestN) {
          best = zone;
          bestN = n;
        }
      }
    }
    zoneOfSticky.set(id, best ?? '');
  }

  const zoneMembers = new Map<string, string[]>();
  const addMember = (zone: string, id: string): void => {
    let list = zoneMembers.get(zone);
    if (!list) {
      list = [];
      zoneMembers.set(zone, list);
    }
    list.push(id);
  };
  for (const id of sessionIds) addMember(zoneOfSession.get(id) ?? '', id);
  for (const id of stickyIds) addMember(zoneOfSticky.get(id) ?? '', id);
  for (const list of zoneMembers.values()) list.sort();

  // ---------- 簇内布局（局部坐标），再按 bbox 逐行排布 ----------
  const zoneKeys = [
    ...order.filter((z) => zoneMembers.has(z)),
    ...(zoneMembers.has('') ? [''] : [])
  ];

  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const zone of zoneKeys) {
    const members = zoneMembers.get(zone)!;
    const stickyOf = (id: string): boolean => stickySet.has(id);
    const widthOf = (id: string): number => (stickyOf(id) ? FREE_STICKY_W : FREE_NODE_W);
    const hOf = (id: string): number =>
      stickyOf(id) ? FREE_STICKY_H : (sessionH.get(id) ?? FREE_NODE_H);

    // 同簇内边：去自环；同一对节点只取第一条方向（含双向边互指的情形）
    const memberSet = new Set(members);
    const predsOf = new Map<string, string[]>();
    const succsOf = new Map<string, string[]>();
    for (const id of members) {
      predsOf.set(id, []);
      succsOf.set(id, []);
    }
    const seenPair = new Set<string>();
    for (const e of input.edges) {
      if (e.from === e.to || !memberSet.has(e.from) || !memberSet.has(e.to)) continue;
      const key = e.from < e.to ? `${e.from}\n${e.to}` : `${e.to}\n${e.from}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      predsOf.get(e.to)!.push(e.from);
      succsOf.get(e.from)!.push(e.to);
    }

    // longest-path 分层：DFS 破环（灰色 = 在栈，回边不计层），禁死循环
    const layer = new Map<string, number>();
    const color = new Map<string, 0 | 1 | 2>();
    for (const id of members) color.set(id, 0);
    const visit = (id: string): number => {
      const c = color.get(id);
      if (c === 2) return layer.get(id)!;
      if (c === 1) return layer.get(id) ?? 0;
      color.set(id, 1);
      let best = 0;
      for (const p of predsOf.get(id)!) {
        if (color.get(p) === 1) continue; // 回边不计层
        best = Math.max(best, visit(p) + 1);
      }
      color.set(id, 2);
      layer.set(id, best);
      return best;
    };
    for (const id of members) visit(id);

    const layers = new Map<number, string[]>();
    for (const id of members) {
      const l = layer.get(id)!;
      let arr = layers.get(l);
      if (!arr) {
        arr = [];
        layers.set(l, arr);
      }
      arr.push(id);
    }
    const layerIds = [...layers.keys()].sort((a, b) => a - b);
    for (const l of layerIds) layers.get(l)!.sort();

    // 重心法降交叉：4 轮上/下扫掠；无邻居节点用自身当前位次；tie-break id 字典序。
    // 每排完一层必须立即刷新位次——同扫掠内的下一层要用新位次，
    // 否则下行/上行各自基于旧位次互相抵消，偶数轮正好退回交叉态（实测回归）。
    const indexIn = new Map<string, number>();
    const rebuildIndex = (): void => {
      indexIn.clear();
      for (const l of layerIds) {
        layers.get(l)!.forEach((id, i) => indexIn.set(id, i));
      }
    };
    const SWEEPS = 4;
    for (let s = 0; s < SWEEPS; s++) {
      rebuildIndex();
      const sweepOrder = s % 2 === 0 ? layerIds : [...layerIds].reverse();
      for (const l of sweepOrder) {
        const keyed = layers.get(l)!.map((id) => {
          const neighbors = [...predsOf.get(id)!, ...succsOf.get(id)!];
          let bc: number;
          if (neighbors.length === 0) {
            bc = indexIn.get(id) ?? 0;
          } else {
            let sum = 0;
            for (const n of neighbors) sum += indexIn.get(n) ?? 0;
            bc = sum / neighbors.length;
          }
          return { id, bc };
        });
        keyed.sort((a, b) => a.bc - b.bc || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        layers.set(l, keyed.map((k) => k.id));
        keyed.forEach((k, i) => indexIn.set(k.id, i));
      }
    }

    // 簇内无连线节点：单列竖排垫在簇首（左侧），行距与同层堆叠同款（实际高度 + AUTO_STACK_GAP）；
    // 有层级的分层内容整体右移让位
    const isolated = members.filter(
      (id) => predsOf.get(id)!.length === 0 && succsOf.get(id)!.length === 0
    );
    const layeredX =
      isolated.length > 0 ? Math.max(...isolated.map(widthOf)) + AUTO_LAYER_GAP : 0;

    // 层内坐标：层 x 按各层最大宽步进（AUTO_LAYER_GAP），节点在层内水平居中；
    // 同层纵向堆叠（实际高度 + AUTO_STACK_GAP）
    const pos = new Map<string, FreePoint>();
    let lx = 0;
    for (const l of layerIds) {
      const lw = Math.max(...layers.get(l)!.map(widthOf));
      let y = 0;
      for (const id of layers.get(l)!) {
        pos.set(id, { x: layeredX + lx + (lw - widthOf(id)) / 2, y });
        y += hOf(id) + AUTO_STACK_GAP;
      }
      lx += lw + AUTO_LAYER_GAP;
    }

    // 纵向居中收敛：节点朝邻层邻居的中心靠拢（连线尽量水平拉直）。
    // 上下各一轮（与重心法同款扫掠方向）；层内保持既有次序、间距不重叠；
    // 无邻居节点原地不动。居中可能把堆叠顶推成负数，最后分层内容 min-y 归零。
    // 注意 centerY 不能叫 cy——外层簇排布的行游标就叫 cy，重名会遮蔽成字符串拼接
    const centerY = new Map<string, number>();
    for (const l of layerIds) {
      for (const id of layers.get(l)!) centerY.set(id, pos.get(id)!.y + hOf(id) / 2);
    }
    const neighborsCenterAvg = (id: string): number | null => {
      const ns = [...predsOf.get(id)!, ...succsOf.get(id)!];
      if (ns.length === 0) return null;
      let sum = 0;
      for (const n of ns) sum += centerY.get(n) ?? 0;
      return sum / ns.length;
    };
    for (let pass = 0; pass < 2; pass++) {
      const sweep = pass === 0 ? layerIds : [...layerIds].reverse();
      for (const l of sweep) {
        let prevBottom = -Infinity;
        for (const id of layers.get(l)!) {
          const h = hOf(id);
          const want = neighborsCenterAvg(id);
          let y = (want ?? centerY.get(id)!) - h / 2;
          if (y < prevBottom + AUTO_STACK_GAP) y = prevBottom + AUTO_STACK_GAP;
          pos.set(id, { x: pos.get(id)!.x, y });
          centerY.set(id, y + h / 2);
          prevBottom = y + h;
        }
      }
    }
    // 居中可能把堆叠顶推成负数：分层内容 min-y 归零（孤立列在其后另从 0 起排，不受影响）
    let minY = Infinity;
    for (const l of layerIds) {
      for (const id of layers.get(l)!) minY = Math.min(minY, pos.get(id)!.y);
    }
    if (Number.isFinite(minY) && minY !== 0) {
      for (const l of layerIds) {
        for (const id of layers.get(l)!) {
          const p = pos.get(id)!;
          pos.set(id, { x: p.x, y: p.y - minY });
        }
      }
    }

    if (isolated.length > 0) {
      let y = 0;
      for (const id of isolated) {
        pos.set(id, { x: 0, y });
        y += hOf(id) + AUTO_STACK_GAP;
      }
    }

    // 簇包围盒：复用 hull 几何（已含 HULL_PADDING 外扩；便签按节点宽 248 估，只会更松）
    const hull = workspaceHullOf(
      members.map((id) => pos.get(id)!),
      members.map((id) => hOf(id))
    );
    if (!hull) continue;

    // 簇间排布：行内从左到右，超出预算宽度换行（行距/列距都是 AUTO_CLUSTER_GAP）
    if (cx > 0 && cx + hull.bbox.w > AUTO_ARRANGE_ROW_W) {
      cy += rowH + AUTO_CLUSTER_GAP;
      cx = 0;
      rowH = 0;
    }
    for (const id of members) {
      const p = pos.get(id)!;
      const abs = { x: p.x + cx, y: p.y + cy };
      if (stickyOf(id)) stickyPos[id] = abs;
      else nodes[id] = abs;
    }
    cx += hull.bbox.w + AUTO_CLUSTER_GAP;
    rowH = Math.max(rowH, hull.bbox.h);
  }

  return { nodes, stickyPos };
}

/**
 * 会话集同步：给新会话补位、剪掉已消失会话的节点 / 连带连线 / 分组成员与空组。
 * 便签 stickies 保留（不是会话）；连线两端只要还是活会话或便签就保留。
 * 无变化返回 null（调用方借此避免无谓写盘）。
 */
export function syncLayoutNodes(
  layout: FreeViewLayout,
  aliveIds: readonly string[]
): FreeViewLayout | null {
  const notesIn = layout.notes ?? {};
  const stickies = layout.stickies ?? [];
  const stickyIds = new Set(stickies.map((s) => s.id));
  const alive = new Set(aliveIds);
  const dead = Object.keys(layout.nodes).filter((id) => !alive.has(id));
  const missing = aliveIds.filter((id) => !layout.nodes[id]);
  const staleNotes = Object.keys(notesIn).filter((id) => !alive.has(id));
  const endpointAlive = (id: string): boolean =>
    (layout.nodes[id] != null && alive.has(id)) || stickyIds.has(id);
  const staleEdges = layout.edges.some((e) => !endpointAlive(e.from) || !endpointAlive(e.to));
  if (dead.length === 0 && missing.length === 0 && staleNotes.length === 0 && !staleEdges) {
    return null;
  }
  const nodes = { ...layout.nodes };
  for (const id of dead) delete nodes[id];
  const heights: Record<string, number> = {};
  for (const id of Object.keys(nodes)) heights[id] = nodeHeightOf(notesIn[id]);
  Object.assign(nodes, autoPlace(nodes, missing, heights));
  const endpointOk = (id: string): boolean => nodes[id] != null || stickyIds.has(id);
  const edges = layout.edges.filter((e) => endpointOk(e.from) && endpointOk(e.to));
  const groups = layout.groups
    .map((g) => ({ ...g, members: g.members.filter((m) => nodes[m] != null) }))
    .filter((g) => g.members.length > 0);
  const notes = { ...notesIn };
  for (const id of staleNotes) delete notes[id];
  return { ...layout, nodes, edges, groups, notes, stickies };
}

/** 适配内容：内容 bbox 居中放进视口（zoom 不超过 1） */
export function fitToRect(
  box: FreeRect,
  vw: number,
  vh: number,
  padding = 80
): { pan: FreePoint; zoom: number } {
  if (box.w <= 0 || box.h <= 0 || vw <= 0 || vh <= 0) {
    return { pan: { x: vw / 2, y: vh / 2 }, zoom: 1 };
  }
  const zoom = clampZoom(
    Math.min(1, (vw - padding * 2) / box.w, (vh - padding * 2) / box.h)
  );
  return {
    pan: {
      x: (vw - box.w * zoom) / 2 - box.x * zoom,
      y: (vh - box.h * zoom) / 2 - box.y * zoom
    },
    zoom
  };
}

/** 组框：成员 bbox + 边距 + 顶部标签区 */
export function groupBoxOf(
  members: readonly FreePoint[],
  heights?: readonly number[]
): FreeRect | null {
  const box = bboxOf(members.map((p, i) => nodeRect(p, heights?.[i])));
  if (!box) return null;
  return {
    x: box.x - GROUP_PADDING,
    y: box.y - GROUP_PADDING - GROUP_LABEL_H,
    w: box.w + GROUP_PADDING * 2,
    h: box.h + GROUP_PADDING * 2 + GROUP_LABEL_H
  };
}

function hypot2(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}

function unit2(dx: number, dy: number): FreePoint {
  const len = hypot2(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function cross(o: FreePoint, a: FreePoint, b: FreePoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function lineIntersect(p: FreePoint, d: FreePoint, q: FreePoint, e: FreePoint): FreePoint | null {
  const det = d.x * e.y - d.y * e.x;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / det;
  return { x: p.x + t * d.x, y: p.y + t * d.y };
}

/** 边的单位外法线：垂直于 ab、背离 centroid */
function perpAway(a: FreePoint, b: FreePoint, cx: number, cy: number): FreePoint {
  const n = unit2(b.y - a.y, a.x - b.x);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if ((cx - mx) * n.x + (cy - my) * n.y > 0) return { x: -n.x, y: -n.y };
  return n;
}

function bboxOfPoints(pts: readonly FreePoint[]): FreeRect | null {
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Andrew 单调链凸包（含共线端点、丢弃中间共线点）。坐标系任意。 */
export function convexHull(points: readonly FreePoint[]): FreePoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const uniq: FreePoint[] = [];
  for (const p of sorted) {
    const last = uniq[uniq.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) uniq.push(p);
  }
  if (uniq.length <= 2) return uniq;
  const lower: FreePoint[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: FreePoint[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 凸多边形外扩 padding。n<3 回落为圆角矩形的 4 顶点。 */
export function offsetConvex(hull: readonly FreePoint[], padding: number): FreePoint[] {
  const n = hull.length;
  if (n === 0) return [];
  if (n === 1) {
    const p = hull[0];
    return [
      { x: p.x - padding, y: p.y - padding },
      { x: p.x + padding, y: p.y - padding },
      { x: p.x + padding, y: p.y + padding },
      { x: p.x - padding, y: p.y + padding }
    ];
  }
  if (n === 2) {
    const a = hull[0];
    const b = hull[1];
    const t = unit2(b.x - a.x, b.y - a.y);
    const nr = { x: t.y, y: -t.x };
    return [
      { x: a.x - t.x * padding + nr.x * padding, y: a.y - t.y * padding + nr.y * padding },
      { x: b.x + t.x * padding + nr.x * padding, y: b.y + t.y * padding + nr.y * padding },
      { x: b.x + t.x * padding - nr.x * padding, y: b.y + t.y * padding - nr.y * padding },
      { x: a.x - t.x * padding - nr.x * padding, y: a.y - t.y * padding - nr.y * padding }
    ];
  }
  let cx = 0;
  let cy = 0;
  for (const p of hull) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  const out: FreePoint[] = [];
  for (let i = 0; i < n; i++) {
    const prev = hull[(i - 1 + n) % n];
    const curr = hull[i];
    const next = hull[(i + 1) % n];
    const n1 = perpAway(prev, curr, cx, cy);
    const n2 = perpAway(curr, next, cx, cy);
    const p1 = { x: curr.x + n1.x * padding, y: curr.y + n1.y * padding };
    const d1 = { x: curr.x - prev.x, y: curr.y - prev.y };
    const p2 = { x: curr.x + n2.x * padding, y: curr.y + n2.y * padding };
    const d2 = { x: next.x - curr.x, y: next.y - curr.y };
    out.push(lineIntersect(p1, d1, p2, d2) ?? { x: curr.x + n1.x * padding, y: curr.y + n1.y * padding });
  }
  return out;
}

function r1(n: number): string {
  return Math.round(n * 10) / 10 + '';
}

/**
 * 凸包顶点圆角化：每顶点沿两侧边内缩 min(radius, 边长/2)，二次贝塞尔以原顶点为控制点。
 * 外扩后再圆角，曲线仍包在卡片外侧。
 */
export function roundedHullPath(verts: readonly FreePoint[], radius: number): string {
  const n = verts.length;
  if (n === 0) return '';
  if (n === 1) {
    const p = verts[0];
    const rr = Math.max(radius, 1);
    return `M ${r1(p.x + rr)} ${r1(p.y)} A ${r1(rr)} ${r1(rr)} 0 1 1 ${r1(p.x - rr)} ${r1(p.y)} A ${r1(rr)} ${r1(rr)} 0 1 1 ${r1(p.x + rr)} ${r1(p.y)} Z`;
  }
  if (n === 2) return roundedHullPath(offsetConvex(verts, 0), radius);
  let d = '';
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n];
    const curr = verts[i];
    const next = verts[(i + 1) % n];
    const lenIn = hypot2(curr.x - prev.x, curr.y - prev.y);
    const lenOut = hypot2(next.x - curr.x, next.y - curr.y);
    const rr = Math.min(radius, lenIn / 2, lenOut / 2);
    const v1 = unit2(curr.x - prev.x, curr.y - prev.y);
    const v2 = unit2(next.x - curr.x, next.y - curr.y);
    const p1 = { x: curr.x - v1.x * rr, y: curr.y - v1.y * rr };
    const p2 = { x: curr.x + v2.x * rr, y: curr.y + v2.y * rr };
    d += i === 0 ? `M ${r1(p1.x)} ${r1(p1.y)}` : ` L ${r1(p1.x)} ${r1(p1.y)}`;
    d += ` Q ${r1(curr.x)} ${r1(curr.y)} ${r1(p2.x)} ${r1(p2.y)}`;
  }
  return `${d} Z`;
}

export interface WorkspaceHull {
  path: string;
  bbox: FreeRect;
  labelX: number;
  labelY: number;
  /** 外扩后的凸包顶点（测试 / 命中用） */
  vertices: FreePoint[];
}

/**
 * 工作区分区气泡：成员卡片四角求凸包 → 外扩 padding → 顶点圆角。
 * 不持久化几何；成员为空返回 null。
 */
export function workspaceHullOf(
  members: readonly FreePoint[],
  heights?: readonly number[]
): WorkspaceHull | null {
  if (members.length === 0) return null;
  const corners: FreePoint[] = [];
  for (let i = 0; i < members.length; i++) {
    const r = nodeRect(members[i], heights?.[i]);
    corners.push(
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h }
    );
  }
  const hull = convexHull(corners);
  const vertices = offsetConvex(hull, HULL_PADDING);
  const bbox = bboxOfPoints(vertices);
  if (!bbox) return null;
  return {
    path: roundedHullPath(vertices, HULL_CORNER_R),
    bbox,
    labelX: bbox.x + HULL_LABEL_INSET_X,
    labelY: bbox.y + HULL_LABEL_INSET_Y,
    vertices
  };
}

export interface EdgeAnchors {
  a: FreePoint;
  /** a 侧朝外法线（单位向量） */
  aOut: FreePoint;
  b: FreePoint;
  bOut: FreePoint;
}

export function portAnchor(r: FreeRect, port: FreePort): { p: FreePoint; out: FreePoint } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  switch (port) {
    case 'n':
      return { p: { x: cx, y: r.y }, out: { x: 0, y: -1 } };
    case 's':
      return { p: { x: cx, y: r.y + r.h }, out: { x: 0, y: 1 } };
    case 'e':
      return { p: { x: r.x + r.w, y: cy }, out: { x: 1, y: 0 } };
    case 'w':
      return { p: { x: r.x, y: cy }, out: { x: -1, y: 0 } };
  }
}

/** 世界坐标到矩形四缘中点的最近锚点 */
export function nearestPort(r: FreeRect, p: FreePoint): FreePort {
  const ports: FreePort[] = ['n', 'e', 's', 'w'];
  let best: FreePort = 'e';
  let bestD = Infinity;
  for (const port of ports) {
    const a = portAnchor(r, port).p;
    const d = (a.x - p.x) * (a.x - p.x) + (a.y - p.y) * (a.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = port;
    }
  }
  return best;
}

/**
 * 连线锚点：两端都指定 port 时用四缘圆点；否则按两节点中心相对方向自动取相对侧。
 */
export function edgeAnchors(
  ra: FreeRect,
  rb: FreeRect,
  fromPort?: FreePort,
  toPort?: FreePort
): EdgeAnchors {
  if (fromPort && toPort) {
    const a = portAnchor(ra, fromPort);
    const b = portAnchor(rb, toPort);
    return { a: a.p, aOut: a.out, b: b.p, bOut: b.out };
  }
  const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
  const cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const rightward = dx >= 0;
    return {
      a: { x: rightward ? ra.x + ra.w : ra.x, y: ca.y },
      aOut: { x: rightward ? 1 : -1, y: 0 },
      b: { x: rightward ? rb.x : rb.x + rb.w, y: cb.y },
      bOut: { x: rightward ? -1 : 1, y: 0 }
    };
  }
  const downward = dy >= 0;
  return {
    a: { x: ca.x, y: downward ? ra.y + ra.h : ra.y },
    aOut: { x: 0, y: downward ? 1 : -1 },
    b: { x: cb.x, y: downward ? rb.y : rb.y + rb.h },
    bOut: { x: 0, y: downward ? -1 : 1 }
  };
}

function bezierControls(
  a: FreePoint,
  aOut: FreePoint,
  b: FreePoint,
  bOut: FreePoint
): { c1: FreePoint; c2: FreePoint } {
  const dist = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  const d = Math.min(Math.max(dist * 0.4, 40), 160);
  return {
    c1: { x: a.x + aOut.x * d, y: a.y + aOut.y * d },
    c2: { x: b.x + bOut.x * d, y: b.y + bOut.y * d }
  };
}

/** 三次贝塞尔路径：控制点沿两侧法线伸出，伸出量随距离自适应并夹在 [40, 160] */
export function bezierPath(a: FreePoint, aOut: FreePoint, b: FreePoint, bOut: FreePoint): string {
  const { c1, c2 } = bezierControls(a, aOut, b, bOut);
  const r = (n: number): string => Math.round(n * 10) / 10 + '';
  return `M ${r(a.x)} ${r(a.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(b.x)} ${r(b.y)}`;
}

/** 三次贝塞尔中点（t=0.5），连线标签锚点 */
export function bezierMidpoint(a: FreePoint, aOut: FreePoint, b: FreePoint, bOut: FreePoint): FreePoint {
  const { c1, c2 } = bezierControls(a, aOut, b, bOut);
  return {
    x: 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x,
    y: 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y
  };
}

/** 终点切线方向（箭头朝向）：终点指向控制点 c2 的反方向 */
export function endTangent(b: FreePoint, bOut: FreePoint): FreePoint {
  return { x: -bOut.x, y: -bOut.y };
}
