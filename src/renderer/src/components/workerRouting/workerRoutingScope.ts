import type { SessionMeta, WorkspaceInfo } from '../../../../shared/types';
import type { WorkerRoutingScope } from '../../../../shared/workerRouting';
import { defaultRootFor, sourceRootsFor } from '../../../../shared/workspaceRoots';

export function workerRoutingScope(
  workspace: WorkspaceInfo | undefined,
  source?: { rootId: string; path?: string; cwd?: string }
): WorkerRoutingScope | undefined {
  if (!workspace) return undefined;
  try {
    const root = source
      ? sourceRootsFor(workspace).find(item => item.id === source.rootId && (!source.path || item.path === source.path))
      : defaultRootFor(workspace);
    if (root) return { workspaceId: workspace.id, rootId: root.id, rootsRevision: workspace.rootsRevision ?? 0,
      ...(source?.cwd ? { cwd: source.cwd } : {}) };
  } catch { /* A workspace without a registered source cannot create references. */ }
  return undefined;
}

export function workerRoutingScopeKey(scope?: WorkerRoutingScope): string {
  return scope ? JSON.stringify([scope.workspaceId, scope.rootId, scope.rootsRevision, scope.cwd ?? '']) : '';
}

export function workerRoutingScopeForSession(workspace: WorkspaceInfo | undefined, session: Pick<SessionMeta, 'sourceRoot' | 'cwd'> | undefined): WorkerRoutingScope | undefined {
  if (!workspace || !session) return undefined;
  if (session.sourceRoot) return workerRoutingScope(workspace, session.sourceRoot);
  try {
    const roots = sourceRootsFor(workspace);
    if (roots.length === 1) return workerRoutingScope(workspace, { rootId: roots[0].id, cwd: session.cwd });
  } catch { /* A legacy session without a single unambiguous source cannot mint a reference. */ }
  return undefined;
}
