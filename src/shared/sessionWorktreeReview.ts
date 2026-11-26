import type { SessionMeta } from './types';
import { sessionWorktreeGroups, validateSessionWorktreeGroups } from './sessionWorktrees';
import { pathKey } from './pathKey';

export type WorktreeReviewSession = Pick<SessionMeta, 'id'> & Partial<Pick<SessionMeta,
  'worktreeGroups' | 'worktreePath' | 'worktreeRepoSet' | 'worktreeSource' | 'worktreeBranch' | 'worktreeBaseBranch' | 'sourceRoot' | 'cwd'>>;

export interface WorktreeReviewRepo {
  groupId: string;
  relativePath: string;
  rootId?: string;
  repoPath: string;
  sourcePath?: string;
  branch?: string;
}

/** Saved task membership for navigation, never evidence of live Git authorization. */
export function sessionWorktreeReviewRepos(session?: WorktreeReviewSession): WorktreeReviewRepo[] {
  if (!session) return [];
  const groups = sessionWorktreeGroups(session);
  if (!groups) return [];
  validateSessionWorktreeGroups(groups);
  return groups.groups.flatMap(group => [{ path: '', branch: group.branch }, ...group.repos]
    .filter(repo => !group.cleanup?.find(result => result.repo === repo.path)?.treeRemoved)
    .map(repo => ({ groupId: group.id, relativePath: repo.path, rootId: group.sourceRoot?.rootId,
      repoPath: repo.path ? `${group.path.replace(/[\\/]+$/, '')}/${repo.path}` : group.path,
      sourcePath: group.source ? (repo.path ? `${group.source.mainRepo.replace(/[\\/]+$/, '')}/${repo.path}` : group.source.mainRepo) : undefined,
      branch: repo.branch })));
}

/** The session's actual cwd determines its shortcut, including nested repositories. */
export function sessionWorktreeReviewTarget(session?: WorktreeReviewSession): WorktreeReviewRepo | undefined {
  if (!session) return undefined;
  const repos = sessionWorktreeReviewRepos(session);
  const cwd = pathKey(session.cwd ?? '');
  return repos.filter(repo => cwd === pathKey(repo.repoPath) || cwd.startsWith(`${pathKey(repo.repoPath)}/`))
    .sort((a, b) => b.repoPath.length - a.repoPath.length)[0]
    ?? repos.find(repo => repo.groupId === sessionWorktreeGroups(session)?.primaryGroupId) ?? repos[0];
}
