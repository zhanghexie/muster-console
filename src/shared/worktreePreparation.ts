import type { WorkspaceInfo, WorkspaceWorktreeGroupSelection } from './types';
import { pathKey } from './pathKey';

export interface WorktreeRepoPreparation { rootId: string; relativePath: string; commands: string[] }
export interface WorktreeRepoExclusion { rootId: string; relativePath: string }
export interface WorktreePreparationSnapshot {
  workspace: WorkspaceInfo; workspaceId: string; rootsRevision: number; controlKey: string;
  sourceKeys: Array<{ rootId: string; physicalPath: string }>; configVersion: string;
  commands: string[]; recipes: WorktreeRepoPreparation[];
  /** Omitted by older callers: preserve saved exclusions. */
  exclusions?: WorktreeRepoExclusion[];
}
export type WorktreePreparationUpdate = Pick<WorktreePreparationSnapshot,
  'workspaceId' | 'rootsRevision' | 'controlKey' | 'sourceKeys' | 'configVersion' | 'commands' | 'recipes' | 'exclusions'>;
export function repositoryExclusions(value: unknown): WorktreeRepoExclusion[] {
  if (!Array.isArray(value)) throw new Error('invalid isolation exclusions');
  return repositoryPreparations(value.map(record => ({ ...record, commands: [] })))
    .map(({ rootId, relativePath }) => ({ rootId, relativePath }));
}
export function preparationCommands(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(command => typeof command !== 'string' || !command.trim() || command.includes('\0'))) throw new Error('invalid worktree preparation commands');
  return [...value];
}
export function repositoryPreparations(value: unknown): WorktreeRepoPreparation[] {
  if (!Array.isArray(value)) throw new Error('invalid repository preparation recipes');
  const keys = new Set<string>();
  return value.map(record => {
    if (!record || typeof record.rootId !== 'string' || !record.rootId.trim() || typeof record.relativePath !== 'string') throw new Error('invalid preparation source');
    const relativePath = record.relativePath.replace(/\\/g, '/');
    if (relativePath.includes('\0') || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)
      || (relativePath && relativePath.split('/').some((part: string) => !part || part === '.' || part === '..'))) throw new Error('invalid preparation repository path');
    const key = JSON.stringify([record.rootId, pathKey(relativePath)]);
    if (keys.has(key)) throw new Error('duplicate repository preparation recipe');
    keys.add(key);
    return { rootId: record.rootId, relativePath, commands: preparationCommands(record.commands) };
  });
}

/** Only repositories actually selected for isolation receive repository-specific commands. */
export function preparationsForSelections(recipes: WorktreeRepoPreparation[], selections: WorkspaceWorktreeGroupSelection[], exclusions: WorktreeRepoExclusion[] = []): WorktreeRepoPreparation[] {
  return recipes.filter(recipe => recipe.commands.length && selections.some(selection => {
    if (selection.rootId !== recipe.rootId) return false;
    const base = pathKey(selection.relativePath), target = pathKey(recipe.relativePath);
    if (base === target) return true;
    if (base && !target.startsWith(`${base}/`)) return false;
    const nested = base ? target.slice(base.length + 1) : target;
    if (selection.repoSet === undefined) return !exclusions.some(exclusion => exclusion.rootId === recipe.rootId
      && (target === pathKey(exclusion.relativePath) || target.startsWith(`${pathKey(exclusion.relativePath)}/`)));
    return selection.repoSet.some(member => pathKey(member) === nested || pathKey(member).startsWith(`${nested}/`));
  })).map(recipe => ({ ...recipe, commands: [...recipe.commands] }));
}
