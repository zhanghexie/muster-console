/** Actual Git transactions: prepare every source, materialize every tree, then provision. */
// @test-shards 2
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { inShard } from './helpers/shard.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(project, '.tmp'); fs.mkdirSync(tempRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(tempRoot, 'task-worktree-create-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
if (process.argv.includes('--baseline-layout')) {
  const file = compile('main/git/workspaceResolve.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('return paths.join(storageRoot, task, repo);',
    "return path.join(storageRoot, storageKey(`workspace-${workspaceId}`, false), storageKey(commonDir), taskId.replace(/-/g, '').slice(0, 8));"));
}
const load = rel => import(pathToFileURL(compile(rel)).href);
const { GitService } = await load('main/git/service.ts');
const { createTaskWorktreeGroups, normalizeWorktreeGroupSelections } = await load('main/git/worktreeTaskCreate.ts');
const { resolveSessionTarget } = await load('main/sessions/targets.ts');
const { workspaceRootUsesFor } = await load('main/workspaceRootUses.ts');
const { captureWorkspaceExecutionContext } = await load('main/workspaceExecutionContext.ts');
const { normalizeSessionWorktrees } = await load('shared/sessionWorktrees.ts');
const { workspaceRootDependencies } = await load('main/workspaceRootDependencies.ts');
const { sourcePathKey } = await load('main/workspacePaths.ts');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const emptyConfig = path.join(fixture, 'gitconfig'); fs.writeFileSync(emptyConfig, '');
Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(folder, message = 'fixture') { git(folder, 'add', '.'); git(folder, '-c', 'commit.gpgsign=false', 'commit', '-qm', message); }
function init(folder, ignores = '') {
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'user.name', 'Fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(folder, 'same.txt'), 'baseline');
  fs.writeFileSync(path.join(folder, 'src', 'start.txt'), 'tracked cwd');
  if (ignores) fs.writeFileSync(path.join(folder, '.gitignore'), ignores);
  commit(folder);
}
let sequence = 0;
function setup(suffix, folders, extraRoots = []) {
  const roots = folders.map((folder, index) => ({ id: String.fromCharCode(97 + index), path: folder }));
  roots.push(...extraRoots);
  const workspace = { id: `ws-${suffix}`, name: 'Multi', path: folders[0], controlRoot: folders[0], rootsRevision: 1,
    roots, defaultRootId: 'a' };
  const cfg = { workspace: folders[0], workspaces: [workspace], activeWorkspaceId: workspace.id,
    worktreeStorageRoot: path.join(fixture, `managed-${suffix}`) };
  const config = { get: () => cfg };
  const service = new GitService(config);
  return { workspace, cfg, config, service };
}
async function create(scope, extra = {}) {
  const target = extra.target ?? await resolveSessionTarget(scope.cfg, { workspaceId: scope.workspace.id, rootId: 'a' });
  return createTaskWorktreeGroups({ config: scope.config, git: scope.service }, {
    target, sessionId: `t${String(++sequence).padStart(7, '0')}-fixture`,
    selections: [{ rootId: 'a', relativePath: '' }, { rootId: 'b', relativePath: '' }], provisionCommands: [], ...extra
  });
}
function branches(folder) { return git(folder, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ao/'); }
function noTasks(folders) {
  for (const folder of folders) { assert.equal(branches(folder), ''); assert.equal(git(folder, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1); }
}
function expectOk(result) { assert.equal(result.ok, true, result.message); return result; }
function expectFailure(result, pattern) { assert.equal(result.ok, false); assert.match(result.message, pattern); }

try {
  await (async () => {
  for (const selections of [[], [{ rootId: 'a', relativePath: '../outside' }], [{ rootId: 'a', relativePath: 'D:\\foreign' }], [{ rootId: 'a', relativePath: '/absolute' }]]) assert.throws(() => normalizeWorktreeGroupSelections(selections), /isolation|relative/);

  const a = path.join(fixture, 'a'), b = path.join(fixture, 'b'); init(a); init(b);
  if (!process.argv.includes('--nested-only') && inShard(0)) {
  const flat = setup('flat', [a, b]);
  const target = await resolveSessionTarget(flat.cfg, { workspaceId: flat.workspace.id, cwd: path.join(a, 'src') });
  const promise = createTaskWorktreeGroups({ config: flat.config, git: flat.service }, { target, sessionId: 'lease001-fixture',
    selections: [{ rootId: 'a', relativePath: '' }, { rootId: 'b', relativePath: '' }], provisionCommands: [] });
  assert.deepEqual(workspaceRootUsesFor(flat.config).list(flat.workspace.id).map(use => use.rootId).sort(), ['a', 'b'], 'all sources are held before the first await');
  const first = expectOk(await promise);
  assert.equal(workspaceRootUsesFor(flat.config).list(flat.workspace.id).length, 0);
  assert.equal(first.state.groups.length, 2);
  assert.equal(first.state.groups[0].baseCommit, git(a, 'rev-parse', 'HEAD'));
  assert.equal(first.cwd, path.join(first.state.groups[0].path, 'src'));
  const namespace = first.state.groups.map(group => path.dirname(group.path));
  assert.deepEqual(await first.rollback(), []); noTasks([a, b]);
  flat.workspace.defaultRootId = 'b'; flat.workspace.roots.reverse(); flat.workspace.path = b;
  const second = expectOk(await create(flat, { target, sessionId: 'lease001-fixture' }));
  assert.deepEqual(second.state.groups.map(group => path.dirname(group.path)), namespace, 'same task retains its namespace regardless of defaults/order');
  assert.deepEqual(await second.rollback(), []); noTasks([a, b]);
  flat.workspace.roots.reverse(); flat.workspace.defaultRootId = 'a';

  // Existing long-layout trees and persisted mappings survive new short trees.
  const legacyPath = path.join(flat.cfg.worktreeStorageRoot, 'workspace-legacy-long-id', '-git-legacy-hash', 'legacy01');
  git(a, 'worktree', 'add', '-q', '-b', 'ao/legacy01', legacyPath, 'main');
  fs.writeFileSync(path.join(legacyPath, 'personal.txt'), 'keep existing work');
  const legacy = { id: 'legacy01-session', worktreePath: legacyPath, worktreeBranch: 'ao/legacy01',
    worktreeBaseBranch: 'main', worktreeSource: { mainRepo: a, commonDir: path.join(a, '.git') } };
  normalizeSessionWorktrees(legacy);
  const saved = JSON.stringify(legacy);
  const compact = expectOk(await create(flat, { sessionId: 'compact1-full-session' }));
  for (const group of compact.state.groups) {
    const parts = path.relative(flat.cfg.worktreeStorageRoot, group.path).split(path.sep);
    assert.equal(parts.length, 2, 'new production creation must use the compact layout');
    assert.match(parts[0], /^t-[a-f0-9]{12}$/);
    assert.match(parts[1], /-[a-f0-9]{10}$/);
  }
  assert.equal(JSON.stringify(legacy), saved);
  assert.equal(fs.readFileSync(path.join(legacyPath, 'personal.txt'), 'utf8'), 'keep existing work');
  // Different full IDs with the same legacy branch prefix must fail without
  // borrowing the first task's tree or deleting its branch.
  const duplicatePrefix = await create(flat, { sessionId: 'compact1-another-session' });
  expectFailure(duplicatePrefix, /branch already exists/);
  assert.equal(git(compact.state.groups[0].path, 'branch', '--show-current'), 'ao/compact1');
  assert.deepEqual(await compact.rollback(), []);
  fs.unlinkSync(path.join(legacyPath, 'personal.txt'));
  git(a, 'worktree', 'remove', legacyPath); git(a, 'branch', '-D', 'ao/legacy01'); noTasks([a, b]);

  // A colliding empty directory created after preparation is not reused.
  const occupied = (await flat.service.prepareSessionWorktreeGroup(a, 'occupied-session', [], flat.workspace.id)).plan;
  fs.mkdirSync(occupied.path, { recursive: true });
  const denied = await flat.service.materializeSessionWorktreeGroup(occupied);
  assert.equal(denied.ok, false); assert.match(denied.message, /already exists/);
  assert.deepEqual(fs.readdirSync(occupied.path), []);
  noTasks([a, b]); fs.rmdirSync(occupied.path);
  console.log('ok compact layout: legacy preservation, same-prefix branch collision and empty destination protection');

  const racing = await Promise.all(['raceA', 'raceB'].map(newBranch => flat.service.worktreeAdd(a, { dirName: 'same-short-key', newBranch, baseRef: 'main' })));
  assert.equal(racing.filter(result => result.ok).length, 1, 'exclusive directory reservation admits one creator');
  const winner = racing.find(result => result.ok);
  assert.equal(path.relative(flat.cfg.worktreeStorageRoot, winner.path).split(path.sep).length, 2);
  assert.equal(git(winner.path, 'branch', '--show-current'), winner.branch);
  git(a, 'worktree', 'remove', winner.path); git(a, 'branch', '-D', winner.branch);
  const single = await flat.service.addSessionWorktree(a, 'single01-full-identity');
  assert.equal(single.ok, true, single.message);
  assert.equal(path.relative(flat.cfg.worktreeStorageRoot, single.path).split(path.sep).length, 2);
  git(a, 'worktree', 'remove', single.path); git(a, 'branch', '-D', single.branch); noTasks([a, b]);
  if (process.argv.includes('--compact-only')) return;

  const nongit = path.join(fixture, 'nongit'); fs.mkdirSync(nongit);
  flat.workspace.roots.push({ id: 'plain', path: nongit });
  const invalid = await create(flat, { selections: [{ rootId: 'a', relativePath: '' }, { rootId: 'plain', relativePath: '' }] });
  expectFailure(invalid, /primary Git/); noTasks([a, b]);
  assert.equal(fs.existsSync(path.join(a, '.git', 'info', 'exclude')), true);
  assert.throws(() => normalizeWorktreeGroupSelections([{ rootId: 'a', relativePath: '', repoSet: ['../escape'] }]), /repoSet|relative|路径/);
  fs.mkdirSync(path.join(a, 'untracked-cwd'));
  const missingCwd = await resolveSessionTarget(flat.cfg, { workspaceId: flat.workspace.id, cwd: path.join(a, 'untracked-cwd') });
  const absent = await create(flat, { target: missingCwd }); expectFailure(absent, /baseline|path.*does not exist/i); noTasks([a, b]);
  const badRecipe = await create(flat, { groupProvisionCommands: [{ rootId: 'b', relativePath: 'src', commands: ['exit 0'] }] });
  expectFailure(badRecipe, /repository root/); noTasks([a, b]);

  const materialize = flat.service.materializeSessionWorktreeGroup.bind(flat.service);
  let calls = 0;
  flat.service.materializeSessionWorktreeGroup = async (...args) => ++calls === 2 ? { ok: false, message: 'second group fixture failure' } : materialize(...args);
  const failed = await create(flat); expectFailure(failed, /second group/); assert.deepEqual(failed.residuals, []); noTasks([a, b]);

  let keptPath; calls = 0;
  flat.service.materializeSessionWorktreeGroup = async (...args) => {
    if (++calls === 2) { fs.writeFileSync(path.join(keptPath, 'new-work.txt'), 'must survive'); return { ok: false, message: 'second group dirty failure' }; }
    const result = await materialize(...args); keptPath = result.path; return result;
  };
  const dirty = await create(flat); expectFailure(dirty, /dirty failure/);
  assert.equal(dirty.residuals.length, 1); assert.match(dirty.residuals[0].message, /files changed/);
  assert.equal(fs.readFileSync(path.join(keptPath, 'new-work.txt'), 'utf8'), 'must survive');
  fs.unlinkSync(path.join(keptPath, 'new-work.txt'));
  git(a, 'worktree', 'remove', keptPath); git(a, 'branch', '-D', dirty.residuals[0].branch); noTasks([a, b]);

  calls = 0; flat.service.materializeSessionWorktreeGroup = async (...args) => {
    if (++calls === 2) { git(keptPath, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'new task commit'); return { ok: false, message: 'second group commit failure' }; }
    const result = await materialize(...args); keptPath = result.path; return result;
  };
  const committed = await create(flat); expectFailure(committed, /commit failure/); assert.match(committed.residuals[0].message, /branch changed/);
  const keptHead = git(keptPath, 'rev-parse', 'HEAD'); assert.notEqual(keptHead, git(a, 'rev-parse', 'HEAD'));
  git(a, 'worktree', 'remove', keptPath); git(a, 'branch', '-D', committed.residuals[0].branch); noTasks([a, b]);

  // A simultaneous creator's identical destination is never owned by a failed add.
  let collidedPath; calls = 0; flat.service.materializeSessionWorktreeGroup = async (plan, ...args) => {
    if (++calls === 2) { collidedPath = plan.path; git(b, 'worktree', 'add', '-q', '-b', plan.branch, plan.path, plan.main.baseCommit); }
    return materialize(plan, ...args);
  };
  const collided = await create(flat); expectFailure(collided, /branch|already exists/i);
  assert.equal(fs.existsSync(collidedPath), true); assert.equal(collided.residuals.length, 1); assert.match(collided.residuals[0].message, /ownership/);
  git(b, 'worktree', 'remove', collidedPath); git(b, 'branch', '-D', collided.residuals[0].branch); noTasks([a, b]);
  flat.service.materializeSessionWorktreeGroup = materialize;
  fs.writeFileSync(path.join(a, 'same.txt'), 'source changes stay in source');
  const provisionFailure = expectOk(await create(flat, { provisionCommands: ['exit 1'] }));
  assert.ok(provisionFailure.warnings.some(warning => warning.includes('same.txt')));
  assert.ok(provisionFailure.warnings.some(warning => /provision/.test(warning)));
  assert.equal(fs.readFileSync(path.join(provisionFailure.state.groups[0].path, 'same.txt'), 'utf8'), 'baseline');
  assert.equal(fs.readFileSync(path.join(a, 'same.txt'), 'utf8'), 'source changes stay in source');
  assert.ok(provisionFailure.state.groups.every(group => fs.existsSync(group.path)), 'failed commands retain the complete task');
  assert.deepEqual(await provisionFailure.rollback(), []); noTasks([a, b]);
  fs.writeFileSync(path.join(a, 'same.txt'), 'baseline');
  const retargeted = await create(flat, { provisionCommands: ['git checkout -b fixture-provision-retarget', 'echo wrong > should-not-run.txt'] });
  expectFailure(retargeted, /task worktree identity changed/);
  assert.equal(retargeted.residuals.length, 1);
  assert.equal(fs.existsSync(path.join(retargeted.residuals[0].path, 'should-not-run.txt')), false, 'preparation cannot continue in a changed task branch');
  assert.match(retargeted.residuals[0].message, /branch changed/);
  git(a, 'worktree', 'remove', retargeted.residuals[0].path);
  git(a, 'branch', '-D', retargeted.residuals[0].branch, 'fixture-provision-retarget'); noTasks([a, b]);
  console.log('ok task-worktree-create: flat preflight/rollback and changed task ownership');

  let changed = false; flat.service.materializeSessionWorktreeGroup = async (...args) => {
    if (!changed) { changed = true; git(b, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'source moved during preparation'); }
    return materialize(...args);
  };
  const movedBase = await create(flat); expectFailure(movedBase, /baseline changed/); noTasks([a, b]);
  flat.service.materializeSessionWorktreeGroup = materialize;
  const prepared = await flat.service.prepareSessionWorktreeGroup(a, 'frozen01-fixture', undefined, flat.workspace.id);
  assert.throws(() => { prepared.plan.main.baseCommit = 'changed'; }, TypeError);
  await assert.rejects(flat.service.materializeSessionWorktreeGroup(structuredClone(prepared.plan)), /unknown or modified/);
  noTasks([a, b]);

  const storageA = path.join(fixture, 'storage-a'), storageB = path.join(fixture, 'storage-b'), storageAlias = path.join(fixture, 'storage-alias');
  fs.mkdirSync(storageA); fs.mkdirSync(storageB); fs.symlinkSync(storageA, storageAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const savedStorage = flat.cfg.worktreeStorageRoot; flat.cfg.worktreeStorageRoot = storageAlias;
  calls = 0; flat.service.materializeSessionWorktreeGroup = async (...args) => {
    if (++calls === 2) { fs.unlinkSync(storageAlias); fs.symlinkSync(storageB, storageAlias, process.platform === 'win32' ? 'junction' : 'dir'); }
    return materialize(...args);
  };
  const movedStorage = await create(flat); expectFailure(movedStorage, /storage identity changed/);
  assert.deepEqual(movedStorage.residuals, []); noTasks([a, b]);
  fs.unlinkSync(storageAlias); flat.cfg.worktreeStorageRoot = savedStorage;
  flat.service.materializeSessionWorktreeGroup = materialize;
  console.log('ok task-worktree-create: pinned source baselines, frozen host plans and storage Junction rollback');

  }
  if (!inShard(1)) return;
  const parent = path.join(fixture, 'parent'), child = path.join(parent, 'Plugins', 'One'), grandchild = path.join(child, 'Core', 'Two');
  init(parent, '/Plugins/\n'); init(child, '/Core/\n'); init(grandchild);
  const seed = path.join(fixture, 'submodule-seed'); init(seed);
  git(grandchild, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', seed, 'modules/Sub'); commit(grandchild, 'pin submodule');
  const submodule = path.join(grandchild, 'modules', 'Sub');
  const pin = git(submodule, 'rev-parse', 'HEAD');
  git(submodule, 'config', 'user.name', 'Fixture'); git(submodule, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(submodule, 'same.txt'), 'later unpinned'); commit(submodule, 'later source commit');
  const nested = setup('nested', [parent, b], [{ id: 'child', path: child }]);
  const nestedTarget = await resolveSessionTarget(nested.cfg, { workspaceId: nested.workspace.id, rootId: 'child', cwd: path.join(child, 'src') });
  const trace = path.join(fixture, 'provision.ndjson'), script = path.join(fixture, 'provision.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs'); const path = require('node:path');
const groups = JSON.parse(process.env.MUSTER_WORKTREE_GROUPS_JSON);
for (const group of groups) if (!fs.existsSync(path.join(group.worktreePath, '.git'))) throw new Error('provision ran before every group');
const primary = process.env.MUSTER_WORKTREE_PRIMARY;
if (!fs.existsSync(path.join(primary, 'Plugins/One/Core/Two/modules/Sub/.git'))) throw new Error('provision ran before all nested trees');
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({cwd: process.cwd(), tag: process.argv[2], groups, workspaceId: process.env.MUSTER_WORKSPACE_ID, controlRoot: process.env.MUSTER_WORKSPACE_CONTROL_ROOT}) + '\\n');`);
  const command = tag => `"${process.execPath}" "${script}" ${tag}`;
  const ready = expectOk(await create(nested, { target: nestedTarget,
    selections: [{ rootId: 'a', relativePath: '', repoSet: ['Plugins/One'] }, { rootId: 'child', relativePath: '' }, { rootId: 'b', relativePath: '' }],
    provisionCommands: [command('legacy')],
    groupProvisionCommands: [{ rootId: 'b', relativePath: '', commands: [command('b')] }, { rootId: 'child', relativePath: 'Core/Two', commands: [command('deep')] }] }));
  assert.equal(ready.state.groups.length, 2, 'parent/child selected roots share a real container');
  const primary = ready.state.groups.find(group => group.id === ready.state.primaryGroupId);
  assert.deepEqual(primary.repos.map(repo => repo.path), ['Plugins/One', 'Plugins/One/Core/Two', 'Plugins/One/Core/Two/modules/Sub']);
  assert.equal(primary.repos.at(-1).kind, 'submodule'); assert.equal(primary.repos.at(-1).baseCommit, pin);
  assert.equal(git(path.join(primary.path, 'Plugins/One/Core/Two/modules/Sub'), 'rev-parse', 'HEAD'), pin);
  assert.equal(fs.readFileSync(path.join(primary.path, 'Plugins/One/Core/Two/modules/Sub/same.txt'), 'utf8'), 'baseline');
  assert.equal(ready.cwd, path.join(primary.path, 'Plugins/One/src'));
  const rows = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.tag), ['legacy', 'b', 'deep']);
  assert.deepEqual(rows.map(row => sourcePathKey(row.cwd)), [primary.path, ready.state.groups.find(group => group !== primary).path, path.join(primary.path, 'Plugins/One/Core/Two')].map(sourcePathKey));
  assert.ok(rows.every(row => row.workspaceId === nested.workspace.id && sourcePathKey(row.controlRoot) === sourcePathKey(parent)));
  const session = { id: 'published', type: 'terminal', name: 'Task', workspaceId: nested.workspace.id, cwd: ready.cwd,
    sourceRoot: nestedTarget.sourceRoot, worktreeGroups: ready.state };
  normalizeSessionWorktrees(session);
  assert.equal(session.sourceRoot.rootId, 'child');
  assert.equal(captureWorkspaceExecutionContext(nested.cfg, session).writableDirectories.length, 2);
  assert.ok(workspaceRootDependencies({ config: nested.config, sessions: { rootDependencyRoster: () => [session] }, tasks: { rootDependencyRoster: () => [] } }, nested.workspace).some(item => item.rootId === 'child' && item.kind === 'worktree'));
  nested.workspace.roots = nested.workspace.roots.filter(root => root.id !== 'child');
  assert.throws(() => captureWorkspaceExecutionContext(nested.cfg, session), /source folder not found/);
  nested.workspace.roots.push({ id: 'child', path: child });
  assert.deepEqual(await ready.rollback(), []); noTasks([parent, child, grandchild, submodule, b]);

  // Two aliases selecting one source union their explicit nested members.
  const alias = path.join(fixture, 'parent-alias'); fs.symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  nested.workspace.roots.push({ id: 'alias', path: alias });
  const aliasReady = expectOk(await create(nested, { target: nestedTarget, selections: [
    { rootId: 'a', relativePath: '', repoSet: ['Plugins/One'] },
    { rootId: 'alias', relativePath: '', repoSet: ['Plugins/One/Core/Two/modules/Sub'] },
    { rootId: 'b', relativePath: '' }
  ] }));
  assert.equal(aliasReady.state.groups.length, 2);
  assert.equal(aliasReady.state.groups[0].repos.length, 3, 'physical aliases cannot silently lose the second selection');
  assert.deepEqual(await aliasReady.rollback(), []); noTasks([parent, child, grandchild, submodule, b]); fs.unlinkSync(alias);
  console.log('ok task-worktree-create: rooted preflight, synchronous leases, stable namespace, second-group rollback, dirty/committed/colliding preservation, three nested levels, pinned submodule, all-tree provision and selected-child provenance');
  })();
} finally {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(tempRoot) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
}
