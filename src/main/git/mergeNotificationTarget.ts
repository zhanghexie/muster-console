import path from 'node:path';
import type { AppConfig, SessionMeta } from '../../shared/types';
import { sourceRootsFor } from '../../shared/workspaceRoots';
import { sourcePathKey } from '../workspacePaths';

/** Never attribute another source folder's merge failure to the active workspace. */
export function mergeNotificationTarget(
  config: Pick<AppConfig, 'workspaces'>,
  listSessions: (workspaceId: string) => SessionMeta[],
  mainRepo: string,
  branch: string
): { workspaceId: string; session?: SessionMeta } | undefined {
  const repoKey = sourcePathKey(mainRepo);
  const candidates = config.workspaces.filter(workspace => !workspace.rootsError).map(workspace => {
    const roots = sourceRootsFor(workspace).map(root => root.path);
    const containsSource = (repo: string): boolean => roots.some(root => {
      const key = sourcePathKey(root);
      const candidate = sourcePathKey(repo);
      return candidate === key || candidate.startsWith(key + '/');
    });
    const session = listSessions(workspace.id).find(session => {
    if (session.worktreeGroups) {
      return session.worktreeGroups.groups.some(group => {
        if (!group.source || !containsSource(group.source.mainRepo)) return false;
        return (group.branch === branch && [group.source.mainRepo, group.path].some(repo => sourcePathKey(repo) === repoKey)) ||
          group.repos.some(repo => repo.branch === branch && [path.join(group.source!.mainRepo, repo.path), path.join(group.path, repo.path)]
            .some(repo => sourcePathKey(repo) === repoKey));
      });
    }
    return session.worktreeBranch === branch && (session.worktreeSource
      ? containsSource(session.worktreeSource.mainRepo) && [session.worktreeSource.mainRepo, session.worktreePath]
        .some(repo => repo !== undefined && sourcePathKey(repo) === repoKey)
      : containsSource(mainRepo));
    });
    return { workspaceId: workspace.id, session, applicable: !!session || containsSource(mainRepo) };
  }).filter(candidate => candidate.applicable).map(({ workspaceId, session }) => ({ workspaceId, session }));
  const owners = candidates.filter(candidate => candidate.session);
  return owners.length === 1 ? owners[0] : candidates.length === 1 ? candidates[0] : undefined;
}
