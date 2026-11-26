/** 渲染层未捕获错误落盘（P15）：userData/logs/renderer-errors.ndjson */

export const RENDERER_ERROR_LOG_NAME = 'renderer-errors.ndjson';
export const RENDERER_ERROR_LOG_MAX_BYTES = 256 * 1024;

export type RendererErrorRecord = {
  ts: number;
  label: string;
  message: string;
  stack?: string;
  componentStack?: string;
};

export function formatRendererErrorLine(rec: RendererErrorRecord): string {
  return JSON.stringify({
    ts: rec.ts,
    label: rec.label || 'panel',
    message: rec.message,
    ...(rec.stack ? { stack: rec.stack.slice(0, 8000) } : {}),
    ...(rec.componentStack ? { componentStack: rec.componentStack.slice(0, 4000) } : {})
  });
}

export function rotateIfNeeded(
  readSize: () => number,
  renameToOld: () => void,
  maxBytes: number = RENDERER_ERROR_LOG_MAX_BYTES
): void {
  try {
    if (readSize() >= maxBytes) renameToOld();
  } catch {
    /* 无文件或 stat 失败：直接追加 */
  }
}

/**
 * Chromium 把 ResizeObserver 自限保护（回调同帧内改布局 → 剩余通知顺延下一帧）
 * 设计成 window error 事件发出：不可 try/catch、布局下一帧自收敛、无功能影响。
 * 除按消息识别外无其他信号（VS Code 等同款处理），视为良性：不进
 * 「渲染层崩溃」上报（toast + renderer-errors 落盘）。两条消息分别对应
 * 「通知顺延」与「循环上限截断」。
 */
const BENIGN_RENDERER_ERROR_PREFIXES = [
  'ResizeObserver loop completed with undelivered notifications',
  'ResizeObserver loop limit exceeded'
];

/**
 * Electron 43 webview 元素卸载的必发上游噪音：guest webContents 销毁后，
 * 元素 disconnectedCallback 的自定义元素反应仍会异步报一次
 * `Invalid guestInstanceId: N`（调用侧无法 try/catch；元素移除与主进程
 * wc.close() 两种销毁顺序下都发生，且探针实测 guest 均已正确销毁——
 * 纯报错噪音，无泄漏）。与 ResizeObserver 同款归良性，不进「渲染层崩溃」
 * 上报，否则每次关闭浏览器标签都弹崩溃 toast。
 */
const BENIGN_GUEST_INSTANCE_ID = /^(?:Uncaught )?Error: Invalid guestInstanceId: \d+$/;

export function isBenignRendererError(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  const m = message.trim();
  return BENIGN_RENDERER_ERROR_PREFIXES.some((p) => m.startsWith(p)) || BENIGN_GUEST_INSTANCE_ID.test(m);
}
