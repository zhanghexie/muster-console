import type { AppContext } from './context';
import type { SessionMeta, WorkspaceInfo, WorkspaceRootDependency } from '../shared/types';
import { sourceRootsFor } from '../shared/workspaceRoots';
import { sourcePathKey } from './workspacePaths';
import { isPathInsideWorkspace } from './git/scan';
import { listDelegateSourceUses } from './tasks/delegateQueue';
import { workspaceRootUsesFor } from './workspaceRootUses';
import { sessionWorktreeGroups } from '../shared/sessionWorktrees';

/** Explicit identities remain authoritative; legacy ambiguity blocks all matching roots. */
function rootIdsFor(workspace: WorkspaceInfo, row: Pick<SessionMeta, 'workspaceId' | 'sourceRoot' | 'cwd' | 'worktreeSource'>): string[] {
  if (row.workspaceId !== undefined && row.workspaceId !== workspace.id) return [];
  if (row.sourceRoot) return [row.sourceRoot.rootId];
  const cwd = row.worktreeSource?.mainRepo ?? row.cwd;
  const roots = sourceRootsFor(workspace);
  if (!cwd) return row.workspaceId === workspace.id ? roots.map(root => root.id) : [];
  const key = sourcePathKey(cwd);
  const matches = roots.filter(root => isPathInsideWorkspace(key, sourcePathKey(root.path)));
  if (!matches.length && row.workspaceId === workspace.id) return roots.map(root => root.id);
  return matches.map(root => root.id);
}

export function workspaceRootDependencies(ctx: AppContext, workspace: WorkspaceInfo): WorkspaceRootDependency[] {
  const result = workspaceRootUsesFor(ctx.config).list(workspace.id);
  const append = (row: Pick<SessionMeta, 'workspaceId' | 'sourceRoot' | 'cwd' | 'worktreeSource'>, use: Omit<WorkspaceRootDependency, 'rootId'>): void => {
    for (const rootId of rootIdsFor(workspace, row)) result.push({ ...use, rootId });
  };
  for (const session of ctx.sessions.rootDependencyRoster()) {
    if (session.type !== 'terminal') continue;
    if (session.status === 'starting' || session.status === 'running') {
      append(session, { kind: 'session', id: session.id, label: session.name, sessionId: session.id });
    }
    // Archived rows can still own a tree while release/cleanup is pending or has failed.
    try {
      const state = sessionWorktreeGroups(session);
      for (const group of state?.groups ?? []) append({
        workspaceId: session.workspaceId, sourceRoot: group.sourceRoot,
        cwd: group.source?.mainRepo ?? group.path, worktreeSource: group.source
      }, { kind: 'worktree', id: `${session.id}:${group.id}`, label: group.path, sessionId: session.id });
      if (state) for (const source of [session.sourceRoot, ...(state.sourceRoots ?? [])]) {
        if (!source || state.groups.some(group => group.sourceRoot?.rootId === source.rootId)) continue;
        append({ workspaceId: session.workspaceId, sourceRoot: source }, {
          kind: 'worktree', id: `${session.id}:source:${source.rootId}`, label: session.worktreePath ?? session.name, sessionId: session.id
        });
      }
    } catch {
      // Corrupt group metadata cannot authorize removal of a possibly referenced source.
      for (const root of sourceRootsFor(workspace)) {
        if (session.workspaceId !== undefined && session.workspaceId !== workspace.id) break;
        result.push({ rootId: root.id, kind: 'worktree', id: session.id, label: session.name, sessionId: session.id });
      }
    }
  }
  for (const queued of listDelegateSourceUses(workspace.id)) {
    const use = { kind: 'queued-task' as const, id: queued.queueId, label: queued.name ?? queued.queueId };
    append(queued, use);
    for (const sourceRoot of queued.sourceRoots ?? []) append({ workspaceId: queued.workspaceId, sourceRoot }, use);
  }
  for (const service of ctx.tasks.rootDependencyRoster()) append(service, {
    kind: 'service', id: service.id, label: service.name, serviceId: service.id
  });
  for (const task of ctx.bgTasks?.runningSourceRoster() ?? []) append(task, {
    kind: 'background-task', id: task.id, label: task.label, sessionId: task.parentSessionId
  });
  const unique = new Map(result.map(use => [JSON.stringify([use.rootId, use.kind, use.id]), use]));
  return [...unique.values()];
}

export function bindWorkspaceRootDependencies(ctx: AppContext): void {
  ctx.workspaces.setRootRemovalGuard((workspace, removed) => {
    const ids = new Set(removed.map(root => root.id));
    return workspaceRootDependencies(ctx, workspace).filter(use => ids.has(use.rootId));
  });
}
