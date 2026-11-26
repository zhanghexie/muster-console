/**
 * 划词菜单 → 会话批注的桥：selectionMenuAreas 的「批注」动作经这里
 * 路由到对应会话（渲染层内存态，无 IPC）。两类来源：
 * - 会话批注：gui-chat 区划词，按 data-session-id 路由（requestChatNote）；
 * - 文件批注：file-editor 区划词，FileEditor 注册选区→路径+行号解析器
 *   （registerFileNoteSource），目标会话的 AgentChatView 注册接收端
 *   （registerFileNoteTarget），requestFileNote 完成「捕获→投递」。
 */

export interface ChatNoteRequest {
  /** 选区纯文本（空白折叠、限长；发送展开与锚点回查都以它为准） */
  quote: string;
  /** 选区所在消息 id（AgentTranscript 的 data-mid 锚点） */
  messageId: string;
  /** 选区所在转写（会话）id */
  sessionId: string;
  /** 活选区（请求方立即包裹成待定锚点用；仅在本次调用栈内有效） */
  range: Range;
}

/** 文件批注捕获结果（markKey=文件内待定标记，确认转正/取消摘除用） */
export interface FileNoteCapture {
  fileRef?: import('../../../shared/types').WorkspaceFileRef;
  /** 选区纯文本（空白折叠、限长） */
  quote: string;
  /** 给模型读取的来源路径；显式多根捕获使用绝对路径，旧单根捕获兼容相对路径。 */
  path: string;
  /** 选区起始行（1-based；md/html 预览等无行号映射时为 null） */
  line: number | null;
  /** 选区结束行（1-based；与起始同行/无行号映射时为 null） */
  endLine: number | null;
  markKey: string | null;
}

/** 投递给目标 GUI 会话的载荷（note=录入框里的批注文字，非空；noteId 由录入框生成） */
export interface FileNoteDelivery extends FileNoteCapture {
  note: string;
  noteId: string;
}

/** 会话侧文件批注的二次编辑路由（角标点击 → 更新/删除会话里的批注） */
export interface FileNoteEditor {
  update: (noteId: string, note: string) => boolean;
  remove: (noteId: string) => boolean;
}

const fileNoteEditors = new Map<string, FileNoteEditor>();

export function registerFileNoteEditor(sessionId: string, editor: FileNoteEditor | null): void {
  if (editor) fileNoteEditors.set(sessionId, editor);
  else fileNoteEditors.delete(sessionId);
}

export function updateFileNoteInSession(sessionId: string, noteId: string, note: string): boolean {
  return fileNoteEditors.get(sessionId)?.update(noteId, note) ?? false;
}

export function removeFileNoteFromSession(sessionId: string, noteId: string): boolean {
  return fileNoteEditors.get(sessionId)?.remove(noteId) ?? false;
}

type Handler = (req: ChatNoteRequest) => void;

const handlers = new Map<string, Handler>();

export function registerChatNoteHandler(sessionId: string, fn: Handler | null): void {
  if (fn) handlers.set(sessionId, fn);
  else handlers.delete(sessionId);
}

/**
 * 「批注」动作入口：捕获当前 DOM 选区并路由到所属会话。
 * 返回 false 表示无可批注对象（无选区 / 不在带批注能力的转写里）。
 */
export function requestChatNote(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const quote = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!quote) return false;
  const startEl =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const list = startEl?.closest('[data-session-id]');
  const sessionId = list?.getAttribute('data-session-id') ?? '';
  const handler = sessionId ? handlers.get(sessionId) : undefined;
  if (!handler) return false;
  const holder = startEl?.closest('[data-mid]');
  handler({
    quote,
    messageId: holder?.getAttribute('data-mid') ?? '',
    sessionId,
    range: range.cloneRange()
  });
  return true;
}

// ── 文件批注（file-editor 区划词 → 目标 GUI 会话）──

/** 当前打开文件的选区解析器（FileEditor 注册；返回 null=无可批注对象） */
type FileNoteSource = () => {
  fileRef?: import('../../../shared/types').WorkspaceFileRef;
  path: string;
  line: number | null;
  endLine: number | null;
  markKey: string | null;
} | null;

let fileNoteSource: FileNoteSource | null = null;

export function registerFileNoteSource(fn: FileNoteSource | null): void {
  fileNoteSource = fn;
}

type FileNoteTarget = (payload: FileNoteDelivery) => number;

const fileTargets = new Map<string, FileNoteTarget>();

export function registerFileNoteTarget(sessionId: string, fn: FileNoteTarget | null): void {
  if (fn) fileTargets.set(sessionId, fn);
  else fileTargets.delete(sessionId);
}

/** 网页批注投递（内置浏览器元素备注 → 目标 GUI 会话，与文件批注同款 token/药丸） */
export interface WebNoteDelivery {
  label: string;
  selector: string;
  url: string;
  note: string;
  noteId: string;
  /** 元素区域截图（dataUrl；二次编辑卡展示，内存态不持久） */
  shot?: string;
}

type WebNoteTarget = (payload: WebNoteDelivery) => number;

const webTargets = new Map<string, WebNoteTarget>();

export function registerWebNoteTarget(sessionId: string, fn: WebNoteTarget | null): void {
  if (fn) webTargets.set(sessionId, fn);
  else webTargets.delete(sessionId);
}

export function deliverWebNote(targetSessionId: string, payload: WebNoteDelivery): number | null {
  const target = webTargets.get(targetSessionId);
  if (!target) return null;
  return target(payload);
}

/**
 * 文件批注捕获：当前 DOM 选区 + 已注册的路径/行号解析器（含文件内待定标记）。
 * 返回 null = 无可批注对象（无选区 / 没有打开的文本文件）。
 */
export function captureFileNote(): FileNoteCapture | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const quote = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 500);
  const anchor = fileNoteSource?.();
  if (!quote || !anchor) return null;
  return {
    quote,
    path: anchor.path,
    ...(anchor.fileRef ? { fileRef: anchor.fileRef } : {}),
    line: anchor.line,
    endLine: anchor.endLine,
    markKey: anchor.markKey
  };
}

/** 投递给目标会话；返回分配的批注序号，目标未挂载返回 null */
export function deliverFileNote(targetSessionId: string, payload: FileNoteDelivery): number | null {
  const target = fileTargets.get(targetSessionId);
  if (!target) return null;
  return target(payload);
}
