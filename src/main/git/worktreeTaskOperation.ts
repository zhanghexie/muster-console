import type { SessionMeta } from '../../shared/types';
import { sessionWorktreeGroups } from '../../shared/sessionWorktrees';

const tasks = new WeakMap<object, Map<string, string>>();
const repositories = new Map<string, object>();

/** Single-repository adoption shares exclusion with task snapshots/integration/cleanup. */
export function beginWorktreeRepositoryOperation(commonDir: string): () => void {
  if (repositories.has(commonDir)) throw new Error('worktree repository operation already running');
  const token = {};
  repositories.set(commonDir, token);
  return () => { if (repositories.get(commonDir) === token) repositories.delete(commonDir); };
}

/** Diagnostics can advance without transferring ownership of the saved topology. */
export function taskWorktreeOwnership(session: SessionMeta): string {
  const state = sessionWorktreeGroups(session);
  return JSON.stringify({ workspaceId: session.workspaceId, sourceRoot: session.sourceRoot, cwd: session.cwd,
    state: state && { ...state, groups: state.groups.map(({ integration: _integration, cleanup: _cleanup, ...group }) => group) } });
}

export function assertTaskWorktreeOperationIdle(config: object, sessionId: string): void {
  const operation = tasks.get(config)?.get(sessionId);
  if (operation) throw new Error(`worktree task ${operation} already running`);
}

/** Shared by integration, cleanup and ownership transfer; acquire before the first await. */
export function beginTaskWorktreeOperation(config: object, sessionId: string, operation: string) {
  assertTaskWorktreeOperationIdle(config, sessionId);
  const active = tasks.get(config) ?? new Map<string, string>();
  tasks.set(config, active); active.set(sessionId, operation);
  const token = {}, held = new Set<string>();
  return {
    holdRepository(commonDir: string) {
      if (held.has(commonDir)) throw new Error('duplicate task repository common directory');
      if (repositories.has(commonDir)) throw new Error('worktree repository operation already running');
      repositories.set(commonDir, token); held.add(commonDir);
    },
    release() {
      for (const common of held) if (repositories.get(common) === token) repositories.delete(common);
      active.delete(sessionId);
    }
  };
}
