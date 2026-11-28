import { app, BrowserWindow, Menu, crashReporter, powerMonitor, powerSaveBlocker, shell, dialog, nativeTheme, screen, desktopCapturer, nativeImage, webContents, safeStorage, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { controlRootFor } from '../shared/workspaceRoots';
import type { DesktopMetadataRuntime } from './desktop/metadataRuntime';
import { createDesktopMetadataRuntime } from './desktop/metadataFactory';
import { WorkerDesktopEpochRuntime } from './desktop/workerEpochRuntime';
import { SchedulerDesktopEpochRuntime } from './desktop/schedulerEpochRuntime';
import { DesktopScreenRuntime } from './desktop/screenRuntime';
import { createWin32DesktopHost } from './desktop/win32DesktopHost';
import { createMacDesktopHost } from './desktop/macDesktopHost';
import { createLinuxDesktopHost } from './desktop/linuxDesktopHost';
import { desktopRuntime } from './desktop/runtime';
import { desktopSetupMacApp } from './desktop/desktopSetup';
import { createIdempotentDesktopComposition } from './desktop/idempotentDesktopComposition';
import { DesktopResumeStateLedger } from './desktop/desktopResumeState';
import { recoverDesktopInitializationFailure } from './desktop/desktopStartupRecovery';
import { desktopIndicatorLabels } from './desktop/desktopIndicatorLabels';
import { createPlatformIndicator } from './desktop/platformIndicator';
import { DesktopIndicatorWindow } from './desktop/desktopIndicatorWindow';
import { windowsEscapeScript, WindowsEscapeMonitor } from './desktop/windowsEscapeMonitor';
import { unixEscapeWorkerPath, UnixEscapeMonitor } from './desktop/unixEscapeMonitor';
import { resolveCuaDriverPath } from './desktop/cuaDriverPath';
import { Win32TargetRegistry } from './desktop/win32TargetRegistry';
import type { PromptTask } from '../shared/types';
import { mergeNotificationTarget } from './git/mergeNotificationTarget';

import { patchElectronForPi } from './agent/piElectronCompat';
import { ConfigManager, defaultWorkspaceRoot, ensureDefaultWorkspaceRoot, migrateRuntimeOverridesToHost } from './config';
import { Store } from './store';
import { ThemeService } from './themes';
import { initializeWindowMaterial } from './windowMaterial';
import { PtyManager } from './pty/manager';
import { SessionsService } from './sessions';
import { EvidenceCollector } from './sessions/evidence';
import { startTurnChangesCleanupSweeper } from './turnChanges/cleanup';
import { turnChanges } from './turnChanges/runtime';
import { PipelineStallScanner } from './pipeline/stallScanner';
import { RuntimeAwarenessStore } from './awareness/store';
import { EventLog } from './awareness/eventLog';
import { EventRouter } from './awareness/eventRouter';
import { deliverSubscriptionEvent, deliverSystemReminderEvent } from './awareness/eventDelivery';
import { handleMemoryIntentEvent } from './memory/runtime';
import { ensureSchedulerDefaultSubscriptions } from './awareness/defaults';
import { SchedulerStatusStore } from './schedulerStatusStore';
import { dispatchRuntimeFacts } from './awareness/dispatch';
import { getEventRegistry } from './awareness/eventRegistry';
import { getSubscriptionPolicyStore } from './orchestrator/subscriptionPolicyStore';
import { createWorkflowRuntime } from './workflow/wiring';
import { bindWorkflowRuntime } from './workflow/runtimeRef';
import { listAliveAwarenessSessionIds } from '../shared/runtimeFacts';
import { PromptTasksManager } from './tasks/manager';
import { UiBridge } from './uiBridge';
import { Orchestrator } from './agent/orchestrator';
import { runHeadlessPiTask } from './agent/providers/piProvider';
import { AgentSessionHost } from './agentSession/host';
import { BackgroundTaskManager } from './agentSession/background/manager';
import { disposeAllNodeRepl } from './agentSession/tools/nodeRepl';
import { registerAgentSessionDrivers } from './agentSession/registerDrivers';
import { ShellApiServer } from './protocol/shellApi';
import { registerIpc } from './ipc';
import { writeInboundMcpPidRecord, removeInboundMcpPidRecord, bindSessionProcessRoots } from './inboundMcp/pidMap';
import { handle, ipcCapabilities, ipcPermissions, stopIpcAdmission, type IpcHandler } from './ipc/handle';
import { shutdownControlledChildren } from './agentSession/process/controlledChild';
import { ScheduledWork } from './runtimeKernel/scheduledWork';
import { GitService } from './git/service';
import { WorkspaceService } from './workspaces';
import { bindWorkspaceRootDependencies } from './workspaceRootDependencies';
import { NotifyStore } from './notify/store';
import { NotifyBus } from './notify/bus';
import type { AppContext } from './context';
import { currentAgentWorkspaceId } from './agent/agentScope';
import { attachMailboxWakes, type MailboxWakeOwner } from './messages/wake';
import { attachMailboxPresentation } from './messages/presentation';
import { ensureAllWorkspacesMetaAgent } from './metaAgent/ensureForApp';
import { provisionHostDomainSkills, resolveBundledSkillsDir } from './metaAgent/hostSkillProvision';
import { resolveRuntimeBuiltinsDir, RuntimeHost } from './runtime/host';
import { configureModelCatalogStorage } from './agentSession/modelCatalogCache';
import { setSkillAuditSink, makeSkillAuditSink } from './agent/skillInject';
import { attachResumeWait } from './resumeWait/runtime';
import { UsageStatsService } from './usage/service';
import {
  registerMetaAgentWsProtocol,
  registerMetaAgentWsScheme
} from './workspaceFsProtocol';
import { WorkspaceFsWatcher } from './workspaceFsWatcher';
import {
  OrchestratorEventPump,
  bindOrchestratorEventPump,
  noteMergeBlocked,
  startGitReflogWatches
} from './orchestrator/events';
import {
  bindSchedulerSituationContext,
  noteSchedulerSituationChanged
} from './orchestrator/situationWriter';
import { setDelegateSlotFreedListener } from './tasks/delegateQueue';
import { setSettleNotifyListener } from './orchestrator/settleNotify';
import { setAgentMessagesUserDataDir } from './metaAgent/messageStore';
import { setDeclarationTrustUserDataDir } from './agent/declarationTrustStore';
import { setAlwaysRulesUserDataDir } from './capabilities/alwaysRules';
import { MemoryService } from './memory/service';
import {
  bindMemoryIntentEvents,
  setMemoryService,
  setUserProfileFilePath
} from './memory/runtime';
import {restoreMemoryCurators,stopMemoryCuratorsAndWait,stopMemoryCuratorAdmission} from './memory/curatorBindings';
import {setMemoryEnvironmentProvider} from './memory/environment';
import {RESULT_MAX_CHARS} from './capabilities/executor';
import {MCP_CALL_RESULT_MAX_CHARS} from '../shared/mcpRelay';
import {MCP_RESULT_MAX_CHARS} from './agent/mcpHub';
import { emitMemoryIntentEvent } from './memory/intentEvents';
import { setMergeBlockedListener } from './git/service';
import { MessagingHost } from './messaging/messagingHost';
import { MusterMessagingSessionHost } from './messaging/sessionHost';
import { MessagingCredentialStore } from './messaging/credentialStore';
import { WorkbenchMessagingHost } from './messaging/workbenchBridge';
import { RemoteBindingService } from './messaging/remoteBindingService';
import { LogicalChannelError, LogicalChannelService } from './messaging/logicalChannelService';
import { claimFeishuConsumer } from './feishu/consumerArbiter';
import { imapConsumerArbiter } from './messaging/imapConsumerArbiter';
import { isDevSandboxEnabled, setupDevSandbox } from './devSandbox';
import { parseDemoArgs } from './demo/options';
import { ensureInstanceId, loadInstancePorts } from './instance/portsFile';
import { listAppInstances, removeInstanceHeartbeat, writeInstanceHeartbeat } from './instance/registry';
import { noteInstallDeferred } from './updater';
import { installDevServerShutdown } from './devServerShutdown';
import { attachEventRelay } from './webAccess/relay';
import { WebAccessServer } from './webAccess/server';
import { setSchedulerCaptureUserData } from './agent/schedulerWorkspaceContext';
import { createAgentAppsService, createLogicalChannelLegacyAdapter } from './agentApps/wiring';
import { createFeedbackService, onFeedbackSchedulerIdle, requestFeedbackAiCheck } from './feedback/wiring';
import { createSafetyServiceForContext, authorizeSafetyOperation } from './safety/bindings';
import { confirmSessionOperation } from './safety/humanConfirmation';
import { createExtensionAppSystem, type ExtensionAppSystem } from './extensions/extensionAppSystem';
import { collectStartupSchemes } from './extensions/startupSchemes';
import { configureBrowserCdpAtBoot } from './browser/cdpBoot';
import { prepareWorkbenchLoginShellPath } from './shell/loginEnv';
import { errorMessage } from '../shared/errors';
import { createTray } from './tray';
import { applyLocaleSetting, t } from '../shared/i18n';
import { detectGitBashPath } from './shell/profiles';
import type { BootResult } from '../shared/boot';
import { CoreReasoningCatalogStore } from './agent/coreReasoningCatalog';
import { piReasoningSources, setPublishedModelInputSpecifications } from './agent/piConfigSync';
import { userDataStorage } from './runtimeKernel/storageRootResolver';
import { installMainConsoleCapture, appendMainLog } from './logs/mainLog';
import { CrashConsoleRing, CRASH_CONSOLE_DUMP_MAX, buildRenderGoneEntry, formatChildGoneLine } from '../shared/crashContext';
import { notifyDesktop } from './logs/desktopNotify';
import { decideRenderGoneReload } from '../shared/renderGonePolicy';
import {
  PRODUCT_APP_ID,
  PRODUCT_NAME_ZH,
  asciiUserAgent
} from '../shared/productIdentity';
import { configureProductUserDataPath, productStorageResolver } from './productStorage';
import { DomainRegistry } from './runtimeKernel/domainRegistry';
import { RuntimeKernel } from './runtimeKernel/kernelContracts';
import { FileSessionManager } from './runtimeKernel/sessionManager';
import { registerRuntimeDomains } from './bootstrap/registerRuntimeDomains';
import { registerHostEntrypointDomains } from './bootstrap/registerHostEntrypointDomains';
import { StartupStorageMaintenance, StorageMaintenanceRecoveryError } from './storage/startupMaintenance';

// Electron Node 20 缺 markAsUncloneable；须在动态 import Pi/undici 前打补丁
patchElectronForPi();
// 正式版和显式 no-sandbox 开发版使用 Muster 自己的 userData 根目录。
// 普通开发沙箱随后会把 userData 重定向到仓库内 .dev-sandbox/userData，保持测试隔离。
configureProductUserDataPath();
// UA 必须纯 ASCII：产品名「集序」进默认 UA 后，Electron 43.x 的 protocol.handle 在把
// 请求头转成 Headers 时会抛 ByteString 转换异常，自定义协议（muster-ws/root/ext/app）
// 请求全部 ERR_UNEXPECTED，文件预览与扩展面板整片失效。须早于任何窗口/session 创建。
app.userAgentFallback = asciiUserAgent(app.userAgentFallback);
// 在所有模块创建前先只完成 userData 重定向，不初始化沙箱文件。
// 第二实例必须先拿到同一 userData 的锁，避免在锁之前改写 config/sessions。
setupDevSandbox({ initialize: false });

// ── 强制单实例（X5-F01，用户拍板超出报告建议档）──
// 同 userData 的第二实例在所有写盘副作用（扩展恢复/启动期原生扩展/config）之前退出。
// Electron 实例锁随 userData 目录：dev 沙箱与正式安装（或不同 checkout 的沙箱）各有
// 独立 userData，跨目录共存是刻意支持的形态，不受本锁影响。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.error('[boot] same-userData instance already running; exiting (single-instance lock)');
  // showErrorBox 可在 app ready 前调用（三平台一致）；提示后退出，不进入启动链
  dialog.showErrorBox(
    t(`${PRODUCT_NAME_ZH} 已在运行`),
    t('同一数据目录只允许运行一个工作台实例。已运行的窗口已带回前台，可从任务栏或托盘找回。')
  );
  app.quit();
  process.exit(0);
}

// Detach confirmed storage groups before Chromium and business stores open them.
const startupStorageMaintenance = new StartupStorageMaintenance(app.getPath('userData'), app.getPath('sessionData'));
let maintenanceErrors: string[];
try { maintenanceErrors = startupStorageMaintenance.detachQueued(); }
catch (error) {
  if (error instanceof StorageMaintenanceRecoveryError) {
    appendMainLog(app.getPath('userData'), 'error', `[storage-maintenance] startup blocked: ${error.message}`);
    dialog.showErrorBox(t('本机存储需要恢复'), t('清理中断后有文件尚未恢复。请检查以下路径的权限或解除文件占用，再启动工作台。\n{{error}}', { error: error.message }));
    process.exit(1);
  }
  maintenanceErrors = [String(error)];
}

// ── 崩溃黑匣子（userData 已在锁前完成重定向，沙盒日志/dump 落沙盒）──
// 本地保留崩溃 minidump（渲染进程 CHECK/V8 OOM 类崩溃不留 WER 记录，没这步就彻底无痕）；
// 纯本地，不上传任何服务器。crashReporter.start 要求在 app ready 之前调用。
try {
  crashReporter.start({ uploadToServer: false });
} catch (e) {
  console.error('[crashReporter] start failed:', e);
}
// 接管 console.*：安装版没有终端，所有主进程日志（含 [fatal] 兜底、[renderer gone]）
// 从此落 userData/logs/main.log（1MB 滚 .old）；dev 下 stdout 仍保留。
installMainConsoleCapture(app.getPath('userData'));
for (const error of maintenanceErrors) console.warn('[storage-maintenance] startup cleanup deferred:', error);
// 子进程（GPU/utility 等）死亡落盘：GPU 崩在界面上同样表现为黑屏/花屏，此前一行不留。
// （渲染进程死亡不触发本事件，由各宿主 webContents 的 render-process-gone 自行落盘。）
app.on('child-process-gone', (_event, details) => {
  appendMainLog(app.getPath('userData'), 'error', formatChildGoneLine(details));
});
// 第二实例尝试启动 = 用户「以为没打开又点了一次」：聚焦/复原主窗
app.on('second-instance', (_event, commandLine, workingDirectory) => {
  relaySecondInstance(commandLine, workingDirectory);
});
// 只有持锁实例才初始化沙箱文件、配置和其余启动期资源。
setupDevSandbox();

configureModelCatalogStorage(app.getPath('userData'));
const bootConfig = new ConfigManager();
// 首启是零工作区（新建引导面板常驻），不预建目录。仅当已有登记确实引用应用自有
// 默认根时在这里补建，保证 scaffold/realpath 校验前目录存在；老配置不引用该路径时
// 此调用无副作用；创建失败明确提示，不静默退回用户主目录。
if (gotSingleInstanceLock) {
  try {
    ensureDefaultWorkspaceRoot(bootConfig.get());
  } catch (err) {
    console.error('[workspace] default workspace folder unavailable:', err);
    dialog.showErrorBox(
      t('默认工作区目录不可用'),
      t('无法创建默认工作区目录 {{path}}。请检查用户主目录的写权限，或在「工作区设置」里改用其他目录后重启。错误：{{err}}', {
        path: defaultWorkspaceRoot(), err: String(err)
      })
    );
  }
}
// 单实例锁未拿到（本实例即将退出）时跳过启动期协议注册副作用。
if (gotSingleInstanceLock) {
  collectStartupSchemes(() => { registerMetaAgentWsScheme(); });
}
installDevServerShutdown();
// Chromium allocates a local CDP port by default; the browser service verifies
// that the endpoint owns this app's main-window target before connecting.
if (gotSingleInstanceLock) configureBrowserCdpAtBoot();

function workspaceManagementRoot(workspace: Parameters<typeof controlRootFor>[0]): string | null {
  try { return controlRootFor(workspace); }
  catch (error) { console.error('[workspace] management root unavailable', workspace.id, error); return null; }
}

const CHROME_H = 36;

function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, '../../build/icon.ico'),
    path.join(__dirname, '../../build/icon.png')
  ];
  return candidates.find((p) => fs.existsSync(p));
}

let mainWindow: BrowserWindow | null = null;
let themesRef: ThemeService | null = null;
let shellApi: ShellApiServer | null = null;
let orchestratorRef: Orchestrator | null = null;
let orchEventPump: OrchestratorEventPump | null = null;
let runtimeKernelRef: RuntimeKernel<IpcHandler> | null = null;
let mailboxOwnerRef: MailboxWakeOwner | undefined;
let workflowRuntimeRef: import('./workflow/runtime').WorkflowRuntime | null = null;
let reflogWatchDisposer: ReturnType<typeof startGitReflogWatches> | null = null;
let fsWatcherRef: WorkspaceFsWatcher | null = null;
let messagingChannelsRef: { stopAdmission(): void; stopAndWait(): Promise<void> } | null = null;
let storeRef: Store | null = null;
let ptyRef: PtyManager | null = null;
let sessionsRef: SessionsService | null = null;
let agentSessionsRef: AgentSessionHost | null = null;
let bgTasksRef: BackgroundTaskManager | null = null;
let tasksRef: PromptTasksManager | null = null;
let eventRouterRef: EventRouter | null = null;
let webAccessRef: WebAccessServer | null = null;
let cliStopAdmission: (() => void) | null = null;
let extensionSystemRef: ExtensionAppSystem | null = null;
let safetyRef: import('../shared/safety').SafetyService | null = null;
let memoryRef: MemoryService | null = null;
let stallScannerRef: PipelineStallScanner | null = null;
/** X7-F06：实例心跳周期刷新（分钟级，unref 不阻退出）；before-quit 清理 */
let startupWorkRef: ScheduledWork | null = null;
// 关闭按钮 ≠ 退出：close 只隐藏到托盘，真正退出只走托盘右键菜单（tray.ts）。
// app.quit() 会再触发一次 window close，此标记放行它。
let isQuitting = false;
let extensionQuitApproved = false;
let extensionQuitPending = false;
let extensionRestartRequested = false;
let runtimeKernelQuitReady = false;
let runtimeKernelQuitPending = false;
type SecondInstanceRequest = { commandLine: string[]; workingDirectory: string };
const pendingSecondInstanceRequests: SecondInstanceRequest[] = [];

function flushSecondInstanceRequests(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isLoading()) return;
  while (pendingSecondInstanceRequests.length) {
    win.webContents.send('app:second-instance', pendingSecondInstanceRequests.shift()!);
  }
}

function relaySecondInstance(commandLine: readonly string[], workingDirectory: string): void {
  const request: SecondInstanceRequest = { commandLine: [...commandLine], workingDirectory };
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingSecondInstanceRequests.push(request);
    showMainWindow();
    return;
  }
  showMainWindow();
  mainWindow.webContents.send('app:second-instance', request);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
}

// 顶层兜底：没有这两个钩子时，任何漏 catch 的异步错误都会静默消失，
// 线上只表现为「某个功能突然不动了」且日志里查无此事。
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

function createWindow(): BrowserWindow {
  const isSandbox = isDevSandboxEnabled();
  const titleBarOverlay = process.platform === 'win32'
    ? { color: '#202023', symbolColor: '#ededee', height: CHROME_H }
    : undefined;
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 640,
    title: isSandbox ? `${t(PRODUCT_NAME_ZH)} [${t('Dev Sandbox 隔离沙箱')}]` : t(PRODUCT_NAME_ZH),
    icon: resolveAppIcon(),
    // 窗口/标题栏颜色必须与 styles/base.css 的 --bg-frame/--ink 同值
    // （test/design-lint.mjs 会校验，改色板记得同步这里）。
    // backgroundColor 取框色（顶栏直接画在框上）：即使个别环境 titleBarOverlay.color 不生效
    // 而透出窗口底色，也保持与顶栏同色（用户验收：右上角不允许色块）
    backgroundColor: '#202023',
    // 自定义顶栏：Windows overlay 控件在右；macOS hiddenInset 红绿灯在左（chrome.css 的
    // .is-mac 给顶栏让位）；Linux overlay 仍实验性，保留原生标题栏
    ...(process.platform === 'linux'
      ? {}
      : {
          titleBarStyle: process.platform === 'darwin' ? ('hiddenInset' as const) : ('hidden' as const),
          ...(titleBarOverlay && { titleBarOverlay })
        }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      ...(parseDemoArgs(process.argv)?.record ? { additionalArguments: ['--muster-demo-record'] } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 内置浏览器 <webview> 栈（2026-10-08 迁移）：guest 参与 renderer 合成栈，
      // 浮层/跟随/露条手势由 DOM 直接处理（旧 WebContentsView 让位体系已移除）
      webviewTag: true
    }
  });
  win.webContents.on('did-finish-load', () => flushSecondInstanceRequests(win));

  const initialTheme = themesRef?.getActive();
  initializeWindowMaterial(win, nativeTheme, {
    panel: initialTheme?.colors['bg-frame'] ?? '#202023',
    ink: initialTheme?.colors['ink'] ?? '#ededee',
    appearance: initialTheme?.appearance ?? 'dark'
  }, { titleBarOverlay: Boolean(titleBarOverlay) });

  win.webContents.setBackgroundThrottling(false);
  // 主→渲染事件分叉一份给 web 客户端（webAccess 网关的事件广播源，见 relay.ts）
  attachEventRelay(win);

  // macOS 原生全屏时系统红绿灯隐藏：推状态给渲染层收回顶栏让位（chrome.css .is-native-fullscreen）
  const pushFullscreen = (): void => {
    win.webContents.send('window:fullscreen', win.isFullScreen());
  };
  win.on('enter-full-screen', pushFullscreen);
  win.on('leave-full-screen', pushFullscreen);

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 只外链 http(s)：相对路径 / metaagent-file: / file:// 落到 shell 会当网页打开并报错
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Menu=null 无 Edit 加速键；只补粘贴，避免挂 editMenu 吞掉终端 Ctrl+C
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key.toLowerCase() !== 'v') return;
    if (input.alt || input.shift) return;
    const isMac = process.platform === 'darwin';
    const isPaste = isMac
      ? input.meta && !input.control
      : input.control && !input.meta;
    if (!isPaste) return;
    event.preventDefault();
    win.webContents.paste();
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer did-fail-load]', code, desc, url);
  });
  win.webContents.on('did-finish-load', () => {
    console.log('[renderer did-finish-load]', win.webContents.getURL());
    // 以全屏态恢复启动（macOS 记住全屏）时渲染层也拿得到初始状态
    pushFullscreen();
  });
  // 渲染层 console 环形缓冲：崩溃时随死因条目落盘（渲染进程一死，renderer-errors
  // 通道就断流了，主进程侧这份快照是「崩时渲染层在干什么」的唯一现场）
  const crashConsole = new CrashConsoleRing();
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    crashConsole.push(`console[${level >= 3 ? 'e' : level === 2 ? 'w' : 'i'}] ${message} (${sourceId}:${line})`);
    if (level >= 2) console.error('[renderer console]', message, sourceId, line);
  });
  // 渲染进程死亡：死因 + 现场快照落盘（reason=oom/crashed/killed/… 是黑屏排查的
  // 第一现场），再按滑动窗口限频自动 reload 自愈；窗口内反复崩则停手改发系统通知
  // （系统通知不依赖渲染层——此刻渲染层恰恰死了，ui.notify 的 toast 弹不出来）。
  const renderGoneStamps: number[] = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    const decision = decideRenderGoneReload(renderGoneStamps, Date.now());
    renderGoneStamps.length = 0;
    renderGoneStamps.push(...decision.recent);
    // 只 appendMainLog 一条（console 捕获也开着，会双写）；死因日志值得独立于
    // console 捕获的健康度——排查黑屏时它是第一现场
    appendMainLog(
      app.getPath('userData'),
      'error',
      buildRenderGoneEntry({
        reason: details.reason,
        exitCode: details.exitCode,
        decisionNote: decision.note,
        url: win.webContents.getURL(),
        mainRssBytes: process.memoryUsage().rss,
        consoleLines: crashConsole.latest(CRASH_CONSOLE_DUMP_MAX)
      })
    );
    if (decision.reload) {
      try {
        win.webContents.reload();
        notifyDesktop(t('界面已自动恢复'), t('渲染进程崩溃，已自动重载；详情见日志'), () =>
          showMainWindow()
        );
      } catch (e) {
        console.error('[renderer gone] reload failed:', e);
      }
    } else {
      notifyDesktop(t('界面渲染引擎多次崩溃'), t('已暂停自动恢复，请重启应用；详情见日志'), () =>
        showMainWindow()
      );
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  console.log('[renderer load]', rendererUrl ?? '(file)');
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
}

// Windows 系统 toast 需 AppUserModelID，否则通知中心可能不显示。
// AUMID 是 Windows 解析应用身份的主键：任务栏图标/名称、toast 点击激活都按它在
// 开始菜单找快捷方式。Electron 发 toast 时若无匹配快捷方式，会按进程名自动建一个
// 并打上当前 AUMID——dev 下即「Electron.lnk」指向 node_modules 的 electron.exe。
// 若 dev 与安装版共用 AUMID，该 lnk 会永久抢占安装版的任务栏身份与 toast 点击跳转
// （2026-09-06、2026-09-10 两次实测：任务栏变 Electron 默认图标、点通知弹出空
// Electron 窗口）。故 dev 必须用独立 AUMID 与正式身份隔离；正式值须与
// electron-builder.yml 的 appId 一致（NSIS 快捷方式上盖的就是它）。
const APP_USER_MODEL_ID = PRODUCT_APP_ID;
const appInstance = (() => {
  const userData = app.getPath('userData');
  const id = ensureInstanceId(userData);
  const base = app.isPackaged ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}.dev`;
  const suffixRaw =
    process.env.MUSTER_INSTANCE_ID?.trim() ||
    (process.env.MUSTER_SANDBOX === '1'
      ? id.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24)
      : '');
  const aumid = suffixRaw ? `${base}.${suffixRaw}` : base;
  return { id, aumid, userData };
})();
if (process.platform === 'win32') {
  app.setAppUserModelId(appInstance.aumid);
}

app.whenReady().then(async () => {
  // 单实例锁未拿到的实例已在模块顶层请求退出；此处不得再进入启动链建窗/写盘
  if (!gotSingleInstanceLock) return;
  const bootT0 = Date.now();
  setSchedulerCaptureUserData(app.getPath('userData'));
  await prepareWorkbenchLoginShellPath();
  // File/Edit/Settings 改由渲染层 chrome-bar 提供，去掉原生第二行菜单。
  // Menu=null 会丢掉 Edit 加速键：Ctrl+V / Win+V 历史点选都不会触发 paste，
  // 终端里只会把 \x16 送给 Cursor CLI。不能整表挂 editMenu（会吞 Ctrl+C 中断），
  // 故在 before-input-event 里只补粘贴。
  Menu.setApplicationMenu(null);

  const getWindow = () => mainWindow;
  let desktopMetadata: DesktopMetadataRuntime | undefined;
  let desktopScreen: DesktopScreenRuntime | undefined;
  let desktopHost: (ReturnType<typeof createWin32DesktopHost> & { platform: 'win32' }) | ReturnType<typeof createMacDesktopHost> |
    ReturnType<typeof createLinuxDesktopHost> | undefined;
  let desktopResumeState: DesktopResumeStateLedger | undefined;
  let desktopUi: UiBridge | undefined;
  let desktopQuitPending = false;
  let desktopQuitReady = false;
  let desktopUnavailableReason: string | undefined;
  let desktopWorkerEpochs: WorkerDesktopEpochRuntime | undefined;
  let desktopSchedulerEpochs: SchedulerDesktopEpochRuntime | undefined;
  const getDesktopMetadata = (): DesktopMetadataRuntime => {
    return desktopMetadata ??= createDesktopMetadataRuntime(app.getPath('userData'), __dirname, screen, powerMonitor);
  };
  const getDesktopWorkerEpochs = (): WorkerDesktopEpochRuntime => {
    if (!sessionsRef) throw new Error('Desktop Worker sessions are unavailable');
    return desktopWorkerEpochs ??= new WorkerDesktopEpochRuntime(app.getPath('userData'), sessionsRef);
  };

  // Phase 1 只做轻量配置读取（applyChrome 需要）；其余服务构造全部后台化，
  // 且必须保证 runtimes.ensureSeeded() 先于 SessionsService 构造
  // （loadSessions 会按 runtime 注册表归一化会话，注册表未种子会抛错）。
  const config = bootConfig;
  const themes = new ThemeService(app.getPath('userData'), config);
  themesRef = themes;
  // 主进程自身可见文案（窗口标题/通知/对话框/错误串）随 config.locale；
  // 渲染层由 renderer/src/i18n.ts 独立接线（缓存先刷 + config 校正），不经此处
  applyLocaleSetting(config.get().locale, app.getLocale());

  // ── 启动两段化：窗口先出（渲染层先显示内联骨架），重初始化后台串行 ──
  // 渲染层水合前 await app:boot:wait，保证所有 ipcMain.handle 已注册。
  // 启动链失败时返回 { ok:false }，渲染层据此显示启动失败页而不是挂一个
  // 大部分 IPC 都缺失的「空壳工作台」。
  let resolveBoot: (r: BootResult) => void = () => {};
  const bootDone = new Promise<BootResult>((resolve) => {
    resolveBoot = resolve;
  });
  handle('app:boot:wait', () => bootDone);
  // 启动失败页需要的自救通道：必须早于启动链注册，否则失败时它们也不存在
  handle('app:relaunch', () => {
    extensionRestartRequested = true;
    app.quit();
  });
  handle('app:log-dir', () => productStorageResolver().resolve('app', 'logs'));

  // 轻量收尾后立刻建窗：此前用户只能看着桌面无响应（黑屏期的大头）。
  mainWindow = createWindow();
  flushSecondInstanceRequests(mainWindow);
  console.log(`[boot] window shown @+${Date.now() - bootT0}ms`);
  // 创建参数是深色默认值；非深色主题在渲染内容加载前先把窗口底/标题栏刷成主题色
  try {
    themes.applyChrome(mainWindow);
  } catch (e) {
    console.warn('[themes] applyChrome failed:', (e as Error).message);
  }
  mainWindow.on('close', (e) => {
    // 点关闭 = 最小化到托盘；退出只走托盘右键「退出」（或 app.quit() 触发的那次 close）
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    } else {
      showMainWindow();
    }
  });

  createTray({ showWindow: showMainWindow });

  app.on('before-quit', event => {
    if (process.env.MUSTER_RUNTIME_DIAGNOSTICS === '1') console.info('[shutdown] barriers', {
      desktopQuitReady, runtimeKernelQuitReady
    });
    const running = extensionSystemRef?.runningTasks() ?? [];
    if (!extensionQuitApproved && running.length) {
      event.preventDefault();
      if (!extensionQuitPending) {
        extensionQuitPending = true; showMainWindow();
        const options: Electron.MessageBoxOptions = { type: 'warning', buttons: [t('返回工作台'), t('保存任务记录并退出')], defaultId: 0, cancelId: 0,
          message: t('{{count}} 个扩展任务仍在运行', { count: running.length }), detail: t('退出会停止工作台持有的后台。任务记录与检查点会保存；再次打开后先对账恢复，不会自动重复提交外部作业。') + '\n\n' + running.map(task => `${task.extensionId} · ${task.command}`).join('\n') };
        void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options)).then(result => {
          extensionQuitPending = false;
          if (result.response === 1) { extensionQuitApproved = true; app.quit(); }
          else {
            extensionRestartRequested = false;
            // X7-F03：quit 取消时若更新安装已触发（quitAndInstall 在途），清安装
            // 失败窗残留并 toast「更新已暂缓」——不再让安装静默中止无任何提示
            noteInstallDeferred();
          }
        }).catch(error => { extensionQuitPending = false; console.error('[extension] quit confirmation failed', error); });
      }
      return;
    }
    shellApi?.stopAdmission();
    webAccessRef?.stopAdmission();
    cliStopAdmission?.();
    stopIpcAdmission();
    startupWorkRef?.stopAdmission();
    ptyRef?.stopAdmission();
    tasksRef?.stopAdmission();
    eventRouterRef?.stopAdmission();
    stallScannerRef?.stopAdmission();
    fsWatcherRef?.stopAdmission();
    orchEventPump?.stopAdmission();
    sessionsRef?.stopMonitoring();
    reflogWatchDisposer?.();
    messagingChannelsRef?.stopAdmission();
    stopMemoryCuratorAdmission();
    workflowRuntimeRef?.stopAdmission();
    if (desktopHost && !desktopQuitReady) {
      event.preventDefault();
      if (!desktopQuitPending) {
        desktopQuitPending = true;
        void (async () => {
          try {
            desktopScreen?.close();
            desktopScreen = undefined;
            await desktopHost!.close();
            desktopHost = undefined;
            if (desktopResumeState) {
              desktopResumeState.cleanRun();
              desktopResumeState.close();
              desktopResumeState = undefined;
            }
          } catch (error) {
            console.error('[desktop] shutdown failed:', error);
            try { desktopUi?.notify(t('电脑操作结果未知'), t('电脑操作关闭未完成，请检查目标及工作台日志。')); } catch { /* best effort */ }
          } finally {
            desktopQuitReady = true;
            desktopQuitPending = false;
            app.quit();
          }
        })();
      }
      return;
    }
    if (runtimeKernelRef && !runtimeKernelQuitReady) {
      event.preventDefault();
      if (!runtimeKernelQuitPending) {
        runtimeKernelQuitPending = true;
        bgTasksRef?.stopAdmission();
        mailboxOwnerRef?.();
        void runtimeKernelRef.dispose()
          .catch(error => console.error('[runtime-kernel] shutdown failed:', error))
          .finally(() => {
            runtimeKernelQuitReady = true;
            runtimeKernelQuitPending = false;
            app.quit();
          });
      }
      return;
    }
    isQuitting = true;
    if (extensionRestartRequested) app.relaunch();
    // 顺序有意：先把内存态同步落盘，再停各类定时器/监听，最后杀子进程。
    sessionsRef?.flushPersist();
    agentSessionsRef?.flushPersist();
    storeRef?.flushSync();
    try { desktopScreen?.close(); desktopScreen = undefined; }
    catch (error) { console.error('[desktop] screen shutdown failed', error); }
    try { desktopMetadata?.close(); desktopMetadata = undefined; }
    catch (error) { console.error('[desktop] metadata shutdown failed', error); }
    try { desktopWorkerEpochs?.close(); desktopWorkerEpochs = undefined; }
    catch (error) { console.error('[desktop] Worker epoch shutdown failed', error); }
    try { desktopSchedulerEpochs?.close(); desktopSchedulerEpochs = undefined; }
    catch (error) { console.error('[desktop] scheduler epoch shutdown failed', error); }
    safetyRef?.dispose();
    removeInstanceHeartbeat(appInstance.id);
  });

  // ── 后台启动链：保持原有相对顺序（notify/scaffold/shellApi/IPC 语义不变），
  // 只是全部挪到窗口出现之后执行；完成后放行渲染层水合。 ──
  await (async () => {
    let bootError: string | null = null;
    try {
      const store = new Store();
      const storage = productStorageResolver();
      const sessionManager = new FileSessionManager(storage.resolve('app', 'sessions'), {
        scheduler: storage.resolve('app', 'scheduler-sessions'), gui: storage.resolve('app', 'agent-session-events')
      });
      const runtimeKernel = new RuntimeKernel({
        domains: new DomainRegistry(), capabilities: ipcCapabilities, permissions: ipcPermissions,
        storage, sessions: sessionManager
      });
      runtimeKernelRef = runtimeKernel;
      // Covers cleanup before domain startup and retries an unfinished domain drain.
      runtimeKernel.scope.add(() => messagingChannelsRef?.stopAndWait());
      const startupWork = new ScheduledWork(error => console.error('[startup] scheduled work failed', error));
      startupWorkRef = startupWork;
      startupWork.schedule(0, async signal => {
        for (const error of await startupStorageMaintenance.purgeDetached(signal)) {
          console.warn('[storage-maintenance] unable to remove isolated data:', error);
        }
      });
      runtimeKernel.scope.add(() => removeInstanceHeartbeat(appInstance.id));
      runtimeKernel.scope.add(() => startupWork.shutdown());
      // Registered after the factory disposer but before service owners: LIFO
      // closes dependencies first, drains mail, then releases session writers.
      runtimeKernel.scope.add(() => mailboxOwnerRef?.drain());
      runtimeKernel.scope.add(() => disposeAllNodeRepl());
      runtimeKernel.scope.add(() => shutdownControlledChildren());
      storeRef = store;
      const pty = new PtyManager(getWindow);
      ptyRef = pty;
      runtimeKernel.scope.add(() => pty.killAllAndWait());
      const ui = new UiBridge(getWindow, () => config.get().activeWorkspaceId,
        process.platform === 'darwin' ? desktopSetupMacApp(app.isPackaged) : undefined);
      desktopUi = ui;
      const getDesktopSchedulerEpochs = (): SchedulerDesktopEpochRuntime =>
        desktopSchedulerEpochs ??= new SchedulerDesktopEpochRuntime(app.getPath('userData'), ui, desktopHost?.visibilityEpoch);
      const graphicalRuntime = desktopRuntime(process.platform, process.env);
      if (graphicalRuntime === 'windows' || graphicalRuntime === 'macos' || graphicalRuntime === 'linux-wayland' ||
          (graphicalRuntime === 'linux-x11' && process.env.DISPLAY?.trim())) {
        let composition: ReturnType<typeof createIdempotentDesktopComposition> | undefined;
        try {
          const desktopDir = storage.resolve('app', 'desktop');
          desktopResumeState = new DesktopResumeStateLedger(path.join(desktopDir, 'stop-state.sqlite'));
          const recovered = desktopResumeState.beginRun().recoveredFromDirtyRun;
          composition = createIdempotentDesktopComposition(path.join(desktopDir, 'receipts'));
          const desktopOptions: Parameters<typeof createMacDesktopHost>[0] = {
            composition,
            driverPath: () => resolveCuaDriverPath({ platform: process.platform, arch: process.arch,
              isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }),
            labels: desktopIndicatorLabels(),
            theme: themes.getActive(),
            createIndicator: (stop, unavailable) => createPlatformIndicator({
              mainDir: __dirname,
              preloadPath: path.join(__dirname, '../preload/desktopIndicator.js'),
              rendererPath: path.join(__dirname, '../renderer'),
              rendererUrl: process.env.ELECTRON_RENDERER_URL,
              stop, unavailable,
              createWindow: (indicatorStop, indicatorUnavailable, preloadPath, rendererPath, rendererUrl) =>
                new DesktopIndicatorWindow(indicatorStop, indicatorUnavailable, preloadPath, rendererPath, rendererUrl)
            }),
            createEscapeMonitor: (onEscape, onFailure) => process.platform === 'win32'
              ? new WindowsEscapeMonitor(windowsEscapeScript(__dirname), onEscape, onFailure)
              : new UnixEscapeMonitor({ workerFile: unixEscapeWorkerPath(__dirname), onEscape, onFailure }),
            resumeState: desktopResumeState,
            reportMonitorFailure: reason => console.error('[desktop] Escape monitor failed:', reason),
            reportStopError: error => console.error('[desktop] stop failed:', error)
          };
          desktopHost = process.platform === 'darwin' ? createMacDesktopHost(desktopOptions) : process.platform === 'linux' ? createLinuxDesktopHost(desktopOptions) : {
            platform: 'win32', ...createWin32DesktopHost({ ...desktopOptions,
              createTargets: () => new Win32TargetRegistry(point => screen.screenToDipPoint(point)),
              dipToPhysical: point => screen.dipToScreenPoint(point) })
          };
          if (recovered) ui.notify(t('电脑操作结果未知'), t('上次电脑操作未正常结束，请先检查目标，再明确指示是否继续。'));
        } catch (error) {
          desktopUnavailableReason = graphicalRuntime === 'linux-wayland' && error instanceof Error
            ? `Wayland desktop initialization failed. ${error.message}` : 'Desktop initialization failed; check the workbench log.';
          console.error('[desktop] initialization failed:', error);
          if (!desktopHost) await composition?.close().catch(cleanupError => console.error('[desktop] receipt cleanup failed:', cleanupError));
          const recovery = await recoverDesktopInitializationFailure(
            desktopHost,
            desktopResumeState,
            (stage, cleanupError) => console.error(`[desktop] ${stage}:`, cleanupError),
          );
          if (recovery.resumeStateClosed) desktopResumeState = undefined;
          desktopHost = undefined;
        }
      }
      const notify = new NotifyStore(ui, (workspaceId) =>
        config.get().workspaces.find((w) => w.id === workspaceId)
      );
      const git = new GitService(config);
      // 无 Git Bash 启动提示（shell-env 三件套 B）：Windows 下探测不到时给用户可见提示，
      // 不阻断启动；同键原地更新，重装/手工指定后重启不再弹。
      if (process.platform === 'win32' && !detectGitBashPath()) {
        try {
          notify.push({
            workspaceId: config.get().activeWorkspaceId,
            sessionId: 'shell:env',
            sessionName: t('Shell 环境'),
            kind: 'error',
            text: t(
              '未检测到 Git Bash：Agent 的 shell 命令会降级到 PowerShell。建议安装 Git for Windows，或在设置 → 通用 → 命令行环境手工指定 bash 路径。'
            ),
            updateKey: 'shell-env:no-bash',
            update: true,
            toast: true
          });
        } catch {
          /* 通知失败不影响启动 */
        }
      }
      // 推送通知总线：看板翻转 → 决策纯函数（shared/notifyDecision）→ 桌面 toast + 订阅者（手机/飞书）
      const notifyBus = new NotifyBus(notify, () => config.get().notify ?? {});
      const bundledBuiltinsDir = path.join(__dirname, 'runtime/builtins');
      const builtinsDir = resolveRuntimeBuiltinsDir(
        bundledBuiltinsDir,
        path.resolve(__dirname, '../../src/main/runtime/builtins'),
        !app.isPackaged
      );
      const runtimes = new RuntimeHost({
        userDataDir: app.getPath('userData'),
        builtinsDir,
        onChange: () => {
          getWindow()?.webContents.send('runtimes:changed', runtimes.list());
        }
      });
      await runtimes.ensureSeeded();
      {
        const cfg = config.get();
        const next = await migrateRuntimeOverridesToHost(cfg, runtimes);
        if (
          next.defaultRuntime !== cfg.defaultRuntime ||
          JSON.stringify(next.runtimeOverrides) !== JSON.stringify(cfg.runtimeOverrides)
        ) {
          config.update({
            defaultRuntime: next.defaultRuntime,
            runtimeOverrides: next.runtimeOverrides
          });
        }
      }

      const usage = new UsageStatsService(store);
      const sessions = new SessionsService(store, pty, config, getWindow, notify, notifyBus, runtimes, git);
      sessionsRef = sessions;
      runtimeKernel.scope.add(() => sessions.shutdownMonitoring());
      // Install the archive guard before any desktop wait or capture can be used.
      // The epoch database itself remains lazy; a failure rejects that archive.
      desktopWorkerEpochs = new WorkerDesktopEpochRuntime(app.getPath('userData'), sessions);
      sessions.setUsageStats(usage);
      const eventLog = new EventLog(app.getPath('userData'));
      runtimeKernel.scope.add(async () => { await eventRouterRef?.shutdown(); eventLog.close(); });
      const timeEvent = (task: PromptTask, at: number) => ({ source: 'time', type: 'fired', scope: task.id,
        workspaceId: task.workspaceId, receivedAt: at, summary: task.name.slice(0, 1000),
        payload: JSON.stringify({ taskId: task.id, workspaceId: task.workspaceId, at }) });
      const tasks = new PromptTasksManager(store, config, sessions, runtimes, notify, (task, at) => { eventLog.append(timeEvent(task, at)); }, { startPaused: true });
      runtimeKernel.scope.add(() => tasks.shutdown());
      tasksRef = tasks;
      void sessions.captureInterruptSnapshots().catch((err) => {
        console.error('[sessions] captureInterruptSnapshots failed', err);
      });
      tasks.bindPower({
        startPreventAppSuspension: () => powerSaveBlocker.start('prevent-app-suspension'),
        stop: (id) => {
          if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
        },
        onResume: (cb) => {
          powerMonitor.on('resume', cb);
          return () => {
            powerMonitor.removeListener('resume', cb);
          };
        }
      });
      // T3.3 phase 触发源 + R1 编排事件：原始翻转流（决策前）
      notifyBus.onFlip((flip) => {
        orchEventPump?.onFlip(flip);
      });
      const workspaces = new WorkspaceService(config);
      // A2 skill 正文注入审计（userData/logs/skill-inject.ndjson；不进 UI 主文案）
      setSkillAuditSink(makeSkillAuditSink(app.getPath('userData')));

      const awareness = new RuntimeAwarenessStore(app.getPath('userData'));
      sessions.attachAwareness(awareness);
      try {
        ensureSchedulerDefaultSubscriptions(
          awareness,
          workspaces.list().map((w) => w.id)
        );
      } catch (err) {
        console.error('[awareness] 调度默认订阅播种失败', err);
      }
      const schedulerStatus = new SchedulerStatusStore(store, getWindow);
      // 发布前 schema v1：邮箱 SQLite 和不可变正文文件只落宿主 userData，
      // 工作区 .muster 旧文件由显式 reset 清理，运行时不读取或迁移。
      setAgentMessagesUserDataDir(app.getPath('userData'));
      // B1 声明 digest 信任账本（declaration-trust/<workspaceId>.json，本地审计不进 git）
      setDeclarationTrustUserDataDir(app.getPath('userData'));
      // B2 always 规则（dangerous 工具「总是允许」持久化；permission-always-rules.json）
      setAlwaysRulesUserDataDir(app.getPath('userData'));

      const ctx: AppContext = {
        runtimeKernel,
        sessionLogs: sessionManager,
        config,
        store,
        pty,
        sessions,
        runtimes,
        tasks,
        git,
        workspaces,
        notify,
        ui,
        desktopUnavailableReason,
        desktopMetadata: getDesktopMetadata,
        desktopScreen: !desktopHost ? undefined : () => desktopScreen ??= new DesktopScreenRuntime(ctx, app.getPath('userData'), getDesktopMetadata().displayRegistry(), ui,
          options => desktopCapturer.getSources(options), png => nativeImage.createFromBuffer(png), desktopHost?.visibilityEpoch),
        ...(desktopHost ? {
          desktopTurns: desktopHost.desktopTurns,
          desktopPtyTurns: desktopHost.desktopPtyTurns,
          ...(desktopHost.platform === 'darwin' ? { desktopMac: desktopHost.desktopMac } : desktopHost.platform === 'win32' ? {
            desktopTargets: desktopHost.desktopTargets, desktopVisibleControl: desktopHost.desktopVisibleControl
          } : {}),
          desktopSemanticControl: desktopHost.desktopSemanticControl,
          desktopAppDiscovery: desktopHost.desktopAppDiscovery,
          desktopWindowList: desktopHost.desktopWindowList
        } : {}),
        desktopWorkerTask: getDesktopWorkerEpochs,
        desktopSchedulerTask: getDesktopSchedulerEpochs,
        desktopEpochs: { currentBinding(owner) {
          if (!owner.startsWith('orchestrator:')) return getDesktopWorkerEpochs().currentBinding(owner);
          return getDesktopSchedulerEpochs().currentBinding(owner);
        }, continuationBinding(owner) {
          if (!owner.startsWith('orchestrator:')) return getDesktopWorkerEpochs().currentBinding(owner);
          return getDesktopSchedulerEpochs().continuationBinding(owner);
        }, endScheduler(workspaceId) {
          getDesktopSchedulerEpochs().closeSession(`orchestrator:${workspaceId}`);
        } },
        awareness,
        schedulerStatus,
        themes,
        usage,        shellApi: null,
        bindShellApi(api) {
          ctx.shellApi = api;
        },
        orchestrator: null,
        bindOrchestrator(o) {
          ctx.orchestrator = o;
        },
        agentSessions: null,
        bindAgentSessions(h) {
          ctx.agentSessions = h;
          // chat runtime 预检链路：sessions.createTerminal 内部也要探 driver 可用性
          sessions.bindAgentSessions(h);
        },
        bgTasks: null,
        bindBgTasks(m) {
          ctx.bgTasks = m;
        },
        evidence: null,
        bindEvidence(c) {
          ctx.evidence = c;
        },
        webAccess: null,
        bindWebAccess(s) {
          ctx.webAccess = s;
        },
        browser: null,
        bindBrowser(s) {
          ctx.browser = s;
        },
        isOrchestratorBusy: (workspaceId?: string) =>
          workspaceId
            ? !!orchestratorRef?.isBusy(workspaceId)
            : !!orchestratorRef?.isAnyBusy(),
        onOrchestratorIdle: (workspaceId: string) => {
          orchEventPump?.onOrchestratorIdle(workspaceId);
          onFeedbackSchedulerIdle(ctx, workspaceId);
        },
        resolveBubbleWorkspaceId: () =>
          currentAgentWorkspaceId() ??
          orchestratorRef?.agentWorkspaceId ??
          config.get().activeWorkspaceId,
        renameAgentSession: (workspaceId: string, name: string) =>
          orchestratorRef
            ? orchestratorRef.renameCurrentSession(workspaceId, name)
            : Promise.resolve({ ok: false, error: t('调度 Agent 未就绪') }),
        getWindow,
        auxRendererIds: new Set<number>(),
        sendToAuxiliaryRenderers(channel, payload) {
          for (const id of this.auxRendererIds) {
            const contents = webContents.fromId(id);
            if (contents && !contents.isDestroyed()) contents.send(channel, payload);
            else this.auxRendererIds.delete(id);
          }
        }
      };
      const aliveEventSubjects = new Set(listAliveAwarenessSessionIds(sessions.list().map(s => s.id), workspaces.list().map(w => w.id)));
      for (const sub of eventLog.subscriptions()) {
        if (!sub.subject.startsWith('task:') && !sub.subject.startsWith('system:') && !aliveEventSubjects.has(sub.subject)) eventLog.unsubscribe(sub.id, sub.subject);
      }
      sessions.onSessionRemoved(session => {
        for (const sub of eventLog.subscriptions(session.id)) eventLog.unsubscribe(sub.id, session.id);
      });
      ctx.eventRouter = new EventRouter(eventLog, async (sub, event) => {
        if (sub.subject.startsWith('system:reminder:')) return deliverSystemReminderEvent(ctx, sub, event);
        if (sub.subject.startsWith('system:intent:')) {
          const claim = eventLog.claimLaunch(sub.id, event.sequence);
          if (claim === 'done') return;
          if (claim === 'uncertain') {
            ctx.notify.push({ workspaceId: sub.workspaceId, sessionId: '', sessionName: t('调度'), label: t('意图待核对'),
              text: t('意图事件 {{id}} 的处理结果不确定，请检查通知记录。', { id: event.id }), update: true,
              updateKey: `event-intent:${sub.id}:${event.id}`, toast: true });
            throw new Error('Intent event processing is uncertain after interruption');
          }
          const page = eventLog.payload(event.id, 0, 32000);
          if (!page || page.nextOffset !== null) throw new Error('Intent event payload unavailable');
          handleMemoryIntentEvent(ctx, JSON.parse(page.text));
          eventLog.finishLaunch(sub.id, event.sequence);
          return;
        }
        return deliverSubscriptionEvent(ctx, sub, event);
      }, undefined, (error, workspaceId) => {
        const target = workspaceId || ctx.workspaces.list()[0]?.id;
        if (!target) return;
        ctx.notify.push({ workspaceId: target, sessionId: '', sessionName: t('事件系统'), label: t('事件处理失败'),
          text: error instanceof Error ? error.message : String(error), update: true, updateKey: 'event-system-error', toast: true });
      });
      eventRouterRef = ctx.eventRouter;
      runtimeKernel.scope.add(() => ctx.eventRouter!.shutdown());
      tasks.bindTimeEventSink((task, at) => {
        ctx.eventRouter?.publish(timeEvent(task, at));
      });
      notifyBus.onFlip(flip => {
        ctx.eventRouter?.publish({ source: 'phase', type: flip.trigger, scope: flip.sessionId, workspaceId: flip.workspaceId,
          receivedAt: flip.ts, summary: `${flip.sessionName}: ${flip.trigger}`, payload: JSON.stringify(flip) });
      });

      ctx.safety = createSafetyServiceForContext(ctx, {
        userDataPath: app.getPath('userData'),
        onChanged: snapshot => {
          const win = ctx.getWindow();
          if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('safety:changed', snapshot);
        }
      });
      safetyRef = ctx.safety;
      sessions.setBusinessApproval(async (workspaceId, action, args, evidence, gitEvidence) => (await authorizeSafetyOperation(ctx, {
        workspaceId, action, args, evidence: gitEvidence ? undefined : evidence, gitEvidence, source: 'catalog',
        humanConfirm: (reason, signal) => confirmSessionOperation(ctx, action, args, reason, signal)
      })).allowed);
      ctx.agentApps = createAgentAppsService(ctx);
      try { ctx.feedback = createFeedbackService(ctx); }
      catch (error) { ctx.feedbackError = errorMessage(error); console.error('[feedback] startup failed:', error); }
      runtimeKernel.scope.add(() => ctx.agentApps!.stop());
      ctx.extensionSystem = createExtensionAppSystem(ctx);
      extensionSystemRef = ctx.extensionSystem;
      runtimeKernel.scope.add(() => ctx.extensionSystem!.stop());
      sessions.attachFactSink((facts) => {
        void dispatchRuntimeFacts(ctx, facts).catch((err: unknown) => {
          console.error('[awareness] subscribe dispatch failed', err);
        });
      });
      bindWorkspaceRootDependencies(ctx);

      // 证据归集器（T4.4）：pty 翻转切片 + bgTasks 摘要 + browser 截图（默认关），7 天滚动清理
      const evidence = new EvidenceCollector({
        userDataDir: app.getPath('userData'),
        getPtyTail: (sid: string, maxChars: number) => pty.getBufferTail(sid, maxChars),
        isBrowserShotEnabled: () => config.get().evidence?.browserShots === true
      });
      ctx.bindEvidence(evidence);
      sessions.attachEvidence(evidence);
      runtimeKernel.scope.add(() => evidence.stop());
      // Retain each surviving session's latest usable snapshot; purge deleted owners.
      startTurnChangesCleanupSweeper(ctx, app.getPath('userData'), turnChanges());
      stallScannerRef = new PipelineStallScanner({ ctx });
      const stallScanner = stallScannerRef;
      runtimeKernel.scope.add(() => stallScanner.shutdown());

      shellApi = new ShellApiServer(ctx);
      ctx.bindShellApi(shellApi);
      runtimeKernel.scope.add(() => shellApi!.stop());
      // 定时任务无头执行器：需要完整 AppContext（配置/工作区/store），在 ctx 就绪后绑定
      tasks.bindHeadless(ctx, (task, hooks) => runHeadlessPiTask(ctx, {
        wsId: task.workspaceId,
        sourceRoot: task.sourceRoot,
        abortKey: `task:${task.id}`,
        prompt: task.prompt,
        providerId: task.providerId,
        modelId: task.modelId,
        timeoutMs: 30 * 60 * 1000,
        onSessionReady: hooks?.onSessionReady,
        onOutput: hooks?.onOutput
      }));
      // GUI（chat surface）Worker 宿主：注册内置 driver（pi/cursor/claude/codex-gui）
      {
        const agentSessions = new AgentSessionHost(ctx, { userDataDir: app.getPath('userData') });
        runtimeKernel.scope.add(() => agentSessions.closeAll());
        registerAgentSessionDrivers(ctx, agentSessions, {
          userDataDir: app.getPath('userData'),
          runtimes: ctx.runtimes
        });
        ctx.bindAgentSessions(agentSessions);
        agentSessionsRef = agentSessions;
        // 定时任务 terminal 模式命中 GUI（chat surface）runtime 时经宿主 send 注入任务原文
        tasks.bindGuiHost(agentSessions);
        sessions.setChatSessionBridge({
          open: (s) => agentSessions.open(s),
          // close/release 必须交回 Promise：有 worktree 时 sessions 会 await 后再删目录
          close: (id, opts) => agentSessions.close(id, opts),
          refresh: (id) => void agentSessions.refresh(id),
          release: (id) => agentSessions.release(id),
          nativeHistory: (s) => s.runtime ? agentSessions.drivers.get(s.runtime)?.nativeHistory : undefined
        });
        agentSessions.onPush((p) => {
          if (p.kind !== 'busy' || p.busy !== false) return;
          if (p.outcome === 'network_error') {
            orchEventPump?.onTurnFailed(p.sessionId, {
              error: p.error,
              retryAttempts: p.retryAttempts
            });
            return;
          }
          orchEventPump?.onTurnEnd(p.sessionId);
        });
      }
      // GUI 会话后台任务（子代理/后台终端/定时器）：复用 pty 与 agentSessions，晚绑定
      {
        const bgTasks = new BackgroundTaskManager(ctx, {
          userDataDir: app.getPath('userData')
        });
        ctx.bindBgTasks(bgTasks);
        // 构建/测试输出摘要进证据链（T4.4；收集器只收 shell 类）
        bgTasks.onTaskFinished = (task) => ctx.evidence?.recordBgTaskFinished(task);
        bgTasksRef = bgTasks;
        runtimeKernel.scope.add(() => bgTasks.shutdown());
      }
      // 引擎侧孤儿清扫：早期版本删除会话不清引擎数据（Pi jsonl/trim-cache、Cursor
      // SDK 存储）的遗留与异常路径孤儿，启动后台扫一次；错开启动窗口避免与首轮
      // 定时任务/画布交接竞态
      {
        startupWork.schedule(15_000, signal => agentSessionsRef?.sweepEngineOrphans(signal));
      }
      // P1（2026-10-23）：宿主技能正文安装/升级链——包内真源 resources/skills（dev=仓库原地，
      // 打包=安装目录 extraResources）ensure 到 ~/.muster/skills（缺→写/包新→覆盖/磁盘≥包→
      // 不动）。必须先于 scaffold，确保显式加载在换机首启即可使用。
      try {
        const provisioned = provisionHostDomainSkills({
          bundledRootDir: resolveBundledSkillsDir({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            moduleDir: __dirname
          })
        });
        if (provisioned.errors.length > 0 || provisioned.invalidBundled.length > 0) {
          console.warn('[metaAgent] host domain skills provision incomplete:', JSON.stringify(provisioned));
        } else if (provisioned.installed.length + provisioned.updated.length > 0) {
          console.log('[metaAgent] host domain skills provisioned:', JSON.stringify(provisioned));
        }
      } catch (error) {
        console.error('[metaAgent] host domain skills provision failed:', error);
      }
      // Ensure scaffolds + notify before Shell api start, so start-time refresh does not swallow `created`.
      ensureAllWorkspacesMetaAgent(ctx);
      // 记忆重构 P0 地基（memory-refactor B1）：装配 per-workspace 记忆派生库
      // （.muster/memory/state.sqlite）。B3 起写路径（memory.note 工具/转录摄入/
      // 压缩前 flush）经 runtime getter 共用本实例；inject() 读路径接线在 B5。
      {
        memoryRef = new MemoryService();
        setMemoryService(memoryRef);
        const memory = memoryRef;
        runtimeKernel.scope.add(async () => { await stopMemoryCuratorsAndWait(); memory.closeAll(); });
        // 装配全局记忆目录；画像知识账本使用 <userData>/memory/knowledge。
        setUserProfileFilePath(app.getPath('userData'));
        setMemoryEnvironmentProvider(()=>({appVersion:app.getVersion(),executorResultMaxChars:String(RESULT_MAX_CHARS),mcpCallResultMaxChars:String(MCP_CALL_RESULT_MAX_CHARS),mcpHubMaxChars:String(MCP_RESULT_MAX_CHARS)}));
        for (const ws of ctx.workspaces.list()) {
          const root = workspaceManagementRoot(ws);
          if (!root) continue;
          try {
            memoryRef.init(root);
            for (const namespace of ['worker','scheduler','profile'] as const) memoryRef.knowledge(root,namespace);
          } catch (err) {
            console.error('[memory] 派生库初始化失败', root, err);
          }
        }
      }

      // X7-F05：Shell API 是 Agent 工具面，桌面 UI 本身不依赖它——监听失败
      // （EMFILE/权限/EACCES 等，随机端口下低概率）降级为错误提示而非中断整条
      // 启动链（对照 webAccess.start / startCliRuns 的姿态）；baseUrl 为空串时
      // pty 注入的 MUSTER_* 环境变量同为空，Agent 工具面一致降级。


      pty.getHostEnv = (sessionId) => {
        const s = sessions.get(sessionId);
        // 后台任务 PTY（bg-* 键）不进会话注册表：不注入宿主身份环境，也不领状态 token
        if (!s) return {};
        const token = sessions.ensureStatusToken(sessionId);
        const base = shellApi!.baseUrl;
        // X7-F05：Shell API 启动失败降级后 baseUrl 为空——不注入残缺的宿主身份环境
        if (!base) return {};
        const statusUrl = `${base}/v1/s/${token}/status`;
        const toolUrl = `${base}/v1/tool`;
        const env: Record<string, string> = {
          MUSTER_HOST: '1',
          MUSTER_VERSION: app.getVersion(),
          MUSTER_SHELL_API: base,
          /** 已绑定本会话：POST 只需 {label} */
          MUSTER_STATUS_URL: statusUrl,
          MUSTER_TOOL_URL: toolUrl,
          /** 调 /v1/tool 时 Authorization: Bearer <token>，可省略身份参数 */
          MUSTER_SESSION_TOKEN: token
        };
        if (s?.workspaceId) env.MUSTER_WORKSPACE_ID = s.workspaceId;
        if (s?.name) env.MUSTER_SESSION_NAME = s.name;
        if (s?.runtime) env.MUSTER_RUNTIME = s.runtime;
        // 一份 JSON，方便 Agent 一次读全；勿再 sessions.observe 查自己
        env.MUSTER_SELF = JSON.stringify({
          statusUrl,
          toolUrl,
          token,
          workspaceId: s?.workspaceId ?? null,
          sessionName: s?.name ?? null,
          runtime: s?.runtime ?? null
        });
        return env;
      };

      const ptyPidBySession = new Map<string, number>();
      pty.onAuxiliaryPids = (sessionId, pids) => bindSessionProcessRoots(sessionId, pids, pty.getHostEnv?.(sessionId) ?? {});
      pty.onPtyPid = (sessionId, pid) => {
        const prev = ptyPidBySession.get(sessionId);
        if (prev != null) removeInboundMcpPidRecord(prev);
        if (pid == null || pid <= 0) {
          ptyPidBySession.delete(sessionId);
          return;
        }
        ptyPidBySession.set(sessionId, pid);
        const env = pty.getHostEnv?.(sessionId) ?? {};
        const token = env.MUSTER_SESSION_TOKEN?.trim();
        const statusUrl = env.MUSTER_STATUS_URL?.trim();
        const toolUrl = env.MUSTER_TOOL_URL?.trim();
        if (!token || !statusUrl || !toolUrl) return;
        writeInboundMcpPidRecord({
          ptyPid: pid,
          sessionId,
          token,
          statusUrl,
          toolUrl
        });
      };

      const orchestrator = new Orchestrator(ctx);
      runtimeKernel.scope.add(() => orchestrator.shutdown());
      ctx.bindOrchestrator(orchestrator);
      orchestratorRef = orchestrator;
      const coreReasoningCatalog = new CoreReasoningCatalogStore(
        path.join(userDataStorage(app.getPath('userData')).resolve('app', 'cache'), 'core-reasoning-v1.json'),
        () => {
          setPublishedModelInputSpecifications(coreReasoningCatalog.snapshot.capabilities);
          ctx.getWindow()?.webContents.send('agentSession:coreReasoningCatalogUpdated', {});
          void ctx.agentSessions?.refreshModelParameters();
          orchestrator.emitContextStatus(orchestrator.activeWorkspaceId);
        },
        net.fetch.bind(net) as typeof fetch
      );
      ctx.coreReasoningCatalog = coreReasoningCatalog;
      runtimeKernel.scope.add(coreReasoningCatalog.start(() => piReasoningSources(() => config.get()), callback => config.onChanged(callback)));
      requestFeedbackAiCheck(ctx);

      const policyRootOf = (workspaceId: string): string | undefined =>
        config.get().workspaces.find((w) => w.id === workspaceId)?.path;
      const orchPump = new OrchestratorEventPump({
        ctx,
        // 守卫状态持久化（O3）：fired/lastActivity 落 userData，重启不丢
        guardStateDir: app.getPath('userData'),
        // R-12：任务翻转/相位翻转/flush 后 30s 节流重写调度态势快照（SITUATION.md）
        onSituationChange: noteSchedulerSituationChanged,
        // C1 订阅策略：每工作区 .muster/scheduler/subscription-policy.json（缺省=内置默认）
        policyFor: (workspaceId) => {
          const root = policyRootOf(workspaceId);
          return root ? getSubscriptionPolicyStore().get(root) : null;
        },
        onPolicyDecision: (workspaceId, decision) => {
          const root = policyRootOf(workspaceId);
          if (root) getSubscriptionPolicyStore().noteHit(root, decision.ruleId, decision.action, Date.now());
        }
      });
      // 态势快照节流器的进程内 ctx（事件缝回调无参，装配时注入）
      bindSchedulerSituationContext(ctx);
      orchEventPump = orchPump;
      runtimeKernel.scope.add(() => orchPump.shutdown());
      bindOrchestratorEventPump(orchPump);
      // 轻量动态工作流（W1）：waitFor 挂泵旁听点，进度以 workflow 事件进泵；
      // 未结束的 run 稍后续跑（等派活/会话等装配完成）
      const workflowWiring = createWorkflowRuntime(ctx, orchPump);
      bindWorkflowRuntime(workflowWiring.runtime);
      workflowRuntimeRef = workflowWiring.runtime;
      runtimeKernel.scope.add(workflowWiring.dispose);
      // 收口/收尾提醒进事件源（R-09/R-19）：sessionAgentTask / git 采纳 / PR 轮询 →
      // settleNotify 缝 → 泵（工作区级信号，复用合并窗口与守卫 hold 语义）。
      // 只带 sessionName 做归因、不带 sessionId——带 id 会刷新会话活动/清心跳键，
      // 而收口提醒不代表该会话仍活跃。
      setSettleNotifyListener((e) => {
        orchPump.enqueue({
          kind: 'settle_warn',
          workspaceId: e.workspaceId,
          sessionName: e.sessionName,
          extraKey: e.extraKey,
          detail: e.detail
        });
      });
      // B7 意图事件面：会话相位翻转（needs_you/done/error）→ 意图谓词扫描
      notifyBus.onFlip((flip) => {
        emitMemoryIntentEvent({
          kind: 'notify_flip',
          workspaceId: flip.workspaceId,
          trigger: flip.trigger,
          sessionId: flip.sessionId
        });
      });
      // B7 意图事件面消费者装配（事件缝 → 工作区库扫描 → 命中通知；幂等）
      bindMemoryIntentEvents(ctx);
      // R-16：事件注册表 emitters 悬空清理——按在册会话 + 各工作区调度合成 id，
      // 清 `.muster/events/` 各状态目录里 emitters 的死会话 id（注册本身不删）
      try {
        const aliveEventIds = listAliveAwarenessSessionIds(
          ctx.sessions.list().map((s) => s.id),
          ctx.workspaces.list().map((w) => w.id)
        );
        // F-01：感知摘要（shares）同一套 alive 集清理——已删工作区的 orchestrator:<wsId>
        // 摘要与应用外删除/崩溃丢失的会话摘要不再永久滞留 runtime-awareness.json
        const prunedShares = ctx.awareness?.pruneShares(aliveEventIds) ?? [];
        if (prunedShares.length) {
          console.log(`[awareness] 已清理 ${prunedShares.length} 条失效会话/工作区的状态共享栏摘要`);
        }
        for (const ws of ctx.workspaces.list()) {
          const root = workspaceManagementRoot(ws);
          if (!root) continue;
          const pruned = getEventRegistry().pruneStaleEmitters(root, aliveEventIds);
          if (pruned.length) {
            console.log(`[events] 已清理 ${pruned.length} 个事件的悬空 emitters（${root}）`);
          }
        }
      } catch (err) {
        console.error('[events] emitters 悬空清理失败', err);
      }
      setDelegateSlotFreedListener((wsId) => orchPump.onSlotFreed(wsId));
      setMergeBlockedListener(({ mainRepo, branch, files }) => {
        const cfg = ctx.config.get();
        const target = mergeNotificationTarget(cfg, id => ctx.sessions.listByWorkspace(id), mainRepo, branch);
        if (!target) { console.warn('[merge] blocked notification has no unique workspace', mainRepo, branch); return; }
        const { workspaceId, session: sess } = target;
        noteMergeBlocked({
          workspaceId,
          sessionId: sess?.id,
          sessionName: sess?.name,
          files
        });
        // B7 意图事件面：合入受阻 → 意图谓词扫描（缝内全兜底）
        emitMemoryIntentEvent({ kind: 'merge_blocked', workspaceId, branch, repo: mainRepo });
      });
      sessions.onLifecycle((s, prev, next) => {
        if (prev === 'working' && next === 'idle' && !s.hidden) orchPump.onTurnEnd(s.id);
      });
      // 普通邮件在空闲后合并提醒；订阅插话与一次性续接分别走各自的持久投递路径。
      const mailboxOwner = attachMailboxWakes(ctx);
      mailboxOwnerRef = mailboxOwner;
      runtimeKernel.scope.add(() => mailboxOwner());
      const detachResumeWait = attachResumeWait(ctx, app.getPath('userData'));
      app.once('before-quit', detachResumeWait);
      attachMailboxPresentation(ctx);
      reflogWatchDisposer = startGitReflogWatches(ctx, orchPump);
      runtimeKernel.scope.add(() => reflogWatchDisposer!.shutdown());

      registerMetaAgentWsProtocol(ctx);
      const fsWatcher = new WorkspaceFsWatcher(ctx);
      runtimeKernel.scope.add(() => fsWatcher.shutdown());
      // T3.3 file 触发源：防抖后的工作区相对路径 → 事件触发任务评估（按工作区限定）
      fsWatcher.onChanged = (workspaceId, relativePaths, rootId) => {
        orchEventPump?.onFsChanged(workspaceId, relativePaths);
        const at = Date.now();
        for (const rel of relativePaths) {
          // '' 是拿不到具体路径的全量刷新兜底，无法做 path 匹配，跳过
          if (!rel) continue;
          ctx.eventRouter?.publish({ source: 'file', type: 'changed', scope: rootId, workspaceId,
            receivedAt: at, summary: rel.slice(0, 1000), payload: JSON.stringify({ path: rel, rootId, workspaceId, at }) });
        }
      };
      fsWatcherRef = fsWatcher;
      const messagingDataDir = storage.resolve('app', 'messaging');
      // AI Office is an explicit task connector; IM channels remote the existing workbench.
      const messagingSessions = new MusterMessagingSessionHost(ctx);
      const messagingWorkbench = new WorkbenchMessagingHost(ctx);
      const messagingBindings = new RemoteBindingService({
        file: path.join(messagingDataDir, 'remote-bindings.json'),
        dispatch: input => messagingWorkbench.handle(input),
        releaseAuthorization: id => messagingWorkbench.releaseAuthorization(id)
      });
      const logicalChannels = new LogicalChannelService({
        file: path.join(messagingDataDir, 'logical-channels.sqlite'),
        workspaceIds: () => ctx.workspaces.list().map(workspace => workspace.id),
        workspaceExists: id => ctx.workspaces.list().some(workspace => workspace.id === id),
        connected: (channel, botId, signal) => messagingHost.accountConnected(channel, botId, signal),
        send: (source, message, signal) => messagingHost.sendLogicalText(source, message, signal),
        remote: {
          intent: (input, scope) => messagingBindings.intent(input, scope),
          isPairingSecret: text => messagingBindings.isPairingSecret(text),
          handle: (input, scope) => messagingBindings.handle(input, scope),
          manage: (scope, method, bindingId) => {
            try { return messagingBindings.manageScope(scope, method, bindingId); }
            catch (error) {
              const reason = error instanceof Error ? error.message : '';
              throw new LogicalChannelError(['remote-limit', 'remote-binding-not-found', 'cancelled'].includes(reason)
                ? reason : 'remote-store-unavailable');
            }
          },
          revoke: scope => messagingBindings.revokeScope(scope),
          revokeLegacySource: source => messagingBindings.revokeLegacySource(source)
        },
        legacy: createLogicalChannelLegacyAdapter(ctx)
      });
      const messagingHost: MessagingHost = new MessagingHost({
        dataDir: messagingDataDir,
        credentials: new MessagingCredentialStore({
          file: path.join(messagingDataDir, 'credentials.json'), cipher: safeStorage, platform: process.platform
        }),
        createOfficeHarness: options => messagingSessions.createHarness(options, 'office'),
        claimFeishuConsumer,
        claimImapConsumer: async (mailbox, owner) => {
          if (!ctx.agentApps) throw new Error('imap-mailbox-identity-invalid');
          await ctx.agentApps.prepareImapReservations();
          return imapConsumerArbiter.claim(mailbox, owner);
        },
        handleRemote: input => logicalChannels.receive(input),
        beforeAccountRemoval: (channel, botId, deleting) => {
          logicalChannels.revokeAccount(channel, botId, deleting);
          messagingBindings.revokeAccount(channel, botId);
        },
        onDiagnostic: diagnostic => console.warn('[messaging]', diagnostic.channel, diagnostic.code,
          diagnostic.referenceId ?? '', diagnostic.reason ?? '')
      });
      ctx.messaging = messagingHost;
      ctx.messagingChannels = logicalChannels;
      let channelRevision = 0;
      logicalChannels.subscribe(change => {
        const win = ctx.getWindow();
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('agentApps:changed', {
          workspaceId: change.workspaceId, appId: 'muster.channel', revision: ++channelRevision
        });
      });
      const messagingChannels = {
        start: () => messagingHost.start(),
        stopAdmission: () => {
          logicalChannels.stopAdmission(); messagingBindings.stopAdmission(); messagingWorkbench.stopAdmission();
          messagingSessions.stopAdmission(); messagingHost.stopAdmission();
        },
        stopAndWait: async () => {
          messagingBindings.stopAdmission();
          const results = await Promise.allSettled([
            logicalChannels.stopAndWait(), messagingWorkbench.stopAndWait(), messagingSessions.stopAndWait(), messagingHost.stopAndWait()
          ]);
          const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Message channels did not finish closing');
        }
      };
      messagingChannelsRef = messagingChannels;
      const domains = runtimeKernel.domains;
      const registerHostDomains = (): void => {
        registerHostEntrypointDomains({
          domains,
          ctx,
          getWindow,
          config,
          storage,
          shellApi: shellApi!,
          notifyBus,
          userDataDir: app.getPath('userData'),
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appVersion: app.getVersion(),
          appInstanceId: appInstance.id,
          sandbox: process.env.MUSTER_SANDBOX === '1' || !!process.env.MUSTER_INSTANCE_ID,
          setWebAccess: server => { webAccessRef = server; },
          setCliStopAdmission: stopAdmission => { cliStopAdmission = stopAdmission; }
        });
      };
      await registerRuntimeDomains({
        domains,
        registerIpcDomains: () => registerIpc(domains, ctx, orchestrator, fsWatcher, () => reflogWatchDisposer?.sync()),
        registerHostDomains,
        eventRouter: ctx.eventRouter!,
        stallScanner,
        evidence,
        messagingChannels,
        orchestratorEvents: orchPump,
        orchestrator,
        closeGuiSessions: () => agentSessionsRef?.closeAll(),
        workflow: workflowWiring,
        promptTasks: tasks,
        restoreMemoryCurators: () => restoreMemoryCurators(ctx),
        stopMemoryCuratorsAndWait,
        disposeNodeRepl: disposeAllNodeRepl,
        backgroundTasks: { shutdown: () => bgTasksRef?.shutdown() },
        mailboxOwner,
        applyExtensions: () => runtimeKernel.apply({ id: 'muster.extensions', version: '1', apply: ({ domain }) => domain.register({
          id: 'extensions',
          dependsOn: ['background-tasks', 'mailbox-admission'],
          start: (_runtimeContext, scope) => {
            // Extension discovery/review owns its startup resources through the
            // same domain scope as the session kernel. Shutdown therefore waits
            // for GUI persistence before stopping extension workers and panels.
            const system = ctx.extensionSystem;
            if (!system) throw new Error('Extension system is unavailable');
            system.start();
            scope.add(() => system.stop());
          }
        }) })
      });
      await runtimeKernel.start();
      // Initialize availability and active-source model catalogs once per app launch.

      {
        const ports = loadInstancePorts(app.getPath('userData'));
        const kind =
          process.env.MUSTER_SANDBOX === '1'
            ? 'sandbox'
            : process.env.MUSTER_INSTANCE_ID
              ? 'e2e'
              : 'user';
        const heartbeatStartedAt = Date.now();
        writeInstanceHeartbeat({
          id: appInstance.id,
          pid: process.pid,
          startedAt: heartbeatStartedAt,
          updatedAt: heartbeatStartedAt,
          aumid: appInstance.aumid,
          userData: app.getPath('userData'),
          kind,
          shellApiPort: ports?.shellApiPort,
          webAccessPort: ports?.webAccessPort ?? ctx.webAccess?.getStatusInfo().port
        });
        // X7-F06：心跳周期刷新（5min）——updatedAt 不再恒等于 startedAt，字段语义
        // 如实反映「实例仍活着」；计时器和已受理写入统一归启动scope。
        startupWork.schedule(5 * 60_000, () => {
          writeInstanceHeartbeat({
            id: appInstance.id,
            pid: process.pid,
            startedAt: heartbeatStartedAt,
            updatedAt: Date.now(),
            aumid: appInstance.aumid,
            userData: app.getPath('userData'),
            kind,
            shellApiPort: ports?.shellApiPort,
            webAccessPort: ports?.webAccessPort ?? ctx.webAccess?.getStatusInfo().port
          });
        }, true);
        // 单实例锁（X5-F01）收敛后，「另有实例」只剩两种可达形态：主实例是未带锁的
        // 旧版本、或平台锁失效——都意味着同一 userData 的数据面竞争仍在，保留警示；
        // 跨 userData 共存（dev 沙箱 + 安装版）是刻意支持形态，不再打扰。
        const userDataDir = app.getPath('userData');
        const others = listAppInstances().filter(
          (x) => x.pid !== process.pid && x.userData === userDataDir
        );
        if (others.length) {
          const wsId = config.get().activeWorkspaceId;
          if (wsId) {
            notify.push({
              workspaceId: wsId,
              sessionId: `app-instance:${appInstance.id}`,
              sessionName: t('工作台'),
              text: t('同一数据目录仍有 {{n}} 个工作台实例在运行（可能为旧版本），会话与设置可能互相覆盖，建议只保留一个', {
                n: others.length
              }),
              toast: true,
              update: true,
              updateKey: 'app-instances'
            });
          }
        }
      }
    } catch (err) {
      // 放行渲染层但把失败如实传出去：此时大量 ipcMain.handle 未注册，
      // 直接挂主界面只会得到满屏「No handler registered」。
      bootError = errorMessage(err);
      console.error('[boot] background init failed:', err);
      shellApi?.stopAdmission();
      webAccessRef?.stopAdmission();
      cliStopAdmission?.();
      stopIpcAdmission();
      startupWorkRef?.stopAdmission();
      ptyRef?.stopAdmission();
      tasksRef?.stopAdmission();
      eventRouterRef?.stopAdmission();
      stallScannerRef?.stopAdmission();
      fsWatcherRef?.stopAdmission();
      orchEventPump?.stopAdmission();
      sessionsRef?.stopMonitoring();
      reflogWatchDisposer?.();
      messagingChannelsRef?.stopAdmission();
      stopMemoryCuratorAdmission();
      workflowRuntimeRef?.stopAdmission();
      mailboxOwnerRef?.();
      try { await runtimeKernelRef?.dispose(); }
      catch (cleanupError) {
        console.error('[boot] runtime cleanup failed:', cleanupError);
        bootError += `\n${errorMessage(cleanupError)}`;
      }
    } finally {
      const result: BootResult = bootError ? { ok: false, error: bootError } : { ok: true };
      resolveBoot(result);
      // X7-F01：bootWait 15s 兜底超时的渲染层已降级挂载，等这个事件（或 bootWait
      // 迟到的 resolve）到达后重拉初始数据补齐；正常路径渲染层早在 bootWait 拿到。
      try {
        mainWindow?.webContents.send('app:boot:ready', result);
      } catch (err) {
        console.warn('[boot] boot:ready event send failed:', err);
      }
      console.log(`[boot] background init done @+${Date.now() - bootT0}ms`);
    }
  })();
});

