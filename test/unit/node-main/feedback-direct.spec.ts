import { describe, expect, it, vi } from 'vitest';
import type { FeedbackTarget } from '../../../src/shared/feedback';
import { feedbackCredentialRequest, readFeedbackCredential } from '../../../src/main/feedback/credential';
import { createDirectFeedbackRemote, validateFeedbackCredential } from '../../../src/main/feedback/directRemote';

const gitlab: FeedbackTarget = { provider: 'gitlab', repository: 'https://gitlab.example.test/group/project' };
const github: FeedbackTarget = { provider: 'github', repository: 'https://github.com/org/project' };

describe('local feedback credentials', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('uses a noninteractive, path-scoped system helper on %s', platform => {
    const request = feedbackCredentialRequest(gitlab, platform, { PATH: 'test-path', GIT_TRACE: 'secret-log', GCM_TRACE_SECRETS: 'true', GIT_DIR: 'wrong-repo' });
    expect(request.args.slice(-4)).toEqual(['-c', 'credential.useHttpPath=true', 'credential', 'fill']);
    expect(request.input).toContain('host=gitlab.example.test\npath=__muster_feedback__\nusername=muster-feedback\n');
    expect(request.env).toMatchObject({ PATH: 'test-path', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GCM_PROVIDER: 'generic' });
    expect(request.env.GIT_TRACE).toBeUndefined();
    expect(request.env.GCM_TRACE_SECRETS).toBeUndefined();
    expect(request.env.GIT_DIR).toBeUndefined();
  });

  it('accepts exactly one password and does not put it in the request or arguments', async () => {
    const runner = vi.fn(async () => 'protocol=https\nusername=muster-feedback\npassword=private-test-token\n\n');
    expect(await readFeedbackCredential(gitlab, runner)).toBe('private-test-token');
    expect(JSON.stringify(runner.mock.calls)).not.toContain('private-test-token');
    expect(await readFeedbackCredential(gitlab, async () => 'password=one\npassword=two\n')).toBeNull();
    expect(await readFeedbackCredential(gitlab, async () => null)).toBeNull();
  });

});

describe('direct feedback without a server', () => {
  it('validates a token with a read-only issue request and reports invalid credentials', async () => {
    const ok = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('[]', { status: 200 }));
    await expect(validateFeedbackCredential(ok as typeof fetch, gitlab, 'private-test-token')).resolves.toBeUndefined();
    expect(String(ok.mock.calls[0]![0])).toContain('/issues?state=all&per_page=1');
    expect(ok.mock.calls[0]![1]?.method).toBeUndefined();
    expect(ok.mock.calls[0]![1]?.headers).toMatchObject({ 'PRIVATE-TOKEN': 'private-test-token' });
    expect(String(ok.mock.calls[0]![0])).not.toContain('private-test-token');
    const bad = vi.fn(async () => new Response('', { status: 401 }));
    await expect(validateFeedbackCredential(bad as typeof fetch, gitlab, 'invalid')).rejects.toThrow('凭据无效');
  });

  it.each([gitlab, github])('lists all issue states and creates using $provider API after review', async target => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const isGitHub = target.provider === 'github';
      const row = isGitHub
        ? { number: 1, title: '相关问题', body: 'existing private content', state: 'closed', html_url: 'https://github.com/org/project/issues/1' }
        : { iid: 1, title: '相关问题', description: 'existing private content', state: 'closed', web_url: 'https://gitlab.example.test/group/project/-/issues/1' };
      if (init?.method === 'POST') return new Response(JSON.stringify(isGitHub
        ? { number: 2, title: '全新反馈', body: 'details', state: 'open', html_url: 'https://github.com/org/project/issues/2' }
        : { iid: 2, title: '全新反馈', description: 'details', state: 'opened', web_url: 'https://gitlab.example.test/group/project/-/issues/2' }), { status: 201 });
      return new Response(JSON.stringify(isGitHub ? [row, { pull_request: {} }] : [row]), { status: 200 });
    });
    const remote = createDirectFeedbackRemote(fake as typeof fetch, target, async () => 'private-test-token');
    const review = await remote.find('全新反馈');
    expect(review.issues).toHaveLength(0);
    expect(calls.every(call => call.init?.method !== 'POST')).toBe(true);
    const created = await remote.create(target, '全新反馈', 'details', review.issues);
    expect(created.id).toBe('2');
    expect(calls.every(call => !call.url.includes('private-test-token') && call.init?.redirect === 'manual')).toBe(true);
    const post = calls.find(call => call.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init?.body))).toEqual(target.provider === 'github' ? { title: '全新反馈', body: 'details' } : { title: '全新反馈', description: 'details' });
    expect(post.init?.headers).toMatchObject(target.provider === 'github' ? { Authorization: 'Bearer private-test-token' } : { 'PRIVATE-TOKEN': 'private-test-token' });
  });

  it('blocks concurrent submissions of the same title after a second repository check', async () => {
    const rows: Array<{ iid: number; title: string; description: string; state: string; web_url: string }> = [];
    let posts = 0;
    const fake = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        const body = JSON.parse(String(init.body));
        const row = { iid: 1, title: body.title, description: body.description, state: 'opened', web_url: 'https://gitlab.example.test/group/project/-/issues/1' };
        rows.push(row); return new Response(JSON.stringify(row), { status: 201 });
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    });
    const remote = createDirectFeedbackRemote(fake as typeof fetch, gitlab, async () => 'private-test-token');
    const before = await remote.find('切换工作区后位置丢失');
    const result = await Promise.allSettled([
      remote.create(gitlab, '切换工作区后位置丢失', 'first', before.issues),
      remote.create(gitlab, '切换工作区后位置丢失', 'second', before.issues)
    ]);
    expect(result.map(item => item.status)).toEqual(['fulfilled', 'rejected']);
    expect(posts).toBe(1);
  });

  it('does not expose other issue bodies and finds uncertain submissions by marker', async () => {
    const marker = '00000000-0000-4000-8000-000000000001';
    const fake = vi.fn(async () => new Response(JSON.stringify([{ iid: 7, title: '其他标题', description: `private text <!-- muster-feedback:${marker} -->`, state: 'closed', web_url: 'https://gitlab.example.test/group/project/-/issues/7' }]), { status: 200 }));
    const remote = createDirectFeedbackRemote(fake as typeof fetch, gitlab, async () => 'private-test-token');
    expect((await remote.find('其他标题')).issues[0]?.body).toBe('');
    expect((await remote.find('已改动的标题', marker)).issues[0]?.body).toBe(`<!-- muster-feedback:${marker} -->`);
  });

  it.each([gitlab, github])('exposes paginated issue history to AI with credentials redacted on $provider', async target => {
    const isGitHub = target.provider === 'github';
    const row = (n: number) => isGitHub
      ? { number: n, title: `问题 ${n}`, body: n === 101 ? `private-test-token ${'证'.repeat(4100)}` : `历史描述 ${n}`, state: n % 2 ? 'closed' : 'open', html_url: `https://github.com/org/project/issues/${n}` }
      : { iid: n, title: `问题 ${n}`, description: n === 101 ? `private-test-token ${'证'.repeat(4100)}` : `历史描述 ${n}`, state: n % 2 ? 'closed' : 'opened', web_url: `https://gitlab.example.test/group/project/-/issues/${n}` };
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/issues/101')) return new Response(JSON.stringify(row(101)), { status: 200 });
      const page = Number(parsed.searchParams.get('page'));
      return new Response(JSON.stringify(page === 1 ? Array.from({ length: 100 }, (_, i) => row(i + 1)) : [row(101), ...(isGitHub ? [{ pull_request: {} }] : [])]), { status: 200 });
    });
    const remote = createDirectFeedbackRemote(fetcher as typeof fetch, target, async () => 'private-test-token');
    const history = await remote.history!();
    expect(history.issues).toHaveLength(101);
    expect(history.issues[0]).toMatchObject({ title: '问题 1', body: '历史描述 1', state: 'closed' });
    expect(history.issues[100]?.bodyTruncated).toBe(true);
    expect(history.issues[100]?.body).not.toContain('private-test-token');
    expect(JSON.stringify(history)).not.toContain('PRIVATE-TOKEN');
    const detail = await remote.details!('101');
    expect(detail.body).toContain('证'.repeat(4100));
    expect(detail.body).not.toContain('private-test-token');
    expect(detail.bodyHash).toBe(history.issues[100]?.bodyHash);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails closed on missing credentials, changed matches, unauthorized access and uncertain POSTs', async () => {
    const empty = createDirectFeedbackRemote(vi.fn() as unknown as typeof fetch, gitlab, async () => null);
    await expect(empty.find('title')).rejects.toThrow('凭据不可用');
    const unauthorized = createDirectFeedbackRemote(vi.fn(async () => new Response('', { status: 401 })) as typeof fetch, gitlab, async () => 'token');
    await expect(unauthorized.find('title')).rejects.toThrow('凭据无效');
    const row = { iid: 1, title: '重复标题', description: '', state: 'opened', web_url: 'https://gitlab.example.test/group/project/-/issues/1' };
    const changed = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify([row]), { status: 200 }));
    await expect(createDirectFeedbackRemote(changed as typeof fetch, gitlab, async () => 'token').create(gitlab, '重复标题', 'body', [])).rejects.toThrow('查重结果已变化');
    expect(changed.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    const interrupted = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('disconnected');
      return new Response('[]', { status: 200 });
    });
    await expect(createDirectFeedbackRemote(interrupted as typeof fetch, gitlab, async () => 'token').create(gitlab, '全新问题', 'body', [])).rejects.toMatchObject({ uncertain: true });
  });
});

it('reads GitHub Issue history and details anonymously and never writes in public mode', async () => {
  const issue = { number: 1, title: 'Prior bug', body: 'Prior report', state: 'closed', html_url: 'https://github.com/org/project/issues/1' };
  const fetcher = vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/1') ? issue : [issue, { pull_request: {} }]));
  const remote = createDirectFeedbackRemote(fetcher, github);
  await expect(remote.history!()).resolves.toMatchObject({ target: github, issues: [{ id: '1', body: 'Prior report', state: 'closed' }] });
  await expect(remote.details!('1')).resolves.toMatchObject({ id: '1', body: 'Prior report' });
  await expect(remote.create(github, 'New bug', 'details', [])).rejects.toThrow('请在 GitHub 网页提交反馈');
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, init] of fetcher.mock.calls) {
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init?.credentials).toBe('omit');
    expect(init?.method ?? 'GET').toBe('GET');
  }
});

it('reports an anonymous GitHub rate limit as unavailable history', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('rate limit', {
    status: 403, headers: { 'x-ratelimit-remaining': '0' },
  }));
  await expect(createDirectFeedbackRemote(fetcher, github).history!()).rejects.toThrow('GitHub 反馈查询达到限额');
});
