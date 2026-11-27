import { useSessionsPeekHover } from './components/useSessionsPeekHover';
import { isWebGateway } from './webGatewayEnvironment';
import { guardVirtualScreenScroll } from './virtualScreenScrollGuard';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { t } from '../../shared/i18n';
import { resolveWorkspaceId } from '../../shared/workspaceFallback';
import { SessionsHotZone } from './components/SessionsHotZone';
import { SessionsFloatSurface } from './components/SessionsFloatSurface';
import { useSessionsPeekEscape } from './components/useSessionsPeekEscape';
import { LeftPanel, type UtilitySelection } from './panels/LeftPanel';
import { CenterPanel } from './panels/CenterPanel';
import { SideToolsPanel } from './panels/SideToolsPanel';
import { AgentFloat } from './panels/AgentFloat';
import { GlobalBoard } from './panels/GlobalBoard';
import { ProcessMonitorPanel } from './panels/ProcessMonitorPanel';
import { requestMemoryCenterTab } from './memoryCenterRoute';
import { ChromeBar } from './components/ChromeBar';
import { QuickOpen } from './components/QuickOpen';
import { prewarmQuickOpenFiles } from './components/useQuickOpenQueries';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ExtensionUiDialogLazy } from './components/ExtensionUiDialogLazy';
import type { SettingsTab } from './components/settings/SettingsModal';
import { SettingsSurfacePortal } from './components/settings/SettingsSurfacePortal';
import { normalizeSettingsTab } from '../../shared/commandPalette';
import { WorkspaceSkeleton } from './components/WorkspaceSkeleton';
import { SelectionMenuHost } from './components/SelectionMenuHost';
import { EvidencePanel } from './components/EvidencePanel';
import { FileNoteEntryHost } from './components/FileNoteEntryHost';
import { WebNoteEntryHost } from './components/WebNoteEntryHost';
import { TooltipHost } from './components/Tooltip';
import { TextToolResultCard } from './components/TextToolResultCard';
import { ErrorTip } from './components/ErrorTip';
import { SetupCompletion, WorkbenchSetupGuide } from './onboarding/WorkbenchSetupGuide';
import type { DesktopSetup } from './onboarding/setupProgress';
import {
  loadHSwitchMode,
  saveHSwitchMode,
  SplitExpandControl,
  type HSwitchMode
} from './components/SplitExpandControl';
import { pulseHStripBusy, useChatStore, useSessionStore, useUiStore, useWorkspaceStore } from './store';
import { CliRunNavigation } from './components/CliRunNavigation';
import { useHistoryWsId } from './panelHistory';
import { LeftNavigationRecorder, type LeftNavigationController } from './hooks/useLeftNavigationHistory';
import { loadRightPanelRestore, saveRightPanelRestore } from './rightPanelRestore';
import { useWorkspaceFile } from './hooks/useWorkspaceFile';
import { useGlobalSidebarWidth } from './sidebarPreferences';
import { useCenterSplitPrefs } from './hooks/useCenterSplitPrefs';
import { resolveActualCenterSelection, resolveCenterSplitPrimary, supportsCenterSplitRef } from './centerSplitSupport';
import { getCenterSplitPaneRefs, samePaneRef, type SplitPaneRef } from '../../shared/centerSplit';
import { RIGHT_UTILITY_TITLES } from '../../shared/rightWorkspace';
import { useCenterSplitSelection } from './hooks/useCenterSplitSelection';
import { useExtensionWorkbenchNavigation as useWorkbenchNavigation } from './extensionWorkbench';
import { centerFileDockKey, centerFileHostKey, onCenterUtilityRequest, releaseDockTarget, requestRightPin, rightDockKey, rightDockSnapshot, showInCenter, useRightDock } from './rightDock';
import { isWorkspaceFileClosePending, prepareWorkspaceFileClose, type WorkspaceFileCloseTransaction } from './workspaceFileClose';
import { usePanelCenterFocus } from './hooks/usePanelCenterFocus';
import { visualHDock, type HDockPage } from '../../shared/workspaceUiPersist';
import { loadVirtualScreenPage, saveVirtualScreenPage } from './virtualScreenPagePreference';
import { resolveAppearance } from '../../shared/resolvedAppearance';
import { workspaceAccent, workspaceAccentEnabled } from '../../shared/workspaceAccent';
import { getTheme } from './theme';
import { getTerminalCapture } from './terminalRegistry';
import { releaseTerminalFocus } from './keybindings/KeybindingHost';
import { getSetupInteractionLock } from './keybindings/overlayStack';
import { useAppKeybindings } from './hooks/useAppKeybindings';
import {
  getChatFindShared,
  isChatFindDomTarget,
  isFilesFindDomTarget,
  patchChatFindShared,
  resolveChatFindTarget
} from './chatSurface/chatFindRegistry';
import { setPreferredFindSurface } from './keybindings/findSurface';
import { usePresence, prefersReducedMotion } from './components/motion';
import {
  createWorkspaceTransit,
  WorkspaceTransitContext,
  type TransitPhase,
  type WorkspaceTransit,
  type WorkspaceTransitLayout
} from './workspaceTransit';
import { usePageActivation } from './hooks/usePageActivation';
import { ExtensionHomePeekContext } from './components/ExtensionSurface';
import {
  attachCenterSplitBridge,
  centerSplitClose,
  centerSplitClosePane,
  centerSplitReconcilePrimary,
  centerSplitSelectAgentRef,
  centerSplitToggleShortcut,
  centerSplitTryFill,
  getCenterSplitState,
  useCenterSplit,
  pruneCenterSplit
} from './centerSplitStore';
import { loadSessionsOpen, saveSessionsOpen } from './sessionsVisibility';
import { agentCenterFilesVersion, applyAgentRightLayout, closeAgentRightTab, focusAgentRightTab, openAgentRightContent, prepareAgentCenterFile, readAgentCenterFile, readRightPanelState, releaseAgentCenterFile, rightLayoutMatches, subscribeAgentCenterFiles } from './rightPanelState';
import { usePanelAxisFocus } from './hooks/usePanelAxisFocus';
import { usePanelRightReveal } from './hooks/usePanelRightReveal';
import { canFocusCenterTarget, focusCenterPaneElement, focusVisibleCenterPane } from './panelCenterFocus';
import { usePanelSplit } from './hooks/usePanelSplit';
import { usePanelCenterClose } from './hooks/usePanelCenterClose';
import { readFileEditorStates } from './fileEditorState';
import { panelNavigationCurrent } from './panelNavigationIdentity';
import { panelFilesCurrent } from './panelFileIdentity';
import { settlePanelVisibility } from './panelVisibility';
import type { CenterFileBinding, CenterNavigationIdentity, PanelRightLayoutResponse } from '../../shared/panelState';
import type { ExtensionNavigationSnapshot } from '../../shared/extension';

type BackgroundCenterView = { id: string; workspaceId: string; target: Exclude<SplitPaneRef, { kind: 'empty' }>;
  navigation?: CenterNavigationIdentity; file?: CenterFileBinding; background?: boolean };
function backgroundViewAvailable(item: BackgroundCenterView, sessions: ReadonlyArray<{ id: string; type: string; archived?: boolean; workspaceId?: string | null }>, navigation?: ExtensionNavigationSnapshot): boolean {
  const target = item.target;
  if (target.kind === 'session') return sessions.some(session => session.id === target.sessionId && session.type === 'terminal' && !session.archived && session.workspaceId === item.workspaceId);
  if (target.sel.startsWith('center-file:')) return !!item.file && panelFilesCurrent(item.workspaceId, [target], [item.file]);
  if (!target.sel.startsWith('nav:')) return !item.navigation;
  return !!item.navigation && panelNavigationCurrent(item.workspaceId, [target], [{ sel: target.sel, ...item.navigation }], navigation);
}

function centerFileLabel(file: CenterFileBinding): string {
  try { const content = JSON.parse(file.content) as { path?: unknown }; return typeof content.path === 'string' ? content.path.replace(/\\/g, '/').split('/').pop() || content.path : ''; }
  catch { return ''; }
}

function centerFileHostVisible(file: CenterFileBinding): boolean {
  const hosts = [...document.querySelectorAll<HTMLElement>('[data-dock-host]')].filter(host => host.dataset.dockHost === centerFileDockKey(file.tabId));
  if (hosts.length !== 1 || !hosts[0]!.isConnected) return false;
  const editor = hosts[0]!.querySelector<HTMLElement>('.right-content-page.is-shown .file-editor');
  if (!editor || !editor.isConnected) return false;
  const rect = editor.getBoundingClientRect(), style = getComputedStyle(editor);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function waitForCenterFileHost(file: CenterFileBinding, current: () => boolean): Promise<void> {
  const deadline = Date.now() + 3500;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (!current()) { reject(new Error('Center file changed before its host became visible')); return; }
      if (centerFileHostVisible(file)) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error('Center file host was not confirmed; inspect before retrying')); return; }
      requestAnimationFrame(check);
    };
    check();
  });
}

/** 设置弹窗低频且体积大：懒加载分包，首开才取 chunk（仅条件渲染，fallback null 即可）。
 *  首开实测有百毫秒级卡顿（chunk 加载/求值 + 全树渲染），空闲预取消掉其中
 *  chunk 加载/求值这部分，剩余的模态挂载渲染成本仍留在首开。
 *  预取失败静默放弃（dev/HMR 抖动不必报警）。注意模块图会缓存失败结果：
 *  求值期抛错时首开 lazy 同样失败（与无预取一致）；但瞬时 fetch 失败也会被
 *  缓存，预取会把这种偶发失败提前钉死到会话周期（生产从磁盘 loadFile，风险小）。
 *  loader 提为共享常量：lazy 工厂与预取必须指向同一 chunk，防日后改路径漂移。 */
type SettingsModalModule = typeof import('./components/settings/SettingsModal');
/** 预取/首开取到后缓存：此后直接渲染真组件，不再经 lazy 挂起——lazy 首次渲染必挂起一拍，
 *  模态会在 presence 已切 in 之后才挂上，首开丢入场动画 */
let settingsModalMod: SettingsModalModule | null = null;
const loadSettingsModal = (): Promise<SettingsModalModule> =>
  import('./components/settings/SettingsModal').then((m) => {
    settingsModalMod = m;
    return m;
  });
const SettingsModalLazy = React.lazy(() =>
  loadSettingsModal().then((m) => ({ default: m.SettingsModal }))
);
const FirstRun = React.lazy(() => import('./onboarding/FirstRun').then(module => ({ default: module.FirstRun })));
type SettingsModalComponent = React.ComponentType<React.ComponentProps<typeof SettingsModalLazy>>;
if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
  // 守卫让模块级副作用在无 rIC / 无 window 的环境（jsdom、node）天然 no-op，
  // 不依赖「当前没有测试导入本模块」这类会腐化的事实。
  // timeout=8000 保证主线程持续繁忙时最迟 8s 也会预取（chunk 求值可能落在
  // 交互中段）——防饿死与完美避让不可兼得，取防饿死。
  window.requestIdleCallback(() => {
    void loadSettingsModal().catch(() => {});
  }, { timeout: 8000 });
}

async function handleTerminalCaptureRequest(p: {
  requestId: string;
  sessionId: string;
}): Promise<void> {
  let restore: (() => void) | undefined;
  try {
    const handle = getTerminalCapture(p.sessionId);
    if (!handle) {
      window.api.terminal.replyCapture(p.requestId, { ok: false, error: t('终端视图未挂载') });
      return;
    }
    restore = await handle.prepare();
    const dataUrl = handle.getCanvasDataURL();
    if (!dataUrl) {
      window.api.terminal.replyCapture(p.requestId, { ok: false, error: t('画布为空') });
      return;
    }
    window.api.terminal.replyCapture(p.requestId, { ok: true, dataUrl });
  } catch (e) {
    window.api.terminal.replyCapture(p.requestId, {
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    });
  } finally {
    try {
      restore?.();
    } catch {
      /* ignore */
    }
  }
}

/** 横向虚拟屏：（会话+终端）↔ Git */
export type HDock = HDockPage;

/**
 * 比例相对整个 main-view 宽度（两侧可不等宽）。
 * - 工作页主态 7/8 → 右侧 Git 只露 1/8
 * - Git 主态 2/3 → 左侧工作页露 1/3
 * 非虚拟：工作页吃满视口
 *
 * 两个主态比例各自独立、各自持久化（workspace.json
 * `hTerminalRatio` / `hGitRatio`）。长按出钮左右拖 = 拖分割边界本身
 * （跟手），谁是主态调谁；另一侧露出量随视口自然得出。
 */
const TERM_RATIO_DEFAULT = 7 / 8;
const TERM_RATIO_MIN = 0.5;
const TERM_RATIO_MAX = 0.95;
const GIT_RATIO_DEFAULT = 2 / 3;
const GIT_RATIO_MIN = 0.5;
const GIT_RATIO_MAX = 0.95;
/** 专注模式会话侧占比（中段把手长按拖跟手调节，两侧之和恒为全宽） */
const FOCUS_RATIO_DEFAULT = 0.5;
const FOCUS_RATIO_MIN = 0.25;
const FOCUS_RATIO_MAX = 0.75;
const STATIC_LEFT_W_RATIO = 1 / 5;
const LEFT_W_MIN = 200;
/** 未拖过时的自适应比例上限；手动拖拽可到 LEFT_W_MAX */
const AUTO_LEFT_W_MAX = 280;
const LEFT_W_MAX = 480;
/** 悬浮会话栏自动收回延迟：指针离开「面板 ∪ 热区」后多久收（防快速斜穿左缘误收） */
const SESSIONS_FLOAT_HIDE_MS = 500;

/** 左栏宽解析：拖过用像素值（限页宽 45%），否则按比例自适应 */
function resolveLeftW(explicit: number | null, pageW: number): number {
  if (explicit != null) {
    return clamp(explicit, LEFT_W_MIN, Math.min(LEFT_W_MAX, Math.round(pageW * 0.45)));
  }
  return clamp(Math.round(pageW * STATIC_LEFT_W_RATIO), LEFT_W_MIN, AUTO_LEFT_W_MAX);
}

const HOVER_SWITCH_MS = 280;
const HOVER_COOLDOWN_MS = 300;
type WsTransit = {
  /** 目标在列表更靠上 → 1：骨架从上进；否则 -1 */
  dir: 1 | -1;
  /**
   * arm：无动画停在实况
   * to-skel：滑到骨架
   * fade：骨架淡出露出实况（切区已完成）
   */
  phase: TransitPhase;
  /** 开启动画时锁定，避免切换中布局抖动 */
  leftW: number;
  virtualScreen: boolean;
  hDock: HDock;
  termRatio: number;
  gitRatio: number;
  frameColor?: string;
  canvasColor?: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/**
 * main-view 壳：agent-expanded/agent-collapsed 类来自 chat store（流式期间
 * 随消息引用逐拍变化）。壳单独消费 chat store——App 不再订阅 chat 状态，
 * token 风暴只重渲这一个 div；children 由 App 传入、元素引用在其渲染间稳定，
 * 壳自身重渲时子树按元素引用直接跳过（DOM 结构与原实现完全一致）。
 */
function MainViewShell({
  viewRef,
  className,
  styleVars,
  schedulerOverviewOpen,
  children
}: {
  viewRef: React.RefObject<HTMLDivElement>;
  className: string;
  styleVars: React.CSSProperties;
  schedulerOverviewOpen: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { chatWorkspaceId } = useChatStore();
  return (
    <div
      className={`${className} ${chatWorkspaceId ? 'agent-expanded' : 'agent-collapsed'}`}
      ref={viewRef}
      style={styleVars}
      {...(schedulerOverviewOpen ? { inert: '' } : {})}
    >
      {children}
    </div>
  );
}

/**
 * 确认请求边沿自动开调度面板（保持原行为：首轮 hydrate 不弹）。
 * 留在 chat store 消费侧的空渲染子组件里，避免把 App 拖进每 token 的重渲路径。
 */
function ChatAutoOpener(): null {
  const { confirms } = useUiStore();
  const { activeWorkspaceId } = useWorkspaceStore();
  const { setChatWorkspaceIdAndLoad } = useChatStore();
  const prevConfirmsLenRef = useRef(-1);
  useEffect(() => {
    const prev = prevConfirmsLenRef.current;
    prevConfirmsLenRef.current = confirms.length;
    if (prev === -1) return; // 首轮 hydrate：已有确认不弹
    if (prev === 0 && confirms.length > 0 && activeWorkspaceId) {
      void setChatWorkspaceIdAndLoad(activeWorkspaceId);
    }
  }, [confirms.length, activeWorkspaceId, setChatWorkspaceIdAndLoad]);
  return null;
}

/**
 * 调度对话面板在场标志上报（空渲染）：chat store 消费留在子组件，App 只在
 * 面板开/关边沿重渲，不随通知/气泡等 slice 更新走。
 */
function AgentPanelFlag({ onOpenChange }: { onOpenChange: (open: boolean) => void }): null {
  const { chatWorkspaceId } = useChatStore();
  useEffect(() => {
    onOpenChange(chatWorkspaceId != null);
  }, [chatWorkspaceId, onOpenChange]);
  return null;
}

export function App({ onWorkspaceClosePendingChange, setup }: {
  onWorkspaceClosePendingChange?: (pending: boolean) => void;
  setup?: DesktopSetup;
} = {}): React.JSX.Element {
  const {
    confirms,
    dialogs,
    respondDialog,
    sideDockRequest,
    clearSideDockRequest,
    flashTip,
    commandPalette,
    openCommandPalette,
    closeCommandPalette,
    requestOpenWorkspaceFile
  } = useUiStore();
  const { workspaces, activeWorkspaceId, switching, switchWorkspace } = useWorkspaceStore();
  useEffect(() => window.api.on('app:second-instance', ({ commandLine, workingDirectory }) => {
    for (const argument of commandLine.slice(1)) {
      if (argument.startsWith('-')) continue;
      const absolute = /^(?:[a-zA-Z]:[\\/]|[\\]{2}|\/)/.test(argument);
      const path = absolute || !workingDirectory
        ? argument
        : `${workingDirectory.replace(/[\\/]+$/, '')}/${argument}`;
      requestOpenWorkspaceFile({ path, source: 'keep' });
    }
  }), [requestOpenWorkspaceFile]);
  const closeWorkspaceList = useRef(workspaces); closeWorkspaceList.current = workspaces;
  // palette 首开预热（2026-10-14 性能专项）：boot 后/切工作区后的空闲档，后台
  // 枚举当前工作区文件清单垫进模块缓存——首次 Ctrl+P 直接出结果（stale-while-
  // revalidate 后台照常刷新）。枚举在主进程侧跑，不占渲染层。
  useEffect(() => {
    const ws = workspaces.find(w => w.id === activeWorkspaceId);
    if (!ws) return;
    const wid = ws.id;
    const rev = ws.rootsRevision ?? 0;
    const schedule =
      window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 2500));
    const cancel = window.cancelIdleCallback
      ? (handle: number) => window.cancelIdleCallback(handle)
      : (handle: number) => window.clearTimeout(handle);
    const handle = schedule(() => prewarmQuickOpenFiles(wid, rev), { timeout: 12000 });
    return () => cancel(handle);
  }, [workspaces, activeWorkspaceId]);
  const { cfg, ready: wsFileReady, workspaceId: wsFileWorkspaceId, patch: patchWsFile } = useWorkspaceFile();
  const { t } = useTranslation();
  const [splitPrefsError, setSplitPrefsError] = useState<{ workspaceId: string | null; message: string } | null>(null);
  useEffect(() => { setSplitPrefsError(null); }, [activeWorkspaceId]);
  const saveSplitPrefs = useCenterSplitPrefs(activeWorkspaceId,
    wsFileReady && wsFileWorkspaceId === activeWorkspaceId, patchWsFile,
    error => {
      const message = error instanceof Error ? error.message : String(error);
      setSplitPrefsError({ workspaceId: activeWorkspaceId, message: message === t('分屏偏好保存失败') ? message : t('分屏偏好保存失败：{{error}}', { error: message }) });
    });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupSettings, setSetupSettings] = useState<'model' | 'theme' | null>(null);
  const [appShell, setAppShell] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const pending = new Map<string, { workspaceId: string; cancelled: boolean; sent: boolean; transaction?: WorkspaceFileCloseTransaction; hadInert: boolean }>();
    const unlock = (id: string): void => {
      const state = pending.get(id); if (!state) return;
      pending.delete(id);
      if (appShell && !state.hadInert) appShell.removeAttribute('inert');
      if (!pending.size) onWorkspaceClosePendingChange?.(false);
    };
    const stopPrepare = window.api.on('workspace:close-prepare-request', request => {
      if (!appShell || pending.size) { window.api.workspaces.replyClosePrepare(request.requestId, { ok: false, error: 'Workspace close surface is unavailable or busy' }); return; }
      const state = { workspaceId: request.workspaceId, cancelled: false, sent: false, transaction: undefined as WorkspaceFileCloseTransaction | undefined, hadInert: appShell.hasAttribute('inert') };
      pending.set(request.requestId, state); appShell.setAttribute('inert', '');
      onWorkspaceClosePendingChange?.(true);
      flashTip(t('正在保存文件并关闭工作区…'));
      void prepareWorkspaceFileClose(request.workspaceId).then(transaction => {
        state.transaction = transaction;
        if (state.cancelled) { try { transaction.rollback(); } finally { unlock(request.requestId); } return; }
        state.sent = true;
        window.api.workspaces.replyClosePrepare(request.requestId, { ok: true });
      }).catch(error => {
        if (!state.cancelled) window.api.workspaces.replyClosePrepare(request.requestId, { ok: false, error: String(error) });
        else console.error('[workspace close] cancelled preparation failed', error);
        unlock(request.requestId);
      });
    });
    const stopClosed = window.api.on('workspace:close-prepare-closed', ({ requestId }) => {
      const state = pending.get(requestId);
      if (state && !state.sent) { state.cancelled = true; unlock(requestId); }
    });
    const stopFinish = window.api.on('workspace:close-finish-request', request => { void (async () => {
      const state = pending.get(request.preparationId);
      let finalized = false;
      try {
        if (!state?.transaction || !state.sent || state.workspaceId !== request.workspaceId) throw new Error('Workspace close preparation is unavailable');
        if (request.committed) {
          await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 5000;
            const check = (): void => {
              if (pending.get(request.preparationId) !== state || state.cancelled) { reject(new Error('Workspace close preparation was cancelled')); return; }
              if (!closeWorkspaceList.current.some(workspace => workspace.id === request.workspaceId)) { resolve(); return; }
              if (Date.now() >= deadline) { reject(new Error('Closed workspace state was not observed')); return; }
              setTimeout(check, 25);
            };
            check();
          });
          finalized = true;
          state.transaction.commit();
          flushSync(() => setBackgroundCenterViews(items => items.filter(item => item.workspaceId !== request.workspaceId || !item.file)));
        } else { finalized = true; state.transaction.rollback(); }
        window.api.workspaces.replyCloseFinish(request.requestId, { ok: true });
      } catch (error) {
        let message = String(error);
        if (!finalized && state?.transaction && !state.cancelled) {
          try { state.transaction.rollback(); } catch (rollbackError) { message += `; rollback failed: ${String(rollbackError)}`; }
        }
        window.api.workspaces.replyCloseFinish(request.requestId, { ok: false, error: message });
      }
      finally { unlock(request.preparationId); }
    })(); });
    const stopAbort = window.api.on('workspace:close-abort', ({ preparationId }) => {
      const state = pending.get(preparationId);
      if (!state) return;
      state.cancelled = true;
      if (!state.transaction) { unlock(preparationId); return; }
      try { state.transaction.rollback(); } catch (error) { console.error('[workspace close] rollback failed', error); }
      finally { unlock(preparationId); }
    });
    return () => {
      stopPrepare(); stopClosed(); stopFinish(); stopAbort();
      for (const [id, state] of pending) {
        state.cancelled = true;
        try { state.transaction?.rollback(); } catch (error) { console.error('[workspace close] rollback failed', error); }
        unlock(id);
      }
    };
  }, [appShell, flashTip, onWorkspaceClosePendingChange]);
  const [settingsPrepared, setSettingsPrepared] = useState(false);
  const [settingsBackgroundWorkspace, setSettingsBackgroundWorkspace] = useState<string | null>(null);
  const [backgroundCenterViews, setBackgroundCenterViews] = useState<BackgroundCenterView[]>([]);
  const centerFilesVersion = useSyncExternalStore(subscribeAgentCenterFiles, agentCenterFilesVersion);
  const backgroundCenterViewsRef = useRef(backgroundCenterViews);
  backgroundCenterViewsRef.current = backgroundCenterViews;
  const [settingsHost, setSettingsHost] = useState<HTMLDivElement | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsPending, setSettingsPending] = useState<Array<{ requestId: string; workspaceId: string; rootsRevision: number; focus: boolean; existing: boolean; tabId?: string }>>([]);
  const [settingsClosePending, setSettingsClosePending] = useState<{ requestId: string; workspaceId: string; rootsRevision: number } | null>(null);
  const settingsClosingRef = useRef(false);
  const settingsOpeningRef = useRef(new Set<string>());
  const observedCenterSplit = useCenterSplit();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [settingsFocus, setSettingsFocus] = useState<string | undefined>();
  // 弹窗 presence：开关驱动进出场（可打断），退场期间保留最后内容
  const settingsPresence = usePresence(settingsOpen);
  const settingsDock = useRightDock();
  const settingsDocked = settingsDock.docked.has('utility:settings');
  const settingsRightShown = settingsDock.shown.has('utility:settings');
  // Restored right tabs must prepare the same settings instance before use.
  useEffect(() => { if (settingsDocked) setSettingsPrepared(true); }, [settingsDocked]);
  // 挂载期间锁定所用组件：chunk 在打开途中才到位时不得换组件类型（会整树重挂丢草稿）
  const settingsImplRef = useRef<SettingsModalComponent>(SettingsModalLazy);
  if (!settingsPresence.mounted && !settingsPrepared) {
    settingsImplRef.current = settingsModalMod?.SettingsModal ?? SettingsModalLazy;
  }
  const SettingsModal = settingsImplRef.current;
  const palettePresence = usePresence(!!commandPalette);
  const lastPaletteRef = useRef(commandPalette);
  if (commandPalette) lastPaletteRef.current = commandPalette;
  const shownPalette = commandPalette ?? (palettePresence.mounted ? lastPaletteRef.current : null);
  const openSettings = useCallback((tab?: SettingsTab, focusId?: string): void => {
    // 旧页签 id（如 integrations）在此归一为现役页签，外部 deep link 不断链
    if (tab) setSettingsTab(normalizeSettingsTab(tab));
    setSettingsFocus(focusId);
    setSettingsOpen(true);
  }, []);
  const openSetupSettings = (kind: 'model' | 'theme'): void => {
    setSetupSettings(kind);
    if (kind === 'model') openSettings('agent', setup?.modelSettingsItem ?? 'agent-provider');
    else openSettings('appearance');
  };
  const checkSetupModel = useRef(setup?.onModelReturn);
  checkSetupModel.current = setup?.onModelReturn;
  useEffect(() => {
    if (!setupSettings || settingsOpen || settingsPresence.mounted) return;
    if (setupSettings === 'theme') { setSetupSettings(null); return; }
    let cancelled = false;
    void Promise.resolve(checkSetupModel.current?.()).finally(() => {
      if (!cancelled) setSetupSettings(null);
    });
    return () => { cancelled = true; };
  }, [setupSettings, settingsOpen, settingsPresence.mounted]);
  const closeUtilityPanel = useCallback((): void => setUtilityPanel(null), []);
  const toggleGlobalBoard = useCallback((): void => {
    setProcessMonitorOpen(false);
    setGlobalBoardOpen((v) => !v);
  }, []);
  const toggleProcessMonitor = useCallback((): void => {
    setGlobalBoardOpen(false);
    setProcessMonitorOpen((v) => !v);
  }, []);
  const toggleLeftDrawer = useCallback((): void => setLeftDrawerOpen((v) => !v), []);
  const closeLeftDrawer = useCallback((): void => setLeftDrawerOpen(false), []);
  const toggleRightDrawer = useCallback((): void => setRightDrawerOpen((v) => !v), []);
  const [hVs, setHVs] = useState(false);
  const [hDock, setHDockState] = useState<HDock>('terminal');
  const hDockIntent = useRef<HDock>('terminal');
  const setHDock = useCallback((dock: HDock) => { hDockIntent.current = dock; setHDockState(dock); }, []);
  const saveWorkspacePage = useCallback((dock: HDock) => {
    if (!activeWorkspaceId || wsFileWorkspaceId !== activeWorkspaceId) return;
    if (!saveVirtualScreenPage(activeWorkspaceId, dock)) {
      flashTip(t('切屏位置无法保存，请检查本地存储空间或浏览器设置'));
    }
  }, [activeWorkspaceId, wsFileWorkspaceId, flashTip, t]);
  const [historyReadyWorkspace, setHistoryReadyWorkspace] = useState<string | null>(null);
  /** 专注模式：藏左栏会话列，会话与 Git 页并肩恒满全宽（虚拟屏临时退出） */
  const [focusMode, setFocusMode] = useState(false);
  const [focusRatio, setFocusRatio] = useState(FOCUS_RATIO_DEFAULT);
  /** 进入专注前的布局快照（内存级，不落盘）：退出专注原样恢复；跨工作区切换即失效
   *  （各工作区布局以各自 workspace.json 为准，专注期间从不改写它们） */
  const focusRestoreRef = useRef<{
    hVs: boolean;
    hDock: HDock;
    termRatio: number;
    gitRatio: number;
  } | null>(null);
  /** 窄屏（手机/窄分屏，≤820px）：左右栏改悬浮抽屉（responsive.css），默认收起 */
  const [narrow, setNarrow] = useState(
    () => window.matchMedia('(max-width: 820px)').matches
  );
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  /** 会话栏显隐（全局偏好 localStorage）：展开=文档流占位；折叠=不占布局，
   *  可经右上角开关或左缘热区速览唤回。与专注模式完全解耦 */
  const [sessionsOpen, setSessionsOpen] = useState(() => loadSessionsOpen());
  const activeSetup = setup?.paused ? undefined : setup;
  const setupStep = activeSetup?.step;
  const focusAfterSetup = useRef(false);
  /** 工作区栈槽位（LeftPanel 底部）：AgentFloat 的胶囊栈 portal 挂进来，
   *  栈随侧边栏同生共死（速览悬停胶囊=悬停面板、显隐不再靠绑定类豁免）。
   *  展开列与速览浮层二选一挂载，槽位元素切换即 portal 容器切换 */
  const [wsSlotEl, setWsSlotEl] = useState<HTMLDivElement | null>(null);
  /** 折叠态下经左缘热区速览唤出（瞬态，不落盘） */
  const [sessionsPeekOpen, setSessionsPeekOpen] = useState(false);
  /** 调度对话面板在场（边沿上报，见 AgentPanelFlag）：面板开着时速览侧边栏不自动
   *  收回——收回去会把面板连带藏掉（sessions-hidden display:none），中断使用 */
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [schedulerOverviewOpen, setSchedulerOverviewOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)');
    const onChange = (): void => {
      setNarrow(mq.matches);
      if (!mq.matches) {
        setLeftDrawerOpen(false);
        setRightDrawerOpen(false);
      }
    };
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // is-narrow 挂 html 根：布局抽屉（responsive.css）与顶栏唤出按钮共用同一开关
  useEffect(() => {
    document.documentElement.classList.toggle('is-narrow', narrow);
    return () => document.documentElement.classList.remove('is-narrow');
  }, [narrow]);
  /** 会话栏以文档流形态生效：展开 + 宽屏（窄屏布局归抽屉管，列常挂载为抽屉）。
   *  与专注解耦——专注不改会话栏显隐 */
  const sessionsInFlow = sessionsOpen && !narrow;
  /** 折叠态（宽屏）：会话栏不占布局，左缘热区可速览唤回 */
  const sessionsHidden = !sessionsOpen && !narrow;
  /** Git 页（侧工具区）首用标记：首次成为激活态（Git 主态，或虚拟屏打开使 Git 页
   *  可见）后恒真；SideToolsPanel 内 Files/Git 内容此前不挂载，首次用到才加载并保活 */
  const [gitEverActive, setGitEverActive] = useState(false);
  const [utilityPanel, setUtilityPanelState] = useState<UtilitySelection | null>(null);
  /** 全局看板（顶栏滑出遮幕）：顶栏按钮 / 鼠标中键 toggle / 快捷键 / 探出条点击 */
  const [globalBoardOpen, setGlobalBoardOpen] = useState(false);
  const [processMonitorOpen, setProcessMonitorOpen] = useState(false);
  const [viewW, setViewW] = useState(1200);
  const [viewH, setViewH] = useState(800);
  const [hSplitHot, setHSplitHot] = useState(false);
  const [hBtnAlong, setHBtnAlong] = useState(0.5);
  const [hSwitchMode, setHSwitchMode] = useState<HSwitchMode>(() => loadHSwitchMode());
  /** 横向虚拟屏两主态页占比（长按按钮左右拖跟手调节，各落 workspace.json） */
  const [termRatio, setTermRatio] = useState(TERM_RATIO_DEFAULT);
  const [gitRatio, setGitRatio] = useState(GIT_RATIO_DEFAULT);
  /** 左栏宽度全局共享；旧工作区宽度仅在首次水合时迁移一次。 */
  const { width: leftColW, setWidth: setLeftColW, commit: commitLeftColW } = useGlobalSidebarWidth(
    cfg.leftColumnWidth, wsFileReady && wsFileWorkspaceId === activeWorkspaceId
  );
  const [leftResizing, setLeftResizing] = useState(false);
  /** 工作区切换胶片：先滑到固定骨架，再切区，再淡出骨架露出实况（编排见 workspaceTransit.ts） */
  const [wsTransit, setWsTransit] = useState<WsTransit | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const workAreaRef = useRef<HTMLDivElement>(null);
  const keySinkRef = useRef<HTMLDivElement>(null);
  const hTimerRef = useRef<number | null>(null);
  const hCoolUntilRef = useRef(0);
  const onExpandBtnRef = useRef(false);
  const resizeBaseRef = useRef({
    term: TERM_RATIO_DEFAULT,
    git: GIT_RATIO_DEFAULT,
    focus: FOCUS_RATIO_DEFAULT
  });
  const resizeDraftRef = useRef<Partial<typeof resizeBaseRef.current>>({});

  const clearHTimer = useCallback(() => {
    if (hTimerRef.current != null) {
      window.clearTimeout(hTimerRef.current);
      hTimerRef.current = null;
    }
  }, []);

  /** 程序化切页后短暂抑制「点击/悬停切页」：输入框药丸/文件链接的跳转发生在
   *  mousedown/click 里，切页后紧跟的 mouseup-click 会落在露出的另一页上，
   *  点击模式会把这次 click 误读成「用户点了这页要切回去」——跳转后立即弹回。
   *  700ms > 滑动动画 420ms，只吞跳转瞬间的那次误读，不影响正常点击/悬停切页。 */
  const suppressPageClickUntilRef = useRef(0);
  const suppressPageClicks = useCallback((): void => {
    suppressPageClickUntilRef.current = Date.now() + 700;
  }, []);

  useEffect(
    () => () => {
      clearHTimer();
    },
    [clearHTimer]
  );

  useEffect(() => {
    if (!wsFileReady) return;
    // 专注期间虚拟屏强制视觉退出：cfg 里 hVirtualScreen 原值保留给退出恢复用
    setHVs(cfg.focusMode ? false : !!cfg.hVirtualScreen);
  }, [wsFileReady, cfg.hVirtualScreen, cfg.focusMode]);

  // 虚拟屏当前页：按工作区 hydrate。VS 关 / 专注时视觉钳到 terminal（盘上值仍保留）
  useEffect(() => {
    if (!wsFileReady || wsFileWorkspaceId !== activeWorkspaceId) return;
    setHDock(
      visualHDock({
        stored: loadVirtualScreenPage(wsFileWorkspaceId, cfg.hDock),
        hVirtualScreen: !!cfg.hVirtualScreen,
        focusMode: !!cfg.focusMode
      })
    );
    setHistoryReadyWorkspace(wsFileWorkspaceId);
  }, [wsFileReady, wsFileWorkspaceId, activeWorkspaceId, cfg.hDock, cfg.hVirtualScreen, cfg.focusMode]);

  useEffect(() => {
    if (!wsFileReady) return;
    setFocusMode(!!cfg.focusMode);
    if (cfg.focusRatio != null) {
      setFocusRatio(clamp(cfg.focusRatio, FOCUS_RATIO_MIN, FOCUS_RATIO_MAX));
    }
  }, [wsFileReady, cfg.focusMode, cfg.focusRatio]);

  // Git 页首用置位（恒真，不回落）：驱动 SideToolsPanel 懒挂载 Files/Git 内容
  useEffect(() => {
    if (hDock === 'git' || hVs || focusMode || rightDrawerOpen) setGitEverActive(true);
  }, [hDock, hVs, focusMode, rightDrawerOpen]);

  // 换工作区即弃专注快照：退出时无处可恢复，布局直接跟随新工作区的 workspace.json
  useEffect(() => {
    focusRestoreRef.current = null;
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!wsFileReady) return;
    if (cfg.hTerminalRatio != null) {
      setTermRatio(clamp(cfg.hTerminalRatio, TERM_RATIO_MIN, TERM_RATIO_MAX));
    }
    if (cfg.hGitRatio != null) {
      setGitRatio(clamp(cfg.hGitRatio, GIT_RATIO_MIN, GIT_RATIO_MAX));
    }
  }, [wsFileReady, cfg.hTerminalRatio, cfg.hGitRatio]);

  // 通知不再自动弹出调度 Agent 面板：需要用户感知的提醒由通知气泡/全局看板探出承担，
  // 面板只在用户主动交互（或确有 confirm 对话框要答）时展开
  // （确认边沿自动开面板的逻辑下沉到 ChatAutoOpener，App 不消费 chat store）。

  const armHSwitch = useCallback(
    (alreadyThere: boolean, apply: () => void) => {
      clearHTimer();
      if (!hVs || hSwitchMode !== 'hover' || alreadyThere || onExpandBtnRef.current) return;
      // 程序化切页后的短暂静默期：指针若停在露条上，不当作悬停切页意图
      if (Date.now() < suppressPageClickUntilRef.current) return;
      if (Date.now() < hCoolUntilRef.current) return;
      hTimerRef.current = window.setTimeout(() => {
        hTimerRef.current = null;
        if (onExpandBtnRef.current) return;
        apply();
        hCoolUntilRef.current = Date.now() + HOVER_COOLDOWN_MS;
      }, HOVER_SWITCH_MS);
    },
    [hVs, hSwitchMode, clearHTimer]
  );

  /** 点击切页：**两种模式都生效**（悬停模式只是多一条「驻留即自动切」的通道，
   *  点击始终是显式切页意图，立即平移）。
   *  否则程序化切页后会出现死结：点会话里的文件链接 → 自动 pan 到 Git 页（文件
   *  区域），此时指针常仍停在露条上——露条里还是同一个工作页元素，浏览器不会重发
   *  `pointerenter`，悬停计时器永不武装，用户只能把鼠标移出露条再移回才能切回会话
   *  区（2026-09-11 用户实测）。
   *  程序化切页那一下的跟随 click 仍由 suppressPageClickUntilRef 吞掉（见上）。 */
  const clickHSwitch = useCallback(
    (alreadyThere: boolean, apply: () => void) => {
      if (!hVs || alreadyThere) return;
      apply();
    },
    [hVs]
  );

  const applySwitchMode = useCallback((mode: HSwitchMode) => {
    setHSwitchMode(mode);
    saveHSwitchMode(mode);
    clearHTimer();
  }, [clearHTimer]);

  /** 长按按钮左右拖：边界跟手（指针 X = 边界 X），只调当前主态一侧；
   * 拖动期间挂 is-reshaping 禁用条带平移过渡，否则每次移动都重启 0.42s
   * 动画，边界永远慢半拍 */
  const [hResizing, setHResizing] = useState(false);
  /** 长按拖动的当前主导轴：size 时被调侧盖调整前快照与指示卡 */
  const [hResizeAxis, setHResizeAxis] = useState<'size' | 'mode' | 'none'>('none');
  const onResizeStart = useCallback(() => {
    setHResizing(true);
    resizeBaseRef.current = { term: termRatio, git: gitRatio, focus: focusRatio };
    resizeDraftRef.current = {};
    // 无快照遮罩（2026-10-10 用户定稿，普通 VS 与双栏全屏两态一致）：拖动中
    // 活内容直接实时重排，只浮百分比指示卡
  }, [termRatio, gitRatio, focusRatio]);
  const onResizeMove = useCallback(
    (pointerX: number) => {
      const draft = resizeDraftRef.current;
      if (focusMode) {
        draft.focus = clamp(pointerX / viewW, FOCUS_RATIO_MIN, FOCUS_RATIO_MAX);
        setFocusRatio(draft.focus);
      } else if (hDock === 'git') {
        draft.git = clamp((viewW - pointerX) / viewW, GIT_RATIO_MIN, GIT_RATIO_MAX);
        setGitRatio(draft.git);
      } else {
        draft.term = clamp(pointerX / viewW, TERM_RATIO_MIN, TERM_RATIO_MAX);
        setTermRatio(draft.term);
      }
    },
    [hDock, viewW, focusMode]
  );
  const onResizeEnd = useCallback(
    (canceled: boolean) => {
      setHResizing(false);
      setHResizeAxis('none');
      const base = resizeBaseRef.current;
      if (canceled) {
        setTermRatio(base.term);
        setGitRatio(base.git);
        setFocusRatio(base.focus);
        return;
      }
      // 最后一次移动可能与松手落在同一帧，从草稿保存尚未渲染的比例。
      const { focus = base.focus, git = base.git, term = base.term } = resizeDraftRef.current;
      if (focusMode) {
        if (Math.abs(focus - base.focus) > 0.002) void patchWsFile({ focusRatio: focus });
        else setFocusRatio(base.focus);
        return;
      }
      if (hDock === 'git') {
        if (Math.abs(git - base.git) > 0.002) void patchWsFile({ hGitRatio: git });
        else setGitRatio(base.git);
      } else {
        if (Math.abs(term - base.term) > 0.002) void patchWsFile({ hTerminalRatio: term });
        else setTermRatio(base.term);
      }
    },
    [hDock, focusMode, patchWsFile]
  );

  // 调节占比拖动（size 轴）：指示卡+调整前快照盖在被调侧——git 主态时网页区被盖，
  // 截图让位（拖完恢复活网页）；terminal 主态时被调的是终端侧，网页露条无需让位；


  const enableHVs = useCallback((landOn: HDock = 'terminal') => {
    clearHTimer();
    onExpandBtnRef.current = false;
    pulseHStripBusy(450);
    setHVs(true);
    setHDock(landOn);
    saveWorkspacePage(landOn);
    void patchWsFile({ hVirtualScreen: true });
    setHSplitHot(false);
  }, [clearHTimer, pulseHStripBusy, saveWorkspacePage, patchWsFile]);

  const disableHVs = useCallback(() => {
    clearHTimer();
    onExpandBtnRef.current = false;
    pulseHStripBusy(450);
    setHVs(false);
    saveWorkspacePage('terminal');
    void patchWsFile({ hVirtualScreen: false });
    setHDock('terminal');
    setHSplitHot(false);
  }, [clearHTimer, pulseHStripBusy, saveWorkspacePage, patchWsFile]);

  /** 进入专注：布局快照只存内存（专注期间从不改写 hVirtualScreen/占比），
   *  退出专注原样恢复；专注自身状态落 workspace.json（重启保持）。入口：把手
   *  长按菜单「关闭虚拟屏」落点（2026-10-10 由「专注」仅改名、行为不变）+
   *  右栏开关的「恢复专注」 */
  const enterFocus = useCallback(() => {
    focusRestoreRef.current = { hVs, hDock, termRatio, gitRatio };
    pulseHStripBusy(450);
    clearHTimer();
    onExpandBtnRef.current = false;
    setFocusMode(true);
    // 与侧边栏显隐解耦：不动 sessionsOpen/速览态——专注中会话栏照常可开合
    // 仅视觉退出虚拟屏，不写 hVirtualScreen——快照负责恢复
    setHVs(false);
    setHDock('terminal');
    setHSplitHot(false);
    void patchWsFile({ focusMode: true });
  }, [hVs, hDock, termRatio, gitRatio, clearHTimer, pulseHStripBusy, patchWsFile]);

  const exitFocus = useCallback(() => {
    pulseHStripBusy(450);
    clearHTimer();
    onExpandBtnRef.current = false;
    setFocusMode(false);
    const snap = focusRestoreRef.current;
    focusRestoreRef.current = null;
    if (!snap) {
      void patchWsFile({ focusMode: false });
      return;
    }
    setHVs(snap.hVs);
    setHDock(snap.hDock);
    saveWorkspacePage(snap.hDock);
    setTermRatio(snap.termRatio);
    setGitRatio(snap.gitRatio);
    // focusMode 与恢复布局必须单条补丁原子落盘：拆两条会有「focusMode 已 false 而
    // hVirtualScreen 还是盘上进入前旧值」的中间 cfg，回流被 hVs 同步 effect 按旧值
    // 复活虚拟屏（右栏开关收起时曾据此闪回悬浮/点击模式）
    void patchWsFile({
      focusMode: false,
      hVirtualScreen: snap.hVs,
      hTerminalRatio: snap.termRatio,
      hGitRatio: snap.gitRatio,
    });
  }, [pulseHStripBusy, clearHTimer, saveWorkspacePage, patchWsFile]);

  /** 右上角开关「收起」专用（专注布局下）：一步退专注+关 VS，单条补丁原子落盘。
   *  不能走 exitFocus（会把快照里的 hVirtualScreen 原值写回——收起语义是右栏连同
   *  Git 页一起消失、落回普通全宽）；也不能 exitFocus+disableHVs 叠两条补丁
   *  （focusMode 先 false 而 hVirtualScreen 还是盘上旧值的中间 cfg，会被 hVs 同步
   *  effect 复活成虚拟屏）。占比照快照恢复，hVirtualScreen 强制 false */
  const collapseRightPanel = useCallback(() => {
    pulseHStripBusy(450);
    clearHTimer();
    onExpandBtnRef.current = false;
    setFocusMode(false);
    setHVs(false);
    setHDock('terminal');
    saveWorkspacePage('terminal');
    setHSplitHot(false);
    const snap = focusRestoreRef.current;
    focusRestoreRef.current = null;
    if (snap) {
      setTermRatio(snap.termRatio);
      setGitRatio(snap.gitRatio);
    }
    void patchWsFile({
      focusMode: false,
      hVirtualScreen: false,
      ...(snap
        ? {
            hTerminalRatio: snap.termRatio,
            hGitRatio: snap.gitRatio,
          }
        : {})
    });
  }, [pulseHStripBusy, clearHTimer, saveWorkspacePage, patchWsFile]);

  /** 把手长按菜单选切页：专注下拖到悬浮/点击 = 一步「退出专注（恢复进专注前快照）
   *  + 应用切屏方式」——专注与悬浮/点击是互斥模式，切换即退出，不必先退再切 */
  const applySwitchModeFromMenu = useCallback(
    (mode: HSwitchMode) => {
      applySwitchMode(mode);
      if (focusMode) exitFocus();
    },
    [applySwitchMode, exitFocus, focusMode]
  );

  /** 把手长按菜单「关闭虚拟屏」落点（原「专注」，仅改名）：切换双栏全屏态
   *  （focusMode）；已在该态时空操作 */
  const toggleFocus = useCallback((): void => {
    if (focusMode) exitFocus();
    else enterFocus();
  }, [focusMode, exitFocus, enterFocus]);

  // ---- 会话栏折叠/展开：折叠态左缘热区划开工作面，露出下方左栏 ----
  const peekCloseTimerRef = useRef<number | null>(null);
  const clearPeekCloseTimer = useCallback((): void => {
    if (peekCloseTimerRef.current != null) {
      window.clearTimeout(peekCloseTimerRef.current);
      peekCloseTimerRef.current = null;
    }
  }, []);
  const armPeekClose = useCallback((): void => {
    clearPeekCloseTimer();
    // 调度对话面板在场时不自动收回：收回去会把面板连带藏掉（sessions-hidden
    // display:none）中断使用；面板关闭后恢复正常收回时机
    if (agentPanelOpen || schedulerOverviewOpen) return;
    peekCloseTimerRef.current = window.setTimeout(() => {
      peekCloseTimerRef.current = null;
      setSessionsPeekOpen(false);
    }, SESSIONS_FLOAT_HIDE_MS);
  }, [agentPanelOpen, clearPeekCloseTimer, schedulerOverviewOpen]);
  useEffect(() => clearPeekCloseTimer, [clearPeekCloseTimer]);
  const openSessionsPeek = useCallback((): void => {
    clearPeekCloseTimer();
    setSessionsPeekOpen(true);
  }, [clearPeekCloseTimer]);
  const closeSessionsPeek = useCallback((): void => {
    clearPeekCloseTimer();
    setSessionsPeekOpen(false);
  }, [clearPeekCloseTimer]);
  /** 右上角开关：展开⇄折叠（偏好全局落 localStorage） */
  const toggleSessions = useCallback((): void => {
    setSessionsOpen((v) => {
      const next = !v;
      saveSessionsOpen(next);
      return next;
    });
  }, []);
  // 折叠失效（展开 / 切窄屏）即收起速览态
  useEffect(() => {
    if (!sessionsHidden) setSessionsPeekOpen(false);
  }, [sessionsHidden]);
  useEffect(() => {
    if (wsTransit) setSessionsPeekOpen(false);
  }, [wsTransit]);
  // 速览面板 keep-alive 必须用原生指针进出：React 合成 enter/leave 按 fiber 树
  // 计算路径，工作区栈 portal 进面板后 fiber 上是 AgentFloat 子树——悬停栈会被
  // 合成事件误判成「离开面板」照常收回；原生事件按 DOM 树判定，栈就是面板子树
  const sessionsFloatRef = useRef<HTMLDivElement | null>(null);
  useSessionsPeekHover(sessionsFloatRef, sessionsHidden, clearPeekCloseTimer, armPeekClose);
  // 输入框编辑中让位给局部取消；其余 Escape 先于冒泡阶段的全局快捷键层收回速览。
  useSessionsPeekEscape(sessionsPeekOpen, closeSessionsPeek);

  const persistHDock = useCallback(
    (dock: HDock) => {
      // 专注期间保留进入专注前的页位。
      if (!focusMode) saveWorkspacePage(dock);
    },
    [focusMode, saveWorkspacePage]
  );
  const showTerminal = useCallback(() => {
    pulseHStripBusy(450);
    setHDock('terminal');
    persistHDock('terminal');
  }, [pulseHStripBusy, persistHDock]);
  const showGit = useCallback(() => {
    pulseHStripBusy(450);
    setHDock('git');
    persistHDock('git');
  }, [pulseHStripBusy, persistHDock]);

  /** 点选模式下侧栏常在 Git peek 里点：先拉回工作页，否则面板开在看不见的中栏 */
  const ensureWorkspaceVisible = useCallback(() => {
    if (hVs && (hDock !== 'terminal' || hDockIntent.current !== 'terminal')) showTerminal();
  }, [hVs, hDock, showTerminal]);

  /** 鼠标中键：任意位置开关全局看板；preventDefault 顺带禁掉中键自动滚动。
   *  iframe（扩展面板/HTML 预览）内容区的中键进不了宿主文档，由 guest 侧
   *  中继脚本（panelRelay.ts，协议层/srcDoc 注入）postMessage 回来补触发。 */
  useEffect(() => {
    const canToggleBoard = (): boolean => {
      const lock = getSetupInteractionLock();
      return !lock || lock.dataset.setupAllowBoard === 'true';
    };
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (canToggleBoard()) setGlobalBoardOpen((v) => !v);
    };
    const onRelay = (e: MessageEvent): void => {
      const d = e.data as { __ma?: boolean; type?: string } | null;
      if (!d || typeof d !== 'object' || d.__ma !== true || d.type !== 'middleClick') return;
      if (canToggleBoard()) setGlobalBoardOpen((v) => !v);
    };
    window.addEventListener('message', onRelay);
    const stopNativeRelay = window.api.on('workbench:middleClick', () => {
      if (canToggleBoard()) setGlobalBoardOpen(value => !value);
    });
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('message', onRelay);
      stopNativeRelay();
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  /** 主进程 sessions.select：与左栏点选对齐，露出终端。
   *  已读由 StoreProvider 的 subscribeRevealNeedsRead 兜底（不跟本 effect 绑在一起，
   *  避免切区重渲拆掉监听）；这里只做切页/收板。 */
  const splitSelection = useCenterSplitSelection<UtilitySelection>({
    workspaceId: activeWorkspaceId,
    setUtilityPanel: setUtilityPanelState,
    ensureWorkspaceVisible,
    revealSession: () => {
      setGlobalBoardOpen(false);
      suppressPageClicks();
      showTerminal();
    },
    reportError: error => flashTip(error instanceof Error ? error.message : String(error))
  });
  const { setUtilityPanel } = splitSelection;

  /** 主进程 terminal.capture：离屏强制重绘后取画布 PNG */
  useEffect(() => {
    let chain = Promise.resolve();
    return window.api.on('terminal:capture-request', (p) => {
      chain = chain.then(() => handleTerminalCaptureRequest(p));
    });
  }, []);

  const selectUtilityPanel = useCallback(
    (id: UtilitySelection) => {
      // 分屏焦点在第二 pane 时：工具/导航选择填充分屏位，不开主工具层
      if (centerSplitTryFill({ kind: 'utility', sel: id })) return;
      ensureWorkspaceVisible();
      setUtilityPanel(id);
    },
    [ensureWorkspaceVisible]
  );
  useEffect(() => onCenterUtilityRequest(sel => {
    clearSideDockRequest();
    showTerminal();
    selectUtilityPanel(sel as UtilitySelection);
  }), [clearSideDockRequest, showTerminal, selectUtilityPanel]);

  // ---- 中央区分屏桥（pane0=当前选中；选中应用回 App；比例/方向按工作区记忆） ----
  const sessionStore = useSessionStore();
  const navigation = useWorkbenchNavigation(activeWorkspaceId ?? '');
  const [trialTarget, setTrialTarget] = useState<string | null>(null);
  const openedTrial = useRef(false);
  useEffect(() => {
    if (!isWebGateway()) void window.api.extensionPublishing?.previewTarget().then(setTrialTarget, () => {});
  }, []);
  useEffect(() => {
    if (!trialTarget || openedTrial.current) return;
    const node = navigation.nodes.find(item => item.kind === 'extension' && item.extensionId === trialTarget);
    if (!node) return;
    openedTrial.current = true;
    selectUtilityPanel(`nav:${node.id}`);
  }, [navigation.nodes, selectUtilityPanel, trialTarget]);
  const centerFileIds = backgroundCenterViews.flatMap(item => item.workspaceId === activeWorkspaceId && item.file &&
    backgroundViewAvailable(item, sessionStore.sessions, navigation) ? [item.file.tabId] : []);
  const splitDepsRef = useRef({
    activeWorkspaceId,
    utilityPanel,
    displayActiveId: sessionStore.displayActiveId,
    sessions: sessionStore.sessions,
    navigation: navigation.nodes,
    centerFileIds,
    navigationIdentity: navigation,
    ensureWorkspaceVisible,
    cfgCenterSplitDir: cfg.centerSplitDir,
    cfgCenterSplitRatio: cfg.centerSplitRatio,
    saveSplitPrefs,
    selectSplitRef: splitSelection.selectRef
  });
  splitDepsRef.current = {
    activeWorkspaceId,
    utilityPanel,
    displayActiveId: sessionStore.displayActiveId,
    sessions: sessionStore.sessions,
    navigation: navigation.nodes,
    centerFileIds,
    navigationIdentity: navigation,
    ensureWorkspaceVisible,
    cfgCenterSplitDir: cfg.centerSplitDir,
    cfgCenterSplitRatio: cfg.centerSplitRatio,
    saveSplitPrefs,
    selectSplitRef: splitSelection.selectRef
  };
  const panelRootsRevision = workspaces.find(workspace => workspace.id === activeWorkspaceId)?.rootsRevision ?? 0;
  const panelSnapshotRef = useRef({ hDock, hVs, focusMode, narrow, rightDrawerOpen, switching, wsTransit, panelRootsRevision, settingsPrepared, settingsVisible, settingsRightShown, settingsDocked, settingsDirty, settingsReady, settingsModal: settingsPresence.mounted });
  panelSnapshotRef.current = { hDock, hVs, focusMode, narrow, rightDrawerOpen, switching, wsTransit, panelRootsRevision, settingsPrepared, settingsVisible, settingsRightShown, settingsDocked, settingsDirty, settingsReady, settingsModal: settingsPresence.mounted };
  const revealRightPanel = usePanelRightReveal({ workspaceId: activeWorkspaceId, rootsRevision: panelRootsRevision, switching,
    transitioning: !!wsTransit, narrow, rightDrawerOpen, focusMode, settingsBlocked: settingsPresence.mounted || (settingsVisible || settingsDocked) && settingsDirty,
    virtualScreen: hVs, page: hDock, pendingPage: () => hDockIntent.current,
    prepare: () => { clearHTimer(); suppressPageClicks(); },
    openDrawer: () => { setLeftDrawerOpen(false); setRightDrawerOpen(true); if (!hVs && !focusMode) enableHVs('git'); else showGit(); },
    showGit, enableGit: () => enableHVs('git'),
    settle: () => settlePanelVisibility('.git-page') });
  const activeRightRequests = useRef(new Set<string>());
  const closedRightRequests = useRef(new Set<string>());
  const settingsControlRef = useRef({ settingsPrepared, settingsOpen, settingsDirty, settingsDocked, settingsModal: settingsPresence.mounted, selectUtilityPanel, closeUtilityPanel, showTerminal, ensureWorkspaceVisible });
  settingsControlRef.current = { settingsPrepared, settingsOpen, settingsDirty, settingsDocked, settingsModal: settingsPresence.mounted, selectUtilityPanel, closeUtilityPanel, showTerminal, ensureWorkspaceVisible };
  const focusBackgroundView = async (item: BackgroundCenterView, rootsRevision: number, requestId: string): Promise<void> => {
    const target = item.target;
    const current = (): boolean => {
      const view = panelSnapshotRef.current, deps = splitDepsRef.current;
      const dockKey = rightDockKey(target);
      const node = target.kind === 'utility' && target.sel.startsWith('nav:') ? deps.navigationIdentity.nodes.find(item => item.id === target.sel.slice(4)) : undefined;
      return !isWorkspaceFileClosePending(item.workspaceId) && !closedRightRequests.current.has(requestId) && deps.activeWorkspaceId === item.workspaceId &&
        view.panelRootsRevision === rootsRevision && !view.switching && !view.wsTransit &&
        !view.settingsModal && !(view.narrow && view.rightDrawerOpen) && !((view.settingsVisible || view.settingsDocked) && view.settingsDirty) &&
        (!dockKey || !rightDockSnapshot().docked.has(dockKey)) && (!item.file || !item.file.pinned) &&
        (!(target.kind === 'utility' && target.sel.startsWith('nav:')) || (!!node && node.placement !== 'tab' && node.placement !== 'window')) && backgroundViewAvailable(item, deps.sessions, deps.navigationIdentity) &&
        !readFileEditorStates(item.workspaceId).some(editor => editor.active && editor.unsaved) &&
        backgroundCenterViewsRef.current.some(entry => entry.id === item.id && entry.workspaceId === item.workspaceId && samePaneRef(entry.target, target));
    };
    if (!current()) throw new Error('Center background view is unavailable or blocked by unsaved changes');
    const result = await centerSplitSelectAgentRef(item.workspaceId, target, current);
    if (result !== 'applied' || !current()) throw new Error('Center background selection outcome is unknown; inspect before retrying');
    setGlobalBoardOpen(false);
    settingsControlRef.current.ensureWorkspaceVisible();
    await settlePanelVisibility('.terminal-page', () => current() && (!panelSnapshotRef.current.hVs || panelSnapshotRef.current.focusMode || hDockIntent.current === 'terminal'));
    if (!current()) throw new Error('Center background focus outcome is unknown; inspect before retrying');
    if (item.file) await waitForCenterFileHost(item.file, current);
    const deps = splitDepsRef.current;
    const primary = resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
    const slot = focusVisibleCenterPane(primary, target);
    await focusCenterPaneElement(slot, () => {
      if (!current()) return false;
      const latest = splitDepsRef.current, view = panelSnapshotRef.current, split = getCenterSplitState();
      const pane = getCenterSplitPaneRefs(resolveActualCenterSelection(latest.utilityPanel, latest.displayActiveId, latest), split)[slot];
      return !!pane && samePaneRef(pane, target) && split.focused === slot && !split.pendingLayout && (!item.file || centerFileHostVisible(item.file)) &&
        (!view.hVs || view.focusMode || view.hDock === 'terminal') && (!view.narrow || !view.rightDrawerOpen);
    });
  };
  const releaseCenterFileBacking = (item: BackgroundCenterView): void => {
    if (!item.file) return;
    if (rightDockSnapshot().docked.has(centerFileDockKey(item.file.tabId))) {
      const result = releaseDockTarget(centerFileDockKey(item.file.tabId), centerFileHostKey(item.file.tabId));
      if (!result.ok) throw new Error(result.error);
    }
    releaseAgentCenterFile(item.workspaceId, item.file.tabId, item.file.content);
  };
  const closeBackgroundView = (item: BackgroundCenterView): void => {
    if (isWorkspaceFileClosePending(item.workspaceId)) throw new Error('Workspace close is pending');
    if (!item.file) {
      flushSync(() => setBackgroundCenterViews(items => items.filter(candidate => candidate.id !== item.id || candidate.workspaceId !== item.workspaceId)));
      return;
    }
    const deps = splitDepsRef.current, split = getCenterSplitState();
    if (deps.activeWorkspaceId !== item.workspaceId || split.pendingLayout || panelSnapshotRef.current.switching || panelSnapshotRef.current.wsTransit ||
        !backgroundViewAvailable(item, deps.sessions, deps.navigationIdentity)) throw new Error('Center file changed or is unavailable');
    const primary = resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
    if (getCenterSplitPaneRefs(primary, split).some(pane => samePaneRef(pane, item.target))) {
      flushSync(() => setBackgroundCenterViews(items => items.map(candidate => candidate.id === item.id ? { ...candidate, background: false } : candidate)));
      return;
    }
    releaseCenterFileBacking(item);
    flushSync(() => setBackgroundCenterViews(items => items.filter(candidate => candidate.id !== item.id || candidate.workspaceId !== item.workspaceId)));
  };
  useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      const deps = splitDepsRef.current, split = getCenterSplitState();
      if (!deps.activeWorkspaceId || isWorkspaceFileClosePending(deps.activeWorkspaceId) || split.pendingLayout || panelSnapshotRef.current.switching || panelSnapshotRef.current.wsTransit) return;
      const panes = getCenterSplitPaneRefs(resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps), split);
      for (const item of backgroundCenterViewsRef.current) {
        if (!item.file || item.workspaceId !== deps.activeWorkspaceId || panes.some(pane => samePaneRef(pane, item.target))) continue;
        const docked = rightDockSnapshot().docked.has(centerFileDockKey(item.file.tabId));
        if (!backgroundViewAvailable(item, deps.sessions, deps.navigationIdentity)) {
          try {
            const current = readAgentCenterFile(item.workspaceId, item.file.tabId);
            if (!docked && (!current || JSON.stringify(current.content) !== item.file.content || current.centerOnly !== item.file.centerOnly || current.pinned !== item.file.pinned)) {
              setBackgroundCenterViews(items => items.filter(candidate => candidate.id !== item.id));
            }
          } catch { /* A temporarily unavailable reader is not evidence the source disappeared. */ }
          continue;
        }
        if (item.background !== false) continue;
        try {
          releaseCenterFileBacking(item);
          setBackgroundCenterViews(items => items.filter(candidate => candidate.id !== item.id));
        } catch (error) {
          setBackgroundCenterViews(items => items.map(candidate => candidate.id === item.id ? { ...candidate, background: true } : candidate));
          flashTip(error instanceof Error ? error.message : String(error));
        }
      }
    });
    return () => { alive = false; };
  }, [observedCenterSplit, utilityPanel, activeWorkspaceId, backgroundCenterViews, centerFilesVersion, settingsDock, switching, wsTransit, flashTip]);
  useEffect(() => window.api.on('panel:snapshot-request', request => {
    try {
      const deps = splitDepsRef.current;
      const view = panelSnapshotRef.current;
      if (!deps.activeWorkspaceId || request.workspaceId !== deps.activeWorkspaceId || view.switching || view.wsTransit) {
        throw new Error('Requested workspace is not the stable visible workspace');
      }
      const split = getCenterSplitState();
      const primary = resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
      window.api.panel.replySnapshot(request.requestId, { ok: true, snapshot: {
        workspaceId: deps.activeWorkspaceId,
        axis: { page: view.hDock, virtualScreen: view.hVs, focusMode: view.focusMode },
        center: { panes: getCenterSplitPaneRefs(primary, split), focused: split.focused,
          fileViews: backgroundCenterViewsRef.current.filter(item => item.workspaceId === deps.activeWorkspaceId && item.file && backgroundViewAvailable(item, deps.sessions, deps.navigationIdentity)).map(item => item.file!),
          background: backgroundCenterViewsRef.current.filter(item => item.workspaceId === deps.activeWorkspaceId && item.background !== false && backgroundViewAvailable(item, deps.sessions, deps.navigationIdentity))
            .map(item => ({ id: item.id, target: item.target, ...(item.navigation ? { navigation: item.navigation } : {}) })),
          ...(split.layoutId ? { layoutId: split.layoutId } : {}), ...(split.order ? { order: [...split.order] } : {}) },
        settings: { prepared: view.settingsPrepared || view.settingsModal,
          visible: view.settingsModal || view.settingsRightShown || (view.settingsVisible && !view.settingsDocked && (!view.hVs || view.focusMode || view.hDock === 'terminal')),
          dirty: view.settingsReady && view.settingsDirty },
        right: readRightPanelState(deps.activeWorkspaceId)
      } });
    } catch (error) {
      window.api.panel.replySnapshot(request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }), []);
  const pendingRightLayout = useRef<string | null>(null);
  useEffect(() => window.api.on('panel:right-layout-request', request => {
    const reply = (response: PanelRightLayoutResponse) => window.api.panel.replyRightLayout(request.requestId, response);
    const view = panelSnapshotRef.current;
    if (pendingRightLayout.current || isWorkspaceFileClosePending(request.workspaceId) ||
        splitDepsRef.current.activeWorkspaceId !== request.workspaceId || view.panelRootsRevision !== request.rootsRevision ||
        view.switching || view.wsTransit || view.settingsModal || (view.settingsVisible || view.settingsDocked) && view.settingsDirty) {
      reply({ ok: false, error: 'Right split is unavailable while the workspace or settings are changing' });
      return;
    }
    pendingRightLayout.current = request.requestId;
    let applied = false;
    void (async () => {
      try {
        applyAgentRightLayout(request.workspaceId, request.change);
        applied = true;
        if (request.reveal) await revealRightPanel(request.requestId, request.workspaceId, request.rootsRevision, () =>
          rightLayoutMatches(readRightPanelState(request.workspaceId), request.change, request.change.next) &&
          !document.querySelector('.right-workspace.is-tab-fullscreen'));
        reply({ ok: true, placement: 'right', ...request.change.next });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply({ ok: false, error: message, ...(applied || message.includes('outcome is unknown') ? { outcome: 'unknown' as const } : {}) });
      } finally {
        pendingRightLayout.current = null;
      }
    })();
  }), [revealRightPanel]);
  useEffect(() => window.api.on('panel:open-content-request', request => {
    const isCurrent = (): boolean => !isWorkspaceFileClosePending(request.workspaceId) && splitDepsRef.current.activeWorkspaceId === request.workspaceId &&
      !panelSnapshotRef.current.switching && !panelSnapshotRef.current.wsTransit &&
      panelSnapshotRef.current.panelRootsRevision === request.rootsRevision;
    if (!isCurrent()) {
      window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Requested workspace or roots are no longer current' });
      return;
    }
    if (request.content.kind === 'settings') {
      if (settingsClosingRef.current) {
        window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Settings close is in progress' });
        return;
      }
      if (request.focus && readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved)) {
        window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Cannot change the visible panel while the active editor has unsaved changes' });
        return;
      }
      const control = settingsControlRef.current;
      if (request.content.placement !== 'right' && request.focus && control.settingsDocked) {
        if (control.settingsModal || control.settingsDirty) {
          window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Cannot move settings while the modal is open or settings have unsaved changes' });
          return;
        }
        try {
          const tabs = readRightPanelState(request.workspaceId).tabs.filter(tab => tab.content.kind === 'utility' && tab.content.sel === 'settings');
          if (tabs.length !== 1) throw new Error('Settings tab is unavailable or ambiguous');
          closeAgentRightTab(request.workspaceId, tabs[0].id, JSON.stringify(tabs[0].content));
        } catch (error) {
          window.api.panel.replyOpenContent(request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
      if (request.content.placement === 'right' && request.focus && (control.settingsModal || control.settingsDirty && !panelSnapshotRef.current.settingsRightShown)) {
        window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Cannot move settings while the modal is open or settings have unsaved changes' });
        return;
      }
      settingsOpeningRef.current.add(request.requestId);
      try {
        setSettingsPrepared(true);
        if (request.content.placement !== 'right' && !request.focus && !control.settingsDocked && !control.settingsModal) {
          setSettingsBackgroundWorkspace(request.workspaceId);
        }
        if (request.content.placement === 'right') {
          activeRightRequests.current.add(request.requestId);
          void Promise.resolve().then(async () => {
            if (closedRightRequests.current.has(request.requestId)) throw new Error('Panel open outcome is unknown; request was closed');
            if (request.focus && (settingsControlRef.current.settingsModal || settingsControlRef.current.settingsDirty && !panelSnapshotRef.current.settingsRightShown)) {
              throw new Error('Settings state changed before the move');
            }
            const result = await openAgentRightContent(request.workspaceId, { kind: 'utility', sel: 'settings', title: RIGHT_UTILITY_TITLES.settings }, request.focus);
            if (closedRightRequests.current.has(request.requestId)) throw new Error('Panel open outcome is unknown; request was closed');
            if (request.focus) {
              await revealRightPanel(request.requestId, request.workspaceId, request.rootsRevision,
                () => readRightPanelState(request.workspaceId).selectedTabId === result.tabId);
            }
            if (closedRightRequests.current.has(request.requestId)) throw new Error('Panel open outcome is unknown; request was closed');
            if (!isCurrent()) throw new Error('Workspace changed; inspect the panel before retrying');
            setSettingsPending(items => [...items, { requestId: request.requestId, workspaceId: request.workspaceId,
              rootsRevision: request.rootsRevision, focus: request.focus, existing: result.existing, tabId: result.tabId }]);
          }).catch(error => {
            settingsOpeningRef.current.delete(request.requestId);
            if (!closedRightRequests.current.has(request.requestId)) window.api.panel.replyOpenContent(request.requestId,
              { ok: false, outcome: 'unknown', error: `Settings open outcome may be unknown; inspect before retrying: ${String(error)}` });
          }).finally(() => { activeRightRequests.current.delete(request.requestId); closedRightRequests.current.delete(request.requestId); });
          return;
        }
        if (request.focus) {
          if (!control.settingsOpen) {
            control.ensureWorkspaceVisible();
            control.showTerminal();
            setGlobalBoardOpen(false);
            control.selectUtilityPanel('settings');
          }
        }
        setSettingsPending(items => [...items, { requestId: request.requestId, workspaceId: request.workspaceId,
          rootsRevision: request.rootsRevision, focus: request.focus, existing: control.settingsPrepared || control.settingsModal }]);
      } catch (error) {
        settingsOpeningRef.current.delete(request.requestId);
        window.api.panel.replyOpenContent(request.requestId, { ok: false, outcome: 'unknown',
          error: `Settings open outcome may be unknown; inspect before retrying: ${String(error)}` });
      }
      return;
    }
    const content = request.content;
    if ((content.kind === 'file' || content.kind === 'image') && content.placement === 'center') {
      try {
        const { placement: _placement, ...fileContent } = content;
        if (!fileContent.fileRef || fileContent.fileRef.workspaceId !== request.workspaceId || fileContent.fileRef.relativePath !== fileContent.path || fileContent.external || fileContent.directory) {
          throw new Error('Center file requires a workspace file reference');
        }
        const view = panelSnapshotRef.current;
        if (request.focus && (view.settingsModal || (view.settingsVisible || view.settingsDocked) && view.settingsDirty ||
            (view.narrow && view.rightDrawerOpen) || readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved))) {
          throw new Error('Center view is blocked by the current view or unsaved changes');
        }
        setGitEverActive(true);
        const prepared = prepareAgentCenterFile(request.workspaceId, fileContent);
        const current = readAgentCenterFile(request.workspaceId, prepared.tabId);
        if (!isCurrent() || !current) throw new Error('Center file changed while preparing');
        if (request.focus && current.pinned) throw new Error('Pinned file cannot be moved from the right panel');
        const target = { kind: 'utility' as const, sel: centerFileDockKey(prepared.tabId) };
        const file: CenterFileBinding = { sel: target.sel, tabId: current.tabId, content: JSON.stringify(current.content), centerOnly: current.centerOnly, pinned: current.pinned };
        const existing = backgroundCenterViewsRef.current.find(item => item.workspaceId === request.workspaceId && samePaneRef(item.target, target));
        if (existing && JSON.stringify(existing.file) !== JSON.stringify(file) && rightDockSnapshot().docked.has(target.sel)) {
          throw new Error('Center file changed while its host is in use');
        }
        const prior = existing && JSON.stringify(existing.file) === JSON.stringify(file) ? existing : undefined;
        const item: BackgroundCenterView = prior ? { ...prior, background: true } : { id: `center:${crypto.randomUUID()}`, workspaceId: request.workspaceId, target, file };
        flushSync(() => setBackgroundCenterViews(items => [...items.filter(old => old !== existing), item]));
        const deps = splitDepsRef.current, panes = getCenterSplitPaneRefs(resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps), getCenterSplitState());
        const alreadyVisible = panes.some(ref => samePaneRef(ref, target));
        if (request.focus) {
          activeRightRequests.current.add(request.requestId);
          void focusBackgroundView(item, request.rootsRevision, request.requestId).then(() => {
            if (!closedRightRequests.current.has(request.requestId)) window.api.panel.replyOpenContent(request.requestId, { ok: true, tabId: item.id, existing: !!prior, selected: true });
          }).catch(error => {
            if (!closedRightRequests.current.has(request.requestId)) window.api.panel.replyOpenContent(request.requestId, { ok: false, outcome: 'unknown', error: String(error) });
          }).finally(() => { activeRightRequests.current.delete(request.requestId); closedRightRequests.current.delete(request.requestId); });
        } else window.api.panel.replyOpenContent(request.requestId, { ok: true, tabId: item.id, existing: !!prior, selected: alreadyVisible });
      } catch (error) { window.api.panel.replyOpenContent(request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if ((content.kind === 'utility' || content.kind === 'session' || content.kind === 'extension') && content.placement === 'center') {
      if (content.kind === 'utility' && (content.sel === 'settings' || !Object.hasOwn(RIGHT_UTILITY_TITLES, content.sel))) {
        window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Utility is not available' });
        return;
      }
      if (content.kind === 'session' && !splitDepsRef.current.sessions.some(session => session.id === content.sessionId &&
          session.type === 'terminal' && !session.archived && session.workspaceId === request.workspaceId)) {
        window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Session is not available in the requested workspace' }); return;
      }
      const target: BackgroundCenterView['target'] = content.kind === 'utility' ? { kind: 'utility', sel: content.sel } :
        content.kind === 'session' ? { kind: 'session', sessionId: content.sessionId } : { kind: 'utility', sel: `nav:${content.nodeId}` };
      const identity = content.kind === 'extension' ? content.navigation : undefined;
      if (content.kind === 'extension' && (!panelNavigationCurrent(request.workspaceId, [target], [{ sel: `nav:${content.nodeId}`, ...content.navigation }], splitDepsRef.current.navigationIdentity) ||
          !splitDepsRef.current.navigationIdentity.nodes.some(node => node.id === content.nodeId && node.kind === 'extension'))) {
        window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Extension navigation changed' }); return;
      }
      const dockKey = rightDockKey(target);
      const node = content.kind === 'extension' ? splitDepsRef.current.navigationIdentity.nodes.find(node => node.id === content.nodeId) : undefined;
      const view = panelSnapshotRef.current;
      if (request.focus && (view.settingsModal || (view.settingsVisible || view.settingsDocked) && view.settingsDirty ||
          (view.narrow && view.rightDrawerOpen) || (content.kind === 'extension' && (!node || node.placement === 'tab' || node.placement === 'window')) || (!!dockKey && rightDockSnapshot().docked.has(dockKey)) ||
          readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved))) {
        window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Center view is blocked by the current view or unsaved changes' }); return;
      }
      const deps = splitDepsRef.current, split = getCenterSplitState();
      const panes = getCenterSplitPaneRefs(resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps), split);
      const alreadyVisible = panes.some(ref => samePaneRef(ref, target));
      const prior = backgroundCenterViewsRef.current.find(item => item.workspaceId === request.workspaceId && samePaneRef(item.target, target) && JSON.stringify(item.navigation) === JSON.stringify(identity));
      const item = prior ?? { id: `center:${crypto.randomUUID()}`, workspaceId: request.workspaceId, target, ...(identity ? { navigation: identity } : {}) };
      if (!prior) flushSync(() => setBackgroundCenterViews(items => [...items.filter(old => old.workspaceId !== request.workspaceId || !samePaneRef(old.target, target)), item]));
      if (request.focus) {
        activeRightRequests.current.add(request.requestId);
        void focusBackgroundView(item, request.rootsRevision, request.requestId).then(() => {
          if (!closedRightRequests.current.has(request.requestId)) window.api.panel.replyOpenContent(request.requestId,
            { ok: true, tabId: item.id, existing: !!prior || alreadyVisible, selected: true });
        }).catch(error => {
          if (!closedRightRequests.current.has(request.requestId)) window.api.panel.replyOpenContent(request.requestId,
            { ok: false, outcome: 'unknown', error: String(error) });
        }).finally(() => { activeRightRequests.current.delete(request.requestId); closedRightRequests.current.delete(request.requestId); });
        return;
      }
      window.api.panel.replyOpenContent(request.requestId, { ok: true, tabId: item.id, existing: !!prior || alreadyVisible,
        selected: alreadyVisible && !!panes[split.focused] && samePaneRef(panes[split.focused], target) });
      return;
    }
    const openView = panelSnapshotRef.current;
    if (request.focus && (openView.settingsModal || (openView.settingsVisible || openView.settingsDocked) && openView.settingsDirty)) {
      window.api.panel.replyOpenContent(request.requestId, { ok: false, error: 'Cannot change the visible panel while settings are open or have unsaved changes' });
      return;
    }
    activeRightRequests.current.add(request.requestId);
    void Promise.resolve().then(async () => {
      if (closedRightRequests.current.has(request.requestId)) throw new Error('Panel open outcome is unknown; request was closed');
      const result = await openAgentRightContent(request.workspaceId, content, request.focus);
      if (closedRightRequests.current.has(request.requestId)) throw new Error('Panel open outcome is unknown; request was closed');
      if (request.focus) {
        const panel = readRightPanelState(request.workspaceId), tab = panel.tabs.find(item => item.id === result.tabId);
        if (!result.selected || !tab || panel.selectedTabId !== result.tabId) throw new Error('Panel focus outcome is unknown; selected tab changed');
        const expected = JSON.stringify(tab.content);
        await revealRightPanel(request.requestId, request.workspaceId, request.rootsRevision, () => {
          const current = readRightPanelState(request.workspaceId);
          return current.selectedTabId === result.tabId && JSON.stringify(current.tabs.find(item => item.id === result.tabId)?.content) === expected;
        });
      }
      return result;
    }).then(result => {
      if (closedRightRequests.current.has(request.requestId)) return;
      window.api.panel.replyOpenContent(request.requestId, isCurrent() ? { ok: true, ...result } :
        { ok: false, outcome: 'unknown', error: 'Workspace changed; inspect the panel before retrying' });
    }).catch(error => {
      if (closedRightRequests.current.has(request.requestId)) return;
      const message = error instanceof Error ? error.message : String(error);
      window.api.panel.replyOpenContent(request.requestId, { ok: false, error: message,
        ...(message.includes('outcome is unknown') || message.includes('result is unknown') ? { outcome: 'unknown' as const } : {}) });
    }).finally(() => { activeRightRequests.current.delete(request.requestId); closedRightRequests.current.delete(request.requestId); });
  }), []);
  useEffect(() => window.api.on('panel:open-content-closed', ({ requestId }) => {
    if (activeRightRequests.current.has(requestId)) closedRightRequests.current.add(requestId);
    settingsOpeningRef.current.delete(requestId);
    setSettingsPending(items => items.filter(item => item.requestId !== requestId));
  }), []);
  useEffect(() => {
    if (!settingsPending.length) return;
    const remaining: typeof settingsPending = [];
    for (const request of settingsPending) {
      const view = panelSnapshotRef.current;
      if (splitDepsRef.current.activeWorkspaceId !== request.workspaceId || view.switching || view.wsTransit || view.panelRootsRevision !== request.rootsRevision) {
        settingsOpeningRef.current.delete(request.requestId);
        window.api.panel.replyOpenContent(request.requestId, { ok: false, outcome: 'unknown', error: 'Workspace changed; inspect the panel before retrying' });
        continue;
      }
      const host = settingsPresence.mounted ? appShell : settingsHost;
      const page = host?.querySelector<HTMLElement>('.settings-page');
      const shown = request.tabId ? view.settingsRightShown : settingsVisible && !view.settingsDocked && (!view.hVs || view.focusMode || view.hDock === 'terminal');
      if (request.tabId && request.focus && settingsPresence.mounted) {
        settingsOpeningRef.current.delete(request.requestId);
        window.api.panel.replyOpenContent(request.requestId, { ok: false, outcome: 'unknown', error: 'Settings modal opened; inspect the panel before retrying' });
        continue;
      }
      if (!settingsReady || !page?.isConnected || (request.focus && !settingsPresence.mounted && !shown) ||
          (request.focus && settingsPresence.mounted && !settingsOpen)) { remaining.push(request); continue; }
      let selectedRight = false;
      if (request.tabId) {
        let right: ReturnType<typeof readRightPanelState>;
        try { right = readRightPanelState(request.workspaceId); }
        catch {
          settingsOpeningRef.current.delete(request.requestId);
          window.api.panel.replyOpenContent(request.requestId, { ok: false, outcome: 'unknown', error: 'Settings tab unavailable; inspect the panel before retrying' });
          continue;
        }
        if (!right.tabs.some(tab => tab.id === request.tabId && tab.content.kind === 'utility' && tab.content.sel === 'settings')) {
          settingsOpeningRef.current.delete(request.requestId);
          window.api.panel.replyOpenContent(request.requestId, { ok: false, outcome: 'unknown', error: 'Settings tab changed; inspect the panel before retrying' });
          continue;
        }
        selectedRight = right.selectedTabId === request.tabId;
        if (request.focus && !selectedRight) { remaining.push(request); continue; }
      }
      if (request.focus) {
        if (readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved)) {
          settingsOpeningRef.current.delete(request.requestId);
          window.api.panel.replyOpenContent(request.requestId, { ok: false, outcome: 'unknown', error: 'Editor state changed; inspect the panel before retrying' });
          continue;
        }
        const search = page.querySelector<HTMLInputElement>('input[type="search"]');
        search?.focus();
        if (!search || document.activeElement !== search) { remaining.push(request); continue; }
      }
      settingsOpeningRef.current.delete(request.requestId);
      window.api.panel.replyOpenContent(request.requestId, { ok: true, tabId: request.tabId ?? 'settings', existing: request.existing,
        selected: request.tabId ? selectedRight : shown || settingsPresence.mounted });
    }
    if (remaining.length !== settingsPending.length) setSettingsPending(remaining);
  }, [settingsPending, settingsReady, settingsHost, settingsVisible, settingsRightShown, settingsDocked, settingsPresence.mounted, settingsOpen, appShell, activeWorkspaceId, switching, wsTransit, panelRootsRevision, hDock, hVs, focusMode]);
  useEffect(() => window.api.on('panel:close-tab-request', request => {
    const view = panelSnapshotRef.current;
    if (typeof request.expectedContent !== 'string' || !request.expectedContent) {
      window.api.panel.replyCloseTab(request.requestId, { ok: false, error: 'Expected panel content is required' });
      return;
    }
    if (isWorkspaceFileClosePending(request.workspaceId) || splitDepsRef.current.activeWorkspaceId !== request.workspaceId || view.switching || view.wsTransit ||
        view.panelRootsRevision !== request.rootsRevision) {
      window.api.panel.replyCloseTab(request.requestId, { ok: false, error: 'Requested workspace or roots are no longer current' });
      return;
    }
    const background = backgroundCenterViewsRef.current.find(item => item.workspaceId === request.workspaceId && item.id === request.tabId);
    if (background) {
      if (background.background === false || !backgroundViewAvailable(background, splitDepsRef.current.sessions, splitDepsRef.current.navigationIdentity) ||
          request.expectedContent !== JSON.stringify({ kind: 'center-background', target: background.target, ...(background.navigation ? { navigation: background.navigation } : {}), ...(background.file ? { file: background.file } : {}) })) {
        window.api.panel.replyCloseTab(request.requestId, { ok: false, error: 'Background view changed; inspect before retrying' }); return;
      }
      try { closeBackgroundView(background); window.api.panel.replyCloseTab(request.requestId, { ok: true, tabId: request.tabId, closed: true }); }
      catch (error) { window.api.panel.replyCloseTab(request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (request.tabId === 'settings' && request.expectedContent === JSON.stringify({ kind: 'settings' })) {
      const control = settingsControlRef.current;
      let rightSettingsExists = true;
      try { rightSettingsExists = readRightPanelState(request.workspaceId).tabs.some(tab => tab.content.kind === 'utility' && tab.content.sel === 'settings'); }
      catch { /* A missing bridge cannot prove the surface is safe to release. */ }
      if (!control.settingsPrepared || control.settingsModal || control.settingsOpen || control.settingsDocked || rightSettingsExists || control.settingsDirty || settingsClosingRef.current || settingsOpeningRef.current.size > 0 ||
          readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved)) {
        window.api.panel.replyCloseTab(request.requestId, { ok: false, error: 'Settings cannot be closed while unavailable, in use, dirty, or another close is pending' });
        return;
      }
      const state = getCenterSplitState();
      if (state.pendingLayout) {
        window.api.panel.replyCloseTab(request.requestId, { ok: false, error: 'Panel layout is changing' });
        return;
      }
      const deps = splitDepsRef.current;
      const primary = resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
      const panes = getCenterSplitPaneRefs(primary, state);
      const index = panes.findIndex(pane => pane.kind === 'utility' && pane.sel === 'settings');
      settingsClosingRef.current = true;
      setSettingsClosePending({ requestId: request.requestId, workspaceId: request.workspaceId, rootsRevision: request.rootsRevision });
      try {
        if (index >= 0 && state.open) centerSplitClosePane(index as 0 | 1 | 2);
        else if (index === 0) control.closeUtilityPanel();
      } catch (error) {
        settingsClosingRef.current = false;
        setSettingsClosePending(null);
        window.api.panel.replyCloseTab(request.requestId, { ok: false, outcome: 'unknown',
          error: `Settings close outcome may be unknown; inspect before retrying: ${String(error)}` });
      }
      return;
    }
    if (request.expectedContent && (view.settingsDirty || view.settingsModal || settingsOpeningRef.current.size > 0) && (() => {
      try { const content = JSON.parse(request.expectedContent); return content?.kind === 'utility' && content?.sel === 'settings'; }
      catch { return false; }
    })()) {
      window.api.panel.replyCloseTab(request.requestId, { ok: false, error: 'Cannot close settings while in use or with unsaved changes' });
      return;
    }
    try {
      const result = closeAgentRightTab(request.workspaceId, request.tabId, request.expectedContent);
      window.api.panel.replyCloseTab(request.requestId, { ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.api.panel.replyCloseTab(request.requestId, { ok: false, error: message,
        ...(message.includes('outcome is unknown') ? { outcome: 'unknown' as const } : {}) });
    }
  }), []);
  useEffect(() => window.api.on('panel:close-tab-closed', ({ requestId }) => {
    setSettingsClosePending(item => {
      if (item?.requestId !== requestId) return item;
      settingsClosingRef.current = false;
      return null;
    });
  }), []);
  useEffect(() => {
    const item = settingsClosePending;
    if (!item) return;
    const deps = splitDepsRef.current, view = panelSnapshotRef.current;
    if (deps.activeWorkspaceId !== item.workspaceId || view.panelRootsRevision !== item.rootsRevision || view.switching || view.wsTransit ||
        settingsOpen || settingsPresence.mounted || settingsDirty || readFileEditorStates(item.workspaceId).some(editor => editor.active && editor.unsaved)) {
      settingsClosingRef.current = false;
      setSettingsClosePending(null);
      window.api.panel.replyCloseTab(item.requestId, { ok: false, outcome: 'unknown', error: 'Settings or workspace changed; inspect before retrying' });
      return;
    }
    const primary = resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
    const state = getCenterSplitState();
    if (state.pendingLayout || getCenterSplitPaneRefs(primary, state).some(pane => pane.kind === 'utility' && pane.sel === 'settings')) return;
    if (settingsPrepared) { setSettingsBackgroundWorkspace(null); setSettingsPrepared(false); return; }
    if (settingsReady) return;
    settingsClosingRef.current = false;
    setSettingsClosePending(null);
    window.api.panel.replyCloseTab(item.requestId, { ok: true, tabId: 'settings', closed: true });
  }, [settingsClosePending, observedCenterSplit, utilityPanel, settingsPrepared, settingsReady, settingsDirty,
    settingsOpen, settingsPresence.mounted, activeWorkspaceId, switching, wsTransit, panelRootsRevision]);
  useEffect(() => window.api.on('panel:focus-tab-request', request => {
    const view = panelSnapshotRef.current;
    if (typeof request.expectedContent !== 'string' || !request.expectedContent) {
      window.api.panel.replyFocusTab(request.requestId, { ok: false, error: 'Expected panel content is required' });
      return;
    }
    if (isWorkspaceFileClosePending(request.workspaceId) || splitDepsRef.current.activeWorkspaceId !== request.workspaceId || view.switching || view.wsTransit ||
        view.panelRootsRevision !== request.rootsRevision) {
      window.api.panel.replyFocusTab(request.requestId, { ok: false, error: 'Requested workspace or roots are no longer current' });
      return;
    }
    if (view.settingsModal || (view.settingsVisible || view.settingsDocked) && view.settingsDirty) {
      window.api.panel.replyFocusTab(request.requestId, { ok: false, error: 'Cannot change the visible panel while settings are open or have unsaved changes' });
      return;
    }
    const background = backgroundCenterViewsRef.current.find(item => item.workspaceId === request.workspaceId && item.id === request.tabId);
    if (background) {
      if (background.background === false || !backgroundViewAvailable(background, splitDepsRef.current.sessions, splitDepsRef.current.navigationIdentity) ||
          request.expectedContent !== JSON.stringify({ kind: 'center-background', target: background.target, ...(background.navigation ? { navigation: background.navigation } : {}), ...(background.file ? { file: background.file } : {}) })) {
        window.api.panel.replyFocusTab(request.requestId, { ok: false, error: 'Background view changed; inspect before retrying' }); return;
      }
      activeRightRequests.current.add(request.requestId);
      void focusBackgroundView(background, request.rootsRevision, request.requestId).then(() => {
        if (!closedRightRequests.current.has(request.requestId)) window.api.panel.replyFocusTab(request.requestId,
          { ok: true, tabId: background.id, selected: true });
      }).catch(error => {
        if (!closedRightRequests.current.has(request.requestId)) window.api.panel.replyFocusTab(request.requestId,
          { ok: false, outcome: 'unknown', error: String(error) });
      }).finally(() => { activeRightRequests.current.delete(request.requestId); closedRightRequests.current.delete(request.requestId); });
      return;
    }
    activeRightRequests.current.add(request.requestId);
    void Promise.resolve().then(async () => {
      if (closedRightRequests.current.has(request.requestId)) throw new Error('Panel focus outcome is unknown; request was closed');
      const result = focusAgentRightTab(request.workspaceId, request.tabId, request.expectedContent);
      await revealRightPanel(request.requestId, request.workspaceId, request.rootsRevision, () => {
        const current = readRightPanelState(request.workspaceId);
        return current.selectedTabId === request.tabId && JSON.stringify(current.tabs.find(item => item.id === request.tabId)?.content) === request.expectedContent;
      });
      return result;
    }).then(result => {
      if (closedRightRequests.current.has(request.requestId)) return;
      window.api.panel.replyFocusTab(request.requestId, { ok: true, ...result });
    }).catch(error => {
      if (closedRightRequests.current.has(request.requestId)) return;
      const message = error instanceof Error ? error.message : String(error);
      window.api.panel.replyFocusTab(request.requestId, { ok: false, error: message,
        ...(message.includes('outcome is unknown') ? { outcome: 'unknown' as const } : {}) });
    }).finally(() => { activeRightRequests.current.delete(request.requestId); closedRightRequests.current.delete(request.requestId); });
  }), []);
  useEffect(() => window.api.on('panel:focus-tab-closed', ({ requestId }) => {
    if (activeRightRequests.current.has(requestId)) closedRightRequests.current.add(requestId);
  }), []);
  usePanelCenterFocus(() => {
    const view = panelSnapshotRef.current, deps = splitDepsRef.current;
    return { workspaceId: deps.activeWorkspaceId, rootsRevision: view.panelRootsRevision, switching: view.switching,
      transitioning: !!view.wsTransit, navigation: deps.navigationIdentity,
      visible: (!view.hVs || view.focusMode || view.hDock === 'terminal') && (!narrow || !rightDrawerOpen),
      canFocus: target => {
        const dockKey = rightDockKey(target);
        const docked = rightDockSnapshot().docked;
        if (target.kind === 'utility' && target.sel.startsWith('center-file:')) {
          const file = backgroundCenterViewsRef.current.find(item => item.workspaceId === deps.activeWorkspaceId && samePaneRef(item.target, target))?.file;
          if (!file || file.pinned || !panelFilesCurrent(deps.activeWorkspaceId ?? '', [target], [file]) || !centerFileHostVisible(file)) return false;
        }
        return canFocusCenterTarget(target, { docked: !!dockKey && docked.has(dockKey), navigation: deps.navigationIdentity.nodes,
          settingsModal: view.settingsModal, settingsDirty: view.settingsDirty, settingsVisible: view.settingsVisible, settingsDocked: docked.has('utility:settings') });
      },
      focus: async (target, isCurrent) => {
        const workspaceId = deps.activeWorkspaceId, rootsRevision = view.panelRootsRevision;
        const slot = focusVisibleCenterPane(resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps), target);
        await focusCenterPaneElement(slot, () => {
          const current = splitDepsRef.current, now = panelSnapshotRef.current, split = getCenterSplitState();
          const primary = resolveActualCenterSelection(current.utilityPanel, current.displayActiveId, current);
          const pane = getCenterSplitPaneRefs(primary, split)[slot];
          const dockKey = rightDockKey(target);
          const docked = rightDockSnapshot().docked;
          const file = target.kind === 'utility' && target.sel.startsWith('center-file:')
            ? backgroundCenterViewsRef.current.find(item => item.workspaceId === workspaceId && samePaneRef(item.target, target))?.file : undefined;
          return isCurrent() && current.activeWorkspaceId === workspaceId && now.panelRootsRevision === rootsRevision && !now.switching && !now.wsTransit &&
            (!now.hVs || now.focusMode || now.hDock === 'terminal') && (!now.narrow || !now.rightDrawerOpen) &&
            !!pane && samePaneRef(pane, target) && split.focused === slot && !split.pendingLayout &&
            (!(target.kind === 'utility' && target.sel.startsWith('center-file:')) || (!!file && !file.pinned && panelFilesCurrent(workspaceId ?? '', [target], [file]) && centerFileHostVisible(file))) &&
            canFocusCenterTarget(target, { docked: !!dockKey && docked.has(dockKey), navigation: current.navigationIdentity.nodes,
              settingsModal: now.settingsModal, settingsDirty: now.settingsDirty, settingsVisible: now.settingsVisible, settingsDocked: docked.has('utility:settings') });
        });
        return slot;
      } };
  });
  usePanelAxisFocus({ workspaceId: activeWorkspaceId, rootsRevision: panelRootsRevision, switching,
    transitioning: !!wsTransit, page: hDock, pendingPage: () => hDockIntent.current,
    prepare: () => { clearHTimer(); suppressPageClicks(); }, virtualScreen: hVs, focusMode,
    narrow, rightDrawerOpen, settingsModal: settingsPresence.mounted, settingsDirtyDocked: settingsDirty && settingsDocked, closeDrawer: () => setRightDrawerOpen(false), revealRight: revealRightPanel,
    showTerminal, settleTerminal: () => settlePanelVisibility('.terminal-page') });
  usePanelSplit({ workspaceId: activeWorkspaceId, rootsRevision: panelRootsRevision, switching,
    transitioning: !!wsTransit, page: hDock, virtualScreen: hVs, focusMode, navigation,
    targetsVisible: panes => panes.every(pane => {
      if (pane.kind !== 'utility' || !pane.sel.startsWith('center-file:')) return true;
      const item = backgroundCenterViewsRef.current.find(candidate => candidate.workspaceId === splitDepsRef.current.activeWorkspaceId && samePaneRef(candidate.target, pane));
      return !!item?.file && !item.file.pinned && backgroundViewAvailable(item, splitDepsRef.current.sessions, splitDepsRef.current.navigationIdentity) && centerFileHostVisible(item.file);
    }),
    primary: () => {
      const deps = splitDepsRef.current;
      return resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
    }, ensureWorkspaceVisible });
  usePanelCenterClose({ workspaceId: activeWorkspaceId, rootsRevision: panelRootsRevision, switching,
    transitioning: !!wsTransit, settingsBlocked: settingsPresence.mounted || (settingsVisible || settingsDocked) && settingsDirty, navigation,
    primary: () => {
      const deps = splitDepsRef.current;
      return resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
    } });
  useEffect(() => {
    attachCenterSplitBridge({
      getPrimary: () => {
        const deps = splitDepsRef.current;
        return resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
      },
      getSelectionScope: () => splitDepsRef.current.activeWorkspaceId,
      getUnderlyingPrimary: () => {
        const deps = splitDepsRef.current;
        return resolveActualCenterSelection(null, deps.displayActiveId, deps);
      },
      supportsRef: ref => supportsCenterSplitRef(ref, splitDepsRef.current),
      canSelectRef: ref => {
        const deps = splitDepsRef.current;
        return ref.kind === 'session'
          ? deps.sessions.some(session => session.id === ref.sessionId && !session.archived)
          : supportsCenterSplitRef(ref, deps);
      },
      selectRef: (ref, options) => splitDepsRef.current.selectSplitRef(ref, options),
      getPrefs: () => {
        const deps = splitDepsRef.current;
        return {
          dir: deps.cfgCenterSplitDir === 'col' ? 'col' : 'row',
          ratio: typeof deps.cfgCenterSplitRatio === 'number' ? deps.cfgCenterSplitRatio : 0.5
        };
      },
      savePrefs: prefs => splitDepsRef.current.saveSplitPrefs(prefs)
    });
    return () => {
      attachCenterSplitBridge(null);
    };
  }, []);
  useLayoutEffect(() => {
    const deps = splitDepsRef.current;
    const unsupportedPrimary = (deps.utilityPanel != null || deps.displayActiveId != null) &&
      resolveCenterSplitPrimary(deps.utilityPanel, deps.displayActiveId, deps).kind === 'empty';
    // Store owns the pending primary transaction, so temporary empty views while
    // sessions.select awaits acknowledgement do not discard an otherwise valid split.
    centerSplitReconcilePrimary(undefined, unsupportedPrimary);
  }, [utilityPanel, sessionStore.displayActiveId, sessionStore.sessions, navigation.nodes, backgroundCenterViews, centerFilesVersion]);
  // 分屏 secondary 失源清理（会话被关/归档）；切工作区整体收起
  useEffect(() => {
    const sources = splitDepsRef.current;
    pruneCenterSplit(ref => supportsCenterSplitRef(ref, sources) &&
      (ref.kind !== 'session' || sources.sessions.some(s => s.id === ref.sessionId && !s.archived)));
  }, [sessionStore.sessions, navigation.nodes, backgroundCenterViews, centerFilesVersion]);
  useEffect(() => { centerSplitClose(); }, [activeWorkspaceId]);

  /** 系统通知点击（决策 #9 审批注意流）：打开记忆中心并落到指定页签 */
  useEffect(() => {
    return window.api.on('ui:openPanel', (p) => {
      if (p.panel !== 'memory') return;
      selectUtilityPanel('memory');
      requestMemoryCenterTab(p.tab ?? 'overview');
    });
  }, [selectUtilityPanel]);

  // Left history owns left content/split layouts and opaque visits to the right.
  const historyWsId = useHistoryWsId();
  const leftNavigationRef = useRef<LeftNavigationController | null>(null);
  const backPanelHistory = useCallback(() => leftNavigationRef.current?.back(), []);
  const forwardPanelHistory = useCallback(() => leftNavigationRef.current?.forward(), []);
  const leftNavigationOptions = {
    workspaceId: historyWsId,
    enabled: wsFileReady && historyReadyWorkspace === historyWsId && wsFileWorkspaceId === activeWorkspaceId && !switching && !wsTransit,
    page: hDock,
    primary: resolveActualCenterSelection(utilityPanel, sessionStore.displayActiveId, splitDepsRef.current),
    showPage: (page: HDock) => {
      clearHTimer();
      suppressPageClicks();
      if (page === 'terminal') showTerminal();
      else if (!hVs && !focusMode) enableHVs('git');
      else showGit();
    }
  };

  const filesSurfaceActive = (hDock === 'git' || focusMode) && !switching && !wsTransit;
  useEffect(() => {
    if (!filesSurfaceActive) {
      setPreferredFindSurface('chat');
      return;
    }
    if (!focusMode) {
      setPreferredFindSurface('files');
      return;
    }
    const syncFromFocus = (target: EventTarget | null): void => {
      if (isFilesFindDomTarget(target)) setPreferredFindSurface('files');
      else if (isChatFindDomTarget(target)) setPreferredFindSurface('chat');
    };
    syncFromFocus(document.activeElement);
    const onFocus = (ev: FocusEvent): void => syncFromFocus(ev.target);
    document.addEventListener('focusin', onFocus);
    // 聊天正文不可聚焦：只听 focusin 时，焦点在文件编辑器里点一下聊天正文再按
    // Ctrl+F 仍会开文件查找——点哪侧跟哪侧（pointerdown 捕获，不依赖可聚焦性）。
    const onPointerDown = (ev: PointerEvent): void => syncFromFocus(ev.target);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [filesSurfaceActive, focusMode]);

  const findChat = useCallback(() => {
    const deps = splitDepsRef.current, split = getCenterSplitState();
    const primary = resolveCenterSplitPrimary(deps.utilityPanel, deps.displayActiveId, deps);
    const focused = getCenterSplitPaneRefs(primary, split)[split.open ? split.focused : 0];
    const target = resolveChatFindTarget(focused?.kind === 'session' ? focused.sessionId : undefined);
    if (!target) return;
    const cur = getChatFindShared();
    patchChatFindShared({
      open: true,
      ownerId: target.id,
      focusEpoch: cur.focusEpoch + 1
    });
  }, []);
  const toggleCenterSplit = useCallback(() => {
    const deps = splitDepsRef.current;
    if (resolveCenterSplitPrimary(deps.utilityPanel, deps.displayActiveId, deps).kind === 'empty') return;
    ensureWorkspaceVisible();
    centerSplitToggleShortcut();
  }, [ensureWorkspaceVisible]);
  const toggleVirtualScreen = useCallback(() => {
    // 专注期间不动持久化布局（见 enterFocus 注释）：这里若 enableHVs 会写 hVirtualScreen，
    // 退出专注时又被快照回写覆盖；退专注走中段钮（短按或长按菜单）
    if (focusMode) return;
    if (hDock === 'git') showTerminal();
    else if (!hVs) enableHVs('git');
    else showGit();
  }, [enableHVs, focusMode, hDock, hVs, showGit, showTerminal]);
  const releaseTerminalFocusAction = useCallback(() => {
    const wasTerm = releaseTerminalFocus(keySinkRef.current);
    flashTip(wasTerm ? t('已退出终端焦点，应用快捷键可用') : t('终端未在输入，快捷键可用'));
  }, [flashTip, t]);
  useAppKeybindings({
    openSettings: () => setSettingsOpen(value => !value),
    findChat,
    toggleGlobalBoard,
    toggleProcessMonitor,
    toggleCenterSplit,
    toggleVirtualScreen,
    goBack: backPanelHistory,
    goForward: forwardPanelHistory,
    releaseTerminalFocus: releaseTerminalFocusAction,
    openQuickFiles: () => openCommandPalette('file'),
    findFiles: () => openCommandPalette('content'),
    gotoPalette: () => openCommandPalette('goto'),
    openCommands: () => openCommandPalette('command')
  });

  useEffect(() => {
    closeCommandPalette();
  }, [activeWorkspaceId, closeCommandPalette]);

  const [stripEl, setStripEl] = useState<HTMLDivElement | null>(null);
  const hasPeekPage = hVs && !narrow && !focusMode && !switching && !wsTransit;
  usePageActivation(stripEl, {
    hDock, narrow, suppressUntil: suppressPageClickUntilRef, clickHSwitch, armHSwitch, clearHTimer,
    show: { terminal: showTerminal, git: showGit }
  });

  useEffect(() => {
    if (!sideDockRequest) return;
    const dock = sideDockRequest.dock;
    clearSideDockRequest();
    if (narrow && dock === 'git') setRightDrawerOpen(true);
    pulseHStripBusy(450);
    suppressPageClicks();
    // 专注下 Git 页本就并肩可见：只响应 dock 语义，不再拉起虚拟屏
    if (!focusMode) {
      if (!hVs) {
        setHVs(true);
        void patchWsFile({ hVirtualScreen: true });
      }
      saveWorkspacePage(dock);
    }
    setHDock(dock);
  }, [sideDockRequest, clearSideDockRequest, pulseHStripBusy, suppressPageClicks, hVs, focusMode, narrow, saveWorkspacePage, patchWsFile]);

  // 过场编排实例常驻（防重入状态跨渲染保留）；布局快照在 arm 时按最新值锁定
  const transitLayoutRef = useRef({ workspaces, activeWorkspaceId, viewW, hVs, hDock, leftColW, focusMode, focusRatio, sessionsInFlow, termRatio, gitRatio });
  transitLayoutRef.current = { workspaces, activeWorkspaceId, viewW, hVs, hDock, leftColW, focusMode, focusRatio, sessionsInFlow, termRatio, gitRatio };
  const waitForWorkspaceVisible = useCallback((id: string): Promise<void> => new Promise(resolve => {
    const deadline = performance.now() + 2000;
    const check = (): void => {
      const surface = workAreaRef.current;
      if (transitLayoutRef.current.activeWorkspaceId === id && surface?.dataset.workspaceId === id && surface.clientWidth > 0 && surface.clientHeight > 0) {
        requestAnimationFrame(() => resolve());
        return;
      }
      if (performance.now() >= deadline) { resolve(); return; }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }), []);
  const switchWorkspaceRef = useRef(switchWorkspace);
  switchWorkspaceRef.current = switchWorkspace;
  const transitRef = useRef<WorkspaceTransit | null>(null);
  if (!transitRef.current) {
    let base: Omit<WsTransit, 'phase'> | null = null;
    transitRef.current = createWorkspaceTransit({
      setPhase: (phase, toId, targetLayout) => {
        if (phase === null) {
          base = null;
          setWsTransit(null);
          return;
        }
        if (phase === 'arm' || !base) {
          const l = transitLayoutRef.current;
          const fromIdx = l.workspaces.findIndex((w) => w.id === l.activeWorkspaceId);
          const toIdx = l.workspaces.findIndex((w) => w.id === toId);
          base = {
            dir: toIdx >= fromIdx ? 1 : -1,
            // 专注下骨架近似（藏会话列 + Git 侧 peek 形态，胶片一闪而过）；
            // 折叠的会话栏不占布局，骨架同样不留左栏位
            leftW: targetLayout?.leftW ?? (l.focusMode || !l.sessionsInFlow ? 0 : resolveLeftW(l.leftColW, l.viewW)),
            virtualScreen: targetLayout?.virtualScreen ?? (l.hVs || l.focusMode),
            hDock: targetLayout?.hDock ?? l.hDock,
            termRatio: targetLayout?.termRatio ?? (l.focusMode ? l.focusRatio : l.termRatio),
            gitRatio: targetLayout?.gitRatio ?? (l.focusMode ? 1 - l.focusRatio : l.gitRatio),
            frameColor: targetLayout?.frameColor,
            canvasColor: targetLayout?.canvasColor
          };
        }
        setWsTransit({ ...base, phase });
      },
      doSwitch: (id) => switchWorkspaceRef.current(id),
      sleep,
      nextFrame,
      reducedMotion: prefersReducedMotion,
      waitForVisible: waitForWorkspaceVisible,
      resolveLayout: async (id): Promise<WorkspaceTransitLayout | null> => {
        try {
          const result = await window.api.workspaceFile.getForWorkspace(id);
          const config = result.config;
          const focus = !!config.focusMode;
          const targetFocusRatio = clamp(config.focusRatio ?? FOCUS_RATIO_DEFAULT, FOCUS_RATIO_MIN, FOCUS_RATIO_MAX);
          const appearance = resolveAppearance(getTheme(), {
            workspaceId: id,
            accent: workspaceAccent(id),
            enabled: workspaceAccentEnabled(id)
          });
          return {
            leftW: focus || !transitLayoutRef.current.sessionsInFlow
              ? 0
              : resolveLeftW(config.leftColumnWidth ?? transitLayoutRef.current.leftColW, transitLayoutRef.current.viewW),
            virtualScreen: !!config.hVirtualScreen || focus,
            hDock: visualHDock({
              stored: loadVirtualScreenPage(id, config.hDock),
              hVirtualScreen: !!config.hVirtualScreen,
              focusMode: focus
            }),
            termRatio: focus
              ? targetFocusRatio
              : clamp(config.hTerminalRatio ?? TERM_RATIO_DEFAULT, TERM_RATIO_MIN, TERM_RATIO_MAX),
            gitRatio: focus
              ? 1 - targetFocusRatio
              : clamp(config.hGitRatio ?? GIT_RATIO_DEFAULT, GIT_RATIO_MIN, GIT_RATIO_MAX),
            frameColor: appearance.surfaces.frame,
            canvasColor: appearance.surfaces.canvas
          };
        } catch (error) {
          console.warn('[workspace transit] target layout unavailable; using current layout', id, error);
          return null;
        }
      }
    });
  }
  const transitSwitch = useCallback((id: string) => {
    const transit = transitRef.current!;
    if (!transit.isRunning() && id === transitLayoutRef.current.activeWorkspaceId) {
      return Promise.resolve({ ok: true });
    }
    return transit.run(id);
  }, []);

  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = (): void => {
      setViewW(Math.max(el.clientWidth, 1));
      // 直接测量工作面，底部留白随 --frame-gap 变化时比例卡/截屏高度同步。
      const stage = el.querySelector('.ws-stage');
      setViewH(Math.max(stage?.clientHeight ?? el.clientHeight, 1));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const stage = el.querySelector('.ws-stage');
    if (stage) ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  const leftW = resolveLeftW(leftColW, viewW);
  /** 拖动落盘用最新值（回调闭包里 state 可能滞后） */
  const leftWRef = useRef(leftW);
  leftWRef.current = leftW;
  const leftDragRef = useRef<{ x: number; width: number } | null>(null);

  /** 左栏拖宽：指针捕获跟手；只占中栏宽度（terminalInnerW 随之伸缩，页宽不变） */
  const onLeftResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    leftDragRef.current = { x: e.clientX, width: leftWRef.current };
    setLeftResizing(true);
  }, []);

  const onLeftResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = leftDragRef.current;
    if (!drag) return;
    const page = e.currentTarget.parentElement;
    if (!page) return;
    const r = page.getBoundingClientRect();
    const dx = e.clientX - drag.x;
    setLeftColW(clamp(Math.round(drag.width + dx), LEFT_W_MIN, Math.round(r.width * 0.45)));
  }, []);

  const onLeftResizeUp = useCallback(
    (): void => {
      if (!leftDragRef.current) return;
      leftDragRef.current = null;
      setLeftResizing(false);
      commitLeftColW(leftWRef.current);
    },
    [commitLeftColW]
  );

  /** 专注布局生效条件：宽屏才并肩分屏（窄屏走抽屉，responsive.css 管布局） */
  const focusLayout = focusMode && !narrow;
  /** 侧边栏当前是否可见（展开=占位可见；折叠=仅速览唤出时可见；窄屏归抽屉管）。
   *  调度 Agent 悬浮层与其绑定：侧边栏隐藏 ⇔ .agent-float 一并隐藏（用户定稿） */
  const sidebarVisible = narrow ? true : sessionsInFlow || sessionsPeekOpen;
  /** 右侧栏（Git 页）当前是否有可见驻留：专注布局恒有，普通态=VS 开启 */
  const rightPanelOpen = focusLayout || hVs;
  /** 右上角右栏开关：关=VS 整体退出（Git 页隐藏）；开=按收起前姿态恢复——
   *  收起前是专注布局则恢复专注，否则恢复 VS 并回到收起时驻留的页（dock 记忆；
   *  此前展开恒 enableHVs('git')，折叠前驻留会话页会被强切 Git，2026-10-10 反馈）。
   *  收起动作本身退专注+关 VS 一步落盘（collapseRightPanel 单条补丁），姿态记忆
   *  经 rightPanelRestore 跨收起/展开周期与重启保留 */
  const toggleRightPanel = useCallback((): void => {
    if (focusLayout || hVs) {
      saveRightPanelRestore({ focus: focusLayout, dock: hDock });
      if (focusLayout) collapseRightPanel();
      else disableHVs();
    } else {
      const restore = loadRightPanelRestore();
      if (restore?.focus) enterFocus();
      else enableHVs(restore?.dock ?? 'git');
    }
  }, [focusLayout, hVs, hDock, collapseRightPanel, disableHVs, enableHVs, enterFocus]);
  const workspacePageW = focusLayout
    ? Math.round(viewW * focusRatio)
    : hVs
      ? Math.round(viewW * termRatio)
      : viewW;
  const gitPageW = focusLayout
    ? Math.max(viewW - workspacePageW, 1)
    : hVs
      ? Math.round(viewW * gitRatio)
      : 0;
  /** 拖大小指示卡：与被调侧等宽高比、居中，宽/高不超过该侧的 80%/50% */
  const resizePageW = focusMode ? viewW : hDock === 'git' ? gitPageW : workspacePageW;
  let sizeCardH = Math.round(viewH * 0.5);
  let sizeCardW = Math.round((sizeCardH * resizePageW) / viewH);
  const sizeCardMaxW = Math.round(resizePageW * 0.8);
  if (sizeCardW > sizeCardMaxW) {
    sizeCardW = sizeCardMaxW;
    sizeCardH = Math.round((sizeCardW * viewH) / resizePageW);
  }
  // 折叠的会话栏不占布局：中栏吃满工作页宽；展开时（含专注）让出左栏宽
  const terminalInnerW = Math.max(workspacePageW - (sessionsInFlow ? leftW : 0), 1);
  const workspacePeekOnGit = Math.max(viewW - gitPageW, 1);
  const hOffset =
    !hVs || hDock === 'terminal' ? 0 : -(workspacePageW - workspacePeekOnGit);
  const agentOnGitPage = !narrow && hVs && hDock === 'git';
  const guideSidebarHidden = narrow ? setupStep === 'session' && !leftDrawerOpen : !sessionsInFlow || agentOnGitPage;
  const settingsCoverGuide = settingsOpen || settingsPresence.mounted || !!setupSettings;
  const virtualScreenOpen = hasPeekPage;
  const guideStep = setupStep !== 'tools' && setupStep !== 'model' && setupStep !== 'finish' ? setupStep : undefined;
  const focusCompletedSetup = (): void => {
    if (!focusAfterSetup.current) return;
    focusAfterSetup.current = false;
    requestAnimationFrame(() => {
      const input = Array.from(appShell?.querySelectorAll<HTMLElement>('.terminal-page .agent-composer [role="textbox"]') ?? [])
        .find(element => !element.closest('[inert], [aria-hidden="true"]') && element.checkVisibility({ visibilityProperty: true }));
      (input ?? keySinkRef.current)?.focus({ preventScroll: true });
    });
  };

  // clip/visible prevents programmatic ancestor scrolling. Keep the event-only
  // fallback without flushing the just-committed switch layout to read offsets.
  useEffect(() => guardVirtualScreenScroll([viewRef.current, workAreaRef.current]), [hDock, hVs, viewW, hOffset]);

  const hSplitBar = (
    <div
      className={`pane-split pane-split-v${hSplitHot ? ' hot' : ''}`}
      data-resizing={hResizing ? '' : undefined}
      style={{ left: workspacePageW }}
      onPointerEnter={() => clearHTimer()}
    >
      <div className="pane-split-line resize-divider-line" />
      <SplitExpandControl
        hVs={hVs}
        /* 把手无短按动作（开/关与顶栏右栏开关重复）；「关闭虚拟屏」态下长按菜单
           拖到悬浮/点击切屏=一步退出并应用。拖拽调比例在窄屏无布局效果
           （focusLayout=false 时不消费 focusRatio），仅无害空转 */
        focusMode={focusMode}
        along={hBtnAlong}
        switchMode={hSwitchMode}
        visible={hSplitHot}
        onAlong={setHBtnAlong}
        onHotChange={setHSplitHot}
        onToggleFocus={toggleFocus}
        onSwitchMode={applySwitchModeFromMenu}
        barX={
          hVs || focusLayout
            ? focusLayout
              ? workspacePageW
              : hDock === 'git'
                ? viewW - gitPageW
                : workspacePageW
            : undefined
        }
        growSign={focusLayout ? 1 : hDock === 'git' ? -1 : 1}
        onDragAxis={setHResizeAxis}
        onResizeStart={onResizeStart}
        onResizeMove={onResizeMove}
        onResizeEnd={onResizeEnd}
        onBtnPointerActive={(active) => {
          onExpandBtnRef.current = active;
        }}
      />
    </div>
  );

  const workArea = (
    <div
      className="work-area"
      ref={workAreaRef}
      data-workspace-id={activeWorkspaceId ?? ''}
      style={{ width: viewW }}
    >
      <div
        ref={setStripEl}
        className={`h-strip${hVs ? ' vs-axis' : ''}`}
        style={{
          width: Math.max(workspacePageW + gitPageW, viewW),
          transform: `translateX(${hOffset}px)`
        }}
      >
        <div
          className="h-page workspace-page"
          data-h-page="terminal"
          data-h-peek={hasPeekPage && hDock === 'git' ? '' : undefined}
          data-setup-target={activeSetup && virtualScreenOpen && hDock === 'git' ? 'virtual-screen' : undefined}
          tabIndex={activeSetup && virtualScreenOpen && hDock === 'git' ? 0 : undefined}
          aria-label={activeSetup && virtualScreenOpen && hDock === 'git' ? t('切到会话页') : undefined}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || event.currentTarget.tabIndex !== 0 || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            showTerminal();
          }}
          style={{ width: workspacePageW }}
        >
          {/* 会话栏：展开时挂工作页文档流（窄屏由 responsive.css 转为抽屉）；
              折叠时改挂 MainViewShell 根下方的 .sessions-float（见下）。
              二选一保证 LeftPanel 单实例 */}
          {sessionsInFlow || narrow ? (
            <div
              className={`sessions-column${narrow && leftDrawerOpen ? ' is-drawer-open' : ''}`}
              style={{ width: leftW }}
            >
              <LeftPanel
                utilityPanel={utilityPanel}
                onSelectUtilityPanel={selectUtilityPanel}
                onCloseUtilityPanel={closeUtilityPanel}
                onEnsureWorkspaceVisible={ensureWorkspaceVisible}
                onOpenSettings={openSettings}
                onSessionCreated={narrow ? closeLeftDrawer : undefined}
                guideNewSession={setupStep === 'session'}
                transitioning={!!wsTransit}
                wsSlotRef={setWsSlotEl}
              />
            </div>
          ) : null}
          {/* 左栏宽度手柄：拖动占中栏宽度，页总宽不变（由虚拟屏调节栏控制）；
              会话栏折叠时不占布局，手柄无意义一并隐藏 */}
          {sessionsInFlow && (
            <div
              className={`left-col-resizer resize-divider${leftResizing ? ' is-resizing' : ''}`}
              style={{ left: leftW }}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('调节左栏宽度')}
              onPointerDown={onLeftResizeDown}
              onPointerMove={onLeftResizeMove}
              onPointerUp={onLeftResizeUp}
              onPointerCancel={onLeftResizeUp}
              onLostPointerCapture={onLeftResizeUp}
            />
          )}
          <div className="terminal-page" style={{ width: terminalInnerW }}>
            <ErrorTip message={splitPrefsError?.workspaceId === activeWorkspaceId ? splitPrefsError.message : null} />
            <ExtensionHomePeekContext.Provider value={hVs && hDock === 'git' && !focusMode && !narrow}>
            <CenterPanel
              onSelectUtilityPanel={selectUtilityPanel}
              utilityPanel={utilityPanel}
              onCloseUtilityPanel={closeUtilityPanel}
              onOpenSettings={openSettings}
              settingsPrepared={settingsPrepared}
              retainedFiles={backgroundCenterViews.flatMap(item => item.file ? [{ workspaceId: item.workspaceId, tabId: item.file.tabId,
                label: centerFileLabel(item.file), centerOnly: item.file.centerOnly }] : [])}
              backgroundViews={[...(settingsBackgroundWorkspace && settingsBackgroundWorkspace === activeWorkspaceId && settingsPrepared && !settingsDocked && !settingsPresence.mounted ? [{
                id: 'settings', label: t('设置'), target: { kind: 'utility' as const, sel: 'settings' },
                onSelect: () => { setGlobalBoardOpen(false); selectUtilityPanel('settings'); },
                onClose: () => {
                  const current = settingsControlRef.current;
                  const deps = splitDepsRef.current;
                  const primary = resolveActualCenterSelection(deps.utilityPanel, deps.displayActiveId, deps);
                  const state = getCenterSplitState();
                  let rightSettingsExists = true;
                  try { rightSettingsExists = readRightPanelState(settingsBackgroundWorkspace).tabs.some(tab => tab.content.kind === 'utility' && tab.content.sel === 'settings'); }
                  catch { /* A missing bridge cannot prove that the view is safe to close. */ }
                  if (deps.activeWorkspaceId !== settingsBackgroundWorkspace || panelSnapshotRef.current.switching || panelSnapshotRef.current.wsTransit ||
                      current.settingsDirty || current.settingsModal || current.settingsDocked || rightSettingsExists || state.pendingLayout ||
                      settingsOpeningRef.current.size || settingsClosingRef.current ||
                      getCenterSplitPaneRefs(primary, state).some(ref => ref.kind === 'utility' && ref.sel === 'settings')) {
                    flashTip(t('设置正在使用或有未保存的更改')); return;
                  }
                  setSettingsBackgroundWorkspace(null); setSettingsPrepared(false);
                }
              }] : []), ...backgroundCenterViews.filter(item => item.workspaceId === activeWorkspaceId && item.background !== false && backgroundViewAvailable(item, sessionStore.sessions, navigation)).map(item => ({
                id: item.id, label: item.file ? centerFileLabel(item.file) : item.target.kind === 'utility' ? item.target.sel.startsWith('nav:') ?
                  navigation.nodes.find(node => node.id === (item.target.kind === 'utility' ? item.target.sel.slice(4) : ''))?.title ?? '' : t(RIGHT_UTILITY_TITLES[item.target.sel as keyof typeof RIGHT_UTILITY_TITLES]) :
                  sessionStore.sessions.find(session => session.id === (item.target.kind === 'session' ? item.target.sessionId : ''))?.name ?? '', target: item.target,
                onSelect: () => {
                  if (splitDepsRef.current.activeWorkspaceId !== item.workspaceId || panelSnapshotRef.current.switching || panelSnapshotRef.current.wsTransit) return;
                  if (!backgroundViewAvailable(item, splitDepsRef.current.sessions, splitDepsRef.current.navigationIdentity)) { flashTip(t('视图已变化，请重新打开')); return; }
                  if (item.file?.pinned) { flashTip(t('请先将内容移回中栏')); return; }
                  const dockKey = rightDockKey(item.target);
                  const node = item.target.kind === 'utility' && item.target.sel.startsWith('nav:') ? splitDepsRef.current.navigationIdentity.nodes.find(node => node.id === (item.target.kind === 'utility' ? item.target.sel.slice(4) : '')) : undefined;
                  if ((dockKey && rightDockSnapshot().docked.has(dockKey)) || (node && (node.placement === 'tab' || node.placement === 'window'))) { flashTip(t('请先将内容移回中栏')); return; }
                  setGlobalBoardOpen(false);
                  if (item.target.kind === 'utility') selectUtilityPanel(item.target.sel as UtilitySelection);
                  else if (!centerSplitTryFill(item.target)) void showInCenter(item.target).catch(error => flashTip(String(error)));
                },
                onClose: () => {
                  if (splitDepsRef.current.activeWorkspaceId !== item.workspaceId || panelSnapshotRef.current.switching || panelSnapshotRef.current.wsTransit) return;
                  try { closeBackgroundView(item); } catch (error) { flashTip(error instanceof Error ? error.message : String(error)); }
                }
              }))]}
              onSettingsHost={setSettingsHost}
              onSettingsVisibilityChange={setSettingsVisible}
            />
            </ExtensionHomePeekContext.Provider>
          </div>
        </div>
        <div
          className={`h-page git-page${narrow && rightDrawerOpen ? ' is-drawer-open' : ''}`}
          data-h-page="git"
          data-h-peek={hasPeekPage && hDock === 'terminal' ? '' : undefined}
          data-setup-target={activeSetup && virtualScreenOpen && hDock === 'terminal' ? 'virtual-screen' : undefined}
          tabIndex={activeSetup && virtualScreenOpen && hDock === 'terminal' ? 0 : undefined}
          aria-label={activeSetup && virtualScreenOpen && hDock === 'terminal' ? t('切到工具页') : undefined}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || event.currentTarget.tabIndex !== 0 || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            showGit();
          }}
          style={{ width: Math.max(gitPageW, hVs ? 1 : 0) }}
        >
          <SideToolsPanel
            /** 专注模式右区恒激活：否则露条指针管道吞掉浏览器点击、Git 页自动刷新与
             *  侧工具快捷键全部失效（专注下 hDock 恒为 terminal，必须显式并入） */
            active={(narrow ? rightDrawerOpen : focusMode || (hVs && hDock === 'git')) && !switching && !wsTransit}
            /** 第二页 DOM 可见性（不含聚焦）：VS 分屏聚焦终端侧时浏览器页仍显示网页 */
            pageVisible={!wsTransit && (narrow ? rightDrawerOpen : hVs || focusMode)}
            transitioning={!!wsTransit}
            gitEverActive={gitEverActive}
          />
        </div>
        {/* 快照+指示卡只服务普通 VS 态（专注恒 hVs=false，卡内无专注分支——2026-10-10 定稿）；
            「关闭虚拟屏」（双栏全屏）态拖动=最普通的窗口 resize：无遮罩、无卡片，
            两侧直接活重排 */}
        {hResizeAxis === 'size' && hVs && (
          <div
            className="ws-resize-ind-pos"
            style={
              hDock === 'git'
                ? { left: workspacePageW, width: gitPageW }
                : { left: 0, width: workspacePageW }
            }
          >
            <div className="ws-resize-card" style={{ width: sizeCardW, height: sizeCardH }}>
              <div className="ws-resize-card-bar" aria-hidden />
              <div className="ws-resize-card-mid">
                <div className="ws-resize-card-label">
                  {/* 指示卡标注被调侧：页缝左右各是完整工作面，按方位称呼不再绑内容形态 */}
                  {hDock !== 'git' ? t('左侧区域') : t('右侧区域')}
                </div>
                <div className="ws-resize-card-num">
                  {Math.round((hDock === 'git' ? gitRatio : termRatio) * 100)}
                  %
                </div>
              </div>
              <div className="ws-resize-card-bar" aria-hidden />
            </div>
          </div>
        )}
        {hSplitBar}
        {/* 调度面板挂在虚拟屏胶片层内，随当前页平移；Git/文件页激活时仅保留面板本体。 */}
        <AgentFloat
          wsStackSlot={narrow ? null : wsSlotEl}
          stackInline={narrow}
          requireWorkspace={isWebGateway()}
          guideNewWorkspace={setupStep === 'workspace'}
          backdropBlur={sidebarVisible && !agentOnGitPage}
          onOverviewOpenChange={setSchedulerOverviewOpen}
        />
      </div>
    </div>
  );

  const railClass = [
    'ws-rail',
    wsTransit
      ? [
          'is-transit',
          wsTransit.dir === 1 ? 'dir-from-above' : 'dir-from-below',
          `phase-${wsTransit.phase}`
        ].join(' ')
      : 'ws-rail-idle'
  ].join(' ');

  return (
    <WorkspaceTransitContext.Provider value={transitSwitch}>
    <div className="app-shell" ref={setAppShell}>
      <LeftNavigationRecorder {...leftNavigationOptions} navigationRef={leftNavigationRef}/>
      <div ref={keySinkRef} className="app-key-sink" tabIndex={-1} aria-hidden="true" />
      <ChromeBar
        onOpenSettings={setupStep === 'theme' ? (tab, item) => {
          if (!tab) openSetupSettings('theme');
          else openSettings(tab, item);
        } : openSettings}
        onResumeSetup={setup?.paused ? setup.onResume : undefined}
        globalBoardOpen={globalBoardOpen}
        onToggleGlobalBoard={toggleGlobalBoard}
        processMonitorOpen={processMonitorOpen}
        onToggleProcessMonitor={toggleProcessMonitor}
        onToggleLeftDrawer={toggleLeftDrawer}
        onToggleRightDrawer={toggleRightDrawer}
        sessionsOpen={sessionsOpen}
        onToggleSessions={toggleSessions}
        rightPanelOpen={rightPanelOpen}
        onToggleRightPanel={toggleRightPanel}
        onBackPanelHistory={backPanelHistory}
        onForwardPanelHistory={forwardPanelHistory}
      />

      {/* 窄屏抽屉遮罩：常挂，is-shown 切 opacity（responsive.css）；点击任意抽屉收起 */}
      <div
        className={`drawer-scrim${narrow && (leftDrawerOpen || rightDrawerOpen) ? ' is-shown' : ''}`}
        onClick={() => {
          setLeftDrawerOpen(false);
          setRightDrawerOpen(false);
        }}
        aria-hidden="true"
      />

      <MainViewShell
        viewRef={viewRef}
        schedulerOverviewOpen={schedulerOverviewOpen}
        className={[
          'main-view',
          hVs ? 'h-vs-on' : 'h-vs-off',
          `h-${hDock}`,
          focusLayout ? 'is-focus' : '',
          sidebarVisible ? '' : 'sessions-hidden',
          sessionsPeekOpen ? 'sessions-peek' : '',
          hResizing ? 'is-reshaping' : '',
          leftResizing ? 'is-left-resizing' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        styleVars={
          {
            ['--sessions-col-w' as string]: `${leftW}px`,
            ['--agent-float-inset' as string]: '12px'
          } as React.CSSProperties
        }
      >
        {/*
          开/关虚拟屏共用同一套 DOM，禁止切 static-layout 导致 CenterPanel/
          xterm WebGL 整树卸载重建。会话列挂在工作页内，与终端同滑。
          工作区切换：胶片先滑到固定骨架，切区后再滑回实况（不截屏）。
          （agent-expanded/agent-collapsed 类由 MainViewShell 自己消费 chat store 补上。）
        */}
        <div className={`ws-stage${wsTransit ? ' is-sliding' : ''}`}>
          <div className={railClass}>
            <div className="ws-pane ws-pane-skel" aria-hidden={!wsTransit}>
              {wsTransit ? (
                <WorkspaceSkeleton
                  leftW={wsTransit.leftW}
                  virtualScreen={wsTransit.virtualScreen}
                  hDock={wsTransit.hDock}
                  termRatio={wsTransit.termRatio}
                  gitRatio={wsTransit.gitRatio}
                  frameColor={wsTransit.frameColor}
                  canvasColor={wsTransit.canvasColor}
                />
              ) : null}
            </div>
            <div className="ws-pane ws-pane-live">{workArea}</div>
          </div>
        </div>

        {/* 折叠态左栏：挂 MainViewShell 根，在 .ws-stage 下方常驻；唤出时工作面
            整体右移，保留内部虚拟屏与工作区胶片结构。与工作页内文档流列二选一。
            点击会话/功能行（行内操作按钮与
            重命名输入除外）选完即走；移出面板延迟收回 */}
        {sessionsHidden && (
          <SessionsFloatSurface
            ref={sessionsFloatRef}
            open={sessionsPeekOpen}
            hidden={!!wsTransit}
            style={{ width: leftW }}
            onClickCapture={(e) => {
              const target = e.target instanceof Element ? e.target : null;
              if (target?.closest('.session-item') && !target.closest('button, input')) {
                closeSessionsPeek();
              }
            }}
          >
            <LeftPanel
              utilityPanel={utilityPanel}
              onSelectUtilityPanel={selectUtilityPanel}
              onCloseUtilityPanel={closeUtilityPanel}
              onEnsureWorkspaceVisible={ensureWorkspaceVisible}
              onOpenSettings={openSettings}
              guideNewSession={setupStep === 'session'}
              transitioning={!!wsTransit}
              wsSlotRef={setWsSlotEl}
            />
          </SessionsFloatSurface>
        )}

        {/* 左缘热区：面板在场时停用（收回后武装复位，指针仍压在热区上不会立即重开） */}
        <SessionsHotZone
          active={sessionsHidden && !sessionsPeekOpen && !wsTransit}
          onSummon={openSessionsPeek}
        />
      </MainViewShell>

      {/* 全局看板浮层：App 根层级（避开 .h-strip 的 transform 劫持 fixed 坐标系）。
          「需要你」新边沿时面板自己从顶缘探出一条浮动，悬停驻留经 onOpen 展开 */}
      <GlobalBoard
        open={globalBoardOpen}
        onClose={() => setGlobalBoardOpen(false)}
        onOpen={() => setGlobalBoardOpen(true)}
        onOpenWorkerSettings={() => openSettings('worker')}
      />
      <ProcessMonitorPanel open={processMonitorOpen} onClose={() => setProcessMonitorOpen(false)} />

      {shownPalette ? (
        <QuickOpen
          key={shownPalette.nonce}
          workspaceId={resolveWorkspaceId(activeWorkspaceId, workspaces)}
          mode={shownPalette.mode}
          seq={shownPalette.seq}
          stage={palettePresence.stage}
          onRequestMode={openCommandPalette}
          onOpenSettings={openSettings}
          onClose={closeCommandPalette}
        />
      ) : null}

      {settingsPresence.mounted || settingsPrepared ? (
        <SettingsSurfacePortal target={settingsPresence.mounted ? appShell : settingsHost}
          onAttached={host => { if (settingsPresence.mounted) host.querySelector<HTMLElement>('.settings-page')?.focus(); }}>
        <React.Suspense fallback={null}>
          <SettingsModal
            initialTab={settingsTab}
            focusItem={settingsFocus}
            stage={settingsPresence.mounted ? settingsPresence.stage : 'in'}
            presentation={settingsPresence.mounted ? 'modal' : 'embedded'}
            active={settingsPresence.mounted || settingsVisible || settingsRightShown}
            setupGuide={settingsPresence.mounted ? setupSettings ?? undefined : undefined}
            modalShell={settingsPresence.mounted ? appShell : undefined}
            onReady={setSettingsReady}
            onDirtyChange={setSettingsDirty}
            onClose={() => {
              if (settingsPresence.mounted) {
                setSettingsOpen(false);
                setSettingsFocus(undefined);
              } else {
                if (settingsDocked && activeWorkspaceId) requestRightPin({ workspaceId: activeWorkspaceId, ref: { kind: 'utility', sel: 'settings' }, command: 'unpin' });
                closeUtilityPanel();
              }
            }}
          />
        </React.Suspense>
        </SettingsSurfacePortal>
      ) : null}
      {!settingsCoverGuide && activeSetup && (setupStep === 'tools' || setupStep === 'model') && <React.Suspense fallback={null}>
        <FirstRun step={setupStep} modelReady={activeSetup.configuredModel} notice={activeSetup.notice}
          onAdvanceTools={skipped => activeSetup.move('model', { step: 'tools', skipped })}
          onBack={() => activeSetup.move('tools')}
          onSkipModel={() => activeSetup.move('workspace', { step: 'model', skipped: !activeSetup.configuredModel })}
          onOpenModelSettings={() => openSetupSettings('model')} onDismiss={activeSetup.onPause} />
      </React.Suspense>}
      {!settingsCoverGuide && activeSetup && guideStep && (!globalBoardOpen || guideStep === 'board') && <WorkbenchSetupGuide key={guideStep} setup={activeSetup} step={guideStep}
        narrow={narrow} sidebarHidden={guideSidebarHidden} onGitPage={agentOnGitPage}
        virtualScreenOpen={virtualScreenOpen} rightPanelOpen={rightPanelOpen}
        boardOpen={globalBoardOpen} onCloseBoard={() => setGlobalBoardOpen(false)} />}
      <SetupCompletion setup={!settingsCoverGuide && setupStep === 'finish' ? activeSetup : undefined}
        onOpenSettings={(tab, item) => tab === 'agent' ? openSetupSettings('model') : openSettings(tab, item)}
        onReleased={focusCompletedSetup} onFinish={() => {
          ensureWorkspaceVisible();
          setLeftDrawerOpen(false);
          setRightDrawerOpen(false);
          focusAfterSetup.current = true;
          activeSetup?.move('done');
        }} />
      <ConfirmDialog request={confirms[0] ?? null} />
      <ExtensionUiDialogLazy request={dialogs[0] ?? null} onRespond={respondDialog} />
      {/* 全局划词菜单唯一宿主（浮条 + 爆炸浮层，portal 渲染） */}
      <SelectionMenuHost />
      {/* 会话证据页唯一宿主（左栏/看板右键「查看证据」，portal 弹窗） */}
      <EvidencePanel />
      {/* 全局 Tooltip 宿主：接管原生 title 提示（portal 渲染） */}
      <TooltipHost />
      {/* 文本工具结果卡：独立宿主挂载（浮条收起后卡片要留着展示进行中/结果） */}
      <TextToolResultCard />
      {/* 文件批注录入框：独立宿主挂载（浮条收起后录入框要贴原位留存，Enter/点外收场） */}
      <FileNoteEntryHost />
      {/* 网页批注二次编辑卡：输入框胶囊点击弹出（元素截图+改/删） */}
      <WebNoteEntryHost />

      {/* 确认请求边沿自动开调度面板（空渲染，仅副作用） */}
      <ChatAutoOpener />
      <AgentPanelFlag onOpenChange={setAgentPanelOpen} />
      <CliRunNavigation />
    </div>
    </WorkspaceTransitContext.Provider>
  );
}
