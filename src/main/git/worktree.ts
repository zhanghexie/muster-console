/**
 * worktree 纯函数助手（P3.5）：porcelain 解析 / 目录名与分支名 / exclude 注入。
 * 无 electron 依赖，便于离线单测（test/git-worktree.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readGitDirectories } from './repoIdentity';

export interface WorktreePorcelainEntry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

/** `git worktree list --porcelain` 输出解析（AO parse.go 同款逐块读取） */
export function parseWorktreePorcelain(out: string): WorktreePorcelainEntry[] {
  const entries: WorktreePorcelainEntry[] = [];
  let cur: Partial<WorktreePorcelainEntry> | null = null;
  const flush = (): void => {
    if (cur && typeof cur.path === 'string' && cur.path) {
      entries.push(cur as WorktreePorcelainEntry);
    }
    cur = null;
  };
  for (const rawLine of String(out ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length).trim() };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line === 'detached') {
      cur.detached = true;
    }
  }
  flush();
  return entries;
}

/** worktree 目录名/分支名里的非法字符压成 -，避免 Windows 路径/refs 问题 */
export function slugifyWorktree(name: string): string {
  const slug = name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 32);
  return slug || 'work';
}

/** 会话短 id：UUID 去连字符后前 8 位，目录名与 ao/<id8> 同源 */
export function sessionWorktreeId8(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8) || 'session';
}

/**
 * 会话 worktree 目录名：纯 <sessionId 前 8 位>，与分支 ao/<id8> 对齐。
 * 存量 `<id8>-<slug>` 长名目录由会话 worktreePath 寻址，不迁移。
 */
export function sessionWorktreeDirName(sessionId: string): string {
  return sessionWorktreeId8(sessionId);
}

/** 分支命名空间：ao/<sessionId 前 8 位> */
export function sessionWorktreeBranch(sessionId: string): string {
  return `ao/${sessionWorktreeId8(sessionId)}`;
}

/** `git symbolic-ref refs/remotes/origin/HEAD` → 短分支名；非法输出返回 null */
export function parseOriginHeadRef(raw: string): string | null {
  const t = String(raw ?? '').trim();
  const m = /^refs\/remotes\/origin\/(.+)$/.exec(t);
  if (m?.[1]) return m[1];
  const short = /^origin\/(.+)$/.exec(t);
  return short?.[1] ?? null;
}

/**
 * 解析「主分支」：优先 origin/HEAD，否则本地 main/master，再退回当前分支。
 */
export function pickDefaultBranch(opts: {
  originHead?: string | null;
  localBranches: readonly string[];
  current?: string | null;
}): string {
  const locals = new Set(opts.localBranches.filter(Boolean));
  const origin = opts.originHead?.trim();
  if (origin && locals.has(origin)) return origin;
  for (const n of ['main', 'master']) {
    if (locals.has(n)) return n;
  }
  const cur = opts.current?.trim();
  if (cur && cur !== 'HEAD') return cur;
  return origin || 'main';
}

/**
 * 主仓库 .git/info/exclude 追加 `/.worktrees/`（不碰用户 .gitignore）。
 * 幂等：已包含该行时不动。.git 是 gitfile（自身已是 worktree）时用 common dir。
 */
export function ensureWorktreesExclude(mainRepoPath: string): void {
  ensureGitDirectoryExcludes(mainRepoPath, ['.worktrees']);
}

export function ensureGitDirectoryExcludes(repo: string, relativePaths: string[]): void {
  try {
    const dirs = readGitDirectories(repo);
    if (!dirs) throw new Error(`Cannot resolve Git directory: ${repo}`);
    const excludeFile = path.join(dirs.commonDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    let content = '';
    try {
      content = fs.readFileSync(excludeFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const present = new Set(content.split(/\r?\n/).map((line) => line.trim()));
    const lines = relativePaths.map((rel) => `/${rel.replace(/[\\*?\[\]]/g, '\\$&')}/`)
      .filter((line) => !present.has(line));
    if (!lines.length) return;
    const next = `${content.replace(/\s*$/, '')}\n# Muster Console: session worktrees\n${lines.join('\n')}\n`;
    fs.writeFileSync(excludeFile, next, 'utf8');
  } catch (error) {
    // Callers that materialize nested repositories must not treat a failed exclusion as success.
    throw error;
  }
}
