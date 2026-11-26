/**
 * 会话 worktree 收尾/自愈/丢弃（2026-09-26 sessions.ts → git/ 拆分，行为保持）：
 * 归档/删除两条路径共用的树清理（嵌套组逐仓先拆——Windows 目录锁序）、
 * 丢失自愈回退、「放弃改动并清理」。经 SessionWorktreeCtx 回接 SessionsService 状态，
 * 通知文案 / updateKey / 重试节奏逐字保持（通知中心合同见 docs/features/isolate-worktree.md）。
 */
import fs from 'node:fs';
import { pathKey } from '../pathKey';
import { readGitDirectories } from './repoIdentity';
import type { SessionMeta } from '../../shared/types';
import { formatNotifyText } from '../../shared/types';
import { usesTaskWorktreeLifecycle, assertSingleWorktreeGroup, clearSessionWorktreeMetadata, sessionWorktreeGroups } from '../../shared/sessionWorktrees';
import { cleanupTaskWorktrees } from './worktreeTaskCleanup';
import { assertTaskWorktreeOperationIdle } from './worktreeTaskOperation';
import { t } from '../../shared/i18n';
import type { ConfigManager } from '../config';
import type { NotifyStore } from '../notify/store';
import { sleep } from '../pty/submit';
import type { GitService } from './service';
import { cleanupNestedWorktree, nestedRepoMainPath, nestedWorktreePath, pruneNestedWorktrees, sortNestedPaths } from './nestedRepos';

/** 归档时等 Windows 释放 worktree 目录锁的重试节奏（首次立即试） */
export const WORKTREE_RELEASE_DELAYS_MS = [0, 600, 1600, 3200];

/** R-18b 逐仓收尾的保留原因描述（通知文案用） */
export function describeNestedKeep(
  kept: 'dirty' | 'unmerged' | 'error',
  detail?: string
): string {
  if (kept === 'unmerged') return t('分支未合入');
  if (kept === 'dirty') return detail ?? t('有未提交改动');
  return t('清理失败：{{reason}}', { reason: detail ?? t('未知') });
}

/** worktree 收尾函数回接 SessionsService 状态的窄接口（方法由服务绑定 this 转发） */
export interface SessionWorktreeCtx {
  git: GitService | undefined;
  config: ConfigManager;
  notify: NotifyStore;
  workspaceIdFor(s: SessionMeta): string;
  resolveWorkspaceId(cwd?: string): string;
  persist(): void;
  flushPersist?(): void;
  broadcast(): void;
  findSession(id: string): SessionMeta | undefined;
  sessions?(): SessionMeta[];
}

/**
 * worktree 回收尝试（归档/删除共用）：等 Windows 释放目录锁，干净才删。
 * removed=false 且 lastFail 为空 = 已被并发清理（如「放弃并清理」抢先完成）。
 */
export async function tryRemoveSessionWorktree(
  ctx: SessionWorktreeCtx,
  s: SessionMeta
): Promise<{ removed: boolean; dirty: boolean; lastFail: string }> {
  let lastFail = '';
  let dirty = false;
  if (!ctx.git || !s.worktreePath) return { removed: false, dirty: false, lastFail: '' };
  for (const ms of WORKTREE_RELEASE_DELAYS_MS) {
    if (ms) await sleep(ms);
    if (!s.worktreePath) return { removed: false, dirty: false, lastFail: '' };
    dirty = await ctx.git.isWorktreeDirty(s.worktreePath);
    if (dirty) {
      lastFail = 'dirty';
      break;
    }
    const res = await ctx.git.worktreeRemove(s.worktreePath);
    if (res.ok) return { removed: true, dirty: false, lastFail: '' };
    lastFail = res.message ?? 'remove failed';
    if (lastFail === t('worktree 有被 Git 忽略的文件，已保留')) { dirty = true; break; }
  }
  return { removed: false, dirty, lastFail };
}

export function clearSessionWorktreeFields(ctx: SessionWorktreeCtx, s: SessionMeta): void {
  assertSingleWorktreeGroup(s);
  clearSessionWorktreeMetadata(s);
  if (s.meta) delete s.meta.orphanWorktree;
  ctx.persist();
  ctx.broadcast();
}

/** worktree 事件通知（通知中心 + toast；worktree 遗留需要人处置） */
export function pushWorktreeNotify(
  ctx: SessionWorktreeCtx,
  s: SessionMeta,
  label: string,
  text: string,
  key: string
): void {
  ctx.notify.push({
    workspaceId: ctx.workspaceIdFor(s),
    sessionId: s.id,
    sessionName: s.name,
    label,
    text: formatNotifyText(s.name, text),
    update: true,
    updateKey: key,
    // worktree 遗留需要人处置
    toast: true
  });
}

/**
 * R-18b 多仓组逐仓收尾（归档/删除共用）：嵌套树逐仓 remove（先于容器根——
 * Windows 目录锁：嵌套树在容器内，直接删根会连目录一起删但留下悬空注册）。
 * 树脏/未合入（对该仓 base）→ 保留该仓树。返回保留清单（空=全部嵌套树已拆）。
 */
export async function resolveSessionMainRepo(ctx: SessionWorktreeCtx, s: SessionMeta): Promise<string | null> {
  if (!ctx.git || !s.worktreePath) return null;
  const main = await ctx.git.resolveMainRepoFor(s.worktreePath);
  if (!main) return null;
  if (s.worktreeBranch && (await ctx.git.readHeadBranch(s.worktreePath)) !== s.worktreeBranch) return null;
  if (s.worktreeSource) {
    const dirs = readGitDirectories(main);
    if (!dirs || pathKey(dirs.commonDir) !== pathKey(s.worktreeSource.commonDir)) return null;
  }
  return main;
}

export async function cleanupNestedRepoSet(
  ctx: SessionWorktreeCtx,
  s: SessionMeta
): Promise<Array<{ repo: string; kept: 'dirty' | 'unmerged' | 'error'; message?: string }>> {
  if (!ctx.git || !s.worktreePath || !s.worktreeRepoSet?.length) return [];
  const mainRepo = await resolveSessionMainRepo(ctx, s);
  if (!mainRepo) return [{ repo: '', kept: 'error', message: t('无法确认 worktree 所属仓库，已保留：{{path}}', { path: s.worktreePath }) }];
  const kept: Array<{ repo: string; kept: 'dirty' | 'unmerged' | 'error'; message?: string }> = [];
  const repos = sortNestedPaths(s.worktreeRepoSet, true);
  // Preflight every nested repo before any parent tree can be removed.
  for (const r of repos) {
    const res = await cleanupNestedWorktree({ mainRepo, repo: r.path, containerRoot: s.worktreePath,
      branch: r.branch, baseBranch: r.baseBranch, checkOnly: true,
      ownedChildren: repos.filter(child => child.path.startsWith(`${r.path}/`)).map(child => nestedWorktreePath(s.worktreePath!, child.path)) });
    if (!res.removed && !res.safeToRemove) kept.push({ repo: r.path, kept: res.kept ?? 'error', message: res.message });
  }
  if (kept.length) return kept;
  for (const r of repos) {
    const res = await cleanupNestedWorktree({
      mainRepo,
      repo: r.path,
      containerRoot: s.worktreePath,
      branch: r.branch,
      ...(r.baseBranch ? { baseBranch: r.baseBranch } : {})
    });
    if (res.removed) {
      if (res.message) pushWorktreeNotify(ctx, s, t('遗留 worktree'), `${r.path}：${res.message}`, `worktree-branch:${s.id}:${r.path}`);
      continue;
    }
    kept.push({ repo: r.path, kept: res.kept ?? 'error', ...(res.message ? { message: res.message } : {}) });
    break; // A failed child removal must never be followed by removing its parent.
  }
  ctx.git.invalidateRepoCaches([
    mainRepo,
    ...s.worktreeRepoSet.map((r) => nestedRepoMainPath(mainRepo, r.path))
  ]);
  return kept;
}

/**
 * 归档时的 worktree 清理：分支有未合入提交 → 整树保留打「未合入」徽标；
 * 否则干净才删（删后顺手删已合入分支），脏/锁失败打遗留徽标。
 */
export async function cleanupSessionWorktreeOnArchive(ctx: SessionWorktreeCtx, s: SessionMeta): Promise<void> {
  if (usesTaskWorktreeLifecycle(s)) { await cleanupTaskWorktrees(ctx, s, 'archive'); return; }
  if (blockUnsupportedGroups(ctx, s)) return;
  if (!ctx.git || !s.worktreePath) return;
  const branch = s.worktreeBranch;
  const mainRepo = await resolveSessionMainRepo(ctx, s);
  // 「干净」不能只看未提交改动：已提交未合入的树删掉后，工作就只剩 ao/* 分支可挖且用户无从得知
  if (branch && mainRepo && !(await ctx.git.isBranchMergedIntoDefault(mainRepo, branch, s.worktreeBaseBranch))) {
    s.meta = { ...(s.meta ?? {}), orphanWorktree: 'unmerged' };
    ctx.persist();
    ctx.broadcast();
    pushWorktreeNotify(
      ctx,
      s,
      t('遗留 worktree'),
      t('分支 {{branch}} 有未合入提交，worktree 已保留（回主仓 git merge {{branch}} 可取回；归档卡片右键可放弃并清理）', { branch }),
      `worktree:${s.id}`
    );
    return;
  }
  if (!mainRepo || await ctx.git.isWorktreeDirty(s.worktreePath)) {
    s.meta = { ...(s.meta ?? {}), orphanWorktree: mainRepo ? 'dirty' : 'locked' };
    ctx.persist(); ctx.broadcast();
    pushWorktreeNotify(ctx, s, t('遗留 worktree'), t('worktree 有未提交改动或所属仓库无法确认，整组已保留：{{path}}', { path: s.worktreePath }), `worktree:${s.id}`);
    return;
  }
  // R-18b：先逐仓拆嵌套树（Windows 锁序：嵌套先、容器根后）；
  // 任一嵌套树保留 → 容器根必须一起保留（保留树目录在容器内，强删根会留悬空注册）
  const keptNested = await cleanupNestedRepoSet(ctx, s);
  if (keptNested.length) {
    const badge = keptNested.some((k) => k.kept === 'unmerged')
      ? 'unmerged'
      : keptNested.some((k) => k.kept === 'dirty')
        ? 'dirty'
        : 'locked';
    s.meta = { ...(s.meta ?? {}), orphanWorktree: badge };
    ctx.persist();
    ctx.broadcast();
    pushWorktreeNotify(
      ctx,
      s,
      t('遗留 worktree'),
      t(
        '多仓组部分嵌套仓未收尾，容器已保留：{{detail}}。各仓 ao/* 分支仍在，可回对应仓合入；归档卡片右键可放弃并清理',
        { detail: keptNested.map((k) => `${k.repo}（${describeNestedKeep(k.kept, k.message)}）`).join('；') }
      ),
      `worktree:${s.id}`
    );
    return;
  }
  const { removed, dirty, lastFail } = await tryRemoveSessionWorktree(ctx, s);
  if (!removed) {
    if (!lastFail) return; // 已被并发清理
    s.meta = { ...(s.meta ?? {}), orphanWorktree: dirty ? 'dirty' : 'locked' };
    ctx.persist();
    ctx.broadcast();
    pushWorktreeNotify(
      ctx,
      s,
      t('遗留 worktree'),
      dirty && lastFail !== t('worktree 有被 Git 忽略的文件，已保留')
        ? t('worktree 有未提交改动，已保留（归档卡片右键可放弃并清理）')
        : t('worktree 删除失败，已保留（{{error}}）', { error: lastFail }),
      `worktree:${s.id}`
    );
    return;
  }
  if (mainRepo && branch) {
    await settleBranchAfterRemove(ctx, s, mainRepo, branch, `worktree:${s.id}`);
  }
  clearSessionWorktreeFields(ctx, s);
}

/** 删除会话时的 worktree 收尾：会话行已移除、徽标无处挂——保留物一律走通知中心 */
export async function cleanupSessionWorktreeOnClose(ctx: SessionWorktreeCtx, s: SessionMeta): Promise<boolean> {
  if (usesTaskWorktreeLifecycle(s)) return (await cleanupTaskWorktrees(ctx, s, 'close')).ok;
  if (blockUnsupportedGroups(ctx, s)) return false;
  if (!s.worktreePath) return true;
  if (!ctx.git) return false;
  if (!(await resolveSessionMainRepo(ctx, s)) || await ctx.git.isWorktreeDirty(s.worktreePath)) {
    const message = t('worktree 有未提交改动或所属仓库无法确认，整组已保留：{{path}}', { path: s.worktreePath });
    s.meta = { ...s.meta, worktreeCleanupIssue: message };
    ctx.persist(); ctx.broadcast();
    pushWorktreeNotify(ctx, s, t('遗留 worktree'), message, `worktree-close:${s.id}`);
    return false;
  }
  // R-18b：先逐仓拆嵌套树；任一保留 → 容器根同样保留（保留树在容器内），只走通知
  const keptNested = await cleanupNestedRepoSet(ctx, s);
  if (keptNested.length) {
    const message = t('多仓组部分嵌套仓未收尾，容器已保留 {{path}}：{{detail}}', {
      path: s.worktreePath,
      detail: keptNested.map((k) => `${k.repo}（${describeNestedKeep(k.kept, k.message)}）`).join('；')
    });
    s.meta = { ...s.meta, worktreeCleanupIssue: message };
    ctx.persist(); ctx.broadcast();
    pushWorktreeNotify(
      ctx,
      s,
      t('遗留 worktree'),
      message,
      `worktree-close:${s.id}`
    );
    return false;
  }
  const branch = s.worktreeBranch;
  const mainRepo = await resolveSessionMainRepo(ctx, s);
  // 干净树的全部工作都已落在分支上，删树无损；脏树保留目录并告知位置
  const { removed, dirty, lastFail } = await tryRemoveSessionWorktree(ctx, s);
  if (!removed) {
    if (!lastFail) return false;
    const message = dirty
      ? t('隔离 worktree 有未提交改动，已保留：{{path}}（分支 {{branch}} 同时保留）', { path: s.worktreePath, branch: branch ?? t('无') })
      : t('隔离 worktree 删除失败，已保留：{{path}}（{{error}}）', { path: s.worktreePath, error: lastFail });
    s.meta = { ...s.meta, worktreeCleanupIssue: message };
    ctx.persist(); ctx.broadcast();
    pushWorktreeNotify(
      ctx,
      s,
      t('遗留 worktree'),
      message,
      `worktree-close:${s.id}`
    );
    return false;
  }
  if (mainRepo && branch) {
    await settleBranchAfterRemove(ctx, s, mainRepo, branch, `worktree-close:${s.id}`);
  }
  return true;
}

/** 删树成功后的分支收尾（归档/删除共用）：删已合入分支；未合入则通知保留 */
async function settleBranchAfterRemove(
  ctx: SessionWorktreeCtx,
  s: SessionMeta,
  mainRepo: string,
  branch: string,
  updateKey: string
): Promise<void> {
  if (!ctx.git) return;
  const del = await ctx.git.deleteMergedBranch(mainRepo, branch, s.worktreeBaseBranch);
  if (!del.ok) {
    pushWorktreeNotify(
      ctx,
      s,
      t('遗留 worktree'),
      del.unmerged
        ? t('分支 {{branch}} 有未合入提交，已保留（回主仓 git merge {{branch}} 可取回）', { branch })
        : t('分支 {{branch}} 未删（{{reason}}）', { branch, reason: del.message ?? '' }),
      updateKey
    );
  }
}

/** Report lost task checkouts before a Worker can resume. */
export function healMissingSessionWorktree(ctx: SessionWorktreeCtx, s: SessionMeta): void {
  if (usesTaskWorktreeLifecycle(s)) {
    assertTaskWorktreeOperationIdle(ctx.config, s.id);
    const groups = sessionWorktreeGroups(s)!;
    const lost = groups.groups.flatMap(group => [{ folder: group.path, main: group.source!.mainRepo, branch: group.branch!, common: group.source!.commonDir },
      ...group.repos.map(repo => ({ folder: `${group.path}/${repo.path}`, main: nestedRepoMainPath(group.source!.mainRepo, repo.path), branch: repo.branch, common: undefined }))])
      .filter(item => {
        try {
          const tree = readGitDirectories(item.folder), source = readGitDirectories(item.main);
          if (!tree || !source) return true;
          const common = pathKey(fs.realpathSync(tree.commonDir));
          return common !== pathKey(fs.realpathSync(source.commonDir)) || (item.common && common !== pathKey(fs.realpathSync(item.common))) ||
            pathKey(fs.realpathSync(tree.gitDir)) === common || fs.readFileSync(`${tree.gitDir}/HEAD`, 'utf8').trim() !== `ref: refs/heads/${item.branch}`;
        } catch { return true; }
      }).map(item => item.folder);
    if (lost.length || groups.groups.some(group => group.cleanup?.some(entry => entry.treeRemoved))) {
      s.meta = { ...s.meta, orphanWorktree: 'locked' }; ctx.persist(); ctx.broadcast();
      const message = t('任务 worktree 不完整，已保留全部组记录。请先处理清理结果：{{paths}}', { paths: lost.join('、') || s.worktreePath || '' });
      pushWorktreeNotify(ctx, s, t('worktree 丢失'), message, `worktree-lost:${s.id}`);
      throw new Error(message);
    }
    return;
  }
  if (blockUnsupportedGroups(ctx, s)) return;
  if (!s.worktreePath || fs.existsSync(s.worktreePath)) return;
  if (s.runtime === 'codex' || s.runtime === 'codex-gui') {
    const message = t('任务 worktree 不完整，已保留全部组记录。请先处理清理结果：{{paths}}', { paths: s.worktreePath });
    pushWorktreeNotify(ctx, s, t('worktree 丢失'), message, `worktree-lost:${s.id}`);
    throw new Error(message);
  }
  if (!ctx.git) return;
  const cfg = ctx.config.get();
  const ws = cfg.workspaces.find(
    (w) => w.id === (s.workspaceId ?? ctx.resolveWorkspaceId(s.cwd))
  );
  const lost = s.worktreePath;
  const branch = s.worktreeBranch;
  const repoSet = s.worktreeRepoSet;
  const source = s.worktreeSource;
  const fallback = s.worktreeSource?.mainRepo && fs.existsSync(s.worktreeSource.mainRepo)
    ? s.worktreeSource.mainRepo : ws?.path || cfg.workspace;
  clearSessionWorktreeMetadata(s);
  s.cwd = fallback;
  ctx.persist();
  ctx.broadcast();
  // R-18b：容器根被外部删除时，嵌套仓的 worktree 注册会悬空——逐仓 prune 兜底
  if (repoSet?.length && source && pathKey(readGitDirectories(source.mainRepo)?.commonDir ?? '') === pathKey(source.commonDir)) {
    void (async () => {
      try {
        const mainRepo = await ctx.git!.resolveMainRepoFor(fallback);
        if (mainRepo) await pruneNestedWorktrees(mainRepo, repoSet.map((r) => r.path));
      } catch (e) {
        console.warn('[sessions] 嵌套仓 worktree prune 失败', s.id, e);
      }
    })();
  }
  pushWorktreeNotify(
    ctx,
    s,
    t('worktree 丢失'),
    t('隔离 worktree 目录已不存在：{{lost}}{{branchNote}}。会话已回退到 {{fallback}}', {
      lost,
      branchNote: branch ? t('（分支 {{branch}} 若未合入仍在）', { branch }) : '',
      fallback
    }),
    `worktree-lost:${s.id}`
  );
}

/** 「放弃改动并清理」：force 删除会话 worktree（调用方须先弹确认）；已合入的分支一并删，未合入保留并说明 */
export async function discardSessionWorktree(
  ctx: SessionWorktreeCtx,
  sessionId: string,
  opts?: { forceBranch?: boolean }
): Promise<{ ok: boolean; message?: string }> {
  const s = ctx.findSession(sessionId);
  if (!s) throw new Error(t('会话不存在: {{id}}', { id: sessionId }));
  if (usesTaskWorktreeLifecycle(s)) return cleanupTaskWorktrees(ctx, s, 'discard');
  assertSingleWorktreeGroup(s);
  if (!s.worktreePath) throw new Error(t('该会话没有 worktree'));
  if (!ctx.git) throw new Error(t('GitService 不可用'));
  const branch = s.worktreeBranch;
  const mainRepo = await resolveSessionMainRepo(ctx, s);
  if (!mainRepo) return { ok: false, message: t('无法确认 worktree 所属仓库，已保留：{{path}}', { path: s.worktreePath }) };
  // R-18b：先逐嵌套仓强拆（嵌套先、容器根后）；分支只删已合入、未合入保留说明
  const nestedNotes: string[] = [];
  if (s.worktreeRepoSet?.length && mainRepo) {
    for (const r of sortNestedPaths(s.worktreeRepoSet, true)) {
      const res = await cleanupNestedWorktree({
        mainRepo,
        repo: r.path,
        containerRoot: s.worktreePath,
        branch: r.branch,
        ...(r.baseBranch ? { baseBranch: r.baseBranch } : {}),
        force: true,
        forceBranch: opts?.forceBranch
      });
      if (res.message) nestedNotes.push(`${r.path}：${res.message}`);
      if (opts?.forceBranch && res.kept === 'error') {
        return { ok: false, message: t('{{repo}}：分支未能删除（{{reason}}）', { repo: r.path, reason: res.message ?? '' }) };
      }
      if (!res.removed) {
        return { ok: false, message: t('{{repo}}：树未能删除（{{reason}}）', { repo: r.path, reason: res.message ?? '' }) };
      }
    }
    // 全部子树拆除成功后清理原先已不存在的登记；子树失败不会走到这里。
    try {
      await pruneNestedWorktrees(mainRepo, s.worktreeRepoSet.map((r) => r.path));
    } catch (e) {
      console.error('[sessions] discard 嵌套 prune 失败', s.id, e);
    }
    ctx.git.invalidateRepoCaches([
      mainRepo,
      ...s.worktreeRepoSet.map((r) => nestedRepoMainPath(mainRepo, r.path))
    ]);
  }
  const res = await ctx.git.worktreeRemove(s.worktreePath, { force: true });
  if (res.ok) {
    let message = [res.message, ...nestedNotes].filter(Boolean).join('；') || undefined;
    if (mainRepo && branch) {
      const del = opts?.forceBranch
        ? await ctx.git.deleteBranchForce(mainRepo, branch)
        : await ctx.git.deleteMergedBranch(mainRepo, branch, s.worktreeBaseBranch);
      if (!del.ok && !del.unmerged) {
        message = [message, t('分支 {{branch}} 未删（{{reason}}）', { branch, reason: del.message ?? '' })].filter(Boolean).join('；');
      }
      if (opts?.forceBranch && !del.ok) {
        return { ok: false, message: message ?? t('分支 {{branch}} 未删（{{reason}}）', { branch, reason: del.message ?? '' }) };
      }
      if (!del.ok && del.unmerged) {
        message = `${message ? `${message}；` : ''}${t('分支 {{branch}} 有未合入提交，已保留（回主仓 git merge {{branch}} 可取回）', { branch })}`;
      }
    }
    clearSessionWorktreeMetadata(s);
    if (s.meta) delete s.meta.orphanWorktree;
    ctx.persist();
    ctx.broadcast();
    return { ok: true, ...(message ? { message } : {}) };
  }
  return res;
}

/** Keep every saved path until creation/integration/cleanup all support multiple groups. */
function blockUnsupportedGroups(ctx: SessionWorktreeCtx, s: SessionMeta): boolean {
  try { assertSingleWorktreeGroup(s); return false; }
  catch (error) {
    s.meta = { ...s.meta, orphanWorktree: 'locked' };
    ctx.persist(); ctx.broadcast();
    pushWorktreeNotify(ctx, s, t('遗留 worktree'), String(error), `worktree:${s.id}`);
    return true;
  }
}
