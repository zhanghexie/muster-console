import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { FeedbackService } from '../../../src/main/feedback/service';
import type { FeedbackDraft, FeedbackTarget } from '../../../src/shared/feedback';
import type { RemoteIssue } from '../../../src/main/feedback/remote';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('ma-feedback-history-')) throw new Error('Unsafe cleanup');
  fs.rmSync(root, { recursive: true, force: true });
} });
const target: FeedbackTarget = { provider: 'gitlab', repository: 'https://gitlab.example.test/a/b' };
const draft = (title: string): FeedbackDraft => ({ kind: 'bug', title, area: '会话', context: '切换工作区', actual: '位置丢失', expected: '保持位置', steps: '切换后返回', impact: '需要重新定位', evidence: '', suggestion: '' });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-feedback-history-')); roots.push(root);
  const rows: RemoteIssue[] = [];
  const detailRows = new Map<string, RemoteIssue>();
  let online = true;
  const lookup = vi.fn(async () => { if (!online) throw new Error('offline'); return { target, issues: structuredClone(rows) }; });
  const create = vi.fn(async (_target: FeedbackTarget, title: string, body: string) => ({ id: '99', title, body, state: 'opened', url: `${target.repository}/-/issues/99` }));
  const wake = vi.fn();
  const details = vi.fn(async (id: string) => detailRows.get(id)!);
  const service = new FeedbackService({ file: path.join(root, 'queue.json'), appVersion: 'test', remote: { history: lookup, find: lookup, details, create }, needsAiCheck: wake });
  return { service, rows, detailRows, wake, create, offline: () => { online = false; }, online: () => { online = true; } };
}

it('lets the AI read all local drafts and issue descriptions, regardless of title similarity', async () => {
  const f = fixture();
  f.service.propose([draft('列表阅读位置重置')], 'private workspace · worker');
  f.rows.push({ id: '8', title: '返回工作区时需要重新寻找会话', body: '切换工作区后滚动回到顶部', state: 'closed', url: `${target.repository}/-/issues/8` });
  const history = await f.service.history('worker:a');
  expect(history.remoteAvailable).toBe(true);
  expect(history.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'local', title: '列表阅读位置重置', body: expect.stringContaining('位置丢失') }),
    expect.objectContaining({ source: 'remote', title: '返回工作区时需要重新寻找会话', body: expect.stringContaining('滚动回到顶部'), status: 'closed' })
  ]));
  expect(JSON.stringify(history)).not.toContain('private workspace');
  expect(f.create).not.toHaveBeenCalled();
});

it('requires every page and the same caller, and invalidates a snapshot when another AI writes', async () => {
  const f = fixture();
  for (let i = 0; i < 11; i++) f.service.propose([draft(`问题 ${i}`)], 'other');
  const first = await f.service.history('worker:a');
  expect(first.hasMore).toBe(true);
  await expect(f.service.proposeChecked([draft('新问题')], 'a', 'worker:a', first.checkId)).rejects.toThrow('完整读取');
  await expect(f.service.history('worker:b', first.checkId)).rejects.toThrow('过期');
  const last = await f.service.history('worker:a', first.checkId);
  expect(last.hasMore).toBe(false);
  f.service.propose([draft('并发增加的其他反馈')], 'b');
  await expect(f.service.proposeChecked([draft('新问题')], 'a', 'worker:a', first.checkId)).rejects.toThrow('历史已变化');
});

it('prevents two AIs from simultaneously writing against the same local history snapshot', async () => {
  const f = fixture();
  const a = await f.service.history('worker:a');
  const b = await f.service.history('worker:b');
  const results = await Promise.allSettled([
    f.service.proposeChecked([draft('返回工作区阅读位置重置')], 'a', 'worker:a', a.checkId),
    f.service.proposeChecked([draft('切换回来后需要重新寻找会话')], 'b', 'worker:b', b.checkId)
  ]);
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(f.service.snapshot().entries).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected');
  expect(rejected && rejected.status === 'rejected' ? rejected.reason.message : '').toContain('历史已变化');
});

it('keeps every history page within the tool-result budget, including JSON escapes', async () => {
  const f = fixture();
  for (let i = 1; i <= 11; i++) f.rows.push({ id: String(i), title: `历史问题 ${i}`, body: '\u0000"\\'.repeat(1300), state: 'closed', url: `${target.repository}/-/issues/${i}` });
  let page = await f.service.history('worker:a');
  const seen: string[] = [];
  let truncated = false;
  for (;;) {
    expect(JSON.stringify({ ok: true, result: page }).length).toBeLessThanOrEqual(9000);
    seen.push(...page.items.map(item => item.id));
    truncated ||= page.items.some(item => item.bodyTruncated === true);
    if (!page.hasMore) break;
    page = await f.service.history('worker:a', page.checkId);
  }
  expect(seen).toEqual(Array.from({ length: 11 }, (_, index) => String(index + 1)));
  expect(truncated).toBe(true);
  await expect(f.service.proposeChecked([draft('独立的新问题')], 'a', 'worker:a', page.checkId)).resolves.toHaveLength(1);
});

it('lets AI read the remainder of a truncated issue and rejects changed contents', async () => {
  const f = fixture();
  const body = '前半段'.repeat(1600) + '末尾的关键复现条件';
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const issue = { id: '7', title: '历史反馈', body, bodyHash, state: 'closed', url: `${target.repository}/-/issues/7` };
  f.rows.push({ ...issue, body: body.slice(0, 4000), bodyTruncated: true });
  f.detailRows.set(issue.id, issue);
  const history = await f.service.history('worker:a');
  expect(history.items[0]?.bodyTruncated).toBe(true);
  let offset = 0, complete = '';
  for (;;) {
    const part = await f.service.historyDetail('worker:a', history.checkId, 'remote', '7', offset);
    expect(JSON.stringify({ ok: true, result: part }).length).toBeLessThanOrEqual(9000);
    complete += part.text;
    if (part.nextOffset === undefined) break;
    offset = part.nextOffset;
  }
  expect(complete).toBe(body);
  f.detailRows.set(issue.id, { ...issue, body: '变了', bodyHash: createHash('sha256').update('变了').digest('hex') });
  await expect(f.service.historyDetail('worker:a', history.checkId, 'remote', '7')).rejects.toThrow('历史已变化');
});

it('retains offline drafts but waits for AI comparison before submission', async () => {
  const f = fixture(); f.offline();
  const history = await f.service.history('worker:a');
  expect(history).toMatchObject({ remoteAvailable: false, remoteError: expect.stringContaining('只能比较本机') });
  const [created] = await f.service.proposeChecked([draft('独立问题')], 'a', 'worker:a', history.checkId);
  expect(f.service.snapshot().entries[0]?.aiChecked).toBe(false);
  await expect(f.service.prepare(created!.id, 1)).rejects.toThrow('等待 AI 查重');
  expect(f.wake).toHaveBeenCalled();
  f.online();
  const recheck = await f.service.history('scheduler');
  await f.service.assess('scheduler', recheck.checkId, [{ id: created!.id, revision: 1 }]);
  expect(f.service.snapshot().entries[0]?.aiChecked).toBe(true);
  const review = await f.service.prepare(created!.id, 2);
  await f.service.submit(created!.id, 2, review.reviewId, false);
  expect(f.create).toHaveBeenCalledOnce();
});

it('allows AI to mark a semantically duplicate draft and invalidates checked drafts when history changes', async () => {
  const f = fixture();
  const [old] = f.service.propose([draft('返回工作区时需要重新寻找会话')], 'a', false);
  f.rows.push({ id: '8', title: '列表阅读位置重置', body: '切换工作区后滚动回到顶部', state: 'closed', url: `${target.repository}/-/issues/8` });
  const history = await f.service.history('scheduler');
  await f.service.assess('scheduler', history.checkId, [{ id: old!.id, revision: 1, duplicateOf: { source: 'remote', id: '8' } }]);
  expect(f.service.snapshot().entries[0]).toMatchObject({ status: 'duplicate', issueUrl: `${target.repository}/-/issues/8` });
  const next = await f.service.history('worker:b');
  const [created] = await f.service.proposeChecked([draft('面板无法关闭')], 'b', 'worker:b', next.checkId);
  f.rows.push({ id: '9', title: '不同措辞的新反馈', body: '面板无法关闭', state: 'opened', url: `${target.repository}/-/issues/9` });
  await expect(f.service.prepare(created!.id, 1)).rejects.toThrow('等待 AI 重新查重');
  expect(f.service.snapshot().entries.find(e => e.id === created!.id)).toMatchObject({ aiChecked: false, revision: 2 });
  expect(f.create).not.toHaveBeenCalled();
});
