/**
 * P5/P11：早 needs_you warning、脏树回注决策、兜底提交标注。
 * Run: node test/worker-status-guard.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'worker-status-guard-'));
const compile = createSharedCompiler(root, tmp);

const {
  EARLY_NEEDS_YOU_MS,
  HOST_FALLBACK_COMMIT_MARK,
  earlyNeedsYouWarning,
  parsePorcelainPaths,
  dirtyTreeRemindMessage,
  dirtyTreeAction,
  fallbackCommitMessage
} = await import(pathToFileURL(compile('shared/workerStatusGuard.ts')).href);

{
  assert.equal(earlyNeedsYouWarning(undefined, undefined), null, '无回合时钟不 warning');
  assert.equal(earlyNeedsYouWarning(EARLY_NEEDS_YOU_MS, undefined), null, '满 N 秒不 warning');
  assert.equal(earlyNeedsYouWarning(5_000, '缺权限卡审批'), null, '带 reason 不 warning');
  assert.match(earlyNeedsYouWarning(8_000, undefined), /读文档/);
  assert.match(earlyNeedsYouWarning(8_000, undefined), /未撤销/);
  assert.equal(earlyNeedsYouWarning(8_000, '  ') !== null, true);
  assert.match(earlyNeedsYouWarning(8_000, '  '), /P5/);
  console.log('ok: earlyNeedsYouWarning');
}

{
  assert.deepEqual(parsePorcelainPaths(''), []);
  assert.deepEqual(parsePorcelainPaths(' M src/a.ts\n?? b.md\n'), ['src/a.ts', 'b.md']);
  assert.deepEqual(parsePorcelainPaths('R  old.ts -> new.ts\n'), ['new.ts']);
  assert.deepEqual(parsePorcelainPaths('?? 中文 space -> arrow.txt\0R  target.txt\0source.txt\0 M last.txt\0'),
    ['中文 space -> arrow.txt', 'target.txt', 'last.txt']);
  console.log('ok: parsePorcelainPaths');
}

{
  assert.equal(dirtyTreeAction(false, 'needs_you'), 'ok');
  assert.equal(dirtyTreeAction(false, 'integrate'), 'ok');
  assert.equal(dirtyTreeAction(true, 'needs_you'), 'remind');
  assert.equal(dirtyTreeAction(true, 'integrate'), 'fallback-commit');
  const msg = dirtyTreeRemindMessage(['a.ts', 'b.ts']);
  assert.match(msg, /P11/);
  assert.match(msg, /a.ts/);
  assert.match(msg, /不会替你决定/);
  assert.ok(fallbackCommitMessage().includes(HOST_FALLBACK_COMMIT_MARK));
  console.log('ok: dirtyTreeAction / remind');
}

const { listDirtyPaths, fallbackCommitDirtyTree } = await import(
  pathToFileURL(compile('main/git/workerDirtyGuard.ts')).href
);
const { gitCommandEnvironment } = await import(pathToFileURL(compile('main/git/gitEnvironment.ts')).href);
assert.deepEqual(gitCommandEnvironment({ Path: 'tools', git_dir: 'wrong repo', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: 'other hooks', GIT_CONFIG_GLOBAL: 'user config', GIT_SSH_COMMAND: 'user ssh' }),
  { Path: 'tools', GIT_CONFIG_GLOBAL: 'user config', GIT_SSH_COMMAND: 'user ssh' });

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

{
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'p11-dirty-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'p11@test']);
  git(repo, ['config', 'user.name', 'p11']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.hooksPath', path.join(repo, '.git', 'hooks')]);
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\n', 'utf8');
  git(repo, ['add', 'keep.txt']);
  git(repo, ['commit', '-m', 'init']);
  assert.deepEqual(await listDirtyPaths(repo), []);

  fs.writeFileSync(path.join(repo, 'wip.ts'), 'export const x = 1;\n', 'utf8');
  const dirty = await listDirtyPaths(repo);
  assert.ok(dirty.some((p) => p.includes('wip.ts')), dirty.join(','));

  const r = await fallbackCommitDirtyTree(repo);
  assert.equal(r.ok, true);
  assert.equal(r.committed, true);
  assert.deepEqual(await listDirtyPaths(repo), [], '兜底后应干净');
  const log = git(repo, ['log', '-1', '--format=%s']);
  assert.match(log, /\[host\] P11/);

  const skip = await fallbackCommitDirtyTree(repo);
  assert.equal(skip.skipped, true);

  const nonGit = path.join(tmp, 'not-a-repository'); fs.mkdirSync(nonGit);
  await assert.rejects(listDirtyPaths(nonGit), /git status|not a git repository/i, 'a failed status read is never a clean checkout');
  const failed = await fallbackCommitDirtyTree(nonGit);
  assert.equal(failed.ok, false, 'a failed status read cannot be a successful skipped snapshot');
  assert.match(failed.message, /git status|not a git repository/i);
  assert.equal(failed.skipped, undefined);

  const { afterNeedsYouReported, beforeRequestIntegrate } = await import(pathToFileURL(compile('main/agentSession/workerTreeGuard.ts')).href);
  const nudges = [];
  const guard = await afterNeedsYouReported({
    sessions: { get: () => ({ worktreePath: nonGit }) },
    agentSessions: { getTurnStartedAt: () => undefined, injectHostNudge: async (_id, text) => nudges.push(text) }
  }, 'unreadable-worktree');
  assert.equal(guard.dirty, true, 'needs_you keeps a conservative state when cleanliness cannot be checked');
  assert.match(guard.fallbackError, /宿主提示/);
  assert.deepEqual(nudges, [], 'host read failure never wakes the Worker');

  const nestedTree = path.join(repo, '.worktrees', 'lost-gitfile');
  git(repo, ['worktree', 'add', '-b', 'ao/lost-gitfile', nestedTree]);
  const gitfile = path.join(nestedTree, '.git'), originalGitfile = fs.readFileSync(gitfile);
  const gitDir = originalGitfile.toString('utf8').trim().slice('gitdir: '.length);
  for (const marker of ['index.lock', 'HEAD.lock', 'locked']) {
    const lockFile = path.join(gitDir, marker); fs.writeFileSync(lockFile, 'fixture lock');
    const recovered = await afterNeedsYouReported({
      sessions: { get: () => ({ worktreePath: nestedTree, worktreeBranch: 'ao/lost-gitfile' }) },
      agentSessions: { getTurnStartedAt: () => undefined, injectHostNudge: async (_id, text) => nudges.push(text) }
    }, 'legacy-lock', undefined, { sleep: async () => fs.unlinkSync(lockFile) });
    assert.equal(recovered.dirty, false, `legacy ${marker} recovers after retry`);
    assert.deepEqual(nudges, [], 'legacy transient lock is never reinjected');
  }
  fs.unlinkSync(gitfile);
  assert.equal(git(nestedTree, ['rev-parse', '--show-toplevel']).trim().replaceAll('\\', '/'), repo.replaceAll('\\', '/'), 'the trigger really makes unguarded Git fall through to its parent source repo');
  fs.writeFileSync(path.join(repo, 'source-work.txt'), 'source pending'); git(repo, ['add', 'source-work.txt']);
  const sourceHead = git(repo, ['rev-parse', 'HEAD']), sourceIndex = fs.readFileSync(path.join(repo, '.git', 'index'));
  const legacy = { sessions: { get: () => ({ worktreePath: nestedTree, worktreeBranch: 'ao/lost-gitfile' }) } };
  assert.match((await beforeRequestIntegrate(legacy, 'lost-gitfile')).fallbackError, /宿主提示/);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), sourceHead, 'missing legacy gitfile never commits the parent source checkout');
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), sourceIndex, 'missing legacy gitfile never stages parent source changes');
  fs.writeFileSync(gitfile, originalGitfile);
  fs.writeFileSync(path.join(nestedTree, 'own-task.txt'), 'task-owned change');
  const overrides = { GIT_DIR: path.join(repo, '.git'), GIT_WORK_TREE: repo, GIT_COMMON_DIR: path.join(repo, '.git'), GIT_INDEX_FILE: path.join(repo, '.git', 'index') };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  let scoped;
  try {
    Object.assign(process.env, overrides);
    scoped = await fallbackCommitDirtyTree(nestedTree);
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
  assert.equal(scoped.ok, true);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), sourceHead, 'inherited Git path/index environment cannot commit the source checkout');
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), sourceIndex, 'inherited Git index cannot override the task index');
  assert.ok(git(nestedTree, ['ls-tree', '--name-only', 'HEAD']).includes('own-task.txt'));
  git(repo, ['worktree', 'remove', '--force', nestedTree]);

  const arrowName = process.platform === 'win32' ? '中文 space arrow.txt' : '中文 space -> arrow.txt';
  fs.writeFileSync(path.join(repo, arrowName), 'untracked name');
  assert.ok((await listDirtyPaths(repo)).includes(arrowName), 'porcelain NUL parsing keeps literal arrows and Unicode filenames');

  assert.ok(path.resolve(repo).startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}p11-dirty-`));
  fs.rmSync(repo, { recursive: true, force: true });
  console.log('ok: fallbackCommitDirtyTree');
}

assert.ok(path.resolve(tmp).startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}worker-status-guard-`));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] worker-status-guard');
