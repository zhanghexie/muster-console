/**
 * T1.7：PR 行内评论 → 邮箱正文拼装 + 会话匹配。
 * Run: node test/pr-review-brief.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-brief-'));
const compile = createSharedCompiler(root, tmp);

const { buildPrReviewBrief, matchWorkerSessionForRepo } = await import(
  'file:///' + compile('shared/prReviewBrief.ts').replace(/\\/g, '/')
);
const { sessionWorktreeReviewRepos, sessionWorktreeReviewTarget } = await import(
  'file:///' + compile('shared/sessionWorktreeReview.ts').replace(/\\/g, '/')
);

{
  const empty = buildPrReviewBrief([]);
  assert.equal(empty, '');
  const skipped = buildPrReviewBrief([{ file: 'a.ts', line: 1, original: 'x', body: '  ' }]);
  assert.equal(skipped, '');
  console.log('ok: empty / blank body skipped');
}

{
  const text = buildPrReviewBrief([
    { file: 'src/b.ts', line: 8, original: 'oldB', body: 'fix B' },
    { file: 'src/a.ts', line: 12, original: 'const x = 1', body: '改成 2' },
    { file: 'src\\a.ts', line: 3, original: 'y', body: '上面先改' }
  ]);
  assert.match(text, /请根据以下 PR 行内评论修订代码/);
  assert.match(text, /重新 push/);
  assert.match(text, /不要 git merge 进主分支/);
  assert.match(text, /\[PR 评论\] src\/a\.ts:3 原文\/评论/);
  assert.match(text, /\[PR 评论\] src\/a\.ts:12 原文\/评论/);
  assert.match(text, /\[PR 评论\] src\/b\.ts:8 原文\/评论/);
  assert.match(text, /原文: const x = 1/);
  assert.match(text, /评论: 改成 2/);
  const a3 = text.indexOf('[PR 评论] src/a.ts:3 原文/评论');
  const a12 = text.indexOf('[PR 评论] src/a.ts:12 原文/评论');
  const b8 = text.indexOf('[PR 评论] src/b.ts:8 原文/评论');
  assert.ok(a3 < a12 && a12 < b8, 'sort by file then line');
  console.log('ok: structured [PR 评论] file:line 原文/评论');
}

{
  const wt = 'E:/ws/.worktrees/sess-1';
  const sessions = [
    { id: 's-other', type: 'terminal', cwd: 'E:/ws', name: 'main' },
    { id: 's-wt', type: 'terminal', worktreePath: wt, cwd: wt, name: 'T1.7' }
  ];
  const hit = matchWorkerSessionForRepo(sessions, 'E:\\ws\\.worktrees\\sess-1');
  assert.equal(hit?.id, 's-wt');
  const miss = matchWorkerSessionForRepo(sessions, 'E:/other');
  assert.equal(miss, null);
  const byCwd = matchWorkerSessionForRepo(
    [{ id: 'cli', type: 'terminal', cwd: 'D:/proj', name: 'cli' }],
    'D:\\proj'
  );
  assert.equal(byCwd?.id, 'cli');
  console.log('ok: matchWorkerSessionForRepo');
}

{
  const group = (id, rootId) => ({ id, path: `C:/tasks/${id}`, branch: 'ao/shared',
    sourceRoot: { rootId, path: `E:/sources/${id}`, cwd: `E:/sources/${id}` },
    source: { mainRepo: `E:/sources/${id}`, commonDir: `E:/sources/${id}/.git` },
    repos: [{ path: 'Plugins/Same', branch: 'ao/shared' }] });
  const owner = { id: 'owner', type: 'terminal', name: 'task', worktreePath: 'C:/tasks/a', cwd: 'C:/tasks/a',
    worktreeGroups: { version: 1, primaryGroupId: 'a', groups: [group('a', 'root-a'), group('b', 'root-b')] } };
  const hit = matchWorkerSessionForRepo([{ id: 'borrower', type: 'terminal', cwd: 'C:/tasks/b/Plugins/Same' }, owner],
    'C:/tasks/b/Plugins/Same');
  assert.equal(hit?.id, 'owner', 'second-group nested review belongs to the task owner, not a cwd borrower');
  assert.equal(hit.groupId, 'b'); assert.equal(hit.rootId, 'root-b');
  assert.equal(hit.repoPath, 'C:/tasks/b/Plugins/Same');
  assert.equal(hit.sourcePath, 'E:/sources/b/Plugins/Same');
  assert.equal(matchWorkerSessionForRepo([owner], 'C:/tasks/b/other'), null, 'no prefix ownership guessing');
  assert.equal(matchWorkerSessionForRepo([owner, { ...owner, id: 'duplicate' }], 'C:/tasks/b'), null,
    'ambiguous owners must not receive comments');
  const broken = { ...owner, worktreeGroups: { ...owner.worktreeGroups, primaryGroupId: 'missing' } };
  assert.equal(matchWorkerSessionForRepo([broken], owner.cwd), null, 'invalid collection cannot fall back to legacy/cwd');
  const brief = buildPrReviewBrief([{ file: 'same.txt', line: 1, original: 'old', body: 'fix second' }], hit);
  assert.match(brief, /C:\/tasks\/b\/Plugins\/Same/); assert.match(brief, /E:\/sources\/b\/Plugins\/Same/);
  assert.match(brief, /root-b/); assert.match(brief, /ao\/shared/);
  assert.doesNotMatch(brief, /重新 push/); assert.doesNotMatch(brief, /C:\/tasks\/a/);
  const reordered = { ...owner, cwd: 'E:/sources/a', worktreePath: 'C:/stale',
    worktreeGroups: { ...owner.worktreeGroups, groups: [...owner.worktreeGroups.groups].reverse() } };
  assert.equal(sessionWorktreeReviewTarget(reordered)?.repoPath, 'C:/tasks/a', 'named primary wins over array order and stale projection');
  const partial = structuredClone(owner);
  partial.worktreeGroups.groups[1].cleanup = [{ repo: 'Plugins/Same', branch: 'ao/shared', status: 'retained', treeRemoved: true, branchRemoved: false }];
  assert.equal(sessionWorktreeReviewRepos(partial).some(repo => repo.repoPath === 'C:/tasks/b/Plugins/Same'), false, 'removed trees cannot be review targets');
  const legacy = { id: 'old', worktreePath: 'C:/legacy', worktreeRepoSet: [{ path: 'Plugins/Same', branch: 'ao/old' }] };
  assert.equal(matchWorkerSessionForRepo([legacy], 'C:/legacy/Plugins/Same')?.id, 'old');
  console.log('ok: all task groups, nested repo identity and unambiguous local review context');
}

fs.rmSync(tmp, { recursive: true, force: true });
