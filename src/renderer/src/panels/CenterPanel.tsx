import { sessionRuntimeLookup } from '../../../shared/retiredServiceRuntimes';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore, useRuntimesStore, useWorkspaceStore } from '../store';
import { setLongtaskSessionSummary } from '../longtaskDiag';
import { TerminalView } from '../components/TerminalView';
import { ArchivedSessionView } from '../components/ArchivedSessionView';
import { CliSessionView } from '../components/CliSessionView';
import { centerFileDockKey, centerFileHostKey, DockSurface, RightDockHost, rightDockKey, useRightDock, useRightPin, type RightPinApi } from '../rightDock';
import { MailEnvelopeViewport } from '../components/MailEnvelopeViewport';
import { ServiceView } from '../components/ServiceView';
import { PromptTaskPanel } from '../components/PromptTaskPanel';
import { UsageStatsPanel } from '../components/UsageStatsPanel';
import { KnowledgeCenter } from '../components/KnowledgeCenter';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { AppLogo } from '../components/AppLogo';
import { ContextMenu } from '../components/ContextMenu';
import { IconChevronDown, IconClose, IconLayout, IconMore, IconSearch, IconExpand, IconShrink } from '../components/icons';
import { SessionStatusIcon } from '../components/StatusIcon';
import { sessionDisplayStatus, type BoardStatus } from '../../../shared/boardStatus';
import { getChatFindShared, patchChatFindShared } from '../chatSurface/chatFindRegistry';
import { CenterSnapBar } from '../components/CenterSnapBar';
import { SnapDividers } from '../components/SnapDividers';
import { SplitContentPicker } from '../components/SplitContentPicker';
import { BackgroundViewTabs, type BackgroundViewTab } from '../components/BackgroundViewTabs';
import { WorkbenchNavigationPanel as WorkbenchNavigationPanel } from './WorkbenchNavigationPanel';
import { ExtensionsManagerPage } from './ExtensionsManagerPage';
import { AgentChatView, type AgentPaneControl } from '../agentChat/AgentChatView';
import { MOTION, usePresence, usePresenceValue } from '../components/motion';
import {
  getSessionViewsVersion,
  keptSessionViews,
  retainSessionViews,
  subscribeSessionViews,
  touchSessionView
} from '../sessionViewLru';
import { canCloseCenterPane, centerPaneRects, centerSnapRevealAt, useCenterPaneDrag, type CenterPaneRect } from '../hooks/useCenterPaneDrag';
import { isCenterSplitSession, supportsCenterSplitRef } from '../centerSplitSupport';
import { useCenterPaneFullscreen } from '../hooks/useCenterPaneFullscreen';
import { runtimeSurface } from '../../../shared/types';
import { sessionAncestry, sessionDepthLabel } from '../../../shared/sessionTree';
import { jumpToSession } from '../sessionJump';
import { PANEL_FOCUS_EVENT } from '../../../shared/panelRelay';
import {
  SPLIT_DRAG_MIME,
  SPLIT_NARROW_PX,
  decodeSplitDragPayload,
  deriveCenterSplitIncomingSnapLayout,
  samePaneRef,
  CENTER_SNAP_LAYOUTS,
  getCenterSplitPaneRefs,
  getCenterSplitPaneCells,
  getCenterSplitDividers,
  type CenterPaneSlot,
  type SplitPaneRef,
  type CenterSnapTarget
} from '../../../shared/centerSplit';
import {
  centerSplitCommitIncomingSnapLayout,
  centerSplitSetFocused,
  centerSplitSetRatio,
  centerSplitSetRatios,
  centerSplitSetDividerRatio,
  centerSplitResetRatio,
  centerSplitSwap,
  centerSplitFlip,
  centerSplitClosePane,
  centerSplitDissolve,
  centerSplitSelectInPane,
  centerSplitToggleShortcut,
  getCenterSplitState,
  useCenterSplit,
  type CenterSplitState
} from '../centerSplitStore';
import type { UtilitySelection } from './LeftPanel';
import { useExtensionWorkbenchNavigation as useWorkbenchNavigation } from '../extensionWorkbench';

type UtilityId = NonNullable<UtilitySelection>;

const nativeLayoutKey = (primary: SplitPaneRef, state: CenterSplitState): string => JSON.stringify({
  refs: getCenterSplitPaneRefs(primary, state), open: state.open, dir: state.dir, ratio: state.ratio, ratios: state.ratios,
  layoutId: state.layoutId, order: state.order, selectionScope: state.selectionScope
});
interface NativePaneDrag { ref: SplitPaneRef; primary: SplitPaneRef; original: CenterSplitState; key: string; cardWidth: number; grabX: number }

/** 层级路径面包屑的一级（子代理通用化 D2） */
interface PaneCrumb {
  id: string;
  name: string;
  /** 层级标签：会话 / 子代理 / 孙代理 */
  kindLabel: string;
  /** 非末级可点回跳；末级（当前会话）无 */
  onNavigate?: () => void;
}

/**
 * 工具面板层：按 selection 作 key 在同一父节点下列表渲染。换下的面板原地从「当前」转 out，
 * 是同一实例（不重挂载：滚动位置、已加载数据、扩展 iframe 都保留）；退场中切回直接从当前
 * 位置回弹到 in。层不涂底（透出页的半透明底），A→B 走「先出后入」时序（base.css
 * .center-utility-layer 段）避免叠印；终端在「有未退场的工具层」期间由 CSS 藏起。
 */
function UtilityLayer({
  sel,
  open,
  onGone,
  onShow,
  children
  , placement = 'center'
  , inset
  , contentStyle
  , slot
  , keep = false
}: {
  sel: UtilityId;
  /** 固定在右侧的工具：内容在右侧显示，本层关闭时也保留实例 */
  keep?: boolean;
  open: boolean;
  onGone: (sel: UtilityId) => void;
  onShow: (sel: UtilityId) => void;
  children: React.ReactNode;
  placement?: string;
  /** 分屏模式下该层占的 pane 体矩形（相对 center-panel，px）；null=整面 */
  inset?: { top: number; left: number; width: number; height: number } | null;
  contentStyle?: React.CSSProperties;
  slot?: CenterPaneSlot | null;
}): React.JSX.Element | null {
  const presence = usePresence(open);
  const mounted = presence.mounted;
  useEffect(() => {
    if (open) onShow(sel);
  }, [open, sel, onShow]);
  useEffect(() => {
    if (!mounted && !keep) onGone(sel);
  }, [mounted, sel, onGone, keep]);
  // 卸载那一拍不能留 enter 态空壳：:has(:not(out)) 会误藏终端闪一帧
  if (!mounted && !keep) return null;
  return (
    <div
      className={`center-utility-layer mp-panel utility-placement-${placement}`}
      data-mp-stage={mounted ? presence.stage : 'out'}
      data-center-slot={slot ?? undefined}
      style={{
        ...(!mounted ? { display: 'none' } : undefined),
        ...(inset
          ? {
              top: `${inset.top}px`,
              left: `${inset.left}px`,
              right: 'auto',
              bottom: 'auto',
              width: `${inset.width}px`,
              height: `${inset.height}px`
            }
          : null),
        ...contentStyle
      }}
      ref={element => { if (element) { if (open) element.removeAttribute('inert'); else element.setAttribute('inert', ''); } }}
      aria-hidden={open ? undefined : true}
    >
      <div className="center-utility-content">{children}</div>
    </div>
  );
}

/** 内容固定在右侧时，中栏原位置显示去向与召回入口（视图实例在右侧，中栏不再挂第二份） */
function DockedPlaceholder({ target, pin, style }: { target: SplitPaneRef; pin: RightPinApi; style?: React.CSSProperties }): React.JSX.Element {
  const { t } = useTranslation();
  return <div className="center-docked-placeholder ui-empty" style={style} data-testid="center-docked-placeholder">
    <p className="ui-empty-desc">{t('此内容正在右侧面板中显示')}</p>
    <div className="center-docked-actions">
      <button type="button" className="btn" onClick={() => pin.reveal(target)}>{t('在右侧查看')}</button>
      <button type="button" className="btn" onClick={() => pin.unpin(target)}>{t('移回中栏')}</button>
    </div>
  </div>;
}

/** Hover chrome overlays the pane; its capture target and content roots remain mounted. */
function PaneToolbar({
  title,
  workerLabel,
  active,
  splitDir,
  secondaryEmpty,
  onFocus,
  onSwap,
  onFlip,
  onResetRatio,
  onDissolve,
  onClose
  , slot, splitOpen, hidden, moving, gesture, agentControl, paneCount, snapDisabled, status, progress, crumbs, onFind, paneSwitch, rightPin, fullscreen, onFullscreen
}: {
  title: string;
  fullscreen: boolean;
  onFullscreen?: () => void;
  /** 固定到右侧（会话 / 内置工具 / 扩展入口）；不可固定的内容不传 */
  rightPin?: { pinned: boolean; toggle: () => void };
  workerLabel: string | null;
  active: boolean;
  splitDir: 'row' | 'col';
  secondaryEmpty: boolean;
  onFocus: () => void;
  onSwap: () => void;
  onFlip: () => void;
  onResetRatio: () => void;
  onDissolve: () => void;
  onClose?: () => void;
  slot: CenterPaneSlot;
  paneCount: number;
  snapDisabled: boolean;
  splitOpen: boolean;
  hidden: boolean;
  moving: boolean;
  gesture: ReturnType<typeof useCenterPaneDrag>;
  agentControl?: AgentPaneControl;
  status?: BoardStatus;
  progress?: string;
  /** 层级路径面包屑（子代理会话用）：自根到自身的祖先链，末级为当前会话 */
  crumbs?: Array<{
    id: string;
    name: string;
    kindLabel: string;
    onNavigate?: () => void;
  }>;
  onFind?: () => void;
  paneSwitch?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  useEffect(() => { if (moving || hidden) setMenuAt(null); }, [moving, hidden]);
  useEffect(() => { if (hidden) { setHovered(false); setKeyboardFocus(false); } }, [hidden]);
  // Fullscreen moves this host without necessarily producing pointerleave.
  useLayoutEffect(() => { setHovered(false); }, [fullscreen]);
  useEffect(() => {
    if (!hovered && !keyboardFocus) return;
    const pointerInteraction = (event: PointerEvent): void => {
      setKeyboardFocus(false);
      if (!host.current?.contains(event.target as Node)) setHovered(false);
    };
    const clear = (): void => { setHovered(false); setKeyboardFocus(false); };
    const pointerOut = (event: PointerEvent): void => {
      const next = event.relatedTarget;
      if (host.current?.contains(event.target as Node) && !(next instanceof Node && host.current.contains(next))) clear();
    };
    window.addEventListener('pointerdown', pointerInteraction, true);
    window.addEventListener('pointermove', pointerInteraction, true);
    // Guest input can stop delivery of further pointer moves in this document.
    window.addEventListener('pointerout', pointerOut, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointerdown', pointerInteraction, true);
      window.removeEventListener('pointermove', pointerInteraction, true);
      window.removeEventListener('pointerout', pointerOut, true);
      window.removeEventListener('blur', clear);
    };
  }, [hovered, keyboardFocus]);
  const revealed = !hidden && (hovered || keyboardFocus || menuAt != null || moving || gesture.captureActive || gesture.barOpen);
  const toolbarPresence = usePresence(revealed);
  const statusLabel = status ? t({ working: '工作中', idle: '空闲', quiet: '空闲', blocked: '待确认', waiting: '需要你',
    error: '错误', no_signal: '无信号', done: '已完成', exited: '已退出', scheduled: '定时任务' }[status]) : '';
  const toggleMenu = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect();
    setMenuAt(prev => prev ? null : { x: rect.left, y: rect.bottom + 6 });
  };
  // Snap 条出现时仅淡出 chrome，保留被捕获的把手位置和命中。
  const barDrag = !!gesture.drag?.bar;
  const pinItems = rightPin ? [{ id: 'right-pin', label: rightPin.pinned ? t('移回中栏') : t('固定到右侧') }] : [];
  return (
    <div ref={host} className="center-pane-toolbar-host" onPointerEnter={() => setHovered(true)} onPointerMove={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
    <div className="center-pane-toolbar-hotzone" aria-hidden="true" />
    <div role="toolbar" aria-label={title}
      data-mp-stage={toolbarPresence.mounted ? toolbarPresence.stage : 'out'}
      onFocusCapture={e => { setKeyboardFocus((e.target as HTMLElement).matches(':focus-visible')); onFocus(); }}
      onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyboardFocus(false); }}
      onPointerDown={onFocus}
      className={`center-split-pane-toolbar mp-scrim${active ? ' is-focused' : ''}${menuAt ? ' has-menu' : ''}${moving ? ' is-moving' : ''}${barDrag ? ' is-bar-drag' : ''}`}>
      <div className="center-pane-leading">
        {crumbs && crumbs.length > 0 ? (
          <nav className="center-pane-crumbs" aria-label={t('会话层级')}>
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <span key={crumb.id} className="center-pane-crumb-wrap">
                  {index > 0 ? (
                    <span className="center-pane-crumb-sep" aria-hidden>
                      <IconChevronDown size={12} />
                    </span>
                  ) : null}
                  {last ? (
                    <span className="center-pane-crumb is-current" aria-current="true">
                      <span className="center-pane-crumb-kind">{crumb.kindLabel}</span>
                      <span className="center-pane-crumb-name">{crumb.name}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="center-pane-crumb"
                      title={t('回到 {{name}}', { name: crumb.name })}
                      onClick={() => crumb.onNavigate?.()}
                    >
                      <span className="center-pane-crumb-kind">{crumb.kindLabel}</span>
                      <span className="center-pane-crumb-name">{crumb.name}</span>
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        ) : (
          <span className="center-split-handle-name" title={title}>{title}</span>
        )}
        {status && <span className="center-pane-status" title={statusLabel}>
          <SessionStatusIcon status={status} size={13}/><span>{statusLabel}</span>
        </span>}
        {workerLabel && <span className="center-split-handle-type" title={workerLabel}>{workerLabel}</span>}
        <span className="center-pane-progress" title={progress}>{progress}</span>
      </div>
        <button
          type="button"
          ref={trigger}
          className="center-split-handle"
          data-testid={`center-pane-handle-${slot}`}
          aria-label={t('{{name}}：分屏操作', { name: title })}
          aria-haspopup="menu"
          aria-expanded={menuAt != null}
          title={t('拖动或长按以选择分屏布局')}
          onFocus={onFocus}
          onPointerDown={e => { onFocus(); gesture.down(slot, e); }}
          onPointerMove={gesture.move}
          onPointerUp={gesture.up}
          onPointerCancel={gesture.cancel}
          onLostPointerCapture={gesture.cancel}
          onClick={e => {
            e.stopPropagation();
            if (gesture.consumeClick(e.detail !== 0)) return;
            toggleMenu(e.currentTarget);
          }}
        >
          <span aria-hidden className="center-split-handle-dots"><IconMore size={16}/></span>
        </button>
      <div className="center-pane-trailing">
        {paneSwitch}
        <div className="center-pane-actions">
        {onFullscreen && <button type="button" className="center-pane-action" aria-label={t(fullscreen ? '退出全屏' : '全屏显示')}
          title={t(fullscreen ? '退出全屏' : '全屏显示')} onClick={onFullscreen}>{fullscreen ? <IconShrink size={15}/> : <IconExpand size={15}/>}</button>}
        {onFind && <button type="button" className="center-pane-action" aria-label={t('查找会话消息')}
          title={t('查找会话消息')} onClick={() => { onFocus(); onFind(); }}><IconSearch size={15}/></button>}
        <button type="button" className="center-pane-action center-pane-layout-action" aria-label={t('选择分屏布局')}
          title={t('选择分屏布局')} disabled={snapDisabled} onClick={() => { onFocus(); gesture.openPicker(slot); }}><IconLayout size={15}/></button>
        {onClose && <button type="button" className="center-pane-action" aria-label={t('关闭面板')}
          title={t('关闭面板')}
          onClick={e => { e.stopPropagation(); onClose(); }}><IconClose size={15}/></button>}
        </div>
      </div>
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          onClose={() => setMenuAt(null)}
          anchor={trigger}
          excludeCloseRef={trigger}
          onSelect={id => {
            if (id === 'swap') onSwap();
            else if (id === 'flip') onFlip();
            else if (id === 'reset-ratio') onResetRatio();
            else if (id === 'dissolve') onDissolve();
            else if (id === 'close') onClose?.();
            else if (id === 'harness') agentControl?.toggle();
            else if (id === 'snap-layout') gesture.openPicker(slot);
            else if (id === 'right-pin') rightPin?.toggle();
            else if (id === 'fullscreen') onFullscreen?.();
            else if (id === 'row' || id === 'col') {
              centerSplitToggleShortcut();
              if (getCenterSplitState().open && getCenterSplitState().dir !== id) onFlip();
            }
          }}
          items={splitOpen ? [
            { id: 'name', label: title, disabled: true },
            ...(agentControl ? [{ id: 'harness', label: t('Harness 透明'), checked: agentControl.on }] : []),
            ...pinItems,
            ...(onFullscreen ? [{ id: 'fullscreen', label: t(fullscreen ? '退出全屏' : '全屏显示') }] : []),
            { id: 'snap-layout', label: t('选择分屏布局'), disabled: snapDisabled },
            ...(paneCount === 2 ? [{ id: 'swap', label: t('与对面交换'), disabled: secondaryEmpty },
              { id: 'flip', label: splitDir === 'row' ? t('转为上下分屏') : t('转为左右分屏') },
              ] : []),
            { id: 'reset-ratio', label: t('分隔条回到居中') },
            { id: 'dissolve', label: t('解散分屏（保留此侧）') },
            { id: 'close', label: t('收起此侧') },
          ] : [
            { id: 'name', label: title, disabled: true },
            ...(agentControl ? [{ id: 'harness', label: t('Harness 透明'), checked: agentControl.on }] : []),
            ...pinItems,
            ...(onFullscreen ? [{ id: 'fullscreen', label: t(fullscreen ? '退出全屏' : '全屏显示') }] : []),
            { id: 'snap-layout', label: t('选择分屏布局'), disabled: snapDisabled },
            { id: 'row', label: t('转为左右分屏') },
            { id: 'col', label: t('转为上下分屏') }
          ]}
        />
      )}
    </div>
    </div>
  );
}

function CenterPanelInner({
  utilityPanel,
  onCloseUtilityPanel,
  onOpenSettings,
  onSelectUtilityPanel,
  settingsPrepared = false,
  emptyGuide,
  backgroundViews = [],
  retainedFiles = [],
  onSettingsHost,
  onSettingsVisibilityChange
}: {
  utilityPanel: UtilitySelection | null;
  onCloseUtilityPanel: () => void;
  /** 打开设置（从工具面板跳设置；App 的 openSettings） */
  onOpenSettings?: (tab?: 'memory' | 'worker') => void;
  onSelectUtilityPanel?: (selection: UtilitySelection) => void;
  settingsPrepared?: boolean;
  emptyGuide?: React.ReactNode;
  backgroundViews?: ReadonlyArray<BackgroundViewTab & { target: SplitPaneRef }>;
  retainedFiles?: ReadonlyArray<{ workspaceId: string; tabId: string; label: string; centerOnly: boolean }>;
  onSettingsHost?: (host: HTMLDivElement | null) => void;
  onSettingsVisibilityChange?: (visible: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { activeWorkspaceId, workspaces, switchWorkspace } = useWorkspaceStore();
  const navigation = useWorkbenchNavigation(activeWorkspaceId ?? '');
  const { sessions, displayActiveId } = useSessionStore();
  const { runtimes } = useRuntimesStore();
  const split = useCenterSplit();
  const active = sessions.find((s) => s.id === displayActiveId);
  const terminals = sessions.filter((s) => s.type === 'terminal');
  const [agentControls, setAgentControls] = useState<Record<string, AgentPaneControl>>({});
  const registerAgentControl = useCallback((id: string, control: AgentPaneControl | null) => {
    setAgentControls(prev => {
      if (!control && !prev[id]) return prev;
      const next = { ...prev }; if (control) next[id] = control; else delete next[id]; return next;
    });
  }, []);
  // P1-3：长任务诊断的活跃会话摘要接线（id 尾段+名称，脱敏不含消息正文）
  useEffect(() => {
    setLongtaskSessionSummary(active ? `${active.id.slice(-8)}:${active.name}` : null);
  }, [active?.id, active?.name]);
  // 字典只随 runtimes 变化重建，避免每次渲染新对象/新引用
  const runtimesById = useMemo(
    () => {
      const lookup = sessionRuntimeLookup(runtimes);
      // Only the host's fallback is translated; a registered runtime keeps its own label.
      if (!runtimes.some(runtime => runtime.id === 'cursor') && lookup.cursor)
        lookup.cursor = { ...lookup.cursor, label: t('Cursor（旧会话）') };
      return lookup;
    },
    [runtimes, t]
  );

  // ---- 分屏 pane 解析 ----
  // pane0 = 当前选中（utilityPanel 优先，其次 displayActiveId 会话）；pane1 = store.secondary
  const pane0Ref: SplitPaneRef = utilityPanel != null
    ? { kind: 'utility', sel: utilityPanel }
    : isCenterSplitSession(active)
      ? { kind: 'session', sessionId: active.id }
      : { kind: 'empty' };
  const pane1Ref: SplitPaneRef = split.secondary;
  const paneRefs = getCenterSplitPaneRefs(pane0Ref, split);
  // ── 会话视图保活 LRU（2026-10-14）：只挂最近访问的 N 个视图，其余真卸载。
  // 访问 = 成为中栏选中或分屏引用；显示中的会话在渲染过滤里恒保（不依赖
  // touch 时序）。被逐出的会话切回时重付一次首开（渐进挂载摊薄），阅读位置
  // 由 ChatTranscript 的滚动记忆恢复。版本号入 deps：存活集合变化才重算。 ──
  const viewsVersion = useSyncExternalStore(subscribeSessionViews, getSessionViewsVersion);
  useEffect(() => {
    if (displayActiveId) touchSessionView(displayActiveId);
  }, [displayActiveId]);
  const splitSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ref of paneRefs) {
      if (ref.kind === 'session' && ref.sessionId !== displayActiveId) ids.add(ref.sessionId);
    }
    return ids;
    // paneRefs 是每渲染新建的数组：按其会话成员拼稳定键做 memo 依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneRefs.map((r) => (r.kind === 'session' ? r.sessionId : '')).join('|'), displayActiveId]);
  useEffect(() => {
    for (const id of splitSessionIds) touchSessionView(id);
  }, [splitSessionIds]);
  useEffect(() => {
    retainSessionViews(new Set(sessions.map((s) => s.id)));
  }, [sessions]);
  const dock = useRightDock();
  const rightPin = useRightPin();
  const dockedSessionIds = useMemo(() => [...dock.docked].flatMap(key => key.startsWith('session:') ? [key.slice(8)] : []), [dock.docked]);
  const backgroundSessionKey = JSON.stringify(backgroundViews.flatMap(view => view.target.kind === 'session' ? [view.target.sessionId] : []));
  const keptTerminals = useMemo(
    // 固定在右侧的会话由右侧显示，不受中栏 LRU 逐出
    () => keptSessionViews(terminals, displayActiveId, new Set([...splitSessionIds, ...dockedSessionIds, ...JSON.parse(backgroundSessionKey) as string[]])),
    // viewsVersion：LRU 存活集合版本（touch/retain 通知时重算过滤）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminals, displayActiveId, splitSessionIds, viewsVersion, dockedSessionIds, backgroundSessionKey]
  );
  const paneSlots = paneRefs.map((_, index) => index as CenterPaneSlot);
  const mainRef = useRef<HTMLElement>(null);
  const fullscreen = useCenterPaneFullscreen(JSON.stringify([activeWorkspaceId, nativeLayoutKey(pane0Ref, split)]), mainRef);
  const fullscreenSlot = fullscreen.slot;
  const [size, setSize] = useState({ width: 0, height: 0 });

  /** 窄屏降级：中央区宽不足时只显示焦点 pane（布局保留，拖宽自动恢复） */
  const splitNarrow = split.open && size.width > 0 && size.width < SPLIT_NARROW_PX;
  const singlePane = splitNarrow || fullscreenSlot != null;
  const visibleSlot = fullscreenSlot ?? split.focused;
  const splitActive = split.open && !singlePane;

  // Geometry is derived from the current mode, never retained from a removed pane.
  const measure = useCallback(() => {
    const main = mainRef.current;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const width = main.clientWidth || rect.width, height = main.clientHeight || rect.height;
    setSize(prev => prev.width === width && prev.height === height ? prev : { width, height });
  }, []);
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (mainRef.current) observer.observe(mainRef.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);
  const gesture = useCenterPaneDrag(mainRef, split, pane0Ref, splitNarrow, (action, slot) => {
    if (action === 'fullscreen') { void fullscreen.enter(slot); }
    else closePane(slot);
  });
  const pending = split.pendingLayout;
  const pendingRefs = pending?.panes ?? (pending ? [pending.pane0, pending.pane1, ...(pending.pane2 ? [pending.pane2] : [])] : []);
  const currentFilled = paneRefs.filter(ref => ref.kind !== 'empty');
  const pendingMatches = pending && pendingRefs.length > 1 && currentFilled.every(ref => pendingRefs.some(other => samePaneRef(ref, other))) &&
    pendingRefs.filter(ref => ref.kind !== 'empty').every(ref => currentFilled.some(other => samePaneRef(ref, other)));
  const full = { top: 0, left: 0, width: size.width, height: size.height };
  const displayCells = getCenterSplitPaneCells(pendingMatches ? { open: true, secondary: pending.pane1, tertiary: pending.pane2,
    dir: pending.dir, ratio: pending.ratio, ratios: pending.ratios, layoutId: pending.layoutId, order: pending.order } : split);
  const pixelRect = (cell: { x: number; y: number; width: number; height: number }): CenterPaneRect => ({ left: cell.x * size.width, top: cell.y * size.height, width: cell.width * size.width, height: cell.height * size.height });
  const pendingEmptySlots = pendingRefs.flatMap((ref, slot) => ref.kind === 'empty' ? [slot] : []);
  let pendingEmptyIndex = 0;
  const paneRects = paneRefs.map((ref, slot) => {
    const mapped = pendingMatches ? ref.kind === 'empty' ? pendingEmptySlots[pendingEmptyIndex++] : pendingRefs.findIndex(other => samePaneRef(ref, other)) : slot;
    return singlePane ? full : pixelRect(displayCells[mapped] ?? { x: 0, y: 0, width: 1, height: 1 });
  });
  if (gesture.drag) {
    paneRects[gesture.drag.slot] = gesture.drag.source;
    const remaining = paneSlots.filter(slot => slot !== gesture.drag!.slot && paneRefs[slot].kind !== 'empty');
    if (remaining.length === 1) paneRects[remaining[0]] = full;
    else if (remaining.length === 2) {
      const cells = getCenterSplitPaneCells(split);
      const dir = cells[remaining[0]].x === cells[remaining[1]].x ? 'col' : 'row';
      remaining.sort((a, b) => cells[a].x - cells[b].x || cells[a].y - cells[b].y);
      const halves = centerPaneRects(size.width, size.height, dir, .5);
      remaining.forEach((slot, index) => { paneRects[slot] = halves[index]; });
    }
  }
  const insetFor = (slot: CenterPaneSlot): CenterPaneRect | null => split.open || gesture.drag ? paneRects[slot] ?? full : null;
  const styleFor = (slot: CenterPaneSlot): React.CSSProperties | undefined => {
    const rect = insetFor(slot);
    if (!rect) return undefined;
    const floating = gesture.drag && gesture.drag.slot === slot;
    return {
      top: rect.top, left: rect.left, right: 'auto', bottom: 'auto', width: rect.width || `${(displayCells[slot]?.width ?? 1) * 100}%`, height: rect.height || `${(displayCells[slot]?.height ?? 1) * 100}%`,
      ...(floating ? { transform: `translate(${gesture.drag!.floating.left - rect.left}px, ${gesture.drag!.floating.top - rect.top}px) scale(${gesture.drag!.scale})`, transformOrigin: '0 0', zIndex: 8 } : {})
    };
  };
  const contentStyleFor = (slot: CenterPaneSlot): React.CSSProperties | undefined => {
    const style = styleFor(slot);
    if (fullscreenSlot != null && slot !== fullscreenSlot) return { ...style, display: 'none' };
    return gesture.drag && gesture.drag.slot === slot
      ? { ...style, background: 'var(--surface-canvas)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }
      : style;
  };

  // 会话视图槽位：该会话显示在哪个 pane（null=不显示）；单开模式保持原
  // visible 语义（CSS :has 负责藏底），分屏模式两槽各自对位、窄屏只留焦点槽
  const sessionSlot = useCallback((sessionId: string): CenterPaneSlot | null => {
    if (!split.open) return sessionId === displayActiveId ? 0 : null;
    const inPane = paneRefs.findIndex(ref => ref.kind === 'session' && ref.sessionId === sessionId);
    if (inPane < 0) return null;
    return singlePane && visibleSlot !== inPane ? null : inPane as CenterPaneSlot;
  }, [split.open, displayActiveId, paneRefs, singlePane, visibleSlot]);

  const utilityOpen = utilityPanel != null && !split.open;

  // 工具面板层列表：当前面板 + 仍在退场的旧面板 + 分屏另一侧的面板，按首次打开顺序排
  // （顺序稳定，避免移动 DOM 节点——扩展 iframe 被移动会整页重载）。层自己播完退场后经
  // onGone 摘除。渲染期入列（同下述 ⚠）。
  const splitSels = useMemo(() => {
    if (!split.open) return [];
    const out: UtilityId[] = [];
    for (const ref of paneRefs) {
      if (ref.kind === 'utility' && !out.includes(ref.sel as UtilityId)) out.push(ref.sel as UtilityId);
    }
    return out;
  }, [split.open, paneRefs]);

  const [layerSels, setLayerSels] = useState<UtilityId[]>(() =>
    utilityPanel != null ? [utilityPanel] : []
  );
  const [closingExtensions, setClosingExtensions] = useState<ReadonlySet<UtilityId>>(() => new Set());
  const [layerWorkspace, setLayerWorkspace] = useState(activeWorkspaceId);
  if (layerWorkspace !== activeWorkspaceId) {
    setLayerWorkspace(activeWorkspaceId); setLayerSels(utilityPanel != null ? [utilityPanel] : []);
    setClosingExtensions(new Set());
  }
  // 分屏另一侧的面板也入列（渲染期 setState：入列当帧渲染，不闪底层）
  const dockedUtilities = [...dock.docked].flatMap(key => key.startsWith('utility:') ? [key.slice(8) as UtilityId] : []);
  const backgroundSels = backgroundViews.flatMap(view => view.target.kind === 'utility' ? [view.target.sel as UtilityId] : []);
  const fileSels: UtilityId[] = retainedFiles.map(file => centerFileDockKey(file.tabId) as UtilityId);
  const [mountedFileHosts, setMountedFileHosts] = useState<readonly string[]>([]);
  const selectedFiles = retainedFiles.filter(file => file.workspaceId === activeWorkspaceId && paneRefs.some(ref => ref.kind === 'utility' && ref.sel === centerFileDockKey(file.tabId))).map(file => file.tabId);
  if (selectedFiles.some(id => !mountedFileHosts.includes(id))) setMountedFileHosts([...new Set([...mountedFileHosts, ...selectedFiles])]);
  const extensionTabs = navigation.nodes.filter(node => node.kind === 'extension' && node.placement === 'tab').map(node => `nav:${node.id}` as UtilityId);
  const externalSels: UtilityId[] = [...extensionTabs, ...dockedUtilities, ...backgroundSels, ...fileSels, ...(settingsPrepared ? ['settings' as const] : [])];
  const missingSels = [...new Set([...splitSels, ...externalSels])].filter(sel => !layerSels.includes(sel));
  if (missingSels.length) setLayerSels([...layerSels, ...missingSels]);
  if (utilityPanel != null && !split.open && !layerSels.includes(utilityPanel)) {
    setLayerSels([...layerSels, utilityPanel]);
  }
  const utilityPanelRef = useRef(utilityPanel);
  utilityPanelRef.current = utilityPanel;
  const splitSelsRef = useRef(splitSels);
  splitSelsRef.current = splitSels;
  const clearExtensionClose = useCallback((sel: UtilityId): void => {
    setClosingExtensions(previous => {
      if (!previous.has(sel)) return previous;
      const next = new Set(previous);
      next.delete(sel);
      return next;
    });
  }, []);
  const dropLayer = useCallback((sel: UtilityId): void => {
    setLayerSels((list) =>
      sel === utilityPanelRef.current || splitSelsRef.current.includes(sel) ? list : list.filter((s) => s !== sel)
    );
    clearExtensionClose(sel);
  }, [clearExtensionClose]);

  function closePane(slot: CenterPaneSlot): void {
    const ref = paneRefs[slot];
    if (ref?.kind === 'utility' && navigation.nodes.some(node => node.kind === 'extension' && `nav:${node.id}` === ref.sel)) {
      setClosingExtensions(previous => new Set(previous).add(ref.sel as UtilityId));
    }
    if (split.open) centerSplitClosePane(slot);
    else if (ref?.kind === 'utility') onCloseUtilityPanel();
  }

  const renderUtility = (sel: NonNullable<UtilitySelection>, slot: CenterPaneSlot | null): React.ReactNode => {
    const centerOnly = split.open && slot != null;
    const ref: SplitPaneRef = { kind: 'utility', sel };
    // Settings uses the shared surface mover but has its own preparation and
    // dirty-state lifecycle; it is not a generic right utility yet.
    const dockKey = sel === 'settings' ? 'utility:settings' : rightDockKey(ref);
    const docked = !!dockKey && dock.docked.has(dockKey);
    // 在右侧显示时，面板自带的关闭只取下右侧标签
    const close = docked ? () => rightPin.unpin(ref) : centerOnly ? () => closePane(slot) : onCloseUtilityPanel;
    const select = (selection: UtilitySelection): void => {
      if (centerOnly && selection) centerSplitSelectInPane(slot!, { kind: 'utility', sel: selection });
      else onSelectUtilityPanel?.(selection);
    };
    const builtin = sel === 'tasks' ? <PromptTaskPanel onNavigateToSession={close} />
      : sel === 'usage' ? <UsageStatsPanel />
      : sel === 'memory' ? <KnowledgeCenter onOpenSettings={onOpenSettings} />
      : sel === 'ext-manager' ? <ExtensionsManagerPage /> : null;
    if (sel === 'settings' && dockKey) return <>
      <DockSurface dockKey={dockKey}><div className="settings-center-host" ref={onSettingsHost} /></DockSurface>
      {docked && layerOpen(sel as UtilityId) ? <DockedPlaceholder target={ref} pin={rightPin} /> : null}
    </>;
    if (builtin && dockKey) return <>
      <DockSurface dockKey={dockKey}>{builtin}</DockSurface>
      {docked && layerOpen(sel as UtilityId) ? <DockedPlaceholder target={ref} pin={rightPin} /> : null}
    </>;
    switch (sel) {
      default: {
        if (sel.startsWith('center-file:')) {
          const file = retainedFiles.find(item => centerFileDockKey(item.tabId) === sel);
          if (!file || (!file.centerOnly && !mountedFileHosts.includes(file.tabId))) return null;
          return <div className="center-file-dock"><RightDockHost dockKey={centerFileDockKey(file.tabId)} hostKey={centerFileHostKey(file.tabId)} shown={file.workspaceId === activeWorkspaceId && layerOpen(sel as UtilityId)} /></div>;
        }
        if (sel.startsWith('nav:')) {
          const closeNavigation = docked || extensionTabs.includes(sel) ? () => rightPin.unpin(ref) : () => closePane(slot ?? 0);
          return <WorkbenchNavigationPanel nodeId={sel.slice(4)} active={layerOpen(sel as UtilityId)} centerOnly={centerOnly} onClose={closeNavigation} onSelect={select} />;
        }
        return null;
      }
    }
  };

  // ---- 拖拽分屏 ----
  const [nativeDrag, setNativeDrag] = useState<NativePaneDrag | null>(null);
  const nativeDragRef = useRef<NativePaneDrag | null>(null);
  const [nativeTarget, setNativeTarget] = useState<CenterSnapTarget | null>(null);
  const [nativeExpanded, setNativeExpanded] = useState(false);
  const nativeExpandedRef = useRef(false);
  const nativeContext = useRef({ primary: pane0Ref, split, cancel: gesture.cancel });
  nativeContext.current = { primary: pane0Ref, split, cancel: gesture.cancel };
  const endNativeDrag = useCallback(() => {
    nativeDragRef.current = null; setNativeDrag(null); setNativeTarget(null); nativeExpandedRef.current = false; setNativeExpanded(false);
  }, []);
  const nativeTargetAt = useCallback((x: number, y: number): CenterSnapTarget | null => {
    for (const element of nativeExpandedRef.current ? mainRef.current?.querySelectorAll<HTMLButtonElement>('[data-center-snap-layout][data-center-snap-index]') ?? [] : []) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return element.disabled ? null : { layoutId: element.dataset.centerSnapLayout as CenterSnapTarget['layoutId'], index: Number(element.dataset.centerSnapIndex) };
      }
    }
    const main = mainRef.current?.getBoundingClientRect(), drag = nativeDragRef.current;
    const picker = mainRef.current?.querySelector('[data-testid="center-snap-bar"]')?.getBoundingClientRect();
    if (!main || !drag || x < main.left || x > main.right || y < main.top || y > main.bottom ||
      nativeExpandedRef.current && picker && x >= picker.left && x <= picker.right && y >= picker.top && y <= picker.bottom) return null;
    const left = x - main.left - drag.grabX, right = left + drag.cardWidth;
    if (left <= 0 || right >= main.width) {
      return { layoutId: 'halves', index: left <= 0 && (right < main.width || x - main.left <= main.right - x) ? 0 : 1 };
    }
    return null;
  }, []);
  const onDragOverMain = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes(SPLIT_DRAG_MIME)) return;
    e.preventDefault();
    const drag = nativeDragRef.current;
    const bounds = mainRef.current?.getBoundingClientRect(), picker = mainRef.current?.querySelector('[data-testid="center-snap-bar"]')?.getBoundingClientRect();
    const expanded = !!drag && !!bounds && e.clientY <= bounds.bottom && centerSnapRevealAt(bounds.width,
      e.clientX - bounds.left, e.clientY - bounds.top, nativeExpandedRef.current,
      picker ? { left: picker.left - bounds.left, top: picker.top - bounds.top, width: picker.width, height: picker.height } : undefined);
    nativeExpandedRef.current = expanded; setNativeExpanded(expanded);
    const target = drag ? nativeTargetAt(e.clientX, e.clientY) : null;
    const candidate = drag && target ? deriveCenterSplitIncomingSnapLayout(drag.primary, drag.original, drag.ref, target) : null;
    const allowed = e.dataTransfer.effectAllowed;
    e.dataTransfer.dropEffect = candidate ? allowed === 'move' || allowed === 'linkMove' ? 'move' : 'copy' : 'none';
    setNativeTarget(candidate ? target : null);
  }, [nativeTargetAt]);
  const onDragLeaveMain = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setNativeTarget(null); nativeExpandedRef.current = false; setNativeExpanded(false);
    }
  }, []);
  const onDropMain = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes(SPLIT_DRAG_MIME)) return;
    e.preventDefault();
    const drag = nativeDragRef.current, target = nativeTargetAt(e.clientX, e.clientY);
    const ref = decodeSplitDragPayload(e.dataTransfer.getData(SPLIT_DRAG_MIME));
    const candidate = drag && target && ref && samePaneRef(ref, drag.ref)
      ? deriveCenterSplitIncomingSnapLayout(drag.primary, drag.original, ref, target) : null;
    endNativeDrag();
    if (candidate) centerSplitCommitIncomingSnapLayout(candidate);
  }, [nativeTargetAt, endNativeDrag]);
  useEffect(() => {
    // Read after the sidebar producer writes its MIME, while dragstart still
    // permits access. Chromium protects getData during later dragover events.
    const start = (e: DragEvent): void => {
      const ref = e.dataTransfer && decodeSplitDragPayload(e.dataTransfer.getData(SPLIT_DRAG_MIME));
      const context = nativeContext.current;
      if (!ref || ref.kind === 'empty' || context.split.pendingLayout) return;
      context.cancel();
      const source = (e.target as HTMLElement | null)?.closest?.('[draggable="true"]')?.getBoundingClientRect();
      const cardWidth = source && source.width > 0 ? source.width : 160;
      const grabX = source ? Math.min(cardWidth, Math.max(0, e.clientX - source.left)) : cardWidth / 2;
      const drag = { ref, primary: context.primary, original: context.split, key: nativeLayoutKey(context.primary, context.split), cardWidth, grabX };
      nativeDragRef.current = drag; setNativeTarget(null); setNativeDrag(drag); nativeExpandedRef.current = false; setNativeExpanded(false);
    };
    const escape = (e: KeyboardEvent): void => { if (e.key === 'Escape') endNativeDrag(); };
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', endNativeDrag); window.addEventListener('drop', endNativeDrag);
    window.addEventListener('blur', endNativeDrag); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('dragstart', start);
      window.removeEventListener('dragend', endNativeDrag); window.removeEventListener('drop', endNativeDrag);
      window.removeEventListener('blur', endNativeDrag); window.removeEventListener('keydown', escape); };
  }, [endNativeDrag]);
  const currentNativeKey = nativeLayoutKey(pane0Ref, split);
  useEffect(() => {
    if (nativeDragRef.current && (nativeDragRef.current.key !== currentNativeKey || split.pendingLayout)) endNativeDrag();
  }, [currentNativeKey, split.pendingLayout, endNativeDrag]);

  // 分屏焦点：点击命中哪个 pane（会话视图是 main 的绝对定位子节点，统一按坐标判）
  const onPointerDownMain = useCallback((e: React.PointerEvent) => {
    if (!split.open) return;
    const main = mainRef.current;
    if (!main || !main.contains(e.target as Node)) return;
    if ((e.target as Element).closest?.('.center-split-pane-toolbar, .center-split-divider, .center-snap-bar-position')) return;
    const base = main.getBoundingClientRect();
    const x = e.clientX - base.left, y = e.clientY - base.top;
    for (const slot of paneSlots) {
      const rect = singlePane && visibleSlot !== slot ? null : paneRects[slot];
      if (!rect) continue;
      if (x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height) {
        centerSplitSetFocused(slot);
        return;
      }
    }
  }, [split.open, singlePane, visibleSlot, paneRects]);
  const onFocusMain = (e: React.FocusEvent): void => {
    if (!split.open || gesture.drag) return;
    const target = e.target as HTMLElement;
    for (const slot of paneSlots) {
      if (target.closest(`[data-pane="${slot}"], [data-center-slot="${slot}"]`)) { centerSplitSetFocused(slot); return; }
    }
    const root = target.closest<HTMLElement>('.terminal-wrap, .agent-chat-view');
    const sessionId = root?.dataset.sessionId;
    if (!sessionId || dock.docked.has(`session:${sessionId}`)) return;
    const slot = sessionSlot(sessionId); if (slot != null) centerSplitSetFocused(slot);
  };
  // Guest documents do not bubble focus into React. Chromium focuses their host
  // iframe when the parent window blurs; read it after that focus has settled.
  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const target = document.activeElement;
        if (!getCenterSplitState().open || !(target instanceof HTMLIFrameElement) || !mainRef.current?.contains(target)) return;
        const slot = target.closest('[data-center-slot]')?.getAttribute('data-center-slot');
        if (slot === '0' || slot === '1' || slot === '2') centerSplitSetFocused(Number(slot) as CenterPaneSlot);
      });
    };
    window.addEventListener('blur', update); window.addEventListener('focus', update);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('blur', update); window.removeEventListener('focus', update); };
  }, []);
  useEffect(() => {
    const focusGuest = (event: MessageEvent): void => {
      if (!getCenterSplitState().open || event.data?.__ma !== true || event.data?.type !== PANEL_FOCUS_EVENT) return;
      for (const iframe of mainRef.current?.querySelectorAll('iframe') ?? []) {
        if (iframe.contentWindow !== event.source) continue;
        const layer = iframe.closest<HTMLElement>('[data-center-slot]');
        if (!layer || layer.getAttribute('aria-hidden') === 'true' || layer.hasAttribute('inert')) return;
        const slot = layer.dataset.centerSlot;
        if (slot === '0' || slot === '1' || slot === '2') centerSplitSetFocused(Number(slot) as CenterPaneSlot);
        return;
      }
    };
    window.addEventListener('message', focusGuest);
    return () => window.removeEventListener('message', focusGuest);
  }, []);

  // ---- 分隔条拖拽 ----
  const dividers = getCenterSplitDividers(split);
  const dividerActive = splitActive && !gesture.drag && !split.pendingLayout && dividers.length > 0;
  const dividerKey = JSON.stringify({ refs: paneRefs, order: split.order, layout: paneRefs.length === 3 ? split.layoutId ?? 'thirds' : split.dir });


  // ---- pane 标题 ----
  const paneTitle = useCallback((ref: SplitPaneRef): string => {
    if (ref.kind === 'empty') return t('选择内容');
    if (ref.kind === 'session') return sessions.find(s => s.id === ref.sessionId)?.name ?? t('会话');
    const sel = ref.sel;
    if (sel === 'tasks') return t('定时任务');
    if (sel === 'usage') return t('使用统计');
    if (sel === 'memory') return t('记忆整理');
    if (sel === 'ext-manager') return t('扩展管理');
    if (sel === 'settings') return t('设置');
    if (sel.startsWith('center-file:')) return retainedFiles.find(file => centerFileDockKey(file.tabId) === sel)?.label ?? sel;
    if (sel.startsWith('nav:')) return navigation.nodes.find(node => node.id === sel.slice(4))?.title ?? sel.slice(4);
    return sel;
  }, [sessions, navigation.nodes, retainedFiles, t]);

  /** 会话运行时标注；普通 Shell 不应显示为 GUI。 */
  /**
   * 层级路径面包屑（子代理通用化 D2）：子代理会话的祖先链，末级是当前会话。
   * 顶层会话返回空——不显示面包屑（保持既有单标题形态，避免给所有会话加噪）。
   */
  const paneCrumbs = useCallback((ref: SplitPaneRef): PaneCrumb[] | undefined => {
    if (ref.kind !== 'session') return undefined;
    const byId = new Map(sessions.map(s => [s.id, s]));
    const chain = sessionAncestry(ref.sessionId, byId);
    // 只有子代理（链长 > 1）才要面包屑
    if (chain.length < 2) return undefined;
    return chain.map((s, index) => ({
      id: s.id,
      name: s.name,
      kindLabel: index < 3 ? t(sessionDepthLabel(index + 1)) : t('第{{n}}层子代理', { n: index + 1 }),
      ...(index < chain.length - 1
        ? {
            onNavigate: () => {
              // 回跳祖先：跨工作区时先切区（jumpToSession 统一处理）
              void jumpToSession({
                sessionId: s.id,
                workspaceId: s.workspaceId,
                activeWorkspaceId,
                switchWorkspace
              });
            }
          }
        : {})
    }));
  }, [sessions, activeWorkspaceId, switchWorkspace, t]);

  const paneWorker = useCallback((ref: SplitPaneRef): string | null => {
    if (ref.kind !== 'session') return null;
    const s = sessions.find(item => item.id === ref.sessionId);
    if (!s) return null;
    return s.runtime ? runtimesById[s.runtime]?.label ?? s.runtime : s.launchKind === 'shell' ? t('终端') : 'GUI';
  }, [sessions, runtimesById, t]);

  const renderSessionView = (s: typeof terminals[number]): React.ReactNode => {
    const entry = s.runtime ? runtimesById[s.runtime] : undefined;
    const slot = sessionSlot(s.id);
    const visible = slot != null;
    const style = slot != null && !(gesture.drag && !split.open && pane0Ref.kind === 'utility') ? contentStyleFor(slot) : undefined;
    const ref: SplitPaneRef = { kind: 'session', sessionId: s.id };
    const dockKey = rightDockKey(ref)!;
    // 固定在右侧：显隐跟随右侧标签，几何由右侧宿主决定
    const docked = dock.docked.has(dockKey);
    const chat = runtimeSurface(entry) === 'chat';
    if (s.archived) return visible ? <ErrorBoundary key={s.id} label={t('归档历史 · 只读')}>
      <ArchivedSessionView session={s} chat={chat} style={style} />
    </ErrorBoundary> : null;
    const view = chat ? (
      <AgentChatView
        sessionId={s.id}
        visible={docked ? dock.shown.has(dockKey) : visible}
        cwd={s.cwd}
        workspaceId={s.workspaceId}
        runtimeId={s.runtime}
        runtimeLabel={entry?.label ?? s.runtime ?? 'GUI'}
        compactHeader
        onPaneControl={registerAgentControl}
        style={docked ? undefined : style}
      />
    ) : s.launchKind === 'shell' ? (
      <TerminalView
        sessionId={s.id}
        workspaceId={s.workspaceId}
        visible={docked ? dock.shown.has(dockKey) : visible}
        cwd={s.cwd}
        style={docked ? undefined : style}
      />
    ) : (
      <CliSessionView session={s} visible={docked ? dock.shown.has(dockKey) : visible}
        skillTarget={s.runtime ? runtimesById[s.runtime]?.integrations?.skillTargets?.find(target => target.kind === 'cli')?.id ?? `runtime:${s.runtime}` : 'runtime:unknown'}
        style={docked ? undefined : style} />
    );
    return (
      <ErrorBoundary key={s.id} label={chat ? t('聊天 {{name}}', { name: s.name }) : t('终端 {{name}}', { name: s.name })}>
        <DockSurface dockKey={dockKey}>{view}</DockSurface>
        {docked && slot != null ? <DockedPlaceholder target={ref} pin={rightPin} style={style} /> : null}
      </ErrorBoundary>
    );
  };

  // 工具层 open 判定：单开=当前选中；分屏=任一 pane 引用它
  const layerOpen = (sel: UtilityId): boolean =>
    (!sel.startsWith('center-file:') || retainedFiles.some(file => file.workspaceId === activeWorkspaceId && centerFileDockKey(file.tabId) === sel)) &&
    (!split.open ? sel === utilityPanel : splitSels.includes(sel) && (!singlePane || paneRefs[visibleSlot]?.kind === 'utility' && (paneRefs[visibleSlot] as { kind: 'utility'; sel: string }).sel === sel));
  const settingsVisible = settingsPrepared && !dock.docked.has('utility:settings') && layerOpen('settings');
  useEffect(() => { onSettingsVisibilityChange?.(settingsVisible); }, [onSettingsVisibilityChange, settingsVisible]);

  const choices: SplitPaneRef[] = [
    ...terminals.filter(session => !session.archived && (session.workspaceId ?? null) === activeWorkspaceId).map(session => ({ kind: 'session' as const, sessionId: session.id })),
    ...['tasks', 'usage', 'memory', 'ext-manager', ...navigation.nodes.map(node => `nav:${node.id}`)]
      .map(sel => ({ kind: 'utility' as const, sel }))
  ].filter(ref => supportsCenterSplitRef(ref, { sessions, navigation: navigation.nodes }) && !paneRefs.some(shown => samePaneRef(ref, shown)));
  const paneBody = (slot: CenterPaneSlot): React.ReactNode => {
    const ref = paneRefs[slot];
    if (!ref) return null;
    if (ref.kind === 'empty') {
      return (
        <SplitContentPicker key={`${activeWorkspaceId}:${slot}`} choices={choices} sessions={sessions}
          workspace={workspaces.find(workspace => workspace.id === activeWorkspaceId)} runtimes={runtimes}
          labelFor={paneTitle} testIdPrefix={`center-snap-fill-${slot}`}
          onOpenWorkerSettings={onOpenSettings ? () => onOpenSettings('worker') : undefined}
          onSelect={choice => centerSplitSelectInPane(slot, choice)} />
      );
    }
    return null;
  };

  const snapTarget = nativeDrag ? nativeTarget : gesture.target;
  const snapCell = snapTarget && CENTER_SNAP_LAYOUTS.find(layout => layout.id === snapTarget.layoutId)?.cells[snapTarget.index];
  const edgeAction = gesture.drag?.edgeAction;
  const actionRect = edgeAction === 'fullscreen' ? full : edgeAction === 'close'
    ? { ...full, top: Math.max(0, size.height - 112), height: Math.min(112, size.height) } : null;
  const previewRect = actionRect ?? (snapCell ? pixelRect(snapCell) : null);
  const dragDecor = usePresenceValue(previewRect ? { rect: previewRect, action: edgeAction ?? ('layout' as const) } : null, MOTION.exitMs);
  const nativePreviewFor = (target: CenterSnapTarget) => nativeDrag
    ? deriveCenterSplitIncomingSnapLayout(nativeDrag.primary, nativeDrag.original, nativeDrag.ref, target) : null;
  const nativeRefs = nativeDrag ? getCenterSplitPaneRefs(nativeDrag.primary, nativeDrag.original) : [];
  const barExpanded = !!nativeDrag ? nativeExpanded : gesture.barOpen;
  const { presence: barPresence, value: barSnapshot } = usePresenceValue(nativeDrag
    ? { expanded: barExpanded, sourceRef: nativeDrag.ref, currentRefs: nativeRefs.some(ref => samePaneRef(ref, nativeDrag.ref)) ? nativeRefs : [...nativeRefs, nativeDrag.ref], previewFor: nativePreviewFor, target: snapTarget }
    : (gesture.barOpen || gesture.drag && edgeAction !== 'fullscreen') && gesture.sourceRef
      ? { expanded: barExpanded, sourceRef: gesture.sourceRef, currentRefs: paneRefs, previewFor: gesture.previewFor, target: snapTarget } : null);
  const liftPresence = usePresence(!!gesture.drag);
  const focusPicker = useRef(false);
  useEffect(() => {
    if (nativeDrag || !gesture.barOpen) { focusPicker.current = false; return; }
    if (!gesture.drag && barPresence.mounted && !focusPicker.current) {
      mainRef.current?.querySelector<HTMLButtonElement>('[data-testid="center-snap-bar"] button:not(:disabled)')?.focus({ preventScroll: true }); focusPicker.current = true;
    }
  }, [gesture.barOpen, gesture.drag, barPresence.mounted, nativeDrag]);
  return (
    <main
      ref={mainRef}
      tabIndex={-1}
      data-testid="center-panel"
      data-preview-side={gesture.drag?.side ?? undefined}
      data-edge-action={edgeAction ?? undefined}
      data-snap-target={snapTarget ? `${snapTarget.layoutId}:${snapTarget.index}` : undefined}
      className={`center-panel${split.open ? ' is-split' : ''}${singlePane ? ' is-split-narrow' : ''}${fullscreenSlot != null ? ' is-pane-fullscreen' : ''}${liftPresence.mounted ? ' is-pane-lifting' : ''}${size.width < 440 ? ' is-snap-compact' : ''}`}
      onDragOver={onDragOverMain}
      onDragLeave={onDragLeaveMain}
      onDrop={onDropMain}
      onPointerDownCapture={onPointerDownMain}
      onFocusCapture={onFocusMain}
    >
      <BackgroundViewTabs tabs={backgroundViews.filter(view => !paneRefs.some(ref => samePaneRef(ref, view.target)))}/>
      <div className="center-split-root" data-testid="center-split-root" data-dir={split.dir} data-layout={split.layoutId ?? split.dir} data-pane-count={paneRefs.length}>
        {([0, 1, 2] as const).map(slot => {
          const ref = paneRefs[slot] ?? { kind: 'empty' };
          const hidden = !paneRefs[slot] || (!split.open && ref.kind === 'empty') || (singlePane && visibleSlot !== slot) || (!!gesture.drag && ref.kind === 'empty');
          const session = ref.kind === 'session' ? sessions.find(s => s.id === ref.sessionId) : undefined;
          const searchable = session && runtimeSurface(session.runtime ? runtimesById[session.runtime] : undefined) === 'chat';
          const canFullscreen = ref.kind !== 'empty' && !split.pendingLayout && supportsCenterSplitRef(ref, {
            sessions, navigation: navigation.nodes,
            centerFileIds: retainedFiles.filter(file => file.workspaceId === activeWorkspaceId).map(file => file.tabId)
          });
          const rect = paneRects[slot] ?? full;
          const standalone = gesture.drag?.slot === slot;
          // Round only the sheet's outside top corners, using physical geometry (including pending/order).
          const topLeft = standalone || rect.top < .5 && rect.left < .5;
          const topRight = standalone || rect.top < .5 && Math.abs(rect.left + rect.width - size.width) < .5;
          return <div key={slot} className="center-split-pane" data-pane={slot} data-testid={`center-pane-${slot}`} data-placement="center" tabIndex={-1}
            data-top-left={topLeft || undefined} data-top-right={topRight || undefined}
            data-floating={gesture.drag && gesture.drag.slot === slot || undefined}
            aria-hidden={hidden || undefined} style={hidden ? { display: 'none' } : { ...(styleFor(slot) ?? { inset: 0 }), zIndex: gesture.drag && gesture.drag.slot === slot ? 9 : 3 }}>
            <PaneToolbar title={paneTitle(ref)} workerLabel={paneWorker(ref)} active={split.focused === slot} slot={slot}
              rightPin={rightPin.canPin(ref) ? { pinned: rightPin.isPinned(ref), toggle: () => rightPin.isPinned(ref) ? rightPin.unpin(ref) : rightPin.pin(ref) } : undefined}
              splitDir={split.dir} splitOpen={split.open} hidden={hidden} moving={!!gesture.drag}
              fullscreen={fullscreenSlot === slot}
              onFullscreen={fullscreenSlot === slot ? () => { void fullscreen.exit(); } : canFullscreen ? () => { centerSplitSetFocused(slot); void fullscreen.enter(slot); } : undefined}
              secondaryEmpty={pane1Ref.kind === 'empty'} gesture={gesture}
              paneCount={paneRefs.length} snapDisabled={ref.kind === 'empty' || !!split.pendingLayout}
              agentControl={ref.kind === 'session' ? agentControls[ref.sessionId] : undefined}
              status={session ? sessionDisplayStatus(session) : undefined} progress={session?.liveStatus?.label}
              crumbs={paneCrumbs(ref)}
              onFind={searchable ? () => patchChatFindShared({ open: true, ownerId: session.id, scope: 'current', activeHitId: null,
                focusEpoch: getChatFindShared().focusEpoch + 1 }) : undefined}
              paneSwitch={!hidden && splitNarrow && fullscreenSlot == null && !gesture.drag && <div className="center-split-pane-switch" aria-label={t('切换分屏会话')}>
                {paneSlots.map(target => <button key={target} type="button" className="center-pane-action"
                  data-testid={`center-pane-switch-${target}`} aria-pressed={split.focused === target}
                  aria-label={t('显示 {{name}}', { name: paneTitle(paneRefs[target]) })} title={paneTitle(paneRefs[target])}
                  onClick={() => centerSplitSetFocused(target)}>{target + 1}</button>)}
              </div>}
              onFocus={() => centerSplitSetFocused(slot)} onSwap={centerSplitSwap} onFlip={centerSplitFlip}
              onResetRatio={centerSplitResetRatio} onDissolve={() => centerSplitDissolve(slot)}
              onClose={canCloseCenterPane(pane0Ref, split, slot) ? () => closePane(slot) : undefined} />
            <div className="center-split-pane-body" data-pane-body={slot}>{split.open ? paneBody(slot) : null}</div>
          </div>;
        })}
        <SnapDividers container={mainRef} dividers={dividers} state={split} enabled={dividerActive}
          layoutKey={JSON.stringify([activeWorkspaceId, dividerKey])} testId="center-split-divider"
          onChange={centerSplitSetDividerRatio} onRestore={(ratio, ratios) => ratios ? centerSplitSetRatios(ratios) : centerSplitSetRatio(ratio)}/>
      </div>
      {gesture.captureActive && <div className="center-pane-capture-shield" data-testid="center-pane-capture-shield" aria-hidden="true" />}
      {layerSels.map((sel) => {
        const index = paneRefs.findIndex(ref => ref.kind === 'utility' && ref.sel === sel);
        const slot = (split.open || gesture.drag) && index >= 0 ? index as CenterPaneSlot : null;
        return (
          <UtilityLayer key={sel.startsWith('center-file:') ? sel : `${activeWorkspaceId}:${sel}`} sel={sel} keep={(sel.startsWith('nav:') && !closingExtensions.has(sel)) || fullscreenSlot != null || externalSels.includes(sel)} open={layerOpen(sel)} inset={slot != null ? insetFor(slot) : null} contentStyle={slot != null ? contentStyleFor(slot) : undefined} slot={slot} onGone={dropLayer} onShow={clearExtensionClose}>
            {renderUtility(sel, slot)}
          </UtilityLayer>
        );
      })}
      {keptTerminals.map(renderSessionView)}
      {!utilityOpen && !gesture.drag && terminals.map(s => {
        const slot = sessionSlot(s.id);
        return slot == null || dock.docked.has(`session:${s.id}`) ? null : <MailEnvelopeViewport key={s.id} mailboxId={s.id} enabled style={contentStyleFor(slot)} />;
      })}
      {!utilityOpen && !split.open && active?.type === 'scheduled' && active.serviceId && (
        <ServiceView serviceId={active.serviceId} />
      )}
      {!utilityOpen && !split.open && !active && (
        <div className="center-placeholder ui-empty">
          {emptyGuide ?? <>
            <div className="empty-logo" aria-hidden>
              <AppLogo size={64} />
            </div>
            <p className="ui-empty-desc">{t('还没有选中会话')}</p>
            <p className="hint-muted">
              {t('在左侧点一项，或对调度 Agent 说「开一个 Claude / Cursor / OpenCode 工作面板」')}
            </p>
          </>}
        </div>
      )}
      {dragDecor.presence.mounted && dragDecor.value && <div className="center-drag-scrim"
        data-testid="center-drag-scrim" {...dragDecor.presence.spread} aria-hidden>
        <div className={`center-pane-blur center-pane-preview mp-scrim${dragDecor.value.action === 'close' ? ' is-close' : ''}`}
          {...dragDecor.presence.spread} style={dragDecor.value.rect} data-testid="center-snap-preview" />
      </div>}
      {dragDecor.presence.mounted && dragDecor.value && <div className="center-drag-hint-pos" aria-hidden>
        <div className={`center-drag-hint mp-pop${dragDecor.value.action === 'close' ? ' is-close' : ''}`} {...dragDecor.presence.spread}>
          {dragDecor.value.action === 'close' ? <IconClose size={18}/> : <IconLayout size={18}/>}
          {t(({ left: '松开后左侧分屏', right: '松开后右侧分屏', fullscreen: '松开后全屏显示', close: '松开后关闭面板', layout: '松开后应用布局' })[dragDecor.value.action])}
        </div>
      </div>}
      {barPresence.mounted && barSnapshot && <div className="center-snap-viewport"><div className="center-snap-bar-position" data-mode={barSnapshot.expanded ? 'expanded' : 'peek'}><CenterSnapBar
        peek={!barSnapshot.expanded}
        layouts={CENTER_SNAP_LAYOUTS.filter(layout => layout.id !== 'wide')}
        currentRefs={barSnapshot.currentRefs} sourceRef={barSnapshot.sourceRef} target={barSnapshot.target} previewFor={barSnapshot.previewFor} labelFor={paneTitle}
        iconFor={ref => ref.kind === 'utility' ? 'tool' : ref.kind === 'session' && runtimeSurface(runtimesById[sessions.find(session => session.id === ref.sessionId)?.runtime ?? '']) !== 'chat' ? 'terminal' : 'chat'}
        presenceSpread={barPresence.spread} onPreview={nativeDrag ? setNativeTarget : gesture.setTarget}
        onSelect={nativeDrag ? target => { const candidate = nativePreviewFor(target); endNativeDrag(); if (candidate) centerSplitCommitIncomingSnapLayout(candidate); } : gesture.selectTarget}
        onDismiss={nativeDrag ? endNativeDrag : gesture.dismissPicker} /></div></div>}
      {nativeDrag && <div className="center-split-drop-overlay"
        data-testid="center-native-drop-shield" data-active="true" aria-hidden />}
    </main>
  );
}

export const CenterPanel = React.memo(CenterPanelInner);
