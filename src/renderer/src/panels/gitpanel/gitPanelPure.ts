/**
 * GitPanel 拆分纯函数层（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * 原面板文件内的常量、类型与纯函数原样迁出，供 hooks / 组件 / 离线单测共用。
 * 本文件保持零 React 依赖（类型 import 仅 type-only），test/gitpanel-split-pure.mjs 可直接转译导入。
 */
import type { GitFileChange, GitRepoSummary } from '../../../../shared/types';
import { isInsideWorkspace } from '../../../../shared/gitRepoTree';
import { tryRelativizeToRoot } from '../../../../shared/workspaceRelPath';

export type DetailTab = 'work' | 'history' | 'pr';
export type RepoSort = 'name' | 'recent' | 'dirty';

export const FS_STATUS_DEBOUNCE_MS = 250;
export const FS_LIST_DEBOUNCE_MS = 800;
/** 方向键移仓后延迟刷新右侧，避免每步都跑 git status + 详情重绘 */
export const DETAIL_SELECT_DEBOUNCE_MS = 180;
/** selectedRepo 持久化（workspaceFile:patch 同步写盘）防抖：点击路径上只 setState */
export const PATCH_REPO_DEBOUNCE_MS = 500;
/** fs 触发的 refreshStatus 最小间隔：主进程已有 status TTL 缓存，这里挡 IPC+重渲往返 */
export const FS_STATUS_MIN_INTERVAL_MS = 1500;
/** 空路径信号（watcher filename 为空）触发的列表刷新冷却 */
export const FS_EMPTY_LIST_COOLDOWN_MS = 10_000;

export function changeTouchesRepo(rels: string[], repoAbs: string, workspaceAbs: string): boolean {
  const repoRel = tryRelativizeToRoot(workspaceAbs, repoAbs);
  if (repoRel == null) return false;
  const base = repoRel.replace(/\\/g, '/');
  return rels.some((rel) => {
    // 空信号（watcher filename 为空）无法定位到具体路径，不命中，
    // 否则根仓库等效于任意文件变化都刷 status
    if (!rel) return false;
    const r = rel.replace(/\\/g, '/');
    if (!base) return true;
    return r === base || r.startsWith(`${base}/`);
  });
}

export function joinRepoRel(repoPath: string, rel: string): string {
  const base = repoPath.replace(/[/\\]+$/, '');
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  const sep = repoPath.includes('\\') ? '\\' : '/';
  return [base, ...parts].join(sep);
}

export function findContainingRepo(
  abs: string,
  repos: GitRepoSummary[],
  pathKey: (p: string) => string
): GitRepoSummary | null {
  let best: GitRepoSummary | null = null;
  let bestLen = -1;
  for (const r of repos) {
    if (!isInsideWorkspace(abs, r.path, pathKey)) continue;
    const len = pathKey(r.path).length;
    if (len > bestLen) {
      best = r;
      bestLen = len;
    }
  }
  return best;
}

export function parseRepoSort(v: string | undefined): RepoSort {
  if (v === 'recent' || v === 'dirty' || v === 'name') return v;
  return 'name';
}

export function repoSummaryEquals(a: GitRepoSummary, b: GitRepoSummary): boolean {
  return (
    a.path === b.path &&
    a.name === b.name &&
    a.workspaceId === b.workspaceId &&
    a.rootId === b.rootId &&
    a.dirty === b.dirty &&
    a.branch === b.branch &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.worktree === b.worktree &&
    a.lastModifiedMs === b.lastModifiedMs
  );
}

/**
 * listRepos 返回项与现有 repos 按 path 对齐，内容没变则复用现有元素（照抄 refreshStatus 的模式）：
 * IPC 序列化每次都是新对象，若直接 setRepos(list)，树构建/摘要徽标等下游 useMemo 会全量失效。
 * 逐项引用都保住且长度一致时连数组本身也不换。
 */
export function mergeRepoList(
  prev: GitRepoSummary[],
  next: GitRepoSummary[],
  pathKeyOf: (p: string) => string
): GitRepoSummary[] {
  if (prev.length === 0) return next;
  const byKey = new Map(prev.map((r) => [pathKeyOf(r.path), r]));
  let changed = false;
  const merged = next.map((r) => {
    const old = byKey.get(pathKeyOf(r.path));
    if (old && repoSummaryEquals(old, r)) return old;
    changed = true;
    return r;
  });
  if (!changed && prev.length === merged.length && prev.every((r, i) => r === merged[i])) {
    return prev;
  }
  return merged;
}

export function sortLabel(sort: RepoSort, t: (key: string) => string): string {
  if (sort === 'recent') return t('最近修改');
  if (sort === 'dirty') return t('未提交变动');
  return t('名称');
}

export function isStaged(f: GitFileChange): boolean {
  return f.index !== ' ' && f.index !== '?';
}

export function isUnstaged(f: GitFileChange): boolean {
  return f.working_dir !== ' ' || f.index === '?';
}

export function unstagedBadge(f: GitFileChange): string {
  if (f.index === '?' || f.working_dir === '?') return '?';
  return f.working_dir !== ' ' ? f.working_dir : 'M';
}

export function stagedBadge(f: GitFileChange): string {
  return f.index !== ' ' && f.index !== '?' ? f.index : 'M';
}
