import type { WorkspaceWorktreeGroupSelection } from './types';

export type SessionIsolation = 'shared' | 'isolated';

export const isolationProperty = {
  type: 'string', enum: ['shared', 'isolated'],
  description: 'Explicit choice, no default: shared=existing checkout; isolated=new task tree without uncommitted changes. Read-only review may share; independent/parallel edits should isolate even if clean.'
};

/** Validate model choices before any queue, resource or durable reservation is created. */
export function requireSessionIsolation(input: {
  isolation?: unknown; isolationGroups?: unknown; shellProfileId?: unknown;
}, options: { allowDefaultGroup?: boolean } = {}): SessionIsolation {
  if (input.isolation !== 'shared' && input.isolation !== 'isolated') {
    throw new Error('isolation must be explicitly shared or isolated; auto and defaults have been removed.');
  }
  if (input.isolation === 'shared') {
    if (input.isolationGroups !== undefined) throw new Error('shared does not accept isolationGroups; choose isolated or remove the isolation repo groups.');
    return 'shared';
  }
  if (input.shellProfileId) throw new Error('Shell does not support isolated; choose shared.');
  if (input.isolationGroups === undefined && options.allowDefaultGroup) return 'isolated';
  if (!Array.isArray(input.isolationGroups) || !input.isolationGroups.length) {
    throw new Error('isolated requires an explicit non-empty isolationGroups selecting the repos to isolate.');
  }
  requireExplicitRepoSets(input.isolationGroups);
  return 'isolated';
}

export function requireExplicitRepoSets(groups: WorkspaceWorktreeGroupSelection[]): void {
  if (!Array.isArray(groups) || !groups.length) throw new Error('isolationGroups must be a non-empty array of repo groups.');
  for (const group of groups) {
    if (!group || typeof group.rootId !== 'string' || !group.rootId.trim() || typeof group.relativePath !== 'string' ||
        !Array.isArray(group.repoSet) || group.repoSet.some(item => typeof item !== 'string')) {
      throw new Error('Each isolationGroups item must explicitly provide rootId, relativePath, and repoSet ([] means the selected root repo only).');
    }
  }
}
