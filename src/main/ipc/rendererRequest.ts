import { ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';

/**
 * 主进程 → 渲染层的一次性请求-应答骨架（ui:confirm / ui:dialog / terminal:capture 共用）：
 * 每次请求使用独立 requestId；应答、取消、窗口失效、超时及异常统一清理自身监听。
 * map 做应答校验/整形；onTimeout 同时提供取消/失效时的 fail-closed 值。
 */
export function requestRendererOnce<T>(
  win: BrowserWindow,
  opts: {
    /** 请求通道（如 'ui:confirm'）与应答前缀（如 'ui:confirm'，应答通道为 `${prefix}:${requestId}`） */
    requestChannel: string;
    prefix: string;
    payload: Record<string, unknown>;
    timeoutMs: number;
    /** 仅在主进程使用，不发到 renderer。 */
    signal?: AbortSignal;
    /** Ignore replies from any webContents other than the target renderer. */
    requireSource?: boolean;
    /** Restrict a private request to the target window's main frame as well. */
    requireMainFrame?: boolean;
    /** 请求结束时通知所有 UI 移除该 requestId（包括桌面/Web 的其他副本）。 */
    closedChannel?: string;
    onTimeout: () => T;
    map: (payload: unknown, requestId: string) => T;
  }
): Promise<T> {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted || win.isDestroyed()) {
      try { resolve(opts.onTimeout()); } catch (err) { reject(err); }
      return;
    }
    const channel = `${opts.prefix}:${requestId}`;
    const wc = win.webContents;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let sent = false;
    const finish = (value: () => T, failure?: { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(channel, onResponse);
      opts.signal?.removeEventListener('abort', onUnavailable);
      win.removeListener('closed', onUnavailable);
      wc.removeListener('destroyed', onUnavailable);
      wc.removeListener('render-process-gone', onUnavailable);
      wc.removeListener('did-start-navigation', onNavigation);
      if (sent && opts.closedChannel && !wc.isDestroyed()) {
        try {
          wc.send(opts.closedChannel, { requestId });
        } catch (err) {
          console.error('[ui] 请求结束通知失败', err);
        }
      }
      if (failure) reject(failure.error);
      else {
        try { resolve(value()); } catch (err) { reject(err); }
      }
    };
    const onUnavailable = () => finish(opts.onTimeout);
    const onResponse = (event: { sender?: unknown; senderFrame?: unknown } | null, payload: unknown) => {
      if (opts.requireSource && event?.sender !== wc) return;
      if (opts.requireMainFrame && (!wc.mainFrame || event?.senderFrame !== wc.mainFrame)) return;
      finish(() => opts.map(payload, requestId));
    };
    const onNavigation = (event: { isSameDocument: boolean; isMainFrame: boolean }) => {
      if (event.isMainFrame && !event.isSameDocument) onUnavailable();
    };
    if (opts.signal?.aborted || win.isDestroyed() || wc.isDestroyed()) {
      onUnavailable();
      return;
    }
    ipcMain.on(channel, onResponse);
    opts.signal?.addEventListener('abort', onUnavailable, { once: true });
    win.once('closed', onUnavailable);
    wc.once('destroyed', onUnavailable);
    wc.once('render-process-gone', onUnavailable);
    wc.on('did-start-navigation', onNavigation);
    timer = setTimeout(onUnavailable, opts.timeoutMs);
    try {
      sent = true;
      wc.send(opts.requestChannel, { ...opts.payload, requestId });
    } catch (err) {
      finish(opts.onTimeout, { error: err });
    }
  });
}
