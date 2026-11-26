import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, ResolvedWorkspaceInfo, WorkspaceFileRef, WorkspaceInfo, WorkspaceRoot } from '../shared/types';
import { controlRootFor, defaultCwdFor, legacyWorkspaceRootId, requireSourceRoot, sourceRootsFor } from '../shared/workspaceRoots';
import { resolveInsideRoot, toPosixRel } from '../shared/workspacePath';
import { pathKey } from './pathKey';

export { controlRootFor, defaultCwdFor, requireSourceRoot, sourceRootsFor };

let demoWorkspaceData: ((workspaceId: string, roots: readonly WorkspaceRoot[]) => string) | undefined;
export function setDemoWorkspaceDataResolver(resolve: NonNullable<typeof demoWorkspaceData>): void {
  demoWorkspaceData = resolve;
}

export interface WorkspaceRootsToken {
  workspaceId: string;
  rootsRevision: number;
}

export function captureWorkspaceRoots(config: Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>, workspaceId?: string): WorkspaceRootsToken {
  const workspace = requireWorkspace(config, workspaceId);
  return { workspaceId: workspace.id, rootsRevision: workspace.rootsRevision ?? 0 };
}

/** 异步扫描/读取返回前校验；移除工作区或修复坏配置也不能放回旧结果。 */
export function workspaceRootsAreCurrent(config: Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>, token: WorkspaceRootsToken): boolean {
  const matches = config.workspaces.filter((w) => w.id === token.workspaceId);
  return matches.length === 1 && !matches[0].rootsError && (matches[0].rootsRevision ?? 0) === token.rootsRevision;
}

export function requireWorkspace(config: Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>, workspaceId?: string): WorkspaceInfo {
  const id = workspaceId === undefined ? config.activeWorkspaceId : workspaceId.trim();
  const matches = config.workspaces.filter((w) => w.id === id);
  if (matches.length > 1) throw new Error('ambiguous workspace identity');
  const workspace = matches[0];
  if (!workspace) throw new Error('workspace not found');
  if (workspace.rootsError) throw new Error(workspace.rootsError);
  return workspace;
}

/** 离线根保留词法身份；在线根按 realpath 去重（Windows Junction/盘符大小写）。 */
export function sourcePathKey(root: string): string {
  try { return pathKey(fs.realpathSync.native(root)); }
  catch { return pathKey(root); }
}

/** 只迁移结构，绝不探测后删除离线根。外部配置的非法结构由调用方报告。 */
export function normalizeWorkspaceRoots(workspace: WorkspaceInfo): ResolvedWorkspaceInfo {
  const rawRoots = workspace.roots ?? [{ id: legacyWorkspaceRootId(workspace.id), path: workspace.path }];
  if (!Array.isArray(rawRoots) || !rawRoots.length) throw new Error('workspace has no source folders');
  const roots: WorkspaceRoot[] = [];
  const ids = new Set<string>();
  const byPath = new Map<string, WorkspaceRoot>();
  const aliases = new Map<string, string>();
  for (const raw of rawRoots) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || typeof raw.path !== 'string' || !path.isAbsolute(raw.path)) {
      throw new Error('invalid workspace source folder');
    }
    if (ids.has(raw.id)) throw new Error('duplicate workspace source folder id');
    ids.add(raw.id);
    const resolved = path.resolve(raw.path);
    const key = sourcePathKey(resolved);
    const existing = byPath.get(key);
    if (existing) { aliases.set(raw.id, existing.id); continue; }
    const root: WorkspaceRoot = { id: raw.id, path: resolved };
    if (typeof raw.label === 'string' && raw.label.trim()) root.label = raw.label.trim();
    byPath.set(key, root);
    roots.push(root);
  }
  const requestedDefault = workspace.defaultRootId ?? (workspace.roots === undefined || roots.length === 1 ? roots[0].id : undefined);
  const defaultRootId = requestedDefault ? aliases.get(requestedDefault) ?? requestedDefault : undefined;
  const defaultRoot = roots.find((r) => r.id === defaultRootId);
  if (!defaultRoot) throw new Error('workspace default source folder is missing');
  if (roots.length > 1 && workspace.controlRoot === undefined) throw new Error('workspace management folder is missing');
  if (workspace.controlRoot !== undefined && (typeof workspace.controlRoot !== 'string' || !path.isAbsolute(workspace.controlRoot))) {
    throw new Error('invalid workspace management folder');
  }
  const controlRoot = path.resolve(workspace.controlRoot ?? workspace.path);
  if (!roots.some((r) => sourcePathKey(r.path) === sourcePathKey(controlRoot))) {
    throw new Error('workspace management folder must remain registered');
  }
  const { rootsError: _previousError, demoDataRoot: _storedDemoPath, ...metadata } = workspace;
  const normalized: ResolvedWorkspaceInfo = {
    ...metadata, roots, defaultRootId: defaultRoot.id, controlRoot, path: defaultRoot.path,
    ...(demoWorkspaceData && { demoDataRoot: demoWorkspaceData(workspace.id, roots) }),
    rootsRevision: Number.isSafeInteger(workspace.rootsRevision) && workspace.rootsRevision! >= 0 ? workspace.rootsRevision! : 0
  };
  return normalized;
}

/** 最近存在的祖先必须在所登记根的 realpath 内；新文件也不能经 Junction 越界。 */
export async function resolveRealPathInsideRoot(root: string, candidate: string): Promise<string> {
  const abs = resolveInsideRoot(root, candidate);
  const physicalRoot = await fsp.realpath(root);
  resolveInsideRoot(physicalRoot, await physicalPathWithMissingLeaf(abs));
  return abs;
}

/** Resolve a new leaf via an existing ancestor without following a broken link. */
async function physicalPathWithMissingLeaf(abs: string): Promise<string> {
  let ancestor = abs;
  const suffix: string[] = [];
  for (;;) {
    try {
      const physicalAncestor = await fsp.realpath(ancestor);
      return path.join(physicalAncestor, ...suffix);
    } catch (err) {
      // 不把失效符号链接当作不存在的普通目录，避免依赖它解析新写入。
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (await fsp.lstat(ancestor).then(() => true, () => false)) throw err;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw err;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function resolveFileRefLexical(config: Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>, ref: WorkspaceFileRef): string {
  const workspace = requireWorkspace(config, ref.workspaceId);
  const root = requireSourceRoot(workspace, ref.rootId);
  const relative = ref.relativePath.replace(/\\/g, '/');
  if (relative.includes('\0') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) {
    throw new Error('invalid workspace relative path');
  }
  return resolveInsideRoot(root.path, relative);
}

export async function resolveFileRef(config: Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>, ref: WorkspaceFileRef): Promise<string> {
  const absolutePath = resolveFileRefLexical(config, ref);
  const root = requireSourceRoot(requireWorkspace(config, ref.workspaceId), ref.rootId);
  return resolveRealPathInsideRoot(root.path, absolutePath);
}

/** 重叠根优先最具体的根；没有匹配时返回区外，绝不选择活动区/默认根。 */
export async function locateAbsolutePath(workspace: WorkspaceInfo, absolutePath: string): Promise<WorkspaceFileRef | undefined> {
  if (!path.isAbsolute(absolutePath)) throw new Error('absolute path required');
  const candidates = [...sourceRootsFor(workspace)].sort((a, b) => b.path.length - a.path.length);
  for (const root of candidates) {
    let relativePath: string;
    try { relativePath = toPosixRel(root.path, absolutePath); }
    catch { continue; }
    await resolveRealPathInsideRoot(root.path, absolutePath);
    return { workspaceId: workspace.id, rootId: root.id, relativePath };
  }
  // 绝对路径可能使用登记根的另一个 Junction 别名。
  const physicalFile = await physicalPathWithMissingLeaf(path.resolve(absolutePath)).catch(() => undefined);
  if (!physicalFile) return undefined;
  const physicalRoots = await Promise.all(candidates.map(async (root) => ({ root, physical: await fsp.realpath(root.path).catch(() => undefined) })));
  physicalRoots.sort((a, b) => (b.physical?.length ?? 0) - (a.physical?.length ?? 0));
  for (const { root, physical } of physicalRoots) {
    if (!physical) continue;
    try { return { workspaceId: workspace.id, rootId: root.id, relativePath: toPosixRel(physical, physicalFile) }; }
    catch { /* 真正区外 */ }
  }
  return undefined;
}
