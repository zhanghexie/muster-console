import type { GitRepoLocation, WorkspaceInfo, WorkspaceWorktreeGroupSelection } from './types';
import { sourceRootsFor } from './workspaceRoots';
import { pathKey } from './pathKey';

export interface WorkspaceRepositoryChoice extends WorkspaceWorktreeGroupSelection {
  key: string; path: string; name: string; sourceLabel: string;
}

export function workspaceRepositoryChoices(workspace: WorkspaceInfo, repos: readonly GitRepoLocation[]): WorkspaceRepositoryChoice[] {
  const roots = sourceRootsFor(workspace);
  return repos.flatMap(repo => {
    if (repo.worktree || !repo.rootId) return [];
    const root = roots.find(root => root.id === repo.rootId);
    if (!root || !(pathKey(repo.path) === pathKey(root.path) || pathKey(repo.path).startsWith(`${pathKey(root.path)}/`))) return [];
    const relativePath = repo.path.split(/[\\/]+/).filter(Boolean).slice(root.path.split(/[\\/]+/).filter(Boolean).length).join('/');
    return [{ key: JSON.stringify([root.id, relativePath]), rootId: root.id, relativePath, path: repo.path,
      name: relativePath || repo.name, sourceLabel: root.label || root.path.split(/[\\/]+/).filter(Boolean).pop() || root.path }];
  });
}

export function choiceIncluded(choice: WorkspaceRepositoryChoice, selections: readonly WorkspaceWorktreeGroupSelection[]): boolean {
  return selections.some(selection => selection.rootId === choice.rootId && (pathKey(choice.relativePath) === pathKey(selection.relativePath)
    || (!selection.relativePath || pathKey(choice.relativePath).startsWith(`${pathKey(selection.relativePath)}/`))));
}
