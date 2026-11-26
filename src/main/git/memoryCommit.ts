/**
 * 记忆写入后把 docs/memory 自动提交，避免主仓脏文件挡住 integrate（P8）。
 * 调用方：面板/记忆中心 IPC、memory.remember 直写、巩固 apply 写盘。
 * pathspec 仅 `docs/memory`（USER.md 在 userData、调度 MEMORY 在 .muster/scheduler
 * 均不进本仓 git）。原 memory.append/remove 工具已随 B8 退役。无 electron 依赖。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { t } from '../../shared/i18n';
import { gitCommandEnvironment } from './gitEnvironment';

const execFileAsync = promisify(execFile);

async function gitAllowFail(
  cwd: string,
  args: string[]
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: gitCommandEnvironment(),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    });
    return { ok: true, out: String(stdout ?? '').trim(), err: '' };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    return { ok: false, out: '', err: stderr || String(err.message ?? e) };
  }
}

export type MemoryCommitResult = {
  ok: boolean;
  skipped?: boolean;
  committed?: boolean;
  message?: string;
};

const MEMORY_PATHSPEC = ['--', 'docs/memory'];

/** 工作区若是 git 仓且 docs/memory 有未提交改动，则 add + commit。失败不抛，由调用方记入结果。 */
export async function commitMemoryChanges(root: string): Promise<MemoryCommitResult> {
  const top = await gitAllowFail(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: true, skipped: true, message: t('当前工作区不是 git 仓库，记忆未自动提交') };
  const cwd = top.out;
  const st = await gitAllowFail(cwd, ['status', '--porcelain', ...MEMORY_PATHSPEC]);
  if (!st.ok) return { ok: false, message: st.err };
  if (!st.out.trim()) return { ok: true, skipped: true };
  const add = await gitAllowFail(cwd, ['add', ...MEMORY_PATHSPEC]);
  if (!add.ok) return { ok: false, message: add.err };
  const commit = await gitAllowFail(cwd, [
    'commit',
    '-m',
    'chore(memory): persist MEMORY.md'
  ]);
  if (!commit.ok) return { ok: false, message: commit.err };
  return { ok: true, committed: true };
}
