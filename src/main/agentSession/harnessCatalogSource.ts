import fs from 'node:fs';
import type { HarnessPickerSource } from '../../shared/harnessPicker';
import type { AppConfig, SessionMeta } from '../../shared/types';
import { assertSessionTargetCurrent, legacySessionSourceRoot, legacySessionWorkspaceId, resolveSessionTarget, type SessionTarget, type SessionTargetInput } from '../sessions/targets';
import { sourcePathKey } from '../workspacePaths';

/** Read the original source for isolated sessions, including uniquely recoverable legacy rows. */
export function sessionModelSourceCwd(config: AppConfig, session: SessionMeta): string | undefined {
  return (session.sourceRoot ?? (Array.isArray(config.workspaces) ? legacySessionSourceRoot(config, session) : undefined))?.cwd;
}

export function resolveSessionModelSource(config: AppConfig, session: SessionMeta): Promise<SessionTarget> {
  const workspaceId = session.workspaceId || legacySessionWorkspaceId(config, session);
  const source = session.sourceRoot ?? legacySessionSourceRoot(config, session);
  if (!workspaceId || !source) throw new Error('会话缺少可确认的模型目录来源，请检查工作区源文件夹。');
  return resolveSessionTarget(config, { workspaceId, rootId: source.rootId, capturedSource: source });
}

export function resolveLaunchModelSource(config: AppConfig, source: SessionTargetInput): Promise<SessionTarget> {
  if (!source?.workspaceId || !source.rootId) throw new Error('请选择有效的工作区源文件夹。');
  return resolveSessionTarget(config, source);
}

export function modelCatalogScope(target: SessionTarget): HarnessPickerSource {
  return { workspaceId: target.workspaceId, rootId: target.sourceRoot.rootId, rootsRevision: target.rootsRevision, cwd: target.sourceRoot.cwd };
}

export function modelCatalogDirectory(cwd: string): string {
  const physical = fs.realpathSync.native(cwd);
  const stat = fs.statSync(physical);
  if (!stat.isDirectory()) throw new Error('模型目录的源文件夹已不可用。');
  return JSON.stringify([sourcePathKey(physical), stat.dev, stat.ino]);
}

export function assertModelCatalogSourceCurrent(config: AppConfig, target: SessionTarget, physicalCwd: string): void {
  assertSessionTargetCurrent(config, target);
  const revision = config.workspaces.find(workspace => workspace.id === target.workspaceId)?.rootsRevision ?? 0;
  if (revision !== target.rootsRevision || modelCatalogDirectory(target.sourceRoot.cwd) !== physicalCwd) throw new Error('模型目录来源已变化，请重新读取。');
}
