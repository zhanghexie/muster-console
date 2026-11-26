import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppContext } from '../context';
import { isPathInsideWorkspace } from '../git/scan';
import { captureWorktreeSelectionSources } from '../git/worktreeSelectionSources';
import { assertSessionTargetCurrent, type SessionTarget } from './targets';

/** Default to the cwd's own Git repository, never its nested repositories or other roots. */
export async function resolveDefaultIsolationGroup(ctx: AppContext, target: SessionTarget) {
  if (!ctx.git) throw new Error('隔离需要 Git 服务');
  const main = await ctx.git.resolveMainRepoFor(target.cwd, target.wsPath);
  assertSessionTargetCurrent(ctx.config.get(), target);
  if (!main) throw new Error('当前目录没有可确定的 Git 仓库；请使用 isolationGroups 明确选择隔离范围');
  const [physicalRoot, physicalMain, physicalCwd] = await Promise.all([
    fs.realpath(target.sourceRoot.path), fs.realpath(main), fs.realpath(target.sourceRoot.cwd)
  ]);
  assertSessionTargetCurrent(ctx.config.get(), target);
  if (!isPathInsideWorkspace(physicalMain, physicalRoot) || !isPathInsideWorkspace(physicalCwd, physicalMain)) {
    throw new Error('当前目录没有可确定的 Git 仓库；请使用 isolationGroups 明确选择隔离范围');
  }
  const relativePath = path.relative(physicalRoot, physicalMain).split(path.sep).join('/');
  return captureWorktreeSelectionSources(ctx.config.get(), { workspaceId: target.workspaceId,
    isolationGroups: [{ rootId: target.sourceRoot.rootId, relativePath, repoSet: [] }] });
}
