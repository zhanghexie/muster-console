/** 渲染层终端截图注册表：每个常驻 TerminalView 挂载时登记。 */

export type TerminalCaptureHandle = {
  /** 隐藏会话挪到屏外并强制重绘；返回还原样式的函数 */
  prepare: () => Promise<() => void>;
  getCanvasDataURL: () => string | null;
};

const handles = new Map<string, TerminalCaptureHandle>();

export function registerTerminalCapture(sessionId: string, handle: TerminalCaptureHandle): void {
  handles.set(sessionId, handle);
}

export function unregisterTerminalCapture(sessionId: string): void {
  handles.delete(sessionId);
}

export function getTerminalCapture(sessionId: string): TerminalCaptureHandle | undefined {
  return handles.get(sessionId);
}

/** 渲染层终端粘贴注册表：文件批注确认后把展开文字粘进对应 CLI 会话的输入。 */
export type TerminalPasteHandle = {
  /** 聚焦终端并 paste（xterm 会按 bracketed-paste 模式写入 pty stdin） */
  paste: (text: string) => void;
};

const pasteHandles = new Map<string, TerminalPasteHandle>();

export function registerTerminalPaste(sessionId: string, handle: TerminalPasteHandle): void {
  pasteHandles.set(sessionId, handle);
}

export function unregisterTerminalPaste(sessionId: string): void {
  pasteHandles.delete(sessionId);
}

export function getTerminalPaste(sessionId: string): TerminalPasteHandle | undefined {
  return pasteHandles.get(sessionId);
}

/**
 * pty:data 单一分发器：全部常驻 TerminalView 共享一个 window 监听，
 * 按 sessionId 精确派发——N 会话高吞吐输出时不再唤醒 N 个「全量监听再自过滤」
 * 的监听器。最后一个订阅者退订时移除 window 监听。
 */
type PtyDataListener = (data: string) => void;

const ptyDataSubs = new Map<string, Set<PtyDataListener>>();
let ptyDataOff: (() => void) | null = null;

function ensurePtyDataListener(): void {
  if (ptyDataOff) return;
  ptyDataOff = window.api.on('pty:data', (p) => {
    const subs = ptyDataSubs.get(p.sessionId);
    if (!subs) return;
    for (const cb of subs) cb(p.data);
  });
}

export function subscribePtyData(sessionId: string, cb: PtyDataListener): () => void {
  let set = ptyDataSubs.get(sessionId);
  if (!set) {
    set = new Set();
    ptyDataSubs.set(sessionId, set);
  }
  set.add(cb);
  ensurePtyDataListener();
  return () => {
    const s = ptyDataSubs.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      ptyDataSubs.delete(sessionId);
      if (ptyDataSubs.size === 0 && ptyDataOff) {
        ptyDataOff();
        ptyDataOff = null;
      }
    }
  };
}
