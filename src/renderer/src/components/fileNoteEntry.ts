/**
 * 文件批注录入框（批注框）单例控制器：file-editor 区划词「批注」→ 这里捕获
 * 选区+路径+行号+文件内待定标记，宿主组件（FileNoteEntryHost，App 根部常驻）
 * 贴着划词浮条弹出录入框；确认后按目标类型投递——GUI 会话进输入框（token 带
 * 批注文字），CLI 会话把展开文字直接粘进终端输入。
 * 文件内计数角标点击 → openFileNoteEdit 打开二次编辑（edit 模式），批注正文
 * 存在下方记录表里（渲染层内存态），会话批注经 noteBridge 的 editor 路由回写。
 * 与 selectionMenuController 同配方：模块级单例状态 + 订阅，无 React 依赖。
 */

import { captureFileNote, type FileNoteCapture } from '../agentChat/noteBridge';

/** 批注投递目标：GUI 会话=批注 token 进输入框；CLI 会话=展开文字粘贴到终端输入 */
export type FileNoteTargetKind = 'chat' | 'terminal';

export interface FileNoteEntryState {
  nonce: number;
  /** create=新批注（贴划词浮条）；edit=角标点击的二次编辑（贴屏幕居中偏上） */
  mode: 'create' | 'edit';
  capture: FileNoteCapture;
  /** create 必带；edit 按 record.sessionId 还原（终端流无会话则缺省） */
  target?: { kind: FileNoteTargetKind; id: string; name: string };
  /** edit 模式：批注 id 与已有正文 */
  noteId?: string;
  initialNote?: string;
  /** 划词浮条的位置（视口坐标）：录入框优先贴其上方 */
  anchor: { left: number; top: number; bottom: number } | null;
}

/** 已确认文件批注的正文记录（角标二次编辑的数据源；noteId 键） */
export interface FileNoteRecord {
  fileRef?: import('../../../shared/types').WorkspaceFileRef;
  noteId: string;
  seq: number;
  quote: string;
  path: string;
  line: number | null;
  endLine: number | null;
  note: string;
  /** GUI 会话目标才有：更新/删除路由回会话 */
  sessionId?: string;
}

const records = new Map<string, FileNoteRecord>();

export function putFileNoteRecord(r: FileNoteRecord): void {
  records.set(r.noteId, r);
}

export function getFileNoteRecord(noteId: string): FileNoteRecord | undefined {
  return records.get(noteId);
}

export function removeFileNoteRecord(noteId: string): void {
  records.delete(noteId);
}

let state: FileNoteEntryState | null = null;
const listeners = new Set<() => void>();

function emit(next: FileNoteEntryState | null): void {
  state = next;
  for (const fn of listeners) fn();
}

export function subscribeFileNoteEntry(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function readFileNoteEntry(): FileNoteEntryState | null {
  return state;
}

/**
 * 打开录入框（create）：立即捕获当前选区与文件锚点（含文件内待定标记）。
 * 返回 'no-source' 表示无可批注对象（无选区 / 没有打开的文本文件）。
 */
export function openFileNoteEntry(args: {
  target: { kind: FileNoteTargetKind; id: string; name: string };
  barRect?: DOMRect | null;
}): 'ok' | 'no-source' {
  const capture = captureFileNote();
  if (!capture) return 'no-source';
  const r = args.barRect;
  emit({
    nonce: Date.now(),
    mode: 'create',
    capture,
    target: args.target,
    anchor: r ? { left: r.left, top: r.top, bottom: r.bottom } : null
  });
  return 'ok';
}

/** 打开二次编辑（edit）：按批注 id 查记录；无记录（会话已清等）返回 false */
export function openFileNoteEdit(noteId: string): boolean {
  const rec = records.get(noteId);
  if (!rec) return false;
  emit({
    nonce: Date.now(),
    mode: 'edit',
    noteId,
    initialNote: rec.note,
    capture: {
      quote: rec.quote,
      path: rec.path,
      ...(rec.fileRef ? { fileRef: rec.fileRef } : {}),
      line: rec.line,
      endLine: rec.endLine,
      markKey: null
    },
    target: rec.sessionId
      ? { kind: 'chat', id: rec.sessionId, name: rec.sessionId }
      : { kind: 'terminal', id: '', name: '' },
    anchor: null
  });
  return true;
}

export function closeFileNoteEntry(): void {
  emit(null);
}
