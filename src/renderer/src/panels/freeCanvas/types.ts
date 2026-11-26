/**
 * 自由视图画布的对外类型与手势内部状态契约。
 * 从 FreeCanvas.tsx 按画布职责拆出；对外符号（FreeCanvasItem/Handle/Props）经
 * panels/FreeCanvas.tsx 再导出，BoardPanel 的 import 路径不变。
 */
import type { Dispatch, MutableRefObject, PointerEvent as ReactPointerEvent, RefObject, SetStateAction } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { LiveStatusKind } from '../../../../shared/types';
import type { BoardStatus } from '../../../../shared/boardStatus';
import type { FreeEdgeKind, FreeGuide, FreePoint, FreePort, FreeRect, FreeSticky } from '../freeViewGeom';

/** 节点入参全原始值：会话 broadcast 全量刷时 memo 才挡得住（与 BoardCard 同策略） */
export interface FreeCanvasItem {
  /** Board-only TODO content; never resolves to a session or a running harness. */
  todoTask?: string;
  id: string;
  name: string;
  runtimeLabel: string;
  harnessId?: string;
  status: BoardStatus;
  liveLabel?: string;
  liveKind?: LiveStatusKind;
  liveSummary?: string;
  branch?: string;
  branchTitle?: string;
  workspaceName?: string;
  /** 活着的工作区 id；空字符串 = 未分区（无归属 / 已关闭） */
  zoneId: string;
  isActive: boolean;
  runtime?: string;
  forkSupport?: 'gui' | 'claude' | 'none';
  /** 需要你节点的未读态；非需要你不传 */
  needsUnread?: boolean;
  /** 调度编排会话：状态图标右上角小蓝点 */
  orchestrated?: boolean;
}

export type DragMode = 'node' | 'group' | 'pan' | 'marquee' | 'link';

export interface DragState {
  mode: DragMode;
  pointerId: number;
  button: number;
  startScreen: FreePoint;
  /** node/group：拖拽起始的指针世界坐标与各节点起始位 */
  startWorld?: FreePoint;
  nodeStarts?: Record<string, FreePoint>;
  ids?: string[];
  /** pan：起始相机 */
  startPan?: FreePoint;
  /** marquee：按住 shift 时的基础选集 */
  baseSel?: string[];
  /** link：源节点与拖出的四缘锚点 */
  linkFrom?: string;
  linkFromPort?: FreePort;
  /** node/group：主拖节点（pointer capture 后 e.target 失真，收拢选集要用） */
  primaryId?: string;
  moved: boolean;
}

/** 拉线拖出中的实时态（悬停目标与锚点） */
export interface LinkDragState {
  from: string;
  fromPort: FreePort;
  to: FreePoint;
  toOut: FreePoint;
  hoverId?: string;
  hoverPort?: FreePort;
}

/** 拉线拖到空白弹出的菜单落点与来源（raf 延挂，避免松手点击打在第一项上） */
export interface LinkMenuPayload {
  x: number;
  y: number;
  from: string;
  fromPort: FreePort;
  world: FreePoint;
}

/** 视口统一指针手势的依赖注入契约（useCanvasPointer） */
export interface CanvasPointerOptions {
  /** 视图当前是否在场（隐藏侧切回时清手势态） */
  active: boolean;
  selNodes: string[];
  setSelNodes: Dispatch<SetStateAction<string[]>>;
  setSelEdges: Dispatch<SetStateAction<string[]>>;
  setSelGroups: Dispatch<SetStateAction<string[]>>;
  visibleIdSet: ReadonlySet<string>;
  sessionIdSet: ReadonlySet<string>;
  stickyById: ReadonlyMap<string, FreeSticky>;
  /** 常驻渲染的便签（框选命中 / 拖拽静态物 / 拖拽写回） */
  stickies: FreeSticky[];
  hOf: (id: string) => number;
  rectOf: (id: string) => FreeRect | null;
  localPoint: (e: { clientX: number; clientY: number }) => FreePoint;
  toWorld: (sx: number, sy: number) => FreePoint;
  /** 备注编辑进行中：画布按下先提交 */
  noteEdit: { id: string; value: string } | null;
  commitNoteEdit: () => void;
  /** 画布按下：提前摘自动布局过渡并收撤销 toast */
  interruptArrange: () => void;
  /** 双击跳转会话（两次 pointerup 识别） */
  onSelectSession: (id: string) => void;
  /** 拉线菜单（useCanvasCreate 持有 raf 与 ref） */
  isLinkMenuOpen: () => boolean;
  cancelLinkMenuRequest: () => void;
  requestLinkMenu: (payload: LinkMenuPayload) => void;
  /** Space 平移态（useCanvasKeyboard 持有） */
  spaceRef: RefObject<boolean>;
}

/** useCanvasPointer 返回的手势态与四类指针事件处理器（视口 div 接线用） */
export interface CanvasPointerApi {
  dragRef: MutableRefObject<DragState | null>;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  guides: FreeGuide[];
  linkDrag: LinkDragState | null;
  hotZone: string | null;
  setHotZone: Dispatch<SetStateAction<string | null>>;
  rightPanMovedRef: MutableRefObject<boolean>;
  blankMovedRef: MutableRefObject<boolean>;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

export interface FreeCanvasHandle {
  startNoteEdit: (id: string) => void;
  clearNote: (id: string) => void;
  placeSession: (
    sessionId: string,
    world: FreePoint,
    from?: { id: string; port?: FreePort; kind?: FreeEdgeKind }
  ) => void;
}

export interface FreeCanvasProps {
  items: FreeCanvasItem[];
  /**
   * 全部未归档工作会话 id（含过滤隐藏的）。
   * 只用于补位/修剪——过滤不得丢掉隐藏节点的位置。
   */
  aliveIds: string[];
  /**
   * 全部未归档工作会话的分区归属（含过滤隐藏的；'' = 未分区）。
   * 一键自动布局按此聚簇——作用范围=全部节点，不能只看可见的 items。
   */
  zones: Record<string, string>;
  /** 侧栏工作区顺序（自动布局的簇排布顺序） */
  workspaceOrder: string[];
  /** 视图当前是否在场（xfade 常驻双视图：隐藏侧须停用键盘/滚轮手势） */
  active: boolean;
  onSelectSession: (id: string) => void;
  onContextMenu: (e: ReactMouseEvent, sessionId: string) => void;
  /** 双击空白 / 便签发起任务：打开 NewTaskDialog */
  onRequestCreate: (opts: {
    world: FreePoint;
    initialTask?: string;
    stickyId?: string;
    handover?: { draft: import('../../../../shared/canvasHandover').CanvasHandoverDraft; fromPort: FreePort };
  }) => void;
}
