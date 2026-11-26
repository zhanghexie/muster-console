import { handle, invokeIpcChannel, type IpcHandler } from './handle';
import { GIT_SCOPED_METHODS, type GitOperationScope } from '../../shared/gitOperations';
import type { AppContext } from '../context';
import type { GitCheckoutRequest, GitAdoptHunkKey, GitDiscardMode } from '../../shared/types';
import { notifyAdoptAppliedForWorktree } from '../orchestrator/settleNotify';
import { t } from '../../shared/i18n';
import { localizeGitUserError } from '../../shared/gitUserErrors';

export function registerGitIpc(ctx: AppContext, syncGitWatches?: () => void): void {
  const repoHandle = <T extends IpcHandler>(channel: string, fn: T): void => {
    handle(channel, (event, ...args: never[]) => ctx.git.withWorkspace(ctx.git.currentOperationScope(),
      async () => {
        try { return await fn(event, ...args); }
        finally {
          if (['git:initRepo', 'git:worktreeAdd', 'git:worktreeRemove'].includes(channel)) {
            try { syncGitWatches?.(); } catch (error) { console.warn('[git] reflog watch synchronization failed', error); }
          }
        }
      }));
  };
  handle('git:invokeScoped', (_event, scope: GitOperationScope, method: string, args: unknown[]) => {
    if (!(GIT_SCOPED_METHODS as readonly string[]).includes(method) || !Array.isArray(args)) {
      throw new Error('invalid scoped Git operation');
    }
    return ctx.git.withWorkspace(scope, () => invokeIpcChannel(`git:${method}`, args));
  });
  handle('git:listRepos', (_e, forceRescan?: boolean, requestedPaths?: string[], workspaceId?: string) =>
    ctx.git.listRepos(!!forceRescan, Array.isArray(requestedPaths) ? requestedPaths : [], workspaceId)
  );
  handle('git:listReposDetailed', (_e, forceRescan?: boolean, requestedPaths?: string[], workspaceId?: string) =>
    ctx.git.listReposDetailed(!!forceRescan, Array.isArray(requestedPaths) ? requestedPaths : [], workspaceId)
  );
  handle('git:listRepoLocations', (_e, forceRescan?: boolean, workspaceId?: string, requestedPaths?: string[]) =>
    ctx.git.listRepoLocations(!!forceRescan, workspaceId, Array.isArray(requestedPaths) ? requestedPaths : [])
  );
  repoHandle('git:status', (_e, repoPath: string) => ctx.git.status(repoPath));
  repoHandle('git:repoSummaries', (_e, repoPaths: string[]) => ctx.git.repoSummaries(repoPaths));
  repoHandle('git:log', (_e, repoPath: string, skip?: number, limit?: number, ref?: string) =>
    ctx.git.log(repoPath, skip ?? 0, limit ?? 80, ref)
  );
  repoHandle(
    'git:diff',
    (_e, repoPath: string, filePath: string, staged?: boolean, untracked?: boolean) =>
      ctx.git.diff(repoPath, filePath, !!staged, untracked)
  );
  repoHandle('git:commitFiles', (_e, repoPath: string, sha: string) =>
    ctx.git.commitFiles(repoPath, sha)
  );
  repoHandle('git:commitDiff', (_e, repoPath: string, sha: string, filePath: string) =>
    ctx.git.commitDiff(repoPath, sha, filePath)
  );
  repoHandle('git:stage', (_e, repoPath: string, paths: string[]) =>
    ctx.git.stage(repoPath, paths)
  );
  repoHandle('git:unstage', (_e, repoPath: string, paths: string[]) =>
    ctx.git.unstage(repoPath, paths)
  );
  repoHandle('git:discard', (_e, repoPath: string, paths: string[], mode?: GitDiscardMode) =>
    ctx.git.discard(repoPath, paths, mode)
  );
  repoHandle('git:stageAll', (_e, repoPath: string) => ctx.git.stageAll(repoPath));
  repoHandle('git:commit', (_e, repoPath: string, message: string) =>
    ctx.git.commit(repoPath, message)
  );
  repoHandle('git:fetch', (_e, repoPath: string) => ctx.git.fetch(repoPath));
  repoHandle('git:pull', (_e, repoPath: string) => ctx.git.pull(repoPath));
  repoHandle('git:push', (_e, repoPath: string) => ctx.git.push(repoPath));
  // 开 PR 专用：worktree 分支无 upstream，需 -u origin <branch> 才能建 PR
  repoHandle('git:pushBranch', (_e, repoPath: string, branch: string) =>
    ctx.git.pushBranch(repoPath, branch)
  );
  repoHandle('git:initRepo', (_e, dirPath?: string) => ctx.git.initRepo(dirPath));
  repoHandle('git:workspaceRoot', () => ctx.git.workspaceRoot());
  repoHandle('git:listBranches', (_e, repoPath: string) => ctx.git.listBranches(repoPath));
  repoHandle('git:checkout', (_e, repoPath: string, req: GitCheckoutRequest) =>
    ctx.git.checkout(repoPath, req)
  );
  // ---------- Worktree（P3.5）----------
  repoHandle('git:worktreeList', (_e, repoPath: string) => ctx.git.worktreeList(repoPath));
  repoHandle(
    'git:worktreeAdd',
    (
      _e,
      repoPath: string,
      args: { dirName: string; newBranch?: string; branch?: string; baseRef?: string }
    ) => {
      const a = args ?? { dirName: '' };
      // 空 dirName 会把树建在 .worktrees 根本身，直接拒绝
      if (!a.dirName?.trim()) {
        return Promise.resolve({ ok: false, message: t('缺少 worktree 目录名（dirName）') });
      }
      return ctx.git.worktreeAdd(repoPath, a).then(result => !result.ok && result.message
        ? { ...result, message: localizeGitUserError(result.message) } : result);
    }
  );
  repoHandle('git:worktreeRemove', (_e, worktreePath: string, force?: boolean) =>
    ctx.git.worktreeRemove(worktreePath, { force: !!force })
  );
  // ---------- Hunk 级原子采纳（T5.5）----------
  repoHandle('git:adoptPreview', (_e, worktreePath: string) =>
    ctx.git.adoptPreview(worktreePath)
  );
  repoHandle(
    'git:adoptHunks',
    async (_e, worktreePath: string, keys: GitAdoptHunkKey[]) => {
      const res = await ctx.git.adoptHunks(worktreePath, Array.isArray(keys) ? keys : []);
      // R-19：部分采纳不触发任务收口——提醒调度人工核对（worktree 会话反查）
      if (res.ok) notifyAdoptAppliedForWorktree(ctx.sessions, worktreePath);
      return res;
    }
  );
}
