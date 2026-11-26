// @test-shards 2
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { inShard } from './helpers/shard.mjs';

const project = path.resolve(import.meta.dirname, '..');
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'task-adopt-'));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, args) => execFileSync('git', args, { cwd, env: cleanEnv, encoding: 'utf8', windowsHide: true });
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { createAdopter, parseUnifiedDiff } = await import(pathToFileURL(compile('main/git/adopt.ts')).href);
const { beginTaskWorktreeOperation } = await import(pathToFileURL(compile('main/git/worktreeTaskOperation.ts')).href);
const keysOf = preview => parseUnifiedDiff(preview.diff).flatMap(file => file.hunks.map(hunk => ({ ...hunk.key, file: file.path })));
function repo(name) {
  const main = path.join(fixture, name), tree = path.join(fixture, 'managed tasks', name);
  fs.mkdirSync(main, { recursive: true }); git(main, ['init', '-b', 'main']);
  for (const [key, value] of [['user.name', 'fixture'], ['user.email', 'fixture@test'], ['commit.gpgsign', 'false'],
    ['core.hooksPath', path.join(fixture, 'owned-hooks')], ['core.quotePath', 'false']]) git(main, ['config', key, value]);
  fs.writeFileSync(path.join(main, 'same.txt'), 'base\n'); git(main, ['add', '.']); git(main, ['commit', '-m', 'base']);
  fs.mkdirSync(path.dirname(tree), { recursive: true }); git(main, ['worktree', 'add', '-b', 'ao/shared', tree]);
  return { main, tree };
}
try {
  if (inShard(0)) {
    const a = repo('a'), b = repo('b');
    fs.writeFileSync(path.join(a.main, 'source staged.txt'), 'user staged\n'); git(a.main, ['add', '.']);
    fs.writeFileSync(path.join(a.main, 'source loose.txt'), 'user loose\n');
    const indexA = fs.readFileSync(path.join(a.main, '.git/index')), headB = git(b.main, ['rev-parse', 'HEAD']);
    const indexB = git(b.tree, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
    const workerIndex = fs.readFileSync(indexB);
    fs.writeFileSync(path.join(b.tree, 'same.txt'), 'second task only\n');
    const adopter = createAdopter(); const preview = await adopter.adoptPreview(b.tree);
    assert.equal(preview.ok, true, preview.message); assert.equal(preview.targetRepo, b.main);
    const applied = await adopter.adoptHunks(b.tree, keysOf(preview));
    assert.equal(applied.ok, true, applied.message); assert.equal(applied.targetRepo, b.main);
    assert.match(git(b.main, ['diff', '--cached']), /second task only/);
    assert.equal(git(b.main, ['rev-parse', 'HEAD']), headB);
    assert.deepEqual(fs.readFileSync(indexB), workerIndex); assert.deepEqual(fs.readFileSync(path.join(a.main, '.git/index')), indexA);
    assert.equal(fs.readFileSync(path.join(a.main, 'same.txt'), 'utf8'), 'base\n');
    console.log('ok: second-group adoption stages only its source, preserving other source WIP and worker index');
  }
  if (inShard(1)) {
    const a = repo('env-a'), b = repo('env-b'); fs.writeFileSync(path.join(b.tree, 'same.txt'), 'selected second\n');
    const saved = { ...process.env };
    try {
      process.env.GIT_DIR = path.join(a.main, '.git'); process.env.GIT_WORK_TREE = a.main;
      process.env.GIT_INDEX_FILE = path.join(a.main, '.git/index');
      const adopter = createAdopter(); const preview = await adopter.adoptPreview(b.tree);
      assert.equal(preview.ok, true, preview.message); assert.equal(preview.targetRepo, b.main, 'inherited Git variables cannot redirect identity');
      const applied = await adopter.adoptHunks(b.tree, keysOf(preview)); assert.equal(applied.ok, true, applied.message);
      assert.equal(git(a.main, ['status', '--porcelain']), ''); assert.match(git(b.main, ['diff', '--cached']), /selected second/);
    } finally {
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
    console.log('ok: repository-local Git environment cannot redirect selected-group adoption');
  }
  if (inShard(2)) {
    const a = repo('locks'); fs.writeFileSync(path.join(a.tree, 'same.txt'), 'locked task\n');
    const adopter = createAdopter(), preview = await adopter.adoptPreview(a.tree);
    const operation = beginTaskWorktreeOperation({}, 'task', 'cleanup');
    const commonDir = fs.realpathSync(path.join(a.main, '.git')).replace(/\\/g, '/');
    operation.holdRepository(process.platform === 'win32' ? commonDir.toLowerCase() : commonDir);
    try {
      const result = await adopter.adoptHunks(a.tree, keysOf(preview));
      assert.equal(result.ok, false, 'task cleanup/snapshot/integration must exclude adoption writes');
      assert.equal(git(a.main, ['status', '--porcelain']), '');
    } finally { operation.release(); }
    const result = await adopter.adoptHunks(a.tree, keysOf(preview)); assert.equal(result.ok, true, result.message);
    console.log('ok: adoption shares task repository locks and releases after failure');
  }
  if (inShard(3)) {
    const a = repo('identity-a'), b = repo('identity-b'); fs.writeFileSync(path.join(a.tree, 'same.txt'), 'original task\n');
    const dotGit = path.join(a.tree, '.git'), original = fs.readFileSync(dotGit);
    const adopter = createAdopter({ beforeApply: async () => {
      const fd = fs.openSync(dotGit, 'r+'); try {
        const other = fs.readFileSync(path.join(b.tree, '.git')); fs.ftruncateSync(fd, 0); fs.writeSync(fd, other);
      } finally { fs.closeSync(fd); }
    } });
    const preview = await adopter.adoptPreview(a.tree);
    await assert.rejects(adopter.adoptHunks(a.tree, keysOf(preview)), /identity|registration/);
    assert.equal(git(a.main, ['status', '--porcelain']), ''); assert.equal(git(b.main, ['status', '--porcelain']), '');
    const fd = fs.openSync(dotGit, 'r+'); try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, original); } finally { fs.closeSync(fd); }
    const head = git(a.main, ['rev-parse', 'HEAD']);
    const late = createAdopter({ beforeApply: async () => { git(a.main, ['commit', '--allow-empty', '-m', 'late source']); } });
    const refused = await late.adoptHunks(a.tree, keysOf(preview)); assert.equal(refused.ok, false);
    assert.notEqual(git(a.main, ['rev-parse', 'HEAD']), head); assert.equal(git(a.main, ['status', '--porcelain']), '');
    console.log('ok: gitfile replacement and late source HEAD changes cannot write an unchecked target');
  }
  if (inShard(4)) {
    const parent = repo('submodule-parent'), child = repo('submodule-seed');
    git(parent.main, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child.main, 'Modules/Same']);
    git(parent.main, ['commit', '-am', 'real submodule']); git(parent.tree, ['reset', '--hard', 'main']);
    const main = path.join(parent.main, 'Modules/Same'), tree = path.join(parent.tree, 'Modules/Same');
    git(main, ['worktree', 'add', '-b', 'ao/nested', tree]);
    const parentHead = git(parent.main, ['rev-parse', 'HEAD']), childHead = git(main, ['rev-parse', 'HEAD']);
    const parentIndex = fs.readFileSync(path.join(parent.main, '.git/index'));
    const privateIndex = git(tree, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
    const workerIndex = fs.readFileSync(privateIndex);
    fs.writeFileSync(path.join(tree, 'same.txt'), 'absorbed submodule task\n');
    const adopter = createAdopter(), preview = await adopter.adoptPreview(tree);
    assert.equal(preview.ok, true, preview.message); assert.equal(preview.targetRepo, main);
    const applied = await adopter.adoptHunks(tree, keysOf(preview)); assert.equal(applied.ok, true, applied.message);
    assert.match(git(main, ['diff', '--cached']), /absorbed submodule task/);
    assert.equal(git(main, ['rev-parse', 'HEAD']), childHead); assert.equal(git(parent.main, ['rev-parse', 'HEAD']), parentHead);
    assert.deepEqual(fs.readFileSync(path.join(parent.main, '.git/index')), parentIndex);
    assert.deepEqual(fs.readFileSync(privateIndex), workerIndex);
    console.log('ok: absorbed submodule resolves its actual source without touching parent/worker indexes or HEADs');
  }
} finally {
  const relative = path.relative(path.join(project, '.tmp'), fixture);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
