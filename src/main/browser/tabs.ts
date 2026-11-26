import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/**
 * 内置浏览器：原生 webview 持有真实页面，切换标签保留同一个 guest。
 * Agent 只执行定向 DOM 动作，按页 FIFO，不依赖或更改宿主输入焦点。
 * 页面共享 persist:browser 登录态；导航、恢复、下载、弹窗与录屏由本服务管理。
 */
import { app, dialog, ipcMain, nativeImage, session, webContents } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config';
import { t } from '../../shared/i18n';
import { PRODUCT_EXECUTABLE_NAME } from '../../shared/productIdentity';
import { buildBrowserPickerScript, type BrowserPickerAppearance } from '../../shared/browserPicker';
import { DEFAULT_RESOLVED_DARK } from '../../shared/resolvedAppearance';
import { MUSTER_EXPORT_SCHEME } from '../../shared/protocolSchemes';
import { MUSTER_EXT_SCHEME, parseExternalFileUrl } from '../../shared/filePreview';
import { getUiWidgetStore } from '../uiWidgetStore';
import { uiWidgetIdentity } from '../../shared/uiWidgetProtocol';
import { uiSessionPageId, uiSessionPageUrl } from '../../shared/uiSessionPage';
import { browserHomeUrl, isBrowserHomeUrl } from '../../shared/browserHome';
import { handleExternalFileRequest } from '../workspaceFsProtocol';
import { BrowserGuestRegistry } from './guestRegistry';
import { BrowserPageOperationQueue } from './pageOperationQueue';
import { routeWindowOpen } from './popupPolicy';
import { getBrowserCdpBootState } from './cdpBoot';
import { CdpEndpointUnavailableError, readDevToolsActivePort, waitForOwnedCdpEndpoint } from './cdpEndpoint';
import { nextCrashRecovery, type CrashState } from './crashPolicy';
import { BrowserRecordingService } from './browserRecording';
import { BrowserDownloadStore } from './downloadStore';
import { browserPanelReplaySrcPrefix, type BrowserFocusAck, type BrowserPanelReplayRequest, type BrowserTabInfo, type BrowserTabsPayload, type BrowserWheelPayload } from '../../shared/browser';
import type { DesktopTargetIdentity } from '../desktop/grants';

const PARTITION = 'persist:browser';
const SEARCH_URL = 'https://www.bing.com/search?q=';
/** 标签恢复上限：防异常膨胀拖慢启动 */
const RESTORE_MAX_TABS = 20;
/** 持久化 debounce：标题/URL 高频变化不合着 config.save 打盘 */
const PERSIST_DEBOUNCE_MS = 800;
/** 懒挂载等待：渲染层收到 mount-request 后创建 webview → did-attach 上报的预算 */
const MOUNT_WAIT_MS = 8_000;
const MOUNT_RETRY_MS = 500;
/** 主文档导航超时上限：防止不可达站点（黑洞/挂起连接）永久停留在无终态 loading */
const NAVIGATION_TIMEOUT_MS = 25_000;
/** Checkpoints can arrive before the renderer publishes the keys it retained. */
const RECENT_PANEL_HISTORY = 96;
/** 用户手势对 new-popup 放行的有效窗口：点击到 window.open 之间通常 <100ms，留足余量 */
const USER_GESTURE_POPUP_WINDOW_MS = 5_000;

/**
 * 元素拾取器（DevTools 式）：注入激活标签，悬停高亮 + tooltip 显示选择器；
 * 点击（capture 拦截防副作用）回传元素信息，Esc/取消回传 null。
 * 返回挂起 Promise 由 executeJavaScript await——页面导航销毁时自然 reject。
 */


interface NativeHistoryPosition {
  entries: Electron.NavigationEntry[];
  index: number;
  /** Identity of each entry while it is still reachable in the native stack. */
  positions: string[];
}

interface PanelHistoryPoint extends NativeHistoryPosition {
  key: string;
  url: string;
  workspaceId?: string;
  sessionId?: string;
  scope?: 'workspace' | 'session';
}

interface Tab {
  id: string;
  workspaceId?: string;
  sessionId?: string;
  scope?: 'workspace' | 'session';
  openerId?: string;
  openInBackground?: boolean;
  panelPoint?: PanelHistoryPoint;
  panelNativeHistory?: NativeHistoryPosition & { webContentsId: number };
  panelHistoryUserNavigation?: boolean;
  panelUserOpen?: boolean;
  panelReplayRequest?: string;
  replayingPanel?: boolean;
  operationRevision?: number;
  title: string;
  url: string;
  favicon: string | null;
  loading: boolean;
  navigationRevision: number;
  navigationPending: boolean;
  mediationDocument: string;
  mediationNavigating: boolean;
  /** 崩溃恢复状态；dom-ready/换代保留计数，稳定窗口或显式导航/重试清零 */
  crash: CrashState | null;
  /** 自动恢复定时器：归属当前 tab+generation，关闭/换代/退出必须取消 */
  crashRetryTimer: NodeJS.Timeout | null;
  /** Agent 视口 override（browser.setViewport 设置；只由本工具设置/清除，随 tab 消亡） */
  viewportOverride: ViewportSize | null;
  /** 最近一次主文档导航失败原因（did-fail-load / loadURL 抛错 / 导航超时）；成功导航时清零 */
  lastLoadError?: { url: string; code?: number; description: string } | null;
  loadFlight?: {
    revision: number; webContentsId: number; url: string; promise: Promise<void>;
    ready: Promise<void>; resolveReady: () => void; rejectReady: (error: Error) => void;
    started: boolean; committedUrl: string | null; documentRequestId?: string;
    documentUrls: Set<string>; failedError?: Error | null; timer?: NodeJS.Timeout;
  };
}

/** 每标签 console 捕获（browser.console） */
export interface ConsoleEntry {
  ts: number;
  level: 'verbose' | 'info' | 'warning' | 'error';
  text: string;
}

/** 每标签网络捕获（browser.network；body 经 wc.debugger Network.getResponseBody 惰性取） */
export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  type: string;
  status?: number;
  mime?: string;
  error?: string;
  ts: number;
}

/** 下载捕获（browser.downloads；session 级 will-download，按来源 webContents 归属标签） */
export interface DownloadEntry {
  id: string;
  tabId: string | null;
  url: string;
  filename: string;
  path: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  mime: string;
  startedAt: number;
  endedAt?: number;
}

type JsDialogType = 'alert' | 'confirm' | 'prompt';

interface PendingJsDialog {
  id: string;
  tabId: string;
  type: JsDialogType;
  message: string;
  defaultValue: string;
  transport: 'preload' | 'native';
  reply: (accepted: boolean, value: string | null) => void | Promise<void>;
  timer: NodeJS.Timeout;
}

export type DialogPolicy = 'manual' | 'auto-accept' | 'auto-dismiss';

/** Install the dialog functions before page scripts can call or save the originals. */
const VIEW_ACTIVATION_FALLBACK = '请点击或用键盘触发此操作';
const VIEW_PRELOAD_SRC = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__maDialogSync', (type, message, defaultValue) =>
  ipcRenderer.sendSync('browser:js-dialog', { type, message, defaultValue }));
contextBridge.executeInMainWorld({
  func: () => {
    const send = window.__maDialogSync;
    const ask = (type, message, defaultValue) =>
      send(type, message === undefined ? '' : String(message), defaultValue === undefined ? '' : String(defaultValue));
    window.alert = function alert(message) { ask('alert', message); };
    window.confirm = function confirm(message) { return ask('confirm', message)?.accepted === true; };
    window.prompt = function prompt(message, defaultValue) {
      const result = ask('prompt', message, defaultValue);
      return result?.accepted ? result.value : null;
    };
  }
});
if (location.protocol === ${JSON.stringify(`${MUSTER_EXT_SCHEME}:`)}) {
  var lastAppearance = null;
  ipcRenderer.on('uiWidget:appearance', (_event, appearance) => { lastAppearance = appearance; });
  contextBridge.exposeInMainWorld('__maUiHost', {
    read: () => ipcRenderer.invoke('uiWidget:guest-read'),
    save: (patch) => ipcRenderer.invoke('uiWidget:guest-save', patch),
    receipt: (receipt) => ipcRenderer.invoke('uiWidget:guest-receipt', receipt),
    action: (action, state) => {
      if (!navigator.userActivation.isActive) return Promise.reject(new Error(
        lastAppearance && typeof lastAppearance.activationError === 'string' && lastAppearance.activationError || ${JSON.stringify(VIEW_ACTIVATION_FALLBACK)}
      ));
      return ipcRenderer.invoke('uiWidget:guest-action', action, state);
    },
    onState: (callback) => { var listener = (_event, snapshot) => callback(snapshot.state); ipcRenderer.on('uiWidget:changed', listener); return () => ipcRenderer.removeListener('uiWidget:changed', listener); },
    onAppearance: (callback) => {
      var listener = (_event, appearance) => callback(appearance); ipcRenderer.on('uiWidget:appearance', listener);
      if (lastAppearance) callback(lastAppearance);
      return () => ipcRenderer.removeListener('uiWidget:appearance', listener);
    }
  });
}`;

/** 弹窗没人处理时的兜底：页面不能永远冻着 */
const DIALOG_TIMEOUT_MS = 120_000;

/** 环形缓冲：超容量丢最旧 */
class Ring<T> {
  constructor(private cap: number, public items: T[] = []) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
}

/** console-message 的 level → 语义档：Electron 43 事件对象上是字符串
 *  （'info'|'warning'|'error'|'debug'），旧版位置参数是 0-3 数字，两者都收 */
function consoleLevel(l: string | number | undefined): ConsoleEntry['level'] {
  if (typeof l === 'string') {
    if (l === 'error') return 'error';
    if (l === 'warning') return 'warning';
    if (l === 'info') return 'info';
    return 'verbose';
  }
  const n = Number(l) || 0;
  if (n >= 3) return 'error';
  if (n === 2) return 'warning';
  if (n === 1) return 'info';
  return 'verbose';
}

let sharedBrowserSession: Electron.Session | null = null;

/** 全局共享 session（登录态跨工作区/站点共用；UA 保留真实内核版本并移除产品名） */
export function browserSession(): Electron.Session {
  if (!sharedBrowserSession) {
    const ses = session.fromPartition(PARTITION);
    // 身份名是纯 ASCII `Muster Console`（UA 里为 `MusterConsole/…`）；中文展示名「集序」只走
    // 界面词条。两种令牌都剔，网页区不该拿到任何工作台产品名。
    const productTokens = new Set([
      `${app.getName().replace(/\s/g, '')}/`,
      `${PRODUCT_EXECUTABLE_NAME}/`
    ]);
    const ua = session.defaultSession
      .getUserAgent()
      .split(' ')
      .filter((tok) => tok.startsWith('Electron/') || ![...productTokens].some((token) => tok.startsWith(token)))
      .join(' ');
    ses.setUserAgent(ua);
    // 智能界面部件（muster-ext）会作为 browser tab 导航目标：自定义协议 handler 只
    // 挂在 default session，persist:browser partition 须补同一 handler，否则网页区加载
    // 产物直接失败（评审 P1-4）。scheme 特权由 registerSchemesAsPrivileged 全局生效。
    try {
      ses.protocol.handle(MUSTER_EXT_SCHEME, (request: Request) => handleExternalFileRequest(request.url, request));
    } catch (err) {
      // 会话复用时 handler 已注册属预期；其余注册失败仅告警——网页区打开部件会失败但应用可用
      console.warn('[browser-tabs] muster-ext handler 注册失败（若非重复注册请排查）:', err);
    }
    sharedBrowserSession = ses;
  }
  return sharedBrowserSession;
}

/** 地址栏输入归一化：带 scheme 原样；含空格或无点号当搜索词；其余补 https:// */
export function normalizeUrlInput(input: string): string {
  const s = input.trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/\s/.test(s) || !s.includes('.')) return SEARCH_URL + encodeURIComponent(s);
  return `https://${s}`;
}

// ── Agent 视口（browser.setViewport / resetViewport，任务 C） ──

/** 视口 clamp 区间（CSS 像素）：320×320 起步（覆盖主流手机竖屏）到 3840×2160（4K 桌面） */
export const VIEWPORT_MIN_WIDTH = 320;
export const VIEWPORT_MAX_WIDTH = 3840;
export const VIEWPORT_MIN_HEIGHT = 320;
export const VIEWPORT_MAX_HEIGHT = 2160;

/** Agent 视口尺寸（CSS 像素） */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * 视口尺寸 clamp（纯逻辑，test/browser-viewport-policy.mjs 直测）：width/height
 * 非有限数值（NaN/Infinity/非数字）直接抛错不静默；越界值收敛到区间；小数取整。
 */
export function clampViewportSize(width: number, height: number): ViewportSize {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(t('非法视口尺寸：width/height 必须是有限数字'));
  }
  return {
    width: Math.round(Math.min(VIEWPORT_MAX_WIDTH, Math.max(VIEWPORT_MIN_WIDTH, width))),
    height: Math.round(Math.min(VIEWPORT_MAX_HEIGHT, Math.max(VIEWPORT_MIN_HEIGHT, height)))
  };
}

function navigationUrlKey(url: string): string {
  try { return new URL(url).href; } catch { return url; }
}

export class BrowserTabService {
  private readonly mediationInstance = randomUUID();
  private tabs = new Map<string, Tab>();
  private panelHistory = new Map<string, PanelHistoryPoint>();
  private retainedPanelHistory = new Set<string>();
  private panelRestoreHosts = new WeakSet<WebContents>();
  private order: string[] = [];
  private activeId: string | null = null;
  /** 激活标签轨迹（统一后退链）：‹ 先走网页后退，无网页历史时沿轨迹退回上一个激活标签 */
  private trail: string[] = [];
  private trailIdx = -1;
  private seq = 0;
  private restored = false;
  /** guest 注册表：tab 壳 ↔ webview guest webContents（渲染层 did-attach 上报） */
  private guests = new BrowserGuestRegistry();
  private operationQueue = new BrowserPageOperationQueue();
  private inputScopes = new Map<string, { source: 'agent' | 'user' }>();
  private inputPreparations = new Map<number, Promise<void>>();
  private humanInputIntents = new Map<string, { webContentsId: number; generation: number;
    navigationRevision: number; expiresAt: number }>();
  private fileChooserNotices = new Set<string>();
  private lastInputSources = new Map<string, 'agent' | 'user'>();
  /** 最近一次真实用户手势时间（前台可见 + 焦点 + 非 Agent 操作期间；new-popup 原生弹窗放行门控用） */
  private userGestures = new Map<string, number>();
  /** 懒挂载等待 flight：同一 tab 并发 ensureGuest 共享一次请求 */
  private mountFlights = new Map<string, Promise<WebContents | null>>();
  /** 每标签 console/网络捕获（agent browser.console/browser.network 的数据源） */
  private consoleBufs = new Map<string, Ring<ConsoleEntry>>();
  private netBufs = new Map<string, Ring<NetworkEntry>>();
  /** 下载记录（session 级，含标签归属） */
  private downloads: Ring<DownloadEntry> = new Ring(100);
  private downloadStore: BrowserDownloadStore;
  private downloadsDir = '';
  /** JS 弹窗队列（每标签）+ 策略：preload 桥 sendSync 阻塞页面，agent 经 browser.dialog 处理 */
  private dialogQueue = new Map<string, PendingJsDialog[]>();
  private dialogWaiters = new Map<string, Set<() => void>>();
  private dialogPolicies = new Map<string, DialogPolicy>();
  private dialogSeq = 0;
  private viewPreloadUrl = '';
  private persistTimer: NodeJS.Timeout | null = null;
  private cdpPortFlight: Promise<number> | null = null;
  /** 录屏服务（任务 E）：CDP screencast 采集 + renderer VP8 编码 + webmMuxer 合成 */
  private recordingSvc: BrowserRecordingService;

  constructor(
    private getWindow: () => BrowserWindow | null,
    private config: ConfigManager
  ) {
    this.downloadsDir = userDataStorage(app.getPath('userData')).resolve('app', 'browser-downloads');
    this.downloadStore = new BrowserDownloadStore(app.getPath('userData'));
    this.recordingSvc = new BrowserRecordingService(
      (tabId) => this.liveGuest(tabId),
      getWindow,
      userDataStorage(app.getPath('userData')).resolve('app', 'browser-captures'),
      (tabId, busy) => this.setAgentBusy(tabId, busy),
      async tabId => {
        const host = this.getWindow(), guest = this.guestRecord(tabId);
        if (!host || host.isDestroyed() || !host.isVisible() || !guest) return false;
        // Read the trusted host's actual presentation, not visibilityState in
        // a guest where Emulation.setFocusEmulationEnabled can force "visible".
        return host.webContents.executeJavaScript(`(() => {
          const view = Array.from(document.querySelectorAll('webview')).find(el => el.dataset.tabId === ${JSON.stringify(tabId)});
          return !!view && view.dataset.browserPresentation === 'foreground' && getComputedStyle(view).visibility === 'visible'
            && view.getWebContentsId() === ${guest.webContentsId};
        })()`, false);
      }
    );
    this.wireDownloads();
    this.wireJsDialogs();
    this.guests.setWindow(null);
  }

  /** 录屏服务（agentTools 的 browser.recording 工具面消费） */
  recording(): BrowserRecordingService {
    return this.recordingSvc;
  }

  isHostContents(id: number): boolean { return this.getWindow()?.webContents.id === id; }

  /** One mutation lane per real page, independent of whichever tab the user views. */
  runOperation<T>(tabId: string, operation: () => Promise<T> | T, source: 'agent' | 'user' = 'agent'): Promise<T> {
    const tab = this.tabs.get(tabId), revision = tab?.operationRevision ?? 0;
    return this.operationQueue.run(tabId, async () => {
      const scope = { source };
      this.inputScopes.set(tabId, scope);
      this.lastInputSources.set(tabId, source);
      if (source === 'agent') this.humanInputIntents.delete(tabId);
      try {
        return await operation();
      } finally {
        if (this.inputScopes.get(tabId) === scope) this.inputScopes.delete(tabId);
      }
    }, { assertCurrent: () => {
      if (!tab || this.tabs.get(tabId) !== tab || (tab.operationRevision ?? 0) !== revision) {
        throw new Error(t('浏览器页面已关闭或换代，排队操作已取消'));
      }
    } });
  }

  private invalidateOperations(tabId: string, reason: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.operationRevision = (tab.operationRevision ?? 0) + 1;
    this.inputScopes.delete(tabId);
    this.humanInputIntents.delete(tabId);
    this.lastInputSources.delete(tabId);
    this.userGestures.delete(tabId);
    this.fileChooserNotices.delete(tabId);
    this.cancelDialogs(tabId);
    this.operationQueue.cancelPending(tabId, new Error(reason));
  }

  private guestRecord(tabId: string): { webContentsId: number; generation: number } | null {
    return this.guests.guestOf(tabId);
  }

  private tabForContents(id: number): string | null {
    return this.guests.tabIdOf(id);
  }

  ownerForContents(id: number): { workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session'; openerId: string } | null {
    const openerId = this.tabForContents(id);
    const tab = openerId ? this.tabs.get(openerId) : undefined;
    return tab && openerId ? { workspaceId: tab.workspaceId, sessionId: tab.sessionId, scope: tab.scope, openerId } : null;
  }

  /** Guest-local DOM focus emulation; never show/focus a window or select a tab. */
  async prepareAgentInput(tabId: string): Promise<void> {
    const wc = await this.ensureGuest(tabId);
    if (!wc) throw new Error(t('浏览器页面尚未挂载，请稍后重试'));
    const record = this.guestRecord(tabId);
    if (!record) throw new Error(t('浏览器页面已关闭或换代'));
    const current = () => {
      if (!this.currentGuest(tabId, wc, record.generation)) throw new Error(t('浏览器页面已关闭或换代'));
    };
    if (!wc.debugger.isAttached()) this.inputPreparations.delete(wc.id);
    let flight = this.inputPreparations.get(wc.id);
    if (!flight) {
      flight = (async () => {
        current();
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Page.enable'); current();
        await wc.debugger.sendCommand('Network.enable'); current();
        await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }); current();
        await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); current();
      })();
      this.inputPreparations.set(wc.id, flight);
      void flight.catch(() => { if (this.inputPreparations.get(wc.id) === flight) this.inputPreparations.delete(wc.id); });
    }
    await flight;
    current();
  }

  handlesNativeDialogs(tabId: string, guestId: number): boolean {
    return this.inputPreparations.has(guestId) && this.isCurrentGuest(tabId, guestId);
  }

  /** Consume the next blocked native-picker hint, including delayed page scripts. */
  fileChooserNotice(tabId: string): string | null {
    if (!this.fileChooserNotices.delete(tabId)) return null;
    return t('capability_unsupported: 后台 DOM 操作不支持文件选择；未切换前台，请在原生网页中手动选择文件');
  }

  /** Background tool actions and links never select the user's front page. */
  shouldOpenInBackground(webContentsId: number): boolean {
    const tabId = this.tabForContents(webContentsId);
    return !!tabId && (this.activeId !== tabId || this.lastInputSources.get(tabId) === 'agent');
  }

  private onFileChooser(tabId: string, wc: WebContents, generation: number, params: unknown): void {
    if (!this.currentGuest(tabId, wc, generation)) return;
    const request = params as { backendNodeId?: number; mode?: string };
    const intent = this.humanInputIntents.get(tabId), tab = this.tabs.get(tabId)!;
    const host = this.getWindow();
    const allowed = intent && intent.webContentsId === wc.id && intent.generation === generation &&
      intent.navigationRevision === tab.navigationRevision && intent.expiresAt >= Date.now() &&
      this.inputScopes.get(tabId)?.source !== 'agent' && this.activeId === tabId &&
      host && !host.isDestroyed() && host.isVisible() && host.isFocused();
    this.humanInputIntents.delete(tabId);
    if (!allowed || typeof request?.backendNodeId !== 'number' || !Number.isInteger(request.backendNodeId) || request.backendNodeId <= 0) {
      this.fileChooserNotices.add(tabId); return;
    }
    const revision = tab.navigationRevision, documentUrl = wc.getURL();
    void (async () => {
      const result = await dialog.showOpenDialog(host, {
        properties: request.mode === 'selectMultiple' ? ['openFile', 'multiSelections'] : ['openFile']
      });
      if (result.canceled || !result.filePaths.length) return;
      if (this.tabs.get(tabId) !== tab || tab.navigationRevision !== revision ||
          wc.getURL() !== documentUrl || !this.currentGuest(tabId, wc, generation)) return;
      await wc.debugger.sendCommand('DOM.setFileInputFiles', {
        backendNodeId: request.backendNodeId, files: result.filePaths
      });
    })().catch(error => console.warn('[browser] native file selection failed:', String(error)));
  }

  /** Reload updated authored pages through their mutation lane. */
  refreshArtifact(filePath: string): void {
    for (const [id, tab] of this.tabs) {
      const parsed = parseExternalFileUrl(tab.url);
      if (!parsed || uiWidgetIdentity(parsed.absPath) !== uiWidgetIdentity(filePath)) continue;
      if (!this.liveGuest(id)) continue;
      void this.runOperation(id, () => this.navigate(id, tab.url)).catch(error => {
        console.warn('[browser] updated artifact reload failed:', String(error));
      });
    }
  }

  /** Register the synchronous reply channel before any guest can navigate. */
  private wireJsDialogs(): void {
    try {
      const preloadFile = userDataStorage(app.getPath('userData')).file('browser-preload');
      fs.writeFileSync(preloadFile, VIEW_PRELOAD_SRC, 'utf-8');
      this.viewPreloadUrl = pathToFileURL(preloadFile).href;
    } catch (err) {
      console.warn('[browser] view preload write failed:', (err as Error).message);
    }
    ipcMain.on('browser:js-dialog', (e, payload: { type?: string; message?: string; defaultValue?: string }) => {
      const tabId = this.tabForContents(e.sender.id);
      const type = payload?.type;
      if (!tabId || (type !== 'alert' && type !== 'confirm' && type !== 'prompt')) {
        e.returnValue = { accepted: false, value: null };
        return;
      }
      this.enqueueJsDialog(tabId, type, String(payload.message ?? ''), String(payload.defaultValue ?? ''), 'preload',
        (accepted, value) => { e.returnValue = { accepted, value }; });
    });
  }

  private enqueueJsDialog(
    tabId: string,
    type: JsDialogType,
    message: string,
    defaultValue: string,
    transport: PendingJsDialog['transport'],
    reply: PendingJsDialog['reply']
  ): void {
    const onReplyError = (error: unknown): void => { console.warn('[browser] auto dialog reply failed:', String(error)); };
    const policy = this.dialogPolicies.get(tabId) ?? 'manual';
    if (policy !== 'manual') {
      const accept = policy === 'auto-accept';
      void Promise.resolve().then(() => reply(accept, accept ? defaultValue : null)).catch(onReplyError);
      return;
    }
    const timer = setTimeout(() => {
      void this.settleDialog(entry, false).catch(onReplyError);
    }, DIALOG_TIMEOUT_MS);
    timer.unref?.();
    const entry: PendingJsDialog = {
      id: `dg${++this.dialogSeq}`,
      tabId,
      type,
      message,
      defaultValue,
      transport,
      reply,
      timer
    };
    const queue = this.dialogQueue.get(tabId) ?? [];
    // 队列上限：丢最旧并放行，防连环弹窗把页面冻死
    if (queue.length >= 10) void this.settleDialog(queue[0], false).catch(onReplyError);
    queue.push(entry);
    this.dialogQueue.set(tabId, queue);
    const waiters = this.dialogWaiters.get(tabId);
    if (waiters) {
      for (const notify of [...waiters]) notify();
    }
  }

  /** 监听指定标签在动作期间新入队的 JS 弹窗（一旦触发 sendSync 阻塞，立即唤醒 performAct 返回 pendingDialogs） */
  waitForDialog(tabId: string): { promise: Promise<void>; cancel: () => void } {
    const listeners = this.dialogWaiters.get(tabId) ?? new Set<() => void>();
    let notify!: () => void;
    const promise = new Promise<void>(resolve => { notify = resolve; });
    listeners.add(notify);
    this.dialogWaiters.set(tabId, listeners);
    return { promise, cancel: () => {
      listeners.delete(notify);
      if (!listeners.size) this.dialogWaiters.delete(tabId);
    } };
  }

  private removeDialog(entry: PendingJsDialog): void {
    clearTimeout(entry.timer);
    const queue = this.dialogQueue.get(entry.tabId);
    if (queue) {
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      if (!queue.length) this.dialogQueue.delete(entry.tabId);
    }
  }

  private async settleDialog(entry: PendingJsDialog, accept: boolean, text?: string): Promise<void> {
    this.removeDialog(entry);
    await entry.reply(accept, accept ? (text ?? entry.defaultValue) : null);
  }

  private cancelDialogs(tabId: string): void {
    for (const entry of [...(this.dialogQueue.get(tabId) ?? [])]) {
      void this.settleDialog(entry, false).catch(error => console.warn('[browser] dialog cleanup failed:', String(error)));
    }
  }

  pendingDialogs(tabId: string): Array<{ id: string; type: string; message: string; defaultValue: string }> {
    return (this.dialogQueue.get(tabId) ?? []).map((d) => ({
      id: d.id,
      type: d.type,
      message: d.message,
      defaultValue: d.defaultValue
    }));
  }

  async dialogAnswer(tabId: string, dialogId: string, accept: boolean, text?: string): Promise<boolean> {
    const queue = this.dialogQueue.get(tabId) ?? [];
    const entry = dialogId ? queue.find((d) => d.id === dialogId) : queue[0];
    if (!entry) return false;
    await this.settleDialog(entry, accept, text);
    return true;
  }

  setDialogPolicy(tabId: string, policy: DialogPolicy): void {
    this.dialogPolicies.set(tabId, policy);
  }

  /** 下载捕获：session 级 will-download，自动落盘 downloadsDir（不弹保存框）并记录归属 */
  private wireDownloads(): void {
    browserSession().on('will-download', (_e, item, webContents) => {
      try {
        fs.mkdirSync(this.downloadsDir, { recursive: true });
        const { id: downloadId, file: savePath } = this.downloadStore.begin(item.getFilename());
        try { item.setSavePath(savePath); }
        catch (error) { this.downloadStore.abandon(downloadId); throw error; }
        const tabId = (webContents && this.tabForContents(webContents.id)) || null;
        const entry: DownloadEntry = {
          id: `dl${++this.seq}`,
          tabId,
          url: item.getURL(),
          filename: item.getFilename(),
          path: savePath,
          state: 'progressing',
          mime: item.getMimeType(),
          startedAt: Date.now()
        };
        this.downloads.push(entry);
        item.once('done', (_ev, state) => {
          entry.state = state;
          entry.endedAt = Date.now();
          try { this.downloadStore.finish(downloadId, state); }
          catch (error) { console.error('[browser] download receipt failed:', (error as Error).message); }
        });
      } catch (err) {
        console.error('[browser] will-download handler failed:', (err as Error).message);
      }
    });
  }

  // ── guest 生命周期（渲染层上报） ──

  /** 渲染层 webview did-attach 上报：fail-closed 校验后绑定并接线事件 */
  guestAttach(tabId: string, webContentsId: number): { ok: boolean; reason?: string } {
    if (uiSessionPageId(this.tabs.get(tabId)?.url ?? '') || isBrowserHomeUrl(this.tabs.get(tabId)?.url ?? '')) return { ok: false, reason: 'internal-page' };
    const win = this.getWindow();
    const guest = webContents.fromId(webContentsId);
    if (!guest || guest.isDestroyed()) return { ok: false, reason: 'not-found' };
    if (guest.getType() !== 'webview') return { ok: false, reason: 'not-webview' };
    // embedder 必须是主窗口 renderer（防跨窗口/其他 webContents 误绑 CDP 输入面）
    const embedderId = (guest as unknown as { hostWebContents?: WebContents | null }).hostWebContents?.id;
    if (!win || embedderId !== win.webContents.id) return { ok: false, reason: 'embedder-mismatch' };
    // 单窗口应用：首报登记主窗口 id（此后 attach 必须属于同一窗口，防跨窗口串绑）
    this.guests.setWindow(win.id, win.webContents.id);
    const previous = this.guests.guestOf(tabId);
    const res = this.guests.attach({ tabId, webContentsId, guestType: 'webview', windowId: win.id, embedderId });
    if (!res.ok) return { ok: false, reason: res.reason };
    if (previous?.webContentsId === webContentsId) return { ok: true };
    if (previous) this.invalidateOperations(tabId, t('浏览器页面已换代，排队操作已取消'));
    // 换代新 guest：旧 guest 的自动恢复定时器不得触碰新页面；崩溃计数保留——
    // 未达上限时自动 loadURL 也是恢复尝试；已放弃时保持空白等待显式重试
    // 在录 job 收尾（旧 guest 的 screencast 会话随换代失效，已收帧仍可合成）
    this.recordingSvc.abortForTab(tabId, 'finalize');
    this.recordingSvc.abortRenderForTab(tabId);
    this.clearCrashTimerFor(tabId);
    this.wireGuest(tabId, guest, res.generation!);
    // 换代重应用 Agent 视口 override（fire-and-forget，失败不阻塞 attach 主流程；
    // Emulation override 是 target 级状态，换代出的新 guest 必须重新设置）
    this.reapplyViewportOverride(tabId);
    // 首次导航由主进程发起（渲染层 webview 不带 src）：确保 debugger 的
    // Network.enable 先于主文档请求，browser.network 才能捕获首屏
    const tab = this.tabs.get(tabId);
    if (!tab) return { ok: true };
    if (!tab.replayingPanel && !tab.crash?.gaveUp && tab.url && tab.url !== 'about:blank') {
      void this.loadTabUrl(tab, guest, res.generation!, tab.navigationRevision, tab.url).catch((err) => {
        console.warn('[browser] initial loadURL failed:', (err as Error).message);
      });
    }
    return { ok: true };
  }

  /** 渲染层 webview 卸载/销毁上报：壳保留、绑定清除（关 tab 走 closeTab） */
  guestDetach(tabId: string, webContentsId: number): void {
    this.inputPreparations.delete(webContentsId);
    if (this.guests.detach(tabId, webContentsId)) {
      this.invalidateOperations(tabId, t('浏览器页面已卸载，排队操作已取消'));
      const flight = this.tabs.get(tabId)?.loadFlight;
      if (flight?.webContentsId === webContentsId) flight.rejectReady(new Error(t('浏览器页面已卸载，请重试')));
    }
  }

  /** 懒挂载：无 guest 时请求渲染层挂载并等 did-attach（并发共享一次 flight） */
  async ensureGuest(tabId: string): Promise<WebContents | null> {
    if (this.tabs.get(tabId)?.crash?.gaveUp) throw new Error(t('连续多次崩溃，已停止自动恢复'));
    const deadline = Date.now() + MOUNT_WAIT_MS;
    const wc = await this.ensureBoundGuest(tabId, deadline);
    if (this.tabs.get(tabId)?.crash?.gaveUp) throw new Error(t('连续多次崩溃，已停止自动恢复'));
    if (!wc) return null;
    const tab = this.tabs.get(tabId), flight = tab?.loadFlight;
    if (flight && flight.webContentsId === wc.id) {
      if (flight.failedError) throw flight.failedError;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([flight.ready, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(t('浏览器页面尚未就绪，请稍后重试'))), Math.max(0, deadline - Date.now()));
        })]);
      } finally { if (timer) clearTimeout(timer); }
      if (!this.isCurrentGuest(tabId, wc.id) || flight.revision !== tab?.navigationRevision) throw new Error(t('浏览器页面已换代或导航已被替代，请重试'));
    } else if (tab?.lastLoadError) {
      throw new Error(t('页面加载失败（{{url}}）：{{reason}}', {
        url: tab.lastLoadError.url,
        reason: tab.lastLoadError.description
      }));
    }
    return wc;
  }

  /** Navigation must obtain a binding without waiting on the load that it supersedes. */
  private async ensureBoundGuest(tabId: string, deadline = Date.now() + MOUNT_WAIT_MS): Promise<WebContents | null> {
    if (!this.tabs.has(tabId)) return null;
    if (uiSessionPageId(this.tabs.get(tabId)!.url)) throw new Error('capability_unsupported: UI session pages use ui.inspect; browser DOM tools require a web page');
    if (isBrowserHomeUrl(this.tabs.get(tabId)!.url)) throw new Error('capability_unsupported: the new tab page is part of the workbench, not a web page');
    const cur = this.liveGuest(tabId);
    if (cur) return cur;
    const existing = this.mountFlights.get(tabId);
    if (existing) return existing;
    const flight = (async (): Promise<WebContents | null> => {
      let requestedAt = -Infinity;
      while (Date.now() < deadline) {
        if (!this.tabs.has(tabId)) return null;
        const wc = this.liveGuest(tabId);
        if (wc) return wc;
        if (Date.now() - requestedAt >= MOUNT_RETRY_MS) {
          // A lazy renderer owner can miss the first event. Replay its full tab inventory
          // before requesting mount, rather than relying on a previously received payload.
          this.emitTabs();
          this.getWindow()?.webContents.send('browser:mount-request', { tabId });
          requestedAt = Date.now();
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })().finally(() => this.mountFlights.delete(tabId));
    this.mountFlights.set(tabId, flight);
    return flight;
  }

  private liveGuest(tabId: string): WebContents | null {
    const rec = this.guestRecord(tabId);
    if (!rec) return null;
    const wc = webContents.fromId(rec.webContentsId);
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  isCurrentGuest(tabId: string, webContentsId: number): boolean {
    return this.liveGuest(tabId)?.id === webContentsId;
  }

  /** tab 壳存在且有活 guest webContents（回合截图证据的「目标仍存活」判定） */
  tabLive(tabId: string): boolean {
    return this.tabs.has(tabId) && this.liveGuest(tabId) != null;
  }

  /**
   * 回合结束截图证据（任务 D）：对活 guest 抓当前帧 PNG + tab 当前 URL。
   * 目标已关 / 未挂载 / 抓帧失败 / 空帧一律返回 null（调用方静默跳过），绝不抛错。
   */
  async captureTurnShot(tabId: string): Promise<{ png: Buffer; url: string } | null> {
    const tab = this.tabs.get(tabId);
    const wc = this.liveGuest(tabId);
    if (!tab || !wc) return null;
    try {
      const png = (await wc.capturePage()).toPNG();
      if (!png.length) return null;
      return { png, url: tab.url };
    } catch {
      return null;
    }
  }

  private currentGuest(tabId: string, wc: WebContents, generation: number): boolean {
    const current = this.guestRecord(tabId);
    return this.tabs.has(tabId) && current?.webContentsId === wc.id && current.generation === generation && !wc.isDestroyed();
  }

  /** Attach and explicit navigation share one flight for the same desired URL/revision. */
  private loadTabUrl(tab: Tab, wc: WebContents, generation: number, revision: number, url: string): Promise<void> {
    const existing = tab.loadFlight;
    if (existing?.revision === revision && existing.webContentsId === wc.id && existing.url === url) return existing.promise;
    existing?.rejectReady(new Error(t('浏览器导航已被新请求替代')));
    tab.navigationPending = true;
    tab.lastLoadError = null;
    let resolveReadyRaw!: () => void, rejectReadyRaw!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReadyRaw = resolve; rejectReadyRaw = reject; });
    // Initial UI loads have no ensureGuest caller; retain the rejection for later awaiters
    // without emitting an unhandled rejection in the meantime.
    void ready.catch(() => {});
    let settled = false;
    const clearFlightTimer = (): void => {
      if (flight?.timer) {
        clearTimeout(flight.timer);
        flight.timer = undefined;
      }
    };
    const resolveReady = (): void => {
      if (settled) return;
      settled = true;
      clearFlightTimer();
      tab.lastLoadError = null;
      resolveReadyRaw();
    };
    const rejectReady = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearFlightTimer();
      if (flight) flight.failedError = error;
      if (!/替代|卸载|关闭/.test(error.message)) {
        tab.lastLoadError ??= { url, description: error.message };
      }
      rejectReadyRaw(error);
    };
    const navTimer = setTimeout(() => {
      if (!this.currentGuest(tab.id, wc, generation) || revision !== tab.navigationRevision) return;
      tab.navigationPending = false;
      const timeoutErr = new Error(t('页面加载超时（{{url}}）：ERR_CONNECTION_TIMED_OUT', { url }));
      tab.lastLoadError = { url, description: 'ERR_CONNECTION_TIMED_OUT' };
      try { (wc as unknown as { stop?: () => void }).stop?.(); } catch { /* ignore */ }
      rejectReady(timeoutErr);
      this.emitTabs();
    }, NAVIGATION_TIMEOUT_MS);
    navTimer.unref?.();
    const promise = Promise.resolve().then(async () => {
      if (!this.currentGuest(tab.id, wc, generation) || revision !== tab.navigationRevision) throw new Error(t('浏览器导航已被新请求替代'));
      const artifact = parseExternalFileUrl(url);
      if (artifact) {
        const relative = path.relative(userDataStorage(app.getPath('userData')).resolve('app', 'agent-sessions'), artifact.absPath).replace(/\\/g, '/');
        if (/^[A-Za-z0-9_-]{1,64}\/ui\/\d+-.+\.(inline|browser)\.html$/i.test(relative)) await getUiWidgetStore(app.getPath('userData')).read(artifact.absPath);
      }
      if (!this.currentGuest(tab.id, wc, generation) || revision !== tab.navigationRevision) throw new Error(t('浏览器导航已被新请求替代'));
      return wc.loadURL(url);
    }).then(async () => {
      if (!this.currentGuest(tab.id, wc, generation) || revision !== tab.navigationRevision) throw new Error(t('浏览器导航已被新请求替代'));
      if (flight?.failedError) throw flight.failedError;
      tab.navigationPending = false;
      this.onUrlChanged(tab.id, wc.getURL() || url);
      resolveReady();
    }).catch(error => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const formatted = !/页面加载|替代|卸载|关闭/.test(normalized.message)
        ? new Error(t('页面加载失败（{{url}}）：{{reason}}', { url, reason: normalized.message }))
        : normalized;
      if (this.currentGuest(tab.id, wc, generation) && revision === tab.navigationRevision) {
        tab.navigationPending = false;
        this.emitTabs();
      }
      rejectReady(formatted);
      throw formatted;
    });
    const flight: NonNullable<Tab['loadFlight']> = {
      revision, webContentsId: wc.id, url, promise, ready, resolveReady, rejectReady,
      started: false, committedUrl: null, documentUrls: new Set([navigationUrlKey(url)]),
      failedError: null, timer: navTimer
    };
    tab.loadFlight = flight;
    return promise;
  }

  /** guest 接线：导航/标题/favicon/console/网络/marker/原生弹窗/窗口打开/崩溃恢复 */
  private wireGuest(tabId: string, wc: WebContents, generation: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const current = (): boolean => this.currentGuest(tabId, wc, generation);
    // Semantic actions do not emit Electron native input events. Only a real
    // current-page mouse/key event can authorize one intercepted native picker.
    const humanInputHost = (): BrowserWindow | null => {
      const host = this.getWindow();
      return current() && this.inputScopes.get(tabId)?.source !== 'agent' &&
        host && !host.isDestroyed() && host.isVisible() && host.isFocused() ? host : null;
    };
    const humanInput = (): void => {
      if (this.activeId !== tabId || !humanInputHost()) return;
      this.lastInputSources.set(tabId, 'user');
      this.userGestures.set(tabId, Date.now());
      this.humanInputIntents.set(tabId, { webContentsId: wc.id, generation,
        navigationRevision: tab.navigationRevision, expiresAt: Date.now() + 2000 });
    };
    wc.on('before-mouse-event', (_event, input) => {
      if (input.type !== 'mouseDown') return;
      humanInput();
      // Native guest clicks do not bubble into the host document. The renderer
      // checks that this guest is actually displayed in the current split.
      if (input.button === 'left') humanInputHost()?.webContents.send('browser:guest-click', { tabId });
    });
    wc.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      humanInput();
      const host = this.getWindow();
      if (input.key === 'Escape' && current() && this.activeId === tabId && this.inputScopes.get(tabId)?.source !== 'agent' &&
          host && !host.isDestroyed() && host.isVisible() && host.isFocused()) {
        host.webContents.send('browser:escape', { tabId });
      }
    });
    const forgetNativeDialogs = (): void => {
      for (const entry of this.dialogQueue.get(tabId)?.filter(d => d.transport === 'native') ?? []) this.removeDialog(entry);
    };
    wc.debugger.on('detach', () => {
      this.inputPreparations.delete(wc.id);
      if (current()) forgetNativeDialogs();
    });
    wc.on('preload-error', (_event, _file, error) => {
      if (current()) console.warn('[browser] guest preload failed:', error.message);
    });
    // 新窗口默认内置新标签（保持登录态与上下文；不经系统浏览器）；例外：弹窗形态
    // 的 window.open（带窗口特征，见 popupPolicy.ts）且源于真实用户手势 → 放行原生
    // 弹窗，保住 window.open 返回值 / window.opener / window.close() 三条契约；
    // 原生弹窗继承 guest 的 persist:browser 会话。
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (!current()) return { action: 'deny' };
      const gesturedAt = this.userGestures.get(tabId);
      const routing = routeWindowOpen(
        String(disposition ?? ''),
        String(features ?? ''),
        gesturedAt != null && Date.now() - gesturedAt <= USER_GESTURE_POPUP_WINDOW_MS
      );
      if (routing.kind === 'native-popup') {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
      }
      this.createTab(url, { workspaceId: tab.workspaceId, sessionId: tab.sessionId, scope: tab.scope, openerId: tab.id },
        { background: this.shouldOpenInBackground(wc.id), panelUserOpen: this.lastInputSources.get(tabId) === 'user' });
      return { action: 'deny' };
    });
    const changed = (url: string): void => {
      if (current() && !tab.navigationPending && wc.getURL() === url) this.onUrlChanged(tabId, url);
    };
    wc.on('frame-created', () => { if (current()) tab.mediationDocument = randomUUID(); });
    wc.on('did-start-navigation', (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
      const url = details.url ?? legacyUrl;
      const isMainFrame = details.isMainFrame ?? legacyMainFrame;
      if (current()) {
        tab.mediationDocument = randomUUID();
        // Invalidate on every frame navigation; main-document actions also wait for completion.
        if (isMainFrame) {
          tab.mediationNavigating = true;
          if (!(details.isSameDocument ?? legacyInPlace)) this.cancelDialogs(tabId);
        }
      }
      const flight = tab.loadFlight;
      if (current() && isMainFrame && flight?.revision === tab.navigationRevision &&
          flight.webContentsId === wc.id && navigationUrlKey(url) === navigationUrlKey(flight.url)) {
        flight.started = true;
      }
    });
    wc.on('did-navigate', (_e, url) => {
      const flight = tab.loadFlight;
      if (current() && flight?.revision === tab.navigationRevision && flight.webContentsId === wc.id &&
          flight.started && flight.documentUrls.has(navigationUrlKey(url))) flight.committedUrl = url;
      if (current() && typeof url === 'string' && !url.startsWith('chrome-error://') && url !== 'about:blank') {
        this.clearLoadFailure(tabId);
      }
      changed(url);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!current()) return;
      tab.mediationDocument = randomUUID();
      if (isMainFrame) { tab.mediationNavigating = false; changed(url); }
    });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!current() || isMainFrame === false || errorCode === -3) return;
      const targetUrl = String(validatedURL || tab.url || '');
      const desc = String(errorDescription || `ERR_FAILED`);
      const reason = typeof errorCode === 'number' ? `${desc} (${errorCode})` : desc;
      tab.lastLoadError = { url: targetUrl, code: typeof errorCode === 'number' ? errorCode : undefined, description: reason };
      tab.navigationPending = false;
      const flight = tab.loadFlight;
      if (flight && flight.webContentsId === wc.id && flight.revision === tab.navigationRevision) {
        flight.rejectReady(new Error(t('页面加载失败（{{url}}）：{{reason}}', { url: targetUrl, reason })));
      }
      this.emitTabs();
    });
    // tab 标记供诊断与兼容脚本使用；工具 Page 身份由 guest 原生 targetId 判定。
    // dom-ready 每次跨文档导航触发；同文档 SPA 导航不清除已有标记，无需重复注入。
    wc.on('dom-ready', () => {
      if (!current()) return;
      tab.mediationNavigating = false;
      const flight = tab.loadFlight, documentUrl = wc.getURL();
      if (documentUrl && !documentUrl.startsWith('chrome-error://') && documentUrl !== 'about:blank') {
        this.clearLoadFailure(tabId);
      }
      const readyForFlight = !!flight && flight.webContentsId === wc.id &&
        flight.revision === tab.navigationRevision && flight.committedUrl != null &&
        !documentUrl.startsWith('chrome-error://') &&
        navigationUrlKey(flight.committedUrl) === navigationUrlKey(documentUrl);
      // A main document is usable after dom-ready and marker injection; do not
      // hold readonly callers until every remote subresource finishes loading.
      void wc.executeJavaScript(`window.__maBrowserTab=${JSON.stringify(tabId)};0`).then(() => {
        // 注意：恢复成功不在 dom-ready 即刻清零崩溃计数——「恢复即崩」的循环必须能
        // 累积到上限；guest 换代也保留计数。crashPolicy 的稳定窗口（超过 60s）
        // 或显式导航/刷新/重试清零。
        if (!readyForFlight || !current() || !flight || tab.loadFlight !== flight ||
            flight.revision !== tab.navigationRevision || wc.getURL() !== documentUrl) return;
        tab.navigationPending = false;
        this.onUrlChanged(tabId, wc.getURL());
        flight.resolveReady();
      }).catch(() => {});
    });
    // 首个 dom-ready 常早于 attach 到达（渲染层上报在途时页面已就绪）：attach 即补注
    wc.executeJavaScript(`window.__maBrowserTab=${JSON.stringify(tabId)};0`).catch(() => {});
    // console 捕获（browser.console）：Electron 43 的事件载荷在 event 对象上
    // （level/message 字段；旧版四参签名已废弃）
    this.consoleBufs.set(tabId, new Ring(200));
    wc.on('console-message', (e, legacyLevel, legacyMessage) => {
      if (!current()) return;
      const detail = e as unknown as { level?: unknown; message?: unknown };
      const message = typeof detail?.message === 'string' ? detail.message : legacyMessage;
      if (typeof message !== 'string') return;
      const level = detail?.level ?? legacyLevel;
      this.consoleBufs
        .get(tabId)
        ?.push({ ts: Date.now(), level: consoleLevel(level as string | number), text: message });
    });
    // 网络捕获（browser.network）：每标签一个 wc.debugger 会话（Network 域），
    // 与 playwright 的浏览器级连接并存（CDP 允许同 target 多会话）
    this.netBufs.set(tabId, new Ring(300));
    try {
      wc.debugger.attach('1.3');
      void wc.debugger.sendCommand('Network.enable');
      wc.debugger.on('message', (_ev, method, params) => {
        if (!current()) return;
        if (method === 'Page.fileChooserOpened') {
          this.onFileChooser(tabId, wc, generation, params); return;
        }
        if (method === 'Page.javascriptDialogOpening') {
          const p = params as { type?: string; message?: string; defaultPrompt?: string };
          const type = p.type;
          if (type === 'alert' || type === 'confirm' || type === 'prompt') {
            this.enqueueJsDialog(tabId, type, p.message ?? '', p.defaultPrompt ?? '', 'native', async (accepted, value) => {
              if (!current() || !wc.debugger.isAttached()) throw new Error(t('浏览器页面已关闭或换代'));
              await wc.debugger.sendCommand('Page.handleJavaScriptDialog', {
                accept: accepted,
                ...(type === 'prompt' && value !== null ? { promptText: value } : {})
              });
            });
          }
          return;
        }
        if (method === 'Page.javascriptDialogClosed') {
          forgetNativeDialogs();
          return;
        }
        // Network redirect records identify their originating request. An old document's
        // delayed redirect must not extend a newer load's accepted URL chain.
        if (method === 'Network.requestWillBeSent') {
          const p = params as { type?: string; requestId?: string; request?: { url?: string }; redirectResponse?: { url?: string } };
          const flight = tab.loadFlight;
          if (flight?.revision === tab.navigationRevision && flight.webContentsId === wc.id &&
              p.type === 'Document' && p.requestId && p.request?.url) {
            if (!p.redirectResponse && navigationUrlKey(p.request.url) === navigationUrlKey(flight.url)) {
              flight.documentRequestId ??= p.requestId;
            } else if (p.requestId === flight.documentRequestId && p.redirectResponse?.url &&
                       flight.documentUrls.has(navigationUrlKey(p.redirectResponse.url))) {
              flight.documentUrls.add(navigationUrlKey(p.request.url));
            }
          }
        }
        this.onNetEvent(tabId, method, params);
      });
    } catch (err) {
      console.warn('[browser] debugger attach failed:', (err as Error).message);
    }
    wc.on('page-title-updated', (_e, title) => {
      if (!current()) return;
      tab.title = title;
      this.emitTabs();
      this.schedulePersist();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      if (!current()) return;
      tab.favicon = icons?.[0] ?? null;
      this.emitTabs();
    });
    wc.on('did-start-loading', () => {
      if (!current()) return;
      tab.loading = true;
      this.emitTabs();
    });
    wc.on('did-stop-loading', () => {
      if (!current()) return;
      tab.loading = false;
      this.emitTabs();
    });
    // 崩溃恢复（任务 A）：连续崩溃按退避序列自动原地 reload（webview 元素与
    // guest webContents 存活，spike 验证）；达上限进入可见错误态停止自动恢复。
    wc.on('render-process-gone', (_e, details) => {
      if (!current()) return;
      tab.mediationDocument = randomUUID();
      tab.mediationNavigating = true;
      this.invalidateOperations(tabId, t('浏览器页面崩溃，排队操作已取消'));
      console.error('[browser] tab render-process-gone:', details.reason, details.exitCode, wc.getURL());
      this.scheduleCrashRecovery(tabId, wc, generation);
    });
    wc.once('destroyed', () => {
      this.guestDetach(tabId, wc.id);
    });
  }

  private onNetEvent(tabId: string, method: string, params: unknown): void {
    const p = params as {
      requestId?: string;
      request?: { url?: string; method?: string };
      type?: string;
      response?: { status?: number; mimeType?: string };
      errorText?: string;
    };
    const buf = this.netBufs.get(tabId);
    if (!buf || typeof p?.requestId !== 'string') return;
    if (method === 'Network.requestWillBeSent') {
      buf.push({
        requestId: p.requestId,
        url: p.request?.url ?? '',
        method: p.request?.method ?? 'GET',
        type: p.type ?? '',
        ts: Date.now()
      });
      return;
    }
    const entry = [...buf.items].reverse().find((x) => x.requestId === p.requestId);
    if (!entry) return;
    if (method === 'Network.responseReceived') {
      entry.status = p.response?.status;
      entry.mime = p.response?.mimeType;
    } else if (method === 'Network.loadingFailed') {
      entry.error = p.errorText ?? 'failed';
    }
  }

  private onUrlChanged(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.url = url;
    this.capturePanelHistory(tab);
    this.emitTabs();
    this.schedulePersist();
  }

  private capturePanelHistory(tab: Tab): void {
    if (tab.replayingPanel || tab.navigationPending || tab.url.startsWith('chrome-error://')) return;
    const internal = isBrowserHomeUrl(tab.url) || !!uiSessionPageId(tab.url);
    const guest = internal ? undefined : this.liveGuest(tab.id);
    const history = guest?.navigationHistory;
    const index = history?.getActiveIndex() ?? -1;
    const entries = history?.getAllEntries() ?? [];
    if (!internal && entries[index]?.url !== tab.url && tab.url !== 'about:blank') return;
    const previous = tab.panelNativeHistory?.webContentsId === guest?.id ? tab.panelNativeHistory : undefined;
    const previousStack = previous ?? (!guest ? tab.panelPoint : undefined);
    if (previousStack?.index === index && tab.panelPoint?.url === tab.url && entries.length === previousStack.entries.length &&
        entries.every((entry, i) => entry.url === previousStack.entries[i]?.url)) return;
    let sameBranch = !!previous;
    const positions = entries.map((entry, i) => {
      const old = previous?.entries[i];
      // A push after going back can overwrite a forward entry at the same URL.
      // Compare that slot at the commit, since PageState can change on traversal.
      const replacedForward = i === index && index > (previous?.index ?? -1) &&
        (entries.length !== previous?.entries.length || old?.pageState !== entry.pageState);
      if (old?.url !== entry.url || replacedForward) sameBranch = false;
      return sameBranch ? previous!.positions[i] : randomUUID();
    });
    const point: PanelHistoryPoint = {
      key: randomUUID(), url: tab.url, index, positions,
      workspaceId: tab.workspaceId, sessionId: tab.sessionId, scope: tab.scope,
      entries: entries.map((entry, i) => {
        const old = previous?.entries[i];
        return old?.url === entry.url && old.title === entry.title && old.pageState === entry.pageState ? old : entry;
      })
    };
    const replacedGuest = !!guest && !!tab.panelNativeHistory && !previous;
    tab.panelNativeHistory = guest ? { webContentsId: guest.id, entries: point.entries, index, positions } : undefined;
    tab.panelPoint = point;
    tab.panelHistoryUserNavigation = !replacedGuest && this.lastInputSources.get(tab.id) !== 'agent';
    this.panelHistory.set(point.key, point);
    this.prunePanelHistory();
  }

  retainPanelHistory(keys: string[]): void {
    this.retainedPanelHistory = new Set(keys);
    this.prunePanelHistory();
  }

  private prunePanelHistory(): void {
    if (this.panelHistory.size <= RECENT_PANEL_HISTORY) return;
    const live = new Set([...this.tabs.values()].map(tab => tab.panelPoint?.key));
    const old = [...this.panelHistory.keys()].slice(0, -RECENT_PANEL_HISTORY);
    for (const key of old) if (!live.has(key) && !this.retainedPanelHistory.has(key)) this.panelHistory.delete(key);
  }

  /** A webview needs a src to instantiate, while Chromium requires an unloaded guest for restore(). */
  private preparePanelRestoreHost(): void {
    const host = this.getWindow()?.webContents;
    if (!host) throw new Error(t('浏览器页面尚未挂载，请稍后重试'));
    if (this.panelRestoreHosts.has(host)) return;
    this.panelRestoreHosts.add(host);
    const candidates = new WeakMap<WebContents, string>();
    host.on('will-attach-webview', (event, _preferences, params) => {
      if (!params.src?.startsWith(browserPanelReplaySrcPrefix)) return;
      const request = params.src.slice(browserPanelReplaySrcPrefix.length);
      const tab = [...this.tabs.values()].find(item => item.replayingPanel && item.panelReplayRequest === request);
      if (!tab || params.partition !== PARTITION) { event.preventDefault(); return; }
      params.src = '';
      // Electron creates the matching WebContents synchronously after this hook.
      const created = (_event: Electron.Event, guest: WebContents): void => {
        if (guest.getType() !== 'webview') return;
        candidates.set(guest, tab.id);
        app.removeListener('web-contents-created', created);
      };
      app.on('web-contents-created', created);
      queueMicrotask(() => app.removeListener('web-contents-created', created));
    });
    host.on('did-attach-webview', (_event, guest) => {
      const id = candidates.get(guest);
      if (!id) return;
      candidates.delete(guest);
      this.guestAttach(id, guest.id);
    });
  }

  /** Move a live guest through its native history, or prepare a fresh guest before replacing it. */
  async replayPanelHistory(request: BrowserPanelReplayRequest): Promise<BrowserTabInfo> {
    const { workspaceId, sessionId, scope, requestId, browserId, historyKey, url } = request;
    const point = historyKey ? this.panelHistory.get(historyKey) : undefined;
    const live = browserId ? this.tabs.get(browserId) : undefined;
    const sameOwner = (owner: { workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session' }): boolean =>
      (!owner.workspaceId || owner.workspaceId === workspaceId) &&
      (owner.scope !== 'session' || !owner.sessionId || owner.sessionId === sessionId);
    if ((historyKey && (!point || point.url !== url || !sameOwner(point))) || (live && !sameOwner(live))) {
      throw new Error(t('网页历史已不可用'));
    }
    const wc = live && this.liveGuest(live.id);
    const native = live?.panelNativeHistory;
    const reachable = point && wc && native?.webContentsId === wc.id && !live?.navigationPending && !!point.positions[point.index] &&
      native.positions[point.index] === point.positions[point.index] &&
      wc.navigationHistory.getEntryAtIndex(point.index)?.url === point.url;
    if (point && live && wc && reachable) {
      return this.runOperation(live.id, async () => {
        live.replayingPanel = true;
        try {
          await this.goToPanelPosition(wc, point);
          return this.finishPanelReplay(live, point, native.positions);
        } finally { live.replayingPanel = false; }
      }, 'user');
    }

    // The new guest is tagged before the first snapshot. The renderer mounts it
    // for restore() without creating another right-panel tab or loading its URL.
    const restorePanelHistory = !!point?.entries.length;
    if (restorePanelHistory) this.preparePanelRestoreHost();
    const id = this.createTab(url, { workspaceId, sessionId, scope }, { background: true, panelReplayRequest: requestId, restorePanelHistory });
    const tab = this.tabs.get(id)!;
    try {
      if (restorePanelHistory && point) {
        const guest = await this.ensureBoundGuest(id);
        if (!guest) throw new Error(t('浏览器页面尚未挂载，请稍后重试'));
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(t('网页历史已不可用'))), NAVIGATION_TIMEOUT_MS);
          });
          await Promise.race([guest.navigationHistory.restore({ entries: point.entries, index: point.index }), timeout]);
        } finally { if (timer) clearTimeout(timer); }
        if (guest.navigationHistory.getActiveIndex() !== point.index || guest.getURL() !== point.url) throw new Error(t('网页历史已不可用'));
      }
      if (point) return this.finishPanelReplay(tab, point, point.positions);
      return this.info(tab, true);
    } catch (error) {
      this.closeTab(id);
      throw error;
    }
  }

  private finishPanelReplay(tab: Tab, point: PanelHistoryPoint, positions: string[]): BrowserTabInfo {
    tab.replayingPanel = false;
    tab.panelPoint = point;
    tab.panelHistoryUserNavigation = false;
    tab.url = point.url;
    const guest = this.liveGuest(tab.id);
    tab.panelNativeHistory = guest ? { webContentsId: guest.id, entries: guest.navigationHistory.getAllEntries(), index: point.index, positions } : undefined;
    const title = guest?.getTitle() || point.entries[point.index]?.title;
    if (title) tab.title = title;
    this.emitTabs();
    this.schedulePersist();
    return this.info(tab, true);
  }

  private async goToPanelPosition(wc: WebContents, point: PanelHistoryPoint): Promise<void> {
    const history = wc.navigationHistory;
    const reached = (): boolean => !wc.isDestroyed() && history.getActiveIndex() === point.index && wc.getURL() === point.url;
    if (reached()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        wc.removeListener('did-navigate', check);
        wc.removeListener('did-navigate-in-page', check);
        wc.removeListener('did-fail-load', failed);
        wc.removeListener('destroyed', lost);
        if (error) reject(error);
        else resolve();
      };
      const check = (): void => { if (reached()) finish(); };
      const lost = (): void => finish(new Error(t('网页历史已不可用')));
      const failed = (_event: Electron.Event, code: number, _reason: string, _url: string, mainFrame: boolean): void => {
        if (mainFrame && code !== -3) lost();
      };
      const timer = setTimeout(lost, NAVIGATION_TIMEOUT_MS);
      wc.on('did-navigate', check);
      wc.on('did-navigate-in-page', check);
      wc.on('did-fail-load', failed);
      wc.once('destroyed', lost);
      try { history.goToIndex(point.index); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  /** Cache an already-visited site's same-origin icon as a small local PNG. */
  async bookmarkFavicon(tabId: string): Promise<string | null> {
    const tab = this.tabs.get(tabId);
    if (!tab?.favicon) return null;
    const pageUrl = tab.url, iconUrl = tab.favicon;
    let page: URL, icon: URL;
    try { page = new URL(pageUrl); icon = new URL(iconUrl); } catch { return null; }
    if (!['http:', 'https:'].includes(page.protocol) || icon.origin !== page.origin) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); timer.unref?.();
    try {
      const response = await browserSession().fetch(icon.href, { signal: controller.signal, credentials: 'omit', redirect: 'manual' });
      if (!response.ok || !response.body) throw new Error('icon request failed');
      const size = Number(response.headers.get('content-length'));
      if (Number.isFinite(size) && size > 256 * 1024) throw new Error('icon is too large');
      const reader = response.body.getReader(), chunks: Buffer[] = [];
      let total = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          total += part.value.byteLength;
          if (total > 256 * 1024) throw new Error('icon is too large');
          chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (this.tabs.get(tabId) !== tab || tab.url !== pageUrl || tab.favicon !== iconUrl) return null;
      const image = nativeImage.createFromBuffer(Buffer.concat(chunks));
      if (image.isEmpty()) throw new Error('unsupported icon image');
      const data = image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
      return data.length <= 65_536 ? data : null;
    } finally { clearTimeout(timer); }
  }

  // ── 标签生命周期 ──

  /** One stable UI-only browser tab per CLI session, including restored tabs. */
  openUiSession(sessionId: string, workspaceId?: string): string {
    this.restoreTabs(false);
    const url = uiSessionPageUrl(sessionId);
    const existing = [...this.tabs.values()].find(tab => tab.url === url && tab.sessionId === sessionId && tab.workspaceId === workspaceId);
    const id = existing?.id ?? this.createTab(url, { sessionId, workspaceId, scope: 'session' });
    this.activate(id);
    this.getWindow()?.webContents.send('uiWidget:present', { sessionId, tabId: id });
    return id;
  }

  createTab(url = 'about:blank', owner: { workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session'; openerId?: string } = {}, options: { background?: boolean; panelUserOpen?: boolean; panelReplayRequest?: string; restorePanelHistory?: boolean } = {}): string {
    // Tools can create before the lazy renderer has called restore. Restore saved
    // shells first, but do not insert a spare default blank next to the requested tab.
    this.restoreTabs(false);
    const id = `bt${++this.seq}`;
    this.tabs.set(id, { id, ...owner, openInBackground: !!options.background, panelReplayRequest: options.panelReplayRequest, panelUserOpen: options.panelUserOpen,
      replayingPanel: options.restorePanelHistory, title: '', url, favicon: null, loading: false, navigationRevision: 0, navigationPending: false,
      mediationDocument: randomUUID(), mediationNavigating: false, crash: null, crashRetryTimer: null, viewportOverride: null });
    this.order.push(id);
    this.guests.createTab(id);
    if (options.background) { this.emitTabs(); this.schedulePersist(); }
    else this.activate(id);
    return id;
  }

  /** Presentation ownership follows the unified right-tab model after pin/unpin. */
  setOwner(id: string, owner: { workspaceId: string; sessionId: string; scope: 'workspace' | 'session' }): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    if (tab.workspaceId === owner.workspaceId && tab.sessionId === owner.sessionId && tab.scope === owner.scope) return true;
    tab.workspaceId = owner.workspaceId;
    tab.sessionId = owner.sessionId;
    tab.scope = owner.scope;
    this.emitTabs();
    this.schedulePersist();
    return true;
  }

  closeTab(id: string, includePanelHistory = false): BrowserTabInfo | undefined {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const wc = this.liveGuest(id);
    const info = includePanelHistory ? this.info(tab, true) : undefined;
    const point = tab.panelPoint;
    if (info && point && wc?.getURL() === point.url && wc.navigationHistory.getActiveIndex() === point.index) {
      point.entries = wc.navigationHistory.getAllEntries();
      if (tab.panelNativeHistory?.webContentsId === wc.id) point.positions = tab.panelNativeHistory.positions;
    }
    const closedPage = info && point ? { ...info, url: point.url, panelHistoryKey: point.key } : info;
    this.invalidateOperations(id, t('浏览器标签已关闭，排队操作已取消'));
    this.fileChooserNotices.delete(id);
    this.lastInputSources.delete(id);
    // 在录 job 收尾落盘（保留已录内容；录制监听随 guest 销毁自然失效）
    this.recordingSvc.abortForTab(id, 'finalize');
    this.recordingSvc.abortRenderForTab(id);
    this.clearCrashRecovery(id);
    tab.loadFlight?.rejectReady(new Error(t('浏览器标签已关闭')));
    const idx = this.order.indexOf(id);
    if (wc) {
      try {
        wc.debugger.removeAllListeners('message');
        if (wc.debugger.isAttached()) wc.debugger.detach();
      } catch {
        /* already destroyed */
      }
      // 不显式 wc.close()：webview 元素随 emitTabs 卸载即自然销毁 guest——
      // 主进程先行 close 会与元素内部 IPC 竞态，渲染层报 "Invalid guestInstanceId"
    }
    this.guests.closeTab(id);
    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.consoleBufs.delete(id);
    this.netBufs.delete(id);
    this.dialogPolicies.delete(id);
    // 轨迹清理：删除被关标签；指针落在删除点左侧时左移
    const at = this.trail.indexOf(id);
    if (at >= 0) {
      this.trail.splice(at, 1);
      if (this.trailIdx >= at) this.trailIdx = Math.max(-1, this.trailIdx - 1);
    }
    if (this.activeId === id) {
      const next = this.order[Math.min(idx, this.order.length - 1)] ?? null;
      if (next) this.activate(next);
      else this.setActiveQuiet(null);
    }
    this.emitTabs();
    this.schedulePersist();
    return closedPage;
  }

  activate(id: string): void {
    if (!this.tabs.has(id)) return;
    // 轨迹：截断前进段后追加（重复激活不动，保持前进链可续走）
    if (this.trailIdx >= 0 && this.trail[this.trailIdx] === id) {
      this.setActiveQuiet(id);
      return;
    }
    this.trail = this.trail.slice(0, this.trailIdx + 1);
    this.trail.push(id);
    this.trailIdx = this.trail.length - 1;
    this.setActiveQuiet(id);
    this.schedulePersist();
  }

  private setActiveQuiet(id: string | null): void {
    this.activeId = id;
    this.emitTabs();
  }

  /** 恢复：只建 tab 壳；没有存档时创建工作台新标签页。 */
  restore(): BrowserTabsPayload {
    this.restoreTabs(true);
    return this.snapshot(true);
  }

  private restoreTabs(createDefault: boolean): void {
    if (!this.restored) {
      this.restored = true;
      const saved = this.config.get().browser?.tabs;
      const urls = (saved?.urls ?? []).slice(0, RESTORE_MAX_TABS).filter((u) => typeof u === 'string');
      if (urls.length) {
        for (const [index, u] of urls.entries()) {
          const id = `bt${++this.seq}`;
          this.tabs.set(id, { id, ...saved?.owners?.[index], title: '', url: u, favicon: null, loading: false, navigationRevision: 0, navigationPending: false, mediationDocument: randomUUID(), mediationNavigating: false, crash: null, crashRetryTimer: null, viewportOverride: null });
          this.order.push(id);
          this.guests.createTab(id);
        }
        const pick =
          (saved?.activeIdx != null && this.order[Math.min(saved.activeIdx, this.order.length - 1)]) ||
          this.order[0];
        this.trail = pick ? [pick] : [];
        this.trailIdx = pick ? 0 : -1;
        this.setActiveQuiet(pick ?? null);
      } else if (createDefault) {
        this.createTab(browserHomeUrl(randomUUID()), { scope: 'workspace' });
      }
    }
  }

  /** Observe an already allocated tab without restoring shells or creating a default tab. */
  inspectExistingTab(id: string): BrowserTabInfo | null {
    const tab = this.tabs.get(id);
    return tab ? this.info(tab) : null;
  }

  /** Capture a host-owned guest/document identity for a future mediation gate; never mounts a page. */
  captureMediationTarget(id: string): { target: DesktopTargetIdentity; workspaceId: string; sessionId?: string;
    scope: 'workspace' | 'session'; isCurrent(): boolean } {
    const tab = this.tabs.get(id), guest = this.guestRecord(id), wc = this.liveGuest(id);
    if (!tab || !guest || !wc || !tab.workspaceId || (tab.scope !== 'workspace' && tab.scope !== 'session') ||
        (tab.scope === 'session' && !tab.sessionId) || tab.navigationPending || tab.mediationNavigating || tab.lastLoadError) {
      throw new Error('Browser mediation target is unavailable or navigating');
    }
    const url = wc.getURL(), processId = wc.getOSProcessId();
    const singleFrame = (): boolean => {
      // Electron documents that this list includes the frame itself; wrappers for the
      // same native frame need not have JavaScript object identity.
      try { const frames = wc.mainFrame.framesInSubtree; return Array.isArray(frames) && frames.length === 1; }
      catch { return false; }
    };
    if (!singleFrame()) throw new Error('Browser mediation for pages with subframes is not yet available');
    let origin: string;
    try {
      const parsed = new URL(url);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin === 'null') throw new Error('unsupported');
      origin = parsed.origin;
    } catch { throw new Error('Browser mediation requires a supported HTTP(S) origin'); }
    if (!Number.isSafeInteger(processId) || processId < 1 || url !== tab.url || wc.isLoadingMainFrame()) throw new Error('Browser mediation target is not stable');
    const document = tab.mediationDocument, workspaceId = tab.workspaceId, sessionId = tab.sessionId, scope = tab.scope;
    const digest = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    const target = Object.freeze({ appId: `browser:${origin}`,
      processInstance: digest([this.mediationInstance, guest.webContentsId, guest.generation, processId]),
      surfaceId: digest([this.mediationInstance, id]),
      surfaceGeneration: digest([guest.webContentsId, guest.generation, processId, document]) });
    const isCurrent = (): boolean => {
      try {
        return this.tabs.get(id) === tab && tab.workspaceId === workspaceId && tab.sessionId === sessionId && tab.scope === scope &&
          !tab.navigationPending && !tab.mediationNavigating && !tab.lastLoadError && tab.mediationDocument === document &&
          this.currentGuest(id, wc, guest.generation) && singleFrame() && !wc.isLoadingMainFrame() &&
          wc.getOSProcessId() === processId && wc.getURL() === url && tab.url === url;
      } catch { return false; }
    };
    if (!isCurrent()) throw new Error('Browser mediation target changed');
    return { target, workspaceId, ...(sessionId ? { sessionId } : {}), scope, isCurrent };
  }

  snapshot(includePanelHistory = false): BrowserTabsPayload {
    this.restoreTabs(true);
    return {
      tabs: this.order
        .map((id) => this.tabs.get(id))
        .filter((tab): tab is Tab => !!tab && (includePanelHistory || !tab.panelReplayRequest || !tab.replayingPanel))
        .map((tab) => this.info(tab, includePanelHistory)),
      activeId: this.activeId,
      nav: { back: this.navBackAvailable(), forward: this.navForwardAvailable() }
    };
  }

  private info(tab: Tab, includePanelHistory = false): BrowserTabInfo {
    const nh = this.liveGuest(tab.id)?.navigationHistory;
    if (includePanelHistory && !tab.panelPoint) this.capturePanelHistory(tab);
    return {
      id: tab.id,
      workspaceId: tab.workspaceId, sessionId: tab.sessionId, scope: tab.scope, openerId: tab.openerId,
      openInBackground: tab.openInBackground,
      ...(includePanelHistory ? {
        panelHistoryKey: tab.panelPoint?.url === tab.url && !tab.replayingPanel ? tab.panelPoint.key : undefined,
        panelHistoryUserNavigation: tab.panelHistoryUserNavigation,
        panelUserOpen: tab.panelUserOpen,
        panelReplayRequest: tab.panelReplayRequest,
        panelRestorePending: !!tab.panelReplayRequest && tab.replayingPanel
      } : {}),
      title: uiSessionPageId(tab.url) ? t('交互 UI') : isBrowserHomeUrl(tab.url) ? t('新建标签页') : tab.title || tab.url || 'about:blank',
      url: tab.url,
      favicon: tab.favicon,
      loading: tab.loading,
      canGoBack: !!nh?.canGoBack(),
      canGoForward: !!nh?.canGoForward(),
      /** 崩溃已达上限：停止自动恢复，等待手动重试（UI 显示错误卡） */
      crashed: !!tab.crash?.gaveUp
    };
  }

  // ── 导航（经注册表定位 guest；未挂载先 ensureGuest 懒挂载） ──

  async navigate(id: string, input: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const url = normalizeUrlInput(input);
    if (uiSessionPageId(url) || isBrowserHomeUrl(url)) {
      tab.loading = false; tab.navigationPending = false;
      this.onUrlChanged(id, url); return;
    }
    const revision = ++tab.navigationRevision;
    tab.url = url;
    tab.navigationPending = true;
    this.clearCrashRecovery(id);
    tab.loadFlight?.rejectReady(new Error(t('浏览器导航已被新请求替代')));
    // Attach and navigate share the same revision flight, so a lazy tab loads once.
    const wc = await this.ensureBoundGuest(id);
    if (this.tabs.get(id) !== tab || revision !== tab.navigationRevision) throw new Error(t('浏览器导航已被新请求替代'));
    if (!wc) { tab.navigationPending = false; throw new Error(t('浏览器页面尚未挂载，请稍后重试')); }
    const generation = this.guestRecord(id)!.generation;
    await this.loadTabUrl(tab, wc, generation, revision, url);
  }

  private clearLoadFailure(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.lastLoadError = null;
    if (tab.loadFlight?.failedError) {
      if (tab.loadFlight.timer) clearTimeout(tab.loadFlight.timer);
      tab.loadFlight = undefined;
    }
  }

  async nav(id: string, dir: 'back' | 'forward' | 'refresh'): Promise<void> {
    const sessionId = uiSessionPageId(this.tabs.get(id)?.url ?? '');
    if (sessionId) {
      if (dir === 'refresh') this.getWindow()?.webContents.send('uiWidget:present', { sessionId, tabId: id });
      else await this.navActive(dir);
      return;
    }
    if (isBrowserHomeUrl(this.tabs.get(id)?.url ?? '')) {
      if (dir !== 'refresh') await this.navActive(dir);
      return;
    }
    if (dir === 'refresh') {
      if (this.tabs.get(id)?.crash?.gaveUp) { await this.retryCrash(id); return; }
    }
    this.clearCrashRecovery(id);
    this.clearLoadFailure(id);
    const wc = await this.ensureBoundGuest(id).catch(() => null);
    if (!wc) return;
    if (dir === 'back') wc.navigationHistory.goBack();
    else if (dir === 'forward') wc.navigationHistory.goForward();
    else wc.reload();
  }

  /** 作用于激活标签（全局前进后退集成：浏览器页激活时 panel.back/forward 转发到此）。
   *  统一后退链：先走网页历史，无网页历史（如新开标签）沿激活轨迹退回上一个标签。 */
  async navActive(dir: 'back' | 'forward' | 'refresh'): Promise<void> {
    if (dir === 'refresh') {
      if (this.activeId) await this.nav(this.activeId, 'refresh');
      return;
    }
    const nh = this.activeId ? this.liveGuest(this.activeId)?.navigationHistory : null;
    if (dir === 'back') {
      if (nh?.canGoBack()) {
        this.clearCrashRecovery(this.activeId!);
        this.clearLoadFailure(this.activeId!);
        nh.goBack();
        return;
      }
      if (this.trailIdx > 0) {
        this.trailIdx -= 1;
        this.setActiveQuiet(this.trail[this.trailIdx]);
      }
      return;
    }
    if (nh?.canGoForward()) {
      this.clearCrashRecovery(this.activeId!);
      this.clearLoadFailure(this.activeId!);
      nh.goForward();
      return;
    }
    if (this.trailIdx < this.trail.length - 1) {
      this.trailIdx += 1;
      this.setActiveQuiet(this.trail[this.trailIdx]);
    }
  }

  private navBackAvailable(): boolean {
    const nh = this.activeId ? this.liveGuest(this.activeId)?.navigationHistory : null;
    return !!nh?.canGoBack() || this.trailIdx > 0;
  }

  private navForwardAvailable(): boolean {
    const nh = this.activeId ? this.liveGuest(this.activeId)?.navigationHistory : null;
    return !!nh?.canGoForward() || this.trailIdx < this.trail.length - 1;
  }

  async openDevTools(id: string): Promise<void> {
    const wc = await this.ensureBoundGuest(id).catch(() => null);
    wc?.openDevTools({ mode: 'detach' });
  }

  /** 崩溃自动恢复调度：定时器回调再校验 tab/guest/generation，旧事件不加载新 guest */
  private scheduleCrashRecovery(tabId: string, wc: WebContents, generation: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.currentGuest(tabId, wc, generation)) return;
    const { state, decision } = nextCrashRecovery(tab.crash, Date.now());
    tab.crash = state;
    this.clearCrashTimer(tab);
    if (decision.action === 'give-up') {
      this.emitTabs();
      return;
    }
    tab.crashRetryTimer = setTimeout(() => {
      tab.crashRetryTimer = null;
      if (!this.currentGuest(tabId, wc, generation) || wc.isDestroyed()) return;
      try {
        // 同 guest 原地 reload（主进程侧实测可用；导航历史随 webContents 保留，
        // 崩溃→reload 后 canGoBack/goBack 正常——e2e 验证）
        wc.reload();
      } catch {
        /* guest 已销毁：壳保留，等懒挂载重建 */
      }
    }, decision.delayMs);
    this.emitTabs();
  }

  private clearCrashTimer(tab: Tab): void {
    if (tab.crashRetryTimer) {
      clearTimeout(tab.crashRetryTimer);
      tab.crashRetryTimer = null;
    }
  }

  private clearCrashTimerFor(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) this.clearCrashTimer(tab);
  }

  private clearCrashRecovery(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.clearCrashTimer(tab);
    if (tab.crash) {
      tab.crash = null;
      this.emitTabs();
    }
  }

  /** 手动重试：清零计数；原 guest reload 保留历史，未挂载/空白 guest 加载保存的 URL。 */
  async retryCrash(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab?.crash?.gaveUp) return false;
    this.clearCrashRecovery(tabId);
    const wc = this.liveGuest(tabId);
    try {
      if (!wc || !wc.getURL() || wc.getURL() === 'about:blank') await this.navigate(tabId, tab.url);
      else wc.reload();
      return true;
    } catch {
      return false;
    }
  }

  /** Compatibility rejection: background tools never request a foreground handoff. */
  async requestGuestFocus(_tabId: string, _reveal = false): Promise<void> {
    throw new Error('capability_unsupported: 后台 DOM 操作不支持请求前台焦点');
  }

  ackGuestFocus(_payload: BrowserFocusAck, _senderId: number): boolean { return false; }

  /** Agent 正在操作该标签：关渲染节流——隐藏/后台期间页面定时器与动画不被 Chromium 降频 */
  setAgentBusy(tabId: string, busy: boolean): void {
    const wc = this.liveGuest(tabId);
    if (!wc) return;
    try {
      wc.setBackgroundThrottling(!busy);
    } catch {
      /* guest 可能已销毁 */
    }
  }

  /** File URL for the renderer's <webview preload> attribute. */
  preloadPath(): string {
    return this.viewPreloadUrl;
  }

  // ── 推送与持久化 ──

  private emitTabs(): void {
    this.getWindow()?.webContents.send('browser:tabs', this.snapshot(true));
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private persistNow(): void {
    const cur = this.config.get().browser ?? {};
    const tabs = this.order.map(id => this.tabs.get(id)).filter((tab): tab is Tab => !!tab && !!tab.url &&
      tab.url !== 'about:blank' && !tab.url.startsWith(MUSTER_EXPORT_SCHEME + ':') && !(tab.panelReplayRequest && tab.replayingPanel));
    this.config.update({
      browser: {
        ...cur,
        tabs: {
          urls: tabs.map(tab => tab.url),
          owners: tabs.map(({ workspaceId, sessionId, scope }) => ({ workspaceId, sessionId, ...(scope ? { scope } : {}) })),
          activeIdx: this.activeId ? Math.max(0, tabs.findIndex(tab => tab.id === this.activeId)) : undefined
        }
      }
    });
  }

  /** 标签栏布局偏好（渲染层开关/拖宽经此落盘；主进程读改写，防与 tabs 段并发互踩） */
  setTabbarPrefs(prefs: { width?: number; collapsed?: boolean }): void {
    const cur = this.config.get().browser ?? {};
    const next = {
      ...cur,
      ...(prefs.width != null
        ? { tabbarWidth: Math.max(140, Math.min(320, Math.round(prefs.width))) }
        : {}),
      ...(prefs.collapsed != null ? { tabbarCollapsed: prefs.collapsed } : {})
    };
    this.config.update({ browser: next });
  }

  /** 退出前落盘（before-quit 调用；此时主窗口可能已在销毁中，persist 不依赖窗口） */
  stop(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.restored) this.persistNow();
    this.recordingSvc.stopAll(true);
    for (const id of this.order) {
      this.invalidateOperations(id, t('浏览器已关闭，排队操作已取消'));
      this.clearCrashRecovery(id);
      this.tabs.get(id)?.loadFlight?.rejectReady(new Error(t('浏览器标签已关闭')));
      const wc = this.liveGuest(id);
      if (wc) {
        try {
          wc.debugger.removeAllListeners('message');
          if (wc.debugger.isAttached()) wc.debugger.detach();
        } catch {
          /* already destroyed */
        }
        try {
          wc.close();
        } catch {
          /* already destroyed */
        }
      }
      this.guests.closeTab(id);
    }
    this.tabs.clear();
    this.panelHistory.clear();
    this.retainedPanelHistory.clear();
    this.fileChooserNotices.clear();
    this.lastInputSources.clear();
    this.humanInputIntents.clear();
    this.userGestures.clear();
    this.inputPreparations.clear();
    this.order = [];
    this.activeId = null;
  }

  // ── agent 观测数据（console / network / downloads） ──

  consoleEntries(tabId: string): ConsoleEntry[] {
    return this.consoleBufs.get(tabId)?.items ?? [];
  }

  networkEntries(tabId: string): NetworkEntry[] {
    return this.netBufs.get(tabId)?.items ?? [];
  }

  /** 惰性取响应体：请求捕获在案且 debugger 仍在（页面未销毁）时经 CDP 取 */
  async networkBody(tabId: string, requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    const wc = this.liveGuest(tabId);
    const entry = this.netBufs.get(tabId)?.items.find((x) => x.requestId === requestId);
    if (!wc || !entry) throw new Error(t('网络请求不在捕获记录中（tabId 或 requestId 无效）'));
    try {
      const res = (await wc.debugger.sendCommand('Network.getResponseBody', {
        requestId
      })) as { body?: string; base64Encoded?: boolean };
      return { body: res?.body ?? '', base64Encoded: !!res?.base64Encoded };
    } catch (e) {
      throw new Error(t('响应体不可用（已被浏览器丢弃或资源仍在加载）：{{message}}', {
        message: (e as Error).message
      }));
    }
  }

  downloadStatus(file: string): 'active' | 'verified' | 'unknown' { return this.downloadStore.status(file); }
  downloadIdentity(file: string): string { return this.downloadStore.snapshotIdentity(file); }
  removeDownload(file: string, expected: string): void { this.downloadStore.remove(file, expected); }

  downloadEntries(): DownloadEntry[] {
    return this.downloads.items;
  }

  activeTabId(): string | null {
    return this.activeId;
  }

  /** A guest-only move with no pressed buttons. Press and release stay on the DOM path. */
  async moveGuestPointer(tabId: string, point: { x: number; y: number }): Promise<void> {
    const wc = this.liveGuest(tabId);
    const guest = this.guestRecord(tabId);
    if (!wc || !guest || !wc.debugger.isAttached()) throw new Error(t('浏览器页面尚未挂载，请稍后重试'));
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0
    });
    if (!this.currentGuest(tabId, wc, guest.generation)) throw new Error(t('浏览器页面已关闭或换代'));
  }

  /** 露条态滚轮转发：guest 经 CDP mouse.wheel 滚动（wc.sendInputEvent 对 guest 不生效） */
  async wheelForward(tabId: string, payload: Omit<BrowserWheelPayload, 'tabId'>): Promise<boolean> {
    if (!payload || ![payload.x, payload.y, payload.deltaX, payload.deltaY].every(Number.isFinite) ||
        payload.x < 0 || payload.y < 0) return false;
    const wc = this.liveGuest(tabId);
    if (!wc || !wc.debugger.isAttached()) return false;
    try {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: payload.x,
        y: payload.y,
        deltaX: payload.deltaX,
        deltaY: payload.deltaY
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── 视口（agent browser.setViewport / resetViewport；Emulation override） ──

  /** Emulation 域命令走 wc.debugger（与 Network 捕获共用同一会话；未挂则补挂） */
  private async sendEmulationCommand(
    wc: WebContents,
    method: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand(method, params);
  }

  /**
   * Agent 视口设置（响应式布局验收）：clamp 后经 guest debugger 的
   * Emulation.setDeviceMetricsOverride 应用（deviceScaleFactor=1、mobile=false），
   * 页面 CSS 视口随之变化。只改该标签的网页内容区，不动窗口/布局；override 记在
   * tab 上——guest 换代（崩溃恢复重建）后 reapplyViewportOverride 自动重应用，
   * 关闭标签随 tab 消亡，无需专门清理。
   */
  async setViewport(tabId: string, width: number, height: number): Promise<ViewportSize> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(t('浏览器标签不存在：{{id}}（先用 browser.tabs 列出可用标签）', { id: tabId }));
    const revision = tab.operationRevision ?? 0;
    const size = clampViewportSize(width, height);
    // guest 未挂载先懒挂载（后台标签也可设视口——CDP 层操作，不需要输入焦点）
    const wc = await this.ensureGuest(tabId);
    if (!wc) throw new Error(t('浏览器页面尚未挂载，请稍后重试'));
    const generation = this.guestRecord(tabId)?.generation;
    const current = (): void => {
      if (this.tabs.get(tabId) !== tab || (tab.operationRevision ?? 0) !== revision ||
          generation == null || !this.currentGuest(tabId, wc, generation)) {
        throw new Error(t('浏览器页面已关闭或换代，视口设置已取消'));
      }
    };
    current();
    try {
      await this.sendEmulationCommand(wc, 'Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
        dontSetVisibleSize: true
      });
    } catch (err) {
      current();
      throw new Error(t('视口设置失败：{{message}}', { message: (err as Error).message }));
    }
    // An old target's ACK must not publish successful metrics for its replacement.
    current();
    tab.viewportOverride = size;
    return size;
  }

  /** Current agent viewport override, used by deterministic render jobs to restore user state. */
  viewportOverride(tabId: string): ViewportSize | null {
    const value = this.tabs.get(tabId)?.viewportOverride;
    return value ? { ...value } : null;
  }

  /** 清除 Agent 设置的视口 override（Emulation.clearDeviceMetricsOverride）：
   *  只清本工具设置的状态，不影响用户窗口与布局；无 override 时幂等返回。 */
  async resetViewport(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(t('浏览器标签不存在：{{id}}（先用 browser.tabs 列出可用标签）', { id: tabId }));
    if (!tab.viewportOverride) return;
    const wc = this.liveGuest(tabId);
    if (!wc) { tab.viewportOverride = null; return; }
    const revision = tab.operationRevision ?? 0, generation = this.guestRecord(tabId)?.generation;
    const current = (): void => {
      if (this.tabs.get(tabId) !== tab || (tab.operationRevision ?? 0) !== revision ||
          generation == null || !this.currentGuest(tabId, wc, generation)) {
        throw new Error(t('浏览器页面已关闭或换代，视口恢复已取消'));
      }
    };
    current();
    try {
      await this.sendEmulationCommand(wc, 'Emulation.clearDeviceMetricsOverride');
    } catch (err) {
      current();
      throw new Error(t('视口恢复失败：{{message}}', { message: (err as Error).message }));
    }
    current();
    tab.viewportOverride = null;
  }

  /** 换代重应用（guestAttach 新 guest 接线后调用；fire-and-forget，失败忽略） */
  private reapplyViewportOverride(tabId: string): void {
    const size = this.tabs.get(tabId)?.viewportOverride;
    if (!size) return;
    void this.setViewport(tabId, size.width, size.height).catch(() => {});
  }

  /** 元素拾取：注入激活标签，等用户点击（Esc/取消 null）；元素截图（区域裁剪）随事件推送。
   *  激活标签是空白页时先切到第一个有内容的标签（拾取空白页无意义）。 */
  async pick(): Promise<void> {
    const cur = this.activeId ? this.tabs.get(this.activeId) : null;
    if (cur && (!cur.url || cur.url === 'about:blank')) {
      const next = this.order
        .map((id) => this.tabs.get(id))
        .find((t) => t && t.url && t.url !== 'about:blank');
      if (next) this.activate(next.id);
      else {
        this.getWindow()?.webContents.send('browser:picked', null);
        return;
      }
    }
    const tabId = this.activeId;
    if (!tabId) {
      this.getWindow()?.webContents.send('browser:picked', null);
      return;
    }
    const wc = await this.ensureGuest(tabId).catch(() => null);
    if (!wc) {
      this.getWindow()?.webContents.send('browser:picked', null);
      return;
    }
    // Read the current host's final roles; no second palette is reconstructed in the guest.
    const defaults = DEFAULT_RESOLVED_DARK.cssVars;
    let appearance: BrowserPickerAppearance = {
      background: defaults['--surface-overlay']!, foreground: defaults['--overlay-fg-primary']!,
      shadow: defaults['--shadow-pop']!, indicator: defaults['--status-info-fg']!, fill: defaults['--scan-selected-bg']!
    };
    const host = this.getWindow()?.webContents;
    if (host && !host.isDestroyed()) {
      const current = await host.executeJavaScript(`(() => {
        const style = getComputedStyle(document.documentElement), value = key => style.getPropertyValue(key).trim();
        return { background:value('--surface-overlay'), foreground:value('--overlay-fg-primary'),
          shadow:value('--shadow-pop'), indicator:value('--status-info-fg'), fill:value('--scan-selected-bg') };
      })()`).catch(() => null) as Partial<BrowserPickerAppearance> | null;
      if (current) for (const key of Object.keys(appearance) as (keyof BrowserPickerAppearance)[]) {
        if (typeof current[key] === 'string' && current[key]) appearance[key] = current[key]!;
      }
    }
    void wc
      .executeJavaScript(buildBrowserPickerScript(appearance), true)
      .then(async (raw: unknown) => {
        if (!raw || typeof raw !== 'object') {
          this.getWindow()?.webContents.send('browser:picked', null);
          return;
        }
        const info = raw as {
          selector: string;
          tag: string;
          id: string;
          text: string;
          url: string;
          rect: { x: number; y: number; w: number; h: number };
        };
        // 元素截图：整页 capturePage 后按元素区域裁剪（capturePage 是物理像素，
        // 与 CSS 视口的比值即 dpr——经 innerWidth 求得）；失败不阻塞拾取（shot 空串）
        let shot = '';
        try {
          const img = await wc.capturePage();
          const cssW = (await wc.executeJavaScript('innerWidth', true)) as number;
          const dpr = cssW > 0 ? img.getSize().width / cssW : 1;
          const r = info.rect;
          const w = Math.max(1, Math.round(r.w * dpr));
          const h = Math.max(1, Math.round(r.h * dpr));
          const cropped = img.crop({
            x: Math.max(0, Math.round(r.x * dpr)),
            y: Math.max(0, Math.round(r.y * dpr)),
            width: Math.min(w, img.getSize().width),
            height: Math.min(h, img.getSize().height)
          });
          shot = cropped.isEmpty() ? '' : cropped.toDataURL();
        } catch {
          /* 截图失败仅降级无图 */
        }
        this.getWindow()?.webContents.send('browser:picked', { ...info, shot });
      })
      .catch(() => {
        this.getWindow()?.webContents.send('browser:picked', null);
      });
  }

  /** 取消拾取（再次点按钮/切页时） */
  async cancelPick(): Promise<void> {
    const wc = this.activeId ? this.liveGuest(this.activeId) : null;
    await wc?.executeJavaScript('window.__maPickCancel&&window.__maPickCancel();0').catch(() => {});
  }

  // ── CDP 桥（agent 操控通道） ──

  /** Only return an endpoint after it reports the current app window's native target. */
  async cdpPort(): Promise<number> {
    const state = getBrowserCdpBootState();
    if (state.kind === 'disabled') return 0;
    if (state.kind === 'error') {
      if (state.reason === 'invalid-port') {
        throw new Error(t('浏览器 CDP 端口配置无效，请将 MUSTER_DEVTOOLS_PORT 设为 1–65535 并重启工作台'));
      }
      throw new Error(t('浏览器 CDP 启动失败，请重启工作台'));
    }
    if (!this.cdpPortFlight) {
      // A port-0 boot gets its real port from Chromium. Re-read on every retry:
      // an old DevToolsActivePort file must never identify another process.
      const port = state.port || (() => readDevToolsActivePort(userDataStorage(app.getPath('userData')).file('devtools-port')));
      this.cdpPortFlight = waitForOwnedCdpEndpoint(port, () => {
        const win = this.getWindow();
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
        try { return win.webContents.getOrCreateDevToolsTargetId(); } catch { return null; }
      }).catch((error: unknown) => {
        if (error instanceof CdpEndpointUnavailableError) {
          if (!error.port) throw new Error(t('浏览器 CDP 端口未能启动，请重启工作台'));
          throw new Error(t('浏览器 CDP 端口 {{port}} 不可用或不属于当前工作台，请重启；若设置了 MUSTER_DEVTOOLS_PORT，请检查端口占用', { port: error.port }));
        }
        throw error;
      });
    }
    const flight = this.cdpPortFlight;
    try { return await flight; }
    finally { if (this.cdpPortFlight === flight) this.cdpPortFlight = null; }
  }

  cdpEnabledInConfig(): boolean {
    return this.config.get().browser?.cdpEnabled !== false;
  }
}
