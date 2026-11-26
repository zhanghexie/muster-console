import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';

/** Resolve IDs only from the host's captured execution context, never model input. */
export function reviewRootDirs(context?: WorkspaceExecutionContext): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  if (!context) return result;
  for (const root of context.roots ?? []) {
    if (root.error) continue;
    const mapping = (context.mappings ?? []).find(item => item.rootId === root.rootId);
    result.set(root.rootId, mapping?.worktreePath ?? root.path);
  }
  return result;
}
