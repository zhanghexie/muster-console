import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, SessionMeta, SessionWorktreeGroup, WorkspaceInfo } from '../../shared/types';
import { sessionWorktreeGroups } from '../../shared/sessionWorktrees';
import { defaultRootFor } from '../../shared/workspaceRoots';
import { controlRootFor, locateAbsolutePath, requireSourceRoot, requireWorkspace, resolveRealPathInsideRoot, sourcePathKey, sourceRootsFor } from '../workspacePaths';
import { isPathInsideWorkspace } from '../git/scan';
import { toPosixRel } from '../../shared/workspacePath';

type WorkspaceConfig = Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>;
export interface SessionTargetInput {
  workspaceId?: string;
  rootId?: string;
  cwd?: string;
  rootsRevision?: number;
  /** Internal queue snapshot; changing the default must not redirect queued work. */
  capturedSource?: SessionMeta['sourceRoot'];
}
export interface SessionTarget {
  workspaceId: string;
  cwd: string;
  wsPath: string;
  controlRoot: string;
  rootsRevision: number;
  sourceRoot: NonNullable<SessionMeta['sourceRoot']>;
  sourceKey: string;
  controlKey: string;
}

/** Shared forks refer to an existing owner; they must not acquire cleanup ownership. */
export function registeredWorktreeSession(sessions: readonly SessionMeta[], cwd?: string, workspaceId?: string): SessionMeta | undefined {
  if (!cwd) return undefined;
  const matches = sessions.filter((session) => (workspaceId === undefined || session.workspaceId === workspaceId) && registeredWorktreeGroup(session, cwd));
  if (new Set(matches.map((s) => s.workspaceId)).size > 1) throw new Error('ambiguous workspace identity; workspaceId required');
  return matches.sort((a, b) => registeredWorktreeGroup(b, cwd)!.path.length - registeredWorktreeGroup(a, cwd)!.path.length)[0];
}

export function registeredWorktreeGroup(session: SessionMeta, cwd: string): SessionWorktreeGroup | undefined {
  return sessionWorktreeGroups(session)?.groups.filter(group => isPathInsideWorkspace(cwd, group.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

async function locateWorkspace(config: WorkspaceConfig, input: SessionTargetInput): Promise<WorkspaceInfo> {
  if (input.workspaceId !== undefined || !input.cwd) return requireWorkspace(config, input.workspaceId);
  const matches: WorkspaceInfo[] = [];
  for (const workspace of config.workspaces) {
    if (workspace.rootsError) continue;
    if (await locateAbsolutePath(workspace, input.cwd)) matches.push(workspace);
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous workspace identity; workspaceId required' : 'working directory is outside registered source folders');
  return matches[0];
}

/** Capture a single source identity. External task trees require a registered source session. */
export async function resolveSessionTarget(
  config: WorkspaceConfig,
  input: SessionTargetInput,
  worktreeSession?: SessionMeta
): Promise<SessionTarget> {
  if (input.cwd !== undefined && (!input.cwd.trim() || !path.isAbsolute(input.cwd.trim()))) throw new Error('absolute working directory required');
  const cwdInput = input.cwd?.trim();
  const workspace = input.workspaceId !== undefined || !cwdInput ? requireWorkspace(config, input.workspaceId) : await locateWorkspace(config, { ...input, cwd: cwdInput });
  const revision = workspace.rootsRevision ?? 0;
  if (input.rootsRevision !== undefined && input.rootsRevision !== revision) throw new Error('workspace source folders changed; retry');
  const inheritedGroup = cwdInput && worktreeSession?.workspaceId === workspace.id ? registeredWorktreeGroup(worktreeSession, cwdInput) : undefined;
  const inheritedTree = !!inheritedGroup;
  const inherited = inheritedGroup?.sourceRoot ?? (worktreeSession?.workspaceId === workspace.id && (inheritedTree || cwdInput === worktreeSession.cwd) ? worktreeSession.sourceRoot : undefined);
  const captured = input.capturedSource ?? inherited;
  const rootId = input.rootId ?? captured?.rootId;
  let root = rootId !== undefined ? requireSourceRoot(workspace, rootId) : undefined;
  if (captured && (captured.rootId !== rootId || sourcePathKey(captured.path) !== sourcePathKey(root!.path) || (captured.physicalPath !== undefined && captured.physicalPath !== sourcePathKey(root!.path)))) throw new Error('task source folder changed or was removed');
  if (!root && cwdInput) {
    const sourceCwd = inheritedTree ? inheritedGroup?.source?.mainRepo : cwdInput;
    if (sourceCwd) {
      const ref = await locateAbsolutePath(workspace, sourceCwd);
      if (ref) root = requireSourceRoot(workspace, ref.rootId);
    }
    if (!root && inheritedTree) {
      const roots = sourceRootsFor(workspace);
      if (roots.length === 1 && inheritedGroup?.source?.mainRepo && isPathInsideWorkspace(roots[0].path, inheritedGroup.source.mainRepo)) root = roots[0];
    }
    if (!root) throw new Error('working directory is outside registered source folders');
  }
  root ??= defaultRootFor(workspace);
  const sourceKey = sourcePathKey(root.path);
  const controlRoot = controlRootFor(workspace);
  const controlKey = sourcePathKey(controlRoot);
  let cwd = cwdInput ?? captured?.cwd ?? root.path;
  if (!inheritedTree && !isPathInsideWorkspace(cwd, root.path)) {
    // A Junction alias can locate the same root; run through its registered path.
    const physicalRoot = await fs.realpath(root.path);
    cwd = path.join(root.path, toPosixRel(physicalRoot, await fs.realpath(cwd)));
  }
  const sourceCwd = inheritedTree ? captured?.cwd ?? inherited?.cwd ?? root.path : cwd;
  // A selected parent root remains valid in overlapping source folders.
  await resolveRealPathInsideRoot(root.path, sourceCwd);
  if (inheritedTree) await resolveRealPathInsideRoot(inheritedGroup!.path, cwd);
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('working directory is not a directory');
  const target: SessionTarget = {
    workspaceId: workspace.id, cwd, wsPath: root.path, controlRoot, rootsRevision: revision,
    sourceRoot: { rootId: root.id, path: root.path, cwd: sourceCwd, physicalPath: sourceKey },
    sourceKey, controlKey
  };
  assertSessionTargetCurrent(config, target);
  return target;
}

/** Recheck after awaits; harmless label/order/default changes do not relocate a pinned source. */
export function assertSessionTargetCurrent(config: WorkspaceConfig, target: SessionTarget): void {
  const workspace = requireWorkspace(config, target.workspaceId);
  const root = requireSourceRoot(workspace, target.sourceRoot.rootId);
  if (sourcePathKey(root.path) !== target.sourceKey || sourcePathKey(controlRootFor(workspace)) !== target.controlKey) throw new Error('task source folder changed; retry');
}

/** Legacy ownership is inferred only when unique; an external tree uses its recorded main repo. */
export function legacySessionWorkspaceId(config: WorkspaceConfig, session: Pick<SessionMeta, 'workspaceId' | 'cwd' | 'sourceRoot' | 'worktreeSource'>): string {
  if (session.workspaceId !== undefined) return session.workspaceId;
  const cwd = session.sourceRoot?.cwd ?? session.worktreeSource?.mainRepo ?? session.cwd;
  if (!cwd || !path.isAbsolute(cwd)) return '';
  const physical = sourcePathKey(cwd);
  const matches = config.workspaces.filter((workspace) => !workspace.rootsError && sourceRootsFor(workspace).some((root) => isPathInsideWorkspace(physical, sourcePathKey(root.path))));
  return matches.length === 1 ? matches[0].id : '';
}

export function legacySessionSourceRoot(config: WorkspaceConfig, session: SessionMeta): SessionMeta['sourceRoot'] {
  if (session.sourceRoot) return session.sourceRoot;
  const workspace = config.workspaces.find((w) => w.id === legacySessionWorkspaceId(config, session));
  const cwd = session.worktreeSource?.mainRepo ?? session.cwd;
  if (!workspace || workspace.rootsError || !cwd) return undefined;
  const physical = sourcePathKey(cwd);
  const roots = [...sourceRootsFor(workspace)].sort((a, b) => sourcePathKey(b.path).length - sourcePathKey(a.path).length);
  const root = roots.find((root) => isPathInsideWorkspace(physical, sourcePathKey(root.path)));
  return root ? { rootId: root.id, path: root.path, cwd } : undefined;
}
