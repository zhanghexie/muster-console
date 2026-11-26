import { nativeImage, Notification, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { decodeDesktopPng } from './desktop/pngDecoder';
import { requestRendererOnce } from './ipc/rendererRequest';
import type { AgentStatus } from '../shared/types';
import type { ConfirmDialogFields, ConfirmResult } from '../shared/confirmDialog';
import { parseConfirmIpcPayload } from '../shared/confirmDialog';
let notifyUnsupportedLogged = false;
import {
  UI_DIALOG_TIMEOUT_MS,
  normalizeMenuArgs,
  normalizeMultiSelectArgs,
  normalizePromptArgs,
  normalizeSelectArgs,
  type UiDialogRequest,
  type UiDialogResponse,
  type UiMenuArgs,
  type UiMultiSelectArgs,
  type UiPromptArgs,
  type UiSelectArgs
} from '../shared/uiDialog';

const CONFIRM_TIMEOUT_MS = UI_DIALOG_TIMEOUT_MS;
/** 截图/视图挂起只是弹窗准备工作，不能吞掉确认门自身的超时。 */
const CONFIRM_SUSPEND_TIMEOUT_MS = 5_000;
/** 防止 toast 被 GC 掉导致 click 丢失 */
const MAX_HELD_NOTIFICATIONS = 20;

export type NotifyClickHandler = (workspaceId: string, sessionId?: string) => void;

/** Host-only receipt: the id is minted for the actual renderer request, never read from its reply. */
export interface ConfirmReceipt { decision: ConfirmResult; approvalId?: string; failureReason?: 'confirmation-unavailable' | 'confirmation-interrupted' | 'invalid-response' }
export interface DesktopConfirmEvidence {
  png: Buffer;
  sha256: string;
  region: { x: number; y: number; width: number; height: number };
}

type DialogQueueEntry = {
  request: Omit<UiDialogRequest, 'requestId'> & { requestId?: string };
  resolve: (value: string | string[] | null) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  detachAbort(): void;
};

/**
 * 主进程 → 渲染层的 UI 通道：状态气泡、系统通知、确认与通用对话框。
 * confirm 是危险操作的强制门；prompt/select/multiSelect/menu 供扩展与调度 Agent。
 *
 * 气泡按 workspaceId 分桶。
 * 未传 id 时回落 active——仅兼容旧调用；调度工具路径应显式传发起区 id，
 * 否则「在 B 跑 Agent、UI 已切到 A」会把气泡写进 A 码头像。
 */
export class UiBridge {
  private heldNotifications: Notification[] = [];
  private onNotifyClick: NotifyClickHandler | null = null;
  private dialogQueue: DialogQueueEntry[] = [];
  private dialogBusy = false;

  constructor(
    private getWindow: () => BrowserWindow | null,
    private getActiveWorkspaceId: () => string | null | undefined
  ) {}

  /** 系统 toast 点击：切工作区等副作用（由 registerIpc 注入） */
  setNotifyClickHandler(handler: NotifyClickHandler | null): void {
    this.onNotifyClick = handler;
  }

  setBubble(text: string, status: AgentStatus = 'idle', workspaceId?: string): void {
    const wsId = workspaceId?.trim() || this.getActiveWorkspaceId() || undefined;
    console.log(
      `[bubble] set text=${JSON.stringify(text).slice(0, 60)} status=${status} ws=${wsId ?? '(none)'} explicit=${!!workspaceId?.trim()}`
    );
    this.getWindow()?.webContents.send('ui:bubble', {
      text,
      status,
      workspaceId: wsId
    });
  }

  notify(
    title: string,
    body: string,
    optsOrIcon?: string | {
      workspaceId?: string;
      sessionId?: string;
      icon?: string;
      /** 点击 toast 后让渲染层打开中栏面板页签（决策 #9：审批注意流=角标+通知中心） */
      openPanel?: { panel: string; tab?: string };
    }
  ): void {
    if (!Notification.isSupported()) {
      // Desktop toast is the only notification outlet; when the platform cannot show
      // any, log once so the loss is visible instead of silently dropping needs_you.
      if (!notifyUnsupportedLogged) {
        notifyUnsupportedLogged = true;
        console.error('[notify] 系统通知不可用（Notification.isSupported=false）：桌面通知将被全部丢弃，needs_you 请依赖左栏胶囊与看板列');
      }
      return;
    }
    const t = title.trim() || 'Muster Console';
    const b = body.trim();
    let workspaceId = '';
    let sessionId = '';
    let icon: string | undefined;
    let openPanel: { panel: string; tab?: string } | undefined;
    if (typeof optsOrIcon === 'string') {
      icon = optsOrIcon;
    } else if (optsOrIcon) {
      workspaceId = optsOrIcon.workspaceId?.trim() || '';
      sessionId = optsOrIcon.sessionId?.trim() || '';
      icon = optsOrIcon.icon;
      openPanel = optsOrIcon.openPanel;
    }
    const opts: Electron.NotificationConstructorOptions = {
      title: t,
      body: b || undefined
    };
    if (icon?.startsWith('data:')) {
      try {
        const img = nativeImage.createFromDataURL(icon);
        if (!img.isEmpty()) opts.icon = img;
      } catch {
        /* 坏 data URL 时仍发无 icon 通知 */
      }
    }
    const n = new Notification(opts);
    this.holdNotification(n);
    n.on('click', () => {
      this.focusMainWindow();
      if (openPanel) {
        try {
          this.getWindow()?.webContents.send('ui:openPanel', openPanel);
        } catch (err) {
          console.error('[notify:click] open panel failed', err);
        }
      }
      if (workspaceId) {
        try {
          this.onNotifyClick?.(workspaceId, sessionId || undefined);
        } catch (err) {
          console.error('[notify:click] activate workspace failed', err);
        }
      }
    });
    n.show();
  }

  /**
   * 确认弹窗期间的视图挂起钩子：WebContentsView（内置浏览器）恒在渲染层 DOM 之上，
   * ConfirmDialog 居中弹层会被它盖住——confirm 期间挂起网页视图，结束恢复。
   * suspend 可异步：实现方先截当前帧推渲染层（挂起后由截图 img 顶上）再挂起。
   * 由启动链在 BrowserTabService 构造后注入（UiBridge 构造早于它，晚绑定）。
   */
  private confirmSuspend: { suspend(): void | Promise<void>; resume(): void } | null = null;
  /** 在途 confirm 的让位深度：并发多个确认弹窗时末位结束才恢复视图 */
  private confirmDepth = 0;

  setConfirmSuspend(hooks: { suspend(): void | Promise<void>; resume(): void } | null): void {
    this.confirmSuspend = hooks;
  }

  async confirm(
    title: string,
    detail: string,
    opts?: ConfirmDialogFields & {
      inboundMcpReview?: import('../shared/inboundMcp').InboundMcpReview;
      /** 在主进程取消本次人工确认；不进入 renderer payload。 */
      signal?: AbortSignal;
      /** Only the desktop renderer may see and answer this confirmation. */
      localOnly?: boolean;
      desktopEvidence?: DesktopConfirmEvidence;
    }
  ): Promise<ConfirmResult> {
    return (await this.confirmWithReceipt(title, detail, opts)).decision;
  }

  async confirmWithReceipt(
    title: string,
    detail: string,
    opts?: ConfirmDialogFields & {
      inboundMcpReview?: import('../shared/inboundMcp').InboundMcpReview;
      signal?: AbortSignal;
      localOnly?: boolean;
      desktopEvidence?: DesktopConfirmEvidence;
    }
  ): Promise<ConfirmReceipt> {
    const win = this.getWindow();
    const timeout = (): ConfirmReceipt => ({ decision: { confirmed: false, cancelledBy: 'timeout' }, failureReason: 'confirmation-interrupted' });
    if (!win || win.isDestroyed()) return { decision: { confirmed: false, cancelledBy: 'timeout' }, failureReason: 'confirmation-unavailable' };
    if (opts?.signal?.aborted) return timeout();
    let desktopEvidence: import('../shared/confirmDialog').DesktopEvidencePreview | undefined;
    if (opts?.desktopEvidence) {
      if (opts.localOnly !== true) throw new Error('Desktop evidence requires a local-only confirmation');
      const { png, sha256, region } = opts.desktopEvidence;
      if (!Buffer.isBuffer(png) || png.length > 20 * 1024 * 1024 || png.length < 45 ||
          typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || !region ||
          ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
          region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) throw new Error('Invalid desktop confirmation evidence');
      const copy = Buffer.from(png), area = { ...region };
      if (createHash('sha256').update(copy).digest('hex') !== sha256) throw new Error('Desktop evidence hash does not match');
      const size = await decodeDesktopPng(copy);
      if (size.width !== area.width || size.height !== area.height) throw new Error('Desktop evidence region does not match image');
      if (opts.signal?.aborted || win.isDestroyed()) return timeout();
      desktopEvidence = { dataUrl: `data:image/png;base64,${copy.toString('base64')}`, region: area };
    }
    try {
      await this.suspendViewsForConfirm(opts?.signal);
      if (opts?.signal?.aborted) return timeout();
      return await requestRendererOnce<ConfirmReceipt>(win, {
        requestChannel: 'ui:confirm',
        prefix: 'ui:confirm',
        payload: {
          title,
          detail,
          ...(opts?.localOnly ? { localOnly: true } : {}),
          ...(desktopEvidence ? { desktopEvidence } : {}),
          ...(opts?.dangerous ? { dangerous: true } : {}),
          ...(opts?.subtitle ? { subtitle: opts.subtitle } : {}),
          ...(opts?.intent ? { intent: opts.intent } : {}),
          ...(opts?.summary ? { summary: opts.summary } : {}),
          ...(opts?.confirmNote ? { confirmNote: opts.confirmNote } : {}),
          ...(opts?.toolDescription ? { toolDescription: opts.toolDescription } : {}),
          ...(opts?.confirmLabel ? { confirmLabel: opts.confirmLabel } : {}),
          ...(opts?.cancelLabel ? { cancelLabel: opts.cancelLabel } : {}),
          ...(opts?.permission ? { permission: opts.permission } : {}),
          ...(opts?.inboundMcpReview ? { inboundMcpReview: opts.inboundMcpReview } : {})
        },
        timeoutMs: CONFIRM_TIMEOUT_MS,
        signal: opts?.signal,
        requireSource: opts?.localOnly === true,
        requireMainFrame: opts?.localOnly === true,
        closedChannel: 'ui:confirmClosed',
        onTimeout: timeout,
        map: (payload, requestId) => {
          const valid = typeof payload === 'boolean' || (!!payload && typeof payload === 'object' && !Array.isArray(payload) &&
            (typeof (payload as { confirmed?: unknown }).confirmed === 'boolean' ||
              ['allowOnce', 'allowAlways', 'deny', 'custom'].includes(String((payload as { kind?: unknown }).kind))));
          const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
          const kind = raw?.kind;
          const desktopValid = typeof payload === 'boolean' || (!!raw && typeof raw.confirmed === 'boolean' &&
            (kind === undefined || (typeof kind === 'string' && ['allowOnce', 'allowAlways', 'deny', 'custom'].includes(kind) &&
              raw.confirmed === (kind === 'allowOnce' || kind === 'allowAlways'))) &&
            !(raw.confirmed && raw.cancelledBy !== undefined));
          const decision = parseConfirmIpcPayload(payload);
          if (!valid || (opts?.localOnly && !desktopValid)) return { decision: { confirmed: false, kind: 'deny' }, failureReason: 'invalid-response' };
          const allowed = decision.confirmed === true && !decision.cancelledBy &&
            (decision.kind === 'allowOnce' || decision.kind === 'allowAlways');
          return { decision, ...(allowed ? { approvalId: requestId } : {}) };
        }
      });
    } finally {
      this.resumeViewsAfterConfirm();
    }
  }

  /** 挂起失败不阻塞确认门（降级：视图可能盖住弹窗，但 confirm 仍可应答） */
  private async suspendViewsForConfirm(signal?: AbortSignal): Promise<void> {
    this.confirmDepth += 1;
    if (this.confirmDepth > 1) return;
    const hooks = this.confirmSuspend;
    if (!hooks || signal?.aborted) return;
    try {
      const suspended = Promise.resolve(hooks.suspend());
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(() => {
          console.error('[ui] confirm 挂起浏览器视图超时（降级继续弹窗）');
          finish();
        }, CONFIRM_SUSPEND_TIMEOUT_MS);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
        void suspended.then(() => {
          // 若取消/超时后异步截图才完成挂起，不得把已经结束的弹窗留成永久遮挡。
          // 有其他确认仍在途时保留挂起，最后一个确认负责恢复。
          if (this.confirmDepth === 0) {
            try { hooks.resume(); } catch (err) { console.error('[ui] confirm 迟到挂起恢复失败', err); }
          }
          finish();
        }, (err) => {
          console.error('[ui] confirm 挂起浏览器视图失败（降级继续弹窗）', err);
          finish();
        });
      });
    } catch (err) {
      console.error('[ui] confirm 挂起浏览器视图失败（降级继续弹窗）', err);
    }
  }

  private resumeViewsAfterConfirm(): void {
    this.confirmDepth = Math.max(0, this.confirmDepth - 1);
    if (this.confirmDepth > 0) return;
    try {
      this.confirmSuspend?.resume();
    } catch (err) {
      console.error('[ui] confirm 恢复浏览器视图失败', err);
    }
  }

  /** 文本输入；取消 / 超时返回 null */
  prompt(args: UiPromptArgs | Record<string, unknown>, signal?: AbortSignal): Promise<string | null> {
    const n = normalizePromptArgs(args);
    return this.enqueueDialog({ kind: 'prompt', ...n }, signal) as Promise<string | null>;
  }

  /** 单选；返回 item.id，取消 / 超时返回 null */
  select(args: UiSelectArgs | Record<string, unknown>, signal?: AbortSignal): Promise<string | null> {
    const n = normalizeSelectArgs(args);
    return this.enqueueDialog({ kind: 'select', ...n }, signal) as Promise<string | null>;
  }

  /** 多选；返回 id[]，取消 / 超时返回 null */
  multiSelect(args: UiMultiSelectArgs | Record<string, unknown>, signal?: AbortSignal): Promise<string[] | null> {
    const n = normalizeMultiSelectArgs(args);
    return this.enqueueDialog({ kind: 'multiSelect', ...n }, signal) as Promise<string[] | null>;
  }

  /** 菜单式单选（可含 separator）；返回 id，取消 / 超时返回 null */
  menu(args: UiMenuArgs | Record<string, unknown>, signal?: AbortSignal): Promise<string | null> {
    const n = normalizeMenuArgs(args);
    return this.enqueueDialog({ kind: 'menu', ...n }, signal) as Promise<string | null>;
  }

  private enqueueDialog(
    request: Omit<UiDialogRequest, 'requestId'>,
    signal?: AbortSignal
  ): Promise<string | string[] | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const index = this.dialogQueue.indexOf(entry);
        if (index < 0) return; // The displayed request owns its abort listener.
        this.dialogQueue.splice(index, 1);
        entry.detachAbort();
        resolve(null);
      };
      const entry: DialogQueueEntry = { request, resolve, reject, signal,
        detachAbort: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      this.dialogQueue.push(entry);
      void this.pumpDialogQueue();
    });
  }

  private async pumpDialogQueue(): Promise<void> {
    if (this.dialogBusy) return;
    const next = this.dialogQueue.shift();
    if (!next) return;
    this.dialogBusy = true;
    try {
      const value = await this.showDialogOnce(next.request, next.signal);
      next.resolve(value);
    } catch (error) {
      next.reject(error);
    } finally {
      next.detachAbort();
      this.dialogBusy = false;
      void this.pumpDialogQueue();
    }
  }

  private showDialogOnce(
    partial: Omit<UiDialogRequest, 'requestId'>,
    signal?: AbortSignal
  ): Promise<string | string[] | null> {
    const win = this.getWindow();
    if (!win) return Promise.resolve(null);
    this.focusMainWindow();
    return requestRendererOnce<string | string[] | null>(win, {
      requestChannel: 'ui:dialog',
      prefix: 'ui:dialog',
      signal,
      closedChannel: 'ui:dialogClosed',
      payload: { ...(partial as Record<string, unknown>) },
      timeoutMs: UI_DIALOG_TIMEOUT_MS,
      onTimeout: () => null,
      map: (raw) => {
        const response = raw as UiDialogResponse;
        if (!response || response.cancelled) return null;
        return response.value;
      }
    });
  }

  private focusMainWindow(): void {
    const win = this.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  private holdNotification(n: Notification): void {
    this.heldNotifications.push(n);
    if (this.heldNotifications.length > MAX_HELD_NOTIFICATIONS) {
      this.heldNotifications.splice(0, this.heldNotifications.length - MAX_HELD_NOTIFICATIONS);
    }
  }
}
