import { createHash } from 'node:crypto';
import type { AppConfig } from '../../shared/types';
import { preparationCommands, repositoryPreparations, repositoryExclusions, type WorktreePreparationSnapshot, type WorktreePreparationUpdate } from '../../shared/worktreePreparation';
import { controlRootFor, requireSourceRoot, requireWorkspace, sourcePathKey, sourceRootsFor } from '../workspacePaths';
import { patchWorkspaceFile, readWorkspaceFile } from '../metaAgent/workspaceFile';

export function readWorktreePreparation(config: AppConfig, workspaceId: string): WorktreePreparationSnapshot {
  const workspace = requireWorkspace(config, workspaceId);
  const git = readWorkspaceFile(controlRootFor(workspace)).git;
  const commands = preparationCommands(git?.worktreeProvisionCommands ?? []);
  const recipes = repositoryPreparations(git?.worktreeRepoProvisionCommands ?? []);
  const exclusions = repositoryExclusions(git?.worktreeIsolationExclusions ?? []);
  return { workspace: structuredClone(workspace), workspaceId: workspace.id, rootsRevision: workspace.rootsRevision ?? 0,
    controlKey: sourcePathKey(controlRootFor(workspace)), sourceKeys: sourceRootsFor(workspace).map(root => ({ rootId: root.id, physicalPath: sourcePathKey(root.path) })),
    configVersion: createHash('sha256').update(JSON.stringify([commands, recipes, exclusions])).digest('hex'), commands, recipes, exclusions };
}

/** Synchronous compare-and-write: stale windows never overwrite a new root or recipe. */
export function saveWorktreePreparation(config: AppConfig, input: WorktreePreparationUpdate): WorktreePreparationSnapshot {
  const current = readWorktreePreparation(config, input.workspaceId);
  if (input.rootsRevision !== current.rootsRevision || input.controlKey !== current.controlKey
    || JSON.stringify(input.sourceKeys) !== JSON.stringify(current.sourceKeys) || input.configVersion !== current.configVersion) throw new Error('worktree preparation scope changed; reload settings');
  const commands = preparationCommands(input.commands), recipes = repositoryPreparations(input.recipes);
  const exclusions = repositoryExclusions(input.exclusions ?? current.exclusions ?? []);
  for (const recipe of recipes) requireSourceRoot(current.workspace, recipe.rootId);
  for (const exclusion of exclusions) requireSourceRoot(current.workspace, exclusion.rootId);
  patchWorkspaceFile(controlRootFor(current.workspace), { git: { worktreeProvisionCommands: commands, worktreeRepoProvisionCommands: recipes, worktreeIsolationExclusions: exclusions } });
  return readWorktreePreparation(config, input.workspaceId);
}
