/** Two Git processes interleave Worker push/pop with host integration. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'integrate-stash-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { mergeIsolateBranch } = await import(pathToFileURL(compile('main/git/mergeIsolate.ts')).href);
const { saveIntegrateSnapshot, restoreIntegrateSnapshot } = await import(pathToFileURL(compile('main/git/integrateSnapshot.ts')).href);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true }).trim();
const otherGit = (cwd, ...args) => promisify(execFile)('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
try {
  const repo = path.join(temp, 'main'), worker = path.join(temp, 'worker'); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'same.txt'), 'line1\nline2\nline3\nline4\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'worktree', 'add', '-q', '-b', 'ao/task', worker);
  fs.writeFileSync(path.join(worker, 'same.txt'), 'line1\nline2\nline3\nmerged\n'); git(worker, 'commit', '-qam', 'task');
  fs.writeFileSync(path.join(repo, 'same.txt'), 'user-wip\nline2\nline3\nline4\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'unrelated-staged'); git(repo, 'add', 'other.txt');
  let workerOid;
  const result = await mergeIsolateBranch({ mainRepo: repo, worktreePath: worker, branch: 'ao/task', stashMain: true,
    skipNpmInstall: true, skipTypecheck: true, beforeWrite: async stage => {
      if (stage !== 'merge') return;
      fs.writeFileSync(path.join(worker, 'other.txt'), 'worker-wip');
      await otherGit(worker, 'stash', 'push', '-m', 'worker'); workerOid = git(worker, 'rev-parse', 'refs/stash');
    } });
  assert.equal(result.ok, true, result.message);
  assert.equal(git(repo, 'rev-parse', 'refs/stash'), workerOid, 'host cannot pop the Worker stash');
  assert.equal(fs.readFileSync(path.join(repo, 'same.txt'), 'utf8'), 'user-wip\nline2\nline3\nmerged\n');
  assert.equal(fs.readFileSync(path.join(repo, 'other.txt'), 'utf8'), 'unrelated-staged');
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'other.txt');
  await otherGit(worker, 'stash', 'pop');
  assert.equal(fs.readFileSync(path.join(worker, 'other.txt'), 'utf8'), 'worker-wip');
  assert.equal(fs.readFileSync(path.join(worker, 'same.txt'), 'utf8'), 'line1\nline2\nline3\nmerged\n', 'Worker cannot receive host WIP');
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/muster/integrate'), '');
  // Private snapshot preserves split staged/unstaged state and untracked content without a stack entry.
  fs.writeFileSync(path.join(repo, 'same.txt'), 'staged'); git(repo, 'add', 'same.txt'); fs.writeFileSync(path.join(repo, 'same.txt'), 'unstaged');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked');
  const ref = await saveIntegrateSnapshot(repo, ['same.txt', 'new.txt']);
  assert.equal(fs.existsSync(path.join(repo, 'new.txt')), false);
  await restoreIntegrateSnapshot(repo, ref, ['same.txt', 'new.txt']);
  assert.equal(git(repo, 'show', ':same.txt'), 'staged');
  assert.equal(fs.readFileSync(path.join(repo, 'same.txt'), 'utf8'), 'unstaged');
  assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'untracked');
  assert.equal(git(repo, 'ls-files', 'new.txt'), '', 'untracked file must remain untracked');
  assert.equal(git(repo, 'show', ':other.txt'), 'unrelated-staged');
  console.log('ok: private snapshots and two-process stash isolation');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
