import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/**
 * 浏览器 Agent 工具面（browser.*）：playwright-core 经 CDP 类型改写代理驱动内置
 * 浏览器的独立后台页面——ariaSnapshot/locator/自动等待全部复用 Playwright。
 *
 * webview guest 的 DevTools target type 是 "webview"，playwright 页面发现只认
 * "page"：连接必须经 cdpTypeProxy（协议层改写类型标签，与 playwright 版本解耦）。
 *
 * tabId → Page 按已绑定 guest 的 CDP targetId 对齐，不依赖网页可修改的标记或 URL。
 * 修改操作经每页 FIFO；不同页并行。后台点击与键盘走无 userGesture 的固定 DOM 语义。
 * 不做审批门（用户决策 2026-09-07：真实使用中确认弹窗不会被认真对待）。
 *
 * JS 弹窗由 guest preload 的同步桥处理；子帧原生弹窗由 tabs 服务的 CDP 会话管理。
 *
 * R2 起 catalog 面收敛为 browser.run 单入口：本类是各动作的内部执行真源，
 * 用法文档在 ~/.muster/skills/browser/SKILL.md（browserHelp.ts 保留作参考数据）。
 */
import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type CDPSession, type Locator, type Page } from 'playwright-core';
import { BrowserTabService, normalizeUrlInput } from './tabs';
import { DEFAULT_RENDER_DURATION_MS, DEFAULT_RENDER_FPS, DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from './browserRecording';
import { startCdpTypeProxy, type CdpTypeProxy } from './cdpTypeProxy';
import { captureFullPageScreenshot } from './fullPageScreenshot';
import {
  BrowserCapabilityUnsupportedError,
  buildProtectedEvaluateScript,
  formatSemanticTargetError,
  parseCoordinatePair,
  performSemanticCoordinateClick,
  performSemanticDrag,
  performSemanticPageKey,
  performSemanticScroll,
  semanticElementAction
} from './semanticActions';
import { t } from '../../shared/i18n';

const CLICK_TIMEOUT_MS = 8000;
const DEFAULT_SNAPSHOT_MAX_CHARS = 9000;
const MIN_SNAPSHOT_MAX_CHARS = 500;
const MAX_SNAPSHOT_MAX_CHARS = 10_000;
const MAX_RENDER_FRAMES = 1_500;
const MAX_RENDER_DURATION_MS = 120_000;
const SCREENSHOT_SURFACE_SETTLE_MS = 50;
const MUTATIONS = new Set([
  'click',
  'fill',
  'select',
  'scroll',
  'hover',
  'movePointer',
  'pressKey',
  'drag',
  'evaluate',
  'upload',
  'storage',
  'setViewport',
  'resetViewport',
  'screenshot'
]);
export type BrowserActor = { workspaceId?: string; sessionId?: string };

function normalizeRenderTimesForTool(times: number[] | undefined, durationMs: unknown, fps: unknown): number[] {
  if (times !== undefined) {
    if (!Array.isArray(times)) throw new Error(t('tasks.render times 必须是数组'));
    return times.map(value => Number(value));
  }
  const duration = Math.max(0, Math.min(MAX_RENDER_DURATION_MS, Math.floor(Number(durationMs ?? DEFAULT_RENDER_DURATION_MS))));
  const rate = Math.max(1, Math.min(60, Math.floor(Number(fps ?? DEFAULT_RENDER_FPS))));
  const total = Math.min(MAX_RENDER_FRAMES, Math.floor(duration * rate / 1000) + 1);
  return Array.from({ length: Math.max(1, total) }, (_, index) => Math.min(duration, Math.round(index * 1000 / rate)));
}

const INTERACTIVE_ROLE_RE = /\b(button|link|textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|menuitem|menuitemcheckbox|menuitemradio|option|tab|treeitem|heading|navigation|main|dialog|alertdialog|form|banner|search|region)\b/i;

/** 过滤无障碍树快照：仅保留带 [ref=...] 的可交互节点及关键地标/标题行 */
export function filterInteractiveSnapshot(snap: string): string {
  if (!snap) return snap;
  const lines = snap.split('\n');
  const kept = lines.filter((line) => line.includes('[ref=') || INTERACTIVE_ROLE_RE.test(line));
  return kept.length ? kept.join('\n') : snap;
}

/** 按预算安全截取快照文本（优先在换行处截断，避免截断 [ref=eN] 标记） */
export function sliceSnapshotWithinBudget(
  snap: string,
  offset = 0,
  maxChars = DEFAULT_SNAPSHOT_MAX_CHARS
): { slice: string; offset: number; nextOffset?: number; totalChars: number; truncated: boolean } {
  const totalChars = snap.length;
  const safeOffset = Math.max(0, Math.min(totalChars, Math.floor(Number(offset) || 0)));
  const budget = Math.max(
    MIN_SNAPSHOT_MAX_CHARS,
    Math.min(MAX_SNAPSHOT_MAX_CHARS, Math.floor(Number(maxChars) || DEFAULT_SNAPSHOT_MAX_CHARS))
  );
  if (safeOffset === 0 && totalChars <= budget) {
    return { slice: snap, offset: 0, totalChars, truncated: false };
  }
  let end = Math.min(totalChars, safeOffset + budget);
  if (end < totalChars) {
    const nl = snap.lastIndexOf('\n', end);
    if (nl > safeOffset + Math.floor(budget * 0.5)) {
      end = nl + 1;
    }
  }
  const slice = snap.slice(safeOffset, end);
  return {
    slice,
    offset: safeOffset,
    ...(end < totalChars ? { nextOffset: end } : {}),
    totalChars,
    truncated: end < totalChars || safeOffset > 0
  };
}

export class BrowserAgentTools {
  private pw: Browser | null = null;
  /** 进行中的 connectOverCDP：冷启动并发工具调用只建一条连接（否则先建的成孤儿） */
  private connecting: Promise<Browser> | null = null;
  /** CDP 类型改写代理（webview target type → page）：随首条连接懒启动 */
  private proxy: CdpTypeProxy | null = null;
  /** 每 tab 在途动作计数：并发动作时先结束者不得误报空闲/提前恢复节流 */
  private actCounts = new Map<string, number>();
  private selectedTabs = new Map<string, string>();
  private nativeDialogPages = new WeakSet<Page>();
  private capturesDir: string;

  constructor(
    private tabs: BrowserTabService,
    private getWindow: () => BrowserWindow | null,
    userDataDir: string
  ) {
    this.capturesDir = userDataStorage(userDataDir).resolve('app', 'browser-captures');
  }

  // ── 连接与 tabId 解析 ──

  private async ensurePw(): Promise<Browser> {
    if (this.pw && this.pw.isConnected()) return this.pw;
    this.connecting ??= this.connectPw();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connectPw(): Promise<Browser> {
    const upstream = await this.tabs.cdpPort();
    if (!upstream) throw new Error(t('浏览器 CDP 端口未开启：请在设置中恢复 browser.cdpEnabled 后重启'));
    if (!this.proxy) this.proxy = await startCdpTypeProxy(upstream);
    this.pw = await chromium.connectOverCDP(`http://127.0.0.1:${this.proxy.port}`);
    return this.pw;
  }

  private async pageFor(tabId: string): Promise<{ page: Page; guestId: number; connection: Browser }> {
    const snap = this.tabs.snapshot();
    const tab = snap.tabs.find((x) => x.id === tabId);
    if (!tab) {
      throw new Error(t('浏览器标签不存在：{{id}}（先用 browser.tabs 列出可用标签）', { id: tabId }));
    }
    const guest = await this.tabs.ensureGuest(tabId);
    if (!guest) {
      throw new Error(t('浏览器标签尚未挂载：{{id}}（稍等页面就绪后重试）', { id: tabId }));
    }
    // Electron 原生 getter 不依赖 debugger 会话，打开 DevTools 后也可查询。
    // 网页删除/篡改 window.__maBrowserTab、两个标签 URL 相同都不会改变归属。
    let targetId: string;
    try {
      targetId = guest.getOrCreateDevToolsTargetId();
    } catch (err) {
      throw new Error(t('浏览器标签 CDP 身份查询失败：{{id}}（{{reason}}）', {
        id: tabId,
        reason: err instanceof Error ? err.message : String(err)
      }));
    }
    if (typeof targetId !== 'string' || !targetId) {
      throw new Error(t('浏览器标签 CDP 身份尚未就绪：{{id}}', { id: tabId }));
    }
    const pw = await this.ensurePw();
    // guest 已绑定时 Playwright 的 target 发现仍可能在途，只等待同一个 target。
    let lastTargetError: string | null = null;
    const discoveredTargets = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const pages: Page[] = [];
      for (const c of pw.contexts()) pages.push(...c.pages());
      for (const p of pages) {
        let session: CDPSession | null = null;
        let matched = false;
        try {
          session = await p.context().newCDPSession(p);
          const { targetInfo } = await session.send('Target.getTargetInfo');
          if (targetInfo?.targetId) discoveredTargets.add(targetInfo.targetId);
          matched = targetInfo?.targetId === targetId;
        } catch (error) {
          lastTargetError = error instanceof Error ? error.message : String(error);
          /* target 发现与关闭竞态：不退回 URL 或网页标记猜测 */
        } finally {
          await session?.detach().catch(() => {});
        }
        if (matched) {
          this.requireCurrentGuest(tabId, guest.id);
          return { page: p, guestId: guest.id, connection: pw };
        }
      }
      this.requireCurrentGuest(tabId, guest.id);
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(t('浏览器标签尚未就绪：CDP 未发现目标 {{targetId}}（tabId={{tabId}}，已发现 {{count}} 个目标）{{reason}}', {
      targetId, tabId, count: discoveredTargets.size,
      reason: lastTargetError ? `；Target 查询错误：${lastTargetError}` : ''
    }));
  }

  private requireCurrentGuest(tabId: string, guestId: number): void {
    if (!this.tabs.isCurrentGuest(tabId, guestId)) {
      throw new Error(t('浏览器标签已关闭或重新挂载：{{id}}（稍等页面就绪后重试）', { id: tabId }));
    }
  }

  /** 动作类工具（activate/navigate 等不经 pageFor 的）先校验标签存在，防静默假成功 */
  private requireTab(tabId: string): void {
    const snap = this.tabs.snapshot();
    if (!snap.tabs.some((x) => x.id === tabId)) {
      throw new Error(t('浏览器标签不存在：{{id}}（先用 browser.tabs 列出可用标签）', { id: tabId }));
    }
  }

  /** 快照 ref 判定：主 frame 元素是 e12 形式；非主 frame（iframe、导航/target 重建后
   *  序号上浮的主 frame）元素带 f{seq} 帧前缀，如 f3e13（Playwright injected script
   *  refPrefix，mode:'ai' 专属）。两种形式都透传给 aria-ref=，选择器引擎会按帧 seq
   *  跳帧解析（_jumpToAriaRefFrameIfNeeded）——绝不能当 CSS 选择器传，否则必超时。 */
  private static REF_RE = /^(?:f\d+)?e\d+$/;

  private locatorFor(page: Page, target: unknown): Locator {
    const ref = String(target ?? '').trim();
    if (!ref) throw new Error(t('target 不能为空：传 browser.snapshot 返回的 ref（如 e12 或 f3e13）或 CSS 选择器'));
    return page.locator(BrowserAgentTools.REF_RE.test(ref) ? `aria-ref=${ref}` : ref);
  }

  // ── 状态条 ──

  private emitAgent(active: boolean, action: string | null, tabId: string | null): void {
    this.getWindow()?.webContents.send('browser:agentState', { active, action, tabId });
  }

  /** playwright 连接建于 guest 崩溃前时，该 target 的 Page session 永久失效
   *  （connectOverCDP 不会为同 target 重建 session，evaluate 恒报 Target crashed）。
   *  崩溃自动恢复（wc.reload）后页面已活——重连一次即拿到新 session，工具链复活。 */
  private static DEAD_PAGE_RE = /Target (crashed|closed|disposed)/i;

  private async reviveConnection(failedConnection: Browser): Promise<void> {
    // 并发调用可能同时发现旧 Page 已死：只断开它们实际使用的连接，
    // 后发现者复用 ensurePw 的新连接 flight，不能再关闭刚重建的连接。
    if (this.pw !== failedConnection) return;
    this.pw = null;
    await failedConnection.close().catch(() => {});
  }

  /** 只读常量探测 Page 自身的 session，必须在任何业务动作/焦点操作之前。
   *  避免在弹窗阻塞或协议无响应时无限等待；超时的探测没有网页副作用。 */
  private async assertPageSession(page: Page): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        page.evaluate('0'),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(t('浏览器页面脚本探测超时（{{timeout}}ms）：CDP 已连接，但页面未响应；请检查待处理弹窗或页面脚本阻塞', { timeout: CLICK_TIMEOUT_MS }))), CLICK_TIMEOUT_MS);
        })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * Chromium cannot capture a webview surface whose host element is CSS-hidden.
   * Background browser tabs use that presentation to stay out of hit testing,
   * so briefly expose only the target surface while retaining inert, pointer
   * isolation, and the background tab identity. The returned cleanup checks
   * that the tab stayed in the same presentation before restoring the style.
   */
  private async prepareScreenshotSurface(tabId: string): Promise<(() => Promise<void>) | null> {
    const win = this.getWindow();
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) ||
        (typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed()) ||
        typeof win.webContents.executeJavaScript !== 'function') return null;
    const request = JSON.stringify(tabId);
    const state = await win.webContents.executeJavaScript(`(() => {
      const tabId = ${request};
      const view = Array.from(document.querySelectorAll('webview')).find(node => node.getAttribute('data-tab-id') === tabId);
      if (!(view instanceof HTMLElement) || view.dataset.browserPresentation !== 'background' || getComputedStyle(view).visibility !== 'hidden') return null;
      const previousVisibility = view.style.visibility;
      view.style.visibility = 'visible';
      return { previousVisibility };
    })()`, true) as { previousVisibility?: string } | null;
    if (!state) return null;
    await new Promise<void>(resolve => setTimeout(resolve, SCREENSHOT_SURFACE_SETTLE_MS));
    return async () => {
      const currentWindow = this.getWindow();
      if (!currentWindow || (typeof currentWindow.isDestroyed === 'function' && currentWindow.isDestroyed()) ||
          (typeof currentWindow.webContents.isDestroyed === 'function' && currentWindow.webContents.isDestroyed()) ||
          typeof currentWindow.webContents.executeJavaScript !== 'function') return;
      const previousVisibility = JSON.stringify(state.previousVisibility ?? '');
      await currentWindow.webContents.executeJavaScript(`(() => {
        const tabId = ${request};
        const view = Array.from(document.querySelectorAll('webview')).find(node => node.getAttribute('data-tab-id') === tabId);
        if (!(view instanceof HTMLElement) || view.dataset.browserPresentation !== 'background') return;
        view.style.visibility = ${previousVisibility};
      })()`, true).catch(() => {});
    };
  }

  private async withAct<T>(
    tabId: string,
    action: string,
    fn: (page: Page, assertGuestCurrent: () => void, signal: AbortSignal) => Promise<T>,
    serialize = MUTATIONS.has(action)
  ): Promise<T> {
    const perform = () => this.performAct(tabId, action, fn);
    return serialize ? this.tabs.runOperation(tabId, perform) : perform();
  }

  private async performAct<T>(
    tabId: string,
    action: string,
    fn: (page: Page, assertGuestCurrent: () => void, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const prepare = async () => {
      let target = await this.pageFor(tabId);
      const originalGuestId = target.guestId;
      // The private CDP proxy strips Playwright's userGesture flag. Still prepare
      // the target's permanent native-picker guard before any injected script.
      await this.tabs.prepareAgentInput(tabId);
      this.requireCurrentGuest(tabId, originalGuestId);
      try {
        await this.assertPageSession(target.page);
      } catch (first) {
        if (!BrowserAgentTools.DEAD_PAGE_RE.test(String((first as Error)?.message))) throw first;
        await this.reviveConnection(target.connection);
        this.requireCurrentGuest(tabId, originalGuestId);
        target = await this.pageFor(tabId);
        await this.tabs.prepareAgentInput(tabId);
        this.requireCurrentGuest(tabId, originalGuestId);
        await this.assertPageSession(target.page);
      }
      this.requireCurrentGuest(tabId, originalGuestId);
      const { page, guestId } = target;
      if (!this.nativeDialogPages.has(page)) {
        // The guest debugger owns native dialog replies after Page.enable.
        page.on('dialog', dialog => {
          if (dialog.type() === 'beforeunload') {
            void dialog.accept().catch(() => {});
          } else if (!this.tabs.handlesNativeDialogs(tabId, guestId)) {
            void dialog.dismiss().catch(() => {});
          }
        });
        this.nativeDialogPages.add(page);
      }
      return target;
    };
    const n = (this.actCounts.get(tabId) ?? 0) + 1;
    this.actCounts.set(tabId, n);
    const controller = new AbortController();
    let dialogWatch: { promise: Promise<void>; cancel: () => void } | undefined;
    let actionStarted = false;
    try {
      this.emitAgent(true, action, tabId);
      if (this.tabs.pendingDialogs(tabId).length) throw new Error('__MA_DIALOG_INTERCEPTED__');
      // A page script can open a dialog even before dom-ready. Race the probe
      // as well as the action so the caller can respond while JS is suspended.
      dialogWatch = action !== 'upload' && typeof (this.tabs as { waitForDialog?: unknown }).waitForDialog === 'function'
        ? this.tabs.waitForDialog(tabId)
        : undefined;
      const interrupted = dialogWatch?.promise.then((): never => {
        const error = new Error('__MA_DIALOG_INTERCEPTED__');
        controller.abort(error);
        throw error;
      });
      const { page, guestId } = await (interrupted ? Promise.race([prepare(), interrupted]) : prepare());
      this.tabs.setAgentBusy(tabId, true);
      this.requireCurrentGuest(tabId, guestId);
      actionStarted = true;
      const running = fn(page, () => this.requireCurrentGuest(tabId, guestId), controller.signal);
      const result = await (interrupted ? Promise.race([running, interrupted]) : running);
      const dialogs = this.tabs.pendingDialogs(tabId);
      if (dialogs.length && action !== 'snapshot') {
        return {
          ...(result && typeof result === 'object' ? result : { ok: true }),
          pendingDialogs: dialogs,
          note: t('动作触发了 JS 弹窗并已排队，处理完（browser.dialog）后页面才会继续')
        } as T;
      }
      const note = this.tabs.fileChooserNotice(tabId);
      return note && result && typeof result === 'object' ? { ...result, note } : result;
    } catch (err) {
      const dialogs = this.tabs.pendingDialogs(tabId);
      if (dialogs.length) {
        if (action === 'snapshot') return {
          snapshot: '', pendingDialogs: dialogs,
          note: t('页面有未处理的 JS 弹窗（alert/confirm/prompt），先调 browser.dialog 处理再取快照')
        } as T;
        if (action === 'upload' && actionStarted) return {
          ok: false, assignment: 'unknown', upload: 'unverified', pendingDialogs: dialogs,
          note: 'The file assignment outcome is unknown; inspect the page before retrying.'
        } as T;
        return {
          ok: actionStarted && action !== 'screenshot',
          mode: action === 'movePointer' ? 'pointer' : 'semantic',
          trusted: action === 'movePointer',
          pendingDialogs: dialogs,
          note: t('动作触发了 JS 弹窗并已排队，处理完（browser.dialog）后页面才会继续')
        } as T;
      }
      throw err;
    } finally {
      dialogWatch?.cancel();
      const left = (this.actCounts.get(tabId) ?? 1) - 1;
      if (left <= 0) {
        this.actCounts.delete(tabId);
        this.tabs.setAgentBusy(tabId, false);
        // 还有其他 tab 的动作在途时不推空闲（先结束者会把进行中的动作误报为完成）
        if (this.actCounts.size === 0) this.emitAgent(false, null, null);
      } else {
        this.actCounts.set(tabId, left);
      }
    }
  }

  // ── 工具实现（hosts/browser.ts 薄壳直调） ──

  tabsList(): unknown {
    return this.tabs.snapshot();
  }

  open(url?: string, owner?: BrowserActor): unknown {
    const raw = url ? String(url).trim() : '';
    // 与 IPC 通路同归一化（catalog 承诺「也可传搜索词」）：scheme-less 会被 loadURL 拒绝
    const id = this.tabs.createTab(raw ? normalizeUrlInput(raw) : 'about:blank', { ...owner, scope: 'session' }, { background: true });
    this.selectedTabs.set(this.actorKey(owner), id);
    return { id };
  }

  /** 关闭对不存在 tabId 幂等静默（与 activate/navigate 的 requireTab 报错不同）：
   *  关到「已经没了」与关成功对 agent 等价，报错反而逼它多查一轮 */
  closeTab(tabId: string): void {
    this.tabs.closeTab(tabId);
    for (const [actor, selected] of this.selectedTabs) if (selected === tabId) this.selectedTabs.delete(actor);
  }

  async activate(tabId: string, owner?: BrowserActor, opts?: { foreground?: boolean }): Promise<unknown> {
    this.requireTab(tabId);
    if (!await this.tabs.ensureGuest(tabId)) throw new Error(t('浏览器后台页面不可用'));
    this.requireTab(tabId);
    this.selectedTabs.set(this.actorKey(owner), tabId);
    if (opts?.foreground) {
      this.tabs.activate(tabId);
      return { ok: true, background: false, foreground: true };
    }
    return { ok: true, background: true };
  }

  async navigate(tabId: string, input: string): Promise<unknown> {
    this.requireTab(tabId);
    await this.tabs.runOperation(tabId, () => this.tabs.navigate(tabId, normalizeUrlInput(String(input ?? ''))));
    return { ok: true };
  }

  async snapshot(
    tabId: string,
    opts?: {
      selector?: string;
      interactiveOnly?: boolean;
      maxChars?: number;
      offset?: number;
    }
  ): Promise<unknown> {
    // 有待处理弹窗时页面 JS 被 sendSync 阻塞（ariaSnapshot 拿不到），直接引导先处理弹窗
    const dialogs = this.tabs.pendingDialogs(tabId);
    if (dialogs.length) {
      return {
        snapshot: '',
        pendingDialogs: dialogs,
        note: t('页面有未处理的 JS 弹窗（alert/confirm/prompt），先调 browser.dialog 处理再取快照')
      };
    }
    return this.withAct(tabId, 'snapshot', async (page) => {
      const scopeSelector = opts?.selector ? String(opts.selector).trim() : '';
      let snap = '';
      if (scopeSelector) {
        const loc = this.locatorFor(page, scopeSelector);
        try {
          if (typeof (loc as unknown as { ariaSnapshot?: (o: { mode: string }) => Promise<string> }).ariaSnapshot === 'function') {
            snap = await (loc as unknown as { ariaSnapshot: (o: { mode: string }) => Promise<string> }).ariaSnapshot({ mode: 'ai' });
          } else {
            snap = await page.ariaSnapshot({ mode: 'ai' });
          }
        } catch (err) {
          throw formatSemanticTargetError(scopeSelector, err);
        }
      } else {
        // mode:'ai' 才带 [ref=eN] 引用。已知边界（2026-09-07 实测）：新开页面的 ref 分配
        // 可能延迟数分钟（playwright 注入与 Chromium AX 构建的时序，reload 也会重置）；
        // 轮询 10s 兜不住时返回无 ref 树 + 提示 agent 走 CSS 选择器或稍后重试。
        for (let i = 0; i < 20; i++) {
          snap = await page.ariaSnapshot({ mode: 'ai' });
          if (snap.includes('[ref=') || (snap && i >= 16)) break;
          if (typeof page.waitForTimeout === 'function') {
            await page.waitForTimeout(500);
          }
        }
      }
      if (opts?.interactiveOnly) {
        snap = filterInteractiveSnapshot(snap);
      }
      const hasRefs = snap.includes('[ref=');
      const sliced = sliceSnapshotWithinBudget(snap, opts?.offset, opts?.maxChars);
      const notes: string[] = [];
      const blockedNotice = this.tabs.fileChooserNotice(tabId);
      if (blockedNotice) notes.push(blockedNotice);
      if (!hasRefs && !scopeSelector) {
        notes.push(
          t('该页面的元素引用（ref）尚未就绪（新页面常见，需等待约一两分钟）；本次快照无 ref，target 可改用 CSS 选择器，或稍后重试 browser.snapshot')
        );
      }
      if (sliced.truncated) {
        notes.push(
          t('快照全文共 {{total}} 字符，本次返回 [{{start}}..{{end}}) 段以避免超出 12KB 上限；可传 selector（如 "main"/"#app"）缩小范围、传 interactiveOnly:true 仅看交互元素，或传 offset:{{next}} 分页续读', {
            total: sliced.totalChars,
            start: sliced.offset,
            end: sliced.offset + sliced.slice.length,
            next: sliced.nextOffset ?? sliced.totalChars
          })
        );
      }
      const consoleErrors = this.tabs.consoleEntries(tabId).filter((e) => e.level === 'error').length;
      return {
        snapshot: sliced.slice,
        url: page.url(),
        ...(sliced.truncated
          ? {
              truncated: true,
              totalChars: sliced.totalChars,
              offset: sliced.offset,
              ...(sliced.nextOffset != null ? { nextOffset: sliced.nextOffset } : {})
            }
          : {}),
        ...(dialogs.length ? { pendingDialogs: dialogs } : {}),
        ...(consoleErrors ? { consoleErrors } : {}),
        ...(notes.length ? { note: notes.join('；') } : {})
      };
    });
  }

  async click(tabId: string, target: string): Promise<unknown> {
    const point = parseCoordinatePair(target);
    return this.withAct(tabId, 'click', async (page) => {
      if (point) {
        const result = await page.evaluate(performSemanticCoordinateClick, point);
        if (!result.ok) {
          if (result.code === 'capability_unsupported') throw new BrowserCapabilityUnsupportedError('click', result.error);
          throw new Error(`semantic_action_failed: ${result.error}`);
        }
      } else {
        await semanticElementAction(this.locatorFor(page, target), { action: 'click' }, CLICK_TIMEOUT_MS, target);
      }
      return { ok: true, mode: 'semantic', trusted: false };
    });
  }

  async fill(tabId: string, target: string, text: string): Promise<unknown> {
    return this.withAct(tabId, 'fill', async (page) => {
      await semanticElementAction(this.locatorFor(page, target), { action: 'fill', text: String(text ?? '') }, CLICK_TIMEOUT_MS, target);
      return { ok: true, mode: 'semantic', trusted: false,
        note: t('已按 DOM 语义填值并发送合成 input/change；依赖可信输入、光标或专有编辑器模型的页面需手动操作') };
    });
  }

  async selectOption(tabId: string, target: string, value: string): Promise<unknown> {
    return this.withAct(tabId, 'select', async (page) => {
      await semanticElementAction(this.locatorFor(page, target), { action: 'select', value: String(value ?? '') }, CLICK_TIMEOUT_MS, target);
      return { ok: true, mode: 'semantic', trusted: false };
    });
  }

  async pressKey(tabId: string, key: string, target?: string): Promise<unknown> {
    const k = String(key ?? '').trim();
    if (!k) throw new Error(t('key 不能为空'));
    return this.withAct(tabId, 'pressKey', async (page) => {
      if (target && String(target).trim()) {
        await semanticElementAction(this.locatorFor(page, target), { action: 'pressKey', key: k }, CLICK_TIMEOUT_MS, target);
      } else {
        const res = await page.evaluate(performSemanticPageKey, k);
        if (res && typeof res === 'object' && 'ok' in res && !res.ok) {
          if (res.code === 'capability_unsupported') throw new BrowserCapabilityUnsupportedError('pressKey', res.error);
          throw new Error(`semantic_action_failed: ${res.error}`);
        }
      }
      return { ok: true, mode: 'semantic', trusted: false };
    });
  }

  async hover(tabId: string, target: string): Promise<unknown> {
    return this.withAct(tabId, 'hover', async (page) => {
      await semanticElementAction(this.locatorFor(page, target), { action: 'hover' }, CLICK_TIMEOUT_MS, target);
      return { ok: true, mode: 'semantic', trusted: false };
    });
  }

  async movePointer(tabId: string, target: string): Promise<unknown> {
    const point = parseCoordinatePair(target);
    if (!point || point.x < 0 || point.y < 0) throw new Error('movePointer requires viewport coordinates "x,y"');
    return this.withAct(tabId, 'movePointer', async (page, assertGuestCurrent) => {
      const viewport = await page.evaluate(() => {
        const { innerWidth, innerHeight } = globalThis as unknown as { innerWidth: number; innerHeight: number };
        return { width: innerWidth, height: innerHeight };
      });
      if (point.x >= viewport.width || point.y >= viewport.height) throw new Error('movePointer coordinates are outside the page viewport');
      assertGuestCurrent();
      await this.tabs.moveGuestPointer(tabId, point);
      return { ok: true, mode: 'pointer', trusted: true };
    });
  }

  async scroll(tabId: string, direction: 'up' | 'down', amount?: number, target?: string): Promise<unknown> {
    return this.withAct(tabId, 'scroll', async (page) => {
      const delta = Math.max(50, Math.min(4000, Math.round(Number(amount) || 600)));
      const signedDelta = direction === 'up' ? -delta : delta;
      if (target !== undefined) {
        await semanticElementAction(this.locatorFor(page, target), { action: 'scroll', delta: signedDelta }, CLICK_TIMEOUT_MS, target);
      } else {
        await page.evaluate(performSemanticScroll, signedDelta);
      }
      return { ok: true, mode: 'semantic', trusted: false };
    });
  }

  async waitFor(
    tabId: string,
    opts: {
      text?: string;
      selector?: string;
      url?: string;
      hiddenSelector?: string;
      state?: 'load' | 'domcontentloaded' | 'networkidle';
      timeoutMs?: number;
      timeMs?: number;
    }
  ): Promise<unknown> {
    const hasCondition = Boolean(
      opts?.selector || opts?.hiddenSelector || opts?.text || opts?.url || opts?.state
    );
    // 纯时间等待（timeMs）不依赖页面挂载或加载就绪：导航在途或站点慢响应时仍可正常等待
    if (!hasCondition) {
      this.requireTab(tabId);
      const ms = Math.max(100, Math.min(30_000, Number(opts?.timeMs) || 1000));
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, met: 'time' };
    }
    return this.withAct(tabId, 'wait', async (page) => {
      const timeout = Math.max(500, Math.min(30_000, Number(opts?.timeoutMs) || 10_000));
      if (opts?.selector) {
        await page.waitForSelector(String(opts.selector), { timeout, state: 'visible' });
        return { ok: true, met: 'selector' };
      }
      if (opts?.hiddenSelector) {
        await page.waitForSelector(String(opts.hiddenSelector), { timeout, state: 'hidden' });
        return { ok: true, met: 'hiddenSelector' };
      }
      if (opts?.text) {
        await page
          .getByText(String(opts.text))
          .first()
          .waitFor({ state: 'visible', timeout });
        return { ok: true, met: 'text' };
      }
      if (opts?.url) {
        const raw = String(opts.url);
        const regex = /^\/(.+)\/([gimsu]*)$/.exec(raw);
        await page.waitForURL(regex ? new RegExp(regex[1], regex[2]) : raw, { timeout });
        return { ok: true, met: 'url', url: page.url() };
      }
      if (opts?.state) {
        await page.waitForLoadState(opts.state, { timeout });
        return { ok: true, met: 'state', state: opts.state };
      }
      const ms = Math.max(100, Math.min(30_000, Number(opts?.timeMs) || 1000));
      await page.waitForTimeout(ms);
      return { ok: true, met: 'time' };
    });
  }

  /** 截图落盘（previewPath 供 UI 展示卡片，同时返回 path 供支持视觉/读图的模型直接读取） */
  async screenshot(
    tabId: string,
    opts?: { selector?: string; fullPage?: boolean }
  ): Promise<unknown> {
    return this.withAct(tabId, 'screenshot', async (page, assertGuestCurrent, signal) => {
      const restoreSurface = await this.prepareScreenshotSurface(tabId);
      let buf: Buffer;
      try {
        const scopeSelector = opts?.selector ? String(opts.selector).trim() : '';
        if (scopeSelector) {
          const loc = this.locatorFor(page, scopeSelector);
          try {
            buf = typeof (loc as unknown as { screenshot?: (o: { type: 'png' }) => Promise<Buffer> }).screenshot === 'function'
              ? await (loc as unknown as { screenshot: (o: { type: 'png' }) => Promise<Buffer> }).screenshot({ type: 'png' })
              : await page.screenshot({ type: 'png' });
          } catch (err) {
            throw formatSemanticTargetError(scopeSelector, err);
          }
        } else if (opts?.fullPage) {
          buf = await captureFullPageScreenshot(page, assertGuestCurrent, signal);
        } else buf = await page.screenshot({ type: 'png' });
      } finally {
        await restoreSurface?.();
      }
      signal.throwIfAborted();
      assertGuestCurrent();
      fs.mkdirSync(this.capturesDir, { recursive: true });
      // 随机后缀：同毫秒并发截图不互相覆盖
      const file = path.join(
        this.capturesDir,
        `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
      );
      fs.writeFileSync(file, buf);
      return {
        ok: true,
        path: file,
        previewPath: file,
        note: t('截图已保存至 {{path}}（界面可见；支持读图的模型可直接读取 path 查看画面）', { path: file })
      };
    }).catch(error => {
      const pending = (this.proxy?.stats().pending ?? []).slice(0, 16);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n[screenshot tab=${tabId} fullPage=${Boolean(opts?.fullPage)}; CDP pending: ${pending.map(c => `${c.method} ${c.elapsedMs}ms`).join(', ') || 'none'}]`, { cause: error });
    });
  }

  async evaluate(tabId: string, expression: string): Promise<unknown> {
    const expr = String(expression ?? '').trim();
    if (!expr) throw new Error(t('expression 不能为空'));
    return this.withAct(tabId, 'evaluate', async (page) => {
      const wrapped = buildProtectedEvaluateScript(expr);
      const raw = await page.evaluate(wrapped);
      let value: unknown = raw;
      let truncated = false;
      if (typeof raw === 'string' && raw.length > DEFAULT_SNAPSHOT_MAX_CHARS) {
        value = raw.slice(0, DEFAULT_SNAPSHOT_MAX_CHARS);
        truncated = true;
      } else if (raw && typeof raw === 'object') {
        const json = JSON.stringify(raw);
        if (json.length > DEFAULT_SNAPSHOT_MAX_CHARS) {
          value = json.slice(0, DEFAULT_SNAPSHOT_MAX_CHARS);
          truncated = true;
        }
      }
      return {
        ok: true,
        value,
        mode: 'semantic',
        trusted: false,
        ...(truncated ? { truncated: true, note: t('返回值过长已截断至 {{max}} 字符', { max: DEFAULT_SNAPSHOT_MAX_CHARS }) } : {})
      };
    });
  }

  // ── 扩展能力（低频动作：用法见 browser 技能文档） ──

  /** Assign prepared local file snapshots without opening a native chooser or focusing the page. */
  async upload(tabId: string, target: string, files: string[], expectedHashes: readonly string[], assertCurrent: () => void,
    approve: (destination: { documentUrl: string; frameUrl: string }) => Promise<void>): Promise<unknown> {
    return this.withAct(tabId, 'upload', async (page, assertGuestCurrent) => {
      assertCurrent?.();
      const element = await this.locatorFor(page, target).elementHandle({ timeout: CLICK_TIMEOUT_MS });
      if (!element) throw new Error('Upload input not found');
      try {
        const frame = await element.ownerFrame();
        if (!frame) throw new Error('Upload input frame is unavailable');
        const isConnected = (node: unknown): boolean => (node as { isConnected: boolean }).isConnected;
        const destination = { documentUrl: page.url(), frameUrl: frame.url() };
        await approve(destination);
        assertCurrent();
        assertGuestCurrent();
        if (page.url() !== destination.documentUrl || frame.url() !== destination.frameUrl ||
            !await element.evaluate(isConnected)) throw new Error('Upload target changed during authorization');
        assertCurrent();
        assertGuestCurrent();
        if (page.url() !== destination.documentUrl || frame.url() !== destination.frameUrl) throw new Error('Upload target changed during authorization');
        // Explicit payloads keep browser File contents valid after the private snapshots are removed.
        const payloads = await Promise.all(files.map(async file => ({ name: path.basename(file), mimeType: '', buffer: await fs.promises.readFile(file) })));
        if (payloads.length !== expectedHashes.length || payloads.some((payload, index) =>
          createHash('sha256').update(payload.buffer).digest('hex') !== expectedHashes[index])) {
          throw new Error('Upload file snapshot changed during authorization');
        }
        assertCurrent();
        assertGuestCurrent();
        if (page.url() !== destination.documentUrl || frame.url() !== destination.frameUrl ||
            !await element.evaluate(isConnected)) throw new Error('Upload target changed during authorization');
        assertCurrent();
        assertGuestCurrent();
        try {
          await element.setInputFiles(payloads, { timeout: CLICK_TIMEOUT_MS });
        } catch (error) {
          return { ok: false, assignment: 'unknown', upload: 'unverified',
            note: `File assignment may have occurred; inspect the page before retrying: ${String(error)}` };
        }
        return { ok: true, assignment: 'completed', upload: 'unverified',
          note: 'Files were assigned to the input; verify any server-side upload separately.' };
      } finally {
        await element.dispose().catch(error => console.warn('[browser] upload target cleanup failed:', String(error)));
      }
    });
  }

  async drag(tabId: string, from: string, to: string, timeoutMs?: number): Promise<unknown> {
    const rawFrom = String(from ?? '').trim();
    const rawTo = String(to ?? '').trim();
    if (!rawFrom || !rawTo) throw new Error(t('drag 需要同时提供 from 与 to（元素 ref/CSS 选择器，或 "x,y" 视口坐标）'));
    const fromCoord = parseCoordinatePair(rawFrom);
    const toCoord = parseCoordinatePair(rawTo);
    const timeout = Math.max(500, Math.min(30_000, Number(timeoutMs) || CLICK_TIMEOUT_MS));
    return this.withAct(tabId, 'drag', async (page) => {
      const resolveEndpoint = async (
        raw: string,
        coord: { x: number; y: number } | null,
        isSource: boolean
      ): Promise<{ point: { x: number; y: number }; locator: Locator | null }> => {
        if (coord) return { point: coord, locator: null };
        const loc = this.locatorFor(page, raw);
        let box: { x: number; y: number; width: number; height: number } | null = null;
        try {
          box = await loc.boundingBox({ timeout });
        } catch (err) {
          throw formatSemanticTargetError(raw, err);
        }
        if (!box || box.width <= 0 || box.height <= 0) {
          throw new Error(isSource ? t('拖拽源不可见或无包围盒') : t('拖拽目标不可见或无包围盒'));
        }
        return { point: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, locator: loc };
      };
      const source = await resolveEndpoint(rawFrom, fromCoord, true);
      const target = await resolveEndpoint(rawTo, toCoord, false);
      const fromPoint = source.point;
      const toPoint = target.point;
      const targetToken = target.locator
        ? `drag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : undefined;

      if (target.locator && targetToken) {
        await semanticElementAction(
          target.locator,
          { action: 'markDragTarget', token: targetToken },
          timeout,
          rawTo
        );
      }

      if (source.locator) {
        const dragRes = await semanticElementAction(
          source.locator,
          {
            action: 'drag',
            dx: toPoint.x - fromPoint.x,
            dy: toPoint.y - fromPoint.y,
            ...(targetToken ? { targetToken } : {})
          },
          timeout,
          rawFrom
        );
        if (target.locator && targetToken && dragRes.targetHit === false) {
          await semanticElementAction(
            target.locator,
            { action: 'dropTarget', token: targetToken, dragData: dragRes.dragData },
            timeout,
            rawTo
          );
        }
        return { ok: true, mode: 'semantic', trusted: false, from: fromPoint, to: toPoint };
      }

      const res = await page.evaluate(performSemanticDrag, {
        fromPoint,
        toPoint,
        ...(targetToken ? { targetToken } : {})
      });
      if (res && typeof res === 'object' && 'ok' in res && !res.ok) {
        if (res.code === 'capability_unsupported') throw new BrowserCapabilityUnsupportedError('drag', res.error);
        throw new Error(`semantic_action_failed: ${res.error}`);
      }
      if (target.locator && targetToken && res && typeof res === 'object' && 'ok' in res && res.ok && res.targetHit === false) {
        await semanticElementAction(
          target.locator,
          { action: 'dropTarget', token: targetToken, dragData: res.dragData },
          timeout,
          rawTo
        );
      }
      return { ok: true, mode: 'semantic', trusted: false, from: fromPoint, to: toPoint };
    });
  }

  // ── JS 弹窗（alert/confirm/prompt；队列与策略在 tabs 服务，preload 同步桥） ──

  /** 录屏（browser.recording 粗粒度分组）：start/stop/status/cancel */
  async recording(
    args: { action?: string; tabId?: string; recordingId?: string }
  ): Promise<unknown> {
    const svc = this.tabs.recording();
    const action = args?.action ?? 'status';
    if (action === 'start') {
      const tabId = String(args?.tabId ?? '');
      if (!tabId) throw new Error(t('recording start 需要 tabId（先 browser.tabs 列出）'));
      this.requireTab(tabId);
      const job = await svc.start(tabId);
      return { ok: true, recording: job, note: t('录制已开始（停止后产物为 .webm 文件，经 previewPath 用户可见）') };
    }
    if (action === 'stop') {
      const id = String(args?.recordingId ?? '');
      if (!id) throw new Error(t('recording stop 需要 recordingId（start 返回的 id）'));
      const job = await svc.stop(id);
      return { ok: true, recording: job, ...(job.artifact?.path ? { path: job.artifact.path, previewPath: job.artifact.path } : {}) };
    }
    if (action === 'cancel') {
      const id = String(args?.recordingId ?? '');
      if (!id) throw new Error(t('recording cancel 需要 recordingId'));
      return { ok: svc.cancel(id) };
    }
    if (action === 'status') {
      const id = args?.recordingId ? String(args.recordingId) : '';
      const job = id ? svc.job(id) : null;
      if (id && !job) throw new Error(t('录制任务不存在：{{id}}', { id }));
      return { ok: true, ...(job ? { recording: job } : {}) };
    }
    throw new Error(t('action 只接受 start | stop | status | cancel'));
  }

  /**
   * Deterministic HTML animation rendering for trusted extensions.  This path
   * talks to the existing native webview debugger directly; it never uses the
   * Playwright page abstraction, an external browser, or Python.
   */
  async render(
    args: {
      action?: string;
      tabId?: string;
      url?: string;
      renderId?: string;
      jobId?: string;
      recordingId?: string;
      width?: number;
      height?: number;
      times?: number[];
      durationMs?: number;
      fps?: number;
    },
    owner?: BrowserActor,
    signal?: AbortSignal
  ): Promise<unknown> {
    const action = args?.action ?? 'status';
    if (action === 'status') {
      const id = String(args?.renderId ?? args?.jobId ?? args?.recordingId ?? '');
      if (!id) throw new Error(t('tasks.render status 需要 renderId'));
      const job = this.tabs.recording().renderJob(id, owner);
      if (!job) throw new Error(t('确定性渲染任务不存在：{{id}}', { id }));
      return { ok: true, render: job };
    }
    if (action === 'cancel') {
      const id = String(args?.renderId ?? args?.jobId ?? args?.recordingId ?? '');
      if (!id) throw new Error(t('tasks.render cancel 需要 renderId'));
      return { ok: this.tabs.recording().cancelRender(id, owner) };
    }

    let tabId = String(args?.tabId ?? '').trim();
    let created = false;
    if (!tabId) {
      const rawUrl = String(args?.url ?? '').trim();
      if (!rawUrl) throw new Error(t('tasks.render start 需要 tabId 或 url'));
      const opened = this.open(normalizeUrlInput(rawUrl), owner) as { id?: unknown };
      tabId = String(opened?.id ?? '');
      created = true;
    } else if (args?.url !== undefined) {
      throw new Error(t('tasks.render 不能同时传 tabId 和 url'));
    }
    this.requireTab(tabId);
    const ownedTab = this.tabs.snapshot().tabs.find(tab => tab.id === tabId);
    if (owner?.workspaceId && ownedTab?.workspaceId !== owner.workspaceId) {
      throw new Error(t('确定性渲染目标不属于扩展当前工作区'));
    }
    if (signal?.aborted) throw new Error(t('已取消'));
    await this.tabs.ensureGuest(tabId);

    const actionIsPreview = action === 'preview';
    if (action === 'validate' || actionIsPreview || action === 'start') {
      const width = Number.isFinite(Number(args?.width)) ? Number(args.width) : DEFAULT_RENDER_WIDTH;
      const height = Number.isFinite(Number(args?.height)) ? Number(args.height) : DEFAULT_RENDER_HEIGHT;
      const viewportBefore = this.tabs.viewportOverride(tabId);
      if (action === 'validate') {
        await this.tabs.setViewport(tabId, width, height);
        try {
          const times = args?.times === undefined ? [] : normalizeRenderTimesForTool(args.times, undefined, undefined);
          const validation = await this.tabs.recording().validateRender(tabId, signal, { times });
          return { ok: true, valid: true, tabId, width, height, validation };
        } finally {
          try {
            if (viewportBefore) await this.tabs.setViewport(tabId, viewportBefore.width, viewportBefore.height);
            else await this.tabs.resetViewport(tabId);
          } catch {
            /* closing/replacing a tab makes restoration impossible and harmless */
          }
        }
      }
      const times = actionIsPreview
        ? [Math.max(0, Number(args?.times?.[0] ?? 0))]
        : normalizeRenderTimesForTool(args?.times, args?.durationMs, args?.fps);
      const viewport = await this.tabs.setViewport(tabId, width, height);
      const restoreViewport = async () => {
        try {
          if (viewportBefore) await this.tabs.setViewport(tabId, viewportBefore.width, viewportBefore.height);
          else await this.tabs.resetViewport(tabId);
        } catch {
          /* closing/replacing a tab makes restoration impossible and harmless */
        }
      };
      try {
        const render = await this.tabs.recording().startRender(tabId, {
          times,
          width: viewport.width,
          height: viewport.height,
          owner,
          restoreViewport,
          signal
        });
        return { ok: true, render, renderId: render.id, jobId: render.id, tabId, createdTab: created };
      } catch (error) {
        await restoreViewport();
        throw error;
      }
    }
    throw new Error(t('tasks.render action 只接受 start | preview | validate | status | cancel'));
  }

  dialogList(tabId: string): unknown {
    return { ok: true, dialogs: this.tabs.pendingDialogs(tabId) };
  }

  async dialogAct(
    tabId: string,
    dialogId: string,
    accept: boolean,
    promptText?: string
  ): Promise<unknown> {
    const ok = await this.tabs.dialogAnswer(tabId, dialogId, accept, promptText === undefined ? undefined : String(promptText));
    if (!ok) {
      return {
        ok: false,
        error: t('没有匹配的待处理弹窗（dialogId={{id}}）', { id: dialogId || '<空>' }),
        dialogs: this.tabs.pendingDialogs(tabId)
      };
    }
    return { ok: true, accepted: !!accept };
  }

  dialogPolicy(tabId: string, policy: 'manual' | 'auto-accept' | 'auto-dismiss'): unknown {
    if (policy !== 'manual' && policy !== 'auto-accept' && policy !== 'auto-dismiss') {
      throw new Error(t('policy 只接受 manual / auto-accept / auto-dismiss'));
    }
    this.tabs.setDialogPolicy(tabId, policy);
    return { ok: true, policy };
  }

  // ── Cookie / Web Storage ──

  async cookies(
    tabId: string | undefined,
    args: {
      action: 'get' | 'set' | 'clear';
      cookies?: Array<Record<string, unknown>>;
      urls?: string[];
      name?: string;
    },
    owner?: BrowserActor
  ): Promise<unknown> {
    const id = this.resolveTabId(tabId, owner);
    const perform = async (): Promise<unknown> => {
      const { page } = await this.pageFor(id);
      const ctx = page.context();
      if (args?.action === 'set') {
        const list = Array.isArray(args.cookies) ? args.cookies : [];
        // Playwright addCookies 契约（rewriteCookies 断言）：url 与 domain/path 互斥，
        // domain 定位必须成对带 path。工具契约只要求「url 或 domain」，这里按其归一化：
        // url 优先（多余的 domain/path 剔除）；domain 定位时 path 缺省 '/'。
        // 不归一化时 Playwright 会抛断言错且文案误导（domain-only 报 "should have
        // either url or domain"——用户 2026-10-14 实测踩坑）。
        const normalized = list.map((c) => {
          if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') {
            throw new Error(t('每颗 cookie 至少要 name + value，并以 url 或 domain 定位'));
          }
          if (!c.url && !c.domain) throw new Error(t('cookie {{name}} 缺少 url 或 domain', { name: c.name }));
          const copy: Record<string, unknown> = { ...c };
          if (copy.url) {
            delete copy.domain;
            delete copy.path;
          } else if (!copy.path) {
            copy.path = '/';
          }
          return copy;
        });
        await ctx.addCookies(normalized as unknown as Parameters<typeof ctx.addCookies>[0]);
        return { ok: true, count: normalized.length };
      }
      if (args?.action === 'clear') {
        await ctx.clearCookies();
        return { ok: true };
      }
      const urls = Array.isArray(args?.urls) && args.urls.length ? args.urls.map(String) : undefined;
      let list = await ctx.cookies(urls);
      if (args?.name) list = list.filter((c) => c.name === args.name);
      return { ok: true, cookies: list };
    };
    return args?.action === 'set' || args?.action === 'clear' ? this.tabs.runOperation(id, perform) : perform();
  }

  async storage(
    tabId: string,
    args: { action: 'get' | 'set' | 'remove' | 'clear'; kind: 'local' | 'session'; key?: string; value?: string }
  ): Promise<unknown> {
    const action = args?.action ?? 'get';
    const target = args?.kind === 'session' ? 'sessionStorage' : 'localStorage';
    return this.withAct(tabId, 'storage', async (page) => {
      // 注意：playwright 字符串表达式的 evaluate 不传 arg——参数内联 JSON 自调用
      const argJson = JSON.stringify({ target, op: action, key: args?.key ?? null, value: args?.value ?? null });
      const res = await page.evaluate(
        `((__ma) => {
           const s = window[__ma.target];
           if (!s) return null;
           if (__ma.op === 'get') {
             if (__ma.key) return s.getItem(__ma.key);
             return Object.keys(s).map((k) => [k, s.getItem(k)]);
           }
           if (__ma.op === 'set') { s.setItem(String(__ma.key), String(__ma.value ?? '')); return true; }
           if (__ma.op === 'remove') { s.removeItem(String(__ma.key)); return true; }
           s.clear(); return true;
         })(${argJson})`
      );
      if (action === 'get') {
        return {
          ok: true,
          value: res,
          note: args?.key ? undefined : t('值为 [key, value] 数组；字符串原样返回')
        };
      }
      return { ok: true };
    }, action !== 'get');
  }

  // ── 观测（console / network / downloads / help） ──

  consoleEntries(
    tabId: string,
    args: { level?: string; contains?: string; limit?: number }
  ): unknown {
    const all = this.tabs.consoleEntries(tabId);
    let items = all;
    const level = args?.level ? String(args.level) : '';
    if (level && ['verbose', 'info', 'warning', 'error'].includes(level)) {
      items = items.filter((x) => x.level === level);
    }
    if (args?.contains) items = items.filter((x) => x.text.includes(String(args.contains)));
    const limit = Math.max(1, Math.min(200, Number(args?.limit) || 50));
    return { ok: true, total: all.length, items: items.slice(-limit) };
  }

  async network(
    tabId: string,
    args: {
      action?: 'list' | 'body';
      method?: string;
      status?: number;
      contains?: string;
      limit?: number;
      requestId?: string;
    }
  ): Promise<unknown> {
    if (args?.action === 'body') {
      if (!args.requestId) throw new Error(t('action=body 需要 requestId（先 list 拿到）'));
      const body = await this.tabs.networkBody(tabId, String(args.requestId));
      const truncated = body.body.length > 60_000;
      return {
        ok: true,
        base64Encoded: body.base64Encoded,
        body: truncated ? body.body.slice(0, 60_000) : body.body,
        ...(truncated ? { note: t('响应体过长已截断到 60000 字符') } : {})
      };
    }
    const all = this.tabs.networkEntries(tabId);
    let items = all;
    if (args?.method) items = items.filter((x) => x.method.toUpperCase() === String(args.method).toUpperCase());
    if (args?.status != null) items = items.filter((x) => x.status === Number(args.status));
    if (args?.contains) items = items.filter((x) => x.url.includes(String(args.contains)));
    const limit = Math.max(1, Math.min(200, Number(args?.limit) || 50));
    return { ok: true, total: all.length, items: items.slice(-limit) };
  }

  downloads(args: { limit?: number }): unknown {
    const all = this.tabs.downloadEntries();
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
    return { ok: true, items: all.slice(-limit).reverse() };
  }

  // ── 视口（browser.setViewport / resetViewport，任务 C） ──

  /** 设置响应式验收视口：宽高 clamp 到 320-3840×320-2160（非法值抛错），
   *  guest 换代（崩溃恢复重建）后自动重应用；走 withAct 获得标签校验与 agentState 展示。 */
  async setViewport(tabId: string, width: number, height: number): Promise<unknown> {
    return this.withAct(tabId, 'setViewport', async () => {
      // 视口是 guest 级 Emulation override，不需要 playwright page——直接调 tabs 服务
      const viewport = await this.tabs.setViewport(tabId, width, height);
      return { ok: true, viewport };
    });
  }

  /** 清除 browser.setViewport 设置的视口 override（只清 Agent 自己设置的；无 override 幂等成功） */
  async resetViewport(tabId: string): Promise<unknown> {
    return this.withAct(tabId, 'resetViewport', async () => {
      await this.tabs.resetViewport(tabId);
      return { ok: true };
    });
  }

  private actorKey(owner?: BrowserActor): string {
    return JSON.stringify([owner?.workspaceId ?? '', owner?.sessionId ?? '']);
  }

  /** 缺省目标跟随调用方，用户切换标签/会话不改变它。 */
  private resolveTabId(tabId?: string, owner?: BrowserActor): string {
    if (tabId) return tabId;
    const selected = this.selectedTabs.get(this.actorKey(owner));
    if (selected) { this.requireTab(selected); return selected; }
    throw new Error(t('当前 AI 尚未选择浏览器页面（传 tabId，或先 browser.open / browser.activate）'));
  }
}
