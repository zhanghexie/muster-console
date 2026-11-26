import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultProductWorktreesRoot } from '../runtimeKernel/storageRootResolver';
import { pathKey } from '../pathKey';
import { isPathInsideWorkspace } from './scan';

/** 配置里的工作区（只取 id + 根路径） */
export type WorkspacePathRef = { id: string; path: string };

/** 无配置时的默认隔离 worktree 根，由 StorageRootResolver 统一派生。 */
export function defaultWorktreeStorageRoot(): string {
  return defaultProductWorktreesRoot();
}

function storageKey(value: string, pathIdentity = true): string {
  const label = path.basename(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'workspace';
  return label + '-' + createHash('sha256').update(pathIdentity ? pathKey(value) : value).digest('hex').slice(0, 16);
}

export function worktreesRootForWorkspace(workspacePath: string, storageRoot = defaultWorktreeStorageRoot()): string {
  return path.join(storageRoot, storageKey(path.resolve(workspacePath)));
}

/**
 * 最长前缀命中：路径落在多个工作区时取更具体的那个。
 * 与 UI 活动工作区无关。
 */
export function findContainingWorkspace(
  target: string,
  workspaces: readonly WorkspacePathRef[]
): WorkspacePathRef | undefined {
  const resolved = path.resolve(target);
  let best: WorkspacePathRef | undefined;
  let bestLen = -1;
  for (const w of workspaces) {
    const root = typeof w.path === 'string' ? w.path.trim() : '';
    if (!root) continue;
    if (!isPathInsideWorkspace(resolved, root)) continue;
    const len = path.resolve(root).length;
    if (len > bestLen) {
      best = { id: w.id, path: root };
      bestLen = len;
    }
  }
  return best;
}

/**
 * 应用管理根内按工作区和仓库身份隔离；extra 仓以自身路径作为分组身份。
 */
export function resolveWorktreesRoot(
  repoPath: string,
  workspaces: readonly WorkspacePathRef[],
  storageRoot = defaultWorktreeStorageRoot()
): string {
  if (!path.isAbsolute(storageRoot)) throw new Error('Worktree storage must be an absolute path');
  const repo = path.resolve(repoPath);
  if (isPathInsideWorkspace(storageRoot, repo)) throw new Error('Worktree storage must be outside the source repository');
  const ws = findContainingWorkspace(repo, workspaces);
  return path.join(worktreesRootForWorkspace(ws?.path || repo, storageRoot), storageKey(repo));
}

/** New multi-group tasks use a logical workspace and canonical repository identity. */
export function resolveTaskWorktreesRoot(workspaceId: string, commonDir: string, repoPath: string, storageRoot = defaultWorktreeStorageRoot()): string {
  if (!workspaceId.trim() || !path.isAbsolute(storageRoot)) throw new Error('Invalid task worktree storage scope');
  if (isPathInsideWorkspace(storageRoot, repoPath)) throw new Error('Worktree storage must be outside the source repository');
  return path.join(storageRoot, storageKey(`workspace-${workspaceId}`, false), storageKey(commonDir));
}

/** New destinations only. Persisted paths remain authoritative for existing trees. */
export function compactWorktreePath(workspaceId: string, taskId: string, commonDir: string, repoPath: string,
  storageRoot = defaultWorktreeStorageRoot(), platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!workspaceId.trim() || !taskId.trim() || !paths.isAbsolute(storageRoot)
    || !paths.isAbsolute(repoPath) || !paths.isAbsolute(commonDir)) throw new Error('Invalid task worktree storage scope');
  const relative = paths.relative(repoPath, storageRoot);
  if (!relative || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`))) {
    throw new Error('Worktree storage must be outside the source repository');
  }
  const digest = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const repoKey = paths.normalize(commonDir);
  // Hash full logical identities, not their shared UUID prefixes. Prefixing the
  // components also avoids Windows device names on every supported platform.
  const task = 't-' + digest([workspaceId, taskId]).slice(0, 12);
  const label = paths.basename(repoPath).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'repo';
  const repo = label + '-' + digest([platform === 'win32' ? repoKey.toLowerCase() : repoKey]).slice(0, 10);
  return paths.join(storageRoot, task, repo);
}

/**
 * 隔离上探天花板：会话所属工作区根；未绑定时才回落活动工作区（兼容旧调用）。
 */
export function isolateWalkCeiling(
  sessionWorkspacePath: string | undefined,
  activeWorkspacePath: string
): string {
  const target = sessionWorkspacePath?.trim();
  return target || activeWorkspacePath;
}

/** 隔离派活 cwd 是否落在目标会话工作区（不看 UI 活动区） */
export function isolateCwdInTargetWorkspace(cwd: string, targetWorkspacePath: string): boolean {
  const target = targetWorkspacePath.trim();
  if (!target) return false;
  return isPathInsideWorkspace(path.resolve(cwd), target);
}

export type RepoAllowKind = 'workspace' | 'index' | 'linked' | 'none';

export function classifyRepoAllow(opts: {
  repoPath: string;
  workspaces: readonly WorkspacePathRef[];
  allowedKeys: Iterable<string>;
  pathKey: (p: string) => string;
}): RepoAllowKind {
  const resolved = path.resolve(opts.repoPath);
  if (findContainingWorkspace(resolved, opts.workspaces)) return 'workspace';
  const k = opts.pathKey(resolved);
  for (const a of opts.allowedKeys) {
    if (a === k) return 'index';
  }
  return 'none';
}

/** 路径出现在 `git worktree list` 结果里则视为可自动登记的 linked worktree */
export function isListedWorktree(
  resolved: string,
  listedPaths: readonly string[],
  pathKey: (p: string) => string
): boolean {
  const k = pathKey(resolved);
  return listedPaths.some((p) => pathKey(p) === k);
}

export type UnknownRepoReason = 'missing' | 'unindexed';

export function unknownRepoI18n(opts: {
  reason: UnknownRepoReason;
  resolved: string;
  activeWorkspace: string;
  targetWorkspace: string;
}): { key: string; params: { resolved: string; active: string; target: string } } {
  const params = {
    resolved: opts.resolved,
    active: opts.activeWorkspace,
    target: opts.targetWorkspace
  };
  if (opts.reason === 'missing') {
    return {
      key: '不是 git 仓库: {{resolved}}（当前活动工作区 {{active}}、目标 {{target}}）',
      params
    };
  }
  return {
    key: '未知仓库（未登记或索引未刷新）: {{resolved}}（当前活动工作区 {{active}}、目标 {{target}}）。可调用 git.refreshRepos() 刷新。',
    params
  };
}
