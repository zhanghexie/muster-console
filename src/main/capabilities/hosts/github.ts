import path from 'node:path';
import { isConfirmed } from '../../../shared/confirmDialog';
import type { PrDiscussionEntry, PrFilter, PrRepoScope, PrSummary, PrVersion, SubmitPrReviewInput, CreatePrInput } from '../../../shared/githubPr';
import { t } from '../../../shared/i18n';
import { RESULT_MAX_CHARS } from '../../../shared/toolResultBudget';
import { defaultCwdFor } from '../../../shared/workspaceRoots';
import { currentAgentSessionId, currentAgentWorkspaceId, currentGuiExecutionTurn, isSchedulerInvocation } from '../../agent/agentScope';
import { isHeadlessTurn } from '../../agent/turnScope';
import type { AppContext } from '../../context';
import { GitHubPrError } from '../../git/githubHttp';
import type { GitHubCreateApproval, GitHubReviewApproval, GitHubWriteApproval } from '../../git/githubPrService';

type RepoArgs = { repoPath?: string };
type PageArgs = RepoArgs & { offset?: number };
type VersionArgs = PageArgs & { version: PrVersion };
type HandlerOptions = { signal?: AbortSignal; assertCurrent?: () => void; onConfirming?: () => void };

const PAGE_BUDGET = RESULT_MAX_CHARS - 2500;
// JSON escapes one UTF-16 code unit into at most six characters.
const TEXT_CHUNK = 1400;

function page<T>(rows: T[], offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid GitHub result offset.');
  const items: T[] = [];
  let size = 2;
  for (const row of rows.slice(offset)) {
    size += JSON.stringify(row).length + 1;
    if (size > PAGE_BUDGET) {
      if (!items.length) throw new Error('One GitHub result item exceeds the tool output budget.');
      break;
    }
    items.push(row);
  }
  const end = offset + items.length;
  return { items, nextOffset: end < rows.length ? end : null };
}

function textChunk(value: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid GitHub text offset.');
  let end = Math.min(offset + TEXT_CHUNK, value.length);
  if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end]!)) end--;
  return { text: value.slice(offset, end), nextOffset: end < value.length ? end : null };
}

function summary(pr: PrSummary): PrSummary {
  const { number, url, title, state, isDraft, headRefName, baseRefName, author, updatedAt, checks, reviewDecision, latestDiscussionAt } = pr;
  return { number, url, title, state, isDraft, headRefName, baseRefName, author, updatedAt, checks, reviewDecision, latestDiscussionAt };
}

function discussion(item: PrDiscussionEntry) {
  const body = item.body.slice(0, 1200);
  return { ...item, body, bodyTruncated: body.length < item.body.length };
}

function callerSession(ctx: AppContext, sessionId: string) {
  const parent = sessionId.startsWith('bg-')
    ? ctx.bgTasks?.taskParentPairs().find(task => task.id === sessionId.slice(3))?.parentSessionId : undefined;
  return ctx.sessions.get(parent ?? sessionId);
}

async function scoped<T>(ctx: AppContext, args: RepoArgs,
  run: (service: NonNullable<AppContext['githubPr']>, scope: PrRepoScope, assertActor: () => void) => Promise<T>): Promise<T> {
  const sessionId = currentAgentSessionId();
  const session = sessionId ? callerSession(ctx, sessionId) : undefined;
  const workspaceId = sessionId ? session?.workspaceId : isSchedulerInvocation() ? currentAgentWorkspaceId() : undefined;
  const workspace = ctx.workspaces.list().find(item => item.id === workspaceId);
  if (!workspace || (sessionId && (!session || session.archived))) throw new Error('GitHub requires a session bound to a workspace.');
  const lease = session ? ctx.sessions.sessionScopeToken(session.id) : undefined;
  const assertActor = () => {
    if (!sessionId) return;
    const current = callerSession(ctx, sessionId);
    if (!lease || !current || current.archived || current.workspaceId !== workspace.id ||
        ctx.sessions.sessionScopeToken(current.id) !== lease) {
      throw new GitHubPrError('changed', t('GitHub 操作已取消，请返回会话后重试'));
    }
  };
  assertActor();
  const service = ctx.githubPr;
  if (!service) throw new Error('GitHub is unavailable in this host.');
  const binding = { workspaceId: workspace.id, rootsRevision: workspace.rootsRevision ?? 0 };
  let repoPath = args.repoPath;
  try {
    if (repoPath === undefined) {
      repoPath = await ctx.git.withWorkspace(binding, () => ctx.git.checkoutForCwd(session?.cwd || defaultCwdFor(workspace)));
      if (!repoPath) {
        const { repos } = await ctx.git.listRepoLocations(false, workspace.id);
        if (repos.length === 1) repoPath = repos[0]!.path;
      }
    }
    if (!repoPath || !path.isAbsolute(repoPath)) throw new Error('Provide the absolute repoPath of a GitHub checkout in this workspace.');
    assertActor();
    return await run(service, { ...binding, repoPath }, assertActor);
  } catch (error) {
    if (error instanceof GitHubPrError && error.installUrl) {
      throw new GitHubPrError(error.kind, `${error.message}\n${error.installUrl}`, error.installUrl);
    }
    throw error;
  }
}

function approval<T>(ctx: AppContext, scope: PrRepoScope, assertActor: () => void, options: HandlerOptions | undefined, label: string,
  describe: (details: T) => string): GitHubWriteApproval<T> {
  const guiTurn = currentGuiExecutionTurn();
  const assertCurrent = () => {
    if (options?.signal?.aborted || guiTurn?.isCurrent() === false) {
      throw new GitHubPrError('changed', t('GitHub 操作已取消，请返回会话后重试'));
    }
    assertActor();
    options?.assertCurrent?.();
  };
  if (isHeadlessTurn()) throw new Error('GitHub writes require a user confirmation in an interactive session.');
  assertCurrent();
  return {
    assertCurrent,
    async confirm(details) {
      assertCurrent();
      options?.onConfirming?.();
      const answer = await ctx.ui.confirm(`GitHub · ${label}`, describe(details), {
        dangerous: true, subtitle: scope.repoPath, confirmLabel: label, cancelLabel: t('取消'), signal: options?.signal
      });
      if (!isConfirmed(answer)) throw new GitHubPrError('failed', t('用户未确认此次 GitHub 操作'));
      assertCurrent();
    }
  };
}

export const githubHost = {
  'github.repository': (ctx: AppContext, args: RepoArgs) => scoped(ctx, args, (service, scope) => service.repository(scope)),
  'github.list': (ctx: AppContext, args: PageArgs & { filter: PrFilter; cursor?: string }) => scoped(ctx, args, async (service, scope) => {
    const result = await service.list(scope, args.filter, args.cursor, false);
    const { items, nextOffset } = page(result.prs, args.offset);
    return { prs: items, nextOffset, nextCursor: result.cursor };
  }),
  'github.detail': (ctx: AppContext, args: PageArgs & { number: number; section?: 'overview' | 'body' | 'checks' | 'discussion' }) =>
    scoped(ctx, args, async (service, scope) => {
      const pr = await service.readReview(scope, args.number);
      const version = { repository: pr.repository, number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha };
      if (args.section === 'checks') return { version, ...page(pr.checkEntries, args.offset), sourceTruncated: pr.checksTruncated };
      if (args.section === 'discussion') return { version, ...page(pr.discussion.map(discussion), args.offset), sourceWindow: 'latest' };
      if (args.section === 'body') return { version, ...textChunk(pr.body, args.offset), sourceTruncated: pr.bodySourceTruncated };
      return { ...summary(pr), version, headRepository: pr.headRepository, body: pr.body.slice(0, 800),
        bodyTruncated: pr.body.length > 800, reviewThreads: pr.threads.length, moreReviewThreads: !!pr.threadCursor };
    }),
  'github.files': (ctx: AppContext, args: VersionArgs & { page?: number; filename?: string }) => scoped(ctx, args, async (service, scope) => {
    const filePage = args.page ?? 1;
    const { files, filesHaveMore } = await service.files(scope, args.version, filePage);
    const nextPage = filesHaveMore && filePage < 150 ? filePage + 1 : null;
    if (args.filename !== undefined) {
      const file = files.find(item => item.path === args.filename);
      if (!file) throw new Error('The file is not on this PR files page. Use the page where it was listed.');
      const { text, nextOffset } = textChunk(file.patch ?? '', args.offset);
      return { patch: file.patch === null ? null : text, nextOffset, sourceTruncated: file.truncated };
    }
    const { items, nextOffset } = page(files.map(({ patch, ...file }) => ({ ...file, patchAvailable: patch !== null })), args.offset);
    return { page: filePage, files: items, nextOffset, nextPage, sourceTruncated: filesHaveMore && nextPage === null };
  }),
  'github.threads': (ctx: AppContext, args: VersionArgs & { cursor?: string; threadId?: string }) => scoped(ctx, args, async (service, scope) => {
    if (args.threadId !== undefined) {
      const { comments, ...thread } = await service.readThread(scope, args.version, args.threadId);
      const { items, nextOffset } = page(comments.map(discussion), args.offset);
      return { thread, comments: items, nextOffset };
    }
    const { threads, threadCursor } = await service.threads(scope, args.version, args.cursor);
    const rows = threads.map(({ comments, ...thread }) => ({ ...thread, comments: comments.length }));
    const { items, nextOffset } = page(rows, args.offset);
    return { threads: items, nextOffset, nextCursor: threadCursor };
  }),
  'github.create': (ctx: AppContext, args: RepoArgs & Pick<CreatePrInput, 'branch' | 'base' | 'title'> &
    Partial<Pick<CreatePrInput, 'body' | 'draft'>>, options?: HandlerOptions) => scoped(ctx, args, (service, scope, assertActor) =>
    service.createFromAgent(scope, { ...args, body: args.body ?? '', draft: args.draft ?? false },
      approval<GitHubCreateApproval>(ctx, scope, assertActor, options, t('推送并创建 PR'), details => JSON.stringify(details, null, 2)))),
  'github.publish': (ctx: AppContext, args: RepoArgs & Pick<SubmitPrReviewInput, 'version' | 'event'> &
    Partial<Pick<SubmitPrReviewInput, 'body' | 'comments'>>, options?: HandlerOptions) => scoped(ctx, args, (service, scope, assertActor) =>
    service.publishFromAgent(scope, { ...args, body: args.body ?? '', comments: args.comments ?? [] },
      approval<GitHubReviewApproval>(ctx, scope, assertActor, options, t('发布评审'), details => JSON.stringify(details, null, 2))))
};
