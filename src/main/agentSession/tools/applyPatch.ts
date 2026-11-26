/**
 * D1 ApplyPatch handler：结构化 patch 落盘（workspace 根内）。
 * 复用 workspaceFs 的根内约束与文本防护；操作语义见 shared/applyPatch。
 * 两阶段：先全量读盘+校验（纯函数层，任一失败则零写入），再顺序落盘
 * （update/move 带读取时的 mtime 乐观锁，外部并发修改拒绝盲写）。
 * 已知边界：CRLF 文件的 hunk 匹配按 LF 语义（fail-closed 拒绝而非模糊套用）；
 * 写阶段中途失败不回滚（message 明示已落盘文件数，工作区处于部分应用状态）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideRoot } from '../../../shared/workspacePath';
import {
  applyPatchOpToContent,
  countHunkLines,
  normalizeApplyPatchInput,
  ApplyPatchErrorCode,
  type ApplyPatchFileResult,
  type ApplyPatchInput,
  type ApplyPatchResult,
  type DiffHunk,
  type PatchFileOp
} from '../../../shared/applyPatch';
import { isTextPreviewKind, previewKindForPath } from '../../../shared/filePreview';
import { readText, writeText, removePath } from '../../workspaceFs';

async function existsInRoot(root: string, rel: string): Promise<boolean> {
  try {
    const abs = resolveInsideRoot(root, rel);
    const st = await fs.stat(abs);
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

function syntheticPatch(op: PatchFileOp, content: string | undefined): DiffHunk[] {
  const lines = content
    ? content.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''))
    : [];
  if (op.type === 'add') {
    return [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map((l) => `+${l}`)
      }
    ];
  }
  if (op.type === 'delete') {
    return [
      {
        oldStart: 1,
        oldLines: lines.length,
        newStart: 0,
        newLines: 0,
        lines: lines.map((l) => `-${l}`)
      }
    ];
  }
  return op.hunks ?? [];
}

/** 阶段一产物：单文件操作的全部落盘依据（读取/校验已完成，未产生任何写入） */
interface FilePlan {
  op: PatchFileOp;
  /** 依据的原文（update/move 需要；delete 不读） */
  original?: string;
  /** 读取时的 mtime 基线（update 写回乐观锁用） */
  mtimeMs?: number;
  /** 变换后的目标内容（delete 为 undefined） */
  next?: string;
}

type PlanOutcome =
  | { ok: true; plan: FilePlan }
  | { ok: false; error: ApplyPatchErrorCode; message: string };

/**
 * 阶段一：读盘 + 纯函数校验。关键纪律：
 * - 存在性以 fs.stat 为准（`existed`），**读取失败不视为不存在**——
 *   二进制/超大文件 readText 失败时 add 不得借「original=undefined」静默覆盖原内容；
 * - update/move 的 hunk 校验整体失败则本条目失败（不模糊套用）。
 */
async function planOneOp(root: string, op: PatchFileOp): Promise<PlanOutcome> {
  if (!isTextPreviewKind(previewKindForPath(op.filePath))) {
    return { ok: false, error: ApplyPatchErrorCode.IO_ERROR, message: `reject media path: ${op.filePath}` };
  }
  const existed = await existsInRoot(root, op.filePath);

  if (op.type === 'add') {
    if (existed) {
      return { ok: false, error: ApplyPatchErrorCode.FILE_EXISTS, message: op.filePath };
    }
    return { ok: true, plan: { op, next: op.content ?? '' } };
  }

  if (op.type === 'delete') {
    if (!existed) {
      return { ok: false, error: ApplyPatchErrorCode.FILE_NOT_EXIST, message: op.filePath };
    }
    return { ok: true, plan: { op } };
  }

  // update / move：需要原文作依据
  if (!existed) {
    return { ok: false, error: ApplyPatchErrorCode.FILE_NOT_EXIST, message: op.filePath };
  }
  if (op.type === 'move') {
    const dest = op.movePath!;
    if (!isTextPreviewKind(previewKindForPath(dest))) {
      return { ok: false, error: ApplyPatchErrorCode.IO_ERROR, message: `reject media path: ${dest}` };
    }
    if (await existsInRoot(root, dest)) {
      return { ok: false, error: ApplyPatchErrorCode.FILE_EXISTS, message: dest };
    }
  }
  const r = await readText(root, op.filePath);
  if (!r.ok) {
    // 读取失败 ≠ 不存在（二进制/超大/权限）：整体失败，绝不静默覆盖
    return {
      ok: false,
      error: ApplyPatchErrorCode.IO_ERROR,
      message: `read failed for ${op.filePath}: ${r.error ?? ''}`
    };
  }
  const applied = applyPatchOpToContent(op, r.content);
  if (!applied.ok) {
    return { ok: false, error: applied.error, message: `${op.type} ${op.filePath}` };
  }
  return {
    ok: true,
    plan: { op, original: r.content, mtimeMs: r.mtimeMs, next: applied.content }
  };
}

type WriteOutcome =
  | { ok: true; file: ApplyPatchFileResult }
  | { ok: false; error: ApplyPatchErrorCode; message: string };

/** 阶段二：落盘。update 带读取时 mtime 乐观锁；delete/move 的删除结果必须检查 */
async function writeOneOp(root: string, plan: FilePlan): Promise<WriteOutcome> {
  const { op } = plan;
  try {
    if (op.type === 'delete') {
      const r = await removePath(root, op.filePath);
      if (!r.ok) {
        return { ok: false, error: ApplyPatchErrorCode.IO_ERROR, message: `delete ${op.filePath}: ${r.error ?? ''}` };
      }
    } else if (op.type === 'move') {
      const dest = op.movePath!;
      await ensureParent(root, dest);
      // 写前复查目标存在性（TOCTOU 收窄：两阶段间外部创建同名文件不静默覆盖；
      // 与检查之间仍有微窗，见文件头「已知边界」）
      if (await existsInRoot(root, dest)) {
        return { ok: false, error: ApplyPatchErrorCode.FILE_EXISTS, message: `move → ${dest}: 目标已存在` };
      }
      // 目标是新文件，无 mtime 基线；源内容依据已在阶段一捕获
      const w = await writeText(root, dest, plan.next ?? plan.original ?? '');
      if (!w.ok) {
        return { ok: false, error: ApplyPatchErrorCode.IO_ERROR, message: `move → ${dest}: ${w.error ?? ''}` };
      }
      const rm = await removePath(root, op.filePath);
      if (!rm.ok) {
        return {
          ok: false,
          error: ApplyPatchErrorCode.IO_ERROR,
          message: `move 目标已写入 ${dest}，但源文件删除失败: ${rm.error ?? ''}`
        };
      }
    } else if (op.type === 'add') {
      await ensureParent(root, op.filePath);
      // 写前复查存在性（同上：收窄两阶段 TOCTOU 窗口）
      if (await existsInRoot(root, op.filePath)) {
        return { ok: false, error: ApplyPatchErrorCode.FILE_EXISTS, message: `add ${op.filePath}: 文件已存在` };
      }
      const w = await writeText(root, op.filePath, plan.next ?? '');
      if (!w.ok) {
        return { ok: false, error: ApplyPatchErrorCode.IO_ERROR, message: `add ${op.filePath}: ${w.error ?? ''}` };
      }
    } else {
      // update：带阶段一读取的 mtime 基线，外部并发修改拒绝盲写
      const w = await writeText(root, op.filePath, plan.next ?? '', plan.mtimeMs);
      if (!w.ok) {
        return { ok: false, error: ApplyPatchErrorCode.IO_ERROR, message: `update ${op.filePath}: ${w.error ?? ''}` };
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: ApplyPatchErrorCode.IO_ERROR,
      message: (e as Error).message ?? String(e)
    };
  }
  const structuredPatch = syntheticPatch(op, plan.next);
  const { additions, deletions } = countHunkLines(structuredPatch);
  return {
    ok: true,
    file: {
      filePath: op.filePath,
      type: op.type,
      ...(op.movePath ? { movePath: op.movePath } : {}),
      additions,
      deletions,
      structuredPatch
    }
  };
}

async function ensureParent(root: string, rel: string): Promise<void> {
  const abs = resolveInsideRoot(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
}

/**
 * 在 workspace 根内应用结构化 patch。
 * 入参统一走 normalize（对已归一形状幂等）；返回逐文件结果与错误码。
 * 两阶段：校验全过才进写阶段；写阶段中途失败不回滚（message 明示进度）。
 */
export async function applyPatchToWorkspace(root: string, raw: unknown): Promise<ApplyPatchResult> {
  const input: ApplyPatchInput | undefined = normalizeApplyPatchInput(raw);
  if (!input || !input.files.length) {
    return { ok: false, files: [], error: ApplyPatchErrorCode.EMPTY_PATCH, message: 'empty patch' };
  }
  // 阶段一：全量读取 + 校验（任一失败 → 零写入）
  const plans: FilePlan[] = [];
  for (const op of input.files) {
    const p = await planOneOp(root, op);
    if (!p.ok) {
      return { ok: false, files: [], error: p.error, message: p.message };
    }
    plans.push(p.plan);
  }
  // 阶段二：顺序落盘
  const results: ApplyPatchFileResult[] = [];
  for (const plan of plans) {
    const w = await writeOneOp(root, plan);
    if (!w.ok) {
      return {
        ok: false,
        files: results,
        error: w.error,
        message: `${w.message}（已落盘 ${results.length}/${plans.length} 个文件，工作区处于部分应用状态）`
      };
    }
    results.push(w.file);
  }
  return { ok: true, files: results };
}

/** 供 catalog/GuiHostTool 暴露的入口：root + args → 结果 */
export async function handleApplyPatch(
  root: string,
  args: Record<string, unknown>
): Promise<ApplyPatchResult> {
  return applyPatchToWorkspace(root, args);
}
