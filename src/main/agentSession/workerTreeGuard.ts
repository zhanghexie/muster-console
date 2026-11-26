/**
 * P5/P11：GUI/CLI Worker 报 needs_you 或 requestIntegrate 时的宿主侧校验。
 * 自愈检查不回注；持续故障走编排事件；只回注 Worker 可行动的提醒。
 */
import path from 'node:path';
import fs from 'node:fs';
import type { AppContext } from '../context';
import {
  dirtyTreeAction,
  dirtyTreeRemindMessage,
  earlyNeedsYouWarning
} from '../../shared/workerStatusGuard';
import { fallbackCommitDirtyTree, listDirtyPaths } from '../git/workerDirtyGuard';
import { isIsolatedWorktreePath } from '../../shared/worktreePath';
import { usesTaskWorktreeLifecycle, sessionWorktreeGroups, validateSessionWorktreeGroups } from '../../shared/sessionWorktrees';
import { guardTaskWorktrees, type TaskWorkerSnapshotResult } from '../git/worktreeTaskWorker';
import type { IntegrateWorktreeGroup } from '../../shared/integrateRequest';
import { readGitDirectories } from '../git/repoIdentity';
import { pathKey } from '../pathKey';
import { taskWorktreeOwnership } from '../git/worktreeTaskOperation';
import { t } from '../../shared/i18n';
import { getOrchestratorEventPump } from '../orchestrator/events';
import { retryWorkerTreeRead, isTransientWorkerTreeError, type WorkerTreeRetryOptions } from './workerTreeRetry';

export type WorkerGuardResult = {
  warnings: string[];
  dirty: boolean;
  fallbackCommit?: boolean;
  fallbackError?: string;
  worktreeGroups?: IntegrateWorktreeGroup[];
  snapshots?: TaskWorkerSnapshotResult[];
  assertCurrent?: () => void;
};

function isolateCwd(ctx: AppContext, sessionId: string): string | undefined {
  const s = ctx.sessions.get(sessionId);
  const p = s?.worktreePath?.trim() || (s?.cwd && isIsolatedWorktreePath(s.cwd) ? s.cwd : '');
  return p || undefined;
}

async function dirtyPathsFor(ctx: AppContext, sessionId: string): Promise<string[]> {
  const session = ctx.sessions.get(sessionId);
  const groups = session && sessionWorktreeGroups(session);
  if (groups) validateSessionWorktreeGroups(groups);
  if (groups && (groups.cwdPolicy === 'source' || groups.groups.length > 1)) {
    const checked = await guardTaskWorktrees(ctx, session!, false);
    if (checked.failure) throw new Error(checked.failure);
    return checked.paths.map(file => {
      for (const group of groups.groups) {
        const prefix = `${group.sourceRoot!.rootId}/${group.id}/`;
        if (file.startsWith(prefix)) return `${path.basename(group.path)}/${file.slice(prefix.length)}`;
      }
      return file;
    });
  }
  const cwd = isolateCwd(ctx, sessionId);
  if (!cwd) return [];
  verifyLinkedTree(cwd, session?.worktreeBranch, session?.worktreeSource?.commonDir);
  for (const repo of session?.worktreeRepoSet ?? []) verifyLinkedTree(path.join(cwd, repo.path), repo.branch);
  const paths = await listDirtyPaths(cwd);
  for (const repo of ctx.sessions.get(sessionId)?.worktreeRepoSet ?? []) {
    paths.push(...(await listDirtyPaths(path.join(cwd, repo.path))).map((p) => repo.path + '/' + p));
  }
  return paths;
}

/** A lost legacy gitfile must never make Git walk up into the user's source checkout. */
function verifyLinkedTree(cwd: string, branch?: string, expectedCommon?: string): string {
  try {
    const dirs = readGitDirectories(cwd);
    if (!dirs || !fs.statSync(path.join(cwd, '.git')).isFile()) throw new Error();
    const physical = (folder: string) => pathKey(fs.realpathSync(folder));
    const tree = physical(cwd), privateDir = physical(dirs.gitDir), common = physical(dirs.commonDir);
    const relative = path.relative(path.join(common, 'worktrees'), privateDir);
    const back = path.resolve(privateDir, fs.readFileSync(path.join(privateDir, 'gitdir'), 'utf8').trim());
    const head = fs.readFileSync(path.join(privateDir, 'HEAD'), 'utf8').trim();
    if (privateDir === common || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      physical(path.dirname(back)) !== tree || path.basename(back) !== '.git' ||
      (expectedCommon && physical(expectedCommon) !== common) ||
      (branch ? head !== `ref: refs/heads/${branch}` : !head.startsWith('ref: refs/heads/'))) throw new Error();
    for (const dir of [privateDir, common]) {
      for (const marker of ['locked', 'index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        if (fs.existsSync(path.join(dir, marker))) throw new Error(`repository has an active Git operation: ${marker}`);
      }
    }
    return JSON.stringify({ tree, privateDir, common, head });
  } catch (error) {
    if (isTransientWorkerTreeError(error)) throw error;
    throw new Error(`git status cannot verify linked worktree identity: ${cwd}`);
  }
}

// Per-context, bounded notification state. Recovery clears the incident; repeated reports do not wake models.
const notices = new WeakMap<AppContext, Map<string, string>>();
function noticeState(ctx: AppContext): Map<string, string> {
  let state = notices.get(ctx);
  if (!state) { state = new Map(); notices.set(ctx, state); }
  return state;
}
function rememberNotice(ctx: AppContext, key: string, value: string): boolean {
  const state = noticeState(ctx);
  if (state.get(key) === value) return false;
  if (state.size >= 1000) state.delete(state.keys().next().value!);
  state.set(key, value); return true;
}
function nudgeGui(ctx: AppContext, sessionId: string, text: string): void {
  const host = ctx.agentSessions;
  if (!host?.injectHostNudge || !rememberNotice(ctx, `nudge:${sessionId}`, text)) return;
  void host.injectHostNudge(sessionId, text).then(result => {
    if (result?.ok === false && noticeState(ctx).get(`nudge:${sessionId}`) === text) noticeState(ctx).delete(`nudge:${sessionId}`);
  }).catch(error => {
    if (noticeState(ctx).get(`nudge:${sessionId}`) === text) noticeState(ctx).delete(`nudge:${sessionId}`);
    console.warn('[workerTreeGuard] nudge delivery failed', sessionId, error);
  });
}
function reportFailure(ctx: AppContext, sessionId: string, error: unknown): string {
  console.warn('[workerTreeGuard] check failed', sessionId, error);
  const transient = isTransientWorkerTreeError(error);
  const message = transient
    ? t('【宿主提示】任务仓仍被 Git 操作占用，自动重试后未恢复。请调度检查正在进行的操作，确认安全后再重试；不要直接删除锁文件。')
    : t('【宿主提示】无法完成任务仓检查或快照，交付检查未通过。请调度检查仓库状态和宿主诊断日志；已有提交会保留。');
  const session = ctx.sessions.get(sessionId);
  const pump = getOrchestratorEventPump();
  if (session?.workspaceId && pump && rememberNotice(ctx, `failure:${sessionId}`, transient ? 'busy' : 'failed')) {
    pump.enqueue({ kind: 'merge_blocked', workspaceId: session.workspaceId, sessionId,
      sessionName: session.name, detail: message, extraKey: 'worker-tree-guard', touchActivity: false });
  }
  return message;
}
function clearFailure(ctx: AppContext, sessionId: string): void {
  noticeState(ctx).delete(`failure:${sessionId}`);
}

export async function afterNeedsYouReported(
  ctx: AppContext,
  sessionId: string,
  reason?: string,
  retry?: WorkerTreeRetryOptions
): Promise<WorkerGuardResult> {
  const warnings: string[] = [];
  const started = ctx.agentSessions?.getTurnStartedAt(sessionId);
  const early = earlyNeedsYouWarning(
    started === undefined ? undefined : Date.now() - started,
    reason
  );
  if (early) warnings.push(early);

  let paths: string[];
  let multipleGroups = false;
  try {
    const session = ctx.sessions.get(sessionId);
    multipleGroups = !!session && usesTaskWorktreeLifecycle(session);
    paths = await retryWorkerTreeRead(() => dirtyPathsFor(ctx, sessionId), retry);
  } catch (error) {
    const message = reportFailure(ctx, sessionId, error);
    // A failed host check is not proof of dirt; retain conservative blocking, without a Worker turn.
    return { warnings: [message], dirty: true, fallbackError: message };
  }
  clearFailure(ctx, sessionId);
  const dirty = paths.length > 0;
  if (dirtyTreeAction(dirty, 'needs_you') === 'remind') {
    warnings.push(dirtyTreeRemindMessage(paths, multipleGroups));
  }
  if (warnings.length) nudgeGui(ctx, sessionId, warnings.join('\n\n'));
  else noticeState(ctx).delete(`nudge:${sessionId}`);
  return { warnings, dirty };
}

async function snapshotBeforeIntegrate(
  ctx: AppContext,
  sessionId: string
): Promise<WorkerGuardResult> {
  const warnings: string[] = [];
  try {
    const session = ctx.sessions.get(sessionId);
    const groups = session && sessionWorktreeGroups(session);
    if (groups) validateSessionWorktreeGroups(groups);
    if (groups && (groups.cwdPolicy === 'source' || groups.groups.length > 1)) {
      const result = await guardTaskWorktrees(ctx, session!, true);
      const facts = { worktreeGroups: result.worktreeGroups, snapshots: result.snapshots, assertCurrent: result.assertCurrent };
      if (result.failure) {
        const completed = result.snapshots.filter(repo => repo.committed).map(repo => `${repo.rootId}/${repo.groupId}/${repo.repo || '.'}`).join(', ');
        const error = result.failure + (completed ? `\n[host] P11 snapshots retained: ${completed}` : '');

        return { ...facts, warnings: [error], dirty: true, fallbackCommit: false, fallbackError: error };
      }
      if (result.committed) {
        const note = '【宿主 · P11】requestIntegrate 时全部任务仓的未提交改动已逐仓机械快照，提交标注 [host] P11。';
        warnings.push(note);
      }
      return { ...facts, warnings, dirty: result.paths.length > 0, ...(result.committed ? { fallbackCommit: true } : {}) };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { warnings: [message], dirty: true, fallbackCommit: false, fallbackError: message };
  }
  const cwd = isolateCwd(ctx, sessionId);
  if (!cwd) return { warnings, dirty: false };

  const owner = ctx.sessions.get(sessionId)!;
  const ownership = taskWorktreeOwnership(owner);
  const trees = [{ path: cwd, branch: owner.worktreeBranch, common: owner.worktreeSource?.commonDir },
    ...(owner.worktreeRepoSet ?? []).map(repo => ({ path: path.join(cwd, repo.path), branch: repo.branch, common: undefined }))];
  const identities = trees.map(tree => verifyLinkedTree(tree.path, tree.branch, tree.common));
  const assertCurrent = () => {
    const latest = ctx.sessions.get(sessionId);
    if (!latest || taskWorktreeOwnership(latest) !== ownership || isolateCwd(ctx, sessionId) !== cwd) throw new Error('worktree task ownership changed');
    for (let i = 0; i < trees.length; i++) {
      const tree = trees[i]!;
      if (verifyLinkedTree(tree.path, tree.branch, tree.common) !== identities[i]) throw new Error('worktree repository identity changed');
    }
  };
  const guards = { beforeWrite: async () => { assertCurrent(); }, afterCommit: async () => { assertCurrent(); } };

  const paths = await dirtyPathsFor(ctx, sessionId);
  const dirty = paths.length > 0;
  if (dirtyTreeAction(dirty, 'integrate') !== 'fallback-commit') {
    assertCurrent(); return { warnings, dirty, assertCurrent };
  }

  for (const repo of [...ctx.sessions.get(sessionId)?.worktreeRepoSet ?? []].sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
    const result = await fallbackCommitDirtyTree(path.join(cwd, repo.path), guards);
    if (!result.ok) {
      const error = repo.path + ': ' + result.message;

      return { warnings: [error], dirty: true, fallbackCommit: false, fallbackError: error };
    }
  }
  const result = await fallbackCommitDirtyTree(cwd, guards);
  if (result.ok) {
    const remaining = await dirtyPathsFor(ctx, sessionId);
    assertCurrent();
    if (remaining.length) {
      const error = `worktree remains dirty after host snapshot: ${remaining.join(', ')}`;

      return { warnings: [error], dirty: true, fallbackCommit: false, fallbackError: error };
    }
    const note =
      `【宿主 · P11】requestIntegrate 时树仍脏，已兜底提交并标注 [host] P11（${(result.paths ?? paths).join(', ')}）。` +
      '未改你的提交说明意图：这是机械快照，请在后续补规范 commit。';
    warnings.push(note);

    return { warnings, dirty: true, fallbackCommit: true, assertCurrent };
  }

  const fail =
    dirtyTreeRemindMessage(paths) +
    (result.message ? ` 兜底提交失败：${result.message}` : ' 兜底提交失败。');
  warnings.push(fail);

  return { warnings, dirty: true, fallbackCommit: false, fallbackError: result.message };
}

/** Retry only read-only preflight, never replay a snapshot that may already have committed. */
export async function beforeRequestIntegrate(
  ctx: AppContext, sessionId: string, retry?: WorkerTreeRetryOptions
): Promise<WorkerGuardResult> {
  try {
    await retryWorkerTreeRead(() => dirtyPathsFor(ctx, sessionId), retry);
    const result = await snapshotBeforeIntegrate(ctx, sessionId);
    if (result.fallbackError || result.fallbackCommit === false) {
      const message = reportFailure(ctx, sessionId, result.fallbackError || result.warnings.join('\n'));
      return { ...result, warnings: [message], fallbackError: message };
    }
    clearFailure(ctx, sessionId);
    noticeState(ctx).delete(`nudge:${sessionId}`);
    if (result.fallbackCommit) {
      result.warnings = [t('【宿主提示】任务仓的未提交改动已保存为宿主快照，请在交付说明中注明。')];
    }
    return result;
  } catch (error) {
    const message = reportFailure(ctx, sessionId, error);
    return { warnings: [message], dirty: true, fallbackCommit: false, fallbackError: message };
  }
}
