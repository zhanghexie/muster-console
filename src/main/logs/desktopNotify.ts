import { Notification } from 'electron';

/**
 * 原生系统通知：渲染进程死亡后的提示走这里而不是 ui.notify——
 * 那条通道要渲染层活着才能弹 toast，而此刻渲染层恰恰刚死。
 * Windows 走 AUMID（index.ts 已 setAppUserModelId），点击通知聚焦应用。
 */
export function notifyDesktop(title: string, body: string, onActivate?: () => void): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    if (onActivate) n.on('click', () => onActivate());
    n.show();
  } catch {
    /* 通知失败静默：别让提示本身成为新的故障源 */
  }
}
