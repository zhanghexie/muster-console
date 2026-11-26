import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool } from '../../../src/main/agent/agentScope';
import { githubHost } from '../../../src/main/capabilities/hosts/github';
import { GitHubPrService } from '../../../src/main/git/githubPrService';
import type { GitHubAppAuth } from '../../../src/main/git/githubAppAuth';
import { reviewVersionKey, type AutoReviewTarget, type GitHubPrStorage } from '../../../src/main/git/githubPrStorage';
import { sendSessionMail } from '../../../src/main/messages/assignment';
import type { CreatePrInput, PrAiDraft, PrVersion } from '../../../src/shared/githubPr';

vi.mock('../../../src/main/git/githubPrReview', () => ({ generateGitHubPrReview: vi.fn() }));
vi.mock('../../../src/main/messages/assignment', () => ({ sendSessionMail: vi.fn() }));
vi.mock('../../../src/main/orchestrator/prMergedWatch', () => ({ notePrOpenSnapshot: vi.fn() }));

const scope = { workspaceId: 'workspace', rootsRevision: 2, repoPath: path.resolve('repos', 'worktree') };
const version: PrVersion = { repository: 'team/repo', number: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
const create: CreatePrInput = {
  branch: 'topic', title: 'Change a file', body: '', draft: true, repository: 'team/repo', pushRepository: 'developer/repo'
};

function fixture() {
  const trace: { url: string; body: unknown }[] = [];
  const push = vi.fn(async () => ({ ok: true }));
  const withWorkspace = vi.fn(async (candidate: typeof scope, callback: () => Promise<unknown>) => {
    if (candidate.workspaceId !== scope.workspaceId || candidate.rootsRevision !== scope.rootsRevision) {
      throw new Error('workspace repository scope changed');
    }
    return callback();
  });
  const context = { origin: 'git@github.com:developer/repo.git', pushUrl: 'git@github.com:developer/repo.git',
    head: version.headSha, worktree: true };
  const worker = { id: 'worker', type: 'terminal', name: 'Code Worker', workspaceId: scope.workspaceId,
    cwd: path.join(scope.repoPath, 'src'), worktreeGroups: {
    version: 1, primaryGroupId: 'task', groups: [{ id: 'task', path: scope.repoPath, branch: 'topic', repos: [] }]
  } };
  const confirm = vi.fn(async (_title: string, _details: string) => ({ confirmed: true }));
  const checkoutForCwd = vi.fn(async (_cwd: string) => scope.repoPath);
  let lease = {};
  const ctx = { git: { withWorkspace, checkoutForCwd, githubPrContext: async (repoPath: string) => {
    if (repoPath !== scope.repoPath) throw new Error('unregistered checkout in the caller workspace');
    return context;
  }, pushBranch: push },
  sessions: { listByWorkspace: () => [worker], get: (id: string) => id === worker.id ? worker : undefined,
    sessionScopeToken: (id: string) => id === worker.id ? lease : undefined },
  workspaces: { list: () => [{ id: scope.workspaceId, rootsRevision: scope.rootsRevision, path: scope.repoPath }] },
  ui: { confirm } } as unknown as AppContext;
  const auth = { credentials: async () => ({ token: 'mock-key', login: 'developer', generation: 1 }),
    assertCurrent: vi.fn(), installUrl: 'https://github.com/apps/muster-review/installations/new' } as unknown as GitHubAppAuth;
  const targets: AutoReviewTarget[] = [];
  const drafts = new Map<string, PrAiDraft>();
  const saveDraft = vi.fn((key: string, draft: PrAiDraft) => { drafts.set(key, draft); });
  const storage = { targets: () => targets, diskDraft: (key: string) => drafts.get(key) ?? null, saveDraft } as unknown as GitHubPrStorage;
  const generate = vi.fn(async () => ({ body: 'Review draft', partial: false }));
  let sha = version.headSha;
  let headRepository = 'developer/repo';
  let writeAccess = true;
  let selectedRepository = 'team/repo';
  let installVisible = true;
  let patch = '@@ -1 +1 @@\n-before()\n+after()';
  const manageUrl = 'https://github.com/organizations/team/settings/installations/1';
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    trace.push({ url: url.pathname, body });
    if (url.pathname === '/user/installations') {
      return Response.json({ installations: installVisible ? [{ id: 1, account: { login: 'team' }, repository_selection: 'selected',
        html_url: manageUrl, permissions: { pull_requests: writeAccess ? 'write' : 'read', contents: 'read', checks: 'read', statuses: 'read' } }] : [] });
    }
    if (url.pathname === '/user/installations/1/repositories') {
      return Response.json({ repositories: [{ full_name: selectedRepository }] });
    }
    if (url.pathname === '/repos/developer/repo') {
      return Response.json({ full_name: 'developer/repo', default_branch: 'main',
        parent: { full_name: 'team/repo' }, source: { full_name: 'team/repo' } });
    }
    if (url.pathname === '/repos/team/repo') return Response.json({ full_name: 'team/repo', default_branch: 'main' });
    if (url.pathname === '/repos/team/repo/branches/main') return Response.json({ name: 'main' });
    if (url.pathname === '/repos/team/repo/pulls' && !body) return Response.json([]);
    if (url.pathname === '/repos/team/repo/pulls' && body) {
      return Response.json({ number: 7, html_url: 'https://github.com/team/repo/pull/7' });
    }
    if (url.pathname === '/repos/team/repo/pulls/7') {
      return Response.json({ state: 'open', head: { sha, ref: 'topic', repo: { full_name: headRepository } }, base: { sha: version.baseSha } });
    }
    if (url.pathname === '/repos/team/repo/pulls/7/files') {
      return Response.json([{ filename: 'src/change.ts', patch }]);
    }
    if (url.pathname === '/graphql') {
      const reviewPr = { number: 7, headRefOid: sha, baseRefOid: version.baseSha, repository: { nameWithOwner: version.repository } };
      if (body.query.includes('MusterReviewSelection')) {
        return Response.json({ data: { nodes: [{ id: 'THREAD_1', path: 'src/change.ts', line: 1, diffSide: 'RIGHT',
          comments: { nodes: [{ id: 'comment', body: 'Check the new branch.' }] },
          anchor: { nodes: [{ pullRequestReview: { pullRequest: reviewPr } }] } }] } });
      }
      return Response.json({ data: { repository: { pullRequest: { ...reviewPr, title: 'Change a file', state: 'OPEN',
        headRefName: 'topic', baseRefName: 'main', headRepository: { nameWithOwner: headRepository } } } } });
    }
    if (url.pathname === '/repos/team/repo/pulls/7/reviews') {
      return Response.json({ id: 111, html_url: 'https://github.com/team/repo/pull/7#pullrequestreview-111' });
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  const service = ctx.githubPr = new GitHubPrService(ctx, auth, storage, fetcher, generate);
  return { ctx, service, trace, push, withWorkspace, context, confirm, checkoutForCwd,
    setPatch: (value: string) => { patch = value; }, renewSession: () => { lease = {}; },
    targets, saveDraft, generate, foreignFork: () => { headRepository = 'another/repo'; },
    advance: () => { sha = 'c'.repeat(40); },
    manageUrl, selectRepository: (name: string) => { selectedRepository = name; },
    removeInstallation: () => { installVisible = false; }, revokeWrite: () => { writeAccess = false; } };
}

describe('GitHub Agent actions', () => {
  const asWorker = <T>(run: () => Promise<T>) => runAsAgentSession('worker', run);

  it('uses the trusted checkout for Worker and scheduler reads, and rejects an unregistered repository', async () => {
    const { ctx, trace, checkoutForCwd } = fixture();
    await expect(githubHost['github.repository'](ctx, {})).rejects.toThrow(/bound to a workspace/);
    await expect(asWorker(() => githubHost['github.repository'](ctx, { repoPath: path.resolve('other-project') })))
      .rejects.toMatchObject({ kind: 'repo' });
    expect(trace).toHaveLength(0);
    expect(await asWorker(() => githubHost['github.detail'](ctx, { number: 7 }))).toMatchObject({ version });
    expect(checkoutForCwd).toHaveBeenCalledWith(path.join(scope.repoPath, 'src'));
    expect(trace.map(entry => entry.url)).not.toContain('/repos/team/repo/pulls/7/files');
    await runAsAgentWorkspace(scope.workspaceId, () => runAsSchedulerTool(() =>
      githubHost['github.repository'](ctx, {})));
    expect(checkoutForCwd).toHaveBeenLastCalledWith(scope.repoPath);
  });

  it('paginates escaped patches within budget instead of dropping content', async () => {
    const { ctx, setPatch } = fixture();
    const patch = '\u0000'.repeat(1399) + '🚀' + 'file\n'.repeat(300);
    setPatch(patch);
    let offset: number | undefined;
    let text = '';
    do {
      const result = await asWorker(() => githubHost['github.files'](ctx, { version, filename: 'src/change.ts', offset }));
      expect(JSON.stringify({ ok: true, result }).length).toBeLessThan(12_000);
      expect(result.patch).not.toBeNull();
      text += result.patch;
      offset = result.nextOffset ?? undefined;
    } while (offset !== undefined);
    expect(text).toBe(patch);
  });

  it('requires confirmation before pushing and publishing, and shows the exact destination and payload', async () => {
    const { ctx, push, trace, confirm } = fixture();
    confirm.mockResolvedValueOnce({ confirmed: false });
    await expect(asWorker(() => githubHost['github.create'](ctx, { branch: 'topic', title: 'Change it' }))).rejects.toThrow();
    expect(push).not.toHaveBeenCalled();
    expect(trace.some(call => call.url.endsWith('/pulls') && call.body)).toBe(false);
    expect(JSON.parse(confirm.mock.calls[0]![1])).toMatchObject({ repository: 'team/repo', pushRepository: 'developer/repo',
      login: 'developer', branch: 'topic', base: 'main', headSha: version.headSha, title: 'Change it' });
    await asWorker(() => githubHost['github.create'](ctx, { branch: 'topic', title: 'Change it' }));
    expect(push).toHaveBeenCalledWith(scope.repoPath, 'topic', expect.objectContaining({
      head: version.headSha, beforePush: expect.any(Function)
    }));
    const review = { version, event: 'COMMENT' as const, body: 'Please cover the retry.', comments: [
      { path: 'src/change.ts', line: 1, side: 'RIGHT' as const, body: 'Handle the error.' }
    ] };
    confirm.mockResolvedValueOnce({ confirmed: false });
    await expect(asWorker(() => githubHost['github.publish'](ctx, review))).rejects.toThrow();
    expect(trace.some(call => call.url.endsWith('/reviews'))).toBe(false);
    expect(JSON.parse(confirm.mock.calls.at(-1)![1])).toEqual({ ...review, login: 'developer' });
    await asWorker(() => githubHost['github.publish'](ctx, review));
    expect(trace.filter(call => call.url.endsWith('/reviews'))).toEqual([
      { url: '/repos/team/repo/pulls/7/reviews', body: { commit_id: version.headSha, event: review.event, body: review.body, comments: review.comments } }
    ]);
  });

  it('rejects writes if a commit, repository permission or caller lease changed during confirmation', async () => {
    const { ctx, trace, push, confirm, advance, revokeWrite, renewSession } = fixture();
    const invoke = () => asWorker(() => githubHost['github.create'](ctx, { branch: 'topic', title: 'Change it' }));
    confirm.mockImplementationOnce(async () => { renewSession(); return { confirmed: true }; });
    await expect(invoke()).rejects.toMatchObject({ kind: 'changed' });
    confirm.mockImplementationOnce(async () => { advance(); return { confirmed: true }; });
    await expect(asWorker(() => githubHost['github.publish'](ctx, { version, event: 'APPROVE' }))).rejects.toMatchObject({ kind: 'changed' });
    confirm.mockImplementationOnce(async () => { revokeWrite(); return { confirmed: true }; });
    await expect(invoke()).rejects.toMatchObject({ kind: 'permission' });
    expect(push).not.toHaveBeenCalled();
    expect(trace.some(call => (call.url.endsWith('/pulls') && call.body) || call.url.endsWith('/reviews'))).toBe(false);
  });
});

describe('GitHub PR host service', () => {
  it('uses the fork as the push destination and the upstream parent as the pull request target', async () => {
    const { service, trace, push, withWorkspace } = fixture();
    expect(await service.create(scope, create)).toMatchObject({ number: 7 });
    expect(withWorkspace).toHaveBeenCalledWith(scope, expect.any(Function));
    expect(push).toHaveBeenCalledWith(scope.repoPath, 'topic', { pushUrl: 'git@github.com:developer/repo.git', head: version.headSha });
    expect(trace.at(-1)).toEqual({ url: '/repos/team/repo/pulls',
      body: { title: 'Change a file', body: '', head: 'developer:topic', head_repo: 'repo', base: 'main', draft: true } });
  });

  it('never pushes to a destination that changed after opening the creation form', async () => {
    const { service, trace, push, context } = fixture();
    context.pushUrl = 'git@github.com:another/repo.git';
    await expect(service.create(scope, create)).rejects.toMatchObject({ kind: 'changed' });
    expect(push).not.toHaveBeenCalled();
    expect(trace.some(call => call.body !== undefined)).toBe(false);
  });

  it('checks the target installation before pushing a branch', async () => {
    const { service, push, revokeWrite, manageUrl } = fixture();
    revokeWrite();
    await expect(service.create(scope, create)).rejects.toMatchObject({ kind: 'permission', installUrl: manageUrl });
    expect(push).not.toHaveBeenCalled();
  });

  it('distinguishes missing installation, missing repository selection and missing permissions', async () => {
    const { service, manageUrl, selectRepository, removeInstallation, revokeWrite } = fixture();
    expect((await service.repository(scope)).appAccess).toEqual({ state: 'ready' });
    revokeWrite();
    expect((await service.repository(scope)).appAccess).toEqual({ state: 'permissions', url: manageUrl, missing: ['pull_requests'] });
    selectRepository('team/another-repo');
    expect((await service.repository(scope)).appAccess).toEqual({ state: 'install', url: manageUrl });
    removeInstallation();
    expect((await service.repository(scope)).appAccess).toEqual({ state: 'install', url: 'https://github.com/apps/muster-review/installations/new' });
  });

  it('binds the review submission to the visible commit and refuses a stale draft', async () => {
    const { service, trace, advance } = fixture();
    const review = { version, event: 'COMMENT' as const, body: 'Handle the retry case.', comments: [
      { path: 'src/change.ts', line: 9, side: 'RIGHT' as const, body: 'What if the call fails?' }
    ] };
    await service.publish(scope, review);
    expect(trace.at(-1)).toEqual({ url: '/repos/team/repo/pulls/7/reviews', body: {
      commit_id: version.headSha, event: review.event, body: review.body, comments: review.comments
    } });
    advance();
    await expect(service.publish(scope, review)).rejects.toMatchObject({ kind: 'changed' });
    expect(trace.filter(call => call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('only offers and forwards discussions to a Worker whose push repository also matches the PR head', async () => {
    const { service, foreignFork } = fixture();
    vi.mocked(sendSessionMail).mockClear();
    expect(await service.detail(scope, 7)).toMatchObject({ workerName: 'Code Worker' });
    await service.forward(scope, version, ['THREAD_1']);
    expect(sendSessionMail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionId: 'worker', text: expect.stringContaining('Check the new branch.')
    }));
    foreignFork();
    expect(await service.detail(scope, 7)).toMatchObject({ workerName: null });
    await expect(service.forward(scope, version, ['THREAD_1'])).rejects.toMatchObject({ kind: 'repo' });
    expect(sendSessionMail).toHaveBeenCalledTimes(1);
  });

  it('finds the current opt-in for a ready event and reuses the pinned draft', async () => {
    const { service, targets, generate, saveDraft } = fixture();
    targets.push({ scope, repository: version.repository, login: 'previous-account' },
      { scope: { ...scope, workspaceId: 'stale', rootsRevision: 1 }, repository: version.repository, login: 'developer' },
      { scope, repository: version.repository, login: 'developer' });
    const event = { type: 'pull_request.ready_for_review' as const, repository: version.repository,
      number: 7, headSha: version.headSha, draft: false };
    service.observeWebhook({ ...event, headSha: 'c'.repeat(40) });
    service.observeWebhook(event);
    service.observeWebhook(event);
    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledWith(reviewVersionKey('developer', version),
      expect.objectContaining({ body: 'Review draft', partial: false })));
    expect(await service.draft(scope, version)).toMatchObject({ body: 'Review draft' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('reports a model failure without exposing the provider error and can retry the draft', async () => {
    const { service, generate } = fixture();
    generate.mockRejectedValueOnce(new Error('provider rejected request with sensitive details'));
    await expect(service.draft(scope, version)).rejects.toMatchObject({ kind: 'failed',
      message: '生成 GitHub 审查草稿失败，请检查模型设置后重试' });
    expect(await service.draft(scope, version)).toMatchObject({ body: 'Review draft' });
  });
});
