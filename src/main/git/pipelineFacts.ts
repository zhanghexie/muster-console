/**
 * R2：隔离树机械 git 事实（不改 mergeIsolate）。无 electron 依赖。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { parsePorcelainPaths } from '../../shared/workerStatusGuard';
import { gitCommandEnvironment } from './gitEnvironment';

const execFileAsync = promisify(execFile);

export interface PipelineGitFacts {
  uncommittedCount: number;
  aheadCount: number;
  canFastForward: boolean;
  dirtyOverlap: boolean;
  lastFileWriteAt?: number;
  overlapFiles: string[];
  /** 隔离树脏路径（上限 50）；sessions.observe 用，sessions.observe 可不透出 */
  dirtyPaths: string[];
  lastCommit?: { hash: string; subject: string };
}

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
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024
    });
    return { ok: true, out: String(stdout ?? ''), err: '' };
  } catch (e) {
    const err = e as { stderr?: string; message?: string; stdout?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    return { ok: false, out: String(err.stdout ?? ''), err: stderr || String(err.message ?? e) };
  }
}

function maxMtimeMs(cwd: string, rels: string[]): number | undefined {
  let max = 0;
  for (const rel of rels.slice(0, 80)) {
    try {
      const st = fs.statSync(path.join(cwd, rel));
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch {
      /* missing */
    }
  }
  return max > 0 ? max : undefined;
}

/**
 * 停滞扫描用的轻量活动时间：只看隔离树 dirty mtime + 最近提交时刻。
 * 不打主仓（无 ahead / merge-base / 脏重叠），避免定时扫描 git 风暴。
 */
export async function collectWorktreeLastWriteAt(worktreePath: string): Promise<number | undefined> {
  const wt = worktreePath?.trim() ?? '';
  if (!wt || !fs.existsSync(wt)) return undefined;
  const porcelain = await gitAllowFail(wt, ['status', '--porcelain']);
  const dirty = porcelain.ok ? parsePorcelainPaths(porcelain.out) : [];
  let lastFileWriteAt = maxMtimeMs(wt, dirty);
  const commitLog = await gitAllowFail(wt, ['log', '-1', '--format=%H%x09%s%x09%ct']);
  if (commitLog.ok) {
    const [, , ct] = commitLog.out.trim().split('\t');
    const sec = Number.parseInt(ct ?? '', 10);
    if (Number.isFinite(sec) && sec > 0) {
      const ms = sec * 1000;
      lastFileWriteAt = lastFileWriteAt && lastFileWriteAt > ms ? lastFileWriteAt : ms;
    }
  }
  return lastFileWriteAt;
}

export async function collectPipelineGitFacts(opts: {
  worktreePath: string;
  mainRepo: string;
  branch?: string;
}): Promise<PipelineGitFacts> {
  const empty: PipelineGitFacts = {
    uncommittedCount: 0,
    aheadCount: 0,
    canFastForward: false,
    dirtyOverlap: false,
    overlapFiles: [],
    dirtyPaths: []
  };
  const wt = opts.worktreePath;
  if (!wt || !fs.existsSync(wt) || !opts.mainRepo) return empty;

  const porcelain = await gitAllowFail(wt, ['status', '--porcelain']);
  const dirty = porcelain.ok ? parsePorcelainPaths(porcelain.out) : [];
  const uncommittedCount = dirty.length;

  const head = await gitAllowFail(opts.mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const target = head.ok && head.out.trim() && head.out.trim() !== 'HEAD' ? head.out.trim() : 'main';

  const branch = (opts.branch ?? '').trim();
  let aheadCount = 0;
  let canFastForward = false;
  const mergeFiles: string[] = [];
  if (branch) {
    const ahead = await gitAllowFail(opts.mainRepo, ['rev-list', '--count', `${target}..${branch}`]);
    if (ahead.ok) {
      const n = Number.parseInt(ahead.out.trim(), 10);
      if (Number.isFinite(n) && n >= 0) aheadCount = n;
    }
    const anc = await gitAllowFail(opts.mainRepo, ['merge-base', '--is-ancestor', target, branch]);
    canFastForward = anc.ok;
    const names = await gitAllowFail(opts.mainRepo, ['diff', '--name-only', `${target}...${branch}`]);
    if (names.ok) {
      for (const line of names.out.split(/\r?\n/)) {
        const p = line.trim();
        if (p) mergeFiles.push(p);
      }
    }
  }

  const mainDirty = await gitAllowFail(opts.mainRepo, ['status', '--porcelain']);
  const mainPaths = new Set(mainDirty.ok ? parsePorcelainPaths(mainDirty.out) : []);
  const overlapFiles = mergeFiles.filter((f) => mainPaths.has(f)).slice(0, 20);

  const commitLog = await gitAllowFail(wt, ['log', '-1', '--format=%H%x09%s%x09%ct']);
  let lastFileWriteAt = maxMtimeMs(wt, dirty);
  let lastCommit: PipelineGitFacts['lastCommit'];
  if (commitLog.ok) {
    const [hash, subject, ct] = commitLog.out.trim().split('\t');
    if (hash) lastCommit = { hash, subject: subject ?? '' };
    const sec = Number.parseInt(ct ?? '', 10);
    if (Number.isFinite(sec) && sec > 0) {
      const ms = sec * 1000;
      lastFileWriteAt = lastFileWriteAt && lastFileWriteAt > ms ? lastFileWriteAt : ms;
    }
  }

  return {
    uncommittedCount,
    aheadCount,
    canFastForward,
    dirtyOverlap: overlapFiles.length > 0,
    ...(lastFileWriteAt ? { lastFileWriteAt } : {}),
    overlapFiles,
    dirtyPaths: dirty.slice(0, 50),
    ...(lastCommit ? { lastCommit } : {})
  };
}
