import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, SessionMeta } from '../shared/types';
import { sessionWorktreeGroups } from '../shared/sessionWorktrees';
import type { ExecutionDirectory, WorkspaceExecutionContext } from '../shared/workspaceExecutionContext';
import { controlRootFor, requireSourceRoot, requireWorkspace, sourcePathKey, sourceRootsFor } from './workspacePaths';
import { legacySessionSourceRoot, legacySessionWorkspaceId, registeredWorktreeSession } from './sessions/targets';
import { pathKey } from './pathKey';
import { readGitDirectories } from './git/repoIdentity';

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function directory(directoryPath: string): ExecutionDirectory {
  const absolute = path.resolve(directoryPath);
  if (!fs.statSync(absolute).isDirectory()) throw new Error(`not a directory: ${absolute}`);
  return Object.freeze({ path: absolute, physicalPath: sourcePathKey(fs.realpathSync(absolute)) });
}

function unique(dirs: ExecutionDirectory[]): readonly ExecutionDirectory[] {
  return Object.freeze(dirs.filter((dir, i) => dirs.findIndex(other => other.physicalPath === dir.physicalPath) === i));
}

export function usesCodexWorktreeCwd(session: SessionMeta): boolean {
  return (session.runtime === 'codex' || session.runtime === 'codex-gui') && session.worktreeGroups?.cwdPolicy === 'source';
}

type WorktreeExecution = NonNullable<WorkspaceExecutionContext['worktreeExecution']>;
type WorktreeMapping = WorkspaceExecutionContext['mappings'][number];

/** Stop at the nearest repository marker, including an unusable or unselected nested checkout. */
function gitRootWithin(cwd: string, ceiling: string): string | undefined {
  const root = fs.realpathSync.native(ceiling);
  for (let probe = fs.realpathSync.native(cwd); inside(probe, root); probe = path.dirname(probe)) {
    try {
      fs.lstatSync(path.join(probe, '.git'));
      return probe;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (pathKey(probe) === pathKey(root) || path.dirname(probe) === probe) break;
  }
}

function resolveWorktreeExecution(
  cwd: ExecutionDirectory,
  selected: ExecutionDirectory,
  mappings: readonly WorktreeMapping[],
  branches: ReadonlyMap<string, string | undefined>,
  primaryPath: string
): WorktreeExecution {
  const sourceCwd = fs.realpathSync.native(cwd.path);
  const sourceRepo = gitRootWithin(cwd.path, selected.path);
  const mapping = sourceRepo
    ? mappings.find(item => sourcePathKey(item.sourcePath) === pathKey(sourceRepo))
    : mappings.some(item => inside(fs.realpathSync.native(item.sourcePath), sourceCwd))
      ? mappings.find(item => item.worktreePath === primaryPath)
      : undefined;
  if (!mapping) throw new Error(`No isolated worktree maps the Codex working directory: ${cwd.path}`);
  const checkout = directory(mapping.worktreePath);
  const relative = sourceRepo ? path.relative(sourceRepo, sourceCwd) : '';
  const target = path.join(checkout.path, relative);
  try {
    const git = readGitDirectories(checkout.path);
    const branch = branches.get(mapping.worktreePath);
    if (!git || !branch) throw new Error('worktree Git identity is incomplete');
    const execution = Object.freeze({ cwd: directory(target), checkout, gitDir: sourcePathKey(git.gitDir), branch });
    assertWorktreeExecutionCurrent(execution);
    return execution;
  } catch (error) {
    throw new Error(`Cannot use the isolated Codex working directory ${target}: ${(error as Error).message}`);
  }
}

export function assertWorktreeExecutionCurrent(execution?: WorktreeExecution): void {
  if (!execution) return;
  const { cwd, checkout, gitDir, branch } = execution;
  const git = readGitDirectories(checkout.path);
  if (!git || directory(checkout.path).physicalPath !== checkout.physicalPath ||
      directory(cwd.path).physicalPath !== cwd.physicalPath ||
      gitRootWithin(cwd.path, checkout.path) !== fs.realpathSync.native(checkout.path) ||
      sourcePathKey(git.gitDir) !== gitDir || gitDir === sourcePathKey(git.commonDir) ||
      !inside(gitDir, sourcePathKey(path.join(git.commonDir, 'worktrees'))) ||
      sourcePathKey(path.resolve(git.gitDir, fs.readFileSync(path.join(git.gitDir, 'gitdir'), 'utf8').trim())) !==
        sourcePathKey(path.join(checkout.path, '.git')) ||
      fs.readFileSync(path.join(git.gitDir, 'HEAD'), 'utf8').trim() !== `ref: refs/heads/${branch}`) {
    throw new Error(`Codex worktree directory or branch changed: ${cwd.path} (expected ${branch})`);
  }
}

/** Sync capture before any await; unregistered legacy sessions keep the old cwd-only policy. */
export function captureWorkspaceExecutionContext(
  config: Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>,
  session: SessionMeta,
  registeredSessions: readonly SessionMeta[] = []
): WorkspaceExecutionContext | undefined {
  const workspaceId = session.workspaceId ?? legacySessionWorkspaceId(config, session);
  if (!workspaceId) {
    if (usesCodexWorktreeCwd(session)) throw new Error('Cannot resolve the workspace for the isolated Codex session');
    return undefined;
  }
  const workspace = requireWorkspace(config, workspaceId);
  const source = session.sourceRoot ?? legacySessionSourceRoot(config, session);
  if (!source) throw new Error('session source folder cannot be resolved');
  const root = requireSourceRoot(workspace, source.rootId);
  const selected = directory(root.path);
  if (sourcePathKey(source.path) !== selected.physicalPath || (source.physicalPath !== undefined && source.physicalPath !== selected.physicalPath)) throw new Error('session source folder changed');
  if (!session.cwd || !path.isAbsolute(session.cwd)) throw new Error('absolute session cwd required');
  const cwd = directory(session.cwd);
  const management = directory(controlRootFor(workspace));
  const directories: ExecutionDirectory[] = [];
  const roots = sourceRootsFor(workspace).map(root => {
    try {
      directories.push(directory(root.path));
      return Object.freeze({ rootId: root.id, path: root.path, ...(root.label ? { label: root.label } : {}) });
    } catch (error) {
      return Object.freeze({ rootId: root.id, path: root.path, ...(root.label ? { label: root.label } : {}), error: String((error as Error).message) });
    }
  });
  const mappings: WorkspaceExecutionContext['mappings'][number][] = [];
  const branches = new Map<string, string | undefined>();
  const references: ExecutionDirectory[] = [];
  let writable = directories;
  const worktree = sessionWorktreeGroups(session) ? session : registeredWorktreeSession(registeredSessions, session.cwd, workspaceId);
  const groups = worktree && sessionWorktreeGroups(worktree);
  const preserveCwd = groups?.cwdPolicy === 'source' && !!session.worktreeGroups;
  if (groups) {
    for (const recorded of groups.sourceRoots ?? []) {
      const sourceRoot = requireSourceRoot(workspace, recorded.rootId);
      const physical = directory(sourceRoot.path).physicalPath;
      if (sourcePathKey(recorded.path) !== physical || (recorded.physicalPath !== undefined && recorded.physicalPath !== physical)) throw new Error('worktree selected source folder changed');
    }
    writable = preserveCwd ? [...directories] : [];
    for (const group of groups.groups) {
      const recorded = group.sourceRoot ?? (groups.groups.length === 1 ? source : undefined);
      if (!recorded) throw new Error('worktree source folder identity is missing');
      const groupRoot = requireSourceRoot(workspace, recorded.rootId);
      const sourceDir = directory(groupRoot.path);
      if (sourcePathKey(recorded.path) !== sourceDir.physicalPath || (recorded.physicalPath !== undefined && recorded.physicalPath !== sourceDir.physicalPath)) throw new Error('worktree source folder changed');
      const tree = directory(group.path);
      const sourcePath = group.source?.mainRepo ?? recorded.cwd;
      if (!inside(sourcePathKey(sourcePath), sourceDir.physicalPath)) throw new Error('worktree source is outside its registered source folder');
      if (preserveCwd || groups.groups.length > 1) {
        const treeGit = readGitDirectories(tree.path);
        const sourceGit = readGitDirectories(sourcePath);
        const common = group.source?.commonDir;
        if (!treeGit || !sourceGit || !common || sourcePathKey(treeGit.commonDir) !== sourcePathKey(common) || sourcePathKey(sourceGit.commonDir) !== sourcePathKey(common) || pathKey(treeGit.gitDir) === pathKey(treeGit.commonDir)) throw new Error('worktree repository identity changed');
      }
      mappings.push(Object.freeze({ rootId: groupRoot.id, sourcePath, worktreePath: tree.path }));
      branches.set(tree.path, group.branch);
      if (preserveCwd) references.push(directory(sourcePath));
      for (const repo of group.repos) {
        const sourceChild = directory(path.join(sourcePath, repo.path));
        const treeChild = directory(path.join(tree.path, repo.path));
        const sourceGit = readGitDirectories(sourceChild.path), treeGit = readGitDirectories(treeChild.path);
        if (!inside(sourceChild.physicalPath, sourceDir.physicalPath) || !inside(treeChild.physicalPath, tree.physicalPath)
          || !sourceGit || !treeGit || sourcePathKey(sourceGit.commonDir) !== sourcePathKey(treeGit.commonDir)
          || sourcePathKey(treeGit.gitDir) === sourcePathKey(treeGit.commonDir)) throw new Error('nested worktree repository identity changed');
        mappings.push(Object.freeze({ rootId: groupRoot.id, sourcePath: sourceChild.path, worktreePath: treeChild.path }));
        branches.set(treeChild.path, repo.branch);
        if (preserveCwd) references.push(sourceChild);
      }
      directories.push(tree);
      writable.push(tree);
    }
    if (preserveCwd) {
      if (!inside(cwd.physicalPath, selected.physicalPath)) throw new Error('session cwd is outside its registered source folder');
    } else if (!writable.some(tree => inside(cwd.physicalPath, tree.physicalPath))) throw new Error('session cwd is outside its registered worktree');
  } else if (!inside(cwd.physicalPath, selected.physicalPath)) {
    throw new Error('session cwd is outside its registered source folder');
  }
  const worktreeExecution = groups && usesCodexWorktreeCwd(session)
    ? resolveWorktreeExecution(cwd, selected, mappings, branches, path.resolve(groups.groups.find(group => group.id === groups.primaryGroupId)!.path))
    : undefined;
  return Object.freeze({
    workspaceId: workspace.id, workspaceName: workspace.name,
    rootsRevision: workspace.rootsRevision ?? 0, sourceRootId: root.id,
    cwd: worktreeExecution?.cwd.path ?? cwd.path, controlRoot: management.path, controlPhysicalPath: management.physicalPath,
    ...(worktreeExecution ? { worktreeExecution } : {}),
    roots: Object.freeze(roots), readableDirectories: unique(directories),
    writableDirectories: unique(writable), mappings: Object.freeze(mappings),
    ...(preserveCwd ? { referenceDirectories: unique(references), mappingRevision: groups.revision ?? 1 } : {})
  });
}

/** Resolve an existing path or a new path's nearest ancestor; broken links fail closed. */
export function executionPathKey(candidate: string): string {
  let probe = path.resolve(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      missing.unshift(path.basename(probe));
      probe = parent;
      continue;
    }
    // A link exists even when its target is missing: realpath failure must not climb past it.
    return pathKey(path.join(fs.realpathSync.native(probe), ...missing));
  }
}

export function pathInExecutionDirectories(candidate: string, cwd: string, dirs: readonly ExecutionDirectory[]): boolean {
  try {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    const physical = executionPathKey(absolute);
    return dirs.some(dir => sourcePathKey(fs.realpathSync(dir.path)) === dir.physicalPath && inside(physical, dir.physicalPath));
  } catch { return false; }
}

/** A writable ancestor must not reopen a mapped source checkout through an alias. */
export function pathWritableInContext(candidate: string, context: WorkspaceExecutionContext): boolean {
  if (!pathInExecutionDirectories(candidate, context.cwd, context.writableDirectories)) return false;
  try {
    const physical = executionPathKey(path.isAbsolute(candidate) ? candidate : path.resolve(context.cwd, candidate));
    const reference = [...(context.referenceDirectories ?? [])].filter(dir => inside(physical, dir.physicalPath)).sort((a, b) => b.physicalPath.length - a.physicalPath.length)[0];
    if ((context.referenceDirectories ?? []).some(dir => inside(dir.physicalPath, physical))) return false;
    if (!reference) return true;
    for (let probe = physical; inside(probe, reference.physicalPath) && probe !== reference.physicalPath; probe = path.dirname(probe)) {
      if (readGitDirectories(probe)) return true;
    }
    return false;
  } catch { return false; }
}

/** Native options grant write access; a handover directory is a session-owned exception. */
export function additionalExecutionDirectories(context?: WorkspaceExecutionContext): string[] {
  if (!context) return [];
  const writable = context.writableDirectories.filter(dir => path.resolve(dir.path) !== path.resolve(context.cwd) &&
    (!context.worktreeExecution || !context.referenceDirectories?.some(reference =>
      inside(reference.physicalPath, dir.physicalPath) || inside(dir.physicalPath, reference.physicalPath))));
  const handover = context.handoverDirectory;
  if (handover && path.resolve(handover.path) !== path.resolve(context.cwd) && !writable.some(dir =>
    path.resolve(dir.path) === path.resolve(handover.path) || (!!dir.physicalPath && dir.physicalPath === handover.physicalPath))) {
    return [...writable.map(dir => dir.path), handover.path];
  }
  return writable.map(dir => dir.path);
}

/** Defaults/order/new roots do not change a captured scope; removal/retargeting does. */
export function assertWorkspaceExecutionContextCurrent(
  config: Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>, context?: WorkspaceExecutionContext
): void {
  if (!context) return;
  assertWorktreeExecutionCurrent(context.worktreeExecution);
  const workspace = requireWorkspace(config, context.workspaceId);
  if (directory(controlRootFor(workspace)).physicalPath !== context.controlPhysicalPath) throw new Error('workspace management folder changed');
  for (const captured of context.roots) {
    const root = requireSourceRoot(workspace, captured.rootId);
    if (path.resolve(root.path) !== path.resolve(captured.path)) throw new Error('workspace source folder changed');
  }
  for (const captured of context.readableDirectories) {
    if (directory(captured.path).physicalPath !== captured.physicalPath) throw new Error('workspace directory identity changed');
  }
}
