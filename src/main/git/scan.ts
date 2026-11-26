import fs from 'node:fs/promises';
import path from 'node:path';
import { SKIP_DIR_NAMES as WORKSPACE_SKIP_DIR_NAMES } from '../workspaceSkipDirs';

/** 扫描时跳过的目录名（大小写按原文匹配常见构建产物） */
const SKIP_DIR_NAMES = new Set([
  ...WORKSPACE_SKIP_DIR_NAMES,
  'node_modules',
  'out',
  'dist',
  'build',
  'Binaries',
  'Intermediate',
  'DerivedDataCache',
  'Saved',
  '.vs',
  '.git',
  '.worktrees',
  '.muster',
  'obj',
  'coverage',
  '.turbo',
  '.cache'
]);

/** 单层并发 readdir 数量上限，避免 metaapp 这类深目录一次炸出几千个句柄 */
const READDIR_CONCURRENCY = 16;

export interface GitScanIssue { path: string; message: string; code?: string }
export interface GitScanResult { roots: string[]; issues: GitScanIssue[] }

export function gitScanIssue(target: string, error: unknown): GitScanIssue {
  const e = error as { message?: unknown; code?: unknown } | null;
  return { path: target, message: typeof e?.message === 'string' ? e.message : String(error),
    ...(typeof e?.code === 'string' ? { code: e.code } : {}) };
}

/**
 * 在 workspace 下查找 git 仓库根（含嵌套独立仓，如 Plugins/*）。
 * 识别 `.git` 目录或 gitfile。
 *
 * 相比串行 await readdir，按层并发可显著降低 metaapp 这类多仓深目录工作区的扫描时延；
 * 同时保留「命中 .git 仍下钻」的行为，以发现 Plugins/ 子仓这类嵌套独立仓。
 */
export async function findGitRoots(
  workspace: string,
  maxDepth = 5
): Promise<string[]> {
  return (await findGitRootsDetailed(workspace, maxDepth)).roots;
}

/** Keeps inaccessible directories distinct from a successful empty scan. */
export async function findGitRootsDetailed(workspace: string, maxDepth = 5): Promise<GitScanResult> {
  const root = path.resolve(workspace);
  const issues: GitScanIssue[] = [];
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return { roots: [], issues: [gitScanIssue(root, { code: 'ENOTDIR', message: 'Not a directory' })] };
  } catch (error) {
    return { roots: [], issues: [gitScanIssue(root, error)] };
  }

  const found: string[] = [];
  await walkLayer([root], 0, maxDepth, found, issues);
  found.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { roots: found, issues };
}

/** 按层并发：nodes 为同一深度的目录列表，统一向下扩展 */
async function walkLayer(
  dirs: string[],
  depth: number,
  maxDepth: number,
  found: string[],
  issues: GitScanIssue[]
): Promise<void> {
  if (dirs.length === 0) return;

  // 同层目录并发 readdir，但限制最大并发，避免一次发出几千个 fs 调用拖垮 IO
  const results = await mapWithConcurrency(
    dirs,
    READDIR_CONCURRENCY,
    async (dir) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        issues.push(gitScanIssue(dir, error));
        return { dir, entries: [] as import('node:fs').Dirent[] };
      }
      return { dir, entries };
    }
  );

  const nextDirs: string[] = [];
  for (const { dir, entries } of results) {
    let hasGit = false;
    for (const e of entries) {
      if (e.name === '.git') {
        hasGit = true;
        break;
      }
    }
    if (hasGit) found.push(path.normalize(dir));

    // 命中 skip 名单的子目录不再下钻（这些目录里不可能有 .git）
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      nextDirs.push(path.join(dir, ent.name));
    }
  }

  if (depth + 1 <= maxDepth) {
    await walkLayer(nextDirs, depth + 1, maxDepth, found, issues);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) break;
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}

export function isPathInsideWorkspace(target: string, workspace: string): boolean {
  const t = path.resolve(target);
  const w = path.resolve(workspace);
  if (process.platform === 'win32') {
    const tl = t.toLowerCase();
    const wl = w.toLowerCase();
    const sep = path.sep.toLowerCase();
    return tl === wl || tl.startsWith(wl.endsWith(sep) ? wl : wl + sep);
  }
  return t === w || t.startsWith(w.endsWith(path.sep) ? w : w + path.sep);
}
