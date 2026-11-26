import type { FeedbackTarget } from '../../shared/feedback';
import { createHash } from 'node:crypto';
import { normalizedTitle, titleSimilarity } from './format';
import { FeedbackRemoteError, normalizeFeedbackTarget, type FeedbackRemote, type RemoteIssue } from './remote';
import { collectEnvSecrets, redactSafetyText } from '../safety/redact';

function apiBase(target: FeedbackTarget): string {
  const url = new URL(target.repository), parts = url.pathname.split('/').filter(Boolean);
  return target.provider === 'github'
    ? `https://api.github.com/repos/${parts.map(encodeURIComponent).join('/')}/issues`
    : `${url.origin}/api/v4/projects/${encodeURIComponent(parts.join('/'))}/issues`;
}

/** A read-only check, so saving a token never creates a test Issue. */
export async function validateFeedbackCredential(fetcher: typeof fetch, requestedTarget: FeedbackTarget, token: string): Promise<void> {
  const target = normalizeFeedbackTarget(requestedTarget);
  const headers = target.provider === 'github'
    ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
    : { Accept: 'application/json', 'PRIVATE-TOKEN': token };
  let response: Response;
  try { response = await fetcher(`${apiBase(target)}?state=all&per_page=1`, { headers, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new FeedbackRemoteError('无法连接反馈仓库，请稍后重试。'); }
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new FeedbackRemoteError('反馈凭据无效或权限不足，请检查后重试。');
  if (!response.ok) throw new FeedbackRemoteError('反馈仓库暂不可用，请稍后重试。');
  try { const text = await response.text(); if (text.length > 4_000_000 || !Array.isArray(JSON.parse(text))) throw new Error('invalid'); }
  catch { throw new FeedbackRemoteError('反馈列表读取失败，请稍后重试。'); }
}

function parseIssue(value: unknown, target: FeedbackTarget): RemoteIssue {
  if (!value || typeof value !== 'object') throw new FeedbackRemoteError('反馈列表读取失败，请稍后重试。');
  const row = value as Record<string, unknown>;
  const id = target.provider === 'github' ? row.number : row.iid;
  const url = target.provider === 'github' ? row.html_url : row.web_url;
  if (!Number.isSafeInteger(id) || Number(id) < 1 || typeof row.title !== 'string' || typeof url !== 'string') throw new FeedbackRemoteError('反馈服务返回的信息不完整');
  const base = new URL(target.repository);
  let link: URL;
  try { link = new URL(url); } catch { throw new FeedbackRemoteError('反馈服务返回的信息不完整'); }
  const expected = `${base.pathname}${target.provider === 'github' ? '/issues/' : '/-/issues/'}${id}`;
  if (link.protocol !== 'https:' || link.origin !== base.origin || link.pathname !== expected || link.username || link.password || link.search || link.hash) throw new FeedbackRemoteError('反馈服务返回的信息不完整');
  return { id: String(id), title: row.title, url, state: String(row.state ?? ''), body: String((target.provider === 'github' ? row.body : row.description) ?? '') };
}

function snapshot(issues: RemoteIssue[]): string {
  return JSON.stringify(issues.map(({ id, title, state, url }) => [id, title, state, url]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/** Without a credential provider, the GitHub adapter only reads public Issues. */
export function createDirectFeedbackRemote(fetcher: typeof fetch, requestedTarget: FeedbackTarget, credential?: (target: FeedbackTarget) => Promise<string | null>): FeedbackRemote {
  const target = normalizeFeedbackTarget(requestedTarget);
  let queue: Promise<void> = Promise.resolve();
  async function authorization(): Promise<{ headers: Record<string, string>; token?: string }> {
    if (!credential && target.provider === 'github') {
      return { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
    }
    const token = await credential?.(target);
    if (!token) throw new FeedbackRemoteError('本机反馈凭据不可用，请联系维护人员。');
    return { token, headers: target.provider === 'github'
      ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
      : { Accept: 'application/json', 'PRIVATE-TOKEN': token } };
  }
  async function request(url: string, init: RequestInit, create = false): Promise<unknown> {
    let response: Response;
    try { response = await fetcher(url, { ...init, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new FeedbackRemoteError(create ? '发送后连接中断，是否发送成功尚不确定，请先核对。' : '无法连接反馈仓库，请稍后重试。', create); }
    if (!response.ok) {
      if (!credential && (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
        throw new FeedbackRemoteError('GitHub 反馈查询达到限额，请稍后重试。');
      }
      if (credential && (response.status === 401 || response.status === 403)) throw new FeedbackRemoteError('反馈凭据无效或权限不足，请联系维护人员。');
      const uncertain = create && (response.status >= 500 || response.status === 408 || (response.status >= 300 && response.status < 400));
      throw new FeedbackRemoteError(uncertain ? '发送结果尚不确定，请先核对是否已发送。' : '反馈仓库暂不可用，请稍后重试。', uncertain);
    }
    try {
      const text = await response.text();
      if (text.length > 12_000_000) throw new Error('response too large');
      return JSON.parse(text);
    } catch { throw new FeedbackRemoteError(create ? '发送结果不完整，是否发送成功尚不确定，请先核对。' : '反馈列表读取失败，请稍后重试。', create); }
  }
  async function find(title: string, marker?: string) {
    const { headers: auth } = await authorization();
    const matches: RemoteIssue[] = [];
    for (let page = 1; page <= 50; page++) {
      const data = await request(`${apiBase(target)}?state=all&per_page=100&page=${page}`, { headers: auth });
      if (!Array.isArray(data)) throw new FeedbackRemoteError('反馈列表读取失败，请稍后重试。');
      for (const value of data) {
        if (target.provider === 'github' && value && typeof value === 'object' && 'pull_request' in value) continue;
        const item = parseIssue(value, target);
        const marked = !!marker && item.body.includes(`<!-- muster-feedback:${marker} -->`);
        if (titleSimilarity(title, item.title) >= 0.62 || marked) matches.push({ ...item, body: marked ? `<!-- muster-feedback:${marker} -->` : '' });
      }
      if (matches.length > 500) throw new FeedbackRemoteError('反馈太多，暂时无法完成查重，请联系维护人员。');
      if (data.length < 100) return { target, issues: matches };
    }
    throw new FeedbackRemoteError('反馈太多，暂时无法完成查重，请联系维护人员。');
  }
  return {
    find,
    async history() {
      const { headers: auth, token } = await authorization();
      const secrets = [...collectEnvSecrets(process.env), ...(token ? [token] : [])];
      const issues: RemoteIssue[] = [];
      for (let page = 1; page <= 50; page++) {
        const data = await request(`${apiBase(target)}?state=all&per_page=100&page=${page}`, { headers: auth });
        if (!Array.isArray(data)) throw new FeedbackRemoteError('反馈列表读取失败，请稍后重试。');
        for (const value of data) {
          if (target.provider === 'github' && value && typeof value === 'object' && 'pull_request' in value) continue;
          const item = parseIssue(value, target);
          const clean = (value: string) => redactSafetyText(value, [...secrets])
            .replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '***REDACTED***')
            .replace(/<!--\s*muster-feedback:[^>]*-->/gi, '[内部标记已移除]');
          const body = clean(item.body);
          issues.push({ ...item, title: clean(item.title).slice(0, 300), body: body.slice(0, 4000), bodyTruncated: body.length > 4000,
            bodyHash: createHash('sha256').update(body).digest('hex') });
        }
        if (data.length < 100) return { target, issues };
      }
      throw new FeedbackRemoteError('反馈太多，暂时无法完成查重，请联系维护人员。');
    },
    async details(id) {
      if (!/^\d+$/.test(id)) throw new FeedbackRemoteError('反馈服务返回的信息不完整');
      const { headers: auth, token } = await authorization();
      const item = parseIssue(await request(`${apiBase(target)}/${id}`, { headers: auth }), target);
      if (item.id !== id) throw new FeedbackRemoteError('反馈服务返回的信息不完整');
      const body = redactSafetyText(item.body, [...collectEnvSecrets(process.env), ...(token ? [token] : [])])
        .replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '***REDACTED***')
        .replace(/<!--\s*muster-feedback:[^>]*-->/gi, '[内部标记已移除]');
      return { ...item, body, bodyHash: createHash('sha256').update(body).digest('hex') };
    },
    async create(expectedTarget, title, body, seen) {
      if (!credential) throw new FeedbackRemoteError('请在 GitHub 网页提交反馈。');
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        const current = await find(title);
        if (JSON.stringify(expectedTarget) !== JSON.stringify(target) || snapshot(current.issues) !== snapshot(seen) ||
          current.issues.some(item => normalizedTitle(item.title) === normalizedTitle(title))) throw new FeedbackRemoteError('查重结果已变化，请重新检查');
        const { headers: auth } = await authorization();
        const data = await request(apiBase(target), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(target.provider === 'github' ? { title, body } : { title, description: body }) }, true);
        try { const item = parseIssue(data, target); return { ...item, body: '' }; }
        catch { throw new FeedbackRemoteError('发送结果不完整，是否发送成功尚不确定，请先核对。', true); }
      } finally { release(); }
    }
  };
}
