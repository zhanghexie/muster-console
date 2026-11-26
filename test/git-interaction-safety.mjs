import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(root, '.tmp', 'git-safety-'));
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = path.join(fixture, 'empty.gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1'; fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args],
  { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const remote = path.join(fixture, 'remote.git'); fs.mkdirSync(remote); git(remote, 'init', '--bare', '-q', '-b', 'main');
const a = path.join(fixture, 'a'); git(fixture, 'clone', '-q', remote, a);
const identity = dir => { git(dir, 'config', 'user.name', 'Git Safety'); git(dir, 'config', 'user.email', 'safety@example.invalid'); };
identity(a);
for (const name of ['same.txt', '[a].txt', 'a.txt']) fs.writeFileSync(path.join(a, name), 'base\n');
git(a, 'add', '.'); git(a, 'commit', '-qm', 'base'); git(a, 'push', '-qu', 'origin', 'main');
const b = path.join(fixture, 'b'); git(fixture, 'clone', '-q', remote, b); identity(b);
const compile = createSharedCompiler(root, path.join(fixture, 'compiled'));
const { createHostGitClient } = await import(pathToFileURL(compile('main/git/hostGitClient.ts')).href);
const hostClient = createHostGitClient(a, { ...process.env, PAGER: 'cat', GIT_DIR: path.join(b, '.git') });
const status = await hostClient.status();
assert.equal(status.current, 'main', 'the host Git client must read status through the installed package');
assert.equal((await hostClient.revparse(['--show-toplevel'])).trim(), git(a, 'rev-parse', '--show-toplevel'));
assert.throws(() => hostClient.env({ PAGER: 'cat' }), /Host Git environment/);
const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
const workspace = { id: 'safety', name: 'Safety', openedAt: 0, path: a, roots: [{ id: 'root', path: a }], rootsRevision: 0, defaultRootId: 'root', controlRoot: a };
const service = new GitService({ get: () => ({ workspace: a, activeWorkspaceId: workspace.id, workspaces: [workspace] }) });

fs.writeFileSync(path.join(a, 'same.txt'), 'staged\n'); git(a, 'add', 'same.txt'); fs.writeFileSync(path.join(a, 'same.txt'), 'working\n');
assert.equal((await service.discard(a, ['same.txt'], 'unstaged')).ok, true);
assert.equal(fs.readFileSync(path.join(a, 'same.txt'), 'utf8'), 'staged\n');
assert(git(a, 'diff', '--cached').includes('+staged')); assert.equal(git(a, 'diff'), '');
fs.writeFileSync(path.join(a, 'added.txt'), 'added\n'); git(a, 'add', 'added.txt'); fs.writeFileSync(path.join(a, 'added.txt'), 'extra\n');
assert.equal((await service.discard(a, ['added.txt'], 'unstaged')).ok, true);
assert.equal(fs.readFileSync(path.join(a, 'added.txt'), 'utf8'), 'added\n');
assert(git(a, 'diff', '--cached').includes('added.txt'));
fs.writeFileSync(path.join(a, 'new.txt'), 'new\n'); assert.equal((await service.discard(a, ['new.txt'], 'unstaged')).ok, true);
assert(!fs.existsSync(path.join(a, 'new.txt')));
assert.equal((await service.discard(a, ['same.txt', 'added.txt'], 'all')).ok, true);
assert.equal(git(a, 'status', '--porcelain'), ''); assert(!fs.existsSync(path.join(a, 'added.txt')));
console.log('ok: MM and added-file unstaged discard preserves index; explicit all discard removes both; untracked deletion');

for (const mode of ['unstaged', 'all']) {
  for (const name of ['[a].txt', 'a.txt']) fs.writeFileSync(path.join(a, name), `${name} staged\n`);
  git(a, '--literal-pathspecs', 'add', '--', '[a].txt', 'a.txt');
  for (const name of ['[a].txt', 'a.txt']) fs.writeFileSync(path.join(a, name), `${name} working\n`);
  assert.equal((await service.discard(a, ['[a].txt'], mode)).ok, true);
  assert.equal(fs.readFileSync(path.join(a, '[a].txt'), 'utf8'), mode === 'unstaged' ? '[a].txt staged\n' : 'base\n');
  assert.equal(git(a, 'show', ':[a].txt'), mode === 'unstaged' ? '[a].txt staged' : 'base');
  assert.equal(fs.readFileSync(path.join(a, 'a.txt'), 'utf8'), 'a.txt working\n', `${mode}: unselected worktree content must survive`);
  assert.equal(git(a, 'show', ':a.txt'), 'a.txt staged', `${mode}: unselected index must survive`);
  git(a, 'reset', '--hard', 'HEAD');
}
for (const name of ['[b].txt', 'b.txt']) fs.writeFileSync(path.join(a, name), 'new staged\n');
git(a, '--literal-pathspecs', 'add', '--', '[b].txt', 'b.txt');
assert.equal((await service.discard(a, ['[b].txt'], 'all')).ok, true);
assert(!fs.existsSync(path.join(a, '[b].txt')));
assert.equal(git(a, 'show', ':b.txt'), 'new staged', 'discarding an added glob-like name must not unstage another file');
git(a, 'restore', '--staged', '--', 'b.txt'); fs.unlinkSync(path.join(a, 'b.txt'));
console.log('ok: literal filenames restrict both discard modes and new-file unstaging to confirmed paths');

// A failed unstage must not be followed by unlinking an added file.
fs.writeFileSync(path.join(a, 'locked.txt'), 'keep\n'); git(a, 'add', 'locked.txt');
const originalClient = service.client;
service.client = function (...args) {
  const client = originalClient.apply(this, args);
  return new Proxy(client, { get(target, member) {
    if (member === 'raw') return (tokens, ...rest) => {
      if (tokens[0] === 'restore' && tokens.includes('--staged')) throw new Error('FIXTURE_INDEX_LOCKED');
      return target.raw(tokens, ...rest);
    };
    return Reflect.get(target, member);
  } });
};
try {
  assert.equal((await service.discard(a, ['locked.txt'], 'all')).ok, false);
  assert.equal(fs.readFileSync(path.join(a, 'locked.txt'), 'utf8'), 'keep\n');
} finally { service.client = originalClient; }
git(a, 'restore', '--staged', '--', 'locked.txt'); fs.unlinkSync(path.join(a, 'locked.txt'));
const outside = path.join(fixture, 'outside.txt'); fs.writeFileSync(outside, 'outside\n');
assert.equal((await service.discard(a, ['../outside.txt'], 'all')).ok, false);
assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');

const initial = await service.status(a); assert.equal(initial.remoteCheck, undefined);
fs.writeFileSync(path.join(b, 'remote.txt'), 'remote\n'); git(b, 'add', '.'); git(b, 'commit', '-qm', 'remote'); git(b, 'push', '-q');
assert.equal((await service.status(a)).behind, 0);
assert.equal((await service.fetch(a)).ok, true);
const checked = await service.status(a); assert.equal(checked.behind, 1); assert(checked.remoteCheck.checkedAt);
git(a, 'remote', 'set-url', 'origin', path.join(fixture, 'missing.git'));
assert.equal((await service.fetch(a)).ok, false);
const failed = await service.status(a); assert(failed.remoteCheck.error); assert.equal(failed.remoteCheck.checkedAt, checked.remoteCheck.checkedAt);
git(a, 'remote', 'set-url', 'origin', remote);
assert.equal((await service.fetch(a)).ok, true); assert.equal((await service.status(a)).remoteCheck.error, undefined);
assert.equal((await service.pull(a)).ok, true);
fs.writeFileSync(path.join(a, 'local.txt'), 'local\n'); git(a, 'add', '.'); git(a, 'commit', '-qm', 'local');
const pushed = await service.push(a); assert.equal(pushed.ok, true); assert(pushed.remote.completedAt); assert(pushed.remote.targets.length);
assert.equal(git(a, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
assert.equal((await service.push(a)).remote.unchanged, true);
console.log('ok: fresh/failed/recovered remote checks, real push result, up-to-date receipt');

git(a, 'checkout', '-qb', 'feature'); fs.writeFileSync(path.join(a, 'same.txt'), 'feature\n'); git(a, 'add', '.'); git(a, 'commit', '-qm', 'feature'); git(a, 'checkout', '-q', 'main');
await service.status(a); fs.writeFileSync(path.join(a, 'same.txt'), 'uncommitted\n');
const switched = await service.checkout(a, { name: 'feature', stashMode: 'stash-reapply' });
assert.equal(switched.ok, true); assert.equal(switched.warning, true); assert(switched.stashRef); assert(switched.conflicts.includes('same.txt'));
assert.equal((await service.status(a)).branch, 'feature'); assert.equal(git(a, 'rev-parse', 'refs/stash'), switched.stashRef);
assert.equal((await service.status(a)).remoteCheck, undefined, 'checks from main cannot claim freshness on another branch');
console.log('ok: actual stash conflict returns partial success, recovery OID and files; HEAD/status cache refreshes');

// A checkout failure followed by a failed automatic restore must retain both errors.
git(a, 'reset', '--hard', 'HEAD'); git(a, 'checkout', '-q', 'main');
fs.writeFileSync(path.join(a, 'same.txt'), 'needs recovery\n');
service.client = function (...args) {
  const client = originalClient.apply(this, args);
  return new Proxy(client, { get(target, member) {
    if (member === 'checkout') return () => { throw new Error('FIXTURE_CHECKOUT_FAILED'); };
    if (member === 'stash') return (tokens, ...rest) => {
      if (tokens[0] === 'pop') throw new Error('FIXTURE_RESTORE_FAILED');
      return target.stash(tokens, ...rest);
    };
    return Reflect.get(target, member);
  } });
};
try {
  const result = await service.checkout(a, { name: 'feature', stashMode: 'stash' });
  assert.equal(result.ok, false); assert.equal(result.warning, true); assert(result.stashRef);
  assert(result.message.includes('FIXTURE_CHECKOUT_FAILED')); assert(result.message.includes('FIXTURE_RESTORE_FAILED'));
} finally { service.client = originalClient; }
console.log('ok: secondary restore failure retains original checkout error and recovery reference');
