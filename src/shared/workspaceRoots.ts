import type { WorkspaceInfo, WorkspaceRoot } from './types';

/** 旧单根身份只依赖 workspaceId，重启、改名、默认根切换都不会重建身份。 */
export function legacyWorkspaceRootId(workspaceId: string): string {
  return `root-${workspaceId}`;
}

/** Renderer-safe；不做磁盘访问或路径猜测。真实目录校验集中在 main/workspacePaths。 */
export function sourceRootsFor(workspace: WorkspaceInfo): readonly WorkspaceRoot[] {
  if (workspace.rootsError) throw new Error(workspace.rootsError);
  if (workspace.roots !== undefined) {
    if (!Array.isArray(workspace.roots) || !workspace.roots.length) throw new Error('workspace has no source folders');
    return workspace.roots;
  }
  if (!workspace.path) throw new Error('workspace has no source folders');
  return [{ id: legacyWorkspaceRootId(workspace.id), path: workspace.path }];
}

export function defaultRootFor(workspace: WorkspaceInfo): WorkspaceRoot {
  const roots = sourceRootsFor(workspace);
  const id = workspace.defaultRootId ?? (roots.length === 1 ? roots[0].id : undefined);
  const root = roots.find((r) => r.id === id);
  if (!root) throw new Error('workspace default source folder is missing');
  return root;
}

export function defaultCwdFor(workspace: WorkspaceInfo): string {
  return defaultRootFor(workspace).path;
}

export function controlRootFor(workspace: WorkspaceInfo): string {
  const registered = registeredControlRootFor(workspace);
  return workspace.demoDataRoot ?? registered;
}

/** Registration and relative project bindings use the user's selected folder. */
export function registeredControlRootFor(workspace: WorkspaceInfo): string {
  if (workspace.rootsError) throw new Error(workspace.rootsError);
  if (workspace.controlRoot !== undefined) {
    if (typeof workspace.controlRoot !== 'string' || !workspace.controlRoot.trim()) throw new Error('workspace management folder is missing');
    return workspace.controlRoot;
  }
  if (workspace.roots !== undefined && workspace.roots.length > 1) {
    throw new Error('workspace management folder is missing');
  }
  return workspace.path;
}

/** 无根旧引用仅在单根下兼容；多根不得默默指向默认根。 */
export function requireSourceRoot(workspace: WorkspaceInfo, rootId?: string): WorkspaceRoot {
  const roots = sourceRootsFor(workspace);
  if (rootId === undefined && roots.length === 1) return roots[0];
  const root = roots.find((r) => r.id === rootId);
  if (!root) throw new Error(rootId === undefined ? 'source folder selection required' : 'source folder not found');
  return root;
}

export function workspaceRootLabel(root: WorkspaceRoot): string {
  return root.label?.trim() || root.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root.path;
}

/** 用于面板节点/历史/请求键，避免 rootId 或相对路径中的分隔符碰撞。 */
export function workspaceFileKey(ref: { rootId: string; relativePath: string }): string {
  return JSON.stringify([ref.rootId, ref.relativePath.replace(/\\/g, '/')]);
}
