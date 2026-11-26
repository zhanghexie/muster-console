import fs from 'node:fs';
import type { AppConfig, SessionMeta, WorkspaceWorktreeGroupSelection } from '../../shared/types';
import { requireSourceRoot, requireWorkspace, sourcePathKey } from '../workspacePaths';
import { normalizeWorktreeGroupSelections } from './worktreeTaskCreate';

export type WorktreeSelectionSource = NonNullable<SessionMeta['sourceRoot']>;

/** Capture every selected source before async validation or queue admission. */
export function captureWorktreeSelectionSources(config: AppConfig, input: {
  workspaceId?: string; rootsRevision?: number; isolationGroups: WorkspaceWorktreeGroupSelection[];
  capturedIsolationSources?: WorktreeSelectionSource[];
}): { selections: WorkspaceWorktreeGroupSelection[]; sources: WorktreeSelectionSource[] } {
  const selections = normalizeWorktreeGroupSelections(input.isolationGroups);
  const workspace = requireWorkspace(config, input.workspaceId);
  if (input.rootsRevision !== undefined && input.rootsRevision !== (workspace.rootsRevision ?? 0)) throw new Error('workspace source folders changed; retry');
  const sources = [...new Set(selections.map(selection => selection.rootId))].map(rootId => {
    const root = requireSourceRoot(workspace, rootId);
    if (!fs.statSync(root.path).isDirectory()) throw new Error('task source folder is not a directory');
    return { rootId, path: root.path, cwd: root.path, physicalPath: sourcePathKey(fs.realpathSync(root.path)) };
  });
  if (input.capturedIsolationSources !== undefined) {
    if (input.capturedIsolationSources.length !== sources.length || sources.some(source => {
      const saved = input.capturedIsolationSources!.find(item => item.rootId === source.rootId);
      return !saved || saved.physicalPath !== source.physicalPath || sourcePathKey(saved.path) !== source.physicalPath;
    })) throw new Error('task isolation source folder changed or was removed');
  }
  return { selections, sources };
}

export function assertWorktreeSelectionSources(config: AppConfig, workspaceId: string, selections: WorkspaceWorktreeGroupSelection[], sources: WorktreeSelectionSource[]): void {
  captureWorktreeSelectionSources(config, { workspaceId, isolationGroups: selections, capturedIsolationSources: sources });
}
