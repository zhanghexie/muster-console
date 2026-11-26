/**
 * GitHub webhook payload 归一化（T3.2）：把 X-GitHub-Event 头 + JSON payload
 * 归一为 push、issue、comment、PR 评审和 CI 等内部事件，供 webAccess 的 /hook 路由
 * 构造 TriggerEvent。纯函数不碰 IO——签名校验（HMAC）在 main/webAccess/hookVerify。
 */
const GITHUB_PR_EVENTS = ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'check_run', 'check_suite'] as const;
type GitHubPrEvent = typeof GITHUB_PR_EVENTS[number];
export type WebhookEventType = 'push' | 'issue' | 'comment' | `${GitHubPrEvent}.${string}`;

export interface GitHubPrWebhook {
  type: `${GitHubPrEvent}.${string}`;
  repository: string;
  number: number;
  headSha: string;
  draft: boolean;
}

export function isGitHubPrEvent(value: string | undefined): value is GitHubPrEvent {
  return GITHUB_PR_EVENTS.some(event => event === value);
}

export function parseGitHubPrWebhook(event: string | undefined, payload: unknown): GitHubPrWebhook | null {
  if (!isGitHubPrEvent(event) || !payload || typeof payload !== 'object') return null;
  const data = payload as {
    action?: unknown; repository?: { full_name?: unknown }; number?: unknown;
    pull_request?: { number?: unknown; draft?: unknown; head?: { sha?: unknown } };
    check_run?: { head_sha?: unknown }; check_suite?: { head_sha?: unknown };
  };
  const { action } = data;
  const repository = data.repository?.full_name;
  const check = event === 'check_run' || event === 'check_suite';
  const headSha = check ? (event === 'check_run' ? data.check_run?.head_sha : data.check_suite?.head_sha) : data.pull_request?.head?.sha;
  const number = check ? 0 : (data.pull_request?.number ?? data.number);
  if (typeof action !== 'string' || !/^[a-z_]{1,40}$/.test(action) ||
      typeof repository !== 'string' || !/^[A-Za-z0-9-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
      typeof number !== 'number' || !Number.isSafeInteger(number) || (!check && number < 1) ||
      typeof headSha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(headSha)) return null;
  return { type: `${event}.${action}`, repository, number, headSha, draft: data.pull_request?.draft === true };
}
interface WebhookEvent {
  kind: 'webhook';
  at: number;
  eventType?: WebhookEventType;
  webhookProvider?: 'gitlab';
  gitlab?: { projectId: number; issueIid: number; action: string; title: string; summary?: string; commentKind?: 'user' | 'system' | 'unknown' };
}

/** 归一化结果：null 表示此投递没有对应业务事件。 */
export interface NormalizedWebhook {
  type: WebhookEventType;
  /** 人类可读摘要（触发日志/去抖记录里展示，如 "push → main"） */
  note: string;
}

function shortRef(ref: string | undefined): string {
  if (!ref) return '';
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

function clip(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 归一化 GitHub webhook：push（任意 push）/ issues（任意 action：opened/closed/…）/
 * issue_comment（仅 created）、PR 与 CI。ping 和未知事件返回 null。
 * payload 非对象视为空对象处理（缺字段给兜底摘要）。
 */
export function normalizeWebhookEvent(githubEvent: string | undefined, payload: unknown): NormalizedWebhook | null {
  if (!githubEvent) return null;
  if (isGitHubPrEvent(githubEvent)) {
    const pr = parseGitHubPrWebhook(githubEvent, payload);
    return pr ? { type: pr.type, note: `${pr.repository}${pr.number ? `#${pr.number}` : ''} ${pr.type}` } : null;
  }
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (githubEvent === 'push') {
    const commits = Array.isArray(body.commits) ? body.commits.length : 0;
    const ref = shortRef(typeof body.ref === 'string' ? body.ref : undefined);
    const repo = (body.repository as { full_name?: string } | undefined)?.full_name;
    const where = repo ? `${repo} ` : '';
    const refPart = ref ? ` → ${ref}` : '';
    return { type: 'push', note: `push ${where}${refPart}（${commits} commits）`.replace(/\s+/g, ' ').trim() };
  }
  if (githubEvent === 'issues') {
    const num = typeof body.issue === 'object' && body.issue ? (body.issue as { number?: unknown }).number : undefined;
    const title = typeof body.issue === 'object' && body.issue ? (body.issue as { title?: unknown }).title : undefined;
    const action = typeof body.action === 'string' ? body.action : 'updated';
    const numPart = num != null ? `#${num} ` : '';
    const titlePart = typeof title === 'string' ? clip(title) : '';
    return { type: 'issue', note: `issue ${numPart}${action}: ${titlePart}`.trim() };
  }
  if (githubEvent === 'issue_comment') {
    // 仅新评论触发（GitHub 对 edited/deleted 也发 issue_comment，重复编辑无触发价值）
    if (body.action !== 'created') return null;
    const num = typeof body.issue === 'object' && body.issue ? (body.issue as { number?: unknown }).number : undefined;
    const commentBody = typeof body.comment === 'object' && body.comment ? (body.comment as { body?: unknown }).body : undefined;
    const numPart = num != null ? `#${num} ` : '';
    const textPart = typeof commentBody === 'string' ? clip(commentBody, 40) : '';
    return { type: 'comment', note: `comment ${numPart}: ${textPart}`.trim() };
  }
  return null;
}

/** 构造 webhook 触发事件：githubEvent 缺省（手动 curl 等）= 通用触发（不带 eventType） */
export function buildWebhookTriggerEvent(
  githubEvent: string | undefined,
  payload: unknown,
  now: number = Date.now()
): { event: WebhookEvent; note: string } | null {
  if (!githubEvent) return { event: { kind: 'webhook', at: now }, note: 'manual' };
  const normalized = normalizeWebhookEvent(githubEvent, payload);
  if (!normalized) return null;
  return { event: { kind: 'webhook', at: now, eventType: normalized.type }, note: normalized.note };
}

/** Normalize only GitLab issue and issue-note events; never fall back to manual. */
export function buildGitLabWebhookTriggerEvent(
  gitlabEvent: string,
  payload: unknown,
  now: number = Date.now()
): { event: WebhookEvent; note: string } | null {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const positiveId = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const body = record(payload);
  const attributes = record(body.object_attributes);
  const project = record(body.project);
  const projectIds = [body.project_id, project.id, attributes.project_id].filter(value => value != null);
  if (!projectIds.length || !projectIds.every(positiveId) || projectIds.some(id => id !== projectIds[0])) return null;
  const projectId = projectIds[0] as number;

  if (gitlabEvent === 'Issue Hook') {
    if (body.object_kind !== 'issue' || !positiveId(attributes.iid)) return null;
    const action = typeof attributes.action === 'string' ? clip(attributes.action, 40) : 'unknown';
    const title = typeof attributes.title === 'string' ? clip(attributes.title, 240) : '';
    return {
      event: { kind: 'webhook', at: now, eventType: 'issue', webhookProvider: 'gitlab',
        gitlab: { projectId, issueIid: attributes.iid, action, title } },
      note: `gitlab issue #${attributes.iid} ${action}`
    };
  }
  if (gitlabEvent === 'Note Hook') {
    const issue = record(body.issue);
    if (body.object_kind !== 'note' || attributes.noteable_type !== 'Issue' || !positiveId(issue.iid)) return null;
    const action = typeof attributes.action === 'string' ? clip(attributes.action, 40) : 'unknown';
    const title = typeof issue.title === 'string' ? clip(issue.title, 240) : '';
    const summary = typeof attributes.note === 'string' ? clip(attributes.note, 512) : '';
    const commentKind = attributes.system === true ? 'system' : attributes.system === false ? 'user' : 'unknown';
    return {
      event: { kind: 'webhook', at: now, eventType: 'comment', webhookProvider: 'gitlab',
        gitlab: { projectId, issueIid: issue.iid, action, title, summary, commentKind } },
      note: `gitlab comment #${issue.iid} ${commentKind}`
    };
  }
  return null;
}
