import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { getResolvedAppearance, subscribeAppearance, terminalTheme } from '../theme';
import { getTerminalFontFamily } from '../uiFont';
import { useHStripBusy, useUiStore } from '../store';
import { TerminalScanOverlay, type ScanHitView } from './TerminalScanOverlay';
import {
  closeSelectionBang,
  dismissSelectionMenu,
  isSelectionBangOpen,
  showSelectionMenu,
  type SelectionAreaContext
} from './selectionMenuController';
import { copySelectionText } from '../terminal/selectionActions';
import { attachDimContrast } from '../terminal/dimContrast';
import { attachTerminalKeyHandler } from '../terminal/keyEvents';
import {
  formatTerminalDropText,
  dataTransferHasPaths,
  pathsFromDataTransfer,
  readPlainTextFromDataTransfer
} from '../../../shared/fileDropPaths';
import { scanLinesForEntities, filterEntitiesByStat } from '../../../shared/terminalScan';
import { readViewportLines, entitiesToHits } from '../terminal/scanBuffer';
import { isBlankTerminalCell } from '../terminal/blankCell';
import { pathStatVariants, resolvePathCandidate } from '../../../shared/terminalSelectionText';
import { TERMINAL_BASE_LINE_HEIGHT, clampRowsToHeight } from '../../../shared/terminalFit';
import {
  majorityPadCss,
  cssFromCellVisualBg,
  cssFromCellVisualFg,
  padSideWidth,
  type CellVisualBgSample,
  type TerminalPadTheme
} from '../../../shared/terminalPadBg';
import {
  registerTerminalCapture,
  unregisterTerminalCapture,
  registerTerminalPaste,
  subscribePtyData
} from '../terminalRegistry';
import { TerminalScanCapsule } from './TerminalScanCapsule';
import '@xterm/xterm/css/xterm.css';

export type TerminalScanPoint = { x: number; y: number };
export type TerminalScanRequest = (point?: TerminalScanPoint) => void;

interface Props {
  sessionId: string;
  workspaceId?: string;
  /** 后台任务终端的链接属于父会话，而非 bg-* 终端 ID。 */
  linkSessionId?: string;
  visible: boolean;
  cwd?: string;
  onAnnotateSelection?: (text: string) => void;
  onBlankPointerDown?: (event: React.PointerEvent<HTMLDivElement>, remainsBlank: () => boolean) => void;
  /** 外部胶囊接管入口；缺省由终端提供自己的识屏胶囊。 */
  onScanControl?: (request: TerminalScanRequest | null) => void;
  onScanStateChange?: (active: boolean) => void;
  onScanEscape?: () => boolean;
  prepareScanCapture?: () => () => void;
  /** 分屏模式下的占位矩形（相对 center-panel）；单开模式缺省走 CSS inset:0 */
  style?: React.CSSProperties;
}

/** 布局动画结束后再 fit，避免关虚拟屏时 WebGL 连着重分配 */
const FIT_DEBOUNCE_MS = 100;
/** 截图服务异常或窗口不可见时，不让悬浮输入区长期隐藏。 */
const SCAN_CAPTURE_TIMEOUT_MS = 1200;
/** 虚拟屏 transform 约 0.42s；拉起后多拍几次，避免按错误/默认尺寸锁死 TUI */
const FIT_RETRY_MS = [0, 80, 280, 500] as const;

function safeDispose(fn: () => void): void {
  try {
    fn();
  } catch {
    // WebGL / xterm 在 React StrictMode 双卸载时可能抛错，不能打挂整棵 UI
  }
}

function readCellSize(term: Terminal): { cellW: number; cellH: number } | null {
  const core = (
    term as unknown as {
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
      };
    }
  )._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (!cell || !(cell.width > 0) || !(cell.height > 0)) return null;
  return { cellW: cell.width, cellH: cell.height };
}

/**
 * Fit 后若整行网格仍高于容器，降行数；余量留给背景垫，绝不拉高 lineHeight / 裁剪。
 */
function clampTerminalToContainer(term: Terminal, container: HTMLElement): void {
  const cell = readCellSize(term);
  if (!cell || term.rows <= 0 || term.cols <= 0) return;
  const avail = container.clientHeight;
  if (!(avail > 0)) return;
  const nextRows = clampRowsToHeight(term.rows, avail, cell.cellH);
  if (nextRows > 0 && nextRows < term.rows) {
    term.resize(term.cols, nextRows);
  }
}

type CellColorLike = {
  getWidth(): number;
  isInverse(): number | boolean;
  isBgDefault(): boolean;
  isBgRGB(): boolean;
  isBgPalette(): boolean;
  getBgColor(): number;
  isFgDefault(): boolean;
  isFgRGB(): boolean;
  isFgPalette(): boolean;
  getFgColor(): number;
};

type CellDrawLike = CellColorLike & {
  getChars(): string;
  isBold(): number | boolean;
};

function asPadTheme(theme: Record<string, string>): TerminalPadTheme {
  return theme as unknown as TerminalPadTheme;
}

/** 从 xterm 单元格缓冲画离屏 PNG。不碰 DOM/WebGL，隐藏会话也不切画面、不 resize pty。 */
function rasterizeTerminalBuffer(term: Terminal): string | null {
  const cols = term.cols;
  const rows = term.rows;
  if (!(cols > 0) || !(rows > 0)) return null;
  const cell = readCellSize(term);
  const cellW = cell?.cellW && cell.cellW > 0 ? cell.cellW : Math.max(6, (term.options.fontSize ?? 13) * 0.6);
  const cellH = cell?.cellH && cell.cellH > 0 ? cell.cellH : Math.max(12, (term.options.fontSize ?? 13) * 1.2);
  const theme = asPadTheme(terminalTheme());
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cols * cellW * dpr));
  canvas.height = Math.max(1, Math.round(rows * cellH * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, cols * cellW, rows * cellH);
  const fontSize = term.options.fontSize ?? 13;
  const fontFamily = term.options.fontFamily || 'Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const buf = term.buffer.active;
  const originY = buf.viewportY;
  for (let r = 0; r < rows; r++) {
    const line = buf.getLine(originY + r);
    if (!line) continue;
    for (let c = 0; c < cols; ) {
      const raw = line.getCell(c) as CellDrawLike | undefined;
      if (!raw) {
        c += 1;
        continue;
      }
      if (raw.getWidth() === 0) {
        c += 1;
        continue;
      }
      const width = Math.max(1, raw.getWidth() || 1);
      const sample = sampleFromCell(raw);
      const x = c * cellW;
      const y = r * cellH;
      ctx.fillStyle = cssFromCellVisualBg(sample, theme);
      ctx.fillRect(x, y, width * cellW, cellH);
      const ch = raw.getChars() || '';
      if (ch && ch !== ' ') {
        const bold = !!raw.isBold();
        ctx.font = `${bold ? 'bold ' : ''}${fontSize}px ${fontFamily}`;
        ctx.fillStyle = cssFromCellVisualFg(sample, theme);
        ctx.fillText(ch, x, y + cellH / 2);
      }
      c += width;
    }
  }
  try {
    const url = canvas.toDataURL('image/png');
    return url.startsWith('data:image/png') ? url : null;
  } catch {
    return null;
  }
}

function sampleFromCell(cell: CellColorLike): CellVisualBgSample {
  return {
    inverse: !!cell.isInverse(),
    bgDefault: cell.isBgDefault(),
    bgRgb: cell.isBgRGB(),
    bgPalette: cell.isBgPalette(),
    bg: cell.getBgColor(),
    fgDefault: cell.isFgDefault(),
    fgRgb: cell.isFgRGB(),
    fgPalette: cell.isFgPalette(),
    fg: cell.getFgColor()
  };
}

function sampleLineCells(
  buf: { getLine: (y: number) => { getCell: (c: number) => unknown } | undefined },
  bufY: number,
  c0: number,
  c1: number,
  cStep: number,
  samples: CellVisualBgSample[]
): void {
  const line = buf.getLine(bufY);
  if (!line) return;
  for (let c = c0; c < c1; c += cStep) {
    const cell = line.getCell(c) as CellColorLike | undefined;
    if (!cell || cell.getWidth() === 0) continue;
    samples.push(sampleFromCell(cell));
  }
}

/** 底部几行横扫：Fit 底部余量跟底部 TUI 铺的底色，不是默认 theme.background。 */
function sampleBottomRowsBg(term: Terminal): CellVisualBgSample[] {
  const buf = term.buffer.active;
  const samples: CellVisualBgSample[] = [];
  if (term.rows <= 0 || term.cols <= 0) return samples;
  const colStep = Math.max(1, Math.floor(term.cols / 40));
  const bottomRows = Math.min(3, term.rows);
  for (let r = term.rows - bottomRows; r < term.rows; r++) {
    sampleLineCells(buf, buf.viewportY + r, 0, term.cols, colStep, samples);
  }
  return samples;
}

/** 右缘几列竖扫（滚动条旁）：侧边余量跟右缘 TUI 底色，与底边同机制、独立投票。 */
function sampleRightColsBg(term: Terminal): CellVisualBgSample[] {
  const buf = term.buffer.active;
  const samples: CellVisualBgSample[] = [];
  if (term.rows <= 0 || term.cols <= 0) return samples;
  const rowStep = Math.max(1, Math.floor(term.rows / 40));
  const rightCols = Math.min(3, term.cols);
  for (let r = 0; r < term.rows; r += rowStep) {
    sampleLineCells(buf, buf.viewportY + r, term.cols - rightCols, term.cols, 1, samples);
  }
  return samples;
}

function padThemeFromTerm(term: Terminal): TerminalPadTheme {
  const base = terminalTheme() as TerminalPadTheme;
  const cur = (term.options.theme ?? {}) as Partial<TerminalPadTheme>;
  return { ...base, ...cur };
}

/** syncTerminalPadBackground 的 DOM 查询缓存：mount 后首次收集节点引用，
 *  之后每次同步只写值不查询。缓存节点被 xterm 重建/移除（isConnected=false）
 *  时下一次同步自动重收集，无需显式失效点。 */
type PadDomCache = {
  wrap: HTMLElement | null;
  side: HTMLElement | null;
  screen: HTMLElement | null;
  bgNodes: HTMLElement[];
};

const padDomCache = new WeakMap<HTMLElement, PadDomCache>();

function collectPadDom(container: HTMLElement): PadDomCache {
  const bgNodes: HTMLElement[] = [];
  for (const sel of [
    '.xterm',
    '.xterm-viewport',
    '.xterm-scrollable-element',
    '.xterm-screen'
  ]) {
    for (const node of container.querySelectorAll(sel)) bgNodes.push(node as HTMLElement);
  }
  const wrap = container.closest('.terminal-wrap') as HTMLElement | null;
  return {
    wrap,
    side: wrap ? (wrap.querySelector('.terminal-pad-side') as HTMLElement | null) : null,
    screen: container.querySelector('.xterm-screen') as HTMLElement | null,
    bgNodes
  };
}

function padDomFor(container: HTMLElement): PadDomCache {
  const cached = padDomCache.get(container);
  if (
    cached &&
    (cached.wrap?.isConnected ?? true) &&
    (cached.side?.isConnected ?? true) &&
    (cached.screen?.isConnected ?? true) &&
    cached.bgNodes.every((n) => n.isConnected)
  ) {
    return cached;
  }
  const next = collectPadDom(container);
  padDomCache.set(container, next);
  return next;
}

/**
 * 底部余量跟底部 TUI 背景；侧边余量条跟右缘 TUI 背景（同一取色机制）。
 */
function syncTerminalPadBackground(term: Terminal, container: HTMLElement): void {
  const base = padThemeFromTerm(term);
  const fallback =
    effectiveTerminalBackground(term) || String(base.background ?? '').trim() || getResolvedAppearance().surfaces.canvas;
  // 默认格走生效底色（含 OSC），避免 options.theme 仍是旧 #0a0a0a
  const theme: TerminalPadTheme = { ...base, background: fallback };
  const bottomBg = majorityPadCss(sampleBottomRowsBg(term), theme, fallback);
  const sideBg = majorityPadCss(sampleRightColsBg(term), theme, fallback);
  container.style.setProperty('--terminal-bg', bottomBg);
  container.style.setProperty('--terminal-side-bg', sideBg);
  container.style.backgroundColor = bottomBg;
  const dom = padDomFor(container);
  if (dom.wrap) {
    dom.wrap.style.setProperty('--terminal-bg', bottomBg);
    dom.wrap.style.setProperty('--terminal-side-bg', sideBg);
    dom.wrap.style.backgroundColor = bottomBg;
    syncPadSideStrip(dom.wrap, container, sideBg, dom.side, dom.screen);
  }
  for (const node of dom.bgNodes) {
    node.style.backgroundColor = bottomBg;
  }
}

/**
 * 右侧 Fit 余量条：宽度 = 网格右缘到容器右缘，颜色跟右缘 TUI 底色。
 * 屏幕 0 尺寸（未 fit / 隐藏）时收起，避免盖住整个终端。
 */
function syncPadSideStrip(
  wrap: HTMLElement,
  container: HTMLElement,
  sideBg: string,
  sideCached?: HTMLElement | null,
  screenCached?: HTMLElement | null
): void {
  const side =
    sideCached ?? (wrap.querySelector('.terminal-pad-side') as HTMLElement | null);
  if (!side) return;
  const screen =
    screenCached ?? (container.querySelector('.xterm-screen') as HTMLElement | null);
  let w = 0;
  if (screen) {
    const cr = container.getBoundingClientRect();
    const sr = screen.getBoundingClientRect();
    if (sr.width > 1 && sr.height > 1 && cr.width > 1) {
      w = padSideWidth(wrap.getBoundingClientRect().right, sr.right);
    }
  }
  side.style.width = w > 0 ? `${w}px` : '0';
  side.style.backgroundColor = sideBg;
}

/** xterm ThemeService 里 OSC/主题生效后的默认底色（比 options.theme 更准）。 */
function effectiveTerminalBackground(term: Terminal): string | null {
  const core = (
    term as unknown as {
      _core?: { _themeService?: { colors?: { background?: { css?: string } } } };
    }
  )._core;
  const css = core?._themeService?.colors?.background?.css;
  return typeof css === 'string' && css.trim() ? css.trim() : null;
}

/** 单元格原点相对 terminal-wrap（含 wrap padding / xterm 内边距） */
function readScreenOrigin(wrap: HTMLElement): { x: number; y: number } {
  const screen =
    (wrap.querySelector('.xterm-screen') as HTMLElement | null) ||
    (wrap.querySelector('canvas') as HTMLElement | null);
  if (!screen) return { x: 0, y: 0 };
  const wr = wrap.getBoundingClientRect();
  const sr = screen.getBoundingClientRect();
  return { x: sr.left - wr.left, y: sr.top - wr.top };
}

/**
 * 鼠标是否落在当前选区单元格上。
 * xterm 文档写 IBufferCellPosition 为 1-based，但 getSelectionPosition() 直接拷贝
 * SelectionService 的 0-based selectionStart/End；end.x 为排他（与 _areCoordsInSelection 一致）。
 */
function pointerInSelection(
  term: Terminal,
  clientX: number,
  clientY: number,
  wrap: HTMLElement
): boolean {
  const pos = term.getSelectionPosition();
  const text = term.getSelection();
  if (!pos || !text?.trim()) return false;
  const cell = readCellSize(term);
  if (!cell) return false;
  const origin = readScreenOrigin(wrap);
  const wr = wrap.getBoundingClientRect();
  const relX = clientX - wr.left - origin.x;
  const relY = clientY - wr.top - origin.y;
  if (relX < 0 || relY < 0) return false;
  const col = Math.floor(relX / cell.cellW); // 0-based viewport col
  const row = Math.floor(relY / cell.cellH); // 0-based viewport row
  if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return false;
  const bufY = term.buffer.active.viewportY + row; // 0-based
  const x1 = pos.start.x;
  const y1 = pos.start.y;
  const x2 = pos.end.x;
  const y2 = pos.end.y;
  const startY = Math.min(y1, y2);
  const endY = Math.max(y1, y2);
  if (bufY < startY || bufY > endY) return false;
  if (startY === endY) {
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    return col >= lo && col < hi;
  }
  if (bufY === startY) return col >= (y1 <= y2 ? x1 : x2);
  if (bufY === endY) return col < (y1 <= y2 ? x2 : x1);
  return true;
}

/**
 * 单个终端会话的 xterm 视图。
 * 组件常驻（不随切换卸载），visible=false 时仅 CSS 隐藏，保证多会话互不串台且切回即恢复。
 * memo：本组件刻意不订阅 sessions（会话表每 500ms 生命周期轮询就重发 sessions:changed），
 * 但父级 CenterPanel 订阅了——props 全是原始值，memo 挡掉这些与终端无关的重渲。
 */
const TerminalView = React.memo(function TerminalView({
  sessionId,
  workspaceId,
  linkSessionId,
  visible,
  cwd,
  onAnnotateSelection,
  onBlankPointerDown,
  onScanControl,
  onScanStateChange,
  onScanEscape,
  prepareScanCapture,
  style
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const scheduleFitRef = useRef<((force?: boolean, focus?: boolean) => void) | null>(null);
  const cancelFitRef = useRef<(() => void) | null>(null);
  /** WebGL 安装器：mount effect 写入，首次可见时调用（装一次，不随隐藏卸载） */
  const webglInstallRef = useRef<(() => void) | null>(null);
  /** WebGL 是否已装过（组件实例级，装过不再触发） */
  const webglOnceRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const linkOwnerRef = useRef({ workspaceId, sessionId: linkSessionId ?? sessionId, scope: 'session' as const });
  linkOwnerRef.current = { workspaceId, sessionId: linkSessionId ?? sessionId, scope: 'session' };
  const annotateRef = useRef(onAnnotateSelection);
  annotateRef.current = onAnnotateSelection;
  const scanControlRef = useRef(onScanControl); scanControlRef.current = onScanControl;
  const scanStateChangeRef = useRef(onScanStateChange); scanStateChangeRef.current = onScanStateChange;
  const scanEscapeRef = useRef(onScanEscape); scanEscapeRef.current = onScanEscape;
  const prepareScanCaptureRef = useRef(prepareScanCapture); prepareScanCaptureRef.current = prepareScanCapture;
  const requestScanRef = useRef<TerminalScanRequest | null>(null);
  const scanGenRef = useRef(0);
  const scanPendingRef = useRef(false);
  const scanCaptureDepthRef = useRef(0);
  const scanCaptureRestoresRef = useRef(new Set<() => void>());
  const scanOpenRef = useRef(false);
  // 不订阅 sessions：会话表每 500ms 生命周期轮询就可能重发，
  // 终端只认自己的 sessionId，跟着重渲纯属白烧帧
  const { flashTip, requestOpenWorkspaceFile } = useUiStore();
  const hStripBusy = useHStripBusy();
  const hStripBusyRef = useRef(hStripBusy);
  hStripBusyRef.current = hStripBusy;

  const [scanHits, setScanHits] = useState<ScanHitView[] | null>(null);
  const [scanOrigin, setScanOrigin] = useState<{ left: number; top: number } | null>(null);
  const [scanSnapshot, setScanSnapshot] = useState<string | null>(null);
  const [scanEpoch, setScanEpoch] = useState(0);
  const [scanPending, setScanPending] = useState(false);
  const scanOpen = scanHits != null;
  scanOpenRef.current = scanOpen;

  const closeScan = (): void => {
    scanGenRef.current += 1;
    for (const restore of Array.from(scanCaptureRestoresRef.current)) restore();
    scanPendingRef.current = false;
    setScanPending(false);
    setScanHits(null);
    setScanOrigin(null);
    setScanSnapshot(null);
  };

  useEffect(() => { scanStateChangeRef.current?.(scanOpen || scanPending); }, [scanOpen, scanPending]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      // 字体栈固定纯等宽（uiFont.getTerminalFontFamily；不随界面字体——比例 UI 字体会被
      // xterm 按 'W' 撑列宽、按行盒撑行高，横竖间隙大）；已开终端不热更，新终端生效。
      // 字号固定 14、不随字号档（终端列宽/布局稳定性优先）
      fontFamily: getTerminalFontFamily(),
      fontSize: 14,
      lineHeight: TERMINAL_BASE_LINE_HEIGHT,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      scrollback: 10000,
      // 保留 xterm 的滚轮与历史缓冲，同时不绘制滚动条，也不为滚动条预留宽度。
      scrollbar: { showScrollbar: false },
      allowProposedApi: true,
      // 关闭则 .xterm-viewport 强制 background:#000，fit 余量处必现纯黑条
      allowTransparency: true,
      smoothScrollDuration: 125,
      drawBoldTextInBrightColors: true,
      // 对比度保底（与 VS Code 终端同默认）：前景色与单元格底色不足 4.5:1 时渲染期自动加深/提亮，
      // 自定义主题的 ANSI 色再亮也不会白底白字（只调整 fg，不改主题身份；主题内本身达标的色不受影响）
      minimumContrastRatio: 4.5,
      theme: terminalTheme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    el.dataset.appearanceRevision = String(getResolvedAppearance().revision);
    syncTerminalPadBackground(term, el);

    const dimContrast = attachDimContrast(term, el, { enabled: getResolvedAppearance().appearance === 'light', background: getResolvedAppearance().surfaces.canvas });

    let webgl: WebglAddon | null = null;
    /** 深色 WebGL 延后到首次可见启用；隐藏会话与浅色均使用官方 DOM。
     *  模式切换按 addon 生命周期换 renderer，终端缓冲区与实例保持不变。 */
    const installWebgl = (): void => {
      // xterm exposes no dim opacity option. The official DOM renderer lets the
      // foreground-only contrast guard preserve faint text in light themes.
      if (webgl || getResolvedAppearance().appearance === 'light') return;
      try {
        const addon = new WebglAddon({ preserveDrawingBuffer: true });
        addon.onContextLoss(() => {
          safeDispose(() => addon.dispose());
          webgl = null;
        });
        term.loadAddon(addon);
        webgl = addon;
        syncTerminalPadBackground(term, el);
      } catch {
        webgl = null;
      }
    };
    webglInstallRef.current = installWebgl;

    termRef.current = term;
    fitRef.current = fit;

    registerTerminalCapture(sessionId, {
      prepare: async () => {
        const cur = termRef.current;
        if (!cur) throw new Error(t('终端未就绪'));
        cur.scrollToBottom();
        return () => undefined;
      },
      getCanvasDataURL: () => {
        const cur = termRef.current;
        if (!cur) return null;
        return rasterizeTerminalBuffer(cur);
      }
    });

    // 文件批注（CLI 会话为目标）：确认后把展开文字粘进终端输入
    registerTerminalPaste(sessionId, {
      paste: (text) => {
        const cur = termRef.current;
        if (!cur) return;
        cur.focus();
        cur.paste(text);
      }
    });

    const unsubTheme = subscribeAppearance((appearance) => {
      if (termRef.current === term) {
        term.options.theme = { ...appearance.terminal };
        if (appearance.appearance === 'light' && webgl) {
          const previous = webgl;
          webgl = null;
          safeDispose(() => previous.dispose());
        } else if (appearance.appearance === 'dark' && visibleRef.current) {
          installWebgl();
        }
        dimContrast.update({ enabled: appearance.appearance === 'light', background: appearance.surfaces.canvas });
        el.dataset.appearanceRevision = String(appearance.revision);
        syncTerminalPadBackground(term, el);
      }
    });

    void window.api.pty.getBuffer(sessionId).then((buf) => {
      if (buf && termRef.current === term) term.write(buf);
    });

    const onDataDisp = term.onData((data) => {
      window.api.pty.input(sessionId, data);
    });

    /* 真使用 = 用户键盘输入。onData 含 xterm 自动应答（DA1 等设备查询响应），
       不能作为依据——打开会话时 CLI 重连会查询终端能力触发自动应答 */
    const onKeyDisp = term.onKey(() => {
      window.api.sessions.touchUsed(sessionId);
    });

    const clearSelUi = (): void => {
      dismissSelectionMenu(sessionId);
    };

    /** 终端区域的划词菜单回调包：粘贴进输入/清选区/还焦点都封在 TerminalView 内 */
    const selContext = (): SelectionAreaContext => ({
      cwd: cwdRef.current,
      rightOwner: linkOwnerRef.current,
      ...(annotateRef.current ? { annotate: (text: string) => annotateRef.current?.(text) } : {}),
      paste: (text: string) => {
        const term = termRef.current;
        void copySelectionText(text, flashTip).then(() => {
          term?.clearSelection();
          dismissSelectionMenu(sessionId);
          if (!text || !term) return;
          term.focus();
          term.paste(text);
        });
      },
      clearSelection: () => termRef.current?.clearSelection(),
      keepFocus: () => termRef.current?.focus()
    });

    /** 划词松手点（视口坐标）；菜单锚在这里 */
    let pointerVp: { x: number; y: number } | null = null;

    const syncSelAtPointer = (): void => {
      if (!visibleRef.current || isSelectionBangOpen() || scanOpenRef.current) {
        clearSelUi();
        return;
      }
      const text = term.getSelection();
      if (!text || !text.trim() || !pointerVp) {
        clearSelUi();
        return;
      }
      showSelectionMenu({
        source: 'xterm',
        area: 'terminal',
        owner: sessionId,
        text,
        anchor: pointerVp,
        anchorElement: el,
        context: selContext()
      });
      // 菜单弹出后焦点必须仍在 xterm，否则 Ctrl/快捷键进不了终端
      term.focus();
    };

    let pointerDown = false;
    let dragPayload: string | null = null;

    const onMouseDown = (e: MouseEvent): void => {
      const wrapEl = wrapRef.current;
      const canDragSel =
        e.button === 0 &&
        !!wrapEl &&
        term.hasSelection() &&
        !!term.getSelection()?.trim() &&
        pointerInSelection(term, e.clientX, e.clientY, wrapEl);
      if (canDragSel) {
        dragPayload = term.getSelection().trim();
        el.draggable = true;
        pointerDown = false;
        // 拦住 xterm：否则会 preventDefault+清选，HTML5 dragstart 发不出来
        e.stopPropagation();
        return;
      }
      dragPayload = null;
      el.draggable = false;
      pointerDown = true;
      clearSelUi();
    };

    const onDragStart = (e: DragEvent): void => {
      const payload = dragPayload?.trim() || term.getSelection()?.trim() || '';
      if (!payload || !e.dataTransfer) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', payload);
      e.dataTransfer.effectAllowed = 'copy';
    };

    const onDragEnd = (): void => {
      dragPayload = null;
      el.draggable = false;
    };

    const onMouseUp = (e: MouseEvent): void => {
      if (!pointerDown) return;
      pointerDown = false;
      pointerVp = { x: e.clientX, y: e.clientY };
      requestAnimationFrame(syncSelAtPointer);
    };
    // capture：在 xterm 清选之前快照选区并打开 draggable；选区内左键 stopPropagation
    el.addEventListener('mousedown', onMouseDown, true);
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragend', onDragEnd);
    window.addEventListener('mouseup', onMouseUp);

    const onDragOver = (e: DragEvent): void => {
      const dt = e.dataTransfer;
      if (!dataTransferHasPaths(dt)) return;
      e.preventDefault();
      e.stopPropagation();
      if (dt) dt.dropEffect = 'copy';
    };

    const onDrop = (e: DragEvent): void => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const getPath = window.api?.shell?.pathForFile;
      if (typeof getPath === 'function' && dataTransferHasPaths(dt)) {
        const paths = pathsFromDataTransfer(dt, (f) => getPath(f));
        const text = formatTerminalDropText(paths);
        if (text) {
          e.preventDefault();
          e.stopPropagation();
          term.focus();
          term.paste(text);
          return;
        }
      }
      const plain = readPlainTextFromDataTransfer(dt);
      if (!plain) return;
      e.preventDefault();
      e.stopPropagation();
      term.focus();
      term.paste(plain);
    };

    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);

    const wrap = wrapRef.current;
    const beginCapture = (): (() => void) => {
      scanCaptureDepthRef.current += 1;
      wrap?.classList.add('is-scan-capturing');
      let restoreParent: (() => void) | undefined;
      try { restoreParent = prepareScanCaptureRef.current?.(); }
      catch (error) {
        scanCaptureDepthRef.current = Math.max(0, scanCaptureDepthRef.current - 1);
        if (!scanCaptureDepthRef.current) wrap?.classList.remove('is-scan-capturing');
        throw error;
      }
      let restored = false;
      const restore = (): void => {
        if (restored) return;
        restored = true;
        scanCaptureRestoresRef.current.delete(restore);
        try { restoreParent?.(); } finally {
          scanCaptureDepthRef.current = Math.max(0, scanCaptureDepthRef.current - 1);
          if (!scanCaptureDepthRef.current) wrap?.classList.remove('is-scan-capturing');
        }
      };
      scanCaptureRestoresRef.current.add(restore);
      return restore;
    };
    const requestScan: TerminalScanRequest = (point): void => {
      if (scanOpenRef.current || scanPendingRef.current) { closeScan(); return; }
      if (!visibleRef.current) { flashTip(t('终端未就绪')); return; }
      // 虚拟屏位移动画中不进入扫描
      if (hStripBusyRef.current) { flashTip(t('布局切换中，请稍后重试')); return; }
      closeSelectionBang();
      const cur = termRef.current;
      if (!cur) { flashTip(t('终端未就绪')); return; }
      const size = readCellSize(cur);
      if (!size) {
        closeScan();
        flashTip(t('无法读取终端尺寸'));
        return;
      }
      const wr = wrap?.getBoundingClientRect();
      const origin = wr && point
        ? { left: (point.x - wr.left) / (wrap?.clientWidth && wr.width ? wr.width / wrap.clientWidth : 1),
          top: (point.y - wr.top) / (wrap?.clientHeight && wr.height ? wr.height / wrap.clientHeight : 1) }
        : wrap
          ? { left: wrap.clientWidth / 2, top: wrap.clientHeight / 2 }
        : { left: 0, top: 0 };
      const cwdNow = cwdRef.current;
      const originPx = wrap ? readScreenOrigin(wrap) : { x: 0, y: 0 };
      clearSelUi();

      // 先卸掉旧遮罩，再 capturePage（含 WebGL），否则截到的是模糊层本身
      const gen = ++scanGenRef.current;
      scanPendingRef.current = true;
      setScanPending(true);
      setScanHits(null);
      setScanSnapshot(null);
      setScanOrigin(origin);
      void (async () => {
        try {
          const lines = readViewportLines(cur);
          const entities = scanLinesForEntities(lines, cwdNow);
          // stat 清单：localhost URL 的本地映射 + file/dir/loc 的路径变体（含空格贪心链，
          // filterEntitiesByStat 会回填最长存在前缀）
          const absList = [
            ...new Set(
              entities.flatMap((e) => {
                if (e.kind === 'url') {
                  return e.localPath ? [e.localPath] : [];
                }
                const base = e.greedyText ?? e.pathText ?? e.text;
                const variants = e.greedyText ? pathStatVariants(base) : [base];
                return variants
                  .map((v) => resolvePathCandidate(v, cwdNow))
                  .filter((p): p is string => !!p);
              })
            )
          ];
          let stats: Record<string, { exists: boolean; isFile: boolean; isDirectory: boolean }> = {};
          if (absList.length > 0) {
            try {
              stats = await window.api.shell.statPaths(absList);
            } catch {
              stats = {};
            }
          }
          if (gen !== scanGenRef.current || !visibleRef.current || hStripBusyRef.current) return;
          const filtered = filterEntitiesByStat(entities, cwdNow, stats);
          const hits = entitiesToHits(cur, filtered, size.cellW, size.cellH, originPx, cwdNow);
          if (hits.length === 0) flashTip(t('未识别到有效链接或路径'));

          let snapshot: string | null = null;
          const restoreCapture = beginCapture();
          let timeout = 0;
          let captureCancelled = false;
          let timedOut = false;
          try {
            // 超时同时覆盖等待绘制与截图 IPC：窗口被遮挡时 rAF 也可能迟迟不回调。
            const capture = (async (): Promise<string | null> => {
              await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
              if (captureCancelled || gen !== scanGenRef.current || !visibleRef.current || hStripBusyRef.current) return null;
              const rect = wrapRef.current?.getBoundingClientRect();
              if (!rect || rect.width <= 1 || rect.height <= 1) return null;
              return window.api.app.captureRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
            })();
            snapshot = await Promise.race([
              capture,
              new Promise<null>(resolve => { timeout = window.setTimeout(() => { timedOut = true; resolve(null); }, SCAN_CAPTURE_TIMEOUT_MS); })
            ]);
            if (timedOut && gen === scanGenRef.current) flashTip(t('终端截图超时，已使用简化识屏'));
            else if (!snapshot && gen === scanGenRef.current) flashTip(t('终端截图失败，已使用简化识屏'));
          } catch {
            if (gen === scanGenRef.current) flashTip(t('终端截图失败，已使用简化识屏'));
          } finally {
            captureCancelled = true;
            if (timeout) window.clearTimeout(timeout);
            restoreCapture();
          }
          if (gen !== scanGenRef.current || !visibleRef.current || hStripBusyRef.current) return;
          setScanSnapshot(snapshot);
          setScanEpoch((n) => n + 1);
          setScanHits(hits);
        } catch (error) {
          if (gen === scanGenRef.current) flashTip(t('识屏失败：{{error}}', { error: String(error) }));
        } finally {
          if (gen === scanGenRef.current) { scanPendingRef.current = false; setScanPending(false); }
        }
      })();
    };
    requestScanRef.current = requestScan;
    const registerScan = scanControlRef.current;
    registerScan?.(requestScan);
    const onWheel = (): void => {
      if (scanOpenRef.current || scanPendingRef.current) closeScan();
    };
    wrap?.addEventListener('wheel', onWheel, { passive: true });

    // Esc 清选区后仍交给 TUI；只在扫描/爆炸遮罩期间阻止输入。
    attachTerminalKeyHandler(term, () => scanOpenRef.current || isSelectionBangOpen(), clearSelUi);

    const onSelDisp = term.onSelectionChange(() => {
      if (pointerDown || dragPayload) return;
      requestAnimationFrame(syncSelAtPointer);
    });

    let padTimer = 0;
    const schedulePadSync = (): void => {
      if (padTimer) window.clearTimeout(padTimer);
      padTimer = window.setTimeout(() => {
        padTimer = 0;
        if (termRef.current === term) syncTerminalPadBackground(term, el);
      }, 50);
    };
    const onWriteParsedDisp = term.onWriteParsed(schedulePadSync);

    const onScroll = (): void => {
      schedulePadSync();
      if (scanOpenRef.current || scanPendingRef.current) {
        closeScan();
        return;
      }
      if (isSelectionBangOpen() || pointerDown) return;
      term.clearSelection();
      clearSelUi();
    };
    const viewport = el.querySelector('.xterm-viewport');
    viewport?.addEventListener('scroll', onScroll);
    const onTermScroll = term.onScroll(() => onScroll());

    // pty:data 走 terminalRegistry 单一分发器（按 sessionId 派发），
    // 不再每个常驻 TerminalView 全量监听再自过滤
    const offData = subscribePtyData(sessionId, (data) => {
      term.write(data);
    });
    const offExit = window.api.on('pty:exit', (p: { sessionId: string; exitCode: number }) => {
      if (p.sessionId === sessionId) {
        term.write(`\r\n\x1b[90m[${t('进程已退出（{{code}}）。请在会话菜单选择启动方式', { code: p.exitCode })}]\x1b[0m\r\n`);
      }
    });
    const syncPtySize = (): void => {
      if (term.cols > 0 && term.rows > 0) {
        window.api.pty.resize(sessionId, term.cols, term.rows);
      }
    };
    /** force：即使 xterm 列行未变也 resize pty（spawn 默认 120 后必须再推一次） */
    const runFit = (force = false): void => {
      if (!visibleRef.current) return;
      // display:none 时 offsetParent 为 null；虚拟屏移出视口时仍应有 offsetParent
      if (!el.offsetParent && el.offsetWidth === 0) return;
      try {
        term.options.lineHeight = TERMINAL_BASE_LINE_HEIGHT;
        const proposed = fit.proposeDimensions();
        if (!proposed) return;
        if (force || proposed.cols !== term.cols || proposed.rows !== term.rows) {
          fit.fit();
        }
        clampTerminalToContainer(term, el);
        syncTerminalPadBackground(term, el);
        syncPtySize();
      } catch {
        // ignore
      }
    };
    let scheduledFitTimer = 0;
    let fitGeneration = 0;
    const cancelScheduledFit = (): void => {
      fitGeneration += 1;
      if (scheduledFitTimer) {
        window.clearTimeout(scheduledFitTimer);
        scheduledFitTimer = 0;
      }
    };
    const scheduleFit = (force = false, focus = false, retries = false): void => {
      cancelScheduledFit();
      const generation = fitGeneration;
      const delays = retries ? FIT_RETRY_MS : [FIT_DEBOUNCE_MS];
      let index = 0;
      const run = (): void => {
        if (generation !== fitGeneration) return;
        runFit(force);
        if (focus) {
          term.focus();
          focus = false;
        }
        index += 1;
        if (index >= delays.length) {
          scheduledFitTimer = 0;
          return;
        }
        scheduledFitTimer = window.setTimeout(run, delays[index]! - delays[index - 1]!);
      };
      scheduledFitTimer = window.setTimeout(run, delays[0]);
    };
    const doFit = (): void => scheduleFit(false, false, false);
    scheduleFitRef.current = (force = true, focus = false) => scheduleFit(force, focus, true);
    cancelFitRef.current = cancelScheduledFit;

    const offRespawn = window.api.on('pty:respawn', (p: { sessionId: string }) => {
      if (p.sessionId !== sessionId) return;
      term.reset();
      // CLI 刚按某尺寸启动；立刻按容器真实宽高 fit 并推给 pty
      scheduleFitRef.current?.(true);
    });

    const resizeObserver = new ResizeObserver(doFit);
    resizeObserver.observe(el);
    // 挂载时先记下尺寸（此时 pty 可能还在 starting）
    scheduleFitRef.current?.(true);

    return () => {
      scanGenRef.current += 1;
      for (const restore of Array.from(scanCaptureRestoresRef.current)) restore();
      scanPendingRef.current = false;
      requestScanRef.current = null;
      registerScan?.(null);
      unsubTheme();
      dimContrast.dispose();
      webglInstallRef.current = null;
      scheduleFitRef.current = null;
      cancelFitRef.current = null;
      cancelScheduledFit();
      if (padTimer) window.clearTimeout(padTimer);
      resizeObserver.disconnect();
      viewport?.removeEventListener('scroll', onScroll);
      wrap?.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMouseDown, true);
      el.removeEventListener('dragstart', onDragStart);
      el.removeEventListener('dragend', onDragEnd);
      el.draggable = false;
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
      window.removeEventListener('mouseup', onMouseUp);
      safeDispose(() => onDataDisp.dispose());
      safeDispose(() => onKeyDisp.dispose());
      safeDispose(() => onSelDisp.dispose());
      safeDispose(() => onTermScroll.dispose());
      safeDispose(() => onWriteParsedDisp.dispose());
      offData();
      offExit();
      offRespawn();
      unregisterTerminalCapture(sessionId);
      termRef.current = null;
      fitRef.current = null;
      // WebGL/xterm dispose 很重；关最后一个会话时若同步做会冻住整窗。
      // 先让 React 提交空中栏，再丢到下一帧后台拆。
      const gl = webgl;
      webgl = null;
      const termToKill = term;
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          if (gl) safeDispose(() => gl.dispose());
          safeDispose(() => termToKill.dispose());
        }, 0);
      });
    };
  }, [sessionId, flashTip]);

  useEffect(() => {
    scanGenRef.current += 1;
    scanPendingRef.current = false;
    setScanPending(false);
    setScanHits(null);
    setScanOrigin(null);
    setScanSnapshot(null);
  }, [sessionId]);

  /** 首次可见才装 WebGL（装一次，不随隐藏卸载）：隐藏会话不占 GPU 上下文。
   *  延后一拍再装，避开首帧布局（与原 mount+setTimeout(0) 同节拍）。 */
  useEffect(() => {
    if (!visible || webglOnceRef.current) return;
    webglOnceRef.current = true;
    window.setTimeout(() => webglInstallRef.current?.(), 0);
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      closeSelectionBang();
      dismissSelectionMenu(sessionId);
      closeScan();
      return;
    }
    scheduleFitRef.current?.(true, true);
    return () => {
      cancelFitRef.current?.();
    };
  }, [visible, sessionId]);

  return (
    <div
      className={`terminal-wrap xfade xfade-instant${visible ? ' is-shown' : ''}`}
      style={style}
      ref={wrapRef}
      data-session-id={sessionId}
      data-drag-source="terminal"
      data-sel-native=""
      onPointerDownCapture={onBlankPointerDown ? event => {
        if (event.pointerType !== 'mouse' || event.button !== 0 || event.isPrimary === false ||
            event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        const target = event.target;
        const term = termRef.current;
        const screen = containerRef.current?.querySelector<HTMLElement>('.xterm-screen');
        if (!(target instanceof Element) || !target.closest('.terminal-container') ||
            target.closest('.xterm-scrollbar') || !term || !screen || term.hasSelection()) return;
        const { clientX, clientY } = event;
        const remainsBlank = (): boolean => visibleRef.current && termRef.current === term &&
          !term.hasSelection() && !scanOpenRef.current && !scanPendingRef.current && !isSelectionBangOpen() &&
          isBlankTerminalCell(term, screen, clientX, clientY);
        try {
          if (remainsBlank()) onBlankPointerDown(event, remainsBlank);
        } catch (error) { flashTip(t('长按切换失败：{{error}}', { error: String(error) })); }
      } : undefined}
    >
      <div ref={containerRef} className="terminal-container" />
      {/* 右侧 Fit 余量垫条：颜色/宽度由 syncTerminalPadBackground 跟右缘 TUI 写入 */}
      <div className="terminal-pad-side" aria-hidden="true" />
      {/* 划词浮条与「爆炸」浮层由全局 SelectionMenuHost 渲染（selectionMenuController 上报） */}
      {scanOpen ? (
        <TerminalScanOverlay
          key={scanEpoch}
          hits={scanHits!}
          snapshot={scanSnapshot}
          origin={scanOrigin}
          onClose={closeScan}
          autoFocus={!onScanControl}
          onEscape={() => { if (!scanEscapeRef.current?.()) closeScan(); }}
          onTip={flashTip}
          linkOwner={linkOwnerRef.current}
          onPreviewFile={(absPath, line, col) => {
            requestOpenWorkspaceFile({ path: absPath, line, col, scope: 'session', ownerWorkspaceId: workspaceId, ownerSessionId: linkSessionId ?? sessionId });
          }}
        />
      ) : null}
      {!onScanControl ? <TerminalScanCapsule sessionId={sessionId} visible={visible} active={scanOpen || scanPending}
        viewRef={wrapRef} onScan={point => {
          if (requestScanRef.current) requestScanRef.current(point);
          else flashTip(t('终端未就绪'));
        }}/> : null}
    </div>
  );
});

export { TerminalView };

