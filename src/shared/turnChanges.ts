/** Host-owned file changes; file contents stay outside the transcript. */
export interface TurnChangedFile {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  added: number | null;
  removed: number | null;
  diffOmitted?: boolean;
  revertible: boolean;
  /** Absent in historical snapshots written before path-scoped capture. */
  origin?: 'native-tool' | 'observed-tool' | 'provider-diff' | 'explicit-batch' | 'mixed';
  reason?: string;
  reverted?: boolean;
}

export const TURN_FILE_LIMIT = 1024 * 1024;
export const TURN_DIFF_OMITTED = '超出审阅大小上限，仅记录文件变化。';
export const TURN_FILE_COLLISION = '其他会话同时修改了该文件';
export const TURN_FILE_COLLISION_PRESERVED = '其他会话同时修改了该文件，已保留当前内容';
export type ReportedFileChange = { path: string; kind?: string; diff: string; diffOmitted?: boolean };

export interface TurnChanges {
  /** Identity captured before execution and checked at settlement; absent means unknown. */
  repository?: {root:string;branch:string|null;baseCommit:string|null;endCommit?:string|null;scopeStable:boolean};
  id: string;
  state: 'collecting' | 'ready' | 'error';
  /** Background preparation status for review; never blocks provider execution. */
  preparing?: boolean;
  finalizing?: boolean;
  files: TurnChangedFile[];
  warnings: string[];
  concurrentEdits?: TurnConcurrentEdit[];
}

export interface TurnConcurrentEdit {
  path: string;
  otherOwner: string;
  otherLabel: string;
}

export function isTurnFileCollision(summary: TurnChanges, file: TurnChangedFile): boolean {
  return file.reason === TURN_FILE_COLLISION || summary.concurrentEdits?.some(edit => edit.path === file.path) === true;
}

export type TurnChangeOwner = { kind: 'gui' | 'dispatch'; id: string };
export type TurnChangeTarget = TurnChangeOwner & { messageId: string };
export interface TurnReviewEntry {
  target: TurnChangeTarget;
  summary: TurnChanges;
  label: string;
  createdAt: number;
}
export interface TurnRevertResult {
  ok: boolean;
  summary?: TurnChanges;
  restored: string[];
  conflicts: Array<{ path: string; reason: string }>;
  error?: string;
}

/** Persisted warnings describe capture coverage at turn start, never live progress. */
export const TURN_BASELINE_UNAVAILABLE = '本轮开始时文件基线尚未就绪（预热或重新校验），已按文件采集写前原文；缺少可靠写前记录的变化可能未完整覆盖，且不会自动回退';
export function turnChangeWarningText(warning: string): string {
  if (warning === '文件基线仍在后台校验，Shell 变化可能未完整覆盖；已确认的工具文件仍按原文核对') return '本轮结束时未完成文件校验，Shell 改动记录可能不完整；此为历史记录，不表示当前仍在校验';
  return warning === '文件基线正在后台预热，本轮按文件采集写前原文；无可靠写前事件的变化可能未完整覆盖，且不会自动回退' ? TURN_BASELINE_UNAVAILABLE : warning;
}

export function turnChangesStatusText(summary: TurnChanges): string {
  return summary.finalizing ? '正在校验并保存本轮改动…' : '正在记录本轮改动…';
}
