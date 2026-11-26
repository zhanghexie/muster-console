import { workspaceRootUsesFor } from '../workspaceRootUses';
import path from 'node:path';
import type { WorkspaceWorktreeGroupSelection } from '../../shared/types';
import { projectPrimaryWorktree, sessionWorktreeGroups } from '../../shared/sessionWorktrees';
import type { SessionWorktreeCtx } from './worktreeSessionOps';
import { resolveSessionTarget } from '../sessions/targets';
import { sourcePathKey } from '../workspacePaths';
import { captureWorktreeSelectionSources, assertWorktreeSelectionSources } from './worktreeSelectionSources';
import { createTaskWorktreeGroups } from './worktreeTaskCreate';
import { beginTaskWorktreeOperation, taskWorktreeOwnership } from './worktreeTaskOperation';
import { readGitDirectories } from './repoIdentity';
import { t } from '../../shared/i18n';

/** Add resources to a task, never relocate a running process or mutate its captured turn. */
export async function attachTaskWorktrees(ctx: SessionWorktreeCtx, sessionId: string,
  selections: WorkspaceWorktreeGroupSelection[], apply = false) {
  const session = ctx.findSession(sessionId);
  if (!session?.workspaceId || !session.cwd || session.archived || session.hidden || session.type !== 'terminal' || session.launchKind === 'shell') throw new Error('active persistent agent session required');
  if (!ctx.git) throw new Error('GitService unavailable');
  const previous = sessionWorktreeGroups(session);
  if (previous && (previous.cwdPolicy !== 'source' || previous.borrowedFrom)) throw new Error('only the owner of a source-cwd task may append worktrees');
  const captured = captureWorktreeSelectionSources(ctx.config.get(), { workspaceId: session.workspaceId,
    isolationGroups: selections.map(item => ({ ...item, repoSet: item.repoSet ?? [] })) });
  const fingerprint = taskWorktreeOwnership(session);
  const operation = beginTaskWorktreeOperation(ctx.config, sessionId, 'attach');
  const releases: Array<() => void> = [];
  const assertCurrent = () => {
    if (ctx.findSession(sessionId) !== session || session.archived || taskWorktreeOwnership(session) !== fingerprint) throw new Error('task worktree ownership changed');
    assertWorktreeSelectionSources(ctx.config.get(), session.workspaceId!, captured.selections, captured.sources);
  };
  let created: Awaited<ReturnType<typeof createTaskWorktreeGroups>> | undefined;
  let published = false;
  let installed: import('../../shared/types').SessionWorktreeGroups | undefined;
  try {
    // The creator captures all roots before its first await; planning also pins sources.
    assertCurrent();
    for (const selection of captured.selections) releases.push(workspaceRootUsesFor(ctx.config).acquire({
      workspaceId: session.workspaceId, rootId: selection.rootId, kind: 'launch', id: sessionId, sessionId, label: 'append task worktree'
    }));
    const target = await resolveSessionTarget(ctx.config.get(), { workspaceId: session.workspaceId, cwd: session.cwd, capturedSource: session.sourceRoot });
    const pending: WorkspaceWorktreeGroupSelection[] = [];
    const facts: Array<{ sourcePath: string; dirty: boolean | null; existing: boolean }> = [];
    const known = new Set((previous?.groups ?? []).flatMap(group => [group.source!.mainRepo,
      ...group.repos.map(repo => path.join(group.source!.mainRepo, repo.path))]).map(sourcePathKey));
    const held = new Set<string>();
    for (const selection of captured.selections) {
      assertCurrent();
      const source = captured.sources.find(root => root.rootId === selection.rootId)!;
      const sourcePath = path.resolve(source.path, selection.relativePath);
      const dirs = readGitDirectories(sourcePath);
      if (!dirs) throw new Error(`selected repository is unavailable: ${sourcePath}`);
      const members = new Set(['', ...(selection.repoSet ?? []).flatMap(member => member.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')))]);
      for (const member of members) {
        const memberDirs = readGitDirectories(path.join(sourcePath, member));
        if (!memberDirs) {
          if (!member || selection.repoSet?.includes(member)) throw new Error(`nested repository unavailable: ${member}`);
          continue;
        }
        const common = sourcePathKey(memberDirs.commonDir);
        if (!held.has(common)) { operation.holdRepository(common); held.add(common); }
      }
      const existing = known.has(sourcePathKey(sourcePath));
      facts.push({ sourcePath, dirty: await ctx.git.probeDirty(sourcePath), existing });
      if (existing && selection.repoSet?.length) throw new Error('追加嵌套成员请直接选择实际子仓，不重建已有容器');
      if (!existing) pending.push(selection);
    }
    assertCurrent();
    if (!apply || !pending.length) return { ok: true, created: false, facts, cwd: session.cwd,
      mappings: previous, activation: 'unchanged' };
    created = await createTaskWorktreeGroups({ config: ctx.config, git: ctx.git }, {
      target, sessionId, selections: pending, preserveCwd: true, provisionCommands: [],
      holdRepository(common) { if (!held.has(common)) { operation.holdRepository(common); held.add(common); } }
    });
    if (!created.ok) {
      if (created.residuals.length) ctx.notify.push({ workspaceId: session.workspaceId, sessionId, sessionName: session.name,
        toast: true, kind: 'error', text: t('追加 worktree 有遗留资源：{{detail}}', { detail: JSON.stringify(created.residuals) }) });
      return created;
    }
    assertCurrent(); created.assertCurrent();
    const next = previous ? { ...structuredClone(previous), revision: (previous.revision ?? 1) + 1,
      groups: [...structuredClone(previous.groups), ...created.state.groups],
      sourceRoots: [...new Map([...(previous.sourceRoots ?? []), ...(created.state.sourceRoots ?? [])].map(root => [root.rootId, root])).values()] } : created.state;
    installed = next; session.worktreeGroups = next;
    projectPrimaryWorktree(session);
    ctx.persist(); ctx.flushPersist?.(); published = true; ctx.broadcast();
    return { ok: true, created: true, cwd: session.cwd, facts, mappings: next, warnings: created.warnings,
      activation: 'next-connection', note: '原 cwd 不变；新目录将在下一次连接捕获中登记。CLI 需重拉/续作才更新启动目录权限，当前连接不要假定已获访问。追加未执行准备脚本，依赖需在任务树按需准备。' };
  } catch (error) {
    if (created?.ok && !published) {
      if (installed && (ctx.findSession(sessionId) !== session || session.worktreeGroups !== installed)) {
        ctx.notify.push({ workspaceId: session.workspaceId, sessionId, sessionName: session.name, toast: true, kind: 'error', text: t('追加期间所有权变化，已保留新建目录与分支供检查') });
        throw error;
      }
      if (installed) {
        session.worktreeGroups = previous;
        if (previous) projectPrimaryWorktree(session);
        else { delete session.worktreePath; delete session.worktreeSource; delete session.worktreeBranch; delete session.worktreeBaseBranch; delete session.worktreeRepoSet; }
        try { ctx.persist(); ctx.flushPersist?.(); }
        catch (saveError) {
          // Disk may still contain the installed mapping. Retain resources rather than deleting a referenced tree.
          session.worktreeGroups = installed; projectPrimaryWorktree(session);
          ctx.notify.push({ workspaceId: session.workspaceId, sessionId, sessionName: session.name, toast: true, kind: 'error',
            text: t('追加元数据保存失败，目录与分支已保留：{{resources}}；{{error}}', { resources: created.state.groups.map(group => `${group.path} (${group.branch})`).join('；'), error: String(saveError) }) });
          throw error;
        }
      }
      const residuals = await created.rollback();
      if (residuals.length) ctx.notify.push({ workspaceId: session.workspaceId, sessionId, sessionName: session.name,
        toast: true, kind: 'error', text: t('追加回滚保留资源：{{detail}}', { detail: JSON.stringify(residuals) }) });
    }
    throw error;
  } finally { for (const release of releases) release(); operation.release(); }
}
