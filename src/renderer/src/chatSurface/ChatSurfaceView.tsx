import { extensionSkillNamesFromMeta } from '../../../shared/composerSkills';
import { BrandLoading } from '../components/BrandLoader';
/**
 * ChatSurfaceView：统一会话视图。调度 Agent 面板与 GUI Worker 会话的
 * 会话流（ChatTranscript）+ 输入框（AgentComposer）+ 状态条 chips 全部在这里接线，
 * 只按 surface.caps 与快照渲染——两表面的行为一致由本文件单点保证（ChatSurface 合同，
 * 见 docs/plans/implemented/chat-surface-plan.md）。壳只负责自己的周边 UI 与壳级状态注入。
 * 布局：转写铺满剩余高度，输入条悬浮盖在会话流底部。
 */
import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { useTranslation } from 'react-i18next';
import { localizeKnowledgeHostText } from '../../../shared/knowledgeDisplayText';
import { localizeGuiHostError } from '../../../shared/guiHostError';
import type { ChatImageAttachment, ChatMessage } from '../../../shared/types';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import type {
  ChatModelSelection,
  ChatSurface,
  ChatSurfaceMode,
  ChatSurfaceSnapshot
} from '../../../shared/chatSurface';
import {
  dispatchTranscriptBinding,
  guiTranscriptBinding
} from './guiMessageView';
import { ChatTranscript, type TranscriptHarness } from './ChatTranscript';
import { syncChatSurfaceLayout } from './chatSurfaceLayout';
import { useSmoothComposerHeight } from './smoothComposerHeight';
import { ChatFindBar } from './ChatFindBar';
import { chatFindIdFor, useChatFind } from './useChatFind';
import { currentSuggestedReplies, type ComposerReplySuggestions } from './currentSuggestedReplies';
import { findAskQuestionAnchor } from '../../../shared/orchestratorAskQuestion';
import { UI_FOLLOWUP_EVENT, type UiFollowupDetail } from './uiWidgetEvents';
import { AgentComposer, type ComposerPresetItem } from '../components/AgentComposer';
import { guiSkillTargetForRuntime } from '../../../shared/capabilityManagement';
import { guiPermissionOptions } from '../../../shared/guiPermissionOptions';
import { NativeSessionConfigControl } from '../components/NativeSessionConfig';
import { useSessionPermissionConfiguration } from '../components/PermissionConfiguration';
import { useRuntimesStore, useSessionStore, useUiActionsStore, useWorkspaceStore } from '../store';
import { handleChatFileLink } from './onFileLink';
import { ChatLinkBoundary } from './ChatLinkBoundary';
import type { SessionNotesHost } from './useSessionNotes';
import type { ChatAvatarContext } from '../../../shared/userAvatar';
import { useInterruptedTurnGuard } from './useInterruptedTurnGuard';
import { TurnSnapshotVisibilityProvider } from './TurnSnapshotVisibility';
import { SessionReminders } from '../components/SessionReminders';
import { workerRoutingScope, workerRoutingScopeForSession } from '../components/workerRouting/workerRoutingScope';
import { isWebGateway } from '../webGatewayEnvironment';
import { ModelRequestsDialog } from '../agentChat/ModelRequestsDialog';
import { ModelRequestRecordingShortcut, useModelRequestViewer } from '../agentChat/ModelRequestRecording';

export function ChatSurfaceView(props: {
  surface: ChatSurface;
  cwd?: string;
  workspaceId?: string;
  /** 消息列表上方常驻内容（空态欢迎语 / 失忆提示等，壳层给） */
  header?: React.ReactNode;
  /** Test/host-only replacement hook; purpose surfaces use the standard composer. */
  composerOverride?: React.ReactNode;
  className?: string;
  /** false = 冻结最后一份实况（面板退出动画期间不再跟流） */
  live?: boolean;
  /** 常驻保活的壳隐藏时，取消只属于当前交互现场的确认。 */
  interactionActive?: boolean;
  /** 输入条禁用（面板进场动画期间等） */
  disabled?: boolean;
  /** Display a recorded conversation while keeping scroll and tool-card expansion interactive. */
  replayKey?: number;
  /** 调度面板本地斜杠命令（/status /help /bind…）；GUI 会话不需要 */
  onLocalCommand?: (
    kind: 'status' | 'statusVerbose' | 'stop' | 'help' | 'bind' | 'unbind',
    extra?: string
  ) => void;
  /** 批注宿主侧（caps.notes 时由壳经 useSessionNotes 注入：GUI=AgentChatView，调度=AgentFloat） */
  notesHost?: SessionNotesHost;
  /**
   * 覆盖输入条发送（T5.6 手机一键处置：GUI 文本回复走邮箱存信）。
   * 不传则走 surface.actions.send。带图时调用方应自行回落到 send。
   */
  onSend?: (
    text: string,
    images?: ChatImageAttachment[]
  ) => void | Promise<unknown>;
  /** 本表面是否接收 Ctrl+F（GUI=会话可见；调度=面板打开） */
  findEnabled?: boolean;
  /** Harness 透明标注（GUI 会话壳注入；不传不渲染任何标注——现状零变化） */
  harness?: TranscriptHarness;
  /** The dedicated memory curator has a separate, restricted conversation. */
  remindersEnabled?: boolean;
  /** Recording owner for chat surfaces with a host-observable model transport. */
  modelRequestSessionId?: string;
}): React.JSX.Element {
  const surface = props.surface;
  const replaying = props.replayKey !== undefined;
  const transcriptId = replaying ? `replay:${props.replayKey}:${surface.sessionId}` : surface.sessionId;
  const caps = surface.caps;
  const snap = useSyncExternalStore(surface.subscribe, surface.getSnapshot);
  // 冻结：面板退出动画期间渲染最后一份实况（不跟流），回实况时自动续上
  const frozenRef = useRef(snap);
  if (props.live !== false) frozenRef.current = snap;
  const s = props.live === false ? frozenRef.current : snap;

  const store = useUiActionsStore();
  const { workspaces } = useWorkspaceStore();
  const { sessions, activeId } = useSessionStore();
  const { runtimes } = useRuntimesStore();
  const { t } = useTranslation();
  const gui = caps.surfaceKind === 'gui-session';
  const interrupted = useInterruptedTurnGuard(surface, props.live !== false && props.interactionActive !== false && !props.disabled);
  const avatarWorkspace = props.workspaceId ? workspaces.find((w) => w.id === props.workspaceId) : undefined;
  const avatarSession = sessions.find((session) => session.id === surface.sessionId);
  const encodedSkillNames = avatarSession?.meta?.extensionSkillNames;
  const extensionSkillNames = useMemo(() => extensionSkillNamesFromMeta(encodedSkillNames), [encodedSkillNames]);
  const avatarRuntime = avatarSession?.runtime ? runtimes.find((runtime) => runtime.id === avatarSession.runtime) : undefined;
  // 全表心跳/后台会话状态不改变本会话头像；依赖只包含实际展示字段。
  const avatarContext = useMemo<ChatAvatarContext>(() => ({
      surfaceKind: caps.surfaceKind,
      workspaceAvatar: avatarWorkspace?.avatar,
      workspaceName: avatarWorkspace?.name,
      runtimeId: avatarSession?.runtime,
      runtimeLabel: avatarRuntime?.label,
      sessionName: avatarSession?.name
  }), [
    caps.surfaceKind,
    avatarWorkspace?.avatar,
    avatarWorkspace?.name,
    avatarSession?.runtime,
    avatarRuntime?.label,
    avatarSession?.name
  ]);
  const [surfaceNode, setSurfaceNode] = useState<HTMLDivElement | null>(null);
  const setSurfaceNodeRef = useCallback((el: HTMLDivElement | null) => {
    setSurfaceNode(el);
  }, []);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const requestSessionId = replaying ? undefined : props.modelRequestSessionId;
  const recordingActive = props.interactionActive !== false && props.live !== false && !props.disabled;
  const requestViewer = useModelRequestViewer(recordingActive ? requestSessionId : undefined);
  const recordingVisible = requestViewer.recording.enabled === true;
  const requestShortcut = useMemo(() => requestSessionId ? <ModelRequestRecordingShortcut visible={recordingVisible} onOpen={requestViewer.show} /> : null,
    [requestSessionId, recordingVisible, requestViewer.show]);
  const focusComposer = useCallback(() => {
    composerWrapRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
  }, []);
  // 输入条高度弹簧（2026-10-31）：内容高度变化经弹簧逐帧写 wrap 显式 height，
  // 建议回复轮次变化时先按自然高度定位；其他高度变化由 RO 联动平滑让位。
  const replySuggestions = useMemo(
    () => currentSuggestedReplies(s.messages, s.busy, caps.surfaceKind),
    [s.messages, s.busy, caps.surfaceKind]
  );
  useSmoothComposerHeight(composerWrapRef, props.interactionActive !== false && props.live !== false, replySuggestions?.messageId);

  // 输入条悬浮盖在转写上：只量 wrap 高度写入 --composer-overlay-h，
  // 转写 padding-bottom / 跳底按钮让位（避免末条被挡）。
  // 左右对齐不再量 .agent-chat-col：调度浮窗进场带 scale，getBoundingClientRect
  // 会把视口坐标写进 left/width，动画结束 RO 不触发，输入框永久偏左。
  // 列对齐改走 CSS（--chat-col-inset + --chat-col-max + margin:auto），与消息列同约束。
  // 同效应顺带实测滚动条槽宽写入 --chat-sb：thin 槽宽随引擎/系统变，CSS 写死
  // （旧 right:8px）必错位；offsetWidth-clientWidth 即 stable 常驻槽实宽。
  // 布局抖动防护：与内联样式现值相同就不 setProperty。不能把量算挪进 rAF：
  // RO 在渲染步骤里晚于 rAF 触发，挂进下一帧会让 padding 晚一帧——滚底时
  // 最后一条会被长高的输入条瞬挡一下。
  useLayoutEffect(() => {
    const wrap = composerWrapRef.current;
    const root = surfaceNode;
    if (!wrap || !root) return;
    const apply = (): void => syncChatSurfaceLayout(root);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--composer-overlay-h');
    };
  }, [surfaceNode]);

  // 排队消息不进聊天流：统一排队面板（composer 上方）是它们唯一的展示/管理入口，
  // 真正发出（queued 标记被主进程摘掉）后才以普通消息出现在这里。
  const transcriptMessages = useMemo(
    () => s.messages.filter((m) => !(m as { queued?: boolean }).queued),
    [s.messages]
  );
  const openReminderSource = useCallback((messageId: string): boolean => {
    if (!transcriptMessages.some(message => (message as { id?: string }).id === messageId)) return false;
    const list = surfaceNode?.querySelector<HTMLElement>('.chat-list');
    if (!list) return false;
    list.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: messageId }));
    return true;
  }, [surfaceNode, transcriptMessages]);

  const find = useChatFind({
    enabled: props.findEnabled !== false,
    surfaceKind: caps.surfaceKind,
    sessionId: surface.sessionId,
    sessionName:
      avatarContext.sessionName ||
      (caps.surfaceKind === 'dispatch'
        ? t('调度')
        : avatarContext.workspaceName || t('会话')),
    workspaceId: props.workspaceId,
    messages: transcriptMessages as ChatMessage[],
    historyIncomplete: !!s.page && s.page.total > s.messages.length,
    messageSlots: s.page?.slots,
    sessions,
    runtimes,
    surfaceEl: surfaceNode
  });
  const myFindId = chatFindIdFor(caps.surfaceKind, surface.sessionId);
  const ownFindHit =
    find.isOwner && find.activeHit && find.activeHit.sessionId === myFindId
      ? find.activeHit
      : null;
  const findMessageId = ownFindHit?.messageId ?? null;
  const findIndexInMessage = ownFindHit?.indexInMessage ?? null;
  // 状态条/父层刷新不改变命中身份，不应重刷整篇 mark 或重启在途导航。
  const findActiveForTranscript = useMemo(
    () => findMessageId !== null && findIndexInMessage !== null
      ? { messageId: findMessageId, indexInMessage: findIndexInMessage }
      : null,
    [findMessageId, findIndexInMessage]
  );

  // 依赖逐个方法而非整个 store：uiSlice 对象混有 confirms/dialogs 等状态值，任何
  // UI 态一变引用就换，onFileLink 跟着重建 → ChatMessageView 整列 memo 被击穿
  // （2026-09-14 性能专项实测：一次点击转录重渲 13-22 次）。两个方法本身是稳定
  // useCallback（store.tsx，依赖只有 flashTip/t），拿住它们身份即可。
  const requestOpenWorkspaceFile = store.requestOpenWorkspaceFile;
  const flashTip = store.flashTip;
  const onFileLink = useCallback(
    (href: string) => {
      void handleChatFileLink(href, {
        cwd: props.cwd,
        requestOpenWorkspaceFile: args => requestOpenWorkspaceFile({ ...args, scope: 'session', ownerWorkspaceId: props.workspaceId, ownerSessionId: gui ? surface.sessionId : activeId ?? undefined }),
        flashTip,
        t
      });
    },
    [props.cwd, props.workspaceId, gui, surface.sessionId, activeId, requestOpenWorkspaceFile, flashTip, t]
  );

  // 模型绑定：GUI=GuiChatMessage 全量语义；调度=ChatMessage 原生 + 链接化
  const guiBinding = useMemo(
    () => guiTranscriptBinding(surface.sessionId),
    [surface.sessionId]
  );
  const dispatchBinding = useMemo(
    () => dispatchTranscriptBinding(surface.sessionId),
    [surface.sessionId]
  );

  const status = s.status;
  const setModelParameter = surface.actions.setModelParameter;
  const onModelParameterChange = useCallback((id: string, value: string | null) => {
    void setModelParameter?.(id, value).then(r => { if (!r.ok && r.error) flashTip(r.error); });
  }, [setModelParameter, flashTip]);
  const setThinking = surface.actions.setThinking;
  const onThinkingChange = useCallback(
    (level: string | null) => {
      if (!setThinking) return;
      void setThinking(level).then((r) => {
        if (!r.ok && r.error) flashTip(r.error);
      });
    },
    [setThinking, flashTip]
  );
  const thinking = useMemo(
    () =>
      status?.thinking && status.thinking.available && setThinking
        ? { level: status.thinking.level, levels: status.thinking.levels, onChange: onThinkingChange }
        : undefined,
    [status?.thinking?.level, status?.thinking?.available, status?.thinking?.levels, setThinking, onThinkingChange]
  );

  const setModel = surface.actions.setModel;
  const onModelConfiguration = surface.actions.setModelConfiguration;
  const onModelSwitched = surface.actions.onModelSwitched;
  const reloadCodexCatalog = surface.actions.reloadCodexCatalog;
  const reloadHarnessCatalog = surface.actions.reloadHarnessCatalog;
  const refreshHarnessModelState = surface.actions.refreshHarnessModelState;
  const onModelChange = useCallback(
    (m: ChatModelSelection | null) => setModel?.(m),
    [setModel]
  );
  const onModelSwitchedCb = useCallback(() => {
    onModelSwitched?.();
  }, [onModelSwitched]);
  const onReloadCodexCatalog = useCallback(() => {
    return reloadCodexCatalog?.();
  }, [reloadCodexCatalog]);
  const onReloadHarnessCatalog = useCallback(() => reloadHarnessCatalog?.(), [reloadHarnessCatalog]);
  const onRefreshHarnessModelState = useCallback(() => refreshHarnessModelState?.(), [refreshHarnessModelState]);

  /** Composer 状态条数据面（模型按钮/用量环/思考档）——动作接线到 surface */
  const chatStatus = useMemo(
    () =>
      status
        ? {
            modelLabel: status.modelLabel,
            providerId: status.providerId,
            modelId: status.modelId,
            modelPinned: status.modelPinned,
            modelPickerTarget: onModelConfiguration ? caps.modelPickerTarget ?? (gui ? { sessionId: surface.sessionId } : { dispatch: { workspaceId: props.workspaceId ?? surface.sessionId } }) : undefined,
            onModelConfiguration,
            codexModelCatalog: status.codexModelCatalog,
            harnessModelCatalog: status.harnessModelCatalog,
            harnessModelSelection: status.harnessModelSelection,
            modelCatalogWarning: status.modelCatalogWarning,
            modelParams: status.modelParams,
            modelParameters: status.modelParameters,
            onModelParameterChange,
            usage: status.usage,
            title: status.usageTitle,
            thinking,
            onModelChange,
            onModelSwitched: onModelSwitchedCb,
            onReloadCodexCatalog,
            onReloadHarnessCatalog,
            onRefreshHarnessModelState
          }
        : undefined,
    [
      status?.modelLabel,
      status?.providerId,
      status?.modelId,
      status?.modelPinned,
      onModelConfiguration,
      gui,
      surface.sessionId,
      props.workspaceId,
      status?.codexModelCatalog,
      status?.harnessModelCatalog,
      status?.harnessModelSelection,
      status?.modelCatalogWarning,
      status?.modelParams,
      status?.modelParameters,
      onModelParameterChange,
      status?.usage,
      status?.usageTitle,
      thinking,
      onModelChange,
      onModelSwitchedCb,
      onReloadCodexCatalog,
      onReloadHarnessCatalog,
      onRefreshHarnessModelState
    ]
  );

  const loadPresetRoster = surface.actions.loadPresetRoster;
  const changePreset = surface.actions.changePreset;
  const onPresetChange = useCallback((id: string) => changePreset?.(id), [changePreset]);
  const loadRoster = useCallback(
    (): Promise<ComposerPresetItem[] | null> =>
      (loadPresetRoster?.() ?? Promise.resolve(null)) as Promise<ComposerPresetItem[] | null>,
    [loadPresetRoster]
  );
  const presetId = s.preset?.id;
  const presetLocked = s.preset?.locked;
  const preset = useMemo(
    () =>
      caps.presets && presetId != null && loadPresetRoster && changePreset
        ? {
            id: presetId,
            locked: !!presetLocked,
            title: caps.presetLabels?.title ?? t('模式：选择本次对话的自定义模式（创造模式可现场创作）'),
            lockedTitle: caps.presetLabels?.lockedTitle ?? t('对话开始后模式锁定，不可中途切换'),
            lockedNote: caps.presetLabels?.lockedNote ?? t('对话开始后模式锁定，不可中途切换'),
            loadRoster,
            onChange: onPresetChange
          }
        : undefined,
    [
      caps.presets,
      caps.presetLabels,
      presetId,
      presetLocked,
      loadPresetRoster,
      changePreset,
      loadRoster,
      onPresetChange,
      t
    ]
  );

  const expandForSend = props.notesHost?.expandForSend;
  const expandText = useCallback(
    (text: string): string => (expandForSend ? expandForSend(text) : text),
    [expandForSend]
  );
  const sendNowAction = surface.actions.sendNow;
  const onSendNow = useCallback(
    (text: string) => sendNowAction!(expandText(text)),
    [sendNowAction, expandText]
  );
  const editQueuedAction = surface.actions.editQueued;
  const onEditQueued = useCallback(
    (id: string, text: string) => editQueuedAction?.(id, text),
    [editQueuedAction]
  );
  const reorderQueuedAction = surface.actions.reorderQueued;
  const onReorderQueued = useCallback(
    (ids: string[]) => reorderQueuedAction?.(ids),
    [reorderQueuedAction]
  );
  const setModeAction = surface.actions.setMode;
  const onModeChange = useCallback(
    (m: ChatSurfaceMode) => setModeAction?.(m),
    [setModeAction]
  );
  const sendAction = surface.actions.send;
  const onSendProp = props.onSend;
  const onSendResolved = useCallback(
    async (text: string, images?: ChatImageAttachment[]) => {
      if (!await interrupted.confirm()) return false;
      return onSendProp ? onSendProp(text, images) : sendAction(text, images);
    },
    [onSendProp, sendAction, interrupted.confirm]
  );
  const onSend = useCallback(
    async (text: string, images?: ChatImageAttachment[]) => {
      if (!await interrupted.confirm()) return false;
      const expanded = expandText(text);
      if (onSendProp) return onSendProp(expanded, images);
      return sendAction(expanded, images);
    },
    [expandText, onSendProp, sendAction, interrupted.confirm]
  );
  const compactAction = surface.actions.compact;
  const onCompact = useCallback(
    (instructions?: string) => compactAction!(instructions),
    [compactAction]
  );
  const planAction = surface.actions.planAction;
  const onPlanAction = useCallback(
    (action: 'execute' | 'abandon' | 'revise', feedback?: string) => {
      planAction?.(action, feedback);
    },
    [planAction]
  );
  const forkAction = surface.actions.fork;
  const onFork = useCallback(
    (messageId: string) => {
      forkAction?.(messageId);
    },
    [forkAction]
  );
  const bgTasks = useMemo(
    () =>
      caps.bgTasks
        ? { sessionId: surface.sessionId, cwd: props.cwd, workspaceId: props.workspaceId }
        : undefined,
    [caps.bgTasks, surface.sessionId, props.cwd, props.workspaceId]
  );
  const modeSwitchLockedTitle = t('当前回合进行中，切档会中断回合；请等回合结束再切');

  const requestComposerInsert = store.requestComposerInsert;
  const draftKey = caps.draftKey;
  const recallAbortedAction = surface.actions.recallAborted;
  const recallInFlightRef = useRef(false);
  const onEditAborted = useCallback(
    (messageId: string) => {
      if (!recallAbortedAction || recallInFlightRef.current) return;
      recallInFlightRef.current = true;
      void interrupted.confirm(messageId).then(allow => allow ? recallAbortedAction(messageId) : null)
        .then((res) => {
          if (!res?.ok) {
            if (res?.error) flashTip(res.error);
            return;
          }
          requestComposerInsert(res.text ?? '', {
            target: draftKey,
            replace: false,
            images: res.images
          });
        })
        .catch(error => flashTip(String(error)))
        .finally(() => {
          recallInFlightRef.current = false;
        });
    },
    [recallAbortedAction, requestComposerInsert, draftKey, flashTip, interrupted.confirm]
  );
  // ── ma-ui 部件 followup 回填（M5）：iframe 部件请求把文本填进会话输入框 ──
  // UiWidgetCard 收到部件桥的 followup 动作后派发全局事件（detail 带卡片元素），
  // 回填追加到草稿；显式发送动作经宿主确认后复用当前表面的发送入口。
  // 只处理落在自己表面内的卡片——多表面同时挂载时不会把文本串进别的草稿。
  React.useEffect(() => {
    const onFollowup = (e: Event): void => {
      const detail = (e as CustomEvent<UiFollowupDetail>).detail;
      if (!detail || typeof detail.text !== 'string' || !detail.text) return;
      if (detail.sessionId && detail.sessionId !== surface.sessionId) return;
      if (detail.el && (!surfaceNode || !surfaceNode.contains(detail.el))) return;
      if (detail.claim && !detail.claim()) return;
      if (detail.mode === 'send') {
        void Promise.resolve(onSend(detail.text)).then(sent => {
          detail.respond?.({ ok: sent !== false, error: sent === false ? t('消息未发送，请稍后重试') : undefined, type: 'followup' });
        }).catch(error => detail.respond?.({ ok: false, error: String(error.message) }));
      } else {
        requestComposerInsert(detail.text, { target: draftKey, replace: false });
        detail.respond?.({ ok: true, type: 'followup' });
      }
    };
    window.addEventListener(UI_FOLLOWUP_EVENT, onFollowup);
    return () => window.removeEventListener(UI_FOLLOWUP_EVENT, onFollowup);
  }, [surfaceNode, surface.sessionId, requestComposerInsert, draftKey, onSend, t]);

  const pendingSingleQuestion = useMemo(() => {
    if (caps.surfaceKind !== 'dispatch') return false;
    const question = findAskQuestionAnchor(s.messages as readonly ChatMessage[])?.userQuestion;
    return question?.status === 'pending' && question.questions.length === 1;
  }, [caps.surfaceKind, s.messages]);
  const nativeSettings = gui && !!avatarSession?.runtime && avatarSession.runtime !== 'pi';
  const permissionConfiguration = useSessionPermissionConfiguration(gui ? surface.sessionId : undefined, avatarSession?.configurePermissions);
  const permissionChoices = useMemo(() => gui && avatarSession?.runtime === 'pi'
    ? guiPermissionOptions(avatarSession.runtime, s.mode ?? undefined)
    : undefined, [gui, avatarSession?.runtime, s.mode]);
  const permissionView = useMemo(() => {
    // caps.modeOrder 显式为空 = 会话固定档位（扩展侧栏 standard）：运行时权限选项不得复活选择器
    if (caps.modeOrder !== undefined && caps.modeOrder.length === 0) {
      return { order: caps.modeOrder, labels: {}, descriptions: {}, disabled: {} };
    }
    const order = permissionChoices?.map(option => option.mode) ?? caps.modeOrder;
    return {
      order: s.mode && order && !order.includes(s.mode) ? [...order, s.mode] : order,
      labels: permissionChoices ? { ...caps.modeLabels,
        ...Object.fromEntries(permissionChoices.map(option => [option.mode, option.label])) } : caps.modeLabels,
      descriptions: permissionChoices ? { ...caps.modeDescriptions,
        ...Object.fromEntries(permissionChoices.map(option => [option.mode, option.description])) } : caps.modeDescriptions,
      disabled: permissionChoices ? Object.fromEntries(permissionChoices.filter(option => option.disabled || option.legacy)
        .map(option => [option.mode, true])) : caps.modeDisabled
    };
  }, [permissionChoices, caps.modeOrder, caps.modeLabels, caps.modeDescriptions, caps.modeDisabled, s.mode]);
  const onClearReplySuggestions = useCallback((snapshot: ComposerReplySuggestions) => window.api.suggestions.clear({
    kind: caps.surfaceKind === 'dispatch' ? 'dispatch' : 'gui',
    targetId: caps.surfaceKind === 'dispatch' ? caps.draftKey : surface.sessionId,
    messageId: snapshot.messageId, replies: snapshot.replies
  }), [caps.surfaceKind, caps.draftKey, surface.sessionId]);
  const permissionChangeRef = useRef(permissionConfiguration.change);
  permissionChangeRef.current = permissionConfiguration.change;
  const onPermissionChange = useCallback((enabled: boolean) => { void permissionChangeRef.current(enabled); }, []);
  const permissionControl = useMemo(() => gui && !nativeSettings ? {
    enabled: permissionConfiguration.enabled,
    disabled: props.disabled || props.live === false || permissionConfiguration.saving,
    onChange: onPermissionChange
  } : undefined, [gui, nativeSettings, permissionConfiguration.enabled, permissionConfiguration.saving, props.disabled, props.live, onPermissionChange]);
  // reminders 作为 AgentComposer 的 prop 参与 React.memo 浅比较：内联 JSX 每次父渲染都新建引用，
  // message-only 更新（新 snapshot）会让 Composer 白渲染一次。缓存 element，回调经 ref 转发，
  // 依赖只含稳定项，避免被 transcriptMessages 派生的 openReminderSource 反复击穿。
  const openReminderSourceRef = useRef(openReminderSource);
  openReminderSourceRef.current = openReminderSource;
  const remindersNode = useMemo(() => props.remindersEnabled !== false ? <SessionReminders
    kind={gui ? 'session' : 'scheduler'} id={gui ? surface.sessionId : (props.workspaceId ?? surface.sessionId)}
    visible={props.interactionActive !== false && props.live !== false && !props.disabled}
    onOpenSource={(messageId: string) => openReminderSourceRef.current(messageId)} /> : null,
    [props.remindersEnabled, gui, surface.sessionId, props.workspaceId, props.interactionActive, props.live, props.disabled]);
  const composer = (
    <AgentComposer
      workspaceId={props.workspaceId ?? surface.sessionId}
      workerRoutingScope={props.remindersEnabled === false || isWebGateway() ? undefined : gui
        ? workerRoutingScopeForSession(avatarWorkspace, avatarSession)
        : s.status?.workerRoutingScope ?? workerRoutingScope(avatarWorkspace)}
      reminders={remindersNode}
      requestRecordingShortcut={requestShortcut}
      permissionConfiguration={permissionControl}
      nativeSettings={nativeSettings ? <NativeSessionConfigControl key={surface.sessionId}
        sessionId={surface.sessionId} busy={s.busy} disabled={props.disabled || props.live === false}
        configuration={{ enabled: permissionConfiguration.enabled, disabled: permissionConfiguration.saving,
          onChange: enabled => void permissionConfiguration.change(enabled) }} /> : undefined}
      draftKey={caps.draftKey}
      interactionActive={props.interactionActive !== false && props.live !== false && !props.disabled}
      extensionSkillNames={extensionSkillNames}
      extensionTask={!!avatarSession?.meta?.extensionTask}
      surfaceKind={caps.surfaceKind}
      harnessId={gui && avatarSession?.runtime
        ? avatarSession.runtime === 'pi' ? 'muster-core'
          : avatarSession.runtime === 'acp' ? s.status?.harnessModelCatalog?.agentId || avatarSession.piModeId || 'acp'
            : avatarSession.runtime
        : undefined}
      skillTarget={caps.surfaceKind === 'dispatch' ? 'pi-dispatcher' : guiSkillTargetForRuntime(avatarContext.runtimeId, runtimes)}
      allowImages={caps.images !== false}
      plusMenu={caps.plusMenu}
      busy={s.busy}
      replySuggestions={replySuggestions}
      pendingQuestion={pendingSingleQuestion}
      onClearReplySuggestions={onClearReplySuggestions}
      disabled={props.disabled}
      queuedItems={s.queuedItems}
      onCancelQueued={surface.actions.cancelQueued}
      onSendNow={sendNowAction ? onSendNow : undefined}
      onSendNowFallback={gui ? surface.actions.sendNowFallback : undefined}
      onEditQueued={editQueuedAction ? onEditQueued : undefined}
      onReorderQueued={reorderQueuedAction ? onReorderQueued : undefined}
      getQueuedImages={surface.actions.getQueuedImages}
      bgTasks={bgTasks}
      chatStatus={chatStatus}
      preset={preset}
      mode={nativeSettings ? undefined : gui && !permissionConfiguration.enabled ? 'auto' : s.mode ?? undefined}
      onModeChange={!nativeSettings && (!gui || permissionConfiguration.enabled) && setModeAction ? onModeChange : undefined}
      modeOrder={permissionView.order}
      modeChipLabels={permissionView.labels as Partial<Record<ChatSurfaceMode, string>> | undefined}
      modeDescriptions={permissionView.descriptions}
      modeDisabled={permissionView.disabled}
      modeSwitchLocked={!!caps.modeLockOnBusy && s.busy}
      modeSwitchLockedTitle={modeSwitchLockedTitle}
      engineSlashCommands={s.engineSlashCommands}
      onSend={onSend}
      onStop={surface.actions.stop}
      onClear={surface.actions.clear}
      onCompact={caps.manualCompact && compactAction ? onCompact : undefined}
      onRecordRequests={recordingActive && requestSessionId ? requestViewer.open : undefined}
      onLocalCommand={props.onLocalCommand}
      onValueChange={props.notesHost?.onValueChange}
      prepareManualDraft={props.notesHost?.prepareManualDraft}
      restoreManualDraft={props.notesHost?.restoreManualDraft}
      onSendResolved={onSendResolved}
      onSendNowResolved={sendNowAction}
      noteTokens={props.notesHost?.tokens}
      onNoteTokenClick={props.notesHost?.onTokenClick}
      onNoteTokenDelete={props.notesHost?.onTokenDelete}
    />
  );

  const forkProps = caps.fork && forkAction ? { onFork } : {};
  const editAbortedProps = recallAbortedAction ? { onEditAborted } : {};
  const notesHost = props.notesHost;
  const notesEnabled = !!(caps.notes && notesHost);
  const selArea = notesEnabled ? 'gui-chat' : 'agent-chat';
  const noteTranscriptProps =
    notesEnabled && notesHost
      ? {
          notes: notesHost.notes,
          pendingNote: notesHost.pendingNote,
          openNoteId: notesHost.openNoteId,
          onOpenNote: notesHost.onOpenNote,
          onNoteUpdate: notesHost.onNoteUpdate,
          onNoteDelete: notesHost.onNoteDelete,
          onPendingConfirm: notesHost.onPendingConfirm,
          onPendingCancel: notesHost.onPendingCancel
        }
      : {};
  const transcript = (isGui: boolean): React.JSX.Element =>
    isGui ? (
      <ChatTranscript<GuiChatMessage>
        model={guiBinding}
        interactionActive={props.interactionActive !== false && props.live !== false && !props.disabled}
        messages={transcriptMessages as readonly GuiChatMessage[]}
        busy={s.busy}
        page={s.page}
        hasEarlier={s.historyHasEarlier}
        onLoadEarlier={surface.actions.loadEarlier}
        onEnsureMessageLoaded={surface.actions.ensureMessageLoaded}
        onVirtualWindow={surface.actions.retainPageWindow}
        messageIndex={surface.actions.messageIndex}
        sessionId={transcriptId}
        replaying={replaying}
        cwd={props.cwd}
        workspaceId={props.workspaceId}
        avatarContext={avatarContext}
        header={props.header}
        selArea={selArea}
        onRetry={surface.actions.retry}
        onCancelQueued={surface.actions.cancelQueued}
        onPlanAction={planAction ? onPlanAction : undefined}
        mode={s.mode}
        onFileLink={onFileLink}
        compactions={s.compactions}
        findQuery={find.isOwner ? find.query : ''}
        findActive={findActiveForTranscript}
        harness={props.harness}
        {...forkProps}
        {...editAbortedProps}
        {...noteTranscriptProps}
      />
    ) : (
      <ChatTranscript<ChatMessage>
        model={dispatchBinding}
        interactionActive={props.interactionActive !== false && props.live !== false && !props.disabled}
        messages={transcriptMessages as readonly ChatMessage[]}
        busy={s.busy}
        page={s.page}
        hasEarlier={s.historyHasEarlier}
        onLoadEarlier={surface.actions.loadEarlier}
        onEnsureMessageLoaded={surface.actions.ensureMessageLoaded}
        onVirtualWindow={surface.actions.retainPageWindow}
        messageIndex={surface.actions.messageIndex}
        sessionId={surface.sessionId}
        cwd={props.cwd}
        workspaceId={props.workspaceId}
        avatarContext={avatarContext}
        header={props.header}
        selArea={selArea}
        onRetry={surface.actions.retry}
        onCancelQueued={surface.actions.cancelQueued}
        onPlanAction={planAction ? onPlanAction : undefined}
        mode={s.mode}
        onFileLink={onFileLink}
        compactions={s.compactions}
        findQuery={find.isOwner ? find.query : ''}
        findActive={findActiveForTranscript}
        {...forkProps}
        {...editAbortedProps}
        {...noteTranscriptProps}
      />
    );

  return (
    <div
      ref={setSurfaceNodeRef}
      className={`chat-surface-view${props.className ? ` ${props.className}` : ''}`}
    >
      {s.historyLoading ? <BrandLoading>{t('正在读取历史消息…')}</BrandLoading> : s.historyError ? <p role="alert">{localizeKnowledgeHostText(localizeGuiHostError(s.historyError))}</p> : null}
      <ChatLinkBoundary cwd={props.cwd} workspaceId={props.workspaceId} sessionId={gui ? surface.sessionId : activeId ?? undefined}
        active={props.interactionActive !== false && props.live !== false && !props.disabled}
        onFileLink={onFileLink} flashTip={flashTip} showWorkspace={store.requestShowWorkspace}>
        <TurnSnapshotVisibilityProvider owner={{ kind: gui ? 'gui' : 'dispatch', id: surface.sessionId }} messages={transcriptMessages as readonly (GuiChatMessage | ChatMessage)[]}
          active={props.interactionActive !== false && props.live !== false && !props.disabled && !replaying}>
          {transcript(gui)}
        </TurnSnapshotVisibilityProvider>
      </ChatLinkBoundary>
      {interrupted.dialog}
      {requestSessionId && <ModelRequestsDialog key={requestSessionId} sessionId={requestSessionId} open={requestViewer.isOpen}
        onClose={requestViewer.close} compact={caps.manualCompact ? compactAction : undefined}
        recording={requestViewer.recording} focusComposer={focusComposer} />}
      {props.findEnabled !== false ? (
        <ChatFindBar
          open={find.isOwner}
          query={find.query}
          onQueryChange={find.setQuery}
          matchIndex={find.activeIndex}
          matchTotal={find.hits.length}
          onPrev={() => find.go(-1)}
          onNext={() => find.go(1)}
          onClose={find.close}
          scope={find.scope}
          onToggleScope={find.toggleScope}
          groups={find.groups}
          activeHit={find.activeHit}
          onJumpHit={find.jumpToHit}
          focusEpoch={find.focusEpoch}
          failedSessions={find.failedSessions}
          truncated={find.truncated}
        />
      ) : null}
      <div className="agent-chat-composer-wrap" ref={composerWrapRef} {...(replaying ? { inert: '' } : {})}>
        {props.composerOverride ?? composer}
      </div>
    </div>
  );
}

const NULL_SNAPSHOT: ChatSurfaceSnapshot = {
  messages: [],
  busy: false,
  queuedCount: 0,
  queuedItems: [],
  status: null,
  mode: null,
  preset: null
};
const nullSubscribe = (): (() => void) => () => void 0;

/** 壳层读 surface 快照的低频入口（气泡按钮/本地命令等；消息热区仍归 ChatTranscript） */
export function useChatSurfaceSnapshot(surface: ChatSurface | null): ChatSurfaceSnapshot {
  return useSyncExternalStore(
    surface ? surface.subscribe : nullSubscribe,
    () => surface?.getSnapshot() ?? NULL_SNAPSHOT
  );
}
