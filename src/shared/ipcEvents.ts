import type {
  AgentContextEvent,
  AgentDoneEvent,
  AgentHistoryEvent,
  AgentRuntimeEntry,
  AgentStatus,
  AgentThinkingEvent,
  AgentTokenEvent,
  AgentToolEvent,
  ChatMessage,
  FsChangedPayload,
  PtyDataEvent,
  PtyExitEvent,
  SessionMeta,
  WorkspaceInfo
} from './types';
import type { UiDialogRequest } from './uiDialog';
import type { ThemesChangedPayload } from './theme';
import type { GuiWorkerPush } from './guiWorker';
import type { AppLocale } from './i18n';
import type { UpdaterStatus } from './updater';
import type { BootResult } from './boot';

/** 主进程 → 渲染层推送事件。白名单与 payload 从此表推导。 */
export type IpcEventMap = {
  'boardTodos:changed': Record<string, never>;
  'sessionReminders:changed': import('./sessionReminders').SessionReminderTarget;
  'workerRouting:changed': import('./workerRouting').WorkerRoutingChanged;
  'feedback:changed': Record<string, never>;
  'agentApps:operation': import('./agentApps').AppOperation;
  'agentApps:changed': import('./agentApps').AppChanged;
  'agentApps:feishuStatus': import('./agentApps').AppFeishuStatus;
  'memoryCurator:changed': import('./memoryCurator').MemoryCuratorSnapshot;
  'safety:changed': import('./safety').SafetySnapshot;
  'uiWidget:changed': import('./uiWidgetProtocol').UiWidgetSnapshot;
  'uiWidget:updated': { path: string; artifactVersion: number };
  'uiWidget:present': { sessionId: string; tabId: string };
  'uiWidget:draft': { sessionId: string; text: string };
  'pty:data': PtyDataEvent;
  'pty:exit': PtyExitEvent;
  'pty:respawn': { sessionId: string };
  'sessions:changed': { sessions: SessionMeta[]; activeId: string | null };
  /** 邮箱索引/回执变化，不触发收发动画。 */
  'messages:changed': { at: number };
  /** 新信成功保存后的瞬态展示；不重放历史，不代表已读或模型完成。 */
  'messages:activity': import('./mailActivity').MailActivity;
  /** 仅给当前寄件视图的待寄预览。 */
  'messages:departure': import('./mailActivity').MailDepartureRequest;
  /** 调度会话 phase/胶囊（按工作区；不进 sessions.observe / 看板） */
  'scheduler:status': { byWorkspace: Record<string, import('./schedulerStatus').SchedulerStatus> };
  /** 画布交接任务进度（源节点徽标 / 目标节点先落点后置灰；临时会话不进 sessions:changed） */
  'sessions:handover': {
    jobId: string;
    sourceId: string;
    status: 'running' | 'done' | 'failed' | 'cancelled';
    sessionId?: string;
    error?: string;
  };
  /** 显式聚焦会话：关中栏工具/扩展面板，并切回终端工作页 */
  'sessions:reveal': { sessionId: string };
  'workspaces:changed': { workspaces: WorkspaceInfo[]; activeWorkspaceId: string; workspaceAccentDefault?: import('./workspaceAccent').WorkspaceAccentDefault };
  'agent:message': ChatMessage & { workspaceId?: string; eventSeq?: number };
  'agent:token': AgentTokenEvent;
  'agent:thinking': AgentThinkingEvent;
  'agent:tool': AgentToolEvent;
  'agent:done': AgentDoneEvent;
  'agent:history': AgentHistoryEvent | ChatMessage[];
  'agent:context': AgentContextEvent;
  'ui:bubble': { text: string; status: AgentStatus; workspaceId?: string };
  'ui:confirm': {
    requestId: string;
    title: string;
    detail: string;
    localOnly?: boolean;
    desktopEvidence?: import('./confirmDialog').DesktopEvidencePreview;
    inboundMcpReview?: import('./inboundMcp').InboundMcpReview;
    dangerous?: boolean;
    subtitle?: string;
    intent?: string;
    summary?: string;
    confirmNote?: string;
    toolDescription?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** 权限选项门（B2）：四态 kind + always 作用域 + freeText + 结构化预览 */
    permission?: import('./permissionOption').PermissionGateOptions;
  };
  'ui:confirmClosed': { requestId: string };
  'ui:dialog': UiDialogRequest;
  'ui:dialogClosed': { requestId: string };
  'cli:openRun': { workspaceId: string; runId: string };
  /** 系统通知点击后打开中栏面板页签（决策 #9：记忆审批注意流；uiBridge.notify 的 openPanel） */
  'ui:openPanel': {
    panel: 'memory';
    tab?: 'overview' | 'entries' | 'profile' | 'review' | 'approvals' | 'intent' | 'index' | 'recycle';
  };
  'fs:changed': FsChangedPayload;
  'runtimes:changed': AgentRuntimeEntry[];
  'runtimes:availabilityChanged': Record<string, never>;
  'extensions:changed': Record<string, never>;
  'workbench:changed': import('./extension').ExtensionNavigationSnapshot;
  'workbench:extensionEvent': import('./extension').ExtensionRuntimeEvent;
  'extensionSurface:newTask': { title: string; draft: string; projectPath: string; source: import('./boardTodo').ExtensionTaskSource };
  'extensionSurface:previewExport': { workspaceId: string; path: string };
  'extensionSurface:event': { token: string; topic: string; value: unknown };
  'workbench:extensionInvalidated': import('./extension').ExtensionInstanceIdentity;
  'workbench:panelReturned': { token: string };
  'workbench:panelError': { token: string; error: string };
  'workbench:middleClick': Record<string, never>;
  'themes:changed': ThemesChangedPayload;
  /** 界面语言变更（主进程侧改 locale 时广播；渲染层切换走本地路径不经此事件） */
  'locale:changed': { locale: AppLocale };
  'terminal:capture-request': { requestId: string; sessionId: string };
  'panel:snapshot-request': { requestId: string; workspaceId: string };
  'workspace:close-prepare-request': { requestId: string; workspaceId: string };
  'workspace:close-prepare-closed': { requestId: string };
  'workspace:close-finish-request': { requestId: string; preparationId: string; workspaceId: string; committed: boolean };
  'workspace:close-abort': { preparationId: string };
  'panel:open-content-request': { requestId: string; workspaceId: string; rootsRevision: number; content: import('./panelState').PanelOpenContent; focus: boolean };
  'panel:open-content-closed': { requestId: string };
  'panel:close-tab-request': { requestId: string; workspaceId: string; rootsRevision: number; tabId: string; expectedContent: string };
  'panel:close-tab-closed': { requestId: string };
  'panel:focus-tab-request': { requestId: string; workspaceId: string; rootsRevision: number; tabId: string; expectedContent: string };
  'panel:focus-tab-closed': { requestId: string };
  'panel:focus-axis-closed': { requestId: string };
  'panel:focus-axis-request': { requestId: string; workspaceId: string; rootsRevision: number; page: 'terminal' | 'git' };
  'panel:focus-center-request': { requestId: string; workspaceId: string; rootsRevision: number; target: Exclude<import('./centerSplit').SplitPaneRef, { kind: 'empty' }>; navigation?: import('./panelState').CenterNavigationIdentity; file?: import('./panelState').CenterFileBinding };
  'panel:focus-center-closed': { requestId: string };
  'panel:close-center-request': { requestId: string; workspaceId: string; rootsRevision: number; slot: import('./centerSplit').CenterPaneSlot; panes: import('./centerSplit').SplitPaneRef[]; navigation?: import('./panelState').CenterNavigationBinding[]; files?: import('./panelState').CenterFileBinding[] };
  'panel:close-center-closed': { requestId: string };
  'panel:right-layout-request': { requestId: string; workspaceId: string; rootsRevision: number; reveal: boolean; change: import('./panelState').RightPanelLayoutChange };
  'panel:right-layout-closed': { requestId: string };
  'panel:split-request': { requestId: string; workspaceId: string; rootsRevision: number; panes: Exclude<import('./centerSplit').SplitPaneRef, { kind: 'empty' }>[]; layoutId: import('./centerSplit').CenterSnapLayoutId; navigation?: import('./panelState').CenterNavigationBinding[]; files?: import('./panelState').CenterFileBinding[] };
  /** GUI（chat surface）Worker 会话推送（与调度 agent:* 分开；主进程是唯一 writer） */
  'agentSession:event': GuiWorkerPush;
  'modelRequests:recordingChanged': { sessionId: string; enabled: boolean };
  'agentSession:modelCatalogUpdated': { runtimeId: string; agentId?: string; workspaceId: string; rootId: string; cwd: string; requestId?: string; error?: string };
  'agentSession:coreReasoningCatalogUpdated': Record<string, never>;
  'agentSession:harnessCatalogRefreshProgress': import('./harnessCatalogRefresh').HarnessCatalogRefreshEvent;
  'agentSession:harnessModelSelectionsChanged': { key: string; selections: import('./harnessModelSelection').HarnessModelSelections };
  /** GUI 会话后台任务推送（快照 + 子代理消息流；主进程是唯一 writer） */
  'agentSession:bgTask': import('./backgroundTasks').BgTaskPush;
  /** 脚本工作流的 run 记录 / 触发状态 / 信任有变化（节流；面板收到后重新拉 workflow:overview） */
  'workflow:changed': { workspaceId: string };
  /** 划词文本工具流式推送（runId 对齐当次请求；invoke 的最终返回仍是权威全文）：
   *  delta=正文增量；modelLabel 在首个事件携带（实际解析到的服务商·模型）；
   *  reasoning=true 表示模型进入思考段（reasoning_content），此时正文尚无增量。 */
  'textTools:chunk': { runId: string; delta: string; modelLabel?: string; reasoning?: boolean };
  /** 内置浏览器标签快照（标签增删/标题/URL/favicon/加载态变化时全量推送） */
  'browser:tabs': import('./browser').BrowserTabsPayload;
  /** 内置浏览器 Agent 操控状态条（动作前后推送；active=false 空闲） */
  'browser:agentState': import('./browser').BrowserAgentStatePayload;
  /** 元素拾取结果（pick 后用户点击元素的信息；null=Esc/取消/页面导航；shot=元素区域截图，
   *  rect=元素页面坐标（CSS 像素、取整整型）；渲染层暂未消费 rect，仅为与实发载荷对齐 */
  'browser:picked':
    | {
        selector: string;
        tag: string;
        id: string;
        text: string;
        url: string;
        shot: string;
        rect: { x: number; y: number; w: number; h: number };
      }
    | null;
  /** 懒挂载请求（agent 操作未挂载的后台标签；渲染层据此创建 <webview>） */
  'browser:mount-request': { tabId: string };
  'browser:focus-request': import('./browser').BrowserFocusRequest;
  'browser:guest-click': { tabId: string };
  'browser:escape': { tabId: string };
  /** 自动更新状态全量快照（状态迁移即时推；下载进度约 500ms 节流） */
  'updater:status': UpdaterStatus;
  'capabilityManagement:changed': { revision?: number; kind: 'skills' | 'mcp' };
  'inboundMcp:changed': import('./inboundMcp').InboundMcpSetupStatus;
  /** 主窗口原生全屏状态（macOS 全屏时红绿灯隐藏，渲染层据此收回顶栏让位） */
  'window:fullscreen': boolean;
  /** 后台启动链收口（X7-F01）：bootWait 超时降级挂载的渲染层据此重拉初始数据 */
  'app:boot:ready': BootResult;
  /** 第二实例把启动参数转交给已运行实例，主实例负责聚焦并处理可打开的路径。 */
  'app:second-instance': { commandLine: string[]; workingDirectory: string };
};

export type IpcEventChannel = keyof IpcEventMap;

export const IPC_EVENT_CHANNELS = [
  'boardTodos:changed',
  'sessionReminders:changed',
  'workerRouting:changed',
  'feedback:changed',
  'agentApps:operation', 'agentApps:changed', 'agentApps:feishuStatus',
  'memoryCurator:changed',
  'safety:changed',
  'uiWidget:changed',
  'uiWidget:updated',
  'uiWidget:present',
  'uiWidget:draft',
  'pty:data',
  'pty:exit',
  'pty:respawn',
  'sessions:changed',
  'messages:changed',
  'messages:activity',
  'messages:departure',
  'scheduler:status',
  'sessions:handover',
  'sessions:reveal',
  'workspaces:changed',
  'agent:message',
  'agent:token',
  'agent:thinking',
  'agent:tool',
  'agent:done',
  'agent:history',
  'agent:context',
  'ui:bubble',
  'ui:confirm',
  'ui:confirmClosed',
  'ui:dialog',
  'ui:dialogClosed',
  'ui:openPanel',
  'cli:openRun',
  'fs:changed',
  'runtimes:changed',
  'runtimes:availabilityChanged',
  'extensions:changed',
  'workbench:changed',
  'workbench:extensionEvent',
  'extensionSurface:newTask',
  'extensionSurface:previewExport',
  'extensionSurface:event',
  'workbench:extensionInvalidated',
  'workbench:panelReturned',
  'workbench:panelError',
  'workbench:middleClick',
  'themes:changed',
  'locale:changed',
  'terminal:capture-request',
  'panel:snapshot-request',
  'workspace:close-prepare-request',
  'workspace:close-prepare-closed',
  'workspace:close-finish-request',
  'workspace:close-abort',
  'panel:open-content-request',
  'panel:open-content-closed',
  'panel:close-tab-request',
  'panel:close-tab-closed',
  'panel:focus-tab-request',
  'panel:focus-tab-closed',
  'panel:focus-axis-closed',
  'panel:focus-axis-request',
  'panel:focus-center-request',
  'panel:focus-center-closed',
  'panel:close-center-request',
  'panel:close-center-closed',
  'panel:split-request',
  'panel:right-layout-request',
  'panel:right-layout-closed',
  'agentSession:event',
  'modelRequests:recordingChanged',
  'agentSession:modelCatalogUpdated',
  'agentSession:coreReasoningCatalogUpdated',
  'agentSession:harnessCatalogRefreshProgress',
  'agentSession:harnessModelSelectionsChanged',
  'agentSession:bgTask',
  'workflow:changed',
  'textTools:chunk',
  'browser:tabs',
  'browser:agentState',
  'browser:picked',
  'browser:mount-request',
  'browser:focus-request',
  'browser:guest-click',
  'browser:escape',
  'updater:status',
  'capabilityManagement:changed',
  'inboundMcp:changed',
  'window:fullscreen',
  'app:boot:ready',
  'app:second-instance'
] as const satisfies readonly IpcEventChannel[];
