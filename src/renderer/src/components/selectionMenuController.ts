/**
 * 全局划词菜单单例控制器（无 React 依赖）。
 *
 * 全应用只有一个浮条实例（SelectionMenuHost 渲染），两个选区来源：
 * - 'dom'：宿主监听 document mouseup + window.getSelection()（Agent 会话、文件预览、Diff 等）
 * - 'xterm'：TerminalView 在松手后用 term.getSelection() 主动上报
 *
 * 区域（area）由 data-sel-area 属性解析，菜单项由 selectionMenuAreas.ts 的注册表按区域构建；
 * 区域专属能力（终端的粘贴进输入/还焦点/清选区）经 context 回调包注入，宿主与展示层互不感知。
 */

export type SelectionMenuSource = 'dom' | 'xterm';

/** 区域回调包：show 方注入，区域 builder / 收尾逻辑消费 */
export interface SelectionAreaContext {
  /** 选区来源的标签作用域，异步打开时不借用前台会话。 */
  rightOwner?: import('../chatSurface/chatLinkOwner').ChatLinkOwner;
  /** 选区所属工作目录（路径识别/拖拽解析用）；DOM 区域由宿主统一给工作区根 */
  cwd?: string;
  /** 复制选区并粘贴进终端输入（终端专属） */
  paste?: (text: string) => void;
  /** CLI 会话选区写入工作台的批注草稿。 */
  annotate?: (text: string) => void;
  /** 清掉宿主自身选区（xterm clearSelection；DOM 源由宿主兜底 removeAllRanges） */
  clearSelection?: () => void;
  /** 每个菜单动作完成后回调（终端：把焦点还给 xterm，快捷键不失效） */
  keepFocus?: () => void;
}

export interface SelectionMenuState {
  source: SelectionMenuSource;
  /** data-sel-area 解析出的区域 id（terminal / agent-chat / file-editor / diff / default…） */
  area: string;
  /** 上报源实例标识（xterm=sessionId）；定向 dismiss 只关自己唤起的浮条，防多终端互串 */
  owner?: string;
  text: string;
  /** 视口坐标：划词松手时的指针位置，浮条锚在这里 */
  anchor: { x: number; y: number };
  /** DOM host for page ownership, including selections made inside a guest or xterm. */
  anchorElement?: Element;
  /** 选区被裁切/遮挡时暂隐；保留菜单，滚回可见区域后恢复。 */
  hidden?: boolean;
  context?: SelectionAreaContext;
}

export interface SelectionBangState {
  text: string;
  cwd?: string;
  /** 「爆炸」按钮的视口纵向位置，面板顶部尽量贴过去；横向仍居中 */
  originTop?: number;
  /** 打开浮条时携带的区域回调（关闭时清宿主选区用） */
  context?: SelectionAreaContext;
}

export interface SelectionUiState {
  menu: SelectionMenuState | null;
  bang: SelectionBangState | null;
}

let state: SelectionUiState = { menu: null, bang: null };
const listeners = new Set<() => void>();

function emit(next: SelectionUiState): void {
  state = next;
  for (const fn of listeners) fn();
}

export function subscribeSelectionUi(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function readSelectionUi(): SelectionUiState {
  return state;
}

export function isSelectionBangOpen(): boolean {
  return state.bang != null;
}

/** 展示浮条；「爆炸」浮层打开期间忽略（对应原终端 !bangOpen 条件） */
export function showSelectionMenu(menu: SelectionMenuState): void {
  if (state.bang) return;
  emit({ ...state, menu });
}

/** 收起浮条；传 owner 时只收起该实例唤起的（防隐藏终端的选区事件误关别处的浮条） */
export function dismissSelectionMenu(owner?: string): void {
  if (!state.menu) return;
  if (owner != null && state.menu.owner !== owner) return;
  emit({ ...state, menu: null });
}

/** 只改锚点（滚动/回流时跟手）；无浮条时 no-op。 */
export function updateSelectionMenuAnchor(anchor: { x: number; y: number }): void {
  const menu = state.menu;
  if (!menu) return;
  if (menu.anchor.x === anchor.x && menu.anchor.y === anchor.y) return;
  emit({ ...state, menu: { ...menu, anchor } });
}

type RangeLike = {
  commonAncestorContainer?: Node;
  getClientRects(): ArrayLike<{ right: number; bottom: number; width: number; height: number }>;
  getBoundingClientRect(): { right: number; bottom: number; width: number; height: number };
};

/** 按视口、各层 overflow 裁切及实际命中判断，避免 fixed portal 在原文滚走后悬空。 */
function visibleSelectionAnchor(range: RangeLike): { x: number; y: number } | null {
  const node = range.commonAncestorContainer;
  const source = node instanceof Element ? node : node?.parentElement;
  let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
  for (let el = source; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow);
    const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow);
    if (!clipX && !clipY) continue;
    const bounds = el.getBoundingClientRect();
    if (clipX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (clipY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  const rects = Array.from(range.getClientRects());
  if (!rects.length) rects.push(range.getBoundingClientRect());
  for (let i = rects.length - 1; i >= 0; i--) {
    const rect = rects[i];
    const l = Math.max(left, rect.right - rect.width), r = Math.min(right, rect.right);
    const t = Math.max(top, rect.bottom - rect.height), b = Math.min(bottom, rect.bottom);
    if (r <= l || b <= t) continue;
    // 浮条本身不算遮挡；输入框等其它盖层按浏览器的真实命中排除。
    if (source && typeof document.elementsFromPoint === 'function') {
      const visible = [0.5, 0.1, 0.9].some((fraction) => {
        const hit = document.elementsFromPoint(l + (r - l) * fraction, (t + b) / 2)
          .find((el) => !el.closest('.sel-bar'));
        return hit != null && (source === hit || source.contains(hit));
      });
      if (!visible) continue;
    }
    return { x: r, y: b };
  }
  return null;
}

export type SelectionLike = {
  isCollapsed: boolean;
  rangeCount: number;
  toString(): string;
  getRangeAt(index: number): RangeLike;
};

function pickVisibleRect(
  rects: ArrayLike<{ right: number; bottom: number; width: number; height: number }>
): { right: number; bottom: number } | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (r && (r.width > 0 || r.height > 0)) return { right: r.right, bottom: r.bottom };
  }
  return null;
}

/** 从活 DOM 选区取视口锚（末段右下）。选区塌/空则 null——调用方据此决定「跟手」还是「原位保留」。 */
export function liveSelectionAnchor(sel: SelectionLike | null): { x: number; y: number } | null {
  if (!sel || sel.isCollapsed || sel.rangeCount < 1) return null;
  if (!sel.toString().trim()) return null;
  const range = sel.getRangeAt(0);
  const rect =
    pickVisibleRect(range.getClientRects()) ?? pickVisibleRect([range.getBoundingClientRect()]);
  return rect ? { x: rect.right, y: rect.bottom } : null;
}

/**
 * 滚动 / 视口变化 / selectionchange：dom 源按实际可见选区重锚定；不可见时暂隐，滚回恢复。
 * 选区因中间会话刷新被换节点而塌掉时不收起——文案仍在 menu.text，等外点/按键再关。
 * xterm 源没有 DOM Range，原位保留（他面板滚动不再误关）。
 */
export function syncSelectionMenuToLiveSelection(
  sel: SelectionLike | null = typeof window === 'undefined' ? null : window.getSelection()
): void {
  const menu = state.menu;
  if (!menu || menu.source !== 'dom') return;
  if (!sel || sel.isCollapsed || sel.rangeCount < 1 || !sel.toString().trim()) return;
  const next = visibleSelectionAnchor(sel.getRangeAt(0));
  const hidden = next == null;
  if (!!menu.hidden === hidden && (!next || (menu.anchor.x === next.x && menu.anchor.y === next.y))) return;
  emit({ ...state, menu: { ...menu, hidden, anchor: next ?? menu.anchor } });
}

export function openSelectionBang(bang: SelectionBangState): void {
  if (bang.context?.clearSelection) {
    // 终端源：xterm 选区留给浮层背后，不动 DOM 选区
  } else {
    window.getSelection()?.removeAllRanges();
  }
  emit({ menu: null, bang });
}

/** 关闭爆炸浮层并清掉来源选区（xterm clearSelection / DOM removeAllRanges） */
export function closeSelectionBang(): void {
  const bang = state.bang;
  if (!bang) return;
  emit({ menu: null, bang: null });
  bang.context?.clearSelection?.();
  window.getSelection()?.removeAllRanges();
}
