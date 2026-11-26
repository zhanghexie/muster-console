import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppConfig, WorkspaceFileRef } from '../shared/types';
import { toPosixRel } from '../shared/workspacePath';
import { captureWorkspaceRoots, locateAbsolutePath, requireSourceRoot, requireWorkspace, resolveFileRef, resolveFileRefLexical, sourcePathKey, workspaceRootsAreCurrent } from './workspacePaths';
import { pathKey } from './pathKey';
import { holdPendingSource } from './workspaceRootUses';
import type { WorkspaceRootDependency } from '../shared/types';
import { randomUUID } from 'node:crypto';
import { OUTSIDE_WORKSPACE_ROOTS_REASON } from '../shared/errors';

export type WorkspaceFileTarget = string | WorkspaceFileRef | undefined;
type WorkspaceConfig = Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>;

/** 绝对路径在所有源根之外：message 保持原文（渲染层旧契约兜底），reason 供结构化判定。 */
class OutsideWorkspaceRootsError extends Error {
  readonly reason = OUTSIDE_WORKSPACE_ROOTS_REASON;
  constructor() {
    super('path outside workspace roots');
    this.name = 'OutsideWorkspaceRootsError';
  }
}

/** 父子源根可以同时登记；删除父根中的子目录不得绕过源根移除入口。 */
export async function assertNoSourceRootDeletion(config: WorkspaceConfig, absolutePath: string): Promise<void> {
  const physicalTarget = await fs.realpath(absolutePath).catch(() => absolutePath);
  const targetKeys = [pathKey(absolutePath), pathKey(physicalTarget)];
  for (const workspace of config.workspaces) {
    const paths = [...(Array.isArray(workspace.roots) ? workspace.roots.map((r) => r?.path) : [workspace.path]), workspace.controlRoot];
    for (const rootPath of paths) {
      if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) continue;
      const physicalRoot = await fs.realpath(rootPath).catch(() => rootPath);
      for (const rootKey of [pathKey(rootPath), pathKey(physicalRoot)]) {
        if (targetKeys.some((key) => rootKey === key || rootKey.startsWith(`${key}/`))) {
          throw new Error('cannot delete a registered source folder or its parent directory');
        }
      }
    }
  }
}

/** IPC 旧单根参数与新 FileRef 的唯一适配入口；异步返回必须仍属当前根快照。 */
export async function withWorkspaceFileTarget<T>(
  getConfig: () => WorkspaceConfig,
  target: WorkspaceFileTarget,
  legacyPath: string,
  operation: (root: string, ref: WorkspaceFileRef, absolutePath: string) => Promise<T>,
  sourceStable = false,
  treeListing = false
): Promise<T> {
  const config = getConfig();
  let ref: WorkspaceFileRef;
  if (target && typeof target === 'object') {
    if (typeof target.workspaceId !== 'string' || !target.workspaceId.trim() || typeof target.rootId !== 'string' || !target.rootId || typeof target.relativePath !== 'string') {
      throw new Error('invalid workspace file reference');
    }
    ref = target;
  } else {
    const workspace = requireWorkspace(config, target ?? undefined);
    if (path.isAbsolute(legacyPath)) {
      const located = await locateAbsolutePath(workspace, legacyPath);
      if (!located) throw new OutsideWorkspaceRootsError();
      ref = located;
    } else {
      const root = requireSourceRoot(workspace);
      ref = { workspaceId: workspace.id, rootId: root.id, relativePath: toPosixRel(root.path, path.resolve(root.path, legacyPath)) };
    }
  }
  const workspace = requireWorkspace(config, ref.workspaceId);
  const root = requireSourceRoot(workspace, ref.rootId);
  const declaredKey = sourceStable ? pathKey(root.path) : undefined;
  const physicalKey = sourceStable ? sourcePathKey(root.path) : undefined;
  const token = captureWorkspaceRoots(config, workspace.id);
  // Only the read-only tree listing may follow a link outside a source root.
  const absolutePath = treeListing ? resolveFileRefLexical(config, ref) : await resolveFileRef(config, ref);
  const assertCurrent = (): void => {
    // A pinned write must not be reported as failed after harmless label/order/default edits.
    if (sourceStable) {
      const current = requireSourceRoot(requireWorkspace(getConfig(), workspace.id), root.id);
      if (pathKey(current.path) !== declaredKey || sourcePathKey(current.path) !== physicalKey) throw new Error('workspace source folder changed; retry with the current file reference');
      return;
    }
    if (!workspaceRootsAreCurrent(getConfig(), token)) throw new Error('workspace source folders changed; retry with the current file reference');
  };
  assertCurrent();
  const result = await operation(root.path, ref, absolutePath);
  assertCurrent();
  return result;
}

/** Writes hold the root through realpath checks and the actual mutation, even after disconnect. */
export async function withWorkspaceFileMutation<T>(
  config: { get(): WorkspaceConfig }, target: WorkspaceFileTarget, legacyPath: string,
  kind: Extract<WorkspaceRootDependency['kind'], 'file-write' | 'file-delete'>,
  operation: (root: string, ref: WorkspaceFileRef, absolutePath: string) => Promise<T>
): Promise<T> {
  const cfg = config.get();
  const workspace = requireWorkspace(cfg, typeof target === 'object' ? target.workspaceId : target);
  const release = holdPendingSource(config, { workspaceId: workspace.id,
    ...(typeof target === 'object' ? { rootId: target.rootId } : path.isAbsolute(legacyPath) ? { cwd: legacyPath } : {}) },
    { kind, id: randomUUID(), label: typeof target === 'object' ? target.relativePath : legacyPath });
  try { return await withWorkspaceFileTarget(() => config.get(), target, legacyPath, operation, true); }
  finally { release(); }
}
