import type { AppContext } from '../context';
import { currentAgentSessionId, currentAgentWorkspaceId, isSchedulerInvocation } from '../agent/agentScope';
import { assertWorkspaceExecutionContextCurrent } from '../workspaceExecutionContext';
import { defaultCwdFor, requireWorkspace, sourcePathKey, sourceRootsFor } from '../workspacePaths';
import type { ExecutionDirectory } from '../../shared/workspaceExecutionContext';

/** Capture the authenticated caller's read scope; never trust workspaceId as authority. */
export function uploadScope(ctx: AppContext, workspaceId?: string, operation = 'Upload'): { workspaceId: string; cwd: string; dirs: readonly ExecutionDirectory[]; assertCurrent: () => void } {
  const sessionId = currentAgentSessionId();
  if (sessionId) {
    const session = ctx.sessions.peek(sessionId);
    const token = ctx.sessions.sessionScopeToken(sessionId);
    const runtime = session?.runtime;
    const chat = !!session && session.launchKind !== 'shell' && ctx.sessions.isChatRuntime(runtime);
    // CLI scope is the frozen lease of the actual process, never a new GUI snapshot.
    const cliLease = session && !chat ? ctx.sessions.getCliWorkspaceContext(sessionId) : undefined;
    const scope = chat ? ctx.agentSessions?.getWorkspaceContext(sessionId) : cliLease?.workspaceContext;
    const guiEntry = chat ? ctx.agentSessions?.entries?.get(sessionId) : undefined;
    const guiTurnScope = guiEntry?.turnWorkspaceContext;
    if (!scope || !session || !token || session.archived || session.workspaceId !== scope.workspaceId ||
        (workspaceId && workspaceId !== scope.workspaceId)) throw new Error(`${operation} requires the caller session read scope`);
    const assertCurrent = () => {
      if (ctx.sessions.peek(sessionId) !== session || ctx.sessions.sessionScopeToken(sessionId) !== token || session.archived ||
          session.runtime !== runtime || session.workspaceId !== scope.workspaceId ||
          (guiTurnScope && (ctx.agentSessions?.entries?.get(sessionId) !== guiEntry || guiEntry?.turnWorkspaceContext !== guiTurnScope)) ||
          (!chat && ctx.sessions.getCliWorkspaceContext(sessionId) !== cliLease)) {
        throw new Error(`${operation} session is no longer current`);
      }
      assertWorkspaceExecutionContextCurrent(ctx.config.get(), scope);
    };
    assertCurrent();
    return { workspaceId: scope.workspaceId, cwd: scope.cwd, dirs: scope.readableDirectories, assertCurrent };
  }
  const boundWorkspace = currentAgentWorkspaceId();
  if (!isSchedulerInvocation() || !boundWorkspace || (workspaceId && workspaceId !== boundWorkspace)) {
    throw new Error(`${operation} requires an authenticated workspace or session`);
  }
  const workspace = requireWorkspace(ctx.config.get(), boundWorkspace);
  const revision = workspace.rootsRevision ?? 0;
  const dirs = sourceRootsFor(workspace).map(root => ({ path: root.path, physicalPath: sourcePathKey(root.path) }));
  const assertCurrent = () => {
    const current = requireWorkspace(ctx.config.get(), boundWorkspace);
    const currentDirs = sourceRootsFor(current).map(root => ({ path: root.path, physicalPath: sourcePathKey(root.path) }));
    if ((current.rootsRevision ?? 0) !== revision || JSON.stringify(currentDirs) !== JSON.stringify(dirs)) {
      throw new Error(`${operation} workspace scope changed`);
    }
  };
  return { workspaceId: boundWorkspace, cwd: defaultCwdFor(workspace), dirs, assertCurrent };
}
