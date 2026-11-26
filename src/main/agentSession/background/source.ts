import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, SessionMeta } from '../../../shared/types';
import type { WorkspaceExecutionContext } from '../../../shared/workspaceExecutionContext';
import { pathKey } from '../../pathKey';
import { requireSourceRoot, requireWorkspace, sourcePathKey } from '../../workspacePaths';
import { assertSessionTargetCurrent, legacySessionSourceRoot, legacySessionWorkspaceId, resolveSessionTarget } from '../../sessions/targets';
import { captureWorkspaceExecutionContext, usesCodexWorktreeCwd } from '../../workspaceExecutionContext';

type Config = Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>;

/** A background task inherits a registered parent; it never chooses the active/default root. */
export interface BgTaskSource {
  parent: SessionMeta;
  workspaceId: string;
  sourceRoot: NonNullable<SessionMeta['sourceRoot']>;
  cwd: string;
  cwdKey: string;
  worktreeExecution?: WorkspaceExecutionContext['worktreeExecution'];
}

export interface BgTaskLaunchGuard {
  prepare(): Promise<void>;
  assertCurrent(): void;
}

export function captureBgTaskSource(config: Config, parent?: SessionMeta, cwd?: string): BgTaskSource {
  if (!parent) throw new Error('background task parent session not found');
  const snapshot = structuredClone(parent);
  const workspaceId = legacySessionWorkspaceId(config, snapshot);
  const workspace = requireWorkspace(config, workspaceId);
  const source = legacySessionSourceRoot(config, snapshot);
  if (!source) throw new Error('background task source folder selection required');
  const root = requireSourceRoot(workspace, source.rootId);
  const physicalPath = sourcePathKey(root.path);
  if (pathKey(root.path) !== pathKey(source.path)
    || (source.physicalPath !== undefined && physicalPath !== source.physicalPath)) {
    throw new Error('background task source folder changed or was removed');
  }
  const worktreeExecution = usesCodexWorktreeCwd(snapshot) ? captureWorkspaceExecutionContext(config, snapshot)?.worktreeExecution : undefined;
  const actualCwd = worktreeExecution?.cwd.path ?? snapshot.cwd;
  if (!actualCwd || !path.isAbsolute(actualCwd) || (cwd !== undefined && pathKey(actualCwd) !== pathKey(cwd))) {
    throw new Error('background task working directory must match its parent session');
  }
  if (!fs.statSync(actualCwd).isDirectory()) throw new Error('background task working directory is not a directory');
  snapshot.workspaceId = workspaceId;
  snapshot.sourceRoot = { ...source, physicalPath };
  return { parent: snapshot, workspaceId, sourceRoot: snapshot.sourceRoot, cwd: actualCwd, cwdKey: sourcePathKey(actualCwd), worktreeExecution };
}

/** Recheck both registry membership and real directories across shell discovery/driver awaits. */
export function bgTaskLaunchGuard(
  config: () => Config,
  parent: () => SessionMeta | undefined,
  source: BgTaskSource,
  isRunning: () => boolean
): BgTaskLaunchGuard {
  const assertCurrent = (): void => {
    if (!isRunning()) throw new Error('background task was cancelled before launch');
    const current = captureBgTaskSource(config(), parent(), source.cwd);
    if (current.workspaceId !== source.workspaceId || current.sourceRoot.rootId !== source.sourceRoot.rootId
      || current.sourceRoot.physicalPath !== source.sourceRoot.physicalPath
      || pathKey(current.sourceRoot.path) !== pathKey(source.sourceRoot.path)
      || pathKey(current.sourceRoot.cwd) !== pathKey(source.sourceRoot.cwd)
      || current.cwdKey !== source.cwdKey || current.parent.cwd !== source.parent.cwd ||
      current.parent.worktreePath !== source.parent.worktreePath ||
      current.worktreeExecution?.gitDir !== source.worktreeExecution?.gitDir ||
      current.worktreeExecution?.branch !== source.worktreeExecution?.branch) {
      throw new Error('background task parent source changed; retry');
    }
  };
  return {
    assertCurrent,
    async prepare() {
      assertCurrent();
      const target = await resolveSessionTarget(config(), {
        workspaceId: source.workspaceId, rootId: source.sourceRoot.rootId,
        cwd: source.parent.cwd, capturedSource: source.sourceRoot
      }, source.parent);
      assertSessionTargetCurrent(config(), target);
      assertCurrent();
    }
  };
}
