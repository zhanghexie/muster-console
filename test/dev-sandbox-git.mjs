import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-git-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { seedSingleRepo, needsSeedRepo } = await import(pathToFileURL(compile('main/devSandboxGit.ts')));
  const parent = path.join(temp, 'parent');
  fs.mkdirSync(parent);
  const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(parent, ['init', '-b', 'main']);
  run(parent, ['config', '--local', 'user.name', 'Parent User']);
  run(parent, ['config', '--local', 'user.email', 'parent@example.invalid']);
  fs.writeFileSync(path.join(parent, 'parent.txt'), 'parent');
  run(parent, ['add', 'parent.txt']);
  run(parent, ['commit', '-m', 'parent']);
  const before = fs.readFileSync(path.join(parent, '.git', 'config'), 'utf8');
  const beforeHead = fs.readFileSync(path.join(parent, '.git', 'HEAD'), 'utf8');
  const beforeRefs = run(parent, ['for-each-ref', '--format=%(refname):%(objectname)']);
  let calls = 0;
  assert.throws(() => seedSingleRepo(path.join(parent, 'failed'), { 'a.txt': 'x' }, 'initial', undefined, undefined, () => {
    calls++;
    throw new Error('simulated init failure');
  }), /simulated init failure/);
  assert.equal(calls, 1, 'no mutation may follow a failed init');
  assert.throws(() => seedSingleRepo(path.join(parent, 'fake'), {}, 'initial', undefined, undefined, () => ''), /missing local .git/);
  const failConfig = path.join(parent, 'fail-config');
  const attempted = [];
  assert.throws(() => seedSingleRepo(failConfig, {}, 'initial', undefined, undefined, (cwd, args) => {
    attempted.push(args[0]);
    if (args[0] === 'config') throw new Error('simulated config failure');
    return run(cwd, args);
  }), /simulated config failure/);
  assert.deepEqual(attempted, ['init', 'rev-parse', 'config']);
  assert.throws(() => needsSeedRepo(failConfig), /incomplete demo repository/);
  assert.equal(fs.readFileSync(path.join(parent, '.git', 'config'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(parent, '.git', 'HEAD'), 'utf8'), beforeHead);
  assert.equal(run(parent, ['for-each-ref', '--format=%(refname):%(objectname)']), beforeRefs);

  const nested = path.join(parent, 'long'.repeat(22), 'path'.repeat(22), 'demo');
  seedSingleRepo(nested, { 'a.txt': 'main' }, 'initial', { branchName: 'feature/test', files: { 'a.txt': 'branch' }, commitMsg: 'branch' });
  assert.equal(needsSeedRepo(nested), false);
  const runLong = args => execFileSync('git', ['-c', 'core.longpaths=true', '-C', nested, ...args], { cwd: path.parse(nested).root, encoding: 'utf8' }).trim();
  assert.equal(fs.realpathSync.native(runLong(['rev-parse', '--show-toplevel'])), fs.realpathSync.native(nested));
  assert.match(runLong(['branch', '--list']), /feature\/test/);
  assert.equal(fs.readFileSync(path.join(parent, '.git', 'config'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(parent, '.git', 'HEAD'), 'utf8'), beforeHead);
  assert.equal(run(parent, ['for-each-ref', '--format=%(refname):%(objectname)']), beforeRefs);
  console.log('dev sandbox Git isolation regression passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
