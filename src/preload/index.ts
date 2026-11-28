import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppCall, AppCallResult, AppConnection, AppConnectionInput, AppQuery, AppSnapshot } from '../shared/agentApps';
import type { PrApi } from '../shared/githubPr';
import type { GitOperationScope, GitScopedOperations } from '../shared/gitOperations';
import type { CapabilityManagementAPI } from '../shared/capabilityManagementApi';
import type { CapabilityTargetId } from '../shared/capabilityManagement';
import type { WorkerRoutingFollowGlobalInput, WorkerRoutingReadInput, WorkerRoutingResetCooldownInput, WorkerRoutingSaveInput, WorkerRoutingScope, WorkerRoutingSettings, WorkerTargetConfig, WorkerTargetReference } from '../shared/workerRouting';
import type { UiWidgetSnapshot, UiWidgetStatePatch, UiWidgetReceipt, UiWidgetAction, UiWidgetActionResult } from '../shared/uiWidgetProtocol';
import type {
  AppConfig,
  GitActionResult,
  GitAddRepoResult,
  GitAdoptHunkKey,
  GitAdoptHunksResult,
  GitAdoptPreviewResult,
  GitBranchList,
  GitCheckoutRequest,
  GitCommitDiffResult,
  GitCommitFilesResult,
  GitDiffResult,
  GitLogPage,
  GitRepoStatus,
  GitRepoSummary,
  GitRepoListResult,
  GitRepoLocationListResult,
  GitWorktreeAddResult,
  GitWorktreeInfo,
  SessionMeta,
  TerminalRestartIntent,
  ShellEnvInfo,
  ShellProfile,
  WorkspaceNotifyItem,
  AgentRuntimeDetail,
  AgentRuntimeEntry,
  AgentSkillInfo,
  CapabilitiesView,
  CapabilityCatalogInfo,
  RuntimeMutationResult,
  UpdateRuntimeArgs,
  WorkspaceFileEntry,
  WorkspaceInfo,
  WorkspaceFileRef,
  WorkspaceListedFile,
  WorkspaceSearchHit,
  WorkspaceQueryOptions,
  WorkspaceQueryResult,
  WorkspaceOpenOptions,
  WorkspaceSwitchResult,
  WorkspaceUpdateOptions,
  FsDirEntry,
  FsReadResult,
  FsWriteResult,
  FsSearchHit,
  FsListPathsOptions,
  FsSearchTextOptions,
  FsStatResult,
  SandboxInfo
} from '../shared/types';
import type {
  WorkspaceFileConfig,
  WorkspaceFileGetResult,
  WorkspaceFilePatchResult
} from '../shared/metaAgent';
// X4-F06（reliability/X4-IPC面完整性）：memory 域死暴露清理——memory:get/saveEntry/
// forget/restore 与 memoryCenter 15 个无注册且死树独占的方法已删；保留 6 个已注册
// 通道 + log/recycle/events/stagingList（MemoryOverview 活调用，归 X4-F01/D10 裁定）
import type {
  MemoryCenterBadgeResult,
  MemoryCenterEventsOptions,
  MemoryCenterEventsResult,
  MemoryCenterIntentMutateResult,
  MemoryCenterIntentsResult,
  MemoryCenterLogResult,
  MemoryCenterRecycleResult,
  MemoryCenterStagingResult
} from '../shared/memoryCenterIpc';
import { createIpcEventSubscriber } from './ipcEventSubscriber';
import { IPC_EVENT_CHANNELS, type IpcEventChannel, type IpcEventMap } from '../shared/ipcEvents';
import type { ThemeListView, WorkbenchTheme } from '../shared/theme';
import type { RuntimePreflightReply } from '../shared/runtimePreflight';
import type { BootResult } from '../shared/boot';
import type { ConfirmCancelledBy } from '../shared/confirmDialog';
import type { BrowserTabInfo, BrowserTabsPayload, BrowserFocusAck, BrowserPanelReplayRequest, BrowserWheelPayload } from '../shared/browser';

const subscribeIpcEvent = createIpcEventSubscriber(ipcRenderer);

const api = {
  boardTodos: {
    loadAttachments: (id: string, key: string): Promise<import('../shared/types').ChatImageAttachment[]> => ipcRenderer.invoke('boardTodos:loadAttachments', id, key),
    list: (): Promise<import('../shared/boardTodo').BoardTodo[]> => ipcRenderer.invoke('boardTodos:list'),
    save: (input: import('../shared/boardTodo').BoardTodoInput, id?: string): Promise<import('../shared/boardTodo').BoardTodo> => ipcRenderer.invoke('boardTodos:save', input, id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('boardTodos:delete', id)
  },
  localStorage: {
    scan: (): Promise<import('../shared/localStorage').LocalStorageSnapshot> => ipcRenderer.invoke('localStorage:scan'),
    startCleanup: (snapshotId: string, selections: import('../shared/localStorage').LocalStorageSelection[]): Promise<{ id: string }> => ipcRenderer.invoke('localStorage:startCleanup', snapshotId, selections),
    cleanupStatus: (jobId: string): Promise<import('../shared/localStorage').LocalStorageCleanupJob> => ipcRenderer.invoke('localStorage:cleanupStatus', jobId)
  },
  workerRouting: {
    read: (args: WorkerRoutingReadInput): Promise<WorkerRoutingSettings> => ipcRenderer.invoke('workerRouting:read', args),
    save: (args: WorkerRoutingSaveInput): Promise<WorkerRoutingSettings> => ipcRenderer.invoke('workerRouting:save', args),
    followGlobal: (args: WorkerRoutingFollowGlobalInput): Promise<WorkerRoutingSettings> => ipcRenderer.invoke('workerRouting:followGlobal', args),
    reference: (args: { scope: WorkerRoutingScope; config: WorkerTargetConfig }): Promise<WorkerTargetReference> => ipcRenderer.invoke('workerRouting:reference', args),
    validate: (args: { scope: WorkerRoutingScope; targetRef: string }): Promise<WorkerTargetReference> => ipcRenderer.invoke('workerRouting:validate', args),
    resetCooldown: (args: WorkerRoutingResetCooldownInput): Promise<WorkerRoutingSettings> => ipcRenderer.invoke('workerRouting:resetCooldown', args)
  },
  sessionReminders: {
    list: (target: import('../shared/sessionReminders').SessionReminderTarget): Promise<import('../shared/sessionReminders').SessionReminderSnapshot> =>
      ipcRenderer.invoke('sessionReminders:list', target),
    setCompleted: (target: import('../shared/sessionReminders').SessionReminderTarget, scope: string, id: string, done: boolean): Promise<import('../shared/sessionReminders').SessionReminder> =>
      ipcRenderer.invoke('sessionReminders:setCompleted', target, scope, id, done),
    delete: (target: import('../shared/sessionReminders').SessionReminderTarget, scope: string, id: string): Promise<void> =>
      ipcRenderer.invoke('sessionReminders:delete', target, scope, id)
  },
  feedback: {
    snapshot: (): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:snapshot'),
    createManual: (input: import('../shared/feedback').ManualFeedbackInput): Promise<import('../shared/feedback').ManualFeedbackResult> => ipcRenderer.invoke('feedback:createManual', input),
    update: (id: string, revision: number, draft: import('../shared/feedback').FeedbackDraft): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:update', id, revision, draft),
    updateText: (id: string, revision: number, text: string): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:updateText', id, revision, text),
    reject: (id: string, revision: number): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:reject', id, revision),
    delete: (id: string, revision: number): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:delete', id, revision),
    restore: (id: string, revision: number): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:restore', id, revision),
    prepare: (id: string, revision: number): Promise<import('../shared/feedback').FeedbackReview> => ipcRenderer.invoke('feedback:prepare', id, revision),
    duplicate: (id: string, revision: number, match: import('../shared/feedback').FeedbackMatch): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:duplicate', id, revision, match),
    submit: (id: string, revision: number, reviewId: string, distinct: boolean): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:submit', id, revision, reviewId, distinct),
    copyIssueBody: (id: string, revision: number): Promise<void> => ipcRenderer.invoke('feedback:copyIssueBody', id, revision),
    reconcile: (id: string, revision: number, returnToDraft?: boolean): Promise<import('../shared/feedback').FeedbackSnapshot> => ipcRenderer.invoke('feedback:reconcile', id, revision, returnToDraft)
  },
  safety: {
    snapshot: (workspaceId: string): Promise<import('../shared/safety').SafetySnapshot> => ipcRenderer.invoke('safety:snapshot', workspaceId),
    send: (workspaceId: string, text: string, requestId?: string): Promise<import('../shared/safety').SafetySnapshot> => ipcRenderer.invoke('safety:send', workspaceId, text, requestId),
    stop: (workspaceId: string): Promise<void> => ipcRenderer.invoke('safety:stop', workspaceId),
    clear: (workspaceId: string): Promise<import('../shared/safety').SafetySnapshot> => ipcRenderer.invoke('safety:clear', workspaceId),
    setRuleEnabled: (workspaceId: string, ruleId: string, enabled: boolean, revision: number): Promise<import('../shared/safety').SafetySnapshot> => ipcRenderer.invoke('safety:setRuleEnabled', workspaceId, ruleId, enabled, revision)
  },
  agentApps: {
    snapshot: (workspaceId: string): Promise<AppSnapshot> => ipcRenderer.invoke('agentApps:snapshot', workspaceId),
    query: (workspaceId: string, query: AppQuery): Promise<AppCallResult> => ipcRenderer.invoke('agentApps:query', workspaceId, query),
    call: (workspaceId: string, call: AppCall): Promise<AppCallResult> => ipcRenderer.invoke('agentApps:call', workspaceId, call),
    setEnabled: (workspaceId: string, appId: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('agentApps:setEnabled', workspaceId, appId, enabled),
    uninstall: (workspaceId: string, appId: string, deleteData = false): Promise<{ appId: string; dataDeleted: boolean; linkedRemindersStopped: number }> => ipcRenderer.invoke('agentApps:uninstall', workspaceId, appId, deleteData),
    listLibrary: (workspaceId: string): Promise<import('../shared/agentApps').AppLibraryItem[]> => ipcRenderer.invoke('agentApps:listLibrary', workspaceId),
    installFromLibrary: (workspaceId: string, catalogId: string, version?: number): Promise<import('../shared/agentApps').AgentAppDefinition> => ipcRenderer.invoke('agentApps:installFromLibrary', workspaceId, catalogId, version),
    publish: (workspaceId: string, appId: string): Promise<{ catalogId: string; version: number }> => ipcRenderer.invoke('agentApps:publish', workspaceId, appId),
    setPrivate: (workspaceId: string, appId: string, privateApp: boolean): Promise<void> => ipcRenderer.invoke('agentApps:setPrivate', workspaceId, appId, privateApp),
    saveConnection: (workspaceId: string, input: AppConnectionInput): Promise<AppConnection> => ipcRenderer.invoke('agentApps:saveConnection', workspaceId, input),
    testConnection: (workspaceId: string, id: string): Promise<{ ok: true }> => ipcRenderer.invoke('agentApps:testConnection', workspaceId, id),
    listFeishuChats: (workspaceId: string, identity: 'bot' | 'user', pageToken?: string): Promise<import('../shared/agentApps').AppFeishuChatPage> => ipcRenderer.invoke('agentApps:listFeishuChats', workspaceId, identity, pageToken),
    feishuStatus: (workspaceId: string): Promise<import('../shared/agentApps').AppFeishuStatus> => ipcRenderer.invoke('agentApps:feishuStatus', workspaceId),
    startFeishuSetup: (workspaceId: string): Promise<{ ok: boolean; url?: string; qrDataUrl?: string; error?: string }> => ipcRenderer.invoke('agentApps:startFeishuSetup', workspaceId),
    cancelFeishuSetup: (workspaceId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('agentApps:cancelFeishuSetup', workspaceId),
    beginFeishuBinding: (workspaceId: string): Promise<import('../shared/agentApps').AppFeishuStatus> => ipcRenderer.invoke('agentApps:beginFeishuBinding', workspaceId),
    pickImage: (workspaceId: string, appId: string): Promise<{ canceled: true } | { canceled: false; asset: import('../shared/agentApps').AppImageAsset }> => ipcRenderer.invoke('agentApps:pickImage', workspaceId, appId),
    dropImage: (workspaceId: string, appId: string, file: File): Promise<import('../shared/agentApps').AppImageAsset> => ipcRenderer.invoke('agentApps:dropImage', workspaceId, appId, webUtils.getPathForFile(file)),
    readImage: (workspaceId: string, appId: string, assetId: string, thumbnail = false): Promise<{ mime: string; bytes: Uint8Array }> => ipcRenderer.invoke('agentApps:readImage', workspaceId, appId, assetId, thumbnail),
    releaseImage: (workspaceId: string, appId: string, assetId: string): Promise<boolean> => ipcRenderer.invoke('agentApps:releaseImage', workspaceId, appId, assetId)
  },
  uiWidgets: {
    list: (sessionId: string): Promise<UiWidgetSnapshot[]> => ipcRenderer.invoke('uiWidget:list', sessionId),
    sessionAction: (filePath: string, action: UiWidgetAction, state?: UiWidgetStatePatch): Promise<UiWidgetActionResult> => ipcRenderer.invoke('uiWidget:session-action', filePath, action, state),
    read: (filePath: string): Promise<UiWidgetSnapshot> => ipcRenderer.invoke('uiWidget:read', filePath),
    save: (filePath: string, patch: UiWidgetStatePatch): Promise<UiWidgetSnapshot> => ipcRenderer.invoke('uiWidget:save', filePath, patch),
    receipt: (filePath: string, receipt: Omit<UiWidgetReceipt, 'updatedAt'>, source: string): Promise<UiWidgetSnapshot> => ipcRenderer.invoke('uiWidget:receipt', filePath, receipt, source),
    releaseReceipt: (filePath: string, source: string): Promise<void> => ipcRenderer.invoke('uiWidget:release-receipt', filePath, source),
    action: (filePath: string, action: UiWidgetAction, state?: UiWidgetStatePatch): Promise<UiWidgetActionResult> => ipcRenderer.invoke('uiWidget:action', filePath, action, state)
  },
  capabilityManagement: {
    usageList: input => ipcRenderer.invoke('capabilityManagement:usageList', input),
    usageSet: input => ipcRenderer.invoke('capabilityManagement:usageSet', input),
    skillsList: (scope) => ipcRenderer.invoke('capabilityManagement:skillsList', scope),
    previewSkillConsolidation: (scope, name, skillId?: string): ReturnType<CapabilityManagementAPI['previewSkillConsolidation']> => ipcRenderer.invoke('capabilityManagement:previewSkillConsolidation', scope, name, skillId),
    consolidateSkill: (input): ReturnType<CapabilityManagementAPI['consolidateSkill']> => ipcRenderer.invoke('capabilityManagement:consolidateSkill', input),
    readSkill: (id, scope) => ipcRenderer.invoke('capabilityManagement:readSkill', id, scope),
    saveSkill: (input) => ipcRenderer.invoke('capabilityManagement:saveSkill', input),
    createSkill: (input) => ipcRenderer.invoke('capabilityManagement:createSkill', input),
    setPreferred: (input) => ipcRenderer.invoke('capabilityManagement:setPreferred', input),
    refresh: (scope) => ipcRenderer.invoke('capabilityManagement:refresh', scope),
    mcpList: (workspaceId) => ipcRenderer.invoke('capabilityManagement:mcpList', workspaceId),
    getMcp: (id) => ipcRenderer.invoke('capabilityManagement:getMcp', id),
    saveMcp: (input) => ipcRenderer.invoke('capabilityManagement:saveMcp', input),
    removeMcp: (input) => ipcRenderer.invoke('capabilityManagement:removeMcp', input),
    importMcp: (input) => ipcRenderer.invoke('capabilityManagement:importMcp', input),
    testMcp: (id) => ipcRenderer.invoke('capabilityManagement:testMcp', id),
    setMcpEnabled: (enabled, workspaceId) => ipcRenderer.invoke('capabilityManagement:setMcpEnabled', enabled, workspaceId)
  } satisfies CapabilityManagementAPI,
  sessions: {
    list: (): Promise<{
      sessions: SessionMeta[];
      activeId: string | null;
      schedulerByWs?: Record<string, import('../shared/schedulerStatus').SchedulerStatus>;
    }> => ipcRenderer.invoke('sessions:list'),
    create: (opts?: {
      extensionSource?: import('../shared/boardTodo').ExtensionTaskSource;
      cliLaunchOptions?: import('../shared/cliLaunchOptions').CliLaunchOptions;
      activate?: boolean;
      name?: string;
      runtime?: string;
      cwd?: string;
      workspaceId?: string;
      rootId?: string;
      rootsRevision?: number;
      shellProfileId?: string;
      isolate?: boolean;
      isolationGroups?: import('../shared/types').WorkspaceWorktreeGroupSelection[];
      /** GUI（chat surface）会话初始态；仅 chat runtime 生效 */
      guiMode?: import('../shared/types').GuiWorkerMode;
      configurePermissions?: boolean;
      nativeConfig?: import('../shared/nativeSessionConfig').NativeConfigIntent;
      piModeId?: string;
      model?: { providerId: string; modelId: string; };
      thinking?: import('../shared/types').GuiThinkingLevel;
      modelParameters?: import('../shared/modelParameters').ModelParameterValues;
      /** 预检逃生门：true=跳过 runtime 可用性预检强创 */
      force?: boolean;
    }) => ipcRenderer.invoke('sessions:create', opts),
    canvasFork: (sourceId: string): Promise<{ session: SessionMeta; }> =>
      ipcRenderer.invoke('sessions:canvasFork', sourceId),
    canvasHandover: (sourceId: string): Promise<import('../shared/canvasHandover').CanvasHandoverDraft> =>
      ipcRenderer.invoke('sessions:canvasHandover', sourceId),
    canvasHandoverCancel: (jobId: string): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('sessions:canvasHandoverCancel', jobId),
    select: (id: string) => ipcRenderer.invoke('sessions:select', id),
    continueArchived: (id: string) => ipcRenderer.invoke('sessions:continueArchived', id),
    deselect: (id: string): Promise<boolean> => ipcRenderer.invoke('sessions:deselect', id),
    touchUsed: (id: string) => ipcRenderer.send('sessions:touch-used', id),
    archivedTerminalHistory: (id: string): Promise<string> => ipcRenderer.invoke('sessions:archivedTerminalHistory', id),
    deletePreview: (id: string): Promise<import('../shared/sessionLifecycle').SessionDeletePreview> => ipcRenderer.invoke('sessions:deletePreview', id),
    cleanupArchivedWorktree: (id: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('sessions:cleanupArchivedWorktree', id),
    close: (id: string, options?: import('../shared/sessionLifecycle').SessionDeleteOptions) => ipcRenderer.invoke('sessions:close', id, options),
    setConfigurePermissions: (sessionId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('sessions:setConfigurePermissions', sessionId, enabled),
    rename: (id: string, name: string) => ipcRenderer.invoke('sessions:rename', id, name),
    setPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('sessions:setPinned', id, pinned),
    setArchived: (id: string, archived: boolean, selectionHint?: import('../shared/workspaceActiveSession').ArchiveSelectionHint, confirmed?: string[]) =>
      ipcRenderer.invoke('sessions:setArchived', id, archived, selectionHint, confirmed),
    setPhase: (id: string, phase: { value: 'idle' | 'needs_you' | 'done'; }) =>
      ipcRenderer.invoke('sessions:setPhase', id, phase),
    markProcessed: (id: string, confirmed?: string[]) => ipcRenderer.invoke('sessions:markProcessed', id, confirmed),
    completeAndArchive: (args: { sessionIds: string[]; workspaceId?: string; }) =>
      ipcRenderer.invoke('sessions:completeAndArchive', args),
    review: (args: {
      sessionId: string;
      decision: 'passed' | 'rejected' | 'deferred' | 'processed';
      note?: string;
      /** R-14：维度门红灯时跳过门强制验收（验收账本留痕 dimension-gate-override） */
      skipDimensionGate?: boolean;
    }): Promise<{
      ok: boolean;
      decision?: string;
      merged?: boolean;
      injected?: boolean;
      message?: string;
      error?: string;
    }> => ipcRenderer.invoke('sessions:review', args),
    discardWorktree: (id: string): Promise<{ ok: boolean; message?: string; }> =>
      ipcRenderer.invoke('sessions:discardWorktree', id),
    previewForceRemoveUnregistered: (id: string, path: string): Promise<{ token: string; path: string; branch: string }> =>
      ipcRenderer.invoke('sessions:previewForceRemoveUnregistered', id, path),
    forceRemoveUnregistered: (id: string, token: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('sessions:forceRemoveUnregistered', id, token),
    delegate: (input: {
      extensionSource?: import('../shared/boardTodo').ExtensionTaskSource;
      cliLaunchOptions?: import('../shared/cliLaunchOptions').CliLaunchOptions;
      select?: boolean;
      task: string;
      runtime?: string;
      workspaceId?: string;
      rootId?: string;
      rootsRevision?: number;
      isolate: boolean;
      cwd?: string;
      isolationGroups?: import('../shared/types').WorkspaceWorktreeGroupSelection[];
      name?: string;
      /** GUI（chat surface）会话初始态；仅 chat runtime 生效 */
      guiMode?: import('../shared/types').GuiWorkerMode;
      configurePermissions?: boolean;
      nativeConfig?: import('../shared/nativeSessionConfig').NativeConfigIntent;
      piModeId?: string;
      model?: { providerId: string; modelId: string; };
      thinking?: import('../shared/types').GuiThinkingLevel;
      modelParameters?: import('../shared/modelParameters').ModelParameterValues;
      handoverDraftId?: string;
      handoverSupplement?: string;
      attachments?: import('../shared/types').ChatImageAttachment[];
      submissionId?: string;
    }): Promise<import('../shared/types').TaskDelegateResult> => ipcRenderer.invoke('tasks:delegate', input),
    recommendIsolate: (): Promise<boolean> => ipcRenderer.invoke('sessions:recommendIsolate'),
    /** 新建任务预检：隔离推荐 + 主仓 dirty（null=git 不可用未知） */
    precheck: (workspaceId?: string, rootId?: string, rootsRevision?: number): Promise<{ isolate: boolean; dirty: boolean | null; }> =>
      ipcRenderer.invoke('sessions:precheck', workspaceId, rootId, rootsRevision),
    respawn: (id: string, intent?: TerminalRestartIntent) => ipcRenderer.invoke('sessions:respawn', id, intent),
    resumeInterrupted: (
      id: string
    ): Promise<{
      session: SessionMeta;
      brief: string;
      sourceId: string;
      injected?: boolean;
      queued?: boolean;
    }> => ipcRenderer.invoke('sessions:resumeInterrupted', id),
    /** Durable task/review mail; saving does not mean the recipient has read it. */
    sendMessage: (
      args: { sessionId: string; text: string; idempotencyKey?: string }
    ): Promise<import('../shared/types').SessionMessageIpcResult> =>
      ipcRenderer.invoke('sessions:sendMessage', args),
  },
  desktopSetup: {
    status: (): Promise<import('../shared/desktopSetup').DesktopSetupStatus> => ipcRenderer.invoke('desktopSetup:status'),
    openSettings: (permission: import('../shared/desktopSetup').DesktopSetupPermission):
      Promise<import('../shared/desktopSetup').DesktopSettingsOpenResult> => ipcRenderer.invoke('desktopSetup:openSettings', permission)
  },
  shell: {
    listProfiles: (): Promise<ShellProfile[]> => ipcRenderer.invoke('shell:listProfiles'),
    /** 设置页 Shell 区块：本机探测结果 + 手工 Git Bash 路径与存在性 */
    getInfo: (): Promise<ShellEnvInfo> => ipcRenderer.invoke('shell:getInfo'),
    openExternal: (url: string): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('shell:openExternal', url),
    openPath: (absPath: string): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('shell:openPath', absPath),
    revealPath: (absPath: string): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('shell:revealPath', absPath),
    statPaths: (
      absPaths: string[]
    ): Promise<
      Record<string, { exists: boolean; isFile: boolean; isDirectory: boolean; }>
    > => ipcRenderer.invoke('shell:statPaths', absPaths),
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    clipboardFiles: (): Promise<import('../shared/types').ChatImageAttachment[]> => ipcRenderer.invoke('shell:clipboardFiles'),
    /** 文件树拖出：主进程 startDrag，使终端等按 Files 接收；多选拖出传路径数组 */
    startPathDrag: (absPath: string | string[]): void => {
      ipcRenderer.send('shell:startPathDrag', absPath);
    }
  },
  notify: {
    list: (workspaceId: string): Promise<WorkspaceNotifyItem[]> =>
      ipcRenderer.invoke('notify:list', workspaceId),
    /** 本机是否具备系统通知能力（F-01 兜底：设置页「通知」节的条件提示条） */
    capability: (): Promise<boolean> => ipcRenderer.invoke('notify:capability'),
    /** 输入区（composer）失败/被拒提示 → 系统桌面 toast（输入框上方 hint 条已移除） */
    toast: (input: { text: string; workspaceId?: string; label?: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('notify:toast', input)
  },
  browser: {
    restore: (): Promise<BrowserTabsPayload> => ipcRenderer.invoke('browser:restore'),
    replayPanelHistory: (args: BrowserPanelReplayRequest): Promise<BrowserTabInfo> => ipcRenderer.invoke('browser:replay-panel-history', args),
    retainPanelHistory: (keys: string[]): Promise<void> => ipcRenderer.invoke('browser:retain-panel-history', keys),
    open: (args: { url?: string; workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session'; openerId?: string; newTab?: boolean; background?: boolean; restoreShell?: boolean; }): Promise<{ id: string; }> => ipcRenderer.invoke('browser:open', args),
    setOwner: (args: { id: string; workspaceId: string; sessionId: string; scope: 'workspace' | 'session' }): Promise<{ ok: boolean }> => ipcRenderer.invoke('browser:setOwner', args),
    close: (args: { id: string; }): Promise<{ ok: boolean; tab?: BrowserTabInfo; }> => ipcRenderer.invoke('browser:close', args),
    bookmarkFavicon: (args: { id: string; }): Promise<{ dataUrl: string | null; }> => ipcRenderer.invoke('browser:bookmark-favicon', args),
    activate: (args: { id: string; }): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('browser:activate', args),
    navigate: (args: { id: string; input: string; }): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('browser:navigate', args),
    nav: (args: { id?: string; dir: 'back' | 'forward' | 'refresh'; }): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('browser:nav', args),
    devtools: (args: { id: string; }): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('browser:devtools', args),
    /** webview did-attach 上报（主进程注册表绑定 + 事件接线） */
    guestAttach: (args: { tabId: string; webContentsId: number; }): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('browser:guest-attach', args),
    /** webview 卸载/销毁上报（壳保留、绑定清除） */
    guestDetach: (args: { tabId: string; webContentsId: number; }): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('browser:guest-detach', args),
    /** 露条态滚轮转发（主进程经 CDP Input 域滚动 guest） */
    focusAck: (args: BrowserFocusAck): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('browser:focus-ack', args),
    wheelForward: (args: BrowserWheelPayload): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('browser:wheel-forward', args),
    /** 崩溃错误态手动重试（清零退避计数并 reload） */
    retryCrash: (args: { id: string; }): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('browser:retry-crash', args),
    /** webview preload 路径（<webview preload> 属性；弹窗同步桥） */
    preloadPath: (): Promise<{ path: string; }> => ipcRenderer.invoke('browser:preload-path'),
    /** 标签栏布局偏好（宽度 140-320 / 收起）；主进程合并写进 config.browser */
    setTabbar: (args: { width?: number; collapsed?: boolean; }): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('browser:setTabbar', args),
    /** 元素拾取（DevTools 式）：结果经 browser:picked 事件回传 */
    pick: (): Promise<{ ok: boolean; }> => ipcRenderer.invoke('browser:pick'),
    cancelPick: (): Promise<{ ok: boolean; }> => ipcRenderer.invoke('browser:cancelPick'),
    cdp: (): Promise<{ enabled: boolean; port: number; }> => ipcRenderer.invoke('browser:cdp')
  },
  pty: {
    input: (sessionId: string, data: string) => ipcRenderer.send('pty:input', sessionId, data),
    submitComposer: (sessionId: string, text: string, attachments?: import('../shared/types').ChatImageAttachment[]): Promise<{ ok: boolean; error?: string; warning?: string; viaFile?: boolean }> =>
      ipcRenderer.invoke('pty:submitComposer', sessionId, text, attachments),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send('pty:resize', sessionId, cols, rows),
    getBuffer: (sessionId: string): Promise<string> => ipcRenderer.invoke('pty:getBuffer', sessionId)
  },
  suggestions: {
    clear: (request: import('../shared/replySuggestions').ClearReplySuggestionsRequest): Promise<import('../shared/replySuggestions').ClearReplySuggestionsResult> =>
      ipcRenderer.invoke('suggestions:clear', request)
  },
  turnChanges: {
    list: (owner: import('../shared/turnChanges').TurnChangeOwner): Promise<{ ok: boolean; entries: import('../shared/turnChanges').TurnReviewEntry[]; error?: string }> => ipcRenderer.invoke('turnChanges:list', owner),
    diff: (target: import('../shared/turnChanges').TurnChangeTarget, file: string): Promise<{ ok: boolean; diff?: string; error?: string }> => ipcRenderer.invoke('turnChanges:diff', { target, file }),
    revert: (target: import('../shared/turnChanges').TurnChangeTarget): Promise<import('../shared/turnChanges').TurnRevertResult> => ipcRenderer.invoke('turnChanges:revert', target)
  },
  agentSession: {
    describeNativeConfig: (args: { runtimeId: string; presetId?: string; source: { workspaceId: string; rootId: string; rootsRevision?: number; cwd?: string }; refresh?: boolean }):
      Promise<import('../shared/nativeSessionConfig').NativeConfigSnapshot | null> => ipcRenderer.invoke('agentSession:describeNativeConfig', args),
    getNativeConfig: (sessionId: string): Promise<import('../shared/nativeSessionConfig').NativeConfigSnapshot | null> =>
      ipcRenderer.invoke('agentSession:getNativeConfig', sessionId),
    refreshNativeConfig: (sessionId: string): Promise<import('../shared/nativeSessionConfig').NativeConfigSnapshot | null> =>
      ipcRenderer.invoke('agentSession:refreshNativeConfig', sessionId),
    setNativeConfig: (sessionId: string, change: import('../shared/nativeSessionConfig').NativeConfigChange): Promise<{
      ok: boolean; error?: string; pending?: true; snapshot?: import('../shared/nativeSessionConfig').NativeConfigSnapshot
    }> => ipcRenderer.invoke('agentSession:setNativeConfig', { sessionId, change }),
    getModelParameters: (sessionId: string): Promise<import('../shared/modelParameters').ModelParameterSnapshot | null> => ipcRenderer.invoke('agentSession:getModelParameters', sessionId),
    describeModelParameters: (target: { runtimeId: string; providerId?: string; modelId?: string; piModeId?: string; cwd?: string; refresh?: boolean;
      source?: { workspaceId: string; rootId: string; rootsRevision?: number; cwd?: string } }): Promise<import('../shared/modelParameters').ModelParameterContext | null> => ipcRenderer.invoke('agentSession:describeModelParameters', target),
    setModelParameters: (sessionId: string, changes: Record<string, string | null>): Promise<{ ok: boolean; error?: string; applied?: 'immediate' | 'next-turn'; snapshot?: import('../shared/modelParameters').ModelParameterSnapshot }> => ipcRenderer.invoke('agentSession:setModelParameters', { sessionId, changes }),
    saveParameterProfiles: (profiles: import('../shared/modelParameters').ModelParameterProfile[]): Promise<{ ok: boolean; error?: string; profiles?: import('../shared/modelParameters').ModelParameterProfile[] }> => ipcRenderer.invoke('agentSession:saveParameterProfiles', profiles),
    send: (
      sessionId: string,
      text: string,
      images?: import('../shared/types').ChatImageAttachment[],
      opts?: { steerOnBusy?: boolean; }
    ): Promise<import('../shared/guiWorker').GuiWorkerSendResult> =>
      ipcRenderer.invoke('agentSession:send', { sessionId, text, images, ...opts }),
    abort: (sessionId: string, opts?: { holdQueue?: boolean }): Promise<void> =>
      ipcRenderer.invoke('agentSession:abort', opts?.holdQueue ? { sessionId, holdQueue: true } : sessionId),
    retry: (sessionId: string): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('agentSession:retry', sessionId),
    recallAborted: (
      sessionId: string,
      messageId?: string
    ): Promise<{
      ok: boolean;
      text?: string;
      images?: import('../shared/types').ChatImageAttachment[];
      error?: string;
    }> => ipcRenderer.invoke('agentSession:recallAborted', { sessionId, messageId }),
    compact: (
      args: { sessionId: string; instructions?: string; }
    ): Promise<import('../shared/piEvents').PiCompactResult> =>
      ipcRenderer.invoke('agentSession:compact', args),
    respondApproval: (args: {
      sessionId: string;
      approvalId: string;
      approved?: boolean;
      nativeChoiceId?: string;
      reason?: string;
    }): Promise<{ ok: boolean; }> => ipcRenderer.invoke('agentSession:respondApproval', args),
    respondUserQuestion: (args: {
      sessionId: string;
      questionId: string;
      action: 'answer' | 'abort';
      answers?: Array<{ id: string; selected: string[]; custom?: string; }>;
    }): Promise<{ ok: boolean; }> => ipcRenderer.invoke('agentSession:respondUserQuestion', args),
    setMode: (
      sessionId: string,
      mode: import('../shared/types').GuiWorkerMode
    ): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('agentSession:setMode', { sessionId, mode }),
    listPiModes: (): Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        trust: 'system' | 'user';
        order: number;
        broken: string | undefined;
      }> | null
    > => ipcRenderer.invoke('agentSession:listPiModes'),
    listAcpAgents: (): Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        trust: 'system' | 'user';
        order: number;
        broken: string | undefined;
      }> | null
    > => ipcRenderer.invoke('agentSession:listAcpAgents'),
    getHarnessModelSelections: (): Promise<import('../shared/harnessModelSelection').HarnessModelSelections> =>
      ipcRenderer.invoke('agentSession:getHarnessModelSelections'),
    setHarnessModelSelection: (args: { key: string; modelIds: string[] | null }): Promise<import('../shared/harnessModelSelection').HarnessModelSelections> =>
      ipcRenderer.invoke('agentSession:setHarnessModelSelection', args),
    listAcpModels: (args: { source: { workspaceId: string; rootId: string; rootsRevision?: number }; agentId: string; requestId: string; modelId?: string; refresh?: boolean; cliRuntimeId?: string }): Promise<{ ok: true; items: Array<{ id: string; name: string; group?: import('../shared/harnessPicker').HarnessModelGroup }>; currentModelId?: string } | { ok: false; error: string; cleanupFailed?: true }> =>
      ipcRenderer.invoke('agentSession:listAcpModels', args),
    refreshHarnessModelCatalogs: (requestId: string): Promise<import('../shared/harnessCatalogRefresh').HarnessCatalogRefreshResult> =>
      ipcRenderer.invoke('agentSession:refreshHarnessModelCatalogs', requestId),
    listLocalHarnessModels: (args: { source: { workspaceId: string; rootId: string; rootsRevision?: number }; runtimeId: 'claude' | 'pi-external' | 'omp' | 'zcode-gui' | 'muse-gui'; requestId: string; refresh?: boolean; cliRuntimeId?: string }): Promise<{ ok: true; items: Array<{ id: string; name: string; group?: import('../shared/harnessPicker').HarnessModelGroup; resolvedModel?: string; effortLevels?: string[] }>; currentModelId?: string } | { ok: false; error: string; cleanupFailed?: true }> =>
      ipcRenderer.invoke('agentSession:listLocalHarnessModels', args),
    getSessionHarnessModelState: (sessionId: string): Promise<{ ok: true; expected: import('../shared/chatSurface').SessionHarnessModelExpected } | { ok: false; error: string }> =>
      ipcRenderer.invoke('agentSession:getSessionHarnessModelState', sessionId),
    listSessionHarnessModels: (args: { sessionId: string; requestId: string; expected: import('../shared/chatSurface').SessionHarnessModelExpected; refresh?: boolean }): Promise<{ ok: true; runtimeId: string; agentId?: string; items: Array<{ id: string; name: string }>; currentModelId?: string; warning?: string } | { ok: false; error: string; cleanupFailed?: true }> =>
      ipcRenderer.invoke('agentSession:listSessionHarnessModels', args),
    cancelHarnessModels: (requestId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('agentSession:cancelHarnessModels', requestId),
    listHarnessPickerChoices: (): Promise<import('../shared/harnessPicker').HarnessPickerAvailability> => ipcRenderer.invoke('agentSession:listHarnessPickerChoices'),
    readHarnessPickerCatalog: (request: import('../shared/harnessPicker').HarnessPickerRequest): Promise<import('../shared/harnessPicker').HarnessPickerResult> => ipcRenderer.invoke('agentSession:readHarnessPickerCatalog', request),
    setModelConfiguration: (request: import('../shared/harnessPicker').SetModelConfigurationInput): Promise<import('../shared/harnessPicker').SetModelConfigurationResult> => ipcRenderer.invoke('agentSession:setModelConfiguration', request),
    listCodexModels: (target: string | { workspaceId: string; rootId: string; rootsRevision?: number }, refresh?: boolean): Promise<import('../shared/codexModels').CodexModelListResult> =>
      ipcRenderer.invoke('codex:listModels', { ...(typeof target === 'string' ? { sessionId: target } : { source: target }), refresh }),
    claudeStatus: (): Promise<import('../shared/claudeGui').ClaudeGuiStatus> =>
      ipcRenderer.invoke('claude:status'),
    setPiMode: (
      sessionId: string,
      modeId: string
    ): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('agentSession:setPiMode', { sessionId, modeId }),
    setModel: (
      sessionId: string,
      model: { providerId: string; modelId: string; params?: Array<{ id: string; value: string; }>; } | null,
      expected?: import('../shared/chatSurface').SessionHarnessModelExpected
    ): Promise<{ ok: boolean; error?: string; warning?: string; applied?: 'immediate' | 'next-turn' | 'next-reconnect'; }> =>
      ipcRenderer.invoke('agentSession:setModel', { sessionId, model, ...(expected ? { expected } : {}) }),
    setThinking: (
      sessionId: string,
      level: import('../shared/types').GuiThinkingLevel | null
    ): Promise<{ ok: boolean; error?: string; applied?: 'immediate' | 'next-turn' | 'next-reconnect'; }> =>
      ipcRenderer.invoke('agentSession:setThinking', { sessionId, level }),
    planAction: (
      sessionId: string,
      action: 'execute' | 'abandon'
    ): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('agentSession:planAction', { sessionId, action }),
    search: (sessionId: string, query: string, name: string, requestId: string): Promise<import('../shared/chatSearch').ChatSearchOutcome<import('../shared/chatSearch').ChatSearchHit[]>> =>
      ipcRenderer.invoke('agentSession:search', sessionId, query, name, requestId),
    searchCancel: (requestId: string): Promise<void> => ipcRenderer.invoke('agentSession:searchCancel', requestId),
    injectionDetails:(sessionId:string,reference:import('../shared/guiHistoryMetadata').GuiInjectionDetailRef):Promise<import('../shared/guiHistoryMetadata').GuiInjectionDetailsResult>=>
      ipcRenderer.invoke('agentSession:injectionDetails',sessionId,reference),
    engineInput: (sessionId: string, messageId: string, ref: string): Promise<string | null> =>
      ipcRenderer.invoke('agentSession:engineInput', sessionId, messageId, ref),
    modelRequestRecording: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('agentSession:modelRequestRecording', sessionId),
    setModelRequestRecording: (sessionId: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('agentSession:setModelRequestRecording', sessionId, enabled),
    modelRequests: (sessionId: string, before?: number): Promise<import('../shared/modelRequest').ModelRequestRow[]> =>
      ipcRenderer.invoke('agentSession:modelRequests', sessionId, before),
    modelRequestBody: (sessionId: string, id: number): Promise<string | null> =>
      ipcRenderer.invoke('agentSession:modelRequestBody', sessionId, id),
    exportModelRequests: (sessionId: string, id?: number): Promise<import('../shared/modelRequest').ModelRequestExportResult> =>
      ipcRenderer.invoke('agentSession:exportModelRequests', sessionId, id),
    modelRequestCompression: (sessionId: string, id: number): Promise<import('../shared/modelRequest').RequestCompression[]> =>
      ipcRenderer.invoke('agentSession:modelRequestCompression', sessionId, id),
    modelRequestSource: (sessionId: string, id: number, source: string, offset: number): Promise<{ text: string; next: number | null } | null> =>
      ipcRenderer.invoke('agentSession:modelRequestSource', sessionId, id, source, offset),
    metadataTimeline:(sessionId:string,kind:import('../shared/guiHistoryMetadata').GuiMetadataKind,before?:number,limit?:number):Promise<import('../shared/guiHistoryMetadata').GuiMetadataTimelineResult>=>
      ipcRenderer.invoke('agentSession:metadataTimeline',sessionId,kind,before,limit),
    replayMaterial: (sessionId: string, beforeMessageIds?: readonly string[]): Promise<import('../shared/sessionReplay').SessionReplayMaterial> =>
      ipcRenderer.invoke('agentSession:replayMaterial', sessionId, beforeMessageIds),
    historyRange: (sessionId: string, before?: number, limit?: number, targetMessageId?: string): Promise<import('../shared/guiWorker').GuiWorkerHistoryPage | null> =>
      ipcRenderer.invoke('agentSession:getHistoryRange', sessionId, before, limit, targetMessageId),
    clear: (sessionId: string): Promise<{ ok: boolean; }> =>
      ipcRenderer.invoke('agentSession:clear', sessionId),
    cancelQueued: (sessionId: string, messageId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('agentSession:cancelQueued', { sessionId, messageId }),
    editQueued: (sessionId: string, messageId: string, text: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('agentSession:editQueued', { sessionId, messageId, text }),
    reorderQueued: (sessionId: string, orderedIds: string[]): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('agentSession:reorderQueued', { sessionId, orderedIds }),
    fork: (
      sessionId: string,
      uptoMessageId?: string
    ): Promise<import('../shared/guiWorker').GuiWorkerForkResult> =>
      ipcRenderer.invoke('agentSession:fork', { sessionId, uptoMessageId })
  },
  bgTasks: {
    list: (sessionId: string): Promise<import('../shared/backgroundTasks').BgTaskListResult> =>
      ipcRenderer.invoke('bgTasks:list', sessionId),
    kill: (taskId: string): Promise<boolean> => ipcRenderer.invoke('bgTasks:kill', taskId),
    remove: (taskId: string): Promise<boolean> => ipcRenderer.invoke('bgTasks:remove', taskId),
    clearFinished: (sessionId: string): Promise<number> =>
      ipcRenderer.invoke('bgTasks:clearFinished', sessionId),
    markRead: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('bgTasks:markRead', sessionId),
    /** 订阅子代理消息整包（面板打开时才要；关着推的每一包都白扔） */
    subscribeMessages: (sessionId: string, on: boolean): Promise<boolean> =>
      ipcRenderer.invoke('bgTasks:subscribeMessages', sessionId, on)
  },
  workflow: {
    overview: (workspaceId: string): Promise<import('../shared/workflow').WorkflowOverview> =>
      ipcRenderer.invoke('workflow:overview', workspaceId),
    /** 答复问用户的问题（answer：单选为选项原文，多选为数组，自由作答为文字） */
    answer: (workspaceId: string, runId: string, askId: string, answer: string | string[]): Promise<boolean> =>
      ipcRenderer.invoke('workflow:answer', workspaceId, runId, askId, answer),
    cancel: (workspaceId: string, runId: string, closeSessions: boolean): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('workflow:cancel', workspaceId, runId, closeSessions),
    trust: (workspaceId: string, name: string): Promise<boolean> => ipcRenderer.invoke('workflow:trust', workspaceId, name),
    revokeTrust: (workspaceId: string, name: string): Promise<boolean> =>
      ipcRenderer.invoke('workflow:revokeTrust', workspaceId, name),
    /** 停用 / 启用该工作流的定时与事件触发（文件不动） */
    setTriggers: (workspaceId: string, name: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('workflow:setTriggers', workspaceId, name, enabled),
    /** 删除工作流目录（移到系统回收站；有运行中的 run 时拒绝） */
    delete: (workspaceId: string, name: string): Promise<boolean> => ipcRenderer.invoke('workflow:delete', workspaceId, name),
    /** 清理运行历史：只删已结束的 run（不给 runIds 即全部），返回删除条数 */
    clearRuns: (workspaceId: string, runIds?: string[]): Promise<number> =>
      ipcRenderer.invoke('workflow:clearRuns', workspaceId, runIds)
  },
  chat: {
    send: (
      text: string,
      workspaceId?: string,
      images?: import('../shared/types').ChatImageAttachment[]
    ): Promise<{ accepted: boolean; error?: string; }> =>
      ipcRenderer.invoke('chat:send', text, workspaceId, images),
    retry: (workspaceId?: string): Promise<{ accepted: boolean; error?: string; }> =>
      ipcRenderer.invoke('chat:retry', workspaceId),
    recallAborted: (
      messageId?: string,
      workspaceId?: string
    ): Promise<{
      ok: boolean;
      text?: string;
      images?: import('../shared/types').ChatImageAttachment[];
      error?: string;
    }> => ipcRenderer.invoke('chat:recallAborted', messageId, workspaceId),
    stop: (workspaceId?: string): Promise<{ stopped: boolean; }> =>
      ipcRenderer.invoke('chat:stop', workspaceId),
    compact: (
      instructions?: string,
      workspaceId?: string
    ): Promise<import('../shared/piEvents').PiCompactResult> =>
      ipcRenderer.invoke('chat:compact', instructions, workspaceId),
    cancelQueued: (messageId: string, workspaceId?: string): Promise<boolean> =>
      ipcRenderer.invoke('chat:cancelQueued', messageId, workspaceId),
    sendNow: (
      text: string,
      workspaceId?: string
    ): Promise<import('../shared/chatSurface').SendNowResult> =>
      ipcRenderer.invoke('chat:sendNow', text, workspaceId),
    editQueued: (messageId: string, text: string, workspaceId?: string): Promise<boolean> =>
      ipcRenderer.invoke('chat:editQueued', messageId, text, workspaceId),
    reorderQueued: (orderedIds: string[], workspaceId?: string): Promise<boolean> =>
      ipcRenderer.invoke('chat:reorderQueued', orderedIds, workspaceId),
    getMode: (workspaceId?: string): Promise<import('../shared/types').AgentMode> =>
      ipcRenderer.invoke('chat:getMode', workspaceId),
    setMode: (
      mode: import('../shared/types').AgentMode,
      workspaceId?: string
    ): Promise<import('../shared/types').AgentMode> =>
      ipcRenderer.invoke('chat:setMode', mode, workspaceId),
    planAction: (
      action: 'execute' | 'abandon',
      workspaceId?: string
    ): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('chat:planAction', action, workspaceId),
    search: (workspaceId: string, query: string, name: string, requestId: string): Promise<import('../shared/chatSearch').ChatSearchOutcome<import('../shared/chatSearch').ChatSearchHit[]>> =>
      ipcRenderer.invoke('chat:search', workspaceId, query, name, requestId),
    searchCancel: (requestId: string): Promise<void> => ipcRenderer.invoke('chat:searchCancel', requestId),
    historyRange: (
      workspaceId?: string,
      before?: number,
      limit?: number,
      targetMessageId?: string
    ): Promise<import('../shared/chatSurface').ChatHistoryPage> =>
      ipcRenderer.invoke('chat:historyRange', workspaceId, before, limit, targetMessageId),
    state: (workspaceId?: string): Promise<{ busy: boolean }> =>
      ipcRenderer.invoke('chat:state', workspaceId),
    sessionsList: (
      workspaceId?: string
    ): Promise<import('../shared/types').AgentSessionSummary[]> =>
      ipcRenderer.invoke('chat:sessions:list', workspaceId),
    sessionOpen: (
      workspaceId: string,
      sessionFile: string
    ): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('chat:session:open', workspaceId, sessionFile),
    sessionRename: (
      workspaceId: string,
      sessionFile: string,
      name: string
    ): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('chat:session:rename', workspaceId, sessionFile, name),
    sessionDelete: (
      workspaceId: string,
      sessionFile: string
    ): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('chat:session:delete', workspaceId, sessionFile),
    fork: (
      messageId: string,
      workspaceId?: string
    ): Promise<{ ok: boolean; sessionFile?: string; originalSessionFile?: string; error?: string; }> =>
      ipcRenderer.invoke('chat:fork', messageId, workspaceId),
    context: (workspaceId?: string) =>
      ipcRenderer.invoke('chat:context', workspaceId),
    switchModel: (
      model: { providerId: string; modelId: string; } | null,
      workspaceId?: string,
      options?: import('../shared/harnessPicker').SetDispatchModelConfigurationOptions
    ): Promise<{ ok: boolean; error?: string; thinkingReset?: boolean; thinkingUnknown?: boolean; applied?: import('../shared/sessionModelChange').SessionChangeApplied; warning?: string; }> => ipcRenderer.invoke('chat:switchModel', model, workspaceId, options),
    setThinking: (
      level: string | null,
      workspaceId?: string
    ): Promise<{
      ok: boolean;
      error?: string;
      thinkingLevel: string | null;
      available: boolean;
    }> => ipcRenderer.invoke('chat:setThinking', level, workspaceId),
    clear: (workspaceId?: string) =>
      ipcRenderer.invoke('chat:clear', workspaceId),
    respondUserQuestion: (args: {
      workspaceId?: string;
      questionId: string;
      action: 'answer' | 'abort';
      answers?: Array<{ id: string; selected: string[]; custom?: string; }>;
    }): Promise<{ ok: boolean; }> => ipcRenderer.invoke('chat:respondUserQuestion', args)
  },
  agent: {
    listSkills: (workspaceId?: string, target?: CapabilityTargetId, sessionId?: string, rootId?: string): Promise<{ skills: AgentSkillInfo[]; error?: string; }> =>
      ipcRenderer.invoke('agent:listSkills', workspaceId, target, sessionId, rootId)
  },
  usage: {
    summary: (
      query?: import('../shared/usageStats').UsageSummaryQuery
    ): Promise<import('../shared/usageStats').UsageSummary> =>
      ipcRenderer.invoke('usage:summary', query),
    llmCall: (
      id: string
    ): Promise<import('../shared/usageStats').UsageLlmCall | null> =>
      ipcRenderer.invoke('usage:llm-call', id)
  },
  evidence: {
    /** 会话证据索引（时间线数据源；无归档返回 null） */
    getIndex: (
      sessionId: string
    ): Promise<import('../shared/evidence').EvidenceIndex | null> =>
      ipcRenderer.invoke('evidence:index', sessionId),
    /** pty 切片正文（展开时懒加载；条目不在索引返回 null） */
    entryText: (
      sessionId: string,
      entryId: string
    ): Promise<{ text: string; } | null> =>
      ipcRenderer.invoke('evidence:entryText', sessionId, entryId),
    /** browser 截图（data URL；条目不在索引返回 null） */
    entryImage: (
      sessionId: string,
      entryId: string
    ): Promise<{ dataUrl: string; } | null> =>
      ipcRenderer.invoke('evidence:entryImage', sessionId, entryId)
  },
  textTools: {
    run: (req: import('../shared/types').TextToolRunRequest): Promise<import('../shared/types').TextToolRunResult> =>
      ipcRenderer.invoke('textTools:run', req)
  },
  services: {
    list: (workspaceId?: string) => ipcRenderer.invoke('services:list', workspaceId),
    get: (serviceId: string) => ipcRenderer.invoke('services:get', serviceId),
    runs: (serviceId: string): Promise<{ runs: import('../shared/types').TaskRun[]; }> =>
      ipcRenderer.invoke('services:runs', serviceId),
    create: (options: unknown) => ipcRenderer.invoke('services:create', options),
    update: (serviceId: string, patch: unknown) =>
      ipcRenderer.invoke('services:update', serviceId, patch),
    runNow: (serviceId: string) => ipcRenderer.invoke('services:runNow', serviceId),
    enable: (serviceId: string) => ipcRenderer.invoke('services:enable', serviceId),
    disable: (serviceId: string) => ipcRenderer.invoke('services:disable', serviceId),
    delete: (serviceId: string) => ipcRenderer.invoke('services:delete', serviceId)
  },
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
    waitingTips: (): Promise<import('../shared/waitingTips').WaitingTipsResult> => ipcRenderer.invoke('config:waitingTips'),
    update: (patch: Partial<AppConfig>): Promise<AppConfig> =>
      ipcRenderer.invoke('config:update', patch),
    testLlm: (provider: {
      baseUrl: string;
      apiKey: string;
      model?: string;
      api?: import('../shared/types').LlmApiProtocol;
    }): Promise<import('../shared/types').LlmTestResult> =>
      ipcRenderer.invoke('config:testLlm', provider),
    /** pi-ai 内置目录（添加供应商/模型徽章数据源）；null = 目录不可用，UI 回落静态 preset */
    piCatalog: (): Promise<import('../shared/piCatalog').PiCatalogView | null> =>
      ipcRenderer.invoke('config:piCatalog'),
    coreModelInput: (selection: { providerId: string; modelId: string }): Promise<{ supportsImages: boolean }> =>
      ipcRenderer.invoke('config:coreModelInput', selection),
    providerModelCatalog: (provider: import('../shared/providerModelCatalog').ProviderModelCatalogRequest, refresh = false): Promise<import('../shared/providerModelCatalog').ProviderModelCatalogResult> =>
      ipcRenderer.invoke('config:providerModelCatalog', provider, refresh)
  },
  inboundMcp: {
    status: (): Promise<import('../shared/inboundMcp').InboundMcpSetupStatus> => ipcRenderer.invoke('inboundMcp:status'),
    install: (): Promise<import('../shared/inboundMcp').InboundMcpSetupStatus> => ipcRenderer.invoke('inboundMcp:install')
  },
  webAccess: {
    status: (): Promise<import('../shared/webAccess').WebAccessStatusInfo> =>
      ipcRenderer.invoke('webAccess:status'),
    rotate: (): Promise<{
      ok: boolean;
      status?: import('../shared/webAccess').WebAccessStatusInfo;
      error?: string;
    }> => ipcRenderer.invoke('webAccess:rotate'),
    /** T3.2：重新生成 webhook 触发 token（旧 hook 地址失效） */
    rotateHook: (): Promise<{
      ok: boolean;
      status?: import('../shared/webAccess').WebAccessStatusInfo;
      error?: string;
    }> => ipcRenderer.invoke('webAccess:rotateHook'),
    /** T3.2：设置/清除 GitHub 签名密钥（空串 = 关闭签名校验） */
    setHookSecret: (
      secret: string
    ): Promise<{
      ok: boolean;
      status?: import('../shared/webAccess').WebAccessStatusInfo;
      error?: string;
    }> => ipcRenderer.invoke('webAccess:setHookSecret', secret)
  },
  messaging: {
    status: (): Promise<import('../shared/messaging').MessagingStatus> => ipcRenderer.invoke('messaging:status'),
    call: (channel: string, method: string, payload: unknown, requestId?: string): Promise<import('../shared/messaging').MessagingRpcResult> =>
      ipcRenderer.invoke('messaging:call', channel, method, payload, requestId),
    cancel: (requestId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('messaging:cancel', requestId)
  },
  catalog: {
    get: (): Promise<CapabilityCatalogInfo> => ipcRenderer.invoke('catalog:get')
  },
  capabilities: {
    get: (): Promise<CapabilitiesView> => ipcRenderer.invoke('capabilities:get')
  },
  processMonitor: {
    snapshot: (): Promise<import('../shared/processMonitor').ProcessMonitorSnapshot> =>
      ipcRenderer.invoke('processMonitor:snapshot'),
    capture: (): Promise<import('../shared/processMonitor').ProcessMonitorSnapshot> =>
      ipcRenderer.invoke('processMonitor:capture'),
    cpuProfile: (pid: number, durationMs = 3000): Promise<import('../shared/processMonitor').ProcessMonitorProfileResult> =>
      ipcRenderer.invoke('processMonitor:cpuProfile', { pid, durationMs }),
    cpuStart: (pid: number): Promise<import('../shared/processMonitor').ProcessMonitorCpuStartResult> =>
      ipcRenderer.invoke('processMonitor:cpuStart', { pid }),
    cpuStop: (pid: number): Promise<import('../shared/processMonitor').ProcessMonitorProfileResult> =>
      ipcRenderer.invoke('processMonitor:cpuStop', { pid }),
    heapSnapshot: (pid: number): Promise<import('../shared/processMonitor').ProcessMonitorProfileResult> =>
      ipcRenderer.invoke('processMonitor:heapSnapshot', { pid }),
    openArtifact: (path: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('processMonitor:openArtifact', { path })
  },
  runtimes: {
    list: (): Promise<AgentRuntimeEntry[]> => ipcRenderer.invoke('runtimes:list'),
    register: (manifest: import('../shared/types').RegisterRuntimeManifestArgs): Promise<import('../shared/types').RuntimeMutationResult> => ipcRenderer.invoke('runtimes:register', manifest),
    availability: (force?: boolean): Promise<import('../shared/runtimeAvailability').RuntimeAvailabilitySnapshot> => ipcRenderer.invoke('runtimes:availability', force === true),
    get: (id: string): Promise<AgentRuntimeDetail> => ipcRenderer.invoke('runtimes:get', id),
    update: (args: UpdateRuntimeArgs): Promise<RuntimeMutationResult> =>
      ipcRenderer.invoke('runtimes:update', args),
    remove: (id: string): Promise<RuntimeMutationResult> =>
      ipcRenderer.invoke('runtimes:remove', id),
    restoreBuiltins: (ids?: string[]): Promise<RuntimeMutationResult> =>
      ipcRenderer.invoke('runtimes:restoreBuiltins', ids),
    clearDetectHooks: (): Promise<{
      ok: boolean;
      cancelled?: boolean;
      removed?: number;
      files?: string[];
      error?: string;
    }> => ipcRenderer.invoke('runtimes:clearDetectHooks'),
    preflight: (id?: string): Promise<RuntimePreflightReply> =>
      ipcRenderer.invoke('runtimes:preflight', id ? { id } : {}),
    setExternalPiExecutable: (args: { id: 'pi-external' | 'omp'; executable: string }): Promise<{ ok: true; externalPi?: AppConfig['externalPi'] } | { ok: false; error: string }> => ipcRenderer.invoke('runtimes:setExternalPiExecutable', args),
    setExternalHarnessExecutable: (args: { id: 'muse-gui' | 'zcode-gui'; executable: string }): Promise<{ ok: true; externalHarness?: AppConfig['externalHarness'] } | { ok: false; error: string }> => ipcRenderer.invoke('runtimes:setExternalHarnessExecutable', args),
  },
  workspaces: {
    replyClosePrepare: (requestId: string, payload: { ok: true } | { ok: false; error: string }) => ipcRenderer.send(`workspace:close-prepare:${requestId}`, payload),
    replyCloseFinish: (requestId: string, payload: { ok: true } | { ok: false; error: string }) => ipcRenderer.send(`workspace:close-finish:${requestId}`, payload),
    getWorktreePreparation: (workspaceId: string): Promise<import('../shared/worktreePreparation').WorktreePreparationSnapshot> => ipcRenderer.invoke('workspaces:getWorktreePreparation', workspaceId),
    saveWorktreePreparation: (input: import('../shared/worktreePreparation').WorktreePreparationUpdate): Promise<import('../shared/worktreePreparation').WorktreePreparationSnapshot> => ipcRenderer.invoke('workspaces:saveWorktreePreparation', input),
    list: (): Promise<{ workspaces: WorkspaceInfo[]; activeWorkspaceId: string; recommendedRoot: string; recommendedName: string; }> =>
      ipcRenderer.invoke('workspaces:list'),
    pickDir: (multiple?: boolean): Promise<{ ok: boolean; path?: string; paths?: string[]; message?: string; }> =>
      ipcRenderer.invoke('workspaces:pickDir', multiple),
    open: (arg?: string | WorkspaceOpenOptions): Promise<WorkspaceSwitchResult> =>
      ipcRenderer.invoke('workspaces:open', arg),
    switch: (id: string): Promise<WorkspaceSwitchResult> =>
      ipcRenderer.invoke('workspaces:switch', id),
    update: (id: string, opts: WorkspaceUpdateOptions): Promise<WorkspaceSwitchResult> =>
      ipcRenderer.invoke('workspaces:update', id, opts),
    close: (id: string): Promise<WorkspaceSwitchResult> =>
      ipcRenderer.invoke('workspaces:close', id),
    listFiles: (
      workspaceId?: string,
      query?: string,
      requestId?: string
    ): Promise<{ files: WorkspaceFileEntry[]; } & Partial<WorkspaceQueryResult<WorkspaceListedFile>>> =>
      ipcRenderer.invoke('workspace:listFiles', workspaceId, query, requestId)
  },
  workspaceBookmarks: {
    read: (workspaceId: string): Promise<import('../shared/bookmarks').WorkspaceBookmarksResult> =>
      ipcRenderer.invoke('workspaceBookmarks:read', workspaceId),
    change: (workspaceId: string, change: import('../shared/bookmarks').BookmarkChange): Promise<import('../shared/bookmarks').WorkspaceBookmarksResult> =>
      ipcRenderer.invoke('workspaceBookmarks:change', workspaceId, change)
  },
  workspaceFile: {
    get: (): Promise<WorkspaceFileGetResult> => ipcRenderer.invoke('workspaceFile:get'),
    getForWorkspace: (workspaceId: string): Promise<WorkspaceFileGetResult> => ipcRenderer.invoke('workspaceFile:get-for-workspace', workspaceId),
    patch: (
      partial: Partial<WorkspaceFileConfig>,
      workspaceId: string
    ): Promise<WorkspaceFilePatchResult> =>
      ipcRenderer.invoke('workspaceFile:patch', partial, workspaceId)
  },
  memoryCurator: {
    setArchived: (workspaceId:string,candidateId:string,archived:boolean):Promise<{changed:boolean}> => ipcRenderer.invoke('memoryCurator:setArchived',workspaceId,candidateId,archived),
    inspect: (workspaceId:string,input?:import('../shared/memoryCurator').MemoryCuratorQueueQuery):Promise<import('../shared/memoryCurator').MemoryCuratorQueuePage> => ipcRenderer.invoke('memoryCurator:inspect',workspaceId,input),
    state: (workspaceId:string):Promise<import('../shared/memoryCurator').MemoryCuratorSnapshot> => ipcRenderer.invoke('memoryCurator:state',workspaceId),
    send: (workspaceId:string,text:string):Promise<{accepted:boolean}> => ipcRenderer.invoke('memoryCurator:send',workspaceId,text),
    setPaused: (workspaceId:string,paused:boolean):Promise<import('../shared/memoryCurator').MemoryCuratorSnapshot> => ipcRenderer.invoke('memoryCurator:setPaused',workspaceId,paused),
    clear: (workspaceId:string):Promise<import('../shared/memoryCurator').MemoryCuratorSnapshot> => ipcRenderer.invoke('memoryCurator:clear',workspaceId),
    onChanged: (listener:(snapshot:import('../shared/memoryCurator').MemoryCuratorSnapshot)=>void):(()=>void) => {
      const wrapped=(_event:unknown,snapshot:import('../shared/memoryCurator').MemoryCuratorSnapshot)=>listener(snapshot);
      ipcRenderer.on('memoryCurator:changed',wrapped);
      return ()=>ipcRenderer.removeListener('memoryCurator:changed',wrapped);
    }
  },
  knowledge: {
    maintenance: (workspaceId:string,input:import('../shared/knowledge').KnowledgeMaintenanceInput):Promise<import('../shared/knowledge').KnowledgeMaintenanceResult> => ipcRenderer.invoke('knowledge:maintenance',workspaceId,input),
    historySources: (workspaceId:string):Promise<import('../shared/knowledge').KnowledgeHistorySource[]> => ipcRenderer.invoke('knowledge:historySources',workspaceId),
    history: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['history']>[0]):ReturnType<import('../shared/knowledge').KnowledgeApi['history']> => ipcRenderer.invoke('knowledge:history',workspaceId,input),
    govern: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['govern']>[0]):Promise<import('../shared/knowledge').KnowledgeGovernanceReceipt> => ipcRenderer.invoke('knowledge:govern',workspaceId,input),
    undoGovernance: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['undoGovernance']>[0]):Promise<void> => ipcRenderer.invoke('knowledge:undoGovernance',workspaceId,input),
    create: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['create']>[0]):Promise<import('../shared/knowledge').KnowledgeWriteResult> => ipcRenderer.invoke('knowledge:create',workspaceId,input),
    process: (workspaceId:string):Promise<void> => ipcRenderer.invoke('knowledge:process',workspaceId),
    restore: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['restore']>[0]):Promise<import('../shared/knowledge').KnowledgeRecord> => ipcRenderer.invoke('knowledge:restore',workspaceId,input),
    list: (workspaceId:string,input?:import('../shared/knowledge').KnowledgeListQuery):Promise<import('../shared/knowledge').KnowledgeSnapshot> => ipcRenderer.invoke('knowledge:list',workspaceId,input),
    search: (workspaceId:string,input:import('../shared/knowledge').KnowledgeQuery):Promise<import('../shared/knowledge').KnowledgeHit[]> => ipcRenderer.invoke('knowledge:search',workspaceId,input),
    decide: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['decide']>[0]):Promise<import('../shared/knowledge').KnowledgeRecord> => ipcRenderer.invoke('knowledge:decide',workspaceId,input),
    revise: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['revise']>[0]):Promise<import('../shared/knowledge').KnowledgeRecord> => ipcRenderer.invoke('knowledge:revise',workspaceId,input),
    confirm: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['confirm']>[0]):Promise<import('../shared/knowledge').KnowledgeRecord> => ipcRenderer.invoke('knowledge:confirm',workspaceId,input),
    promoteHost: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['promoteHost']>[0]):Promise<import('../shared/knowledge').KnowledgeRecord> => ipcRenderer.invoke('knowledge:promoteHost',workspaceId,input),
    supersede: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['supersede']>[0]):Promise<import('../shared/knowledge').KnowledgeRecord> => ipcRenderer.invoke('knowledge:supersede',workspaceId,input),
    evidence: (workspaceId:string,input:Parameters<import('../shared/knowledge').KnowledgeApi['evidence']>[0]):Promise<import('../shared/knowledge').KnowledgeEvidenceView> => ipcRenderer.invoke('knowledge:evidence',workspaceId,input)
  },
  // X4-F06：memory:get/saveEntry/forget/restore 已随死组件树（MemoryPanel/
  // MemoryCenterTabs）一并删除——主进程 registerMemoryIpc 从未接线（见
  // src/main/ipc/memory.ts 头注，D10 记忆主链裁定）
  memoryCenter: {
    // X4-F06：保留 6 个已注册通道 + 4 个 MemoryOverview 活调用通道（X4-F01/D10）；
    // 其余 15 个无注册、死树独占的死暴露已删
    log: (): Promise<MemoryCenterLogResult> => ipcRenderer.invoke('memoryCenter:log'),
    recycle: (): Promise<MemoryCenterRecycleResult> => ipcRenderer.invoke('memoryCenter:recycle'),
    badge: (): Promise<MemoryCenterBadgeResult> => ipcRenderer.invoke('memoryCenter:badge'),
    intents: (): Promise<MemoryCenterIntentsResult> => ipcRenderer.invoke('memoryCenter:intents'),
    intentCancel: (id: number): Promise<MemoryCenterIntentMutateResult> =>
      ipcRenderer.invoke('memoryCenter:intentCancel', id),
    intentRearm: (id: number): Promise<MemoryCenterIntentMutateResult> =>
      ipcRenderer.invoke('memoryCenter:intentRearm', id),
    events: (opts?: MemoryCenterEventsOptions): Promise<MemoryCenterEventsResult> =>
      ipcRenderer.invoke('memoryCenter:events', opts),
    stagingList: (opts?: { ttlDays?: number; }): Promise<MemoryCenterStagingResult> =>
      ipcRenderer.invoke('memoryCenter:stagingList', opts)
  },
  fs: {
    openFile: (ref: WorkspaceFileRef, viewId: string): Promise<{ ok: boolean; error?: string; }> => ipcRenderer.invoke('fs:openFile', ref, viewId),
    closeFile: (viewId: string): Promise<{ ok: boolean; }> => ipcRenderer.invoke('fs:closeFile', viewId),
    openBrowserPreview: (ref: WorkspaceFileRef): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('fs:openBrowserPreview', ref),
    createPreview: (ref: WorkspaceFileRef): Promise<{ ok: boolean; token?: string; path?: string; error?: string; }> => ipcRenderer.invoke('fs:createPreview', ref),
    releasePreview: (token: string): Promise<{ ok: boolean; }> => ipcRenderer.invoke('fs:releasePreview', token),
    listFiles: (workspaceId: string, opts?: WorkspaceQueryOptions): Promise<WorkspaceQueryResult<WorkspaceListedFile>> =>
      ipcRenderer.invoke('fs:listFiles', workspaceId, opts),
    searchFiles: (workspaceId: string, opts: WorkspaceQueryOptions): Promise<WorkspaceQueryResult<WorkspaceSearchHit>> =>
      ipcRenderer.invoke('fs:searchFiles', workspaceId, opts),
    cancelQuery: (workspaceId: string, requestId: string): Promise<{ cancelled: boolean; }> =>
      ipcRenderer.invoke('fs:cancelQuery', workspaceId, requestId),
    refreshWatch: (workspaceId: string, rootId: string): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('fs:refreshWatch', workspaceId, rootId),
    resolveRef: (workspaceId: string, filePath: string): Promise<{ ok: true; fileRef: WorkspaceFileRef; } | { ok: false; error: string; reason?: string; }> =>
      ipcRenderer.invoke('fs:resolveRef', workspaceId, filePath),
    listDirRef: (ref: WorkspaceFileRef): Promise<{ entries: FsDirEntry[]; error?: string; watchError?: string; }> =>
      ipcRenderer.invoke('fs:listDir', ref),
    listTreeDirRef: (ref: WorkspaceFileRef): Promise<{ entries: FsDirEntry[]; error?: string; watchError?: string; }> =>
      ipcRenderer.invoke('fs:listTreeDir', ref),
    listTreeDir: (workspaceId: string | undefined, dirRel?: string): Promise<{ entries: FsDirEntry[]; error?: string; watchError?: string; }> =>
      ipcRenderer.invoke('fs:listTreeDir', workspaceId, dirRel),
    readTextRef: (ref: WorkspaceFileRef): Promise<FsReadResult> =>
      ipcRenderer.invoke('fs:readText', ref),
    writeTextRef: (ref: WorkspaceFileRef, content: string, expectedMtimeMs?: number | null): Promise<FsWriteResult> =>
      ipcRenderer.invoke('fs:writeText', ref, ref.relativePath, content, expectedMtimeMs ?? null),
    removeRef: (ref: WorkspaceFileRef): Promise<FsWriteResult> => ipcRenderer.invoke('fs:remove', ref),
    statRef: (ref: WorkspaceFileRef): Promise<FsStatResult> => ipcRenderer.invoke('fs:stat', ref),
    listDir: (
      workspaceId: string | undefined,
      dirRel?: string
    ): Promise<{ entries: FsDirEntry[]; error?: string; watchError?: string; }> =>
      ipcRenderer.invoke('fs:listDir', workspaceId, dirRel),
    readText: (workspaceId: string | undefined, filePath: string): Promise<FsReadResult> =>
      ipcRenderer.invoke('fs:readText', workspaceId, filePath),
    /** 工作区外文件的只读预览（绝对路径；无写通道） */
    readExternal: (absPath: string): Promise<FsReadResult> =>
      ipcRenderer.invoke('fs:readExternal', absPath),
    writeText: (
      workspaceId: string | undefined,
      filePath: string,
      content: string,
      expectedMtimeMs?: number | null
    ): Promise<FsWriteResult> =>
      ipcRenderer.invoke('fs:writeText', workspaceId, filePath, content, expectedMtimeMs ?? null),
    remove: (workspaceId: string | undefined, filePath: string): Promise<FsWriteResult> =>
      ipcRenderer.invoke('fs:remove', workspaceId, filePath),
    stat: (workspaceId: string | undefined, filePath: string): Promise<FsStatResult> =>
      ipcRenderer.invoke('fs:stat', workspaceId, filePath),
    listPaths: (
      workspaceId: string | undefined,
      opts?: FsListPathsOptions
    ): Promise<{ paths: string[]; error?: string; }> =>
      ipcRenderer.invoke('fs:listPaths', workspaceId, opts),
    searchText: (
      workspaceId: string | undefined,
      opts: FsSearchTextOptions
    ): Promise<{ hits: FsSearchHit[]; error?: string; }> =>
      ipcRenderer.invoke('fs:searchText', workspaceId, opts)
  },
  git: {
    invokeScoped: <M extends keyof GitScopedOperations>(scope: GitOperationScope, method: M, ...args: Parameters<GitScopedOperations[M]>): ReturnType<GitScopedOperations[M]> =>
      ipcRenderer.invoke('git:invokeScoped', scope, method, args) as ReturnType<GitScopedOperations[M]>,
    listRepos: (forceRescan?: boolean, requestedPaths?: string[], workspaceId?: string): Promise<GitRepoSummary[]> =>
      ipcRenderer.invoke('git:listRepos', forceRescan, requestedPaths, workspaceId),
    listReposDetailed: (forceRescan?: boolean, requestedPaths?: string[], workspaceId?: string): Promise<GitRepoListResult> =>
      ipcRenderer.invoke('git:listReposDetailed', forceRescan, requestedPaths, workspaceId),
    listRepoLocations: (forceRescan?: boolean, workspaceId?: string, requestedPaths?: string[]): Promise<GitRepoLocationListResult> =>
      ipcRenderer.invoke('git:listRepoLocations', forceRescan, workspaceId, requestedPaths),
    status: (repoPath: string): Promise<GitRepoStatus> =>
      ipcRenderer.invoke('git:status', repoPath),
    log: (
      repoPath: string,
      skip?: number,
      limit?: number,
      ref?: string
    ): Promise<GitLogPage> => ipcRenderer.invoke('git:log', repoPath, skip, limit, ref),
    diff: (
      repoPath: string,
      filePath: string,
      staged?: boolean,
      untracked?: boolean
    ): Promise<GitDiffResult> =>
      ipcRenderer.invoke('git:diff', repoPath, filePath, staged, untracked),
    commitFiles: (repoPath: string, sha: string): Promise<GitCommitFilesResult> =>
      ipcRenderer.invoke('git:commitFiles', repoPath, sha),
    commitDiff: (
      repoPath: string,
      sha: string,
      filePath: string
    ): Promise<GitCommitDiffResult> =>
      ipcRenderer.invoke('git:commitDiff', repoPath, sha, filePath),
    stage: (repoPath: string, paths: string[]): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:stage', repoPath, paths),
    unstage: (repoPath: string, paths: string[]): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:unstage', repoPath, paths),
    discard: (repoPath: string, paths: string[], mode?: import('../shared/types').GitDiscardMode): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:discard', repoPath, paths, mode),
    stageAll: (repoPath: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:stageAll', repoPath),
    commit: (repoPath: string, message: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:commit', repoPath, message),
    fetch: (repoPath: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:fetch', repoPath),
    pull: (repoPath: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:pull', repoPath),
    push: (repoPath: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:push', repoPath),
    /** 推送指定分支并建上游（开 PR 专用；worktree 分支通常无 upstream） */
    pushBranch: (repoPath: string, branch: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:pushBranch', repoPath, branch),
    // X4-F06：git:addRepo / git:removeRepo 死暴露已删（渲染层零调用、主进程无注册）
    initRepo: (dirPath?: string): Promise<GitAddRepoResult> =>
      ipcRenderer.invoke('git:initRepo', dirPath),
    workspaceRoot: (): Promise<{ path: string; workspaceId: string; }> =>
      ipcRenderer.invoke('git:workspaceRoot'),
    listBranches: (repoPath: string): Promise<GitBranchList> =>
      ipcRenderer.invoke('git:listBranches', repoPath),
    checkout: (repoPath: string, req: GitCheckoutRequest): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:checkout', repoPath, req),
    worktreeList: (repoPath: string): Promise<GitWorktreeInfo[]> =>
      ipcRenderer.invoke('git:worktreeList', repoPath),
    worktreeAdd: (
      repoPath: string,
      args: { dirName: string; newBranch?: string; branch?: string; baseRef?: string; }
    ): Promise<GitWorktreeAddResult> => ipcRenderer.invoke('git:worktreeAdd', repoPath, args),
    worktreeRemove: (worktreePath: string, force?: boolean): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:worktreeRemove', worktreePath, force),
    adoptPreview: (
      worktreePath: string
    ): Promise<GitAdoptPreviewResult> =>
      ipcRenderer.invoke('git:adoptPreview', worktreePath),
    adoptHunks: (
      worktreePath: string,
      keys: GitAdoptHunkKey[]
    ): Promise<GitAdoptHunksResult> =>
      ipcRenderer.invoke('git:adoptHunks', worktreePath, keys)
  },
  pr: {
    appSetup: (...args) => ipcRenderer.invoke('pr:appSetup', ...args),
    configureApp: (...args) => ipcRenderer.invoke('pr:configureApp', ...args),
    connection: (...args) => ipcRenderer.invoke('pr:connection', ...args),
    authorize: (...args) => ipcRenderer.invoke('pr:authorize', ...args),
    disconnect: (...args) => ipcRenderer.invoke('pr:disconnect', ...args),
    repository: (...args) => ipcRenderer.invoke('pr:repository', ...args),
    list: (...args) => ipcRenderer.invoke('pr:list', ...args),
    detail: (...args) => ipcRenderer.invoke('pr:detail', ...args),
    files: (...args) => ipcRenderer.invoke('pr:files', ...args),
    threads: (...args) => ipcRenderer.invoke('pr:threads', ...args),
    create: (...args) => ipcRenderer.invoke('pr:create', ...args),
    forward: (...args) => ipcRenderer.invoke('pr:forward', ...args),
    draft: (...args) => ipcRenderer.invoke('pr:draft', ...args),
    publish: (...args) => ipcRenderer.invoke('pr:publish', ...args),
    setAutoReview: (...args) => ipcRenderer.invoke('pr:setAutoReview', ...args),
  } satisfies PrApi,
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    /** 等主进程后台启动链完成（IPC 全部注册后 resolve），渲染层水合前 await */
    bootWait: (): Promise<BootResult> => ipcRenderer.invoke('app:boot:wait'),
    /** 启动失败页自救：重启应用 / 打开日志目录（这两条早于启动链注册） */
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
    logDir: (): Promise<string> => ipcRenderer.invoke('app:log-dir'),
    edit: (action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') =>
      ipcRenderer.invoke('app:edit', action),
    runSystemShortcut: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('app:runSystemShortcut', id),
    /** 跟随当前主题的窗口底/标题栏色（renderer/theme.ts 应用主题时同步下发） */
    setChromeTheme: (colors: { panel: string; ink: string; appearance?: 'dark' | 'light'; }): Promise<{ ok: boolean; material?: 'mica' | 'vibrancy' | 'solid'; }> =>
      ipcRenderer.invoke('app:setChromeTheme', colors),
    /** 自定义壁纸：系统选图并复制进 userData/backdrops/，返回落盘路径 */
    pickWallpaper: (): Promise<
      { ok: true; path: string; } | { ok: false; canceled?: boolean; error?: string; }
    > => ipcRenderer.invoke('app:pickWallpaper'),
    captureRect: (rect: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): Promise<string | null> => ipcRenderer.invoke('app:captureRect', rect),
    reportRendererError: (payload: {
      label: string;
      message: string;
      stack?: string;
      componentStack?: string;
    }): Promise<{ ok: boolean; }> => ipcRenderer.invoke('app:report-renderer-error', payload)
  },
  workbench: {
    panelAppearance: (input: { token: string; appearance: Record<string, unknown> }): Promise<void> => ipcRenderer.invoke('workbench:panelAppearance', input),
    panelPlacement: (input: { token: string; placement: 'center' | 'left' | 'right' | 'window' }): Promise<void> => ipcRenderer.invoke('workbench:panelPlacement', input),
    navigation: (): Promise<import('../shared/extension').ExtensionNavigationSnapshot> => ipcRenderer.invoke('workbench:navigation'),
    saveNavigation: (input: import('../shared/extension').ExtensionNavigationSnapshot): Promise<import('../shared/extension').ExtensionNavigationSnapshot> => ipcRenderer.invoke('workbench:saveNavigation', input)
  },
  extensionSurface: {
    openExtension: (input: { workspaceId: string; extensionId: string; scope?: 'global' | 'project'; surfaceId?: string; sourceRootId?: string; mcpTrust?: 'trusted-once' | 'trusted-persistent' }): Promise<Record<string, unknown>> => ipcRenderer.invoke('extensionSurface:open', input),
    call: (input: import('../shared/extensions').ExtensionPanelCallInput): Promise<unknown> => ipcRenderer.invoke('extensionSurface:call', input),
    reloadExtension: (token: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('extensionSurface:reload', token),
    closeExtension: (token: string): Promise<void> => ipcRenderer.invoke('extensionSurface:close', token)
  },
  extensions: {
    snapshot: (workspaceId: string): Promise<import('../shared/extension').ExtensionManagementSnapshot> => ipcRenderer.invoke('extensions:snapshot', workspaceId),
    preserveTransaction: (input: { workspaceId: string; id: string }): Promise<import('../shared/extension').ExtensionTransactionPreserveResult> => ipcRenderer.invoke('extensions:preserveTransaction', input),
    selectProject: (input: { workspaceId: string; sourceRootId: string }): Promise<import('../shared/extension').ExtensionManagementSnapshot> => ipcRenderer.invoke('extensions:selectProject', input),
    setEnabled: (input: { workspaceId: string; sourceRootId: string; selectionRevision: number; scope: 'global' | 'project'; extensionId: string; enabled: boolean }): Promise<import('../shared/extension').ExtensionManagementSnapshot> => ipcRenderer.invoke('extensions:setEnabled', input),
    setEnabledAll: (input: { workspaceId: string; extensionId: string; enabled: boolean }): Promise<{ ok: true }> => ipcRenderer.invoke('extensions:setEnabledAll', input),
    uninstallGlobal: (input: { workspaceId: string; extensionId: string; fingerprint: string }): Promise<void> => ipcRenderer.invoke('extensions:uninstallGlobal', input),
    toolbar: (workspaceId: string): Promise<{ workspaceId: string; sourceRootId: string; selectionRevision: number; items: import('../shared/extension').ExtensionToolbarItem[] }> => ipcRenderer.invoke('extensions:toolbar', workspaceId),
    runToolbar: (input: { workspaceId: string; sourceRootId: string; selectionRevision: number; extensionId: string; menuId?: string; scope?: 'global' | 'project' }): Promise<import('../shared/extension').ExtensionToolbarRunResult> => ipcRenderer.invoke('extensions:runToolbar', input)
  },
  extensionCatalog: {
    catalog: (): Promise<{ packages: Array<{ extensionId: string; name: string; surfaceKind: 'toolbar' | 'sidebar'; directory: string; fingerprint: string; version?: string; enabled: boolean }>; scan: Array<{ extensionId: string; error: string }> }> => ipcRenderer.invoke('extensionCatalog:catalog'),
    setEnabled: (input: { scope: 'global' | 'project'; extensionId: string; enabled: boolean; workspaceId?: string; sourceRootId?: string }): Promise<{ scope: 'global' | 'project'; extensionId: string; enabled: boolean }> => ipcRenderer.invoke('extensionCatalog:setEnabled', input),
    installLocal: (): Promise<{ canceled: true } | { extensionId: string }> => ipcRenderer.invoke('extensionCatalog:installLocal')
  },
  extensionPublishing: {
    connection: () => ipcRenderer.invoke('extensionPublishing:connection'),
    startLocal: () => ipcRenderer.invoke('extensionPublishing:startLocal'),
    stopLocal: () => ipcRenderer.invoke('extensionPublishing:stopLocal'),
    session: () => ipcRenderer.invoke('extensionPublishing:session'),
    signIn: () => ipcRenderer.invoke('extensionPublishing:signIn'),
    authorizeRepository: () => ipcRenderer.invoke('extensionPublishing:authorizeRepository'),
    mine: () => ipcRenderer.invoke('extensionPublishing:mine'),
    submit: (id, repo) => ipcRenderer.invoke('extensionPublishing:submit', id, repo),
    queue: () => ipcRenderer.invoke('extensionPublishing:queue'),
    review: id => ipcRenderer.invoke('extensionPublishing:review', id),
    trial: id => ipcRenderer.invoke('extensionPublishing:trial', id),
    decide: (id, decision, reason) => ipcRenderer.invoke('extensionPublishing:decide', id, decision, reason),
    previewTarget: () => ipcRenderer.invoke('extensionPublishing:previewTarget'),
  } satisfies import('../shared/extensionPublishing').ExtensionPublishingApi as import('../shared/extensionPublishing').ExtensionPublishingApi,
  extensionCenter: {
    list: (force = false): Promise<import('../shared/extensionCenter').ExtensionCenterListing> => ipcRenderer.invoke('extensionCenter:list', force),
    install: (packageKey: string): Promise<import('../shared/extensionCenter').ExtensionCenterInstallResult> => ipcRenderer.invoke('extensionCenter:install', { packageKey }),
    uninstall: (packageKey: string): Promise<import('../shared/extensionCenter').ExtensionCenterUninstallResult> => ipcRenderer.invoke('extensionCenter:uninstall', { packageKey })
  },
  themes: {
    list: (): Promise<ThemeListView> => ipcRenderer.invoke('themes:list'),
    get: (
      id: string
    ): Promise<{ ok: true; theme: WorkbenchTheme; } | { ok: false; error: string; }> =>
      ipcRenderer.invoke('themes:get', id),
    create: (
      name: string
    ): Promise<{ ok: true; theme: WorkbenchTheme; } | { ok: false; error: string; }> =>
      ipcRenderer.invoke('themes:create', name),
    save: (
      theme: WorkbenchTheme
    ): Promise<
      { ok: true; theme: WorkbenchTheme; } | { ok: false; errors: string[]; }
    > => ipcRenderer.invoke('themes:save', theme),
    remove: (id: string): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('themes:remove', id),
    activate: (
      id: string,
      opts?: { scope?: 'global' | 'workspace'; workspaceId?: string; followGlobal?: boolean; }
    ): Promise<{ ok: boolean; error?: string; scope?: 'global' | 'workspace'; }> =>
      ipcRenderer.invoke('themes:activate', id, opts),
    revealDir: (): Promise<string> => ipcRenderer.invoke('themes:revealDir')
  },
  confirmRespond: (
    requestId: string,
    confirmed: boolean,
    cancelledBy?: ConfirmCancelledBy,
    decision?: { kind?: string; scope?: string; freeText?: string; }
  ) => {
    ipcRenderer.send(`ui:confirm:${requestId}`, {
      confirmed,
      cancelledBy,
      ...(decision?.kind ? { kind: decision.kind } : {}),
      ...(decision?.scope ? { scope: decision.scope } : {}),
      ...(decision?.freeText ? { freeText: decision.freeText } : {})
    });
  },
  dialogRespond: (
    requestId: string,
    response: { cancelled: true; } | { cancelled: false; value: string | string[]; }
  ) => {
    ipcRenderer.send(`ui:dialog:${requestId}`, response);
  },
  mailPresentation: {
    setViewport: (viewportId: string, mailboxId: string, active: boolean): Promise<import('../shared/mailActivity').MailPresentationResult> =>
      ipcRenderer.invoke('mailPresentation:viewport', viewportId, mailboxId, active),
    depart: (viewportId: string, requestIds: string[]): Promise<import('../shared/mailActivity').MailPresentationResult> =>
      ipcRenderer.invoke('mailPresentation:depart', viewportId, requestIds)
  },
  terminal: {
    replyCapture: (
      requestId: string,
      payload: { ok: true; dataUrl: string; } | { ok: false; error: string; }
    ) => {
      ipcRenderer.send(`terminal:capture:${requestId}`, payload);
    }
  },
  panel: {
    replySnapshot: (requestId: string, payload: import('../shared/panelState').PanelSnapshotResponse) => {
      ipcRenderer.send(`panel:snapshot:${requestId}`, payload);
    },
    replyOpenContent: (requestId: string, payload: import('../shared/panelState').PanelOpenResponse) => {
      ipcRenderer.send(`panel:open-content:${requestId}`, payload);
    },
    replyCloseTab: (requestId: string, payload: import('../shared/panelState').PanelCloseResponse) => {
      ipcRenderer.send(`panel:close-tab:${requestId}`, payload);
    },
    replyFocusTab: (requestId: string, payload: import('../shared/panelState').PanelFocusResponse) => {
      ipcRenderer.send(`panel:focus-tab:${requestId}`, payload);
    },
    replyFocusAxis: (requestId: string, payload: import('../shared/panelState').PanelAxisFocusResponse) => {
      ipcRenderer.send(`panel:focus-axis:${requestId}`, payload);
    },
    replyFocusCenter: (requestId: string, payload: import('../shared/panelState').PanelCenterFocusResponse) => {
      ipcRenderer.send(`panel:focus-center:${requestId}`, payload);
    },
    replyCloseCenter: (requestId: string, payload: import('../shared/panelState').PanelCenterCloseResponse) => {
      ipcRenderer.send(`panel:close-center:${requestId}`, payload);
    },
    replyRightLayout: (requestId: string, payload: import('../shared/panelState').PanelRightLayoutResponse) => {
      ipcRenderer.send(`panel:right-layout:${requestId}`, payload);
    },
    replySplit: (requestId: string, payload: import('../shared/panelState').PanelSplitResponse) => {
      ipcRenderer.send(`panel:split:${requestId}`, payload);
    }
  },
  captures: {
    readPreview: (
      absPath: string
    ): Promise<{ ok: true; dataUrl: string; } | { ok: false; error: string; }> =>
      ipcRenderer.invoke('captures:readPreview', absPath)
  },
  sandbox: {
    getInfo: (): Promise<SandboxInfo> => ipcRenderer.invoke('sandbox:getInfo'),
    save: (): Promise<{ ok: boolean; message?: string; }> => ipcRenderer.invoke('sandbox:save'),
    reset: (opts?: {
      cleanWorkspaces?: boolean;
      cleanUserData?: boolean;
    }): Promise<{ ok: boolean; message?: string; }> =>
      ipcRenderer.invoke('sandbox:reset', opts),
    openDir: (): Promise<{ ok: boolean; error?: string; }> =>
      ipcRenderer.invoke('sandbox:openDir')
  },
  updater: {
    getState: (): Promise<import('../shared/updater').UpdaterStatus> =>
      ipcRenderer.invoke('updater:getState'),
    /** 手动检查更新；结果经 updater:status 事件/再拉一次 getState 获取 */
    check: (): Promise<import('../shared/updater').UpdaterStatus> =>
      ipcRenderer.invoke('updater:check'),
    /** 静默安装已下载的更新并自启（仅 downloaded 态有效） */
    install: (): Promise<{ ok: boolean; }> => ipcRenderer.invoke('updater:install'),
    /** 打开已下载安装包所在文件夹（自动安装失败的手动兜底） */
    revealInstaller: (): Promise<boolean> => ipcRenderer.invoke('updater:revealInstaller')
  },
  on: <K extends IpcEventChannel>(
    channel: K,
    listener: (payload: IpcEventMap[K]) => void
  ): (() => void) => {
    if (!(IPC_EVENT_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`未知事件频道: ${channel}`);
    }
    return subscribeIpcEvent(channel, listener);
  }
};

export type WorkbenchApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
if (process.argv.includes('--muster-demo-record') && process.isMainFrame) {
  contextBridge.exposeInMainWorld('demoRecording', {
    start: () => ipcRenderer.sendSync('demo:recordStart'),
    append: (id: string, events: import('../shared/demoReplay').DemoVisualEvent[]) => ipcRenderer.sendSync('demo:recordBatch', id, events),
    surface: (id, rect) => ipcRenderer.invoke('demo:surface', id, rect)
  } satisfies import('../shared/demoReplay').DemoRecordingBridge);
}
