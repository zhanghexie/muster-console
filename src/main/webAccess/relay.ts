import type { BrowserWindow } from 'electron';
import { IPC_EVENT_CHANNELS } from '../../shared/ipcEvents';

type BroadcastFn = (channel: string, payload: unknown) => void;

const listeners = new Set<BroadcastFn>();

/** web 客户端订阅主→渲染事件（WebAccessServer 启动时注册） */
export function onWebEventBroadcast(fn: BroadcastFn): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function broadcast(channel: string, payload: unknown): void {
  // A local CLI handoff opens the desktop only, not every connected Web client.
  if (channel === 'cli:openRun') return;
  // Local-only confirmations may contain private desktop evidence and must not
  // be broadcast to connected Web clients. Their replies are source-bound too.
  if (channel === 'ui:confirm' && payload && typeof payload === 'object' &&
      (payload as { localOnly?: unknown }).localOnly === true) return;
  if (!(IPC_EVENT_CHANNELS as readonly string[]).includes(channel)) return;
  for (const fn of listeners) {
    try {
      fn(channel, payload);
    } catch (err) {
      console.error('[web-relay]', err);
    }
  }
}

/**
 * 事件广播的单点接入：包装主窗口 webContents.send。
 *
 * 主进程 14 个文件 30+ 处推送点（sessions/pty/uiBridge/orchestrator…）都写成
 * `getWindow()?.webContents.send(channel, payload)`，而这些地方手里只有 getWindow
 * 函数——逐处迁移要改 8 个类的构造链。这里在 createWindow 时把 send 分叉一份给
 * web 客户端：先广播再原样发送，桌面壳语义完全不变。
 * 白名单（IPC_EVENT_CHANNELS）外不广播；窗口重建（activate）时对每个新窗口各接一次。
 */
export function attachEventRelay(win: BrowserWindow): void {
  const wc = win.webContents;
  const origSend = wc.send.bind(wc);
  wc.send = ((channel: string, ...args: unknown[]) => {
    broadcast(channel, args[0]);
    return origSend(channel, ...(args as never[]));
  }) as typeof wc.send;
}
