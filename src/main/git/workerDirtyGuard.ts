/**
 * P11：隔离树脏检查与兜底提交（不替 Worker 写业务说明，提交信息带 [host] P11 标注）。
 * 无 electron 依赖。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fallbackCommitMessage, parsePorcelainPaths } from '../../shared/workerStatusGuard';
import { gitCommandEnvironment } from './gitEnvironment';

const execFileAsync = promisify(execFile);

async function gitAllowFail(
  cwd: string,
  args: string[]
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['--work-tree', path.resolve(cwd), ...args], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      env: gitCommandEnvironment(),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    });
    return { ok: true, out: String(stdout ?? ''), err: '' };
  } catch (e) {
    const err = e as { stderr?: string; message?: string; stdout?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    return { ok: false, out: String(err.stdout ?? ''), err: stderr || String(err.message ?? e) };
  }
}

export async function listDirtyPaths(cwd: string): Promise<string[]> {
  const st = await gitAllowFail(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!st.ok) throw new Error(`git status failed in ${cwd}: ${st.err}`);
  return parsePorcelainPaths(st.out);
}

export type FallbackCommitResult = {
  ok: boolean;
  committed?: boolean;
  skipped?: boolean;
  message?: string;
  paths?: string[];
  headCommit?: string;
};

/** Host-only guards; not exposed through GitService or a model/renderer tool. */
export interface WorkerSnapshotGuards {
  beforeWrite(stage: 'stage' | 'commit'): Promise<void>;
  afterCommit(headCommit: string): Promise<void>;
}

/** 把当前未提交改动整包提交；失败不抛。 */
export async function fallbackCommitDirtyTree(cwd: string, guards?: WorkerSnapshotGuards): Promise<FallbackCommitResult> {
  let paths: string[];
  let committed = false, headCommit: string | undefined;
  try {
    paths = await listDirtyPaths(cwd);
    if (paths.length === 0) return { ok: true, skipped: true, paths };
    await guards?.beforeWrite('stage');
    const add = await gitAllowFail(cwd, ['add', '-A']);
    if (!add.ok) return { ok: false, message: add.err, paths };
    await guards?.beforeWrite('commit');
    const commit = await gitAllowFail(cwd, ['commit', '-m', fallbackCommitMessage()]);
    if (!commit.ok) return { ok: false, message: commit.err, paths };
    committed = true;
    const head = await gitAllowFail(cwd, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(head.err);
    headCommit = head.out.trim();
    await guards?.afterCommit(headCommit);
    return { ok: true, committed, paths, headCommit };
  } catch (error) {
    return { ok: false, ...(committed ? { committed, headCommit } : {}), message: error instanceof Error ? error.message : String(error) };
  }
}
