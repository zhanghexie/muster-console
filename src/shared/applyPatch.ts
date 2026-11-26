/**
 * D1 ApplyPatch 结构化 patch 契约（纯函数层，主进程/测试共用）。
 * 产品裁决：可选工具（Edit/Write 仍默认）；操作 add|update|delete|move + DiffHunk；
 * 变更预览与 permission option 打通（filePaths + fileChange: add|update）。
 * 零依赖（test/*.mjs 即时转译导入）。
 */
import { FILE_PATHS_MAX, type FileChangeKind, type PermissionPreview } from './permissionOption';

// ---------- DiffHunk（统一 diff 行：' ' 上下文 / '+' 新增 / '-' 删除） ----------

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type PatchOpType = 'add' | 'update' | 'delete' | 'move';

export const PATCH_OP_TYPES: readonly PatchOpType[] = ['add', 'update', 'delete', 'move'];

/** 单文件操作；move 可附 hunks（移动时同步改内容） */
export interface PatchFileOp {
  type: PatchOpType;
  filePath: string;
  /** type=move 的目标路径 */
  movePath?: string;
  /** type=add 的新文件全文；type=update/move 的 hunk 序列 */
  content?: string;
  hunks?: DiffHunk[];
}

export interface ApplyPatchInput {
  files: PatchFileOp[];
}

export const ApplyPatchErrorCode = {
  INVALID_PATCH: 'apply_patch_invalid_patch',
  EMPTY_PATCH: 'apply_patch_empty_patch',
  FILE_NOT_EXIST: 'apply_patch_file_not_exist',
  FILE_EXISTS: 'apply_patch_file_exists',
  HUNK_NOT_FOUND: 'apply_patch_hunk_not_found',
  IO_ERROR: 'apply_patch_io_error'
} as const;
export type ApplyPatchErrorCode = (typeof ApplyPatchErrorCode)[keyof typeof ApplyPatchErrorCode];

export interface ApplyPatchFileResult {
  filePath: string;
  type: PatchOpType;
  movePath?: string;
  additions: number;
  deletions: number;
  structuredPatch: DiffHunk[];
}

export interface ApplyPatchResult {
  ok: boolean;
  files: ApplyPatchFileResult[];
  error?: ApplyPatchErrorCode;
  message?: string;
}

// ---------- 校验 / 归一 ----------

function normPath(p: unknown): string {
  return typeof p === 'string' ? p.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
}

function isDiffHunk(v: unknown): v is DiffHunk {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.oldStart === 'number' &&
    typeof o.oldLines === 'number' &&
    typeof o.newStart === 'number' &&
    typeof o.newLines === 'number' &&
    Array.isArray(o.lines) &&
    o.lines.every((l) => typeof l === 'string')
  );
}

function normalizeHunks(raw: unknown): DiffHunk[] {
  if (!Array.isArray(raw)) return [];
  const out: DiffHunk[] = [];
  for (const h of raw) {
    if (!isDiffHunk(h)) continue;
    out.push({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines.map((l) => l)
    });
  }
  return out;
}

/** 解析并校验 patch 入参；非法条目丢弃，空 patch 返回 undefined */
export function normalizeApplyPatchInput(raw: unknown): ApplyPatchInput | undefined {
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { files?: unknown }).files)
      ? (raw as { files: unknown[] }).files
      : Array.isArray(raw)
        ? raw
        : [];
  const files: PatchFileOp[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    const type = o.type;
    if (type !== 'add' && type !== 'update' && type !== 'delete' && type !== 'move') continue;
    const filePath = normPath(o.filePath ?? o.path);
    if (!filePath) continue;
    const op: PatchFileOp = { type, filePath };
    if (type === 'move') {
      const movePath = normPath(o.movePath ?? o.destination);
      if (!movePath) continue;
      op.movePath = movePath;
      const hunks = normalizeHunks(o.hunks ?? o.structuredPatch);
      if (hunks.length) op.hunks = hunks;
    } else if (type === 'add') {
      const content = typeof o.content === 'string' ? o.content : undefined;
      if (content === undefined) continue;
      op.content = content;
    } else if (type === 'update') {
      const hunks = normalizeHunks(o.hunks ?? o.structuredPatch);
      if (!hunks.length) continue;
      op.hunks = hunks;
    }
    files.push(op);
  }
  return files.length ? { files } : undefined;
}

// ---------- 纯内容变换 ----------

function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  // 尾部空串是「末行自带换行」的产物，去掉
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 重组行文本：保留原文的尾换行形态（原文无尾换行不强行添加，有则保留） */
function joinLines(lines: readonly string[], original: string): string {
  if (!lines.length) return '';
  const body = lines.join('\n');
  return original.endsWith('\n') ? `${body}\n` : body;
}

/** 统计 hunk 的新增/删除行数 */
export function countHunkLines(hunks: readonly DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * 将 DiffHunk 应用到原文内容（纯函数）。
 * 行格式统一 diff：' ' 上下文 / '+' 新增 / '-' 删除；oldStart 为 1 基。
 * 上下文不匹配或行号越界 → undefined（调用方报 HUNK_NOT_FOUND）。
 */
export function applyHunksToContent(original: string, hunks: readonly DiffHunk[]): string | undefined {
  if (!hunks.length) return original;
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  const src = splitLines(original);
  const out: string[] = [];
  let cursor = 0; // 0 基下标，指向 src 中尚未拷贝的下一行
  for (const hunk of sorted) {
    const start = hunk.oldStart - 1;
    if (start < cursor || start > src.length) return undefined;
    // 拷贝 hunk 前的未触及行
    while (cursor < start) {
      out.push(src[cursor]);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      const tag = line.charAt(0);
      const text = line.slice(1);
      if (tag === ' ') {
        if (cursor >= src.length || src[cursor] !== text) return undefined;
        out.push(text);
        cursor += 1;
      } else if (tag === '-') {
        if (cursor >= src.length || src[cursor] !== text) return undefined;
        cursor += 1;
      } else if (tag === '+') {
        out.push(text);
      }
      // 其它前缀忽略（容错）
    }
  }
  while (cursor < src.length) {
    out.push(src[cursor]);
    cursor += 1;
  }
  return joinLines(out, original);
}

/**
 * 单文件操作的内容变换（纯函数）。
 * - add: 直接用 content（目标已存在 → FILE_EXISTS）
 * - update/move+hunks: 对 original 应用 hunks（失败 → HUNK_NOT_FOUND）
 * - delete/move 无 hunks: 由 handler 处理文件级动作，这里只关心内容
 */
export function applyPatchOpToContent(
  op: PatchFileOp,
  original: string | undefined
): { ok: true; content: string | undefined } | { ok: false; error: ApplyPatchErrorCode } {
  if (op.type === 'add') {
    if (original !== undefined) return { ok: false, error: ApplyPatchErrorCode.FILE_EXISTS };
    return { ok: true, content: op.content ?? '' };
  }
  if (op.type === 'delete') {
    if (original === undefined) return { ok: false, error: ApplyPatchErrorCode.FILE_NOT_EXIST };
    return { ok: true, content: undefined };
  }
  // update / move（内容部分）
  if (original === undefined) return { ok: false, error: ApplyPatchErrorCode.FILE_NOT_EXIST };
  const hunks = op.hunks ?? [];
  if (!hunks.length) return { ok: true, content: original };
  const next = applyHunksToContent(original, hunks);
  if (next === undefined) return { ok: false, error: ApplyPatchErrorCode.HUNK_NOT_FOUND };
  return { ok: true, content: next };
}

// ---------- 变更预览（permission option 打通） ----------

/** 从 patch 操作汇总 fileChange：全 add → add，否则 update（delete/move 归 update） */
export function patchFileChange(ops: readonly PatchFileOp[]): FileChangeKind {
  if (ops.length && ops.every((o) => o.type === 'add')) return 'add';
  return 'update';
}

/** 收集预览路径：各 op 的 filePath；move 附带 movePath；上限 FILE_PATHS_MAX */
export function patchFilePaths(ops: readonly PatchFileOp[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    const key = p.toLowerCase();
    if (!p || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const op of ops) {
    if (out.length >= FILE_PATHS_MAX) break;
    push(op.filePath);
    if (op.type === 'move' && op.movePath) push(op.movePath);
  }
  return out.slice(0, FILE_PATHS_MAX);
}

/**
 * ApplyPatch → permission option 文件变更预览（scope=file，filePaths + fileChange）。
 * 确认门（ConfirmDialog / PermissionOptionBody）直接展示此结构。
 */
export function buildApplyPatchPreview(ops: readonly PatchFileOp[]): PermissionPreview {
  return {
    scope: 'file',
    filePaths: patchFilePaths(ops),
    fileChange: patchFileChange(ops)
  };
}

/**
 * 从工具参数推导 ApplyPatch 预览（供 previewFromToolArgs / 确认门调用）。
 * 认 `files` 数组（PatchFileOp 形状）或已归一的 ApplyPatchInput。
 */
export function applyPatchPreviewFromArgs(args: Record<string, unknown>): PermissionPreview | undefined {
  const input = normalizeApplyPatchInput(args.files ?? args.patch ?? args);
  if (!input) return undefined;
  return buildApplyPatchPreview(input.files);
}
