/**
 * 验收后合入隔离 worktree（2026-09-26 sessions.ts → git/ 拆分，行为保持）：
 * 单仓 mergeIsolate 与 R-18b 多仓组级合入（integrateRepoGroup）双路径 +
 * 成功共同收尾（结任务 done / 验收留痕 / 延时归档）。经 SessionIntegrateCtx
 * 回接 SessionsService 状态；错误文案、awareness 记账、归档延时逐字保持。
 */
import type {
  GitMergeIsolateResult,
  GitRepoIntegrateEntry,
  LiveStatus,
  MergeIsolateOptions,
  SessionMeta,
  SessionWorktreeGroupIntegrationResult,
  SessionPhase,
  SessionPhaseKind
} from '../../shared/types';
import { usesTaskWorktreeLifecycle, assertSingleWorktreeGroup, projectPrimaryWorktree, syncSingleWorktreeGroup } from '../../shared/sessionWorktrees';
import {
  buildIntegrateFailNotifyPush,
  integrateAutoAcceptanceNote,
  resolveIntegrateApproval,
  type IntegrateApproval
} from '../../shared/integrateApproval';
import type { ReviewDecision } from '../../shared/boardReview';
import type { RuntimeFact } from '../../shared/runtimeFacts';
import { t } from '../../shared/i18n';
import type { RuntimeAwarenessStore } from '../awareness/store';
import { integrateRepoGroup, nestedRepoMainPath, nestedWorktreePath } from './nestedRepos';
import { resolveSessionMainRepo, type SessionWorktreeCtx } from './worktreeSessionOps';
import { integrateTaskWorktrees } from './worktreeTaskIntegrate';

/** integrate 后留给用户看一眼「已完成」再自动归档的时间 */
export const INTEGRATE_ARCHIVE_DELAY_MS = 2_500;

/** integrate 入参（原 sessions.integrateWorktree 内联签名的具名化，结构逐字段一致） */
export type IntegrateWorktreeOpts = {
  targetBranch?: string;
  approval?: IntegrateApproval;
  confirmNote?: string;
  /** 人手动触发（确认门 / review）失败时弹桌面 toast；调度 auto 免批不传 */
  notifyUserOnFail?: boolean;
} & MergeIsolateOptions;

/** integrate 收尾额外回接的服务回调（setPhase/setArchived 等公开方法转发） */
export interface SessionIntegrateCtx extends SessionWorktreeCtx {
  isExecuting?(session: SessionMeta): boolean;
  awareness: RuntimeAwarenessStore | null;
  emitRuntimeFacts(facts: RuntimeFact[]): void;
  setPhase(
    id: string,
    phase: { value: SessionPhaseKind; source: SessionPhase['source']; ts?: number }
  ): SessionMeta;
  setLiveStatus(id: string, live: LiveStatus): SessionMeta;
  recordAcceptance(id: string, rec: { at: number; decision: ReviewDecision; note?: string }): SessionMeta;
  setArchived(id: string, archived: boolean): SessionMeta;
  archiveReleaseThenCleanup(s: SessionMeta): Promise<void>;
}

/** 人手动合入失败：桌面 toast（调度 auto 免批走编排事件，不走这里） */
function notifyIntegrateFail(
  ctx: SessionIntegrateCtx,
  s: SessionMeta,
  reason: string,
  enabled?: boolean
): void {
  if (!enabled) return;
  try {
    ctx.notify.push(
      buildIntegrateFailNotifyPush({
        workspaceId: ctx.workspaceIdFor(s),
        sessionId: s.id,
        sessionName: s.name,
        reason
      })
    );
  } catch (err) {
    console.error('[sessions] integrate fail notify failed', err);
  }
}

/** approval=auto 时的验收账本备注输入（confirmNote） */
export function acceptanceNoteFor(
  opts: { approval?: IntegrateApproval; confirmNote?: string } & MergeIsolateOptions
): { acceptanceNote?: string } {
  return opts.confirmNote?.trim() ? { acceptanceNote: opts.confirmNote.trim() } : {};
}

/**
 * integrate 成功后的共同收尾：结任务 done、验收留痕、延时归档（归档清理逐仓拆树）
 */
function finishIntegrate(
  ctx: SessionIntegrateCtx,
  s: SessionMeta,
  result: {
    merged: boolean;
    cleanup: 'scheduled' | 'retained';
    approval: IntegrateApproval;
    message: string;
    warnings?: string[];
    gates?: GitMergeIsolateResult['gates'];
    repos?: GitRepoIntegrateEntry[];
    groups?: SessionWorktreeGroupIntegrationResult[];
    alreadyMerged?: boolean;
    target?: string;
    branch?: string;
    acceptanceNote?: string;
  }
): {
  merged: boolean;
  alreadyMerged?: boolean;
  target?: string;
  branch?: string;
  cleanup: 'scheduled' | 'retained';
  approval: IntegrateApproval;
  message: string;
  warnings?: string[];
  gates?: GitMergeIsolateResult['gates'];
  repos?: GitRepoIntegrateEntry[];
  groups?: SessionWorktreeGroupIntegrationResult[];
} {
  if (result.target) s.worktreeBaseBranch = result.target;
  for (const entry of result.repos ?? []) {
    if (!entry.target) continue;
    if (!entry.repo) s.worktreeBaseBranch = entry.target;
    else {
      const repo = s.worktreeRepoSet?.find((r) => r.path === entry.repo);
      if (repo) repo.baseBranch = entry.target;
    }
  }
  if (result.groups) {
    for (const outcome of result.groups) {
      const group = s.worktreeGroups!.groups.find(group => group.id === outcome.groupId)!;
      for (const entry of outcome.repos) {
        if (!entry.target) continue;
        if (!entry.repo) group.baseBranch = entry.target;
        else {
          const repo = group.repos.find(repo => repo.path === entry.repo);
          if (repo) repo.baseBranch = entry.target;
        }
      }
    }
    projectPrimaryWorktree(s);
  } else syncSingleWorktreeGroup(s);
  ctx.persist();
  const sessionId = s.id;
  ctx.setPhase(sessionId, { value: 'done', source: 'model' });
  ctx.setLiveStatus(s.id, { label: t('已完成'), kind: 'done', ts: Date.now() });
  ctx.recordAcceptance(s.id, {
    at: Date.now(),
    decision: 'passed',
    ...(result.approval === 'auto' && result.acceptanceNote
      ? { note: integrateAutoAcceptanceNote(result.acceptanceNote) }
      : {})
  });
  const completedPhase = ctx.findSession(sessionId)?.phase;
  if (result.cleanup === 'scheduled') setTimeout(() => {
    void (async () => {
      try {
        const cur = ctx.findSession(s.id);
        if (!cur) return;
        // 人手动先归档但清理因锁失败时：定时器再跑一遍拆链+删树（release 幂等）
        if (cur.archived) {
          if (cur.worktreePath) await ctx.archiveReleaseThenCleanup(cur);
          return;
        }
        if (cur.phase !== completedPhase || ctx.isExecuting?.(cur)) return;
        ctx.setArchived(sessionId, true);
      } catch (e) {
        console.error('[sessions] integrate 归档清理失败', s.id, e);
        ctx.notify.push({ workspaceId: ctx.workspaceIdFor(s), sessionId: s.id, sessionName: s.name,
          kind: 'error', toast: true, text: t('归档清理失败：{{error}}', { error: String(e) }) });
      }
    })();
  }, INTEGRATE_ARCHIVE_DELAY_MS);
  return {
    merged: result.merged,
    ...(result.alreadyMerged !== undefined ? { alreadyMerged: result.alreadyMerged } : {}),
    ...(result.target !== undefined ? { target: result.target } : {}),
    ...(result.branch !== undefined ? { branch: result.branch } : {}),
    cleanup: result.cleanup,
    approval: result.approval,
    ...(result.warnings ? { warnings: result.warnings } : {}),
    ...(result.gates ? { gates: result.gates } : {}),
    ...(result.repos ? { repos: result.repos } : {}),
    ...(result.groups ? { groups: result.groups } : {}),
    message: result.message
  };
}

/**
 * 验收后合入隔离 worktree：宿主在主仓 merge（Worker cwd 就是 worktree，删不了自己），
 * 再推迟归档——先把工具结果回给模型，再杀进程并删目录。
 * R-18b：多仓组（worktreeRepoSet 有值）走组级路径——零改动过滤 + 全或无预检 +
 * 嵌套先主仓后逐仓真合（详见 git/nestedRepos.ts integrateRepoGroup）。
 */
export async function integrateSessionWorktree(
  ctx: SessionIntegrateCtx,
  sessionId: string,
  opts?: IntegrateWorktreeOpts
): Promise<{
  merged: boolean;
  alreadyMerged?: boolean;
  target?: string;
  branch?: string;
  cleanup: 'scheduled' | 'retained';
  approval: IntegrateApproval;
  message: string;
  warnings?: string[];
  gates?: GitMergeIsolateResult['gates'];
  /** R-18b 多仓组逐仓清单（repo='' 为主仓） */
  repos?: GitRepoIntegrateEntry[];
  groups?: SessionWorktreeGroupIntegrationResult[];
}> {
  const s = ctx.findSession(sessionId);
  if (!s) throw new Error(t('会话不存在: {{id}}', { id: sessionId }));
  try {
    if (usesTaskWorktreeLifecycle(s)) {
      if (!ctx.git) throw new Error(t('GitService 不可用'));
      const task = await integrateTaskWorktrees(ctx, s, opts);
      const fact = ctx.awareness?.recordIntegrate({ ts: Date.now(), sessionId: s.id, workspaceId: s.workspaceId,
        ok: task.ok, message: task.message, branch: s.worktreeBranch });
      if (fact) ctx.emitRuntimeFacts([fact]);
      if (!task.ok) throw new Error(task.message);
      return finishIntegrate(ctx, s, { merged: true, cleanup: 'scheduled',
        approval: resolveIntegrateApproval(opts?.approval), ...(opts && acceptanceNoteFor(opts)),
        groups: task.groups, ...(task.warnings.length ? { warnings: task.warnings } : {}),
        message: t('{{message}}。本会话即将归档并安全清理 worktree；无法安全清理的内容会保留。', { message: task.message }) });
    }
    assertSingleWorktreeGroup(s);
  }
  catch (error) {
    notifyIntegrateFail(ctx, s, String(error), opts?.notifyUserOnFail);
    throw error;
  }
  if (!s.worktreePath || !s.worktreeBranch) {
    const msg = t(
      '本会话没有隔离 worktree。共享检出请在主仓自行合入；不要在当前目录 git worktree remove。'
    );
    notifyIntegrateFail(ctx, s, msg, opts?.notifyUserOnFail);
    throw new Error(msg);
  }
  if (!ctx.git) {
    const msg = t('GitService 不可用');
    notifyIntegrateFail(ctx, s, msg, opts?.notifyUserOnFail);
    throw new Error(msg);
  }

  if (!(await resolveSessionMainRepo(ctx, s))) throw new Error(t('无法确认 worktree 所属仓库，已保留：{{path}}', { path: s.worktreePath }));

  // R-18b 组级合入：零改动过滤 + 全或无预检 + 嵌套先主仓后逐仓真合
  if (s.worktreeRepoSet?.length) {
    const mainRepo = await ctx.git.resolveMainRepoFor(s.worktreePath);
    if (!mainRepo) {
      const msg = t('找不到容器 {{path}} 对应的主仓库根', { path: s.worktreePath });
      notifyIntegrateFail(ctx, s, msg, opts?.notifyUserOnFail);
      throw new Error(msg);
    }
    const group = await integrateRepoGroup({
      mainRepo,
      containerRoot: s.worktreePath,
      mainBranch: s.worktreeBranch,
      ...(s.worktreeBaseBranch ? { mainBaseBranch: s.worktreeBaseBranch } : {}),
      repos: s.worktreeRepoSet,
      merge: {
        ...(opts?.targetBranch?.trim() ? { targetBranch: opts.targetBranch.trim() } : {}),
        ...(opts?.message?.trim() ? { message: opts.message.trim() } : {}),
        noFf: opts?.noFf,
        stashMain: opts?.stashMain,
        skipNpmInstall: opts?.skipNpmInstall,
        skipTypecheck: opts?.skipTypecheck,
        onGateFail: opts?.onGateFail
      }
    });
    ctx.git.invalidateRepoCaches([
      mainRepo,
      s.worktreePath,
      ...s.worktreeRepoSet.map((r) => nestedRepoMainPath(mainRepo, r.path)),
      ...s.worktreeRepoSet.map((r) => nestedWorktreePath(s.worktreePath!, r.path))
    ]);
    if (!group.ok) {
      const fail = ctx.awareness?.recordIntegrate({
        ts: Date.now(),
        sessionId: s.id,
        workspaceId: s.workspaceId,
        ok: false,
        message: group.message,
        branch: s.worktreeBranch
      });
      if (fail) ctx.emitRuntimeFacts([fail]);
      notifyIntegrateFail(ctx, s, group.message, opts?.notifyUserOnFail);
      throw new Error(group.message);
    }
    const okFact = ctx.awareness?.recordIntegrate({
      ts: Date.now(),
      sessionId: s.id,
      workspaceId: s.workspaceId,
      ok: true,
      message: group.message,
      branch: s.worktreeBranch
    });
    if (okFact) ctx.emitRuntimeFacts([okFact]);
    return finishIntegrate(ctx, s, {
      merged: true,
      cleanup: 'scheduled',
      approval: resolveIntegrateApproval(opts?.approval),
      ...(opts && acceptanceNoteFor(opts)),
      repos: group.entries,
      message: t('{{message}}。本会话即将结束并删除 worktree，不要再改文件。', {
        message: group.message
      })
    });
  }

  const merge = await ctx.git.mergeIsolateBranch(s.worktreePath, s.worktreeBranch, {
    targetBranch: opts?.targetBranch,
    // R-18 从哪建回哪：缺省 target 用建树记录的 base（显式 targetBranch 仍优先；旧会话无记录回落默认分支）
    baseBranch: s.worktreeBaseBranch,
    message: opts?.message,
    noFf: opts?.noFf,
    stashMain: opts?.stashMain,
    skipNpmInstall: opts?.skipNpmInstall,
    skipTypecheck: opts?.skipTypecheck,
    onGateFail: opts?.onGateFail
  });
  if (!merge.ok) {
    const fail = ctx.awareness?.recordIntegrate({
      ts: Date.now(),
      sessionId: s.id,
      workspaceId: s.workspaceId,
      ok: false,
      message: merge.message,
      target: merge.target,
      branch: merge.branch
    });
    if (fail) ctx.emitRuntimeFacts([fail]);
    notifyIntegrateFail(ctx, s, merge.message, opts?.notifyUserOnFail);
    throw new Error(merge.message);
  }
  const okFact = ctx.awareness?.recordIntegrate({
    ts: Date.now(),
    sessionId: s.id,
    workspaceId: s.workspaceId,
    ok: true,
    message: merge.message,
    target: merge.target,
    branch: merge.branch,
    alreadyMerged: merge.alreadyMerged
  });
  if (okFact) ctx.emitRuntimeFacts([okFact]);
  return finishIntegrate(ctx, s, {
    merged: true,
    alreadyMerged: merge.alreadyMerged,
    target: merge.target,
    branch: merge.branch,
    cleanup: 'scheduled',
    approval: resolveIntegrateApproval(opts?.approval),
    ...(opts && acceptanceNoteFor(opts)),
    ...(merge.warnings ? { warnings: merge.warnings } : {}),
    ...(merge.gates ? { gates: merge.gates } : {}),
    message: t('{{message}}。本会话即将结束并删除 worktree，不要再改文件。', {
      message: merge.message
    })
  });
}
