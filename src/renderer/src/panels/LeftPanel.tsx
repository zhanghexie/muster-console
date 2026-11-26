import { ErrorTip } from '../components/ErrorTip';
import { useScrollEdges } from '../hooks/useScrollEdges';
import { WorktreeCleanupErrorDialog, worktreeCleanupFailure, type WorktreeCleanupFailure } from '../components/WorktreeCleanupErrorDialog';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useSessionStore,
  useRuntimesStore,
  useWorkspaceStore,
  useChatStore,
  useUiStore
} from '../store';
import { ContextMenu, type ContextMenuPoint } from '../components/ContextMenu';
import { runSessionRestart, sessionRestartActions } from '../sessionRestartActions';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import {
  type AgentRuntimeEntry,
  type LiveStatusKind,
  type SessionMeta,
  type ShellProfile,
  type ShellProfileId
} from '../../../shared/types';
import { sessionDisplayStatus } from '../../../shared/boardStatus';
import { adjacentSessionId, compareSessionsByRail } from '../../../shared/workspaceActiveSession';
import { IconBranch, IconChevronDown } from '../components/icons';
import { sessionHarness } from '../sessionHarness';
import { SearchBar } from '../components/SearchBar';
import { CollapsibleRailStack } from '../components/CollapsibleRailStack';
import { useWorkspaceSidebarCollapsed } from '../sidebarPreferences';
import { matchSessionListQuery } from '../../../shared/sessionListSearch';
import { buildSessionTree, countChildSessions, flattenSessionTree, sessionSubtreePostOrder } from '../../../shared/sessionTree';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
import { NewTaskDialog, type NewTaskAdvanced, type NewTaskIsolation } from '../components/NewTaskDialog';
import type { TaskSourceTarget } from '../components/TaskSourceField';
import { useArchiveFlow } from '../components/sessionArchiveFlow';
import { useSessionDeleteFlow } from '../components/sessionDeleteFlow';
import { archivedWorktreeLabel, hasRetainedWorktree, useSessionWorktreeFlow } from '../components/sessionWorktreeFlow';
import { openEvidenceView } from './evidenceViewStore';
import { jumpToSession } from '../sessionJump';
import { markNeedsUnread, useNeedsRead } from './needsReadStore';
import { KeyChordHint, useChordLabel, useKeybinding, useOverlayDismiss } from '../keybindings/KeybindingHost';
import { MemoryCenterBadge } from '../components/MemoryCenterBadge';
import { SessionRowContent } from '../components/SessionRowContent';
import { SessionArchiveIcon, SessionRowTools } from '../components/SessionRowTools';
import { SessionDetailsCard, type SessionDetailsTarget } from '../components/SessionDetailsCard';
import { useHoverPinMenu } from '../hooks/useHoverPinMenu';
import { UtilityNavigationSection } from '../components/UtilityNavigationSection';
import { useExtensionWorkbenchNavigation as useWorkbenchNavigation, saveExtensionNavigation as saveNavigation } from '../extensionWorkbench';
import { SPLIT_DRAG_MIME, encodeSplitDragPayload, getCenterSplitPaneRefs, samePaneRef, type SplitPaneRef, type SplitSide } from '../../../shared/centerSplit';
import { centerSplitIncoming, centerSplitTryFill, getCenterSplitState, useCenterSplit } from '../centerSplitStore';
import { isCenterSplitSession } from '../centerSplitSupport';
import { useRightPin } from '../rightDock';

/** 会话 ⋯ 菜单的「分屏显示 ▸ 左/右/上/下」子菜单项（导出供单测；选中 id 形如 split-left） */
export function splitMenuItems(t: TFunc): { id: string; label: string; children: Array<{ id: string; label: string }> } {
  return {
    id: 'split',
    label: t('分屏显示'),
    children: [
      { id: 'split-left', label: t('左侧') }, { id: 'split-right', label: t('右侧') },
      { id: 'split-top', label: t('上方') }, { id: 'split-bottom', label: t('下方') }
    ]
  };
}

export const RIGHT_PIN_MENU_ID = 'right-pin';
/** 左栏菜单通用「固定到右侧 / 移回中栏」项（会话、终端、实用工具、扩展入口共用） */
export function rightPinMenuItem(t: TFunc, pinned: boolean): { id: string; label: string } {
  return { id: RIGHT_PIN_MENU_ID, label: pinned ? t('移回中栏') : t('固定到右侧') };
}

function runtimeLabel(runtimes: AgentRuntimeEntry[], id?: string | null): string {
  if (!id) return '';
  return runtimes.find((r) => r.id === id)?.label ?? id;
}

/** 供模块级纯函数生成 UI 文案用的翻译函数形参（t 由渲染调用点传入，随语言切换更新） */
type TFunc = (key: string, options?: Record<string, unknown>) => string;

function sessionStateLabel(s: SessionMeta, t: TFunc): string {
  switch (sessionDisplayStatus(s)) {
    case 'scheduled':
      return t('定时任务');
    case 'working':
      return t('工作中');
    case 'exited':
      return t('已退出');
    case 'blocked':
      return t('待确认');
    case 'no_signal':
      return t('无信号');
    case 'waiting':
      return t('需要你');
    case 'done':
      return t('已完成');
    case 'error':
      return t('错误');
    default:
      return t('空闲');
  }
}

function capsuleKindClass(kind?: LiveStatusKind): string {
  switch (kind) {
    case 'active':
      return 'session-capsule active';
    case 'waiting':
      return 'session-capsule waiting';
    case 'done':
      return 'session-capsule done';
    case 'error':
      return 'session-capsule error';
    default:
      return 'session-capsule info';
  }
}

function isAgentSession(s: SessionMeta): boolean {
  return s.type === 'terminal' && s.launchKind !== 'shell';
}

function isShellSession(s: SessionMeta): boolean {
  return s.type === 'terminal' && s.launchKind === 'shell';
}

/** 置顶优先，同组内按 lastUsedAt（缺省 createdAt）新的在上（比较器与主进程切区兜底共用，见 shared/workspaceActiveSession） */
function sortSessions(list: SessionMeta[]): SessionMeta[] {
  return [...list].sort(compareSessionsByRail);
}

/** 内置实用功能及扩展导航入口。 */
export type UtilityPanelId = 'tasks' | 'usage' | 'memory' | 'ext-manager';
export type UtilitySelection = UtilityPanelId | 'settings' | `nav:${string}` | `center-file:${string}`;

const UTILITY_ACTION: Record<UtilityPanelId, string> = {
  tasks: 'utility.tasks',
  usage: 'utility.usage',
  memory: 'utility.memory',
  'ext-manager': 'utility.extManager'
};

const UTILITY_ITEMS: {
  id: UtilityPanelId;
  label: string;
  title: string;
}[] = [
  { id: 'tasks', label: '定时任务', title: '定时执行提示词任务' },
  { id: 'usage', label: '使用统计', title: '会话 / 无头运行 / 能力调用 / 扩展 LLM 统计' },
  { id: 'memory', label: '记忆整理', title: '记忆中心：知识与经验、任务历史、待确认、归档与主动提醒' },
  { id: 'ext-manager', label: '扩展管理', title: '管理本工作区扩展（.muster/extensions/）' }
];

function UtilityFeatureIcon({ id }: { id: UtilityPanelId }): React.JSX.Element {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true as const,
    className: 'utility-feature-svg'
  };
  const stroke = {
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  };

  switch (id) {
    case 'tasks':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" {...stroke} />
          <path d="M8 5.5V8l2 1.5" {...stroke} />
        </svg>
      );
    case 'usage':
      return (
        <svg {...common}>
          <path d="M2.5 13.5h11" {...stroke} />
          <path d="M4.5 13.5V9" {...stroke} />
          <path d="M8 13.5V5" {...stroke} />
          <path d="M11.5 13.5V7" {...stroke} />
          <path d="M3 4.5 6.5 2.8l3 1.7 3.5-2" {...stroke} />
        </svg>
      );
    case 'memory':
      return (
        <svg {...common}>
          <path d="M4 2.5h6.5a1 1 0 0 1 1 1V13L8 11.2 4.5 13.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" {...stroke} />
        </svg>
      );
    case 'ext-manager':
      return (
        <svg {...common}>
          <path
            d="M6 2.8a1.3 1.3 0 0 1 2.6 0V4h1.6a1 1 0 0 1 1 1v1.6h1.2a1.3 1.3 0 0 1 0 2.6h-1.2V11a1 1 0 0 1-1 1H8.6v1.2a1.3 1.3 0 0 1-2.6 0V12H4.4a1 1 0 0 1-1-1V9.2h-.9a1.3 1.3 0 0 1 0-2.6h.9V5a1 1 0 0 1 1-1H6V2.8Z"
            {...stroke}
          />
        </svg>
      );
  }
}

function UtilityFeatureButton({
  item,
  active,
  opened,
  onToggle,
  onMenu
}: {
  item: (typeof UTILITY_ITEMS)[number];
  active: boolean;
  opened: boolean;
  onToggle: () => void;
  /** 右键 / Shift+F10 打开入口菜单（固定到右侧、分屏显示） */
  onMenu: (point: ContextMenuPoint) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const actionId = UTILITY_ACTION[item.id];
  const chord = useChordLabel(actionId);
  // UTILITY_ITEMS 是模块级常量：label/title 在渲染点现场翻译（语言切换可更新）
  const baseTitle = t(item.title);
  const title = chord
    ? t('{{title}}（{{chord}}）', { title: baseTitle, chord })
    : baseTitle;
  return (
    <button
      type="button"
      role="listitem"
      className={`utility-feature-item session-item${active ? ' active is-pane-focused' : ''}${opened ? ' is-pane-open' : ''}`}
      data-pane-open={opened || undefined}
      data-pane-focused={active || undefined}
      aria-pressed={active}
      title={title}
      draggable
      onDragStart={event => {
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData(SPLIT_DRAG_MIME, encodeSplitDragPayload({ kind: 'utility', sel: item.id }));
      }}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu({ x: e.clientX, y: e.clientY, anchor: e.currentTarget });
      }}
      onKeyDown={(e) => {
        if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu({ x: rect.right, y: rect.bottom, anchor: e.currentTarget });
        }
      }}
    >
      <span className="utility-feature-icon" aria-hidden>
        <UtilityFeatureIcon id={item.id} />
      </span>
      <span className="session-name">
        <span className="session-name-text">{t(item.label)}</span>
      </span>
      {item.id === 'memory' ? <MemoryCenterBadge /> : null}
      <KeyChordHint actionId={actionId} />
    </button>
  );
}

function SessionPinIcon(): React.JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      focusable={false}
      className="session-pin-svg"
    >
      <path
        d="M6.25 2.5h3.5c.4 0 .75.35.75.75v.6c1.35.45 2.25 1.7 2.25 3.15v.5H3.25v-.5c0-1.45.9-2.7 2.25-3.15v-.6c0-.4.35-.75.75-.75Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path d="M8 7.5v6.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** 线框铅笔：重命名 */

/** 标题行「显示已归档」开关（工作会话 / 终端各一份，互不影响） */
function SessionArchiveToggle({
  count,
  show,
  hideTitle,
  showTitle,
  onToggle,
  showWhenEmpty = false
}: {
  count: number;
  show: boolean;
  hideTitle: string;
  showTitle: string;
  onToggle: () => void;
  showWhenEmpty?: boolean;
}): React.JSX.Element | null {
  if (count <= 0 && !showWhenEmpty) return null;
  return (
    <button
      type="button"
      className={`git-btn ghost tiny session-archive-toggle${show ? ' is-on' : ''}`}
      aria-label={show ? hideTitle : showTitle}
      aria-pressed={show}
      title={show ? hideTitle : showTitle}
      onClick={onToggle}
    >
      <SessionArchiveIcon />
      {count > 1 ? <span className="git-toolbar-count">{count}</span> : null}
    </button>
  );
}

/** 线框归档盒 */

/** 中断（Ctrl+C）：实心方块 */

interface CtxMenuState extends ContextMenuPoint {
  sessionId: string;
  /** 右键时的会话快照：标记完成 / 归档分流需要 phase / worktree 等事实 */
  session: SessionMeta;
  pinned: boolean;
  archived: boolean;
  /** 遗留 worktree（归档清理保留的隔离区）：路径 */
  orphanWorktree?: string;
  /** 遗留原因：dirty=有未提交改动 / unmerged=分支有未合入提交 / locked=删除失败（目录锁等） */
  orphanWorktreeReason?: string;
  /** 遗留 worktree 的隔离分支（确认框文案用） */
  orphanWorktreeBranch?: string;
}

function snapshotCtxMenu(s: SessionMeta, point: ContextMenuPoint): CtxMenuState {
  const reason = s.worktreePath && s.meta?.orphanWorktree ? s.meta.orphanWorktree : undefined;
  return {
    sessionId: s.id,
    ...point,
    session: s,
    pinned: !!s.pinned,
    archived: !!s.archived,
    orphanWorktree: reason ? s.worktreePath : undefined,
    orphanWorktreeReason: reason === '1' ? 'dirty' : reason,
    orphanWorktreeBranch: s.worktreeBranch,
  };
}

/** 工作会话列表视图 */
function SessionListView({
  flatAgents,
  treeRows,
  matchedCount,
  totalAll,
  emptyText,
  renderItem,
  getItemProps,
  /** twisty 渲染所需的子节点索引与折叠集，由调用方持有（渲染层无业务态） */
  childCount,
  treeCollapsedIds,
  onKeyDown,
  collapsed,
  activeKey,
  transitioning = false
}: {
  flatAgents: SessionMeta[];
  /**
   * 会话树渲染序（子代理通用化）。给出时按树层级渲染并传 level/twisty 信息；
   * 缺省（终端列表）走原扁平渲染。
   */
  treeRows?: Array<{ session: SessionMeta; level: number; parentId: string | null }>;
  /** 过滤后命中数——「无匹配」判定口径 */
  matchedCount: number;
  totalAll: number;
  emptyText?: string;
  renderItem: (
    s: SessionMeta,
    getItemProps: ReturnType<typeof useListKeyboardNav>['getItemProps'],
    level?: number,
    hasChildren?: boolean,
    treeCollapsed?: boolean
  ) => React.JSX.Element;
  /** twisty 渲染所需的子节点索引与折叠集，由调用方持有（渲染层无业务态） */
  childCount?: Map<string, number>;
  treeCollapsedIds?: ReadonlySet<string>;
  getItemProps: ReturnType<typeof useListKeyboardNav>['getItemProps'];
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  collapsed: boolean;
  activeKey: string | null;
  transitioning?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <CollapsibleRailStack collapsed={collapsed} activeKey={activeKey} paused={transitioning} className="session-list ui-list" tabIndex={0} onKeyDown={onKeyDown}>
      {totalAll === 0 ? (
        <div className="session-empty">{emptyText ?? t('当前空，点击+新建')}</div>
      ) : matchedCount === 0 ? (
        <div className="empty-hint">{t('无匹配的工作会话')}</div>
      ) : treeRows ? (
        treeRows.map(row =>
          renderItem(
            row.session,
            getItemProps,
            row.level,
            (childCount?.get(row.session.id) ?? 0) > 0,
            treeCollapsedIds?.has(row.session.id) === true
          )
        )
      ) : (
        flatAgents.map((s) => renderItem(s, getItemProps))
      )}
    </CollapsibleRailStack>
  );
}

function LeftPanelInner({
  utilityPanel,
  onSelectUtilityPanel,
  onCloseUtilityPanel,
  onEnsureWorkspaceVisible,
  onOpenSettings,
  onSessionCreated,
  guideNewSession = false,
  wsSlotRef,
  transitioning = false
}: {
  utilityPanel: UtilitySelection | null;
  onSelectUtilityPanel: (id: UtilitySelection) => void;
  onCloseUtilityPanel: () => void;
  /** 点选模式下从 Git peek 点侧栏时，先拉回工作页 */
  onEnsureWorkspaceVisible?: () => void;
  /** 打开 Harness 等工作台设置。 */
  onOpenSettings?: (tab?: 'worker') => void;
  onSessionCreated?: () => void;
  guideNewSession?: boolean;
  /** 工作区栈槽位（AgentFloat 经 portal 挂工作区胶囊栈进来）：栈随本面板同生共死，
   *  悬停胶囊=悬停面板本体，速览收回计时/显隐绑定不再需要特殊豁免 */
  wsSlotRef?: (el: HTMLDivElement | null) => void;
  transitioning?: boolean;
}): React.JSX.Element {
  const sessionScrollRef = useScrollEdges();
  const { t } = useTranslation();
  const { visibleSessions, displayActiveId } = useSessionStore();
  const { flashTip } = useUiStore();
  /** 左栏会话操作族（新建/重命名/重启/续作/关闭等）失败统一上浮——照 BoardPanel reportError 范式（X4-F02） */
  const reportError = useCallback((err: unknown): void => {
    flashTip(err instanceof Error ? err.message : String(err));
  }, [flashTip]);
  const splitState = useCenterSplit();
  const primary: SplitPaneRef = utilityPanel != null ? { kind: 'utility', sel: utilityPanel }
    : displayActiveId != null ? { kind: 'session', sessionId: displayActiveId } : { kind: 'empty' };
  const openedRefs = getCenterSplitPaneRefs(primary, splitState);
  const focusedRef = openedRefs[splitState.open ? splitState.focused : 0];
  const paneOpened = (ref: SplitPaneRef): boolean => openedRefs.some(opened => samePaneRef(opened, ref));
  const paneFocused = (ref: SplitPaneRef): boolean => !!focusedRef && samePaneRef(focusedRef, ref);
  const focusedSessionId = focusedRef?.kind === 'session' ? focusedRef.sessionId : null;
  const focusedNavigationId = focusedRef?.kind === 'utility' && focusedRef.sel.startsWith('nav:') ? focusedRef.sel.slice(4) : null;
  const openedNavigationIds = openedRefs.flatMap(ref => ref.kind === 'utility' && ref.sel.startsWith('nav:') ? [ref.sel.slice(4)] : []);
  const { runtimes } = useRuntimesStore();
  const readSessions = useNeedsRead();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const { setChatWorkspaceId } = useChatStore();
  const workspace = workspaces.find(w => w.id === activeWorkspaceId);
  const archivedAgentCount = useMemo(
    () => visibleSessions.filter((s) => isAgentSession(s) && s.archived).length,
    [visibleSessions]
  );
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);
  const [retainedWorktreesOnly, setRetainedWorktreesOnly] = useState(false);
  const [bulkDeleteSelection, setBulkDeleteSelection] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (archivedAgentCount > 0) return;
    setRetainedWorktreesOnly(false);
    setBulkDeleteSelection(null);
  }, [archivedAgentCount]);
  const [showArchivedShells, setShowArchivedShells] = useState(false);
  const agentsAll = useMemo(
    () =>
      sortSessions(
        visibleSessions.filter(
          (s) => isAgentSession(s) && !!s.archived === showArchivedAgents &&
            (!showArchivedAgents || !retainedWorktreesOnly || hasRetainedWorktree(s))
        )
      ),
    [visibleSessions, showArchivedAgents, retainedWorktreesOnly]
  );
  const shellsAll = useMemo(
    () =>
      sortSessions(
        visibleSessions.filter(
          (s) => isShellSession(s) && (showArchivedShells || !s.archived)
        )
      ),
    [visibleSessions, showArchivedShells]
  );
  const archivedShellCount = useMemo(
    () => visibleSessions.filter((s) => isShellSession(s) && s.archived).length,
    [visibleSessions]
  );
  const [agentSearchOpen, setAgentSearchOpen] = useState(false);
  const [agentSearchQuery, setAgentSearchQuery] = useState('');
  const [shellSearchOpen, setShellSearchOpen] = useState(false);
  // 四组折叠状态按工作区独立保存，切区立即恢复对应快照。
  const [agentsCollapsed, setAgentsCollapsed] = useWorkspaceSidebarCollapsed(activeWorkspaceId, 'sessions');
  const [shellsCollapsed, setShellsCollapsed] = useWorkspaceSidebarCollapsed(activeWorkspaceId, 'terminals');
  const [utilityCollapsed, setUtilityCollapsed] = useWorkspaceSidebarCollapsed(activeWorkspaceId, 'utilities');
  const [shellSearchQuery, setShellSearchQuery] = useState('');
  const [shellProfiles, setShellProfiles] = useState<ShellProfile[] | null>(null);
  const [shellMenuBusy, setShellMenuBusy] = useState(false);
  const [openCreateMenu, setOpenCreateMenu] = useState<'shell' | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [extensionDraftRevision, setExtensionDraftRevision] = useState(0);
  const [extensionDraft, setExtensionDraft] = useState<import('../../../shared/ipcEvents').IpcEventMap['extensionSurface:newTask']>();
  useEffect(() => window.api.on('extensionSurface:newTask', draft => {
    if (workspace?.id !== draft.source.workspaceId) return;
    setExtensionDraftRevision(value => value + 1);
    setExtensionDraft(draft);
    setNewTaskOpen(true);
  }), [workspace?.id]);
  useEffect(() => {
    if (extensionDraft && workspace?.id !== extensionDraft.source.workspaceId) {
      setNewTaskOpen(false);
      setExtensionDraft(undefined);
    }
  }, [workspace?.id, extensionDraft]);
  const closeNewTask = (): void => { setNewTaskOpen(false); };
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [utilityMenu, setUtilityMenu] = useState<ContextMenuPoint & { id: UtilityPanelId } | null>(null);
  const rightPin = useRightPin();
  const toggleRightPin = useCallback((ref: SplitPaneRef): void => {
    if (rightPin.isPinned(ref)) rightPin.moveToCenter(ref); else rightPin.pin(ref);
  }, [rightPin]);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const detailsAnchorRef = useRef<SessionDetailsTarget | null>(null);
  const detailsPreview = useHoverPinMenu<SessionDetailsTarget>((a, b) => a.id === b.id, () => true);
  const previewSession = visibleSessions.find(s => s.id === detailsPreview.data?.id);
  useEffect(() => setHoveredSessionId(null), [activeWorkspaceId]);
  useEffect(() => {
    detailsPreview.close();
    const close = detailsPreview.close;
    const onScroll = (event: Event): void => {
      // 全局捕获也收到聊天流自动贴底的 scroll；只取消 anchor 容器的预览/待打开计时器。
      // 卡片自身还有滚动过滤，不能在父组件这里无条件先关掉。
      const target = detailsAnchorRef.current;
      if (event.target instanceof Element) {
        const anchor = target?.anchor.isConnected ? target.anchor
          : target && document.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(target.id)}"]`);
        if (!anchor || !event.target.contains(anchor)) return;
      }
      close();
    };
    // capture Esc 让位（keybindings F-05）：同在 window capture、注册更早的
    // 监听（快捷键录制取消 / overlay 栈关弹窗）已 preventDefault 时不再关预览，
    // 否则录制中按 Esc 会连会话详情预览一起误关。
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('blur', close); window.removeEventListener('keydown', onKey, true); };
  }, [activeWorkspaceId, detailsPreview.close]);
  const [discardWorktreeConfirm, setDiscardWorktreeConfirm] = useState<{
    sessionId: string;
    path: string;
    reason?: string;
    branch?: string;
  } | null>(null);
  const [cleanupError, setCleanupError] = useState<WorktreeCleanupFailure | null>(null);
  const reportCleanupError = useCallback((err: unknown, sessionId?: string, intent?: 'delete'): void => {
    setCleanupError(worktreeCleanupFailure(err, visibleSessions.find(session => session.id === sessionId), intent));
  }, [visibleSessions]);
  const { requestDelete, deleteFlowNode } = useSessionDeleteFlow(reportCleanupError);
  const { showWorktree, worktreeFlowNode } = useSessionWorktreeFlow(visibleSessions, reportCleanupError);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const shellMenuRef = useRef<HTMLDivElement>(null);
  const agentSearchRef = useRef<HTMLInputElement>(null);
  const shellSearchRef = useRef<HTMLInputElement>(null);

  const matchSession = useCallback(
    (s: SessionMeta, q: string): boolean =>
      matchSessionListQuery(s, q, runtimeLabel(runtimes, s.runtime)),
    [runtimes]
  );

  const agentFilterQ = agentSearchQuery.trim().toLowerCase();
  const agents = useMemo(
    () => agentsAll.filter((s) => matchSession(s, agentFilterQ)),
    [agentsAll, agentFilterQ, matchSession]
  );

  /**
   * 会话树（子代理通用化）：带 parentSessionId 的会话挂在父下方缩进一级。
   * agentsAll 已按 lastUsedAt 排序，树构建保持该顺序（顶层与各层子会话都保序）。
   * 父被搜索过滤掉时子提升为顶层——不让子代理凭空消失。
   */
  /** 折叠的父 id 集合：其子树整体不渲染 */
  const [collapsedAgentTrees, setCollapsedAgentTrees] = useState<ReadonlySet<string>>(() => new Set());
  const toggleAgentTree = useCallback((id: string): void => {
    setCollapsedAgentTrees(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const agentTree = useMemo(
    () => buildSessionTree(agents, { include: isAgentSession }),
    [agents]
  );
  /** 扁平化后的渲染序（含 level），键盘导航序列与之同源 */
  const agentTreeRows = useMemo(
    () => flattenSessionTree(agentTree, { collapsed: collapsedAgentTrees }),
    [agentTree, collapsedAgentTrees]
  );
  /** 折叠时仍需知道有无子节点，故子节点数从**未折叠**的树统计 */
  const agentChildCount = useMemo(() => countChildSessions(agentTree), [agentTree]);

  const shellFilterQ = shellSearchQuery.trim().toLowerCase();
  const shells = useMemo(
    () => shellsAll.filter((s) => matchSession(s, shellFilterQ)),
    [shellsAll, shellFilterQ, matchSession]
  );

  /** 点击左侧栏会话/工具入口时收起调度浮动对话面板（2026-10-07 报单⑤）：
   *  与手动收起同语义——置空 chatWorkspaceId，面板 presence 退场，不销毁状态 */
  const collapseAgentFloat = useCallback((): void => {
    setChatWorkspaceId(null);
  }, [setChatWorkspaceId]);

  const selectUtility = useCallback(
    (sel: UtilitySelection): void => {
      collapseAgentFloat();
      onSelectUtilityPanel(sel);
    },
    [onSelectUtilityPanel, collapseAgentFloat]
  );

  const select = useCallback((id: string): void => {
    collapseAgentFloat();
    // 分屏焦点在第二 pane 时：点击列表项填充分屏位，不切换主选中
    if (centerSplitTryFill({ kind: 'session', sessionId: id })) return;
    onEnsureWorkspaceVisible?.();
    onCloseUtilityPanel();
    void jumpToSession({ sessionId: id });
  }, [onCloseUtilityPanel, onEnsureWorkspaceVisible, collapseAgentFloat]);

  /** 键盘导航序列 = 列表行序（树序：父在子前，与视觉一致） */
  const agentIds = useMemo(() => agentTreeRows.map((r) => r.session.id), [agentTreeRows]);
  const shellIds = useMemo(() => shells.map((s) => s.id), [shells]);
  const agentSelectedId =
    focusedSessionId != null && agentIds.includes(focusedSessionId) ? focusedSessionId : null;
  const shellSelectedId =
    focusedSessionId != null && shellIds.includes(focusedSessionId) ? focusedSessionId : null;

  const {
    onListKeyDown: onAgentListKeyDown,
    getItemProps: getAgentItemProps
  } = useListKeyboardNav({
    items: agentIds,
    selectedId: agentSelectedId,
    onSelect: select,
    pauseReveal: transitioning
  });
  const {
    onListKeyDown: onShellListKeyDown,
    getItemProps: getShellItemProps
  } = useListKeyboardNav({
    items: shellIds,
    selectedId: shellSelectedId,
    onSelect: select,
    pauseReveal: transitioning
  });


  const createTerminal = async (runtime: string, name?: string, advanced?: NewTaskAdvanced, source?: TaskSourceTarget, isolation?: NewTaskIsolation): Promise<void> => {
    setOpenCreateMenu(null);
    await window.api.sessions.create({
      runtime,
      ...(source ?? { workspaceId: workspace?.id, rootsRevision: workspace?.rootsRevision }),
      ...(name ? { name } : {}),
      ...(advanced ?? {}),
      ...(isolation ?? {})
    });
  };  const createShell = (profileId: ShellProfileId): void => {
    setOpenCreateMenu(null);
    void window.api.sessions.create({ shellProfileId: profileId }).catch(reportError);
  };

  const ensureShellProfiles = useCallback((): void => {
    if (shellProfiles !== null || shellMenuBusy) return;
    setShellMenuBusy(true);
    void window.api.shell
      .listProfiles()
      .then((list) => setShellProfiles(list))
      .catch(() => setShellProfiles([]))
      .finally(() => setShellMenuBusy(false));
  }, [shellProfiles, shellMenuBusy]);

  const { requestArchive, archiveFlowNode } = useArchiveFlow(visibleSessions);

  const archiveFromRail = (session: SessionMeta, archived: boolean): void => {
    const excludedIds = new Set(sessionSubtreePostOrder(visibleSessions, session.id).map(row => row.id));
    if (archived && displayActiveId && excludedIds.has(displayActiveId)) {
      const orderedIds = [...agentTreeRows.map(row => row.session), ...shells]
        .filter(row => !row.archived).map(row => row.id);
      const nextId = adjacentSessionId(orderedIds, displayActiveId, excludedIds);
      if (nextId) {
        requestArchive(session, true, { activeId: displayActiveId, nextId });
        return;
      }
    }
    requestArchive(session, archived);
  };


  const openCtxMenu = (e: React.MouseEvent, s: SessionMeta): void => {
    e.preventDefault();
    e.stopPropagation();
    detailsPreview.close();
    setCtxMenu(snapshotCtxMenu(s, { x: e.clientX, y: e.clientY, anchor: e.currentTarget }));
  };

  const closeCtxMenu = useCallback((): void => setCtxMenu(null), []);

  useEffect(() => {
    if (!openCreateMenu) return;
    const onDown = (ev: MouseEvent): void => {
      const target = ev.target as Node;
      if (openCreateMenu === 'shell' && shellMenuRef.current?.contains(target)) return;
      setOpenCreateMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
    };
  }, [openCreateMenu]);
  useOverlayDismiss(openCreateMenu != null, () => setOpenCreateMenu(null));

  const toggleUtility = useCallback(
    (id: UtilityPanelId): void => {
      const split = getCenterSplitState();
      if (utilityPanel === id && (!split.open || split.focused === 0)) onCloseUtilityPanel();
      else selectUtility(id);
    },
    [utilityPanel, onCloseUtilityPanel, selectUtility]
  );
  useKeybinding('utility.tasks', () => toggleUtility('tasks'));
  useKeybinding('utility.usage', () => toggleUtility('usage'));
  useKeybinding('utility.memory', () => toggleUtility('memory'));
  useKeybinding('utility.extManager', () => toggleUtility('ext-manager'));
  useKeybinding('session.newTask', () => {
    onEnsureWorkspaceVisible?.();
    setExtensionDraft(undefined);
    setNewTaskOpen(true);
  });
  const newTaskChord = useChordLabel('session.newTask');

  useEffect(() => {
    if (agentSearchOpen) agentSearchRef.current?.focus();
  }, [agentSearchOpen]);

  useEffect(() => {
    if (shellSearchOpen) shellSearchRef.current?.focus();
  }, [shellSearchOpen]);

  useEffect(() => {
    if (!editingId) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [editingId]);

  const startRename = (id: string, current: string): void => {
    detailsPreview.close();
    setEditingId(id);
    setEditName(current);
    closeCtxMenu();
  };

  const commitRename = (): void => {
    if (!editingId) return;
    const id = editingId;
    const name = editName.trim();
    setEditingId(null);
    if (!name) return;
    void window.api.sessions.rename(id, name).catch(reportError);
  };

  const cancelRename = (): void => setEditingId(null);

  const togglePin = (id: string, pinned: boolean): void => {
    closeCtxMenu();
    if (typeof window.api.sessions.setPinned !== 'function') {
      console.error('[LeftPanel] sessions.setPinned 不可用，请完全重启应用（preload 需重载）');
      return;
    }
    void window.api.sessions.setPinned(id, pinned).catch((err: unknown) => {
      console.error('[LeftPanel] setPinned failed', err);
    });
  };

  const renderItem = (
    s: SessionMeta,
    getItemProps: ReturnType<typeof useListKeyboardNav>['getItemProps'],
    /** 树层级：0 = 顶层，1 = 子代理，2 = 孙代理 */
    level = 0,
    /** 该行是否有子会话（决定 twisty 是否渲染） */
    hasChildren = false,
    /** 该行的子树是否处于折叠态 */
    treeCollapsed = false
  ): React.JSX.Element => {
    const renaming = editingId === s.id;
    const st = sessionDisplayStatus(s);
    const grayed = s.archived || st === 'exited';
    const dimState = st === 'idle' || st === 'no_signal' || grayed || st === 'scheduled';
    const stateLabel = sessionStateLabel(s, t);
    const worktreeLabel = archivedWorktreeLabel(s, t);
    const capsuleLabel = isAgentSession(s) && readSessions.has(s.id) && hoveredSessionId !== s.id
      ? '' : s.liveStatus?.label || stateLabel;
    const capsuleKind = s.liveStatus?.kind ?? (st === 'done' ? ('done' as const) : undefined);
    const harness = sessionHarness(s, runtimeLabel(runtimes, s.runtime));
    const ref: SplitPaneRef = { kind: 'session', sessionId: s.id };
    const opened = paneOpened(ref), focused = paneFocused(ref);
    return (
      <div
        key={s.id}
        {...getItemProps(s.id)}
        className={`session-item${focused ? ' active is-pane-focused' : ''}${opened ? ' is-pane-open' : ''}${s.pinned ? ' is-pinned' : ''}${
          grayed ? ' is-exited' : ''
        }${s.archived ? ' is-archived' : ''}`}
        data-has-children={hasChildren || undefined}
        data-pane-open={opened || undefined}
        data-pane-focused={focused || undefined}
        data-session-row={s.id}
        data-tree-level={level || undefined}
        aria-current={focused ? 'true' : undefined}
        aria-expanded={hasChildren ? !treeCollapsed : undefined}
        aria-describedby={detailsPreview.data?.id === s.id ? `session-details-${s.id}` : undefined}
        draggable={isCenterSplitSession(s)}
        onDragStart={event => {
          detailsPreview.close();
          // 从 twisty 起的拖拽不是分屏拖拽（点 twisty 只折叠），须显式拒绝
          if (!isCenterSplitSession(s) || (event.target as HTMLElement | null)?.closest('.session-tree-twisty')) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData(SPLIT_DRAG_MIME, encodeSplitDragPayload({ kind: 'session', sessionId: s.id }));
        }}
        onClick={(e) => {
          e.stopPropagation();
          detailsPreview.close();
          if (!renaming) select(s.id);
        }}
        onContextMenu={(e) => openCtxMenu(e, s)}
        onMouseDown={detailsPreview.close}
        onMouseEnter={event => {
          setHoveredSessionId(s.id);
          detailsAnchorRef.current = { id: s.id, anchor: event.currentTarget };
          if (!renaming && !event.buttons) detailsPreview.onTriggerEnter({ id: s.id, anchor: event.currentTarget });
        }}
        onMouseLeave={event => {
          setHoveredSessionId(null);
          // 列表按 lastUsedAt 排序，其它会话更新会让当前行在 DOM 里移动，Chromium 对移动
          // 节点会派发假 mouseleave（原生 relatedTarget 为 null 且指针仍悬在行上）——忽略之，
          // 否则悬浮中的会话一被更新就把详情卡刷掉。注意必须读 nativeEvent：React 会把原生
          // null 的 relatedTarget 归一化成 Window（合成值恒 truthy，不可判）。
          const from = (event.nativeEvent as MouseEvent).relatedTarget;
          if (!from && event.currentTarget.matches(':hover')) return;
          detailsPreview.onTriggerLeave();
        }}
        onFocus={event => {
          if (event.target === event.currentTarget) detailsAnchorRef.current = { id: s.id, anchor: event.currentTarget };
          if (!renaming && event.target === event.currentTarget) detailsPreview.onTriggerEnter({ id: s.id, anchor: event.currentTarget });
        }}
        onBlur={event => {
          if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.session-details-card')) detailsPreview.onSurfaceEnter();
          else if (!event.currentTarget.contains(event.relatedTarget as Node | null)) detailsPreview.onTriggerLeave();
        }}
      >
        {level > 0 ? (
          <span
            className="session-tree-indent"
            style={{ width: `${level * 12}px` }}
            aria-hidden
          />
        ) : null}
        <SessionRowContent name={s.name} status={st} statusLabel={stateLabel} capsule={capsuleLabel}
          capsuleClassName={`${capsuleKindClass(capsuleKind)}${grayed ? ' dim' : ''}`}
          harness={harness} grayed={grayed} dimState={dimState} editing={renaming}
          treeControl={hasChildren ? (<button
              type="button"
              className={`session-tree-twisty${treeCollapsed ? '' : ' is-open'}`}
              tabIndex={-1}
              aria-hidden
              title={t('折叠/展开子代理')}
              onClick={event => {
                // 折叠不切选中：点 twisty 只是收放子树，不换主选中
                event.stopPropagation();
                toggleAgentTree(s.id);
              }}
              onMouseDown={event => event.stopPropagation()}
            >
              {/* 与工作会话分组折叠同一个箭头（IconChevronDown 14px），
                  收起时朝右、展开时朝下——全应用同一套折叠语义 */}
              <IconChevronDown size={14} />
            </button>) : null}
          trailing={<>
            {worktreeLabel && <button className="session-worktree-status" type="button"
              onClick={event => { event.stopPropagation(); showWorktree(s.id); }}>
              {worktreeLabel}
            </button>}
            <SessionRowTools ts={s.lastUsedAt ?? s.createdAt} archived={s.archived} onArchive={() => archiveFromRail(s, !s.archived)}
              onDelete={() => requestDelete([s.id])} />
          </>}>
        {renaming ? (
          <input
            ref={editInputRef}
            className="session-rename-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              } else if (
                e.key === 'ArrowUp' ||
                e.key === 'ArrowDown' ||
                e.key === 'Home' ||
                e.key === 'End'
              ) {
                e.stopPropagation();
              }
            }}
          />
        ) : (
          <span className="session-name">
            <span className="session-name-text">{s.name}</span>
            {s.worktreePath && s.worktreeBranch ? (
              <span
                className="session-wt-mark"
                title={t('worktree 隔离 · {{branch}}{{group}}', {
                  branch: s.worktreeBranch,
                  group: s.worktreeRepoSet?.length
                    ? t(' · 多仓组 {{n}} 仓', { n: s.worktreeRepoSet.length + 1 })
                    : ''
                })}
                aria-label={t('worktree 隔离')}
              >
                <IconBranch size={11} />
                {s.worktreeRepoSet?.length ? (
                  <span className="session-wt-group">
                    {t('{{n}}仓', { n: s.worktreeRepoSet.length + 1 })}
                  </span>
                ) : null}
              </span>
            ) : null}
            {s.pinned ? (
              <span className="session-pin-mark" aria-label={t('已置顶')}>
                <SessionPinIcon />
              </span>
            ) : null}

          </span>
        )}
        </SessionRowContent>
      </div>
    );
  };

  const navigation = useWorkbenchNavigation(activeWorkspaceId ?? '');
  const [navigationUndo, setNavigationUndo] = useState<Array<typeof navigation.nodes>>([]);
  useEffect(() => { setNavigationUndo([]); }, [activeWorkspaceId]);
  const [navigationError, setNavigationError] = useState('');
  useEffect(() => { const listener = (event: Event): void => setNavigationError(String((event as CustomEvent).detail)); window.addEventListener('workbench:error', listener); return () => window.removeEventListener('workbench:error', listener); }, []);
  const persistNavigation = (change: Parameters<typeof saveNavigation>[1]): void => {
    void saveNavigation(activeWorkspaceId ?? '', change).then(() => setNavigationError('')).catch(error => setNavigationError(String(error)));
  };

  return (
    <aside className="left-panel">
      {/* 实用工具固定在顶部，不随下方工作会话/终端列表滚动（2026-10-10 用户定稿） */}
      <UtilityNavigationSection paused={transitioning} collapsed={utilityCollapsed} onToggleCollapsed={() => setUtilityCollapsed(v => !v)}
        nodes={navigation.nodes} advanced allowScope={false} selectedId={focusedNavigationId} openedIds={openedNavigationIds}
        onUndo={navigationUndo.length ? () => { const nodes = navigationUndo.at(-1)!; setNavigationUndo(navigationUndo.slice(0, -1)); persistNavigation({ nodes }); } : undefined}
        libraryExpanded={navigation.libraryExpanded} onLibraryExpandedChange={libraryExpanded => persistNavigation({ libraryExpanded })}
        onChange={(nodes, announcement) => { if (announcement) setNavigationUndo(list => [...list.slice(-19), navigation.nodes]); persistNavigation({ nodes }); }} onSelect={id => id ? selectUtility(`nav:${id}`) : onCloseUtilityPanel()}
        builtinTiles={UTILITY_ITEMS.map(item => <UtilityFeatureButton key={item.id} item={item}
          active={paneFocused({ kind: 'utility', sel: item.id })} opened={paneOpened({ kind: 'utility', sel: item.id })}
          onToggle={() => toggleUtility(item.id)} onMenu={point => setUtilityMenu({ id: item.id, ...point })} />)}
        rightPin={rightPin} onToggleRightPin={toggleRightPin} />
      {utilityMenu && (
        <ContextMenu x={utilityMenu.x} y={utilityMenu.y} anchor={utilityMenu.anchor} onClose={() => setUtilityMenu(null)}
          items={[rightPinMenuItem(t, rightPin.isPinned({ kind: 'utility', sel: utilityMenu.id })), splitMenuItems(t)]}
          onSelect={(id) => {
            const ref: SplitPaneRef = { kind: 'utility', sel: utilityMenu.id };
            if (id === RIGHT_PIN_MENU_ID) toggleRightPin(ref);
            else if (id.startsWith('split-')) centerSplitIncoming(ref, id.slice(6) as SplitSide);
          }} />
      )}
      {navigationError && <ErrorTip message={navigationError} />}

      {/* Both session groups scroll together; the workspace slot stays outside. */}
      <div className="left-panel-scroll" ref={sessionScrollRef}>
      <div className="panel-header sub">
          {agentSearchOpen ? (
            <SearchBar
              ref={agentSearchRef}
              placeholder={t('搜索工作会话…')}
              aria-label={t('搜索工作会话')}
              value={agentSearchQuery}
              onChange={setAgentSearchQuery}
              matchCount={agentFilterQ ? agents.length : undefined}
              matchTotal={agentFilterQ ? agentsAll.length : undefined}
              onEscape={() => setAgentSearchOpen(false)}
              onBlur={() => {
                if (!agentSearchQuery.trim()) setAgentSearchOpen(false);
              }}
            />
          ) : (
            <>
              <div className="panel-header-label">
                <span>{showArchivedAgents ? t('已归档') : t('工作会话')}</span>
                <button type="button" className="panel-header-toggle"
                  aria-expanded={!agentsCollapsed}
                  aria-label={agentsCollapsed ? t('展开工作会话') : t('折叠工作会话')}
                  title={agentsCollapsed ? t('展开工作会话') : t('折叠工作会话')}
                  onClick={() => setAgentsCollapsed(v => !v)}>
                  <IconChevronDown size={14} className="panel-header-chevron" />
                </button>
              </div>
              <div className={`session-header-actions${showArchivedAgents ? ' is-archive-view' : ''}`}>
                <SessionArchiveToggle
                  count={archivedAgentCount}
                  show={showArchivedAgents}
                  showWhenEmpty
                  hideTitle={t('返回工作会话')}
                  showTitle={t('显示已归档的工作会话（{{n}}）', { n: archivedAgentCount })}
                  onToggle={() => {
                    if (!showArchivedAgents) setAgentsCollapsed(false);
                    setShowArchivedAgents(!showArchivedAgents);
                    setAgentSearchQuery('');
                    setRetainedWorktreesOnly(false);
                    setBulkDeleteSelection(null);
                  }}
                />
                <button
                  type="button"
                  className="git-btn ghost tiny"
                  aria-label={t('搜索工作会话')}
                  onClick={() => setAgentSearchOpen(true)}
                >
                  ⌕
                </button>
                {/* P4 task-first：＋ 弹新建任务对话框（runtime 选择并入对话框；Shell ＋ 菜单不动） */}
                {!showArchivedAgents && <button
                  type="button"
                  className="git-btn ghost tiny"
                  aria-label={t('新建任务')}
                  data-setup-target={guideNewSession && !newTaskOpen ? 'session' : undefined}
                  title={
                    newTaskChord
                      ? t('新建任务（先填任务再拉起会话）（{{chord}}）', { chord: newTaskChord })
                      : t('新建任务（先填任务再拉起会话）')
                  }
                  onClick={() => { setExtensionDraft(undefined); setNewTaskOpen(true); }}
                >
                  ＋
                </button>}
              </div>
            </>
          )}
        </div>
        {showArchivedAgents && archivedAgentCount > 0 && !agentsCollapsed && <div className="archived-session-actions">
          <button type="button" className="git-btn ghost tiny" aria-pressed={retainedWorktreesOnly}
            onClick={() => setRetainedWorktreesOnly(value => !value)}>{t('有保留项')}</button>
          <button type="button" className="git-btn ghost tiny" disabled={!agents.some(row => row.archived)}
            onClick={() => setBulkDeleteSelection(new Set())}>{t('批量删除')}</button>
        </div>}
        <div className={`left-section-scroll${agentsCollapsed ? ' is-collapsed' : ''}`}>
          <SessionListView
            flatAgents={agents}
            treeRows={agentTreeRows}
            childCount={agentChildCount}
            treeCollapsedIds={collapsedAgentTrees}
            matchedCount={agents.length}
            totalAll={agentsAll.length}
            emptyText={showArchivedAgents
              ? archivedAgentCount > 0 && retainedWorktreesOnly ? t('没有保留 worktree 的归档会话') : t('暂无归档会话')
              : undefined}
            renderItem={renderItem}
            getItemProps={getAgentItemProps}
            onKeyDown={onAgentListKeyDown}
            collapsed={agentsCollapsed}
            activeKey={focusedSessionId ?? displayActiveId}
            transitioning={transitioning}
          />
        </div>

        <div className="panel-header sub">
          {shellSearchOpen ? (
            <SearchBar
              ref={shellSearchRef}
              placeholder={t('搜索终端…')}
              aria-label={t('搜索终端')}
              value={shellSearchQuery}
              onChange={setShellSearchQuery}
              matchCount={shellFilterQ ? shells.length : undefined}
              matchTotal={shellFilterQ ? shellsAll.length : undefined}
              onEscape={() => setShellSearchOpen(false)}
              onBlur={() => {
                if (!shellSearchQuery.trim()) setShellSearchOpen(false);
              }}
            />
          ) : (
            <>
              <div className="panel-header-label">
                <span>{t('终端')}</span>
                <button type="button" className="panel-header-toggle"
                  aria-expanded={!shellsCollapsed}
                  aria-label={shellsCollapsed ? t('展开终端') : t('折叠终端')}
                  title={shellsCollapsed ? t('展开终端') : t('折叠终端')}
                  onClick={() => setShellsCollapsed(v => !v)}>
                  <IconChevronDown size={14} className="panel-header-chevron" />
                </button>
              </div>
              <div className="session-header-actions">
                <SessionArchiveToggle
                  count={archivedShellCount}
                  show={showArchivedShells}
                  hideTitle={t('隐藏已归档的终端')}
                  showTitle={t('显示已归档的终端（{{n}}）', { n: archivedShellCount })}
                  onToggle={() => setShowArchivedShells((v) => !v)}
                />
                <button
                  type="button"
                  className="git-btn ghost tiny"
                  aria-label={t('搜索终端')}
                  onClick={() => setShellSearchOpen(true)}
                >
                  ⌕
                </button>
                <div
                  className={`runtime-menu-wrap${openCreateMenu === 'shell' ? ' is-open' : ''}`}
                  ref={shellMenuRef}
                >
                  <button
                    type="button"
                    className="git-btn ghost tiny"
                    aria-label={t('新建终端')}
                    aria-haspopup="menu"
                    aria-expanded={openCreateMenu === 'shell'}
                    onClick={() => {
                      ensureShellProfiles();
                      setOpenCreateMenu((v) => (v === 'shell' ? null : 'shell'));
                    }}
                  >
                    ＋
                  </button>
                  <div className="runtime-menu" role="menu">
                    <div className="runtime-menu-inner ui-menu">
                      {shellProfiles === null || shellMenuBusy ? (
                        <div className="empty-hint">{t('探测中…')}</div>
                      ) : shellProfiles.length === 0 ? (
                        <div className="empty-hint">{t('未找到可用终端')}</div>
                      ) : (
                        shellProfiles.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className="runtime-menu-item ui-menu-item"
                            role="menuitem"
                            onClick={() => createShell(p.id)}
                          >
                            {p.label}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        <div className={`left-section-scroll${shellsCollapsed ? ' is-collapsed' : ''}`}>
          <CollapsibleRailStack collapsed={shellsCollapsed} activeKey={focusedSessionId ?? displayActiveId} paused={transitioning}
            className="session-list ui-list"
            tabIndex={0}
            onKeyDown={onShellListKeyDown}
          >
          {shellsAll.length === 0 ? (
            <div className="session-empty">{t('当前空，点击+新建')}</div>
          ) : shells.length === 0 ? (
            <div className="empty-hint">{t('无匹配的终端')}</div>
          ) : (
            shells.map((s) => renderItem(s, getShellItemProps))
          )}
          </CollapsibleRailStack>
        </div>

      </div>

      <NewTaskDialog
        key={extensionDraft ? extensionDraftRevision : 'ordinary'}
        extensionSource={extensionDraft?.source}
        extensionSkillNames={extensionDraft?.source.skillNames}
        initialName={extensionDraft?.title}
        initialTask={extensionDraft?.draft}
        initialSource={extensionDraft ? { rootId: extensionDraft.source.rootId, path: extensionDraft.projectPath } : undefined}
        open={newTaskOpen}
        runtimes={runtimes}
        workspace={workspace}
        onClose={closeNewTask}
        onSessionCreated={onSessionCreated}
        onOpenWorkerSettings={onOpenSettings ? () => {
          closeNewTask();
          onOpenSettings('worker');
        } : undefined}
        onDelegate={async ({ task, attachments, submissionId, runtime, isolate, isolationGroups, name, advanced, source }) => {
          return window.api.sessions.delegate({
            task, submissionId, ...(attachments?.length ? { attachments } : {}),
            runtime,
            isolate,
              ...(isolationGroups ? { isolationGroups } : {}),
            name: name || undefined,
            ...source,
            ...advanced
          });
        }}
          onBlankSession={(runtime, name, advanced, source, isolation) => createTerminal(runtime, name || undefined, advanced, source, isolation)}
      />

      {/* 工作区栈槽位：AgentFloat portal 进来（胶囊/新建/通知气泡）。在滚动区之外，
          恒贴卡片底部 */}
      <div className="left-ws-slot" ref={wsSlotRef} />
      <SessionDetailsCard target={detailsPreview.data} session={previewSession}
        workspace={workspaces.find(w => w.id === previewSession?.workspaceId)}
        runtime={runtimeLabel(runtimes, previewSession?.runtime)}
        stateLabel={previewSession ? sessionStateLabel(previewSession, t) : ''} onClose={detailsPreview.close}
        onSurfaceEnter={detailsPreview.onSurfaceEnter} onSurfaceLeave={detailsPreview.onSurfaceLeave} />
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          anchor={ctxMenu.anchor}
          hold="fixed"
          items={[
            ...(sessionDisplayStatus(ctxMenu.session) === 'working' && !ctxMenu.archived
              ? [{ id: 'interrupt', label: t('中断'), title: t('中断：向终端发送 Ctrl+C（无响应再右键重启）') }] : []),
            // 分屏显示（终端会话）：拖拽/菜单/快捷键三入口之一
            ...(isCenterSplitSession(ctxMenu.session)
              ? [splitMenuItems(t), rightPinMenuItem(t, rightPin.isPinned({ kind: 'session', sessionId: ctxMenu.sessionId }))]
              : []),
            { id: 'rename', label: t('重命名') },
            ...(isAgentSession(ctxMenu.session) && readSessions.has(ctxMenu.sessionId)
              ? [{ id: 'mark-unread', label: t('标记未读') }] : []),
            { id: 'pin', label: ctxMenu.pinned ? t('取消置顶') : t('置顶') },
            // 标记完成 / 取消完成标记（仅未归档的 agent 会话；model 已判 done 的无需再标）
            ...(!ctxMenu.archived &&
            ctxMenu.session.type === 'terminal' &&
            ctxMenu.session.launchKind !== 'shell'
              ? ctxMenu.session.phase?.value === 'done'
                ? ctxMenu.session.phase.source === 'user'
                  ? [{ id: 'mark-done', label: t('取消完成标记') }]
                  : []
                : [{ id: 'mark-done', label: t('标记完成') }]
              : []),
            { id: 'archive', label: ctxMenu.archived ? t('取消归档') : t('归档') },
            { id: 'evidence', label: t('查看证据') },
            ...sessionRestartActions(ctxMenu.session, runtimes, t),
            ...(ctxMenu.session.interruptSnapshot
              ? [{ id: 'resume-interrupted', label: t('带上下文续作') }]
              : []),
            ...(ctxMenu.orphanWorktree
              ? [
                  {
                    id: 'discard-worktree',
                    label:
                      ctxMenu.orphanWorktreeReason === 'unmerged'
                        ? t('清理 worktree（未合入分支将保留）')
                        : ctxMenu.orphanWorktreeReason === 'dirty'
                          ? t('放弃 worktree 改动并清理')
                          : t('强制清理 worktree'),
                    danger: true
                  }
                ]
              : []),
            // 删除只对已归档会话开放（后端 sessions.close 同样校验）
            ...(ctxMenu.archived ? [{ id: 'delete', label: t('永久删除'), danger: true }] : [])
          ]}
          onClose={closeCtxMenu}
          onSelect={(id) => {
            if (id === 'mark-unread') {
              markNeedsUnread([ctxMenu.sessionId]);
            } else if (id === 'interrupt') {
              window.api.pty.input(ctxMenu.sessionId, '\x03');
              window.api.sessions.touchUsed(ctxMenu.sessionId);
            } else if (id.startsWith('split-')) {
              const side = id.slice(6) as SplitSide;
              centerSplitIncoming({ kind: 'session', sessionId: ctxMenu.sessionId }, side);
            } else if (id === RIGHT_PIN_MENU_ID) {
              toggleRightPin({ kind: 'session', sessionId: ctxMenu.sessionId });
            } else if (id === 'rename') {
              const s = visibleSessions.find((x) => x.id === ctxMenu.sessionId);
              if (s) startRename(s.id, s.name);
            } else if (id === 'pin') {
              togglePin(ctxMenu.sessionId, !ctxMenu.pinned);
            } else if (id === 'mark-done') {
              const s = ctxMenu.session;
              const cancel = s.phase?.value === 'done' && s.phase.source === 'user';
              void window.api.sessions.setPhase(s.id, { value: cancel ? 'idle' : 'done' }).catch(reportError);
            } else if (id === 'archive') {
              archiveFromRail(ctxMenu.session, !ctxMenu.archived);
            } else if (id === 'evidence') {
              openEvidenceView({ sessionId: ctxMenu.sessionId, sessionName: ctxMenu.session.name });
            } else if (id === 'respawn' || id === 'new-conversation') {
              void runSessionRestart(ctxMenu.sessionId, id).catch(reportError);
            } else if (id === 'resume-interrupted') {
              void window.api.sessions.resumeInterrupted(ctxMenu.sessionId).catch(reportError);
            } else if (id === 'discard-worktree') {
              setDiscardWorktreeConfirm({
                sessionId: ctxMenu.sessionId,
                path: ctxMenu.orphanWorktree!,
                reason: ctxMenu.orphanWorktreeReason,
                branch: ctxMenu.orphanWorktreeBranch
              });
            } else if (id === 'delete') {
              requestDelete([ctxMenu.sessionId]);
            }
          }}
        />
      )}
      <AppConfirmDialog
        open={!!discardWorktreeConfirm}
        title={t('清理遗留 worktree')}
        detail={
          discardWorktreeConfirm?.reason === 'unmerged'
            ? t(
                'worktree 本身没有未提交改动，但分支 {{branch}} 有未合入提交。\n将删除目录：{{path}}\n分支保留，回主仓 git merge {{branch}} 可取回工作。此操作不可撤销。',
                {
                  branch: discardWorktreeConfirm.branch ?? '',
                  path: discardWorktreeConfirm.path
                }
              )
            : t('将强制删除会话的隔离 worktree{{suffix}}：\n{{path}}\n{{branchNote}}此操作不可撤销。', {
                suffix:
                  discardWorktreeConfirm?.reason === 'dirty' ? t('（含未提交改动）') : '',
                path: discardWorktreeConfirm?.path ?? '',
                branchNote: discardWorktreeConfirm?.branch
                  ? t('分支 {{branch}} 若已合入将一并删除，未合入则保留。\n', {
                      branch: discardWorktreeConfirm.branch
                    })
                  : ''
              })
        }
        confirmLabel={t('放弃并清理')}
        danger
        onCancel={() => setDiscardWorktreeConfirm(null)}
        onConfirm={() => {
          if (!discardWorktreeConfirm) return;
          const { sessionId } = discardWorktreeConfirm;
          setDiscardWorktreeConfirm(null);
          closeCtxMenu();
          void window.api.sessions.discardWorktree(sessionId).then(result => {
            if (!result.ok) reportCleanupError(new Error(result.message || t('清理 worktree 失败')), sessionId);
            else if (result.message) reportError(new Error(result.message));
          }).catch(error => reportCleanupError(error, sessionId));
        }}
      />
      <WorktreeCleanupErrorDialog failure={cleanupError} onClose={() => setCleanupError(null)} onFailure={reportCleanupError} onRetryDelete={id => requestDelete([id])} />
      {archiveFlowNode}
      {deleteFlowNode}
      {worktreeFlowNode}
      <AppConfirmDialog open={showArchivedAgents && archivedAgentCount > 0 && bulkDeleteSelection !== null} title={t('选择要删除的归档会话')} confirmLabel={t('预览删除范围')}
        confirmDisabled={!bulkDeleteSelection?.size} onCancel={() => setBulkDeleteSelection(null)}
        content={bulkDeleteSelection && <div className="archived-session-delete-selection">
          {agents.filter(row => row.archived).map(row => <label key={row.id}>
            <input type="checkbox" checked={bulkDeleteSelection.has(row.id)} onChange={event => {
              const next = new Set(bulkDeleteSelection);
              if (event.target.checked) next.add(row.id); else next.delete(row.id);
              setBulkDeleteSelection(next);
            }} /> {row.name}
          </label>)}
        </div>}
        onConfirm={() => {
          const ids = new Set(agents.filter(row => row.archived && bulkDeleteSelection?.has(row.id)).map(row => row.id));
          for (const id of [...ids]) {
            for (const row of sessionSubtreePostOrder(visibleSessions, id)) if (row.id !== id) ids.delete(row.id);
          }
          setBulkDeleteSelection(null);
          requestDelete([...ids]);
        }} />
    </aside>
  );
}

export const LeftPanel = React.memo(LeftPanelInner);
