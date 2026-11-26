import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackService } from '../../../src/main/feedback/service';
import { FeedbackRemoteError, normalizeFeedbackTarget, type FeedbackRemote, type RemoteIssue } from '../../../src/main/feedback/remote';
import type { FeedbackDraft, FeedbackTarget } from '../../../src/shared/feedback';

const fakeGitLabToken = 'glpat-' + 'a'.repeat(20);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('muster-feedback-')) throw new Error('Unsafe test cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
} });

const draft = (title = '切换工作区后列表滚动位置丢失'): FeedbackDraft => ({ kind: 'bug', title, area: '会话列表', context: '两个工作区之间切换', actual: '回到顶部', expected: '恢复阅读位置', steps: '滚动列表，切换工作区后返回', impact: '需要重新定位', evidence: '仅在当前环境观察一次', suggestion: '' });
const target: FeedbackTarget = { provider: 'gitlab', repository: 'https://gitlab.example.test/group/project' };
function fixture(remote: FeedbackRemote) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-feedback-')); roots.push(root);
  const file = path.join(root, 'queue.json');
  const options = { file, appVersion: '0.1.31', remote };
  return { file, options, service: new FeedbackService(options) };
}
function remoteFixture() {
  const rows: RemoteIssue[] = [];
  const list = vi.fn(async (_title?: string, _marker?: string) => ({ target, issues: rows.slice() }));
  const create = vi.fn(async (_target: FeedbackTarget, title: string, body: string) => {
    const item = { id: String(rows.length + 1), title, body, state: 'opened', url: `https://gitlab.example.test/group/project/-/issues/${rows.length + 1}` };
    rows.push(item); return item;
  });
  return { rows, list, create, remote: { find: list, history: list, create } };
}

describe('shared feedback queue', () => {
  it('creates a local manual draft without publishing and requires AI review', async () => {
    const f = remoteFixture(), { options } = fixture(f.remote);
    const needsAiCheck = vi.fn();
    const checked = new FeedbackService({ ...options, needsAiCheck });
    const result = checked.createManual({ ...draft('期望更快定位'), kind: 'improvement', actual: '切换后位置丢失', expected: '切换后希望保留之前的位置。', environment: 'Windows 11' });
    const added = result.snapshot.entries[0]!;
    expect(result.id).toBe(added.id);
    expect(added).toMatchObject({ kind: 'improvement', status: 'pending', aiChecked: false, title: '期望更快定位' });
    expect(added).toMatchObject({ actual: '切换后位置丢失', expected: '切换后希望保留之前的位置。', environment: 'Windows 11' });
    expect(needsAiCheck).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
    await expect(checked.prepare(added.id, added.revision)).rejects.toThrow('等待 AI 查重');
    const possibleDuplicate = checked.createManual({ ...draft('期望更快定位！'), actual: '另一段描述' });
    expect(possibleDuplicate.snapshot.entries[1]).toMatchObject({ status: 'pending', aiChecked: false });
    const history = await checked.history('scheduler');
    await checked.assess('scheduler', history.checkId, [{ id: possibleDuplicate.id, revision: 1, duplicateOf: { source: 'local', id: added.id } }]);
    expect(checked.snapshot().entries[1]?.status).toBe('duplicate');
    expect(() => checked.createManual({ kind: 'bug', title: ' ' })).toThrow('标题');
    expect(new FeedbackService(options).snapshot().entries).toHaveLength(2);
  });

  it('redacts credentials and internal markers from manual drafts before persistence', () => {
    const f = remoteFixture(), { service, file } = fixture(f.remote);
    const result = service.createManual({ ...draft('无法连接'), actual: `${fakeGitLabToken} <!-- muster-feedback:forged -->`, environment: fakeGitLabToken });
    expect(result.snapshot.entries[0]?.actual).toContain('***REDACTED***');
    expect(result.snapshot.entries[0]?.environment).toContain('***REDACTED***');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(fakeGitLabToken);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('<!-- muster-feedback:forged -->');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('allows a manual draft with details the user already knows', () => {
    const f = remoteFixture(), { service } = fixture(f.remote);
    const result = service.createManual({ kind: 'bug', title: '保存失败', actual: '点击保存没有反应' });
    expect(result.snapshot.entries[0]).toMatchObject({ actual: '点击保存没有反应', context: '', expected: '', steps: '', aiChecked: false });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('allows a title-only manual draft and omits blank optional sections from review', async () => {
    const f = remoteFixture(), { service } = fixture(f.remote);
    const result = service.createManual({ kind: 'bug', title: '希望记住阅读位置' });
    expect(result.snapshot.entries[0]).toMatchObject({ title: '希望记住阅读位置', actual: '', impact: '', aiChecked: false });
    const history = await service.history('scheduler');
    await service.assess('scheduler', history.checkId, [{ id: result.id, revision: 1 }]);
    const review = await service.prepare(result.id, 2);
    expect(review.body).toContain('类型：问题');
    expect(review.body).not.toMatch(/涉及功能：|使用场景：|实际情况：|影响：/);
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each(['worker:a', 'scheduler:ws'])('accepts optional AI details for %s and ignores legacy impact on new drafts', async (owner) => {
    const f = remoteFixture(), { service, file } = fixture(f.remote);
    const history = await service.history(owner);
    const [created] = await service.proposeChecked([{ kind: 'bug', title: '保存失败', actual: '', impact: '旧调用方提供的影响' }], owner, owner, history.checkId);
    const entry = service.snapshot().entries[0]!;
    expect(entry).toMatchObject({ title: '保存失败', area: '', context: '', actual: '', expected: '', steps: '', impact: '', aiChecked: true });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('旧调用方提供的影响');
    expect(f.create).not.toHaveBeenCalled();
    const review = await service.prepare(created!.id, 1);
    expect(review.body).toContain('类型：问题');
    expect(review.body).not.toMatch(/涉及功能：|实际情况：|影响：/);
    await service.submit(created!.id, 1, review.reviewId, false);
    expect(f.create.mock.calls[0]![2]).not.toContain('旧调用方提供的影响');
  });

  it('still requires a valid AI feedback type and title', () => {
    const f = remoteFixture(), { service } = fixture(f.remote);
    expect(() => service.propose([{ title: '没有类型' }], 'worker:a')).toThrow('类型');
    expect(() => service.propose([{ kind: 'bug' }], 'worker:a')).toThrow('标题');
    expect(() => service.propose([{ kind: 'bug', title: '   ' }], 'worker:a')).toThrow('标题');
    expect(service.snapshot().entries).toHaveLength(0);
  });

  it('preserves impact in previously saved feedback throughout history, editing and review', async () => {
    const f = remoteFixture(), { service, options } = fixture(f.remote);
    const legacy = service.createManual({ ...draft('旧反馈'), impact: '已记录的旧影响' });
    const restored = new FeedbackService(options);
    expect(restored.snapshot().entries[0]?.impact).toBe('已记录的旧影响');
    const history = await restored.history('scheduler:ws');
    expect(history.items[0]?.body).toContain('影响：已记录的旧影响');
    const edited = restored.update(legacy.id, 1, { ...draft('旧反馈'), impact: '已记录的旧影响' });
    expect(edited.entries[0]?.impact).toBe('已记录的旧影响');
    const fresh = await restored.history('scheduler:ws');
    await restored.assess('scheduler:ws', fresh.checkId, [{ id: legacy.id, revision: 2 }]);
    const review = await restored.prepare(legacy.id, 3);
    expect(review.body).toContain('已记录的旧影响');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('includes manual environment in AI history and removes hidden old values after an edit', async () => {
    const f = remoteFixture(), { service, file } = fixture(f.remote);
    const result = service.createManual({ kind: 'bug', title: '显示异常', actual: '界面空白', environment: 'Windows 11 专用环境' });
    const history = await service.history('scheduler');
    expect(history.items[0]?.body).toContain('Windows 11 专用环境');
    const edited = service.updateText(result.id, 1, '显示异常\n\n实际情况：\n已经修改').entries[0]!;
    expect(edited.environment).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('Windows 11 专用环境');
  });
  it('saves the single visible editor as the exact Issue title and body, without retaining removed text', async () => {
    const f = remoteFixture(), { service, file } = fixture(f.remote);
    const id = service.propose([draft()], 'worker:a')[0]!.id;
    expect(() => service.updateText(id, 1, '只有标题')).toThrow('反馈正文');
    expect(() => service.updateText(id, undefined as unknown as number, '标题\n\n正文')).toThrow('已变化');
    const text = '新的标题\n\n## 实际情况\n用户修改后的内容\n\n## 影响\n需要重新定位';
    const saved = service.updateText(id, 1, text).entries[0]!;
    expect(saved).toMatchObject({ title: '新的标题', editedBody: '## 实际情况\n用户修改后的内容\n\n## 影响\n需要重新定位', aiChecked: false });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('两个工作区之间切换');
    const history = await service.history('scheduler');
    expect(history.items[0]?.body).toBe(saved.editedBody);
    await service.assess('scheduler', history.checkId, [{ id, revision: 2 }]);
    const review = await service.prepare(id, 3);
    expect(review.body).toBe(`${saved.editedBody}\n\n<!-- muster-feedback:${id} -->`);
    await service.submit(id, 3, review.reviewId, false);
    expect(f.create.mock.calls[0]![1]).toBe('新的标题');
    expect(f.create.mock.calls[0]![2]).toBe(review.body);
  });

  it('redacts credentials and strips forged internal markers from edited text', () => {
    const f = remoteFixture(), { service, file } = fixture(f.remote);
    const id = service.propose([draft()], 'worker:a')[0]!.id;
    const saved = service.updateText(id, 1, `标题\n\n日志：${fakeGitLabToken}\n<!-- muster-feedback:forged -->`).entries[0]!;
    expect(saved.editedBody).not.toContain(fakeGitLabToken);
    expect(saved.editedBody).not.toContain('<!-- muster-feedback:forged -->');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(fakeGitLabToken);
  });

  it('deletes only the selected local record, invalidates stale checks and leaves remote Issues intact', async () => {
    const f = remoteFixture(), { service, options } = fixture(f.remote);
    const [first, second] = service.propose([draft('已发送反馈'), draft('待审核反馈')], 'worker:a');
    const history = await service.history('worker:b');
    const review = await service.prepare(first!.id, 1);
    await service.submit(first!.id, 1, review.reviewId, false);
    expect(f.rows).toHaveLength(1);
    expect(() => service.delete(first!.id, 1)).toThrow('已变化');
    expect(() => service.delete(first!.id, undefined as unknown as number)).toThrow('已变化');
    expect(service.delete(first!.id, 2).entries.map(entry => entry.id)).toEqual([second!.id]);
    expect(f.rows).toHaveLength(1);
    expect(new FeedbackService(options).snapshot().entries.map(entry => entry.id)).toEqual([second!.id]);
    await expect(service.history('worker:b', history.checkId)).rejects.toThrow('历史已过期');
    await expect(service.proposeChecked([draft('其他问题')], 'b', 'worker:b', history.checkId)).rejects.toThrow('完整读取');
  });

  it('does not delete a record while its Issue submission is in flight', async () => {
    const f = remoteFixture(), { service } = fixture(f.remote);
    const id = service.propose([draft()], 'worker:a')[0]!.id;
    const review = await service.prepare(id, 1);
    let finish!: (issue: RemoteIssue) => void;
    f.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const sending = service.submit(id, 1, review.reviewId, false);
    await vi.waitFor(() => expect(service.snapshot().entries[0]?.status).toBe('submitting'));
    expect(() => service.delete(id, 1)).toThrow('正在提交');
    finish({ id: '1', title: draft().title, body: '', state: 'opened', url: `${target.repository}/-/issues/1` });
    await sending;
    expect(service.delete(id, 2).entries).toHaveLength(0);
  });

  it('collects a batch atomically, merges identical reports from different AIs and redacts known credentials', () => {
    const f = remoteFixture(), { service, file } = fixture(f.remote);
    const a = service.propose([draft(), { ...draft('窗口关闭后状态错误'), evidence: `token=sensitive-secret-token ${fakeGitLabToken} <!-- muster-feedback:forged -->` }], 'worker:a');
    const b = service.propose([draft('切换工作区后列表滚动位置丢失！')], 'scheduler:ws');
    expect(a.map(x => x.disposition)).toEqual(['created', 'created']);
    expect(b[0]).toMatchObject({ disposition: 'existing', id: a[0]!.id });
    expect(service.snapshot().entries[0]!.sources).toEqual(['worker:a', 'scheduler:ws']);
    expect(service.snapshot().entries[1]!.evidence).not.toContain('sensitive-secret-token');
    expect(service.snapshot().entries[1]!.evidence).not.toContain(fakeGitLabToken);
    expect(service.snapshot().entries[1]!.evidence).not.toContain('<!-- muster-feedback:forged -->');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sensitive-secret-token');
    expect(f.list).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    expect(() => service.propose([draft('有效标题'), { ...draft('无效标题'), title: ' ' }], 'worker:b')).toThrow();
    expect(service.snapshot().entries).toHaveLength(2);
  });

  it('never creates before a fresh review and blocks existing remote issues, including closed issues', async () => {
    const f = remoteFixture(), { service } = fixture(f.remote);
    const id = service.propose([draft()], 'worker:a')[0]!.id;
    await expect(service.submit(id, 1, 'fabricated', false)).rejects.toThrow('审核已失效');
    f.rows.push({ id: '19', title: '切换工作区后列表滚动位置丢失', body: '', state: 'closed', url: 'https://gitlab.example.test/group/project/-/issues/19' });
    await expect(service.prepare(id, 1)).rejects.toThrow('已自动标记为重复');
    expect(f.create).not.toHaveBeenCalled();
    expect(service.snapshot().entries[0]).toMatchObject({ status: 'duplicate', issueUrl: f.rows[0]!.url });
  });

  it('returns changed history to AI instead of asking a human to compare matches', async () => {
    const f = remoteFixture(), { service } = fixture(f.remote);
    const id = service.propose([draft()], 'worker:a')[0]!.id;
    const first = await service.prepare(id, 1);
    service.propose([draft('切换工作区后会话列表滚动位置丢失')], 'worker:b');
    await expect(service.submit(id, 1, first.reviewId, false)).rejects.toThrow('等待 AI 重新查重');
    const history = await service.history('scheduler');
    await service.assess('scheduler', history.checkId, [{ id, revision: 2 }]);
    const next = await service.prepare(id, 3);
    expect(next.matches.length).toBeGreaterThan(0);
    await service.submit(id, 3, next.reviewId, false);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.create.mock.calls[0]![2]).toContain(`<!-- muster-feedback:${id} -->`);
  });

  it('fails closed on remote lookup failure, stale edits and changed target', async () => {
    const f = remoteFixture(), { service, options } = fixture(f.remote);
    const id = service.propose([draft()], 'worker:a')[0]!.id;
    f.list.mockRejectedValueOnce(new Error('offline'));
    await expect(service.prepare(id, 1)).rejects.toThrow('offline');
    expect(f.create).not.toHaveBeenCalled();
    const review = await service.prepare(id, 1);
    service.update(id, 1, { ...draft(), impact: '阻断继续工作' });
    await expect(service.submit(id, 1, review.reviewId, false)).rejects.toThrow('已变化');
    const history = await service.history('scheduler');
    await service.assess('scheduler', history.checkId, [{ id, revision: 2 }]);
    const fresh = await service.prepare(id, 3);
    f.list.mockResolvedValueOnce({ target: { provider: 'github', repository: 'https://github.com/org/project' }, issues: [] });
    await expect(service.submit(id, 3, fresh.reviewId, false)).rejects.toThrow('等待 AI 重新查重');
    const migrated = new FeedbackService(options);
    await expect(migrated.submit(id, 4, fresh.reviewId, false)).rejects.toThrow('审核已失效');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('keeps a timed-out POST uncertain across restart and reconciles by its marker without retrying', async () => {
    const f = remoteFixture(), { service, options } = fixture(f.remote);
    const id = service.propose([draft()], 'worker:a')[0]!.id;
    f.create.mockImplementationOnce(async (_target, title, body) => {
      f.rows.push({ id: '22', title, body, state: 'opened', url: 'https://gitlab.example.test/group/project/-/issues/22' });
      throw new FeedbackRemoteError('timeout', true);
    });
    const review = await service.prepare(id, 1);
    await expect(service.submit(id, 1, review.reviewId, false)).rejects.toThrow('timeout');
    const restored = new FeedbackService(options);
    expect(restored.snapshot().entries[0]!.status).toBe('uncertain');
    await expect(restored.prepare(id, 2)).rejects.toThrow('待审核');
    expect((await restored.reconcile(id, 2)).entries[0]).toMatchObject({ status: 'submitted', issueUrl: f.rows[0]!.url });
    expect(f.create).toHaveBeenCalledOnce();
  });
});

it('rejects credentials embedded in the feedback repository URL', () => {
  expect(() => normalizeFeedbackTarget({ provider: 'github', repository: 'https://user:pass@github.com/a/b' })).toThrow('仓库信息无效');
});

describe('public GitHub browser handoff', () => {
  const github: FeedbackTarget = { provider: 'github', repository: 'https://github.com/zhanghexie/muster-console' };

  function handoffFixture() {
    const { create } = remoteFixture();
    const rows: RemoteIssue[] = [];
    const find = vi.fn(async () => ({ target: github, issues: rows.slice() }));
    const { options } = fixture({ create, find, history: find });
    const openIssue = vi.fn<(url: string) => Promise<void>>(async () => {});
    const copyBody = vi.fn<(body: string) => Promise<void>>(async () => {});
    const browserOptions = { ...options, issuePage: { open: openIssue, copyBody } };
    const service = new FeedbackService(browserOptions);
    const propose = async (input: FeedbackDraft) => {
      const history = await service.history('worker-a');
      const [result] = await service.proposeChecked([input], 'worker-a', 'worker-a', history.checkId);
      return result!.id;
    };
    return { service, create, rows, openIssue, copyBody, browserOptions, propose };
  }

  it('requires the exact review, prefills the Issue and keeps it opened after restart', async () => {
    const { service, create, openIssue, copyBody, rows, browserOptions, propose } = handoffFixture();
    const id = await propose(draft('Title & #tag'));
    const review = await service.prepare(id, 1);
    await expect(service.submit(id, 1, 'unreviewed', false)).rejects.toThrow('审核已失效');
    expect(openIssue).not.toHaveBeenCalled();
    await expect(service.submit(id, 1, review.reviewId, false)).resolves.toMatchObject({ entries: [{ status: 'opened', submissionTarget: github }] });
    const url = new URL(openIssue.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe(github.repository + '/issues/new');
    expect(url.searchParams.get('title')).toBe('Title & #tag');
    expect(url.searchParams.get('body')).toBe(review.body);
    expect(copyBody).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const reopened = new FeedbackService(browserOptions);
    await expect(reopened.reconcile(id, 2)).rejects.toThrow('还没有找到这条 Issue');
    expect(reopened.snapshot().entries[0]).toMatchObject({ status: 'opened' });
    rows.push({ id: '27', title: 'User changed the title', body: review.body, state: 'open', url: github.repository + '/issues/27' });
    await expect(reopened.reconcile(id, 2, true)).resolves.toMatchObject({ entries: [{ status: 'submitted', issueUrl: github.repository + '/issues/27' }] });
  });

  it('copies a long body intact and can copy it again after a restart', async () => {
    const { service, openIssue, copyBody, browserOptions, propose } = handoffFixture();
    const id = await propose({ ...draft(), actual: '长内容'.repeat(600) });
    const review = await service.prepare(id, 1);
    expect(review.copyBody).toBe(true);
    await expect(service.copyIssueBody(id, 1)).rejects.toThrow('只有已打开 GitHub');
    expect(copyBody).not.toHaveBeenCalled();
    await service.submit(id, 1, review.reviewId, false);
    const [url] = openIssue.mock.calls[0]!;
    expect(url.length).toBeLessThanOrEqual(2000);
    expect(new URL(url).searchParams.has('body')).toBe(false);
    expect(copyBody).toHaveBeenCalledWith(review.body);
    expect(review.body).toContain(`<!-- muster-feedback:${id} -->`);

    const reopened = new FeedbackService(browserOptions);
    copyBody.mockClear();
    await expect(reopened.copyIssueBody(id, 1)).rejects.toThrow('反馈已变化');
    expect(copyBody).not.toHaveBeenCalled();
    copyBody.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    await expect(reopened.copyIssueBody(id, 2)).rejects.toThrow('无法复制 Issue 正文');
    await reopened.copyIssueBody(id, 2);
    expect(copyBody).toHaveBeenLastCalledWith(review.body);
    expect(openIssue).toHaveBeenCalledOnce();
    expect(reopened.snapshot().entries[0]).toMatchObject({ status: 'opened', revision: 2 });
    await expect(reopened.reconcile(id, 2, true)).resolves.toMatchObject({ entries: [{ status: 'pending', aiChecked: false }] });
  });

  it('keeps a long draft reviewable when its body cannot be copied before opening GitHub', async () => {
    const { service, openIssue, copyBody, propose } = handoffFixture();
    const id = await propose({ ...draft(), actual: '长内容'.repeat(600) });
    const review = await service.prepare(id, 1);
    copyBody.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    await expect(service.submit(id, 1, review.reviewId, false)).rejects.toThrow('检查默认浏览器或剪贴板后重试');
    expect(openIssue).not.toHaveBeenCalled();
    expect(service.snapshot().entries[0]).toMatchObject({ status: 'pending', revision: 2 });
    await expect(service.prepare(id, 2)).resolves.toMatchObject({ revision: 2, copyBody: true });
  });

  it('leaves the draft reviewable when the default browser cannot open', async () => {
    const { service, openIssue, propose } = handoffFixture();
    const id = await propose(draft());
    const review = await service.prepare(id, 1);
    openIssue.mockRejectedValueOnce(new Error('No browser'));
    await expect(service.submit(id, 1, review.reviewId, false)).rejects.toThrow('无法打开 GitHub 提交流程');
    expect(service.snapshot().entries[0]).toMatchObject({ status: 'pending', revision: 2 });
    await expect(service.prepare(id, 2)).resolves.toMatchObject({ revision: 2 });
  });

  it('requires a fresh public history check for legacy drafts and for reviews overtaken by new Issues', async () => {
    const { service, openIssue, rows } = handoffFixture();
    const [legacy] = service.propose([draft()], 'worker-a');
    await expect(service.prepare(legacy!.id, 1)).rejects.toThrow('正在等待 AI 重新查重');
    expect(service.snapshot().entries[0]).toMatchObject({ status: 'pending', aiChecked: false, revision: 2 });
    const history = await service.history('worker-a');
    await service.assess('worker-a', history.checkId, [{ id: legacy!.id, revision: 2 }]);
    const review = await service.prepare(legacy!.id, 3);
    rows.push({ id: '1', title: 'New report after review', body: 'Details', state: 'open', url: github.repository + '/issues/1' });
    await expect(service.submit(legacy!.id, 3, review.reviewId, false)).rejects.toThrow('正在等待 AI 重新查重');
    expect(service.snapshot().entries[0]).toMatchObject({ status: 'pending', aiChecked: false });
    expect(openIssue).not.toHaveBeenCalled();
  });
});
