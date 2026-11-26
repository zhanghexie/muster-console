/**
 * T3.2 webhook 校验单测：GitHub X-Hub-Signature-256 签名校验 + payload 归一化。
 * 运行: node test/webhook-verify.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hookver-'));
const compile = createSharedCompiler(root, tmp);
const { verifyHubSignature256 } = await import(pathToFileURL(compile('main/webAccess/hookVerify.ts')).href);
const { normalizeWebhookEvent, buildWebhookTriggerEvent } = await import(
  pathToFileURL(compile('shared/webhookPayload.ts')).href
);

// ---------- verifyHubSignature256 ----------
const SECRET = 's3cr3t-hook';
const BODY = Buffer.from(JSON.stringify({ hello: 'world', n: 1 }));
const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

assert.equal(verifyHubSignature256(SECRET, BODY, sign(SECRET, BODY)), true, '正确签名通过');
assert.equal(verifyHubSignature256(SECRET, BODY, sign(SECRET, BODY).toUpperCase()), true, '大写 hex 也接受');
assert.equal(verifyHubSignature256(SECRET, BODY, sign('other-secret', BODY)), false, '错密钥拒绝');
assert.equal(verifyHubSignature256(SECRET, Buffer.from('tampered'), sign(SECRET, BODY)), false, '篡改 body 拒绝');
assert.equal(verifyHubSignature256(SECRET, BODY, undefined), false, '缺头拒绝');
assert.equal(verifyHubSignature256(SECRET, BODY, ''), false, '空头拒绝');
assert.equal(verifyHubSignature256(SECRET, BODY, 'sha1=abcdef'), false, 'sha1 前缀拒绝');
assert.equal(verifyHubSignature256(SECRET, BODY, `sha256=${'a'.repeat(63)}`), false, '摘要长度不对拒绝');
assert.equal(verifyHubSignature256(SECRET, BODY, `sha256=${'z'.repeat(64)}`), false, '摘要非 hex 拒绝');
assert.equal(verifyHubSignature256(SECRET, BODY, sign(SECRET, BODY).replace('sha256=', '')), false, '缺等号拒绝');
assert.equal(verifyHubSignature256('', BODY, sign('', BODY)), true, '空密钥仍按 HMAC 计算（调用方负责“空=不校验”）');
console.log('ok: verifyHubSignature256 全分支');

// ---------- normalizeWebhookEvent ----------
const push = normalizeWebhookEvent('push', {
  ref: 'refs/heads/main',
  repository: { full_name: 'acme/app' },
  commits: [{}, {}]
});
assert.equal(push.type, 'push');
assert.match(push.note, /acme\/app/);
assert.match(push.note, /main/);
assert.match(push.note, /2 commits/);
assert.equal(normalizeWebhookEvent('push', { ref: 'refs/tags/v1.0.0', commits: [] }).note.includes('v1.0.0'), true, 'tag ref 去前缀');

const issue = normalizeWebhookEvent('issues', { action: 'opened', issue: { number: 7, title: 'Bug report' } });
assert.equal(issue.type, 'issue');
assert.match(issue.note, /#7/);
assert.match(issue.note, /opened/);
assert.match(issue.note, /Bug report/);

const comment = normalizeWebhookEvent('issue_comment', {
  action: 'created',
  issue: { number: 12 },
  comment: { body: 'please fix\nsoon' }
});
assert.equal(comment.type, 'comment');
assert.match(comment.note, /#12/);
assert.match(comment.note, /please fix soon/, '评论正文折叠空白');

assert.equal(normalizeWebhookEvent('issue_comment', { action: 'edited' }), null, '评论编辑不触发');
assert.equal(normalizeWebhookEvent('issue_comment', { action: 'deleted' }), null, '评论删除不触发');
assert.equal(normalizeWebhookEvent('ping', { zen: 'x' }), null, 'ping 不触发');
assert.equal(normalizeWebhookEvent('pull_request', { action: 'opened' }), null, 'PR 事件缺少仓库、编号和 SHA 时忽略');
const pullRequest = { action: 'ready_for_review', number: 9, repository: { full_name: 'team/project' },
  pull_request: { head: { sha: 'f'.repeat(40) } } };
assert.equal(normalizeWebhookEvent('pull_request', pullRequest).type, 'pull_request.ready_for_review');
assert.equal(normalizeWebhookEvent('pull_request_review_comment', { ...pullRequest, action: 'created' }).type, 'pull_request_review_comment.created');
assert.equal(normalizeWebhookEvent('check_run', { action: 'completed', repository: pullRequest.repository,
  check_run: { head_sha: 'f'.repeat(40) } }).type, 'check_run.completed');
assert.equal(normalizeWebhookEvent(undefined, {}), null, '缺事件名不归一到具体类型');
console.log('ok: normalizeWebhookEvent push/issues/comment + 忽略');

// ---------- buildWebhookTriggerEvent ----------
const built = buildWebhookTriggerEvent('push', { ref: 'refs/heads/dev', commits: [] }, 1234);
assert.equal(built.event.kind, 'webhook');
assert.equal(built.event.at, 1234);
assert.equal(built.event.eventType, 'push');
assert.equal(typeof built.note, 'string');
assert.equal(buildWebhookTriggerEvent('pull_request', {}), null, '未映射事件返回 null');
const manual = buildWebhookTriggerEvent(undefined, {}, 99);
assert.equal(manual.event.kind, 'webhook');
assert.equal(manual.event.eventType, undefined, '手动 curl 为通用触发（不过滤事件类型）');
assert.equal(manual.event.at, 99);
// 畸形 payload：非对象 -> 空对象兜底，不抛
const weird = buildWebhookTriggerEvent('push', 'not-an-object', 5);
assert.equal(weird.event.eventType, 'push');
assert.match(weird.note, /0 commits/);
console.log('ok: buildWebhookTriggerEvent 归一/通用/畸形兜底');

console.log('webhook-verify: ok');
