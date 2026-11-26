/**
 * 文件批注的文件内标记（角标留痕）：FileEditor 挂载时注册 API——
 * - CodeMirror 编辑态： Decoration mark（.msg-note-anchor 观感，随文档编辑映射位置）；
 * - md/html 预览态： wrapNoteAnchor 包 span（与会话批注同款 DOM 锚点）。
 * 批注框打开即落待定标记（is-pending），确认转正（回填批注 id）、取消/删除即摘除；
 * 会话侧删除批注（AgentChatView）经 removeFileNoteMark 同步摘文件内标记。
 * 单例：FileEditor 全局只有 FilesPanel 一份。
 */

export interface FileNoteMarkRange {
  from: number;
  to: number;
}

export interface FileNoteMarksApi {
  /** 编辑态：在 CM 偏移区间落待定标记，返回标记 key */
  placePendingCM: (range: FileNoteMarkRange) => string | null;
  /** 预览态：包住 DOM 选区落待定标记，返回标记 key */
  placePendingPreview: (range: Range) => string | null;
  /** 待定标记转正（回填批注 id；seq=计数角标序号，缺省用编辑器内部计数） */
  confirmMark: (key: string, noteId: string, seq?: number) => void;
  /** 撤销待定标记（录入框取消/放弃） */
  cancelMark: (key: string) => void;
  /** 按批注 id 摘除标记（会话侧删除/对账） */
  removeMark: (noteId: string) => void;
}

let api: FileNoteMarksApi | null = null;

export function registerFileNoteMarks(next: FileNoteMarksApi | null): void {
  api = next;
}

export function placePendingFileNoteMarkCM(range: FileNoteMarkRange): string | null {
  return api?.placePendingCM(range) ?? null;
}

export function placePendingFileNoteMarkPreview(range: Range): string | null {
  return api?.placePendingPreview(range) ?? null;
}

export function confirmFileNoteMark(key: string, noteId: string, seq?: number): void {
  api?.confirmMark(key, noteId, seq);
}

export function cancelFileNoteMark(key: string): void {
  api?.cancelMark(key);
}

export function removeFileNoteMark(noteId: string): void {
  api?.removeMark(noteId);
}
