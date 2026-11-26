import { ErrorTip } from '../components/ErrorTip';
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { workspaceAvatarImageSrc, workspaceIconUrl } from '../workspaceIcons';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  useChatStore,
  useSessionStore,
  useUiStore,
  useWorkspaceStore
} from '../store';
import { useWorkspaceSidebarCollapsed } from '../sidebarPreferences';
import { MailEnvelopeViewport } from '../components/MailEnvelopeViewport';
import { MemoryCuratorView } from '../components/MemoryCuratorView';
import { SafetyIcon, SafetyPanel } from '../components/SafetyPanel';
import { AgentPhone, PhoneIcon } from '../agentApps/AgentPhone';
import { useAgentPhone } from '../agentApps/useAgentPhone';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { CreateWorkspaceModal } from '../components/CreateWorkspaceModal';
import { WorkspaceSaveError } from '../components/WorkspaceRootDependencies';
import { openWorkspaceDependency } from '../workspaceDependencyNavigation';
import { MOTION, prefersReducedMotion, usePresence, usePresenceValue } from '../components/motion';
import { useWorkspaceTransitSwitch } from '../workspaceTransit';
import { IconChevronDown, IconExpand, IconRefresh, IconShrink } from '../components/icons';
import { useWorkspaceReorder } from '../hooks/useWorkspaceReorder';
import { ContextMenu, type ContextMenuPoint } from '../components/ContextMenu';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
import { ChatResetDialog, type ChatResetTarget } from '../components/ChatResetDialog';
import type {
  WorkspaceInfo,
  WorkspaceRootDependency
} from '../../../shared/types';
import {
  dataTransferHasPaths,
  agentInsertFromDataTransfer
} from '../../../shared/fileDropPaths';
import { appendDraft } from '../composerDrafts';
import { resolveBubbleLabel } from './workspaceBubbleLabel';
import { maxPanelHeight, panelOriginY } from './agentFloatGeom';
import { workspaceNeedsYouCount } from '../../../shared/schedulerStatus';
import {
  ensureOrchestratorHistory,
  getOrchestratorSurface,
  setOrchestratorFallbackWs,
  useOrchestratorSurface
} from '../chatSurface/orchestratorSurface';
import { useChatSurfaceSnapshot } from '../chatSurface/ChatSurfaceView';
import { evictMemoryCuratorWorkspaces, useMemoryCuratorSurface } from '../chatSurface/memoryCuratorSurface';
import { useSessionNotes } from '../chatSurface/useSessionNotes';
import { registerDispatchOpener } from '../chatSurface/chatFindRegistry';
import type { ChatSurface } from '../../../shared/chatSurface';
import { workspaceAccent } from '../../../shared/workspaceAccent';
import { useWorkspaceAccentVersion } from '../useWorkspaceAccents';
import { SchedulerReplyPreviewCard, schedulerReplyUnreadIds, useSchedulerReplySnapshots } from './SchedulerReplyBubble';
import { useSchedulerReplyRead } from './schedulerReplyRead';
import { SchedulerConversation, SchedulerIdentity, schedulerMessageRole, useSchedulerActionStyle } from './SchedulerConversation';
import { SchedulerOverview } from './SchedulerOverview';
const FALLBACK_AVATAR = '🤖';
const subscribeEmpty = (): (() => void) => () => undefined;

const PANEL_SIZE_KEY = 'muster.agentPanelSize';
const PANEL_MIN_W = 360;
const PANEL_MIN_H = 260;
/** 与 GUI 会话阅读列（860）+ Composer 壳（884）对齐，拖宽不再铺满视口 */
const PANEL_MAX_W = 900;
/** 应用持久尺寸时的保守余量（工作区列表 + 间距 + 屏幕内边） */
const PANEL_APPLY_SAFE_W = 320;

/** 折叠态堆叠可见层数：当前工作区卡片后最多露出几层边（iOS 同款，更深的工作区完全隐藏） */
const WS_STACK_PEEK_LAYERS = 3;

function loadPanelSize(): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { w?: unknown; h?: unknown };
    if (typeof v.w === 'number' && typeof v.h === 'number' && v.w > 0 && v.h > 0) {
      return { w: v.w, h: v.h };
    }
  } catch {
    /* ignore */
  }
  return null;
}

interface Props {
  requireWorkspace?: boolean;
  guideNewWorkspace?: boolean;
  /** 工作区栈槽位（左栏 LeftPanel 底部）：非空且非内联模式时，栈 portal 挂进去，
   *  与侧边栏同生共死（悬停胶囊=悬停面板，速览收回/显隐绑定天然一致） */
  wsStackSlot?: HTMLDivElement | null;
  /** 栈内联渲染（窄屏：左栏是抽屉，栈保持左下浮层原位） */
  stackInline?: boolean;
  /** 当前激活右侧虚拟屏时保留面板，但不覆盖文件/Git 区域的磨砂遮罩。 */
  backdropBlur?: boolean;
  onOverviewOpenChange?: (open: boolean) => void;
}

function isImageAvatar(avatar: string): boolean {
  return !!workspaceAvatarImageSrc(avatar);
}

function faceOf(ws?: WorkspaceInfo | null): string {
  if (ws?.avatar?.trim()) return ws.avatar.trim();
  return FALLBACK_AVATAR;
}

function Face({
  avatar,
  className,
  title,
  disabled,
  onClick,
  onContextMenu
}: {
  avatar: string;
  className?: string;
  title?: string;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}): React.JSX.Element {
  const img = isImageAvatar(avatar);
  return (
    <button
      type="button"
      className={`agent-avatar agent-float-avatar${workspaceIconUrl(avatar) ? ' is-workspace-symbol' : ''}${className ? ` ${className}` : ''}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {img ? <img className="agent-avatar-img" src={workspaceAvatarImageSrc(avatar)} alt="" draggable={false} /> : avatar}
    </button>
  );
}

/** 列表旁工作区胶囊：主体切换工作区，右侧保留常驻「对话 / 收起」开合钮。 */
function WorkspaceNotifyBubble({
  ws,
  integratedAvatar,
  switching,
  isActive,
  panelOpen,
  live,
  needsCount,
  replyUnread,
  onPick,
  onCloseChat,
  onOpenChat,
  onToggleChat,
  onWorkspaceContextMenu
}: {
  ws: WorkspaceInfo;
  integratedAvatar: boolean;
  switching: boolean;
  isActive: boolean;
  panelOpen: boolean;
  /** 调度回合实时状态（ui:bubble；思考中/生成中/执行工具…） */
  live?: { text: string; status: string };
  /** 仅 Worker needs_you */
  needsCount?: number;
  /** 调度最新 assistant 回复未读；正文预览由行级悬浮卡承载 */
  replyUnread?: boolean;
  onPick: () => void;
  onCloseChat: () => void;
  onOpenChat: () => void;
  onToggleChat: () => void;
  onWorkspaceContextMenu: (e: React.MouseEvent) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const liveActive = !!live && live.status !== 'idle';
  const { text: displayText, mode } = resolveBubbleLabel({
    panelOpen,
    workspaceName: ws.name,
    liveText: live?.status === 'error' ? t('操作失败') : live?.text,
    liveActive
  });
  const liveClass =
    mode === 'live' && live?.status !== 'error' ? 'is-waiting is-live' : '';
  const needs = needsCount && needsCount > 0 ? needsCount : 0;
  const needsClass = !liveClass && needs > 0 ? ' is-waiting' : '';

  return (
    <div className="agent-notify-wrap">
      <ErrorTip message={isActive && live?.status === 'error' ? live.text : null} />
      <div className={`agent-notify-bubble${liveClass ? ` ${liveClass}` : ''}${needsClass}`}>
        {integratedAvatar ? (
          <Face
            avatar={faceOf(ws)}
            title={t('{{name}}\n单击打开/关闭对话 · 右键菜单 · 拖入文件打开面板', { name: ws.name })}
            disabled={switching}
            onClick={(e) => {
              e.stopPropagation();
              onToggleChat();
            }}
            onContextMenu={onWorkspaceContextMenu}
          />
        ) : null}
        <button
          type="button"
          className="agent-notify-body"
          aria-current={isActive || undefined}
          disabled={switching}
          onClick={(e) => {
            e.stopPropagation();
            if (panelOpen) onCloseChat();
            else onPick();
          }}
        >
          <span className="agent-notify-text">{displayText}</span>
          {needs > 0 ? (
            <span className="agent-notify-needs" aria-label={t('需要你 {{n}}', { n: needs })}>
              {needs > 99 ? '99+' : needs}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={`agent-notify-chat${panelOpen ? ' is-open' : ''}${replyUnread ? ' has-reply-unread' : ''}`}
          disabled={switching}
          onClick={(e) => {
            e.stopPropagation();
            onOpenChat();
          }}
        >
          <span className="agent-notify-chat-label">{panelOpen ? t('收起') : t('对话')}</span>
        </button>
      </div>
    </div>
  );
}

function WorkspaceStackItem({
  ws,
  integratedAvatar,
  switching,
  isActive,
  isChatting,
  live,
  needsCount,
  replyUnread,
  replyText,
  registerItem,
  onPick,
  onWorkspaceContextMenu,
  onToggleChat,
  onOpenChat,
  onOpenReply,
  onPathDragOver,
  onPathDrop
}: {
  ws: WorkspaceInfo;
  integratedAvatar: boolean;
  switching: boolean;
  isActive: boolean;
  isChatting: boolean;
  live?: { text: string; status: string };
  needsCount?: number;
  replyUnread?: boolean;
  replyText?: string;
  registerItem: (id: string, el: HTMLDivElement | null) => void;
  onPick: () => void;
  onWorkspaceContextMenu: (e: React.MouseEvent) => void;
  onToggleChat: () => void;
  onOpenChat: () => void;
  onOpenReply: () => void;
  onPathDragOver: (e: React.DragEvent) => void;
  onPathDrop: (e: React.DragEvent) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const itemRef = useRef<HTMLDivElement>(null);
  const [replyHover, setReplyHover] = useState(false);
  const [replyAnchor, setReplyAnchor] = useState<DOMRect | null>(null);
  const replyTimerRef = useRef<number | null>(null);

  const getReplyAnchor = useCallback((): DOMRect | null => {
    const item = itemRef.current;
    if (!item) return null;
    return item.querySelector<HTMLElement>('.agent-notify-bubble')?.getBoundingClientRect()
      ?? item.getBoundingClientRect();
  }, []);

  const clearReplyTimer = useCallback(() => {
    if (replyTimerRef.current !== null) {
      window.clearTimeout(replyTimerRef.current);
      replyTimerRef.current = null;
    }
  }, []);
  const showReplyPreview = useCallback(() => {
    clearReplyTimer();
    if (!replyUnread || !replyText) return;
    replyTimerRef.current = window.setTimeout(() => {
      replyTimerRef.current = null;
      const rect = getReplyAnchor();
      if (rect) {
        setReplyAnchor(rect);
        setReplyHover(true);
      }
    }, 240);
  }, [clearReplyTimer, getReplyAnchor, replyText, replyUnread]);
  const hideReplyPreview = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    clearReplyTimer();
    const related = event.relatedTarget;
    if (related instanceof Element && related.closest('.agent-scheduler-reply-preview-card')) return;
    setReplyHover(false);
  }, [clearReplyTimer]);

  useEffect(() => {
    registerItem(ws.id, itemRef.current);
    return () => registerItem(ws.id, null);
  }, [registerItem, ws.id]);
  useEffect(() => () => clearReplyTimer(), [clearReplyTimer]);
  useEffect(() => {
    if (!replyHover) return;
    const refreshAnchor = () => {
      const rect = getReplyAnchor();
      if (rect) setReplyAnchor(rect);
    };
    window.addEventListener('resize', refreshAnchor);
    window.addEventListener('scroll', refreshAnchor, true);
    return () => {
      window.removeEventListener('resize', refreshAnchor);
      window.removeEventListener('scroll', refreshAnchor, true);
    };
  }, [getReplyAnchor, replyHover]);

  return (
    <div
      ref={itemRef}
      className={`agent-ws-stack-item${isActive ? ' is-active' : ''}${isChatting ? ' is-chatting' : ''}`}
      style={{ '--ws-accent': workspaceAccent(ws.id) } as React.CSSProperties}
      onDragOver={onPathDragOver}
      onDrop={onPathDrop}
      onContextMenu={onWorkspaceContextMenu}
      onMouseEnter={showReplyPreview}
      onMouseLeave={hideReplyPreview}
    >
      {!integratedAvatar ? (
        <Face
          avatar={faceOf(ws)}
          title={t('{{name}}\n单击打开/关闭对话 · 右键菜单 · 拖入文件打开面板', { name: ws.name })}
          disabled={switching}
          onClick={(e) => {
            e.stopPropagation();
            onToggleChat();
          }}
          onContextMenu={onWorkspaceContextMenu}
        />
      ) : null}
      <div className="agent-ws-stack-main">
        <WorkspaceNotifyBubble
          ws={ws}
          integratedAvatar={integratedAvatar}
          switching={switching}
          isActive={isActive}
          panelOpen={isChatting}
          live={live}
          needsCount={needsCount}
          replyUnread={replyUnread}
          onPick={onPick}
          onCloseChat={onToggleChat}
          onOpenChat={onOpenChat}
          onToggleChat={onToggleChat}
          onWorkspaceContextMenu={onWorkspaceContextMenu}
        />
      </div>
      {replyUnread && replyText ? <SchedulerReplyPreviewCard
        open={replyHover}
        text={replyText}
        anchor={replyAnchor}
        onOpen={onOpenReply}
        onKeep={() => setReplyHover(true)}
        onClose={() => setReplyHover(false)}
      /> : null}
    </div>
  );
}

function AgentFloatInner({
  wsStackSlot = null,
  stackInline = false,
  backdropBlur = true,
  requireWorkspace = true,
  guideNewWorkspace = false,
  onOverviewOpenChange
}: Props): React.JSX.Element {
  const {
    bubblesByWs,
    chatWorkspaceId,
    setChatWorkspaceId,
    setChatWorkspaceIdAndLoad
  } = useChatStore();
  const { agentPanelRequest, workspaceEditRequest, clearWorkspaceEditRequest, flashTip, requestOpenWorkspaceFile } = useUiStore();
  const {
    workspaces,
    activeWorkspaceId,
    workspaceRecommendation,
    switching,
    openWorkspace,
    switchWorkspace,
    updateWorkspace,
    closeWorkspace
  } = useWorkspaceStore();
  const switchWorkspaceTransit = useWorkspaceTransitSwitch(switchWorkspace);
  useWorkspaceAccentVersion();
  const { sessions } = useSessionStore();
  const needsCountOf = useCallback(
    (wsId: string) =>
      workspaceNeedsYouCount({
        sessions,
        workspaceId: wsId
      }),
    [sessions]
  );
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const guidedCreate = useRef(false);
  /** Web 工作台的零工作区走原有弹窗；桌面由根布局接手。 */
  const noWorkspaces = workspaces.length === 0 && activeWorkspaceId !== null;
  const showRequiredWorkspace = noWorkspaces && requireWorkspace;
  const [workspaceMenu, setWorkspaceMenu] = useState<ContextMenuPoint & { workspace: WorkspaceInfo } | null>(null);
  const [deleteWorkspace, setDeleteWorkspace] = useState<WorkspaceInfo | null>(null);
  /** 工作区栈折叠（iOS 堆叠式）：当前工作区行置顶可见，其余行收进堆叠；偏好持久化 */
  const [wsCollapsed, setWsCollapsed] = useWorkspaceSidebarCollapsed(activeWorkspaceId, 'workspaces');
  const workspaceSort = useWorkspaceReorder(workspaces, switching, () => setWsCollapsed(false));
  const [overviewRequested, setOverviewRequested] = useState(false);
  const [overviewSourceId, setOverviewSourceId] = useState<string | null>(null);
  const overviewOpen = overviewRequested && workspaces.length > 0;
  const { presence: overviewPresence, value: overviewWorkspaces } = usePresenceValue(
    overviewOpen ? workspaceSort.ordered : null
  );
  const overviewId = useId();
  const overviewTriggerRef = useRef<HTMLButtonElement>(null);
  const overviewWasOpen = useRef(false);
  const closeOverview = useCallback(() => setOverviewRequested(false), []);
  useLayoutEffect(() => {
    onOverviewOpenChange?.(overviewOpen);
    return () => { if (overviewOpen) onOverviewOpenChange?.(false); };
  }, [onOverviewOpenChange, overviewOpen]);
  useEffect(() => {
    if (!workspaces.length) closeOverview();
  }, [closeOverview, workspaces.length]);
  useLayoutEffect(() => {
    const restoreFocus = overviewWasOpen.current && !overviewOpen && !chatWorkspaceId;
    overviewWasOpen.current = overviewOpen;
    if (!restoreFocus) return;
    const frame = requestAnimationFrame(() => overviewTriggerRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [chatWorkspaceId, overviewOpen]);
  const workspaceIds = useMemo(() => workspaces.map(workspace => workspace.id), [workspaces]);
  const schedulerReplies = useSchedulerReplySnapshots(workspaceIds);
  const replyRead = useSchedulerReplyRead();
  const unreadReplyIds = useMemo(
    () => schedulerReplyUnreadIds(workspaceIds, schedulerReplies, replyRead.isUnread),
    [replyRead, schedulerReplies, workspaceIds]
  );
  useEffect(() => {
    if (!chatWorkspaceId || overviewPresence.mounted) return;
    replyRead.markRead(chatWorkspaceId, schedulerReplies[chatWorkspaceId]?.messageId);
  }, [chatWorkspaceId, overviewPresence.mounted, replyRead, schedulerReplies]);
  /** 折叠⇄展开的动画窗口（is-stack-animating）：窗口内 CSS 保留行 z 层叠与槽位
   *  overflow: clip（float.css/left.css）——飞行行才能垫在当前行后、未起飞的行
   *  不会瞬时溢出左栏卡片底缘；收窗后回到无 z 的 DOM 绘制序，行投影才会
   *  被下一行盖住（带 z 的行投影会压在下一颗胶囊顶缘，看着像内阴影） */
  const [wsStackAnimating, setWsStackAnimating] = useState(false);
  const wsStackAnimTimerRef = useRef<number | null>(null);
  const [editWs, setEditWsState] = useState<WorkspaceInfo | null>(null);
  const editWsEpoch = useRef(0);
  const setEditWs = useCallback((value: React.SetStateAction<WorkspaceInfo | null>): void => {
    editWsEpoch.current++;
    setEditWsState(value);
  }, []);
  const editWsRef = useRef(editWs);
  editWsRef.current = editWs;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const handleOpenDependency = async (dependency: WorkspaceRootDependency): Promise<void> => {
    const workspace = editWs;
    if (!workspace) return;
    const epoch = editWsEpoch.current;
    await openWorkspaceDependency({ workspace, dependency, activeWorkspaceId,
      getWorkspace: id => workspacesRef.current.find(item => item.id === id),
      isCurrent: () => editWsEpoch.current === epoch && editWsRef.current === workspace,
      switchWorkspace: switchWorkspaceTransit, openFile: requestOpenWorkspaceFile });
    if (editWsEpoch.current === epoch && editWsRef.current === workspace) setEditWs(null);
  };
  useEffect(() => {
    if (!workspaceEditRequest) return;
    const workspace = workspaces.find(ws => ws.id === workspaceEditRequest.workspaceId);
    if (workspace) {
      setCreateOpen(false);
      setEditWs(workspace);
    }
    clearWorkspaceEditRequest();
  }, [workspaceEditRequest, workspaces, clearWorkspaceEditRequest]);
  /** 面板开合以 store 的 chatWorkspaceId 为唯一来源：非空即开，退场期冻结最后一区内容；
   *  开着换区（非空→非空）只换内容不重播进出场 */
  const { presence: panelPresence, value: shownChatId } = usePresenceValue(
    chatWorkspaceId,
    MOTION.exitMs
  );
  const panelStage = panelPresence.stage;
  const panelOpen = panelPresence.mounted && shownChatId != null && !overviewPresence.mounted;
  const chatRequested = chatWorkspaceId != null;
  const phoneWorkspaceId = shownChatId ?? activeWorkspaceId ?? '';
  const phone = useAgentPhone(phoneWorkspaceId);
  const phoneTriggerRef = useRef<HTMLButtonElement>(null);
  const [resetTarget, setResetTarget] = useState<ChatResetTarget | null>(null);
  useEffect(() => { setResetTarget(null); }, [chatWorkspaceId]);
  /** 可交互（非退场）：按钮/拖拽/查找/聚焦只在此态开放 */
  const panelReady = panelOpen && panelStage === 'in';
  const panelPhaseClass =
    panelStage === 'enter' ? 'is-entering' : panelStage === 'in' ? 'is-open' : 'is-exiting';
  /** 用户拖拽调过的面板尺寸（localStorage 持久；空 = 用 CSS 默认） */
  const [panelSize, setPanelSize] = useState<{ w: number; h: number } | null>(() =>
    loadPanelSize()
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const itemElsRef = useRef(new Map<string, HTMLDivElement>());
  const chatWorkspaceIdRef = useRef(chatWorkspaceId);
  chatWorkspaceIdRef.current = chatWorkspaceId;

  const shownWs = workspaces.find((w) => w.id === shownChatId);
  const panelActionStyle = useSchedulerActionStyle(shownChatId);
  const surface: ChatSurface | null = useOrchestratorSurface(shownChatId);
  const surfaceBusy = React.useSyncExternalStore(surface?.subscribe ?? subscribeEmpty, () => surface?.getSnapshot().busy ?? false);
  const [memoryOpenByWorkspace, setMemoryOpenByWorkspace] = useState<Record<string, boolean>>({});
  const [memoryVisited, setMemoryVisited] = useState<Record<string, boolean>>({});
  const memoryTriggerRef = useRef<HTMLButtonElement>(null), memorySheetRef = useRef<HTMLElement>(null);
  const memorySheetOpen = Boolean(shownChatId && memoryOpenByWorkspace[shownChatId] && panelReady);
  const memoryPresence = usePresence(memorySheetOpen);
  const [safetyOpenWorkspace, setSafetyOpenWorkspace] = useState<string | null>(null);
  const safetyTriggerRef = useRef<HTMLButtonElement>(null);
  const safetySheetOpen = Boolean(shownChatId && safetyOpenWorkspace === shownChatId && panelReady);
  const safetyPresence = usePresence(safetySheetOpen);
  const subsystemMounted = memoryPresence.mounted || safetyPresence.mounted;
  const closeSafetySheet = useCallback((restoreFocus = false): void => {
    setSafetyOpenWorkspace(null);
    if (restoreFocus) safetyTriggerRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => { setSafetyOpenWorkspace(null); }, [shownChatId]);
  const memoryOpenRef = useRef(memorySheetOpen), dismissMemoryClick = useRef(false);
  memoryOpenRef.current = memorySheetOpen;
  const memorySurface = useMemoryCuratorSurface(shownChatId, Boolean(shownChatId && memoryVisited[shownChatId]));
  const memorySnap = useChatSurfaceSnapshot(memorySurface);
  useEffect(() => { evictMemoryCuratorWorkspaces(workspaces.map(workspace => workspace.id)); }, [workspaces]);
  const closeMemorySheet = useCallback((restoreFocus = false): void => {
    if (!shownChatId) return;
    setMemoryOpenByWorkspace(previous => ({ ...previous, [shownChatId]: false }));
    if (restoreFocus) memoryTriggerRef.current?.focus({ preventScroll: true });
  }, [shownChatId]);
  const toggleMemorySheet = (): void => {
    if (!shownChatId) return;
    if (memorySheetOpen) { closeMemorySheet(true); return; }
    closeSafetySheet();
    phone.controller.close();
    setMemoryVisited(previous => ({ ...previous, [shownChatId]: true }));
    setMemoryOpenByWorkspace(previous => ({ ...previous, [shownChatId]: true }));
  };
  useEffect(() => {
    if (!phone.state.open || !phoneWorkspaceId || overviewPresence.mounted) return;
    closeMemorySheet();
    closeSafetySheet();
    if (!chatWorkspaceIdRef.current) void setChatWorkspaceIdAndLoad(phoneWorkspaceId);
    // Only a new opening may reveal the scheduler. Closing its parent must not
    // reopen it just because a phone was visible in that parent.
  }, [phone.controller, phone.state.open]);
  useOverlayDismiss(panelReady && phone.state.open, () => {
    const restoreFocus = document.activeElement?.closest('.agent-phone-panel');
    phone.controller.close();
    if (restoreFocus) phoneTriggerRef.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!panelReady) return;
    const isInside = (target:EventTarget|null):boolean => target instanceof Node && Boolean(memorySheetRef.current?.contains(target) || memoryTriggerRef.current?.contains(target) || target instanceof Element && target.closest('.agent-phone-toggle,.agent-phone-panel,.agent-safety-toggle,.agent-safety-sheet,.agent-ws-overview-btn'));
    const consume = (event:Event):void => { event.preventDefault(); event.stopPropagation(); };
    const onPointerDown = (event:PointerEvent):void => {
      dismissMemoryClick.current = false;
      if (event.target instanceof Element && event.target.closest('.app-confirm-mask')) return;
      if (!memoryOpenRef.current || isInside(event.target)) return;
      dismissMemoryClick.current = true;closeMemorySheet();consume(event);
    };
    const onClick = (event:MouseEvent):void => {
      if (event.target instanceof Element && event.target.closest('.app-confirm-mask')) return;
      if (event.target instanceof Node && memoryTriggerRef.current?.contains(event.target)) { dismissMemoryClick.current = false;return; }
      if (dismissMemoryClick.current) { dismissMemoryClick.current = false;consume(event);return; }
      if (memoryOpenRef.current && !isInside(event.target)) { closeMemorySheet();consume(event); }
    };
    const onKeyDown = (event:KeyboardEvent):void => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key !== 'Escape' || !memoryOpenRef.current) return;
      closeMemorySheet(true);consume(event);
    };
    document.addEventListener('pointerdown',onPointerDown,true);
    document.addEventListener('click',onClick,true);
    document.addEventListener('keydown',onKeyDown,true);
    return () => { document.removeEventListener('pointerdown',onPointerDown,true);document.removeEventListener('click',onClick,true);document.removeEventListener('keydown',onKeyDown,true);dismissMemoryClick.current=false; };
  },[panelReady,shownChatId,closeMemorySheet]);
  useLayoutEffect(() => {
    if (!memorySheetOpen || !memoryPresence.mounted) return;
    const sheet = memorySheetRef.current;
    const input = sheet?.querySelector<HTMLElement>('textarea:not(:disabled), [contenteditable="true"]');
    (input ?? sheet)?.focus({ preventScroll: true });
  },[memorySheetOpen,memoryPresence.mounted]);
  const notesViewRef = useRef<HTMLDivElement>(null);
  const notesWorkspaceId = overviewPresence.mounted ? overviewSourceId : shownChatId;
  const getDispatchMessageRole = useCallback(
    (messageId: string) => notesWorkspaceId
      ? schedulerMessageRole(getOrchestratorSurface(notesWorkspaceId), messageId)
      : undefined,
    [notesWorkspaceId]
  );
  const notesHost = useSessionNotes({
    sessionId: notesWorkspaceId ?? '',
    draftKey: notesWorkspaceId ?? '',
    getMessageRole: getDispatchMessageRole,
    viewRef: notesViewRef,
    flashTip,
    requestOpenWorkspaceFile
  });
  const overviewSourceNotes = useMemo(() => notesWorkspaceId
    ? { workspaceId: notesWorkspaceId, host: notesHost, viewRef: notesViewRef }
    : null, [notesHost, notesWorkspaceId]);
  const panelBusy = Boolean(shownChatId && shownChatId === chatWorkspaceId && surfaceBusy);
  /** 面板显示区 = 聊天区（实况开关；退出动画期间为 false，视图冻结最后一份实况） */
  const chatLive = panelOpen && panelStage !== 'out' && shownChatId === chatWorkspaceId;
  // 新面板装载历史；token/thinking/tool 事件的 ws 兜底随实况工作区走
  useEffect(() => {
    if (shownChatId) void ensureOrchestratorHistory(shownChatId);
  }, [shownChatId]);
  useEffect(() => {
    setOrchestratorFallbackWs(overviewPresence.mounted ? null : chatWorkspaceId);
    return () => setOrchestratorFallbackWs(null);
  }, [chatWorkspaceId, overviewPresence.mounted]);

  /** 右上角拖拽调面板大小：左下角锚定不动，向右/向上放大。直接写样式保证跟手，松手才落 state/localStorage。 */
  const onPanelResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!panelReady) return;
    const panel = panelRef.current;
    const handle = e.currentTarget;
    if (!panel) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;
    // 面板左/下边缘锚定：宽最多到视口右缘（留 12px）；高不与顶栏重合
    // （报单④：顶缘 ≥ 顶栏下沿 + 间隙，见 agentFloatGeom.ts 取舍说明）
    const maxW = Math.min(
      PANEL_MAX_W,
      Math.max(PANEL_MIN_W, window.innerWidth - rect.left - 12)
    );
    const maxH = Math.max(PANEL_MIN_H, maxPanelHeight(window.innerHeight));
    let latestW = startW;
    let latestH = startH;
    let raf = 0;
    const apply = (): void => {
      raf = 0;
      panel.style.width = `${latestW}px`;
      panel.style.height = `${latestH}px`;
    };
    const onMove = (ev: PointerEvent): void => {
      const w = Math.min(Math.max(startW + (ev.clientX - startX), PANEL_MIN_W), maxW);
      const h = Math.min(Math.max(startH - (ev.clientY - startY), PANEL_MIN_H), maxH);
      if (w === latestW && h === latestH) return;
      latestW = w;
      latestH = h;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const finish = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      document.body.classList.remove('is-panel-resizing');
      if (raf) cancelAnimationFrame(raf);
      apply();
      const next = { w: Math.round(latestW), h: Math.round(latestH) };
      setPanelSize(next);
      try {
        localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.add('is-panel-resizing');
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };

  /** 应用持久尺寸（夹在当前视口内；空则交回 CSS 默认）。高度上限不与顶栏重合（报单④）。 */
  const panelStyle = (() => {
    if (!panelSize) return undefined;
    const w = Math.min(
      Math.max(panelSize.w, PANEL_MIN_W),
      PANEL_MAX_W,
      Math.max(PANEL_MIN_W, window.innerWidth - PANEL_APPLY_SAFE_W)
    );
    const h = Math.min(Math.max(panelSize.h, PANEL_MIN_H), Math.max(PANEL_MIN_H, maxPanelHeight(window.innerHeight)));
    return { width: `${w}px`, height: `${h}px`, maxHeight: 'none', flexShrink: 0 } as const;
  })();

  const registerItem = useCallback((id: string, el: HTMLDivElement | null): void => {
    if (el) itemElsRef.current.set(id, el);
    else itemElsRef.current.delete(id);
  }, []);

  const setPanelOrigin = useCallback((wsId: string | null): void => {
    const panel = panelRef.current;
    if (!panel) return;
    const item = wsId ? itemElsRef.current.get(wsId) : undefined;
    panel.style.setProperty('--panel-origin-y', panelOriginY(panel.getBoundingClientRect(), item?.getBoundingClientRect()));
  }, []);

  const getOverviewAnchor = useCallback((workspaceId: string): DOMRect | undefined => {
    const row = itemElsRef.current.get(workspaceId);
    const anchor = row && !row.closest('.agent-ws-stack-row[aria-hidden]') ? row : overviewTriggerRef.current;
    return anchor?.getBoundingClientRect();
  }, []);

  // 缩放原点对准来源工作区行：进场取目标行、退场取当前展示行（退场中 shownChatId 已冻结）
  const panelExiting = panelStage === 'out';
  useLayoutEffect(() => {
    if (panelOpen) setPanelOrigin(shownChatId);
  }, [panelOpen, panelExiting, shownChatId, setPanelOrigin]);

  /** 点击打开/切换；同一区再点则关闭。进出场可打断：退场中再点即从当前位置回弹，
   *  开着点别的区只换内容 */
  const handleToggleChat = useCallback(
    async (id: string): Promise<void> => {
      if (chatWorkspaceIdRef.current === id) {
        phone.controller.close();
        setChatWorkspaceId(null);
        return;
      }
      await setChatWorkspaceIdAndLoad(id);
    },
    [setChatWorkspaceId, setChatWorkspaceIdAndLoad, phone.controller]
  );

  /** 路径拖入：只打开/切换到目标工作区，已打开则不关 */
  const ensureChatOpen = useCallback(
    async (id: string): Promise<void> => {
      if (chatWorkspaceIdRef.current === id) return;
      await setChatWorkspaceIdAndLoad(id);
    },
    [setChatWorkspaceIdAndLoad]
  );
  const openScheduler = useCallback((id: string): void => {
    setSafetyOpenWorkspace(null);
    setMemoryOpenByWorkspace(previous => ({ ...previous, [id]: false }));
    void ensureChatOpen(id);
  }, [ensureChatOpen]);
  useEffect(() => {
    registerDispatchOpener(openScheduler);
    return () => registerDispatchOpener(null);
  }, [openScheduler]);

  const pathDragOpenRef = useRef<{ id: string; at: number } | null>(null);

  /** 外部请求打开面板并切到指定工作区（如定时任务运行历史跳转） */
  const agentPanelNonceSeenRef = useRef(0);
  useEffect(() => {
    if (!agentPanelRequest) return;
    if (agentPanelNonceSeenRef.current === agentPanelRequest.nonce) return;
    agentPanelNonceSeenRef.current = agentPanelRequest.nonce;
    const purpose = agentPanelRequest.purpose ?? 'dispatch';
    if (purpose === 'memory') closeOverview();
    setSafetyOpenWorkspace(null);
    phone.controller.close();
    setMemoryOpenByWorkspace(previous => ({ ...previous, [agentPanelRequest.workspaceId]: purpose === 'memory' }));
    if (purpose === 'memory') setMemoryVisited(previous => ({ ...previous, [agentPanelRequest.workspaceId]: true }));
    void ensureChatOpen(agentPanelRequest.workspaceId);
  }, [agentPanelRequest, closeOverview, ensureChatOpen]);

  const onStackPathDragOver = useCallback(
    (e: React.DragEvent, id: string): void => {
      if (!dataTransferHasPaths(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const now = Date.now();
      const prev = pathDragOpenRef.current;
      if (prev?.id === id && now - prev.at < 350) return;
      pathDragOpenRef.current = { id, at: now };
      void ensureChatOpen(id);
    },
    [ensureChatOpen]
  );

  const onStackPathDrop = useCallback(
    (e: React.DragEvent, id: string): void => {
      if (!dataTransferHasPaths(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const getPath = window.api?.shell?.pathForFile;
      const text = agentInsertFromDataTransfer(
        e.dataTransfer,
        typeof getPath === 'function' ? (f) => getPath(f) : () => ''
      );
      if (!text) return;
      void (async () => {
        await ensureChatOpen(id);
        // 直接追加到持久化草稿：面板重开/连拖多个文件都不丢、不覆盖
        appendDraft(id, text);
      })();
    },
    [ensureChatOpen]
  );

  /** 气泡常驻开合钮：切换对话面板（同区已开则关） */
  const handleOpenChat = useCallback(
    async (id: string): Promise<void> => {
      await handleToggleChat(id);
    },
    [handleToggleChat]
  );

  /** 流式自动滚底 / 划区跟随已随消息列表本体迁入 ChatSurfaceView（ChatTranscript） */

  // 开面板/换区后聚焦输入框。不监听点外关闭——误关太容易，只走头像/气泡「收起」等显式手段
  useEffect(() => {
    if (!panelReady) return;
    const raf = requestAnimationFrame(() => {
      const el = safetyOpenWorkspace === shownChatId ? panelRef.current?.querySelector<HTMLElement>('[data-agent-purpose="safety"]') : memoryOpenRef.current ? memorySheetRef.current : panelRef.current?.querySelector(
        '[data-agent-purpose="dispatch"] textarea, [data-agent-purpose="dispatch"] [contenteditable="true"]'
      ) as HTMLElement | null;
      el?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [panelReady, shownChatId]);

  const pickWorkspace = async (ws: WorkspaceInfo): Promise<void> => {
    if (!activeWorkspaceId || ws.id === activeWorkspaceId) return;
    const res = await switchWorkspaceTransit(ws.id);
    if (!res.ok && res.message) console.warn('[workspace]', res.message);
  };

  const openWorkspaceMenu = (ws: WorkspaceInfo, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setWorkspaceMenu({ workspace: ws, x: e.clientX, y: e.clientY, anchor: e.currentTarget });
  };

  /** 折叠态排序：当前工作区置顶，其余保持原相对顺序收进堆叠（行折叠不可见） */
  const stackWorkspaces = useMemo(() => {
    if (!wsCollapsed || !activeWorkspaceId) return workspaceSort.ordered;
    const active = workspaceSort.ordered.filter((w) => w.id === activeWorkspaceId);
    return [...active, ...workspaceSort.ordered.filter((w) => w.id !== activeWorkspaceId)];
  }, [workspaceSort.ordered, wsCollapsed, activeWorkspaceId]);

  /** 开一次动画窗口：最深一层行的 transform 延迟 (n-2)*--dur-stagger，追平手风琴的
   *  panelMs 即收窗；连点时重置计时（transition 被打断重走，窗口跟着重开）。
   *  prefers-reduced-motion 下过渡全关（base.css），行瞬时就位无重叠期，不开窗 */
  const beginWsStackAnimating = useCallback((): void => {
    if (prefersReducedMotion()) return;
    setWsStackAnimating(true);
    if (wsStackAnimTimerRef.current !== null) window.clearTimeout(wsStackAnimTimerRef.current);
    wsStackAnimTimerRef.current = window.setTimeout(
      () => {
        wsStackAnimTimerRef.current = null;
        setWsStackAnimating(false);
      },
      MOTION.panelMs + Math.max(0, workspaces.length - 2) * MOTION.staggerMs
    );
  }, [workspaces.length]);

  useEffect(
    () => () => {
      if (wsStackAnimTimerRef.current !== null) window.clearTimeout(wsStackAnimTimerRef.current);
    },
    []
  );

  const toggleWsCollapsed = useCallback((): void => {
    beginWsStackAnimating();
    setWsCollapsed((v) => {
      const next = !v;
      return next;
    });
  }, [beginWsStackAnimating, setWsCollapsed]);

  /** 折叠行几何：折叠时当前工作区行（置顶位 depth=0）保持展开，其余行按堆叠深度
   *  缩小一圈、下移一点、垫在当前行后面（iOS 堆叠通知意象，CSS 消费 --ws-depth）；
   *  超过可见层数的完全隐藏（is-stack-buried）。
   *  is-active-row 按真实激活工作区标记（z 层叠挂在它身上；展开态首行若非激活行
   *  不得冒领，否则其投影会压到下一颗胶囊顶缘——展开态「内阴影」的根因） */
  const wsStackRowProps = (
    wsId: string,
    depth: number
  ): { className: string; style?: React.CSSProperties; 'aria-hidden'?: true; ref: (element: HTMLDivElement | null) => void } => {
    const isActive = wsId === activeWorkspaceId;
    const open = !wsCollapsed || depth === 0;
    let className = `agent-ws-stack-row${open ? ' is-open' : ''}${
      isActive ? ' is-active-row' : ''
    }`;
    const style = { '--ws-depth': String(depth) } as React.CSSProperties;
    if (wsCollapsed && depth !== 0) {
      if (depth > WS_STACK_PEEK_LAYERS) className += ' is-stack-buried';
    }
    const hidden = wsCollapsed && depth !== 0;
    return { className, style, 'aria-hidden': hidden ? true : undefined,
      ref: element => { element?.toggleAttribute('inert', hidden); } };
  };

  /** 折叠钮：工作区 ≥2 才有意义（单个无堆叠可言） */
  const wsCollapseBtn = workspaces.length > 1 && (
    <button
      type="button"
      className={`agent-ws-collapse-btn${wsCollapsed ? ' is-collapsed' : ''}`}
      title={
        wsCollapsed
          ? t('展开工作区列表（堆叠 {{n}} 个工作区）', { n: workspaces.length - 1 })
          : t('折叠工作区列表（只留当前工作区）')
      }
      aria-expanded={!wsCollapsed}
      disabled={switching || !!workspaceSort.dragging}
      onClick={toggleWsCollapsed}
    >
      <IconChevronDown size={14} className="agent-ws-collapse-caret" />
    </button>
  );

  /** 工作区胶囊栈（折叠/新建钮 + 每区头像/通知气泡）：宽屏经 portal 挂进左栏槽位
   *  （随侧边栏显隐、悬停计入面板），窄屏保持左下浮层原位内联。
   *  折叠=当前工作区行置顶展开，其余行收进堆叠（iOS 堆叠通知意象） */
  const wsStack = (
    <div
      {...workspaceSort.props}
      className={`agent-ws-stack${wsCollapsed ? ' is-collapsed' : ''}${
        wsStackAnimating ? ' is-stack-animating' : ''
      }${workspaceSort.dragging ? ' is-sorting' : ''
      }`}
    >
      <div className="agent-ws-stack-header">
        <span className="agent-ws-stack-label" title={t('长按拖动排序，Alt + 方向键也可调整')}>{t('工作区')}</span>
        <span className="agent-ws-sort-hint" role="status" aria-live="polite">
          {workspaceSort.dragging ? t('位置 {{position}}/{{total}} · Esc 取消', { position: workspaceSort.position, total: workspaces.length })
            : ''}
        </span>
        {wsCollapseBtn}
        {workspaces.length > 0 ? (
          <button
            ref={overviewTriggerRef}
            type="button"
            className="agent-ws-overview-btn"
            aria-label={t(overviewOpen ? '收起并排对话' : '展开并排对话')}
            title={t(overviewOpen ? '收起并排对话' : '展开并排对话')}
            aria-expanded={overviewOpen}
            aria-haspopup="dialog"
            aria-controls={overviewPresence.mounted ? overviewId : undefined}
            disabled={switching || !!workspaceSort.dragging}
            onClick={() => {
              if (overviewOpen) {
                closeOverview();
                return;
              }
              if (!overviewPresence.mounted) setOverviewSourceId(shownChatId);
              phone.controller.close();
              setResetTarget(null);
              setOverviewRequested(true);
            }}
          >
            {overviewOpen ? <IconShrink size={13} /> : <IconExpand size={13} />}
          </button>
        ) : null}
        <button
          type="button"
          className="agent-ws-add-btn"
          aria-label={t('新建工作区')}
          title={t('新建工作区')}
          data-setup-target={guideNewWorkspace && !createOpen ? 'workspace' : undefined}
          disabled={switching || !!workspaceSort.dragging}
          onClick={() => { guidedCreate.current = noWorkspaces && !requireWorkspace; setCreateOpen(true); }}
        >
          +
        </button>
      </div>
      {workspaceSort.saveFailed && <div role="alert">{t('排序保存失败，重启后可能恢复原顺序')}</div>}
      {stackWorkspaces.map((w, i) => {
        if (i !== 0) return null;
        const isActive = w.id === activeWorkspaceId;
        const row = wsStackRowProps(w.id, i);
        return (
          <div key={w.id} {...row} data-workspace-sort-id={w.id} data-sorting={workspaceSort.dragging === w.id || undefined} data-sort-pressing={workspaceSort.pressing === w.id || undefined}>
            <WorkspaceStackItem
              ws={w}
              integratedAvatar={!stackInline}
              switching={switching}
              isActive={isActive}
               isChatting={shownChatId === w.id && chatRequested}
              live={bubblesByWs[w.id]}
              needsCount={needsCountOf(w.id)}
              replyUnread={unreadReplyIds.includes(w.id)}
              replyText={schedulerReplies[w.id]?.text}
              registerItem={registerItem}
              onPick={() => void pickWorkspace(w)}
              onWorkspaceContextMenu={(e) => openWorkspaceMenu(w, e)}
              onToggleChat={() => void handleToggleChat(w.id)}
              onOpenChat={() => void handleOpenChat(w.id)}
              onOpenReply={() => void handleOpenChat(w.id)}
              onPathDragOver={(e) => onStackPathDragOver(e, w.id)}
              onPathDrop={(e) => onStackPathDrop(e, w.id)}
            />
          </div>
        );
      })}
      {/* 其余行：rest 手风琴（grid 0fr↔1fr 管容器高度→钉底栈整体 glide），
          折叠时行内 transform 同步滑到当前行后缘（溢出可见才能叠到卡片后方） */}
      <div className={`agent-ws-stack-rest${wsCollapsed ? '' : ' is-open'}`}>
        <div className="agent-ws-stack-rest-body">
          {stackWorkspaces.map((w, i) => {
            if (i === 0) return null;
            const isActive = w.id === activeWorkspaceId;
            const row = wsStackRowProps(w.id, i);
            return (
              <div key={w.id} {...row} data-workspace-sort-id={w.id} data-sorting={workspaceSort.dragging === w.id || undefined} data-sort-pressing={workspaceSort.pressing === w.id || undefined}>
                <WorkspaceStackItem
                  ws={w}
                  integratedAvatar={!stackInline}
                  switching={switching}
                  isActive={isActive}
                   isChatting={shownChatId === w.id && chatRequested}
                  live={bubblesByWs[w.id]}
                  needsCount={needsCountOf(w.id)}
                  replyUnread={unreadReplyIds.includes(w.id)}
                  replyText={schedulerReplies[w.id]?.text}
                  registerItem={registerItem}
                  onPick={() => void pickWorkspace(w)}
                  onWorkspaceContextMenu={(e) => openWorkspaceMenu(w, e)}
                  onToggleChat={() => void handleToggleChat(w.id)}
                  onOpenChat={() => void handleOpenChat(w.id)}
                  onOpenReply={() => void handleOpenChat(w.id)}
                  onPathDragOver={(e) => onStackPathDragOver(e, w.id)}
                  onPathDrop={(e) => onStackPathDrop(e, w.id)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`agent-float${panelOpen ? ' is-expanded' : ' is-collapsed'}`}
      // 内置浏览器让位：WebContentsView 恒在渲染层之上，浮窗（含展开面板）压在
      // 网页区上方时截图让位、移开恢复（leave 也重判——面板开着仍压着则保持让位）
    >
      {workspaceMenu && <ContextMenu x={workspaceMenu.x} y={workspaceMenu.y} anchor={workspaceMenu.anchor} hold="fixed"
        items={[
          { id: 'workspace-edit', label: t('编辑'), disabled: switching },
          { id: 'workspace-delete', label: t('删除'), danger: true, disabled: switching || workspaces.length === 0,
            title: t('从已打开列表移除') },
          { id: 'workspace-unread', label: t('标记未读') }
        ]}
        onClose={() => setWorkspaceMenu(null)}
        onSelect={id => {
          const workspace = workspaceMenu.workspace;
          setWorkspaceMenu(null);
          if (id === 'workspace-edit') { setCreateOpen(false); setEditWs(workspace); }
          else if (id === 'workspace-delete') setDeleteWorkspace(workspace);
          else if (id === 'workspace-unread') replyRead.markUnread(workspace.id, schedulerReplies[workspace.id]?.messageId);
        }} />}
      <ChatResetDialog target={!overviewPresence.mounted && resetTarget?.workspaceId === chatWorkspaceId ? resetTarget : null} onClose={() => setResetTarget(null)}/>
      <AppConfirmDialog open={!!deleteWorkspace} title={t('关闭工作区')}
        detail={t('关闭工作区「{{name}}」？不会删除磁盘文件，仅从已打开列表移除。', { name: deleteWorkspace?.name ?? '' })}
        confirmLabel={t('确认关闭')} danger onCancel={() => setDeleteWorkspace(null)}
        onConfirm={() => {
          if (!deleteWorkspace || switching) return;
          const workspace = deleteWorkspace;
          setDeleteWorkspace(null);
          void closeWorkspace(workspace.id).then(result => {
            if (!result.ok) flashTip(result.message || t('删除失败'));
          }).catch(error => flashTip(error instanceof Error ? error.message : t('删除失败')));
        }} />
      <div className="agent-float-anchor">
        {stackInline ? (
          wsStack
        ) : (
          /* 栈本体已 portal 进左栏（见 wsStackSlot）：这里留同几何幽灵占位，保住
             对话面板「贴着栈右侧、is-chatting 气泡收窄时左移」的锚位不漂移 */
          <div className={`agent-ws-stack agent-ws-stack-ghost${wsCollapsed ? ' is-collapsed' : ''}`} aria-hidden>
            <div className="agent-ws-stack-header">
              <span className="agent-ws-stack-label" />
              {workspaces.length > 1 ? (
                <button type="button" className="agent-ws-collapse-btn" tabIndex={-1} />
              ) : null}
              {workspaces.length > 0 ? (
                <button type="button" className="agent-ws-overview-btn" tabIndex={-1} />
              ) : null}
              <button type="button" className="agent-ws-add-btn" tabIndex={-1} />
            </div>
            {stackWorkspaces.map((w, i) => {
              if (i !== 0) return null;
              const row = wsStackRowProps(w.id, i);
              return (
                <div key={w.id} {...row}>
                  <div
                    className={`agent-ws-stack-item${
                      shownChatId === w.id && chatRequested ? ' is-chatting' : ''
                    }`}
                  />
                </div>
              );
            })}
            <div className={`agent-ws-stack-rest${wsCollapsed ? '' : ' is-open'}`}>
              <div className="agent-ws-stack-rest-body">
                {stackWorkspaces.map((w, i) => {
                  if (i === 0) return null;
                  const row = wsStackRowProps(w.id, i);
                  return (
                    <div key={w.id} {...row}>
                      <div
                        className={`agent-ws-stack-item${
                          shownChatId === w.id && chatRequested ? ' is-chatting' : ''
                        }`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {panelOpen && backdropBlur ? (
          <div
            className="agent-float-backdrop backdrop-blur-overlay mp-scrim"
            {...panelPresence.spread}
            data-agent-backdrop-interactive={panelReady ? 'true' : 'false'}
            aria-hidden="true"
            onPointerDown={(event) => {
              if (event.button !== 0 || event.target !== event.currentTarget) return;
              phone.controller.close();
              setChatWorkspaceId(null);
            }}
          />
        ) : null}

        {panelOpen && shownChatId ? (
          <aside
            ref={panelRef}
            className={`agent-float-panel ${panelPhaseClass}`}
            data-mp-stage={panelStage}
            style={{ ...panelStyle, ...panelActionStyle } as React.CSSProperties}
          >
            <MailEnvelopeViewport mailboxId={`orchestrator:${shownChatId}`} enabled={chatLive && !subsystemMounted} />
            <div
              className="agent-panel-resizer"
              title={t('拖拽调节面板大小')}
              onPointerDown={onPanelResizeStart}
            />
            <div className="agent-panel-body">
              <div className="agent-header">
                <div className="agent-panel-title-row">
                  <div className="agent-panel-side-left agent-panel-main-actions">
                  <button
                    type="button"
                    className="agent-chat-clear-btn agent-panel-icon-btn"
                    aria-label={t('重置')}
                    title={t('清空聊天并开始新 Pi 会话')}
                    disabled={panelBusy || !panelReady}
                    onClick={() => {
                      if (surface && shownChatId) setResetTarget({ workspaceId: shownChatId, purpose: 'dispatch', surface });
                    }}
                  >
                    <IconRefresh size={18}/>
                  </button>
                  <button type="button" ref={memoryTriggerRef} className="agent-chat-clear-btn agent-memory-toggle"
                    aria-label={t(memorySheetOpen ? '收起记忆子系统' : '打开记忆子系统')}
                    title={t('记忆子系统')} aria-expanded={memorySheetOpen} aria-controls={`agent-memory-sheet-${shownChatId}`}
                    disabled={!panelReady} onClick={toggleMemorySheet}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 5a3 3 0 0 0-5.8-1 3.5 3.5 0 0 0-3.4 5.3 4 4 0 0 0 .5 7.5 3.5 3.5 0 0 0 5.2 3.5A3 3 0 0 0 12 18V5Zm0 0a3 3 0 0 1 5.8-1 3.5 3.5 0 0 1 3.4 5.3 4 4 0 0 1-.5 7.5 3.5 3.5 0 0 1-5.2 3.5A3 3 0 0 1 12 18" />
                      <path d="M6.2 4A3 3 0 0 1 7 7m-4.2 2.3A3 3 0 0 1 6 10m-2.7 6.8A3 3 0 0 0 7 15m1.5 5.3A3 3 0 0 1 9 17m8.8-13A3 3 0 0 0 17 7m4.2 2.3A3 3 0 0 0 18 10m2.7 6.8A3 3 0 0 1 17 15m-1.5 5.3A3 3 0 0 0 15 17" />
                    </svg>
                  </button>
                  <button type="button" ref={safetyTriggerRef} className="agent-chat-clear-btn agent-memory-toggle agent-safety-toggle"
                    aria-label={safetySheetOpen ? t('收起安全子系统') : t('打开安全子系统')} title={t('安全子系统')} aria-expanded={safetySheetOpen}
                    aria-controls={`agent-safety-sheet-${shownChatId}`} disabled={!panelReady}
                    onClick={() => { if (safetySheetOpen) closeSafetySheet(true); else { closeMemorySheet(); phone.controller.close(); setSafetyOpenWorkspace(shownChatId); } }}><SafetyIcon/></button>
                  </div>
                  <SchedulerIdentity workspace={shownWs} />
                  <div className="agent-panel-tools-right">
                  <button type="button" ref={phoneTriggerRef} className="agent-chat-clear-btn agent-phone-toggle" aria-label={phone.state.open ? t('收起手机应用') : t('打开手机应用')} title={t('调度的手机')} aria-expanded={phone.state.open} disabled={!panelReady} onClick={() => { closeMemorySheet(); closeSafetySheet(); if (phone.state.open) phone.controller.close(); else phone.controller.open(); }}><PhoneIcon/></button>
                  <button
                    type="button"
                    className="agent-chat-clear-btn agent-panel-side-right agent-panel-icon-btn"
                    aria-label={t('收起')}
                    title={t('收起')}
                    disabled={!panelReady}
                    onClick={() => { phone.controller.close(); setChatWorkspaceId(null); }}
                  >
                    <IconChevronDown size={18}/>
                  </button>
                  </div>
                </div>
              </div>
              <div className="agent-panel-surfaces">
              <div ref={notesViewRef} data-agent-purpose="dispatch"
                className="agent-panel-purpose-view agent-panel-dispatch-view"
                aria-hidden={subsystemMounted}
                {...(subsystemMounted ? { inert: '' as unknown as boolean } : {})}>
                <SchedulerConversation
                  surface={surface!}
                  workspace={shownWs}
                  live={chatLive}
                  interactionActive={!subsystemMounted}
                  disabled={!panelReady || subsystemMounted}
                  notesHost={!subsystemMounted ? notesHost : undefined}
                  findEnabled={panelReady && !subsystemMounted}
                />
              </div>
              {memoryVisited[shownChatId] && memorySurface ? <div key={`memory:${shownChatId}`} className="agent-memory-sheet-host"
                hidden={!memoryPresence.mounted} data-memory-stage={memoryPresence.stage}>
                <div className="agent-memory-sheet-backdrop mp-scrim" {...memoryPresence.spread} aria-hidden="true" />
                <section ref={memorySheetRef} id={`agent-memory-sheet-${shownChatId}`} data-agent-purpose="memory"
                  className="agent-memory-sheet mp-panel" role="dialog" aria-label={t('记忆子系统')} tabIndex={-1}
                  aria-hidden={!memorySheetOpen} {...memoryPresence.spread} {...(!memorySheetOpen ? { inert: '' as unknown as boolean } : {})}>
                <header className="agent-memory-sheet-header">
                  <button type="button" className="agent-chat-clear-btn agent-panel-icon-btn" aria-label={t('重置记忆会话')}
                    title={t('清空记忆对话，不删除已保存的记忆')} disabled={memorySnap.busy || !panelReady || !memorySheetOpen}
                    onClick={() => setResetTarget({ workspaceId: shownChatId, purpose: 'memory', surface: memorySurface })}><IconRefresh size={18}/></button>
                    <h2>{t('记忆子系统')}</h2>
                  <button type="button" className="agent-chat-clear-btn agent-panel-icon-btn" aria-label={t('关闭记忆子系统')} title={t('收起')}
                      disabled={!panelReady || !memorySheetOpen} onClick={() => closeMemorySheet(true)}><IconChevronDown size={18}/></button>
                  </header>
                <MemoryCuratorView surface={memorySurface} workspaceId={shownChatId} cwd={shownWs?.path}
                  active={chatLive && memorySheetOpen}
                  disabled={!panelReady || !memorySheetOpen} />
                </section>
              </div> : null}
              <SafetyPanel key={`safety:${shownChatId}`} workspaceId={shownChatId} open={safetySheetOpen}
                presence={safetyPresence} triggerRef={safetyTriggerRef} onClose={closeSafetySheet}/>
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      {/* 栈本体：宽屏 portal 进左栏槽位（DOM 上是侧边栏的子节点——显隐/悬停语义
          随侧边栏走，不再需要 sessions-hidden 豁免与速览 z 抬升）；槽位不在
          （折叠未速览）即随侧边栏一起不存在 */}
      {!stackInline && wsStackSlot ? createPortal(wsStack, wsStackSlot) : null}

      {overviewWorkspaces && overviewPresence.mounted ? (
        <SchedulerOverview id={overviewId} open={overviewOpen} presence={overviewPresence} workspaces={overviewWorkspaces}
          selectedWorkspaceId={chatWorkspaceId ?? activeWorkspaceId}
          singleNotes={overviewSourceNotes}
          replies={schedulerReplies} markRead={replyRead.markRead}
          getWorkspaceAnchor={getOverviewAnchor}
          onClose={closeOverview} />
      ) : null}
      {phoneWorkspaceId && <AgentPhone key={phoneWorkspaceId} workspaceId={phoneWorkspaceId} workspaceName={workspaces.find(w => w.id === phoneWorkspaceId)?.name ?? t('调度')} phone={phone} anchor={panelRef} anchorReady={panelReady}/>}
      <CreateWorkspaceModal
        open={createOpen || showRequiredWorkspace}
        mode="create"
        multiFolder={!guidedCreate.current}
        guided={guidedCreate.current}
        busy={switching}
        required={showRequiredWorkspace}
        recommendedRoot={showRequiredWorkspace || guidedCreate.current ? workspaceRecommendation?.root : undefined}
        recommendedName={guidedCreate.current ? t('我的工作区') : showRequiredWorkspace ? workspaceRecommendation?.name : undefined}
        onClose={() => setCreateOpen(false)}
        onSave={async (opts) => {
          const res = await openWorkspace(opts);
          if (!res.ok) throw new Error(res.message || t('创建失败'));
          setCreateOpen(false);
        }}
      />

      <CreateWorkspaceModal
        open={!noWorkspaces && !!editWs}
        mode="edit"
        initial={
          editWs
            ? {
                id: editWs.id,
                path: editWs.path,
                name: editWs.name,
                avatar: editWs.avatar,
                roots: editWs.roots,
                defaultRootId: editWs.defaultRootId,
                controlRoot: editWs.controlRoot,
                rootsRevision: editWs.rootsRevision
              }
            : undefined
        }
        busy={switching}
        canDelete={workspaces.length > 0}
        onClose={() => setEditWs(null)}
        onOpenDependency={handleOpenDependency}
        onSave={async (opts) => {
          if (!editWs) return;
          const workspace = editWs;
          const epoch = editWsEpoch.current;
          const res = await updateWorkspace(workspace.id, {
            name: opts.name,
            avatar: opts.avatar,
            avatarAccent: opts.avatarAccent,
            ...(opts.roots ? { roots: opts.roots, defaultRootId: opts.defaultRootId, expectedRootsRevision: opts.expectedRootsRevision } : {})
          });
          if (!res.ok) throw new WorkspaceSaveError(res.message || t('保存失败'), res.rootDependencies);
          if (editWsEpoch.current === epoch && editWsRef.current === workspace) setEditWs(null);
        }}
        onDelete={async () => {
          if (!editWs) return;
          const workspace = editWs;
          const epoch = editWsEpoch.current;
          const res = await closeWorkspace(workspace.id);
          if (!res.ok) throw new Error(res.message || t('删除失败'));
          if (editWsEpoch.current === epoch && editWsRef.current === workspace) setEditWs(null);
        }}
      />
    </div>
  );
}

export const AgentFloat = React.memo(AgentFloatInner);
