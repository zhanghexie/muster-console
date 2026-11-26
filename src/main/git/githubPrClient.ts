import type {
  PrCheck, PrChecksStatus, PrDiscussionEntry, PrFile, PrReviewDecision, PrReviewThread, PrSummary, PrVersion
} from '../../shared/githubPr';
import { t } from '../../shared/i18n';
import { array, githubFetch, githubStatusError, GitHubPrError, object, safeGitHubUrl, string } from './githubHttp';
import { githubRepositoryName } from './githubRepository';

const API = 'https://api.github.com';
export const FILES_PAGE_SIZE = 20;
const PATCH_LIMIT = 32_000;
const COMMENT_LIMIT = 12_000;

export function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
}

export function githubPullUrl(raw: unknown, repository: string, number: number): string {
  const url = safeGitHubUrl(raw, 'github.com');
  if (url && new URL(url).pathname.toLowerCase() === `/${repository.toLowerCase()}/pull/${number}`) return url;
  return `https://github.com/${repository}/pull/${number}`;
}

function toChecks(value: unknown): PrChecksStatus {
  if (value === 'SUCCESS') return 'pass';
  if (value === 'PENDING' || value === 'EXPECTED') return 'pending';
  if (value === 'ERROR' || value === 'FAILURE') return 'failure';
  return value == null ? 'none' : 'unknown';
}

function reviewDecision(value: unknown): PrReviewDecision | null {
  if (value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') return value;
  return null;
}

const THREAD_FIELDS = `id path line diffSide isResolved isOutdated
  comments(last: 25) {
    pageInfo { hasPreviousPage }
    nodes { id body createdAt url author { login } }
  }`;

const SUMMARY_FIELDS = `number title url state isDraft headRefName baseRefName updatedAt reviewDecision
  author { login }
  comments(last: 8) { nodes { createdAt author { login } } }
  reviews(last: 8, states: [COMMENTED, APPROVED, CHANGES_REQUESTED, DISMISSED]) { nodes { submittedAt author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

function recentDiscussion(row: Record<string, unknown>, viewer: string): string | null {
  const entries = [...array(object(row.comments).nodes), ...array(object(row.reviews).nodes)];
  let latest = '';
  for (const entry of entries.map(object)) {
    if (string(object(entry.author).login).toLowerCase() === viewer.toLowerCase()) continue;
    const date = string(entry.createdAt) || string(entry.submittedAt);
    if (date > latest) latest = date;
  }
  return latest || null;
}

function summary(row: Record<string, unknown>, repository: string, viewer: string): PrSummary | null {
  const number = row.number;
  const state = row.state;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 ||
      (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')) return null;
  const commit = object(object(array(object(row.commits).nodes)[0]).commit);
  return { number, state, title: string(row.title), url: githubPullUrl(row.url, repository, number), isDraft: row.isDraft === true,
    headRefName: string(row.headRefName), baseRefName: string(row.baseRefName), author: string(object(row.author).login) || null,
    updatedAt: string(row.updatedAt), checks: toChecks(object(commit.statusCheckRollup).state),
    reviewDecision: reviewDecision(row.reviewDecision), latestDiscussionAt: recentDiscussion(row, viewer) };
}

function comment(raw: unknown): PrDiscussionEntry {
  const row = object(raw);
  const state = string(row.state);
  return { id: string(row.id), body: string(row.body).slice(0, COMMENT_LIMIT), author: string(object(row.author).login) || null,
    createdAt: string(row.submittedAt) || string(row.createdAt) || null, url: safeGitHubUrl(row.url, 'github.com'),
    ...(state ? { reviewState: state } : {}) };
}

function thread(raw: unknown): PrReviewThread {
  const row = object(raw);
  const comments = object(row.comments);
  return { id: string(row.id), path: string(row.path), line: typeof row.line === 'number' ? row.line : null,
    side: row.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT', resolved: row.isResolved === true, outdated: row.isOutdated === true,
    comments: array(comments.nodes).map(comment).filter(c => c.id), commentsTruncated: object(comments?.pageInfo).hasPreviousPage === true };
}

function cursor(connection: Record<string, unknown>): string | null {
  const info = object(connection.pageInfo);
  return info.hasNextPage === true ? string(info.endCursor) || null : null;
}

function checkContext(raw: unknown): PrCheck | null {
  const value = object(raw);
  const name = string(value.name) || string(value.context);
  if (!name) return null;
  return { name, state: string(value.conclusion) || string(value.status) || string(value.state) || 'UNKNOWN',
    url: safeGitHubUrl(value.detailsUrl ?? value.targetUrl) };
}

export interface RepoInfo { name: string; branch: string; parent: string | null; source: string | null }

export class GitHubPrClient {
  constructor(private readonly fetcher: typeof fetch, private readonly token: string, readonly viewer: string) {}

  private async request(path: string, body?: unknown): Promise<{ data: unknown; response: Response }> {
    const response = await githubFetch(this.fetcher, `${API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'User-Agent': 'Muster', Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw githubStatusError(response);
    try { return { data: await response.json() as unknown, response }; }
    catch { throw new GitHubPrError('failed', t('GitHub 返回了无法读取的数据')); }
  }

  async rest(path: string, body?: unknown): Promise<unknown> { return (await this.request(path, body)).data; }

  private async graph(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = object(await this.rest('/graphql', { query, variables }));
    const errors = array(result.errors).map(object);
    if (errors.length) {
      if (errors.some(err => err.type === 'RATE_LIMITED')) throw new GitHubPrError('rateLimit', t('GitHub 请求达到限额，请稍后重试'));
      if (errors.every(err => err.type === 'NOT_FOUND' || err.type === 'FORBIDDEN')) {
        throw new GitHubPrError('permission', t('GitHub 仓库不可用或当前账号权限不足'));
      }
      throw new GitHubPrError('failed', t('GitHub 未能完成 PR 查询，请稍后重试'));
    }
    return object(result.data);
  }

  private repoVariables(repository: string) {
    const [owner, name] = repository.split('/');
    return { owner, name };
  }

  async repository(repository: string): Promise<RepoInfo> {
    const row = object(await this.rest(`/repos/${repository}`));
    const name = githubRepositoryName(string(row.full_name));
    const branch = string(row.default_branch);
    if (!name || !branch) throw new GitHubPrError('failed', t('GitHub 返回了无法读取的数据'));
    return { name, branch, parent: githubRepositoryName(string(object(row.parent).full_name)),
      source: githubRepositoryName(string(object(row.source).full_name)) };
  }

  async repositoryInstallation(repository: string): Promise<{
    permissions: Record<string, unknown> | null; manageUrl?: string;
  }> {
    const target = repository.toLowerCase();
    const [owner] = target.split('/');
    let manageUrl: string | undefined;
    for (let page = 1; page <= 10; page++) {
      const installs = await this.request(`/user/installations?per_page=100&page=${page}`);
      for (const item of array(object(installs.data).installations).map(object)) {
        if (string(object(item.account).login).toLowerCase() !== owner ||
            typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id < 1) continue;
        const url = safeGitHubUrl(item.html_url, 'github.com') ?? undefined;
        manageUrl ??= url;
        if (item.suspended_at) continue;
        const installation = { permissions: object(item.permissions), manageUrl: url };
        if (item.repository_selection === 'all') return installation;
        for (let repoPage = 1; repoPage <= 30; repoPage++) {
          const repos = await this.request(`/user/installations/${item.id}/repositories?per_page=100&page=${repoPage}`);
          if (array(object(repos.data).repositories).map(object).some(row => string(row.full_name).toLowerCase() === target)) return installation;
          if (!/rel="next"/.test(repos.response.headers.get('link') ?? '')) break;
        }
      }
      if (!/rel="next"/.test(installs.response.headers.get('link') ?? '')) break;
    }
    return { permissions: null, manageUrl };
  }

  async list(repository: string, filter: 'authored' | 'reviewRequested', after?: string) {
    const query = `repo:${repository} is:pr is:open ${filter === 'authored' ? 'author' : 'review-requested'}:${this.viewer} sort:updated-desc`;
    const data = await this.graph(`query MusterPullRequests($query: String!, $after: String) {
      search(type: ISSUE, query: $query, first: 25, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { ${SUMMARY_FIELDS}
          repository { nameWithOwner }
        } }
      }
    }`, { query, after: after ?? null });
    const search = object(data.search);
    const prs = array(search.nodes).map(object)
      .filter(row => string(object(row.repository).nameWithOwner).toLowerCase() === repository.toLowerCase())
      .map(row => summary(row, repository, this.viewer)).filter((item): item is PrSummary => !!item);
    return { prs, cursor: cursor(search) };
  }

  async detail(repository: string, number: number) {
    const data = await this.graph(`query MusterPullRequest($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          ${SUMMARY_FIELDS}
          body headRefOid baseRefOid headRepository { nameWithOwner }
          discussion: comments(last: 40) { nodes { id author { login } body createdAt url } }
          decisions: reviews(last: 40, states: [COMMENTED, APPROVED, CHANGES_REQUESTED, DISMISSED]) {
            nodes { id author { login } body state submittedAt url }
          }
          reviewThreads(first: 20) {
            pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} }
          }
          checks: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          } } } } }
        }
      }
    }`, { ...this.repoVariables(repository), number });
    const pr = object(object(data.repository).pullRequest);
    const entry = summary(pr, repository, this.viewer);
    const headSha = pr.headRefOid;
    const baseSha = pr.baseRefOid;
    if (!entry || !validSha(headSha) || !validSha(baseSha)) {
      throw new GitHubPrError('permission', t('GitHub 上找不到该 PR，或当前账号没有查看权限'));
    }
    const discussions = [...array(object(pr.discussion).nodes), ...array(object(pr.decisions).nodes)]
      .map(comment).filter(item => item.id).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    const threads = object(pr.reviewThreads);
    const checks = object(object(object(object(array(object(pr.checks).nodes)[0]).commit).statusCheckRollup).contexts);
    const body = string(pr.body);
    return { ...entry, repository, headSha, baseSha, headRepository: githubRepositoryName(string(object(pr.headRepository).nameWithOwner)),
      body: body.slice(0, COMMENT_LIMIT), bodySourceTruncated: body.length > COMMENT_LIMIT,
      threads: array(threads.nodes).map(thread).filter(item => item.id), threadCursor: cursor(threads),
      discussion: discussions, checkEntries: array(checks.nodes).map(checkContext).filter((item): item is PrCheck => !!item),
      checksTruncated: object(checks.pageInfo).hasNextPage === true };
  }

  async threads(version: PrVersion, after?: string) {
    const data = await this.graph(`query MusterPullRequestThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          headRefOid baseRefOid
          reviewThreads(first: 20, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_FIELDS} } }
        }
      }
    }`, { ...this.repoVariables(version.repository), number: version.number, after: after ?? null });
    const pr = object(object(data.repository).pullRequest);
    if (pr.headRefOid !== version.headSha || pr.baseRefOid !== version.baseSha) this.changed();
    const threads = object(pr.reviewThreads);
    return { threads: array(threads.nodes).map(thread).filter(item => item.id), threadCursor: cursor(threads) };
  }

  async threadSelection(version: PrVersion, ids: string[]): Promise<PrReviewThread[]> {
    // Node IDs from a different PR must never be included in a Worker brief.
    const data = await this.graph(`query MusterReviewSelection($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on PullRequestReviewThread {
          ${THREAD_FIELDS}
          anchor: comments(first: 1) {
            nodes { pullRequestReview { pullRequest { number headRefOid baseRefOid repository { nameWithOwner } } } }
          }
        }
      }
    }`, { ids });
    const result = array(data.nodes).map(object).map(node => {
      const root = object(array(object(node.anchor).nodes)[0]);
      const pr = object(object(root.pullRequestReview).pullRequest);
      if (pr.number !== version.number || pr.headRefOid !== version.headSha || pr.baseRefOid !== version.baseSha ||
          string(object(pr.repository).nameWithOwner).toLowerCase() !== version.repository.toLowerCase()) this.changed();
      return thread(node);
    });
    if (result.length !== ids.length) this.changed();
    return result;
  }

  async checkVersion(version: PrVersion, requireOpen = false): Promise<Record<string, unknown>> {
    const pr = object(await this.rest(`/repos/${version.repository}/pulls/${version.number}`));
    if (object(pr.head).sha !== version.headSha || object(pr.base).sha !== version.baseSha || (requireOpen && pr.state !== 'open')) this.changed();
    return pr;
  }

  async files(version: PrVersion, page: number) {
    await this.checkVersion(version);
    const { data, response } = await this.request(`/repos/${version.repository}/pulls/${version.number}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`);
    await this.checkVersion(version);
    const files: PrFile[] = array(data).map(object).map(row => {
      const patch = string(row.patch);
      const previousPath = string(row.previous_filename);
      return { path: string(row.filename), ...(previousPath ? { previousPath } : {}), status: string(row.status),
        additions: typeof row.additions === 'number' ? row.additions : 0, deletions: typeof row.deletions === 'number' ? row.deletions : 0,
        patch: patch ? patch.slice(0, PATCH_LIMIT) : null, truncated: patch.length > PATCH_LIMIT };
    }).filter(file => !!file.path);
    return { files, filesHaveMore: /rel="next"/.test(response.headers.get('link') ?? '') };
  }

  private changed(): never {
    throw new GitHubPrError('changed', t('PR 版本或状态已变化，请刷新后继续'));
  }
}
