import { ErrorTip } from '../components/ErrorTip';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WorktreeCleanupErrorDialog, worktreeCleanupFailure, type WorktreeCleanupFailure } from '../components/WorktreeCleanupErrorDialog';
import { useTranslation } from 'react-i18next';
import { useSessionStore, useRuntimesStore, useUiStore, useWorkspaceStore } from '../store';
import { useWorkspaceTransitSwitch } from '../workspaceTransit';
import type { SessionMeta } from '../../../shared/types';
import {
  boardStatusOfSession,
  isGlobalBoardSession,
  boardZoneOf,
  sessionBoardColumn,
  sessionDisplayStatus,
  type BoardStatus
} from '../../../shared/boardStatus';
import { BOARD_ZONE_PRESENTATION } from './boardPresentation';
import { BoardCard } from './BoardCard';
import { BoardColumnScroll } from './BoardColumnScroll';
import { IconChevronDown, IconFilter, IconFolder, IconFolderOpen, IconPlus } from '../components/icons';
import { MOTION, usePresence } from '../components/motion';
import { boardNeedsReason, canReviewSession, gatedFromNeedsYouColumn, reviewFactsOf } from '../../../shared/boardReview';
import {
  dimensionGateBadgeLabel,
  dimensionGateDetailText,
  isDimensionGateRedSession
} from '../../../shared/dimensionGates';
import { BoardReviewDialog } from '../components/BoardReviewDialog';
import { FreeCanvas, type FreeCanvasHandle, type FreeCanvasItem } from './FreeCanvas';
import {
  getFreeViewLayout,
  setBoardFilterPanelIds,
  setBoardFilterWorkspaceIds,
  setFreeViewMode,
  useFreeViewOptions
} from './freeViewStore';
import { BOARD_FILTER_PANEL_ORDER, type BoardFilterPanel } from './freeViewGeom';
import { markNeedsUnread, useNeedsRead } from './needsReadStore';
import { jumpToSession } from '../sessionJump';
import { ContextMenu } from '../components/ContextMenu';
import { runSessionRestart, sessionRestartActions } from '../sessionRestartActions';
import { NewTaskDialog } from '../components/NewTaskDialog';
import { rememberQueuedHandover, useQueuedHandoverPlacement } from './freeCanvas/useQueuedHandoverPlacement';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
import { AppLogo } from '../components/AppLogo';
import { useArchiveFlow } from '../components/sessionArchiveFlow';
import { useSessionDeleteFlow } from '../components/sessionDeleteFlow';
import { archivedWorktreeLabel, useSessionWorktreeFlow } from '../components/sessionWorktreeFlow';
import { useHoverPinMenu } from '../hooks/useHoverPinMenu';
import { openEvidenceView } from './evidenceViewStore';
import { useChordLabel } from '../keybindings/KeybindingHost';
import { forkSupportOf } from '../../../shared/forkCapability';
import { runtimeSurface } from '../../../shared/types';
import type { FreePoint } from './freeViewGeom';
import { useBoardClock } from './boardClock';
import { StatusTicker } from './BoardStatusTicker';
import { sessionHarness } from '../sessionHarness';
import type { BoardTodo } from '../../../shared/boardTodo';
import { useBoardTodos } from './useBoardTodos';
import { BoardTodoCard } from './BoardTodoCard';
import { BoardFilterMenu, type BoardFilterOption } from './BoardFilterMenu';

interface CtxMenuState {
  sessionId: string;
  x: number;
  y: number;
  /** 右键时的会话快照：标记完成 / 归档分流需要 phase / worktree 等事实 */
  session: SessionMeta;
  archived: boolean;
  orphanWorktree?: string;
  /** 遗留原因：dirty=有未提交改动 / unmerged=分支有未合入提交 / locked=删除失败 */
  orphanWorktreeReason?: string;
  orphanWorktreeBranch?: string;
}

/** 右键 / 「⋯」共用：指定坐标（右键=光标处；⋯=按钮右下角）构造菜单快照 */
function snapshotCtxMenu(s: SessionMeta, x: number, y: number): CtxMenuState {
  const reason = s.worktreePath && s.meta?.orphanWorktree ? s.meta.orphanWorktree : undefined;
  return {
    sessionId: s.id,
    x,
    y,
    session: s,
    archived: !!s.archived,
    orphanWorktree: reason ? s.worktreePath : undefined,
    // 旧数据只有 '1' 标记，一律按 dirty 处理
    orphanWorktreeReason: reason === '1' ? 'dirty' : reason,
    orphanWorktreeBranch: s.worktreeBranch
  };
}

interface CardItem {
  s: SessionMeta;
  status: BoardStatus;
}

/** 看板列骨架：定义在模块级——渲染体内定义会让每次重渲整板 remount（丢状态/重挂卡片） */
function Column({
  zone,
  count,
  unreadCount,
  onToggle,
  children
}: {
  zone: 'todo' | 'working' | 'needsYou' | 'done' | 'archived';
  count: number;
  unreadCount?: number;
  onToggle?: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const visual = zone === 'todo' ? { get label() { return t('代办'); }, headClass: 'board-head-todo' } : BOARD_ZONE_PRESENTATION[zone];
  const head = (
    <>
      <span className={`board-head-dot ${visual.headClass}`} />
      <span className="board-column-title">{visual.label}</span>
      <span className="board-column-count">{count}</span>
      {unreadCount && unreadCount > 0 ? (
        <span className="board-column-unread">{t('{{n}} 未读', { n: unreadCount })}</span>
      ) : null}
      {onToggle ? (
        <span className="board-column-chevron" aria-hidden>
          ▾
        </span>
      ) : null}
    </>
  );
  return (
    <section className="board-column" data-zone={zone}>
      <header className="board-column-head">
        {onToggle ? (
          <button
            type="button"
            className="board-column-toggle"
            aria-expanded
            onClick={onToggle}
          >
            {head}
          </button>
        ) : (
          head
        )}
      </header>
      <BoardColumnScroll label={t('滚动{{name}}列表', { name: visual.label })}>{children}</BoardColumnScroll>
    </section>
  );
}

type BoardZone = 'working' | 'needsYou' | 'done' | 'archived';

function boardFilterPanelOf(session: SessionMeta, now: number): BoardFilterPanel {
  if (sessionBoardColumn(session, now) === 'archived') return 'archived';
  const status = sessionDisplayStatus(session, now);
  if (gatedFromNeedsYouColumn(session, now)) return 'working';
  const zone = boardZoneOf(status);
  return zone === 'needsYou' ? 'needsYou' : zone === 'done' ? 'done' : 'working';
}

/** 分组的开合状态由看板持有，切换过滤或列变化时不丢失。 */
function WorkspaceGroup({ name, count, expanded, onToggle, children }: {
  name: string; count: number; expanded: boolean; onToggle: () => void; children: React.ReactNode;
}): React.JSX.Element {
  const id = React.useId();
  const presence = usePresence(expanded, MOTION.exitMs);
  return <section className="board-workspace-group">
    <button type="button" className="board-workspace-heading" aria-label={`${name} · ${count}`} aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
      {expanded ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}
      <span className="board-workspace-name" title={name}>{name}</span>
      <span className="board-workspace-count">{count}</span>
      <span className="board-workspace-chevron" aria-hidden><IconChevronDown size={13} /></span>
    </button>
    <div id={id} className={`acc board-workspace-body${expanded && presence.stage === 'in' ? ' is-open' : ''}`}
      {...presence.spread} aria-hidden={!expanded} ref={el => { el?.toggleAttribute('inert', !expanded); }}>
      <div className="acc-body">{presence.mounted ? <div className="board-workspace-cards">{children}</div> : null}</div>
    </div>
  </section>;
}

export interface BoardPanelProps {
  onClose?: () => void;
  onOpenWorkerSettings?: () => void;
  active?: boolean;
}

/**
 * 全局看板主体：四区由 deriveBoardStatus 读时推导——
 * 卡片不可拖拽，事实变了自己跳列。点击卡片选中会话并聚焦中央终端
 * （sessions.select → sessions:reveal 自动收回本面板）。
 * 数据源走现有 useSessionStore（IPC 全量 broadcast），卡片 memo + 分桶 useMemo 扛刷新。
 * 卡片按工作区分组；点跨工作区卡片先切工作区再选中。
 * 看板过滤菜单按工作区和面板多选；过滤只改渲染，不改自由画布 nodes 位置。
 */
export function BoardPanel({ onClose, onOpenWorkerSettings }: BoardPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const { sessions, activeId } = useSessionStore();
  const { todos, error: todoError, loaded: todosLoaded } = useBoardTodos();
  const { runtimes } = useRuntimesStore();
  const { workspaces, activeWorkspaceId, switchWorkspace: switchDirect } = useWorkspaceStore();
  const switchWorkspace = useWorkspaceTransitSwitch(switchDirect);
  const { flashTip } = useUiStore();
  const freeLayout = useFreeViewOptions();
  const needsRead = useNeedsRead();
  const isFreeView = freeLayout.view === 'free';
  const freeCanvasRef = useRef<FreeCanvasHandle>(null);
  useQueuedHandoverPlacement(sessions, freeCanvasRef, isFreeView);
  const workspaceFilterIds = freeLayout.filterWorkspaceIds ??
    (freeLayout.filterActiveWorkspace && activeWorkspaceId ? [activeWorkspaceId] : null);
  const panelFilterIds = freeLayout.filterPanelIds;
  const workspaceMatches = (workspaceId?: string): boolean =>
    workspaceFilterIds === null || workspaceFilterIds.includes(workspaceId ?? '');
  const panelMatches = (panel: BoardFilterPanel): boolean =>
    panelFilterIds === null || panelFilterIds.includes(panel);
  const filterOn = workspaceFilterIds !== null;
  const globalBoardChord = useChordLabel('globalBoard.toggle');
  const scopedSessions = useMemo(() => {
    return sessions.filter(s => isGlobalBoardSession(s) && workspaceMatches(s.workspaceId));
  }, [sessions, workspaceFilterIds]);
  const scopedTodos = useMemo(() => todos.filter(todo => workspaceMatches(todo.workspaceId)), [todos, workspaceFilterIds]);
  const sessionsByWs = useMemo(() => {
    const grouped = new Map<string | undefined, SessionMeta[]>();
    for (const s of scopedSessions) {
      const group = grouped.get(s.workspaceId) ?? [];
      group.push(s); grouped.set(s.workspaceId, group);
    }
    return grouped;
  }, [scopedSessions]);
  // 相对时间刷新节拍（broadcast 之外的低频兜底）
  const tick = useBoardClock();
  /** 会话卡片及自由画布共用右键菜单。 */
  const sessionMenu = useHoverPinMenu<CtxMenuState>((a, b) => a.sessionId === b.sessionId);
  const ctxMenu = sessionMenu.data ?? null;
  const closeCtxMenu = sessionMenu.close;
  const reportError = useCallback((err: unknown): void => {
    flashTip(err instanceof Error ? err.message : String(err));
  }, [flashTip]);
  const [taskOpen, setTaskOpen] = useState(false);
  const taskOpenRef = useRef(false);
  taskOpenRef.current = taskOpen;
  const [taskSeed, setTaskSeed] = useState<{
    world?: FreePoint;
    initialTask?: string;
    stickyId?: string;
    todo?: BoardTodo;
    handover?: { draft: import('../../../shared/canvasHandover').CanvasHandoverDraft; fromPort: import('./freeViewGeom').FreePort };
  }>({});
  const handoverDraftRef = useRef<string>();
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;
  const closeTask = useCallback(() => {
    taskOpenRef.current = false;
    setTaskOpen(false);
    const draft = handoverDraftRef.current;
    handoverDraftRef.current = undefined;
    if (draft) void window.api.sessions.canvasHandoverCancel(draft).catch(error => reportErrorRef.current(error));
  }, []);
  useEffect(() => () => {
    const draft = handoverDraftRef.current;
    if (draft) void window.api.sessions.canvasHandoverCancel(draft).catch(error => reportErrorRef.current(error));
  }, []);
  const [discardConfirm, setDiscardConfirm] = useState<{
    sessionId: string;
    path: string;
    reason?: string;
    branch?: string;
  } | null>(null);
  const [cleanupError, setCleanupError] = useState<WorktreeCleanupFailure | null>(null);
  const reportCleanupError = useCallback((err: unknown, sessionId?: string, intent?: 'delete'): void => {
    setCleanupError(worktreeCleanupFailure(err, scopedSessions.find(session => session.id === sessionId), intent));
  }, [scopedSessions]);
  const { requestDelete, deleteFlowNode } = useSessionDeleteFlow(reportCleanupError);
  const { showWorktree, worktreeFlowNode } = useSessionWorktreeFlow(scopedSessions, reportCleanupError);
  const [rejectTarget, setRejectTarget] = useState<SessionMeta | null>(null);
  /** R-14：打回默认意见（红灯时预填维度门详情，随打回注入 Worker） */
  const [rejectDefaultNote, setRejectDefaultNote] = useState<string | undefined>();
  /** R-14：红灯会话「强制验收（跳过维度门）」确认框目标 */
  const [forceAccept, setForceAccept] = useState<SessionMeta | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<SessionMeta | null>(null);


  const runtimeLabelOf = useCallback(
    (id?: string): string => (id && runtimes.find((r) => r.id === id)?.label) || id || 'Agent',
    [runtimes]
  );

  const buckets = useMemo(() => {
    void tick;
    const now = Date.now();
    const idle: CardItem[] = [];
    const quiet: CardItem[] = [];
    const working: CardItem[] = [];
    const needsYou: CardItem[] = [];
    const done: CardItem[] = [];
    const exited: CardItem[] = [];
    for (const s of scopedSessions) {
      if (s.type !== 'terminal' || s.launchKind === 'shell') continue;
      const status = sessionDisplayStatus(s, now);
      const item: CardItem = { s, status };
      // 归档列只收 archived；done+exited（已合入但进程已退）走已完成列，不因 hiddenFromNeedsYou 误入归档。
      if (sessionBoardColumn(s, now) === 'archived') {
        exited.push(item);
        continue;
      }
      // R-14 维度门红灯：needs_you 被机械门挡下——不进需要你列，卡片留在工作列带红灯徽标
      if (boardZoneOf(status) === 'needsYou' && gatedFromNeedsYouColumn(s, Date.now())) {
        working.push(item);
        continue;
      }
      switch (boardZoneOf(status)) {
        case 'working':
          (status === 'working' ? working : status === 'quiet' ? quiet : idle).push(item);
          break;
        case 'needsYou':
          needsYou.push(item);
          break;
        case 'done':
          done.push(item);
          break;
        default:
          break;
      }
    }
    const byTimeDesc = (a: CardItem, b: CardItem): number =>
      (b.s.liveStatus?.ts ?? b.s.lastUsedAt ?? b.s.createdAt) -
      (a.s.liveStatus?.ts ?? a.s.lastUsedAt ?? a.s.createdAt);
    return {
      idle: idle.sort(byTimeDesc),
      quiet: quiet.sort(byTimeDesc),
      working: working.sort(byTimeDesc),
      needsYou: needsYou.sort(byTimeDesc),
      done: done.sort(byTimeDesc),
      exited: exited.sort(byTimeDesc)
    };
  }, [scopedSessions, tick]);

  const visibleBuckets = useMemo(() => ({
    working: panelMatches('working') ? buckets.working : [],
    quiet: panelMatches('working') ? buckets.quiet : [],
    idle: panelMatches('working') ? buckets.idle : [],
    needsYou: panelMatches('needsYou') ? buckets.needsYou : [],
    done: panelMatches('done') ? buckets.done : [],
    exited: panelMatches('archived') ? buckets.exited : []
  }), [buckets, panelFilterIds]);
  const visibleTotal = visibleBuckets.idle.length + visibleBuckets.quiet.length +
    visibleBuckets.working.length + visibleBuckets.needsYou.length + visibleBuckets.done.length +
    visibleBuckets.exited.length + (panelMatches('todo') ? scopedTodos.length : 0);

  const [filterOpen, setFilterOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const boardRootRef = useRef<HTMLElement>(null);

  // 左右方向键在「状态｜自由」两视图间切换。仅无修饰键的纯方向键；
  // 输入态（input/textarea/contentEditable，含终端与背后面板）忽略；
  // 焦点不在看板内（如打开看板前聚焦的文件树）也不接管，避免误伤别处的方向键导航。
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (isTyping(e.target)) return;
      const target = e.target instanceof Node ? e.target : null;
      const root = boardRootRef.current;
      const inBoard =
        target === document.body ||
        target === document.documentElement ||
        (root != null && root.contains(target));
      if (!inBoard) return;
      e.preventDefault();
      setFreeViewMode(getFreeViewLayout().view === 'free' ? 'status' : 'free');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 卡片重命名：与左栏同款内联输入（Enter 提交 / Esc 取消 / 失焦提交）
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  const commitRename = useCallback((): void => {
    const r = renamingRef.current;
    renamingRef.current = null;
    setRenaming(null);
    if (r?.name.trim()) void window.api.sessions.rename(r.id, r.name.trim()).catch(reportError);
  }, [reportError]);

  const cancelRename = useCallback((): void => { renamingRef.current = null; setRenaming(null); }, []);

  const changeRename = useCallback((value: string): void => {
    setRenaming((r) => (r ? { ...r, name: value } : r));
  }, []);

  /** 工作区名兜底：close 工作区时会话保留（id 悬空）→「已关闭工作区」；
   * 无 id 的历史会话 →「未归属」。自由视图里这两类都归入「未分区」hull。 */
  const workspaceNameOf = useCallback(
    (wsId?: string): string | undefined => {
      if (!wsId) return t('未归属');
      return workspaces.find((w) => w.id === wsId)?.name ?? t('已关闭工作区');
    },
    [workspaces, t]
  );

  const workspaceAlive = useCallback(
    (wsId?: string): boolean => !!wsId && workspaces.some((w) => w.id === wsId),
    [workspaces]
  );

  /** 自由视图节点数据：非归档的工作会话（列视图同口径、去掉归档桶），入参原始值。
   * 过滤后的列表只用于渲染；位置同步走 allFreeIds。 */
const toFreeItem = useCallback(
    (s: SessionMeta, now: number): FreeCanvasItem => {
      const harness = sessionHarness(s, runtimeLabelOf(s.runtime));
      return {
      id: s.id,
      name: s.name,
      runtimeLabel: harness?.name ?? runtimeLabelOf(s.runtime),
      harnessId: harness?.id,
      status: boardStatusOfSession(s, now),
      liveLabel: s.liveStatus?.label,
      liveKind: s.liveStatus?.kind,
      liveSummary: s.liveStatus?.summary,
      branch: s.worktreeBranch,
      branchTitle: s.worktreePath,
      workspaceName: workspaceNameOf(s.workspaceId),
      zoneId: workspaceAlive(s.workspaceId) ? s.workspaceId! : '',
      isActive: s.id === activeId,
      runtime: s.runtime,
      forkSupport: forkSupportOf(
        s.runtime,
        runtimeSurface(runtimes.find((r) => r.id === s.runtime))
      ),
      needsUnread:
        boardZoneOf(boardStatusOfSession(s, now)) === 'needsYou' &&
        !gatedFromNeedsYouColumn(s, now)
          ? !needsRead.has(s.id)
          : undefined,
      orchestrated: s.orchestrated === true,
    };
    },
    [runtimeLabelOf, workspaceNameOf, workspaceAlive, activeId, runtimes, needsRead, sessionsByWs, t]
  );
const renderCard = (item: CardItem): React.JSX.Element => {
    const needsReview =
      canReviewSession(item.s, Date.now()) &&
      !gatedFromNeedsYouColumn(item.s, Date.now());
    const reason = boardNeedsReason(item.s, Date.now());
    const facts = reason ? reviewFactsOf(item.s) : null;
    const gateRed = isDimensionGateRedSession(item.s);
    const harness = sessionHarness(item.s, runtimeLabelOf(item.s.runtime));
    return (
      <BoardCard
        key={item.s.id}
        sessionId={item.s.id}
        replyPreview={item.s.boardReplyPreview}
        workerRouting={item.s.workerRouting}
        name={item.s.name}
        runtimeLabel={harness?.name ?? runtimeLabelOf(item.s.runtime)}
        harnessId={harness?.id}
        status={item.status}
        liveLabel={item.s.liveStatus?.label}
        liveKind={item.s.liveStatus?.kind}
        liveSummary={item.s.liveStatus?.summary}
        branch={item.s.worktreeBranch}
        branchTitle={item.s.worktreePath}
        orphanWorktree={!!item.s.meta?.orphanWorktree}
        relTimeTs={item.s.lastUsedAt ?? item.s.createdAt}
        isActive={item.s.id === activeId}
        archived={item.s.archived}
        onArchive={archiveFromCard}
        onDelete={deleteFromCard}
        worktreeStatus={archivedWorktreeLabel(item.s, t)}
        onWorktree={showWorktree}
        onSelect={select}
        onContextMenu={openCtxMenuBySessionId}
        needsUnread={
          boardZoneOf(item.status) === 'needsYou'
            ? !needsRead.has(item.s.id)
            : undefined
        }
        orchestrated={item.s.orchestrated === true}
        gateRedLabel={gateRed ? dimensionGateBadgeLabel(item.s.dimensionGates) || undefined : undefined}
        gateRedDetail={gateRed ? dimensionGateDetailText(item.s.dimensionGates) || undefined : undefined}
        renaming={renaming?.id === item.s.id}
        renameValue={renaming?.id === item.s.id ? renaming.name : ''}
        renameInputRef={renaming?.id === item.s.id ? renameInputRef : undefined}
        onRenameChange={changeRename}
        onRenameCommit={commitRename}
        onRenameCancel={cancelRename}
        reviewSessionId={facts?.shortId}
        reviewItem={facts?.item}
        reviewSummary={facts?.summary || undefined}
        reviewDeferred={facts?.deferred || undefined}
        reviewable={needsReview}
      />
    );
  };
  const freeItems = useMemo<FreeCanvasItem[]>(() => {
    void tick;
    const now = Date.now();
    return scopedSessions
      .filter((s) => s.type === 'terminal' && s.launchKind !== 'shell' && !s.archived && panelMatches(boardFilterPanelOf(s, now)))
      .map((s) => toFreeItem(s, now));
  }, [scopedSessions, tick, toFreeItem, panelFilterIds]);

  const allFreeIds = useMemo(
    () =>
      sessions
        .filter((s) => isGlobalBoardSession(s) && !s.archived)
        .map((s) => s.id),
    [sessions]
  );

  /** 全部未归档工作会话的分区归属（含过滤隐藏的；'' = 未分区）——自动布局聚簇用 */
  const allFreeZones = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of sessions) {
      if (!isGlobalBoardSession(s) || s.archived) continue;
      m[s.id] = workspaceAlive(s.workspaceId) ? s.workspaceId! : '';
    }
    return m;
  }, [sessions, workspaceAlive]);

  /** 侧栏工作区顺序（自动布局的簇排布顺序；ChromeBar 即按此数组序渲染） */
  const workspaceOrder = useMemo(() => workspaces.map((w) => w.id), [workspaces]);

  const workspaceFilterOptions = useMemo<BoardFilterOption[]>(() => {
    const ids = new Set<string>(workspaces.map(workspace => workspace.id));
    for (const session of sessions) if (isGlobalBoardSession(session)) ids.add(session.workspaceId ?? '');
    for (const todo of todos) ids.add(todo.workspaceId ?? '');
    return [...ids].sort((a, b) => {
      if (a === '') return 1;
      if (b === '') return -1;
      const ai = workspaceOrder.indexOf(a);
      const bi = workspaceOrder.indexOf(b);
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) ||
        (workspaceNameOf(a) ?? '').localeCompare(workspaceNameOf(b) ?? '');
    }).map(id => ({ id, label: workspaceNameOf(id || undefined) ?? t('未归属') }));
  }, [sessions, todos, workspaces, workspaceOrder, workspaceNameOf, t]);

  const panelFilterOptions: Array<BoardFilterOption & { id: BoardFilterPanel }> = [
    { id: 'todo', label: t('代办') },
    { id: 'working', label: t('进行中') },
    { id: 'needsYou', label: t('需要你') },
    { id: 'done', label: t('已完成') },
    { id: 'archived', label: t('归档') }
  ];
  const toggleWorkspaceFilter = useCallback((id: string): void => {
    const all = workspaceFilterOptions.map(option => option.id);
    const current = workspaceFilterIds ?? all;
    const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id];
    setBoardFilterWorkspaceIds(next.length === all.length ? null : next);
  }, [workspaceFilterIds, workspaceFilterOptions]);
  const togglePanelFilter = useCallback((id: BoardFilterPanel): void => {
    const current = panelFilterIds ?? BOARD_FILTER_PANEL_ORDER;
    const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id];
    setBoardFilterPanelIds(next.length === BOARD_FILTER_PANEL_ORDER.length ? null : next);
  }, [panelFilterIds]);
  const activeFilterCount = (workspaceFilterIds === null ? 0 : 1) + (panelFilterIds === null ? 0 : 1);

  const unreadNeedsCount = useMemo(() => {
    return visibleBuckets.needsYou
      .filter((item) => !needsRead.has(item.s.id) && !item.s.reviewDeferred).length;
  }, [visibleBuckets.needsYou, needsRead]);

  // 点击卡片：选中并聚焦终端（reveal 会自动收回本面板切回工作页）。
  // 点跨工作区卡片：先切工作区再选中，否则终端不可见。
  const select = useCallback(
    (sessionId: string): void => {
      const todo = todos.find(item => item.id === sessionId);
      if (todo) {
        if (taskOpenRef.current) return;
        taskOpenRef.current = true;
        setTaskSeed({ todo, world: getFreeViewLayout().nodes[todo.id] });
        setTaskOpen(true);
        return;
      }
      void (async () => {
        const s = scopedSessions.find((x) => x.id === sessionId);
        const r = await jumpToSession({
          sessionId,
          workspaceId: s?.workspaceId,
          activeWorkspaceId,
          switchWorkspace
        });
        if (!r.ok) {
          flashTip(t('无法跳转：{{message}}', { message: r.message ?? t('工作区可能已关闭') }));
        }
      })();
    },
    [todos, scopedSessions, activeWorkspaceId, switchWorkspace, flashTip, t]
  );

  const { requestArchive, archiveFlowNode } = useArchiveFlow(scopedSessions);

  /** 卡片底部 / 右键：标记完成 / 取消完成标记（按点击时的 phase 快照分流） */
  const markDoneFromCard = useCallback(
    (sessionId: string): void => {
      const s = scopedSessions.find((x) => x.id === sessionId);
      if (!s) return;
      const cancel = s.phase?.value === 'done' && s.phase.source === 'user';
      void window.api.sessions.setPhase(sessionId, { value: cancel ? 'idle' : 'done' }).catch(reportError);
    },
    [scopedSessions, reportError]
  );

  /** 与左栏相同的归档入口（未完成的隔离会话走同一确认分流）。 */
  const archiveFromCard = useCallback(
    (sessionId: string): void => {
      const s = scopedSessions.find((x) => x.id === sessionId);
      if (!s) return;
      requestArchive(s, !s.archived);
    },
    [scopedSessions, requestArchive]
  );

  /** 卡片底部 / 右键：删除（后端仅对已归档会话放行） */
  const deleteFromCard = useCallback((sessionId: string): void => requestDelete([sessionId]), [requestDelete]);

  const markProcessedFromCard = useCallback((sessionId: string): void => {
    const session = scopedSessions.find(row => row.id === sessionId);
    if (session) requestArchive(session, true, undefined, true);
  }, [scopedSessions, requestArchive]);

  const openCtxMenu = useCallback((e: React.MouseEvent, s: SessionMeta): void => {
    e.preventDefault();
    e.stopPropagation();
    sessionMenu.openFixed(snapshotCtxMenu(s, e.clientX, e.clientY));
  }, [sessionMenu]);

  const openCtxMenuBySessionId = useCallback(
    (e: React.MouseEvent, sessionId: string): void => {
      const s = scopedSessions.find((x) => x.id === sessionId);
      if (s) openCtxMenu(e, s);
    },
    [scopedSessions, openCtxMenu]
  );

  // 状态列内按侧栏工作区顺序归组；已关闭及无归属会话按各自身份保留。
  const renderWorkspaceGroups = (zone: BoardZone, items: CardItem[]): React.ReactNode => {
    const groups = new Map<string | undefined, CardItem[]>();
    for (const card of items) {
      const group = groups.get(card.s.workspaceId) ?? [];
      group.push(card);
      groups.set(card.s.workspaceId, group);
    }
    const order = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
    return [...groups.entries()].sort(([a], [b]) => (order.get(a ?? '') ?? Infinity) - (order.get(b ?? '') ?? Infinity))
      .map(([id, groupItems]) => {
        const key = JSON.stringify([zone, id ?? null]);
        return <WorkspaceGroup key={key} name={workspaceNameOf(id) ?? ''} count={groupItems.length}
          expanded={!collapsedGroups.has(key)} onToggle={() => setCollapsedGroups(previous => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })}>
          {groupItems.map(item => renderCard(item))}
        </WorkspaceGroup>;
      });
  };

  // 视图主体：空态块与列网格（状态视图）——与自由画布 xfade 叠放互切。
  // 空态判定只看工作会话；调度入口位于左栏工作区回复气泡。
  const emptyBlock = (
    <div className="ui-empty board-empty">
      <div className="empty-logo" aria-hidden>
        <AppLogo size={56} />
      </div>
      <p className="ui-empty-desc">
        {filterOn ? t('当前工作区还没有工作会话') : t('所有工作区都还没有工作会话')}
      </p>
      <p className="hint-muted">{t('点击左栏 ＋ 新建任务，或问调度 Agent 派活')}</p>
    </div>
  );

  const statusBody = (
      <>
        <div className="board-grid" style={{ '--board-panel-count': Math.max(1, [
          panelMatches('todo'), panelMatches('working'), panelMatches('needsYou'), panelMatches('done'), panelMatches('archived')
        ].filter(Boolean).length) } as React.CSSProperties}>
          {panelMatches('todo') ? <Column zone="todo" count={scopedTodos.length}>
            {Array.from(new Set(scopedTodos.map(todo => todo.workspaceId))).sort((a, b) =>
              workspaceOrder.indexOf(a ?? '') - workspaceOrder.indexOf(b ?? '')).map(workspaceId => {
              const group = scopedTodos.filter(todo => todo.workspaceId === workspaceId).sort((a, b) => b.updatedAt - a.updatedAt);
              const key = JSON.stringify(['todo', workspaceId ?? null]);
              return <WorkspaceGroup key={key} name={workspaceNameOf(workspaceId) ?? ''} count={group.length}
                expanded={!collapsedGroups.has(key)} onToggle={() => setCollapsedGroups(previous => {
                  const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
                })}>
                {group.map(todo => <BoardTodoCard key={todo.id} id={todo.id} name={todo.name} task={todo.task} onEdit={() => select(todo.id)} />)}
              </WorkspaceGroup>;
            })}
            {!scopedTodos.length ? <p className="board-todo-empty hint-muted">{t('在新建任务中添加代办')}</p> : null}
          </Column> : null}
          {panelMatches('working') ? <Column zone="working" count={visibleBuckets.idle.length + visibleBuckets.quiet.length + visibleBuckets.working.length}>
            {visibleTotal === 0 ? emptyBlock : null}
            {renderWorkspaceGroups('working', [...visibleBuckets.working, ...visibleBuckets.quiet, ...visibleBuckets.idle])}
          </Column> : null}
          {panelMatches('needsYou') ? <Column zone="needsYou" count={visibleBuckets.needsYou.length}
            unreadCount={visibleBuckets.needsYou.filter((item) => !needsRead.has(item.s.id)).length}>
            {renderWorkspaceGroups('needsYou', visibleBuckets.needsYou)}
          </Column> : null}
          {panelMatches('done') ? <Column zone="done" count={visibleBuckets.done.length}>
            {renderWorkspaceGroups('done', visibleBuckets.done)}
          </Column> : null}
          {panelMatches('archived') ? <div className="board-column-archive">
            <Column zone="archived" count={visibleBuckets.exited.length}>
              {renderWorkspaceGroups('archived', visibleBuckets.exited)}
            </Column>
          </div> : null}
          {visibleTotal === 0 && panelFilterIds !== null && panelFilterIds.length === 0 ? (
            <div className="board-filter-empty hint-muted">{t('未选择面板')}</div>
          ) : null}
        </div>
      </>
    );

  return (
    <main ref={boardRootRef} className="board-utility-panel">
      <header className="prompt-task-toolbar board-toolbar">
        <div>
          <h1 title={globalBoardChord || undefined}>{t('全局看板')}</h1>
        </div>
        <div
          className="board-view-switch"
          data-setup-target="global-board-views"
          role="tablist"
          aria-label={t('看板视图')}
          title={t('左右方向键切换视图')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={!isFreeView}
            className="board-view-tab"
            onClick={() => setFreeViewMode('status')}
          >
            {t('状态')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isFreeView}
            className="board-view-tab"
            onClick={() => setFreeViewMode('free')}
          >
            {t('自由')}
          </button>
        </div>
        <div className="prompt-task-toolbar-actions board-management board-management-actions">
          <button
            type="button"
            className="ui-btn board-filter board-icon-btn"
            ref={filterButtonRef}
            aria-expanded={filterOpen}
            aria-haspopup="dialog"
            aria-label={t('过滤')}
            data-filtered={activeFilterCount > 0 ? 'true' : undefined}
            onClick={() => setFilterOpen(value => !value)}
          >
            <IconFilter size={15} />
          </button>
          <button
            type="button"
            className="ui-btn primary board-new board-icon-btn"
            aria-label={t('新建')}
            onClick={() => {
              setTaskSeed({});
              setTaskOpen(true);
            }}
          >
            <IconPlus size={15} />
          </button>
        </div>
      </header>

      <BoardFilterMenu
        open={filterOpen}
        anchorRef={filterButtonRef}
        workspaceOptions={workspaceFilterOptions}
        selectedWorkspaceIds={workspaceFilterIds}
        panelOptions={panelFilterOptions}
        selectedPanelIds={panelFilterIds}
        onToggleWorkspace={toggleWorkspaceFilter}
        onTogglePanel={togglePanelFilter}
        currentWorkspaceId={activeWorkspaceId}
        onSelectCurrentWorkspace={() => {
          if (activeWorkspaceId) setBoardFilterWorkspaceIds([activeWorkspaceId]);
        }}
        onSelectAllWorkspaces={() => setBoardFilterWorkspaceIds(null)}
        onSelectAllPanels={() => setBoardFilterPanelIds(null)}
        onClose={() => setFilterOpen(false)}
      />

      <div className="board-panel">
        {todoError ? <ErrorTip message={t('读取代办失败：{{message}}', { message: todoError })} /> : null}
        <div className="xfade-stack board-view-stack">
          <div className={`xfade board-slide board-body board-status-body${!isFreeView ? ' is-shown' : ''}`}
            aria-hidden={isFreeView} ref={element => { element?.toggleAttribute('inert', isFreeView); }}>{statusBody}</div>
          <div className={`xfade board-slide board-body board-free-body${isFreeView ? ' is-shown' : ''}`}
            aria-hidden={!isFreeView} ref={element => { element?.toggleAttribute('inert', !isFreeView); }}>
            {todosLoaded ? <FreeCanvas
              ref={freeCanvasRef}
              items={[...freeItems, ...(panelMatches('todo') ? scopedTodos : []).map(todo => ({
                id: todo.id, name: todo.name.trim() || todo.task.trim().split('\n')[0], runtimeLabel: t('代办'), status: 'idle' as const,
                todoTask: todo.task, workspaceName: workspaceNameOf(todo.workspaceId),
                zoneId: workspaceAlive(todo.workspaceId) ? todo.workspaceId! : '', isActive: false
              }))]}
              aliveIds={[...allFreeIds, ...todos.map(todo => todo.id)]}
              zones={{ ...allFreeZones, ...Object.fromEntries(todos.map(todo => [todo.id, workspaceAlive(todo.workspaceId) ? todo.workspaceId! : ''])) }}
              workspaceOrder={workspaceOrder}
              active={isFreeView && !taskOpen}
              onSelectSession={select}
              onContextMenu={(event, id) => { if (todos.some(todo => todo.id === id)) select(id); else openCtxMenuBySessionId(event, id); }}
              onRequestCreate={({ world, initialTask, stickyId, handover }) => {
                if (taskOpenRef.current) throw new Error(t('请先完成或关闭当前新建任务窗口'));
                taskOpenRef.current = true;
                handoverDraftRef.current = handover?.draft.id;
                setTaskSeed({ world, initialTask, stickyId, handover });
                setTaskOpen(true);
              }}
            /> : null}
          </div>
        </div>
      </div>
      <StatusTicker unreadCount={unreadNeedsCount} needsCount={visibleBuckets.needsYou.length} />

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onHoverEnter={sessionMenu.onSurfaceEnter}
          onHoverLeave={sessionMenu.onSurfaceLeave}
          hold={sessionMenu.hold ?? undefined}
          items={[
            ...(isFreeView
              ? [
                  {
                    id: 'note',
                    label: getFreeViewLayout().notes?.[ctxMenu.sessionId]
                      ? t('编辑备注')
                      : t('添加备注')
                  },
                  ...(getFreeViewLayout().notes?.[ctxMenu.sessionId]
                    ? [{ id: 'clear-note', label: t('清除备注') }]
                    : []),
                  { id: 'note-sep', separator: true }
                ]
              : []),
            { id: 'rename', label: t('重命名') },
            ...(ctxMenu.session.launchKind !== 'shell' && needsRead.has(ctxMenu.sessionId)
              ? [{ id: 'mark-unread', label: t('标记未读') }] : []),
            { id: 'pin', label: ctxMenu.session.pinned ? t('取消置顶') : t('置顶') },
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
            ...(!ctxMenu.archived &&
            ctxMenu.session.phase?.value === 'needs_you'
              ? [{ id: 'mark-processed', label: t('标记完成并归档') }]
              : []),
            ...(canReviewSession(ctxMenu.session) && !isDimensionGateRedSession(ctxMenu.session)
              ? [{ id: 'review-accept', label: ctxMenu.session.worktreePath && ctxMenu.session.worktreeBranch ? t('验收并合入') : t('验收并归档') }]
              : []),
            // R-14 维度门红灯专属：打回（自动附红灯详情）与强制验收（确认框跳过门+留痕）
            ...(isDimensionGateRedSession(ctxMenu.session)
              ? [
                  { id: 'gate-reject', label: t('打回重做（附维度门详情）') },
                  { id: 'gate-force', label: t('强制验收（跳过维度门）'), danger: true }
                ]
              : []),
            { id: 'evidence', label: t('查看证据') },
            ...sessionRestartActions(ctxMenu.session, runtimes, t),
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
              return;
            }
            if (id === 'note') {
              const sid = ctxMenu.sessionId;
              requestAnimationFrame(() => freeCanvasRef.current?.startNoteEdit(sid));
            } else if (id === 'clear-note') {
              freeCanvasRef.current?.clearNote(ctxMenu.sessionId);
            } else if (id === 'rename') {
              setRenaming({ id: ctxMenu.sessionId, name: ctxMenu.session.name });
            } else if (id === 'pin') {
              const s = ctxMenu.session;
              if (typeof window.api.sessions.setPinned !== 'function') {
                reportError(new Error(t('请完全重启应用后重试')));
                return;
              }
              void window.api.sessions.setPinned(s.id, !s.pinned).catch(reportError);
            } else if (id === 'mark-done') {
              const s = ctxMenu.session;
              markDoneFromCard(s.id);
            } else if (id === 'mark-processed') {
              markProcessedFromCard(ctxMenu.sessionId);
            } else if (id === 'review-accept') {
              setAcceptTarget(ctxMenu.session);
            } else if (id === 'gate-reject') {
              // 打回默认意见预填红灯详情：Worker 第一时间知道被哪个维度挡下、缺什么
              const detail = dimensionGateDetailText(ctxMenu.session.dimensionGates);
              setRejectDefaultNote(detail || undefined);
              setRejectTarget(ctxMenu.session);
            } else if (id === 'gate-force') {
              setForceAccept(ctxMenu.session);
            } else if (id === 'archive') {
              requestArchive(ctxMenu.session, !ctxMenu.archived);
            } else if (id === 'respawn' || id === 'new-conversation') {
              void runSessionRestart(ctxMenu.sessionId, id).catch(reportError);
            } else if (id === 'evidence') {
              openEvidenceView({ sessionId: ctxMenu.sessionId, sessionName: ctxMenu.session.name });
            } else if (id === 'discard-worktree') {
              setDiscardConfirm({
                sessionId: ctxMenu.sessionId,
                path: ctxMenu.orphanWorktree!,
                reason: ctxMenu.orphanWorktreeReason,
                branch: ctxMenu.orphanWorktreeBranch
              });
            } else if (id === 'delete') {
              deleteFromCard(ctxMenu.sessionId);
            }
          }}
        />
      )}

      <AppConfirmDialog
        open={!!discardConfirm}
        title={t('清理遗留 worktree')}
        detail={
          discardConfirm?.reason === 'unmerged'
            ? t(
                'worktree 本身没有未提交改动，但分支 {{branch}} 有未合入提交。\n将删除目录：{{path}}\n分支保留，回主仓 git merge {{branch}} 可取回工作。此操作不可撤销。',
                { branch: discardConfirm.branch ?? '', path: discardConfirm.path }
              )
            : t(
                '将强制删除会话的隔离 worktree{{dirtySuffix}}：\n{{path}}\n{{mergedNote}}此操作不可撤销。',
                {
                  dirtySuffix: discardConfirm?.reason === 'dirty' ? t('（含未提交改动）') : '',
                  path: discardConfirm?.path ?? '',
                  mergedNote: discardConfirm?.branch
                    ? t('分支 {{branch}} 若已合入将一并删除，未合入则保留。\n', {
                        branch: discardConfirm.branch
                      })
                    : ''
                }
              )
        }
        confirmLabel={t('放弃并清理')}
        danger
        onCancel={() => setDiscardConfirm(null)}
        onConfirm={() => {
          if (!discardConfirm) return;
          const { sessionId } = discardConfirm;
          setDiscardConfirm(null);
          closeCtxMenu();
          void window.api.sessions.discardWorktree(sessionId).then(result => {
            if (!result.ok) reportCleanupError(new Error(result.message || t('清理 worktree 失败')), sessionId);
            else if (result.message) reportError(new Error(result.message));
          }).catch(error => reportCleanupError(error, sessionId));
        }}
      />
      <WorktreeCleanupErrorDialog failure={cleanupError} onClose={() => setCleanupError(null)} onFailure={reportCleanupError} onRetryDelete={deleteFromCard} />
      {deleteFlowNode}
      {worktreeFlowNode}
      <NewTaskDialog
        open={taskOpen}
        runtimes={runtimes}
        workspace={workspaces.find(w => w.id === (taskSeed.todo ? taskSeed.todo.workspaceId : taskSeed.handover?.draft.workspaceId ?? activeWorkspaceId))}
        todo={taskSeed.todo}
        extensionSkillNames={taskSeed.todo?.advanced.extensionSource?.skillNames}
        onTodoSaved={todo => {
          if (taskSeed.world) freeCanvasRef.current?.placeSession(todo.id, taskSeed.world, taskSeed.stickyId ? { id: taskSeed.stickyId } : undefined);
        }}
        initialTask={taskSeed.initialTask}
        initialName={taskSeed.handover?.draft.name}
        initialSource={taskSeed.handover?.draft.sourceRoot}
        lockedTask={taskSeed.handover?.draft.lockedTask}
        onClose={closeTask}
        onOpenWorkerSettings={onOpenWorkerSettings ? () => {
          closeTask();
          // The board floats above Settings; close it before navigating there.
          onClose?.();
          onOpenWorkerSettings();
        } : undefined}
        onDelegate={async ({ task, attachments, submissionId, supplement, runtime, isolate, name, advanced, source, isolationGroups }) => {
          const seed = taskSeed;
          const r = await window.api.sessions.delegate({
            task, submissionId, ...(attachments?.length ? { attachments } : {}),
            runtime,
            isolate,
            name: name || undefined,
            ...(isolationGroups ? { isolationGroups } : {}),
            ...(seed.handover ? { handoverDraftId: seed.handover.draft.id, handoverSupplement: supplement ?? '' } : {}),
            ...source,
            ...advanced
          });
          if (r.queued && seed.handover && seed.world && !rememberQueuedHandover({ id: seed.handover.draft.id,
            from: seed.handover.draft.sourceId, port: seed.handover.fromPort, world: seed.world })) {
            flashTip(t('交接任务已排队，但无法保存画布落点；创建后请从会话列表打开'));
          }
          if (seed.world && r.session) {
            freeCanvasRef.current?.placeSession(
              r.session.id,
              seed.world,
              seed.handover ? { id: seed.handover.draft.sourceId, port: seed.handover.fromPort, kind: 'handover' } :
                seed.stickyId ? { id: seed.stickyId } : undefined
            );
          }
          return r;
        }}
        onBlankSession={async (runtime, name, advanced, source, isolation) => {
          const seed = taskSeed;
          await window.api.sessions
            .create({ runtime, ...(name ? { name } : {}), ...advanced, ...source, ...isolation })
            .then((s) => {
              if (seed.world && s?.id) {
                freeCanvasRef.current?.placeSession(
                  s.id,
                  seed.world,
                  seed.stickyId ? { id: seed.stickyId } : undefined
                );
              }
            });
        }}
      />
      {archiveFlowNode}
      <BoardReviewDialog
        open={!!rejectTarget}
        title={t('打回「{{name}}」', { name: rejectTarget?.name ?? '' })}
        confirmLabel={t('打回并继续改')}
        defaultNote={rejectDefaultNote ?? t('请按验收意见继续修改')}
        onCancel={() => {
          setRejectTarget(null);
          setRejectDefaultNote(undefined);
        }}
        onConfirm={(note) => {
          const s = rejectTarget;
          setRejectTarget(null);
          setRejectDefaultNote(undefined);
          if (!s) return;
          void window.api.sessions
            .review({ sessionId: s.id, decision: 'rejected', note })
            .then((r) => {
              if (r?.error) flashTip(r.error);
            })
            .catch((err: unknown) => {
              flashTip(err instanceof Error ? err.message : String(err));
            });
        }}
      />
      <AppConfirmDialog
        open={!!acceptTarget}
        title={t('验收「{{name}}」', { name: acceptTarget?.name ?? '' })}
        detail={acceptTarget?.worktreePath && acceptTarget.worktreeBranch
          ? t('合入隔离分支 {{branch}}，成功后安排归档。', { branch: acceptTarget.worktreeBranch })
          : t('记录验收结果并归档会话。')}
        confirmLabel={acceptTarget?.worktreePath && acceptTarget.worktreeBranch ? t('验收并合入') : t('验收并归档')}
        focusCancel
        onCancel={() => setAcceptTarget(null)}
        onConfirm={() => {
          if (!acceptTarget) return;
          const { id } = acceptTarget;
          setAcceptTarget(null);
          void window.api.sessions.review({ sessionId: id, decision: 'passed' }).then(result => {
            if (result?.ok === false && result.message) flashTip(result.message);
          }).catch(reportError);
        }}
      />
      <AppConfirmDialog
        open={!!forceAccept}
        title={t('强制验收「{{name}}」', { name: forceAccept?.name ?? '' })}
        detail={t(
          '维度门红灯：{{badge}}\n{{detail}}\n确认将跳过维度门按「验收通过」处理，并在验收账本留痕 dimension-gate-override。',
          {
            badge: forceAccept ? dimensionGateBadgeLabel(forceAccept.dimensionGates) : '',
            detail: forceAccept ? dimensionGateDetailText(forceAccept.dimensionGates) : ''
          }
        )}
        confirmLabel={t('强制验收（跳过维度门）')}
        danger
        onCancel={() => setForceAccept(null)}
        onConfirm={() => {
          const s = forceAccept;
          setForceAccept(null);
          if (!s) return;
          void window.api.sessions
            .review({ sessionId: s.id, decision: 'passed', skipDimensionGate: true })
            .then((r) => {
              if (r && r.ok === false && r.message) flashTip(r.message);
            })
            .catch((err: unknown) => {
              flashTip(err instanceof Error ? err.message : String(err));
            });
        }}
      />
    </main>
  );
}
