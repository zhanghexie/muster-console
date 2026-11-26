import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createFeedbackRelay, createRepository, readConfig, titleSimilarity } from '../services/feedback-relay/server.mjs';

const cfg = readConfig({ FEEDBACK_ISSUE_TOKEN: 'test-secret' });
assert.deepEqual(cfg.target, { provider: 'github', repository: 'https://github.com/zhanghexie/muster-console' });
assert.equal(readConfig({
  FEEDBACK_ISSUE_TOKEN: 'test-secret', FEEDBACK_REPOSITORY: 'https://github.com/org/project.git'
}).target.repository, 'https://github.com/org/project');
assert.throws(() => readConfig({}), /FEEDBACK_ISSUE_TOKEN/);
assert.throws(() => readConfig({ FEEDBACK_ISSUE_TOKEN: 'x', FEEDBACK_REPOSITORY: 'http://example.test/a/b' }), /HTTPS/);
assert.throws(() => readConfig({ FEEDBACK_ISSUE_TOKEN: 'x', FEEDBACK_PROVIDER: 'github', FEEDBACK_REPOSITORY: 'https://github.com/a/b/c' }), /HTTPS/);
assert.ok(titleSimilarity('切换工作区后会话列表滚动位置丢失', '切换工作区后列表滚动位置丢失') >= 0.62);
assert.equal(titleSimilarity('ISSUE 信息', 'issue 信息！'), 1);

for (const provider of ['gitlab', 'github']) {
  const target = provider === 'gitlab' ? { provider, repository: 'https://gitlab.example.test/group/project' } : { provider, repository: 'https://github.com/org/project' };
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    const github = provider === 'github';
    const row = github ? { number: 1, title: 'old', body: 'private body', state: 'closed', html_url: 'https://github.com/org/project/issues/1' }
      : { iid: 1, title: 'old', description: 'private body', state: 'closed', web_url: 'https://gitlab.example.test/group/project/-/issues/1' };
    if (init.method === 'POST') return new Response(JSON.stringify(row), { status: 201 });
    return new Response(JSON.stringify(github ? [row, { pull_request: {} }] : [row]), { status: 200 });
  };
  const repo = createRepository({ target, token: 'test-secret' }, fake);
  assert.equal((await repo.list()).length, 1);
  await repo.create('new', 'body');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.url.includes('test-secret') && call.init.redirect === 'manual'));
  assert.equal(provider === 'github' ? calls[0].init.headers.Authorization : calls[0].init.headers['PRIVATE-TOKEN'], provider === 'github' ? 'Bearer test-secret' : 'test-secret');
  assert.deepEqual(JSON.parse(calls[1].init.body), provider === 'github' ? { title: 'new', body: 'body' } : { title: 'new', description: 'body' });
  const failed = createRepository({ target, token: 'test-secret' }, async () => { throw new Error('offline'); });
  await assert.rejects(failed.list(), error => error.uncertain === false);
  await assert.rejects(failed.create('new', 'body'), error => error.uncertain === true);
}

const target = { provider: 'gitlab', repository: 'https://gitlab.example.test/group/project' };
const marker1 = '00000000-0000-4000-8000-000000000001';
const marker2 = '00000000-0000-4000-8000-000000000002';
const rows = [{ id: '9', title: '无关问题', body: 'internal secret content', state: 'closed', url: `${target.repository}/-/issues/9` }];
let creates = 0;
const repo = {
  async list() { return structuredClone(rows); },
  async create(title, body) {
    creates++;
    const issue = { id: String(10 + creates), title, body, state: 'opened', url: `${target.repository}/-/issues/${10 + creates}` };
    rows.push(issue); return issue;
  }
};
const server = createFeedbackRelay({ target }, repo).listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
async function post(route, payload) {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
try {
  const title = '切换工作区后列表滚动位置丢失';
  const before = await (await post('/v1/matches', { title })).json();
  assert.deepEqual(before.issues, []);
  const make = marker => ({ target, title, seen: before.issues, body: `实际情况\n\n<!-- muster-feedback:${marker} -->` });
  const responses = await Promise.all([post('/v1/issues', make(marker1)), post('/v1/issues', make(marker2))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(creates, 1, 'the relay serializes competing feedback and rechecks the repository');
  const after = await (await post('/v1/matches', { title })).json();
  assert.equal(after.issues.length, 1);
  assert.equal(after.issues[0].body, '', 'ordinary searches do not reveal issue descriptions');
  assert.ok(!JSON.stringify(after).includes('internal secret content'));
  const createdBody = rows.at(-1).body;
  const createdMarker = createdBody.match(/muster-feedback:([^ ]+)/)[1];
  const reconcile = await (await post('/v1/matches', { title: '标题后来被修改', marker: createdMarker })).json();
  assert.equal(reconcile.issues[0].body, `<!-- muster-feedback:${createdMarker} -->`);
  assert.equal((await post('/v1/issues', { ...make(marker2), target: { provider: 'github', repository: 'https://github.com/evil/repo' } })).status, 409);
  assert.equal((await post('/v1/issues', { ...make(marker2), body: 'without marker' })).status, 400);
  assert.equal((await fetch(`${base}/v1/matches`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post('/v1/matches', { title: 'x'.repeat(181) })).status, 400);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-feedback-relay-test-'));
  try {
    const bundle = path.join(temp, 'client.cjs');
    await build({ entryPoints: [path.resolve('test/fixtures/feedback-relay-client.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const { FeedbackService, createDirectFeedbackRemote, normalizedTitle, titleSimilarity: clientSimilarity } = createRequire(import.meta.url)(bundle);
    for (const [a, b] of [['切换工作区后列表位置丢失', '切换工作区时列表位置丢失'], ['ISSUE 信息', 'issue 信息！'], ['ＡＢＣ', 'abc'], ['a', 'b']]) {
      assert.equal(clientSimilarity(a, b), titleSimilarity(a, b), 'desktop and relay must use the same similarity rule');
      if (clientSimilarity(a, b) === 1) assert.equal(normalizedTitle(a), normalizedTitle(b));
    }
    const service = new FeedbackService({ file: path.join(temp, 'queue.json'), appVersion: 'test', remote: createDirectFeedbackRemote(async (_url, init) => {
      assert.equal(init.headers['PRIVATE-TOKEN'], 'fixture-token');
      if (init.method === 'POST') {
        const payload = JSON.parse(init.body); const issue = await repo.create(payload.title, payload.description);
        return Response.json({ iid: Number(issue.id), title: issue.title, description: issue.body, state: issue.state, web_url: issue.url }, { status: 201 });
      }
      return Response.json(rows.map(issue => ({ iid: Number(issue.id), title: issue.title, description: issue.body, state: issue.state, web_url: issue.url })));
    }, target, async () => 'fixture-token') });
    const draft = { kind: 'bug', title: '任务完成后没有通知', area: '通知', context: '完成一个任务', actual: '没有提示', expected: '显示通知', steps: '等待任务完成', impact: '用户不知道结果', evidence: '一次观察', suggestion: '' };
    const id = service.propose([draft], 'Worker A')[0].id;
    const review = await service.prepare(id, 1);
    assert.equal(creates, 1, 'preparing and reviewing never creates an issue');
    const result = await service.submit(id, 1, review.reviewId, false);
    assert.equal(result.entries[0].status, 'submitted');
    assert.equal(creates, 2, 'the production desktop client submits through its direct credential-backed remote');
  } finally {
    if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('ma-feedback-relay-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(temp, { recursive: true, force: true });
  }
} finally { server.close(); await once(server, 'close'); }
console.log('feedback relay: GitLab/GitHub requests, privacy, validation, concurrency, and desktop round trip passed');
