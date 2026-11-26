/** Source gitlink changes caused by the task's own nested merge must remain attributable. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(project, '.tmp'); fs.mkdirSync(tempRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(tempRoot, 'task-integrate-submodule-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { integrateTaskWorktrees } = await import(pathToFileURL(compile('main/git/worktreeTaskIntegrate.ts')).href);
const { normalizeSessionWorktrees } = await import(pathToFileURL(compile('shared/sessionWorktrees.ts')).href);
const { sourcePathKey } = await import(pathToFileURL(compile('main/workspacePaths.ts')).href);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const configFile = path.join(fixture, 'gitconfig'); fs.writeFileSync(configFile, '');
Object.assign(env, { GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function init(folder) {
  fs.mkdirSync(folder, { recursive: true }); git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'user.name', 'Fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
  git(folder, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(folder, 'same.txt'), 'base'); git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'base');
}
function commit(folder, file, text) { fs.writeFileSync(path.join(folder, file), text); git(folder, 'add', '.'); git(folder, 'commit', '-qm', text); }
function setup(name, gate = false) {
  const folder = path.join(fixture, name); fs.mkdirSync(folder);
  const a = path.join(folder, 'a'), b = path.join(folder, 'b'), module = path.join(folder, 'module');
  init(a); init(b); init(module);
  if (gate) commit(a, 'package.json', JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(3)"' } }));
  const relative = 'Plugins/模块 one';
  git(a, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', module, relative); git(a, 'commit', '-qm', 'submodule');
  const child = path.join(a, relative);
  git(child, 'config', 'user.name', 'Fixture'); git(child, 'config', 'user.email', 'fixture@example.invalid'); git(child, 'config', 'commit.gpgsign', 'false');
  const groups = [a, b].map((main, i) => {
    const id = i ? 'b' : 'a'; const tree = path.join(folder, `tree-${id}`), baseCommit = git(main, 'rev-parse', 'HEAD');
    git(main, 'worktree', 'add', '-q', '-b', 'ao/task', tree, 'main');
    return { id, path: tree, sourceRoot: { rootId: id, path: main, cwd: main, physicalPath: sourcePathKey(main) },
      source: { mainRepo: main, commonDir: path.join(main, '.git') }, branch: 'ao/task', baseBranch: 'main', baseCommit, repos: [] };
  });
  const nested = path.join(groups[0].path, relative), baseCommit = git(child, 'rev-parse', 'HEAD');
  git(child, 'worktree', 'add', '-q', '-b', 'ao/task', nested, 'main');
  commit(nested, 'same.txt', 'module-task');
  groups[0].repos.push({ path: relative, branch: 'ao/task', baseBranch: 'main', baseCommit, kind: 'submodule' });
  commit(groups[0].path, 'same.txt', 'parent-task'); // add records the nested task commit as the gitlink.
  commit(groups[1].path, 'same.txt', 'second-task');
  const ws = { id: name, name, path: a, controlRoot: a, defaultRootId: 'a', rootsRevision: 1, roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
  const owner = { id: name, name, type: 'terminal', workspaceId: name, cwd: groups[0].path, sourceRoot: groups[0].sourceRoot,
    worktreeGroups: { version: 1, primaryGroupId: 'a', groups } };
  normalizeSessionWorktrees(owner);
  git(a, 'config', 'submodule.recurse', 'true');
  const snapshots = [];
  const ctx = { config: { get: () => ({ workspaces: [ws], activeWorkspaceId: name }) }, git: { invalidateRepoCaches() {} },
    workspaceIdFor: () => name, findSession: () => owner, persist: () => snapshots.push(structuredClone(owner)), broadcast() {} };
  return { a, b, child, nested, relative, groups, owner, ctx, snapshots };
}
try {
  const task = setup('fast-forward');
  const result = await integrateTaskWorktrees(task.ctx, task.owner, { skipNpmInstall: true, skipTypecheck: true });
  assert.equal(result.ok, true, result.message);
  assert.equal(fs.readFileSync(path.join(task.child, 'same.txt'), 'utf8'), 'module-task');
  assert.equal(fs.readFileSync(path.join(task.a, 'same.txt'), 'utf8'), 'parent-task');
  assert.equal(git(task.a, 'status', '--porcelain'), '', 'the parent gitlink and source submodule agree after fast-forward');
  assert.equal(git(task.b, 'status', '--porcelain'), '');

  const noFf = setup('no-ff');
  const noFfResult = await integrateTaskWorktrees(noFf.ctx, noFf.owner, { noFf: true, skipNpmInstall: true, skipTypecheck: true });
  assert.equal(noFfResult.ok, true, noFfResult.message);
  assert.ok(noFfResult.warnings.some(warning => warning.includes(noFf.relative)), 'merge-commit submodule HEAD is retained with an explicit parent gitlink warning');
  assert.equal(git(noFf.child, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(noFf.child, 'rev-parse', 'HEAD'), noFf.owner.worktreeGroups.groups[0].integration[0].mergedCommit);
  assert.notEqual(git(noFf.child, 'rev-parse', 'HEAD'), git(noFf.nested, 'rev-parse', 'HEAD'));

  const partial = setup('partial'); const opts = { noFf: true, skipNpmInstall: true, skipTypecheck: true };
  const hook = path.join(partial.a, '.git/hooks/pre-merge-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho fixture-parent-failure >&2\nexit 1\n'); fs.chmodSync(hook, 0o755);
  const failure = await integrateTaskWorktrees(partial.ctx, partial.owner, opts);
  assert.equal(failure.ok, false); assert.match(failure.message, /fixture-parent-failure/);
  assert.deepEqual(partial.owner.worktreeGroups.groups.map(group => group.integration.map(entry => entry.status)), [['merged', 'failed'], ['not-started']]);
  const sourceHeads = [git(partial.a, 'rev-parse', 'HEAD'), git(partial.b, 'rev-parse', 'HEAD')];
  const moduleMerge = partial.owner.worktreeGroups.groups[0].integration[0].mergedCommit;
  Object.assign(partial.owner, JSON.parse(JSON.stringify(partial.snapshots.at(-1)))); normalizeSessionWorktrees(partial.owner);
  fs.unlinkSync(hook);
  const userFile = path.join(partial.child, 'user-work.txt'); fs.writeFileSync(userFile, 'user work');
  const dirtyRetry = await integrateTaskWorktrees(partial.ctx, partial.owner, opts);
  assert.equal(dirtyRetry.ok, false, 'a dirty source child cannot be attributed to the previous merge');
  assert.deepEqual([git(partial.a, 'rev-parse', 'HEAD'), git(partial.b, 'rev-parse', 'HEAD')], sourceHeads);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'user work'); fs.unlinkSync(userFile);
  git(partial.a, 'add', partial.relative);
  const userIndex = git(partial.a, 'ls-files', '--stage', '--', partial.relative);
  const stagedRetry = await integrateTaskWorktrees(partial.ctx, partial.owner, opts);
  assert.equal(stagedRetry.ok, false, 'a staged source gitlink remains user work');
  assert.equal(git(partial.a, 'ls-files', '--stage', '--', partial.relative), userIndex);
  git(partial.a, 'reset', '--', partial.relative);
  const retry = await integrateTaskWorktrees(partial.ctx, partial.owner, opts);
  assert.equal(retry.ok, true, retry.message);
  assert.equal(git(partial.child, 'rev-parse', 'HEAD'), moduleMerge, 'restart retry never remerges or checks out the already completed child');
  assert.deepEqual(partial.owner.worktreeGroups.groups.map(group => group.integration.map(entry => entry.status)), [['already-merged', 'merged'], ['merged']]);
  const gate = setup('gate-abort', true);
  const gateResult = await integrateTaskWorktrees(gate.ctx, gate.owner, { noFf: true, skipNpmInstall: true, onGateFail: 'abort' });
  assert.equal(gateResult.ok, false, 'the parent typecheck gate still aborts its own merge');
  assert.equal(git(gate.child, 'symbolic-ref', '--short', 'HEAD'), 'main', 'parent rollback does not recursively detach the completed child');
  const completedChild = gate.owner.worktreeGroups.groups[0].integration[0].mergedCommit;
  assert.equal(git(gate.child, 'rev-parse', 'HEAD'), completedChild);
  const gateRetry = await integrateTaskWorktrees(gate.ctx, gate.owner, { noFf: true, skipNpmInstall: true, skipTypecheck: true });
  assert.equal(gateRetry.ok, true, gateRetry.message);
  assert.equal(git(gate.child, 'rev-parse', 'HEAD'), completedChild);
  console.log('ok task-worktree-integrate-submodule: unicode/spaces gitlinks, FF/no-FF warning, parent failure/restart, dirty child/staged gitlink preservation, gate abort without recursive child reset');
} finally {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(tempRoot) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
}
