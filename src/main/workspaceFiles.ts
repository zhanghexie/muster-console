import fs from 'node:fs/promises';
import path from 'node:path';
import { SKIP_DIR_NAMES } from './workspaceSkipDirs';

const MAX_FILES = 2000;
const MAX_RESULTS = 40;

export interface WorkspaceFileEntry {
  /** 工作区相对路径，POSIX 分隔 */
  path: string;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function scoreMatch(rel: string, query: string): number {
  const q = query.toLowerCase();
  const p = rel.toLowerCase();
  if (!q) return 0;
  if (p === q) return 1000;
  const base = path.posix.basename(p);
  if (base.startsWith(q)) return 800 - base.length;
  if (base.includes(q)) return 600 - base.length;
  if (p.includes(q)) return 400 - p.length;
  // 简单子序列：query 字符按序出现在 path 中
  let i = 0;
  for (const ch of p) {
    if (ch === q[i]) i++;
    if (i >= q.length) return 200 - p.length;
  }
  return -1;
}

/**
 * 枚举工作区文件（有上限），按 query 模糊过滤。
 */
export async function listWorkspaceFiles(
  root: string,
  query = ''
): Promise<WorkspaceFileEntry[]> {
  const absRoot = path.resolve(root);
  const all: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (all.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (all.length >= MAX_FILES) return;
      const name = String(ent.name);
      if (name === '.' || name === '..') continue;
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        await walk(path.join(dir, name));
        continue;
      }
      if (!ent.isFile()) continue;
      const abs = path.join(dir, name);
      const rel = toPosix(path.relative(absRoot, abs));
      if (!rel || rel.startsWith('..')) continue;
      all.push(rel);
    }
  }

  await walk(absRoot);

  const q = query.trim();
  if (!q) {
    return all.slice(0, MAX_RESULTS).map((p) => ({ path: p }));
  }

  const scored: { path: string; score: number }[] = [];
  for (const p of all) {
    const score = scoreMatch(p, q);
    if (score < 0) continue;
    scored.push({ path: p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, MAX_RESULTS).map(({ path: p }) => ({ path: p }));
}
