import type { AppConfig, PromptTask, SessionMeta } from '../../shared/types';
import { defaultRootFor } from '../../shared/workspaceRoots';
import { pathKey } from '../pathKey';
import { requireSourceRoot, requireWorkspace, sourcePathKey } from '../workspacePaths';

type Config = Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>;
type Source = NonNullable<SessionMeta['sourceRoot']>;

/** Registry operations stay synchronous. Launch validates the directory again after awaits. */
export function capturePromptTaskSource(config: Config, input: {
  workspaceId: string; rootId?: string; rootsRevision?: number;
}, legacy = false): Source {
  const workspace = requireWorkspace(config, input.workspaceId);
  if (input.rootsRevision !== undefined && input.rootsRevision !== (workspace.rootsRevision ?? 0)) {
    throw new Error('workspace source folders changed; retry');
  }
  // Old services have no cwd evidence. Only a single registered root is unambiguous.
  const root = input.rootId !== undefined || legacy
    ? requireSourceRoot(workspace, input.rootId) : defaultRootFor(workspace);
  return { rootId: root.id, path: root.path, cwd: root.path, physicalPath: sourcePathKey(root.path) };
}

export function assertPromptTaskSource(config: Config, task: Pick<PromptTask, 'workspaceId' | 'sourceRoot'>): Source {
  const source = task.sourceRoot;
  if (!source) throw new Error('scheduled task source folder selection required');
  const root = requireSourceRoot(requireWorkspace(config, task.workspaceId), source.rootId);
  if (pathKey(source.path) !== pathKey(root.path) || pathKey(source.cwd) !== pathKey(root.path)
    || (source.physicalPath !== undefined && source.physicalPath !== sourcePathKey(root.path))) {
    throw new Error('scheduled task source folder changed or was removed');
  }
  return source;
}
