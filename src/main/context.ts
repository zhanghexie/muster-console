import type { BrowserWindow } from 'electron';
import { t } from '../shared/i18n';
import type { ConfigManager } from './config';
import type { Store } from './store';
import type { PtyManager } from './pty/manager';
import type { SessionsService } from './sessions';
import type { PromptTasksManager } from './tasks/manager';
import type { UiBridge } from './uiBridge';
import type { ShellApiServer } from './protocol/shellApi';
import type { GitService } from './git/service';
import type { WorkspaceService } from './workspaces';
import type { NotifyStore } from './notify/store';
import type { RuntimeHost } from './runtime/host';
import type { ThemeService } from './themes';
import type { Orchestrator } from './agent/orchestrator';
import type { AgentSessionHost } from './agentSession/host';
import type { BackgroundTaskManager } from './agentSession/background/manager';
import type { UsageStatsService } from './usage/service';
import type { WebAccessServer } from './webAccess/server';

/** 贯穿主进程的依赖集合，hosts / executor / orchestrator 都通过它取服务。 */
export interface AppContext {
  messaging?: import('../shared/messaging').MessagingService;
  messagingChannels?: import('./messaging/logicalChannelService').LogicalChannelService;
  runtimeKernel?: import('./runtimeKernel/kernelContracts').RuntimeKernel<import('./ipc/handle').IpcHandler>;
  sessionLogs?: import('./runtimeKernel/sessionManager').SessionLogFactory;
  feedback?: import('./feedback/service').FeedbackService;
  feedbackError?: string;
  skillsManagement?: import('./capabilityManagement/skills').SkillsManagementService;
  mcpManagement?: import('./capabilityManagement/mcpManagement').McpManagementService;
  coreReasoningCatalog?: import('./agent/coreReasoningCatalog').CoreReasoningCatalogStore;
  config: ConfigManager;
  store: Store;
  pty: PtyManager;
  sessions: SessionsService;
  runtimes: RuntimeHost;
  tasks: PromptTasksManager;
  git: GitService;
  githubPr?: import('./git/githubPrService').GitHubPrService;
  workspaces: WorkspaceService;
  notify: NotifyStore;
  ui: UiBridge;
  /** Extension services are attached after safety and application dependencies are ready. */
  extensionSystem?: import('./extensions/extensionAppSystem').ExtensionAppSystem;
  agentApps?: import('./agentApps/serviceClient').AgentAppsServiceClient;
  safety?: import('../shared/safety').SafetyService;
  themes: ThemeService;
  /** 使用统计：会话/调度/能力调用/无头运行的计数埋点 */
  usage: UsageStatsService;
  shellApi: ShellApiServer | null;
  bindShellApi: (api: ShellApiServer) => void;
  /** 调度 Agent 晚绑定（P4：delegateTask 异步协调通知用） */
  orchestrator: Orchestrator | null;
  bindOrchestrator: (o: Orchestrator) => void;
  /** GUI（chat surface）Worker 宿主：晚绑定（构造依赖完整 ctx） */
  agentSessions: AgentSessionHost | null;
  bindAgentSessions: (h: AgentSessionHost) => void;
  /** GUI 会话后台任务（子代理/后台终端/定时器）：晚绑定（复用 pty 与 agentSessions） */
  bgTasks: BackgroundTaskManager | null;
  bindBgTasks: (m: BackgroundTaskManager) => void;
  /** 运行时状态流（内置字段事件账本 + 状态共享栏），落 userData */
  awareness: import('./awareness/store').RuntimeAwarenessStore;
  eventRouter?: import('./awareness/eventRouter').EventRouter;
  resumeWait?: import('./resumeWait/service').ResumeWaitService;
  /** Host-owned desktop task identity; not model-provided. Desktop actions remain unavailable until attached. */
  desktopEpochs?: { currentBinding(owner: string): { epoch: string; anchor: string; generation: number } | null;
    /** Optional host-private identity readback; it never supplies a desktop permission. */
    continuationBinding?(owner: string): { epoch: string; anchor: string; generation: number } | null;
    endScheduler?(workspaceId: string): void };
  desktopWorkerTask?: () => import('./desktop/workerEpochRuntime').WorkerDesktopEpochRuntime;
  desktopSchedulerTask?: () => import('./desktop/schedulerEpochRuntime').SchedulerDesktopEpochRuntime;
  /** Lazily initialized read-only desktop metadata backend; no capture or input. */
  desktopMetadata?: () => import('./desktop/metadataRuntime').DesktopMetadataRuntime;
  /** Optional host-owned application inventory; requires a current desktop activity lease. */
  desktopAppDiscovery?: () => import('./desktop/cuaAppDiscovery').CuaAppDiscovery;
  desktopWindowList?: () => import('./desktop/cuaWindowList').CuaWindowList;
  /** Sanitized startup error; a failed desktop backend must not block text turns. */
  desktopUnavailableReason?: string;
  desktopScreen?: () => import('./desktop/screenRuntime').DesktopScreenRuntime;
  desktopMac?: ReturnType<typeof import('./desktop/macDesktopHost').createMacDesktopHost>['desktopMac'];
  desktopTargets?: () => import('./desktop/win32TargetRegistry').Win32TargetRegistry;
  desktopControl?: () => import('./desktop/win32ControlRuntime').Win32ControlRuntime;
  /** Visible Windows execution bridge, attached only when all its host dependencies are ready. */
  desktopVisibleControl?: () => import('./desktop/win32VisibleBridge').Win32VisibleBridge;
  desktopSemanticControl?: () => import('./desktop/cuaVisibleBridge').CuaVisibleBridge;
  desktopTurns?: () => import('./desktop/desktopTurns').DesktopTurns;
  desktopPtyTurns?: () => import('./desktop/ptyDesktopTurns').PtyDesktopTurns;
  /** Host-private delivery evidence for the single assembled desktop write barrier. */
  desktopEngineDelivery?: () => import('./desktop/globalEngineDelivery').GlobalEngineDelivery;
  /** 调度会话 phase/胶囊（按工作区；不进 SessionMeta / 看板） */
  schedulerStatus: import('./schedulerStatusStore').SchedulerStatusStore;
  /** 证据归集器（T4.4）：晚绑定（依赖 userData 与 pty；GUI browser 工具挂钩用） */
  evidence: import('./sessions/evidence').EvidenceCollector | null;
  bindEvidence: (c: import('./sessions/evidence').EvidenceCollector) => void;
  /** 网页访问网关（远程连接 · 网址连接）：晚绑定（在 registerIpc 之后启动） */
  webAccess: WebAccessServer | null;
  bindWebAccess: (s: WebAccessServer) => void;
  /** 内置浏览器（虚拟屏浏览器页）：晚绑定（依赖 config 与主窗口，CDP 端口 ready 后才可知） */
  browser: import('./browser/tabs').BrowserTabService | null;
  bindBrowser: (s: import('./browser/tabs').BrowserTabService) => void;
  /** 某工作区（或任意）调度 Agent 是否正忙 */
  isOrchestratorBusy: (workspaceId?: string) => boolean;
  /** 调度回合空闲（队列也空）时：R1 事件泵可 flush */
  onOrchestratorIdle?: (workspaceId: string) => void;
  /**
   * 写气泡应落到的工作区：工具 ALS（当前回合）> 单 busy 区 > active。
   */
  /**
   * 写气泡应落到的工作区：工具 ALS（当前回合）> 单 busy 区 > active。
   */
  resolveBubbleWorkspaceId: () => string;
  /** 重命名当前调度 Agent 会话（Pi 落盘会话）标题 */
  renameAgentSession: (
    workspaceId: string,
    name: string
  ) => Promise<{ ok: boolean; error?: string }>;
  getWindow(): BrowserWindow | null;
  /**
   * 辅助应用窗口（扩展独立窗口等完整 renderer 窗口）登记：聊天生命线事件
   * （agentSession:event / bgTask）除主窗口外也要送达这些窗口里的 AI 侧栏。
   */
  readonly auxRendererIds: Set<number>;
  sendToAuxiliaryRenderers(channel: string, payload: unknown): void;
}

export { currentAgentWorkspaceId } from './agent/agentScope';

export function requireShellApi(ctx: AppContext): ShellApiServer {
  if (!ctx.shellApi) throw new Error(t('ShellApi 尚未绑定'));
  return ctx.shellApi;
}
