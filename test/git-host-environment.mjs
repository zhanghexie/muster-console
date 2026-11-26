/** Explicit workspace Git operations must not inherit a parent checkout/index. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd(); fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'git-host-environment-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const load = rel => import(pathToFileURL(compile(rel)).href);
const { GitService } = await load('main/git/service.ts');
const { resolveSessionTarget } = await load('main/sessions/targets.ts');
const { createTaskWorktreeGroups } = await load('main/git/worktreeTaskCreate.ts');
const { integrateTaskWorktrees } = await load('main/git/worktreeTaskIntegrate.ts');
const { cleanupTaskWorktrees } = await load('main/git/worktreeTaskCleanup.ts');
const { rollbackPreparedTrees } = await load('main/git/worktreeRollback.ts');
const { normalizeSessionWorktrees } = await load('shared/sessionWorktrees.ts');
const { createHostGitClient } = await load('main/git/hostGitClient.ts');
const { commitMemoryChanges } = await load('main/git/memoryCommit.ts');
const { collectPipelineGitFacts } = await load('main/git/pipelineFacts.ts');
const { isTaskGitlinkChange } = await load('main/git/submoduleMergeState.ts');
const { readGitDirectories } = await load('main/git/repoIdentity.ts');
const { pathKey } = await load('main/pathKey.ts');
const { collectDimensionGates } = await load('main/dimensionGates/runner.ts');
const originalEnvironment = { ...process.env };
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
const globalConfig = path.join(fixture, 'gitconfig'); fs.writeFileSync(globalConfig, '[fixture]\nmarker = inherited-global\n');
Object.assign(clean, { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: clean, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function init(name, branch = 'main') {
  const folder = path.join(fixture, name); fs.mkdirSync(folder);
  git(folder, 'init', '-q', '-b', branch);
  git(folder, 'config', 'user.name', 'Fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
  git(folder, 'config', 'commit.gpgsign', 'false'); git(folder, 'config', 'core.hooksPath', path.join(fixture, 'no-hooks'));
  fs.writeFileSync(path.join(folder, 'same.txt'), name + '\n');
  git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'base'); return folder;
}
const sources = ['a', 'b'].map(id => ({ id, path: init('source-' + id) }));
const decoy = init('unrelated', 'unrelated');
fs.writeFileSync(path.join(decoy, 'same.txt'), 'unrelated user staged work\n'); git(decoy, 'add', '.');
const decoyHead = git(decoy, 'rev-parse', 'HEAD'), decoyIndexPath = path.join(decoy, '.git/index');
const decoyIndex = fs.readFileSync(decoyIndexPath), decoyStatus = git(decoy, 'status', '--porcelain');
const workspace = { id: 'env', path: sources[0].path, controlRoot: sources[0].path, roots: sources,
  defaultRootId: 'a', rootsRevision: 0 };
const cfg = { workspace: workspace.path, activeWorkspaceId: workspace.id, workspaces: [workspace],
  worktreeStorageRoot: path.join(fixture, 'managed') };
const config = { get: () => cfg }, service = new GitService(config);
const setEnvironment = values => {
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
  Object.assign(process.env, clean, values);
};
const intactDecoy = () => {
  assert.equal(git(decoy, 'rev-parse', 'HEAD'), decoyHead);
  assert.deepEqual(fs.readFileSync(decoyIndexPath), decoyIndex);
  assert.equal(git(decoy, 'status', '--porcelain'), decoyStatus);
  assert.equal(fs.readFileSync(path.join(decoy, 'same.txt'), 'utf8'), 'unrelated user staged work\n');
};
try {
  setEnvironment({}); await service.listRepos(); // Seed the real cached simple-git client before inheritance changes.
  setEnvironment({ GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy });
  assert.equal((await service.status(sources[0].path)).branch, 'main', 'cached host client must use the explicit source checkout');
  const host = createHostGitClient(sources[0].path, { ...process.env, GIT_SSH_COMMAND: 'host-ssh', GIT_ASKPASS: 'host-askpass' });
  assert.equal((await host.raw(['config', '--get', 'fixture.marker'])).trim(), 'inherited-global');
  for (const invoke of [
    () => host.raw(['-c', 'core.sshCommand=request-ssh', 'status']),
    () => host.raw(['-c', 'core.askPass=request-askpass', 'status']),
    () => host.addConfig('core.sshCommand', 'request-ssh'),
    () => host.status(['-c', 'core.sshCommand=request-ssh']),
    () => host.env({ GIT_DIR: path.join(decoy, '.git') })
  ]) await assert.rejects(async () => invoke(), /not permitted|cannot be supplied/);
  intactDecoy();
  setEnvironment({ GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: decoyIndexPath,
    GIT_COMMON_DIR: path.join(decoy, '.git'), GIT_OBJECT_DIRECTORY: path.join(decoy, '.git/objects'), GIT_NAMESPACE: 'parent',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: decoy });
  const target = await resolveSessionTarget(cfg, { workspaceId: workspace.id, rootId: 'b' });
  const created = await createTaskWorktreeGroups({ config, git: service }, { target,
    sessionId: 'envtask0-aaaa-bbbb-cccc-000000000000', selections: sources.map(root => ({ rootId: root.id, relativePath: '' })), provisionCommands: [] });
  assert.equal(created.ok, true, created.message);
  const owner = { id: 'env-task', name: 'env task', type: 'terminal', workspaceId: workspace.id, cwd: created.cwd,
    sourceRoot: target.sourceRoot, worktreeGroups: created.state };
  normalizeSessionWorktrees(owner);
  for (const group of owner.worktreeGroups.groups) {
    assert.equal(await service.runWorktreeProvision(group.path, ['git rev-parse --show-toplevel > environment-root.txt']), '');
    const marker = path.join(group.path, 'environment-root.txt');
    assert.equal(pathKey(fs.realpathSync(fs.readFileSync(marker, 'utf8').trim())), pathKey(fs.realpathSync(group.path))); fs.unlinkSync(marker);
    fs.writeFileSync(path.join(group.path, 'same.txt'), group.sourceRoot.rootId + ' task\n');
    git(group.path, 'add', '.'); git(group.path, 'commit', '-qm', 'task change');
    assert.equal((await service.status(group.path)).branch, group.branch);
    assert.deepEqual(await service.listUncommittedPaths(group.path), []);
    const facts = await collectPipelineGitFacts({ worktreePath: group.path, mainRepo: group.source.mainRepo, branch: group.branch });
    assert.equal(facts.uncommittedCount, 0); assert.equal(facts.aheadCount, 1); assert.equal(facts.canFastForward, true);
    assert.equal(facts.lastCommit.hash, git(group.path, 'rev-parse', 'HEAD'));
  }
  const ctx = { config, git: service, findSession: id => id === owner.id ? owner : undefined, sessions: () => [owner],
    workspaceIdFor: () => workspace.id, resolveWorkspaceId: () => workspace.id, notify: { push() {} }, persist() {}, flushPersist() {}, broadcast() {} };
  const merged = await integrateTaskWorktrees(ctx, owner, { skipNpmInstall: true, skipTypecheck: true });
  assert.equal(merged.ok, true, merged.message);
  for (const source of sources) assert.equal(fs.readFileSync(path.join(source.path, 'same.txt'), 'utf8'), source.id + ' task\n');
  let released = false;
  const removed = await cleanupTaskWorktrees(ctx, owner, 'archive', { release: async () => { released = true; } });
  assert.equal(removed.ok, true, removed.message); assert.equal(released, true); assert.equal(owner.worktreeGroups, undefined);
  intactDecoy();
  const prepared = await service.prepareSessionWorktreeGroup(sources[0].path, 'envroll0-aaaa-bbbb-cccc-000000000000', [], workspace.id);
  const materialized = await service.materializeSessionWorktreeGroup(prepared.plan);
  assert.equal(materialized.ok, true, materialized.message);
  const rollback = await rollbackPreparedTrees([{ repo: prepared.plan.main, path: prepared.plan.path, branch: prepared.plan.branch }]);
  assert.deepEqual(rollback, []); assert.equal(fs.existsSync(prepared.plan.path), false); intactDecoy();
  const memory = path.join(sources[0].path, 'docs/memory'); fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), 'fixture memory\n');
  const persisted = await commitMemoryChanges(sources[0].path); assert.equal(persisted.committed, true, persisted.message);
  assert.equal(git(sources[0].path, 'status', '--porcelain'), ''); intactDecoy();
  const childSource = init('child-source'), parent = init('parent-source');
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childSource, 'Child');
  git(parent, 'commit', '-qm', 'child baseline'); const parentBase = git(parent, 'rev-parse', 'HEAD');
  const child = path.join(parent, 'Child');
  git(child, 'config', 'user.name', 'Fixture'); git(child, 'config', 'user.email', 'fixture@example.invalid');
  git(child, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(child, 'same.txt'), 'child task\n'); git(child, 'add', '.'); git(child, 'commit', '-qm', 'child task');
  const childCommit = git(child, 'rev-parse', 'HEAD');
  git(parent, 'add', 'Child'); git(parent, 'commit', '-qm', 'incoming child link'); const incoming = git(parent, 'rev-parse', 'HEAD');
  git(parent, 'reset', '--mixed', parentBase);
  assert.equal(await isTaskGitlinkChange(parent, incoming, { relativePath: 'Child', sourcePath: pathKey(fs.realpathSync(child)),
    commonDir: pathKey(fs.realpathSync(readGitDirectories(child).commonDir)), taskCommit: childCommit, mergedCommit: childCommit }), true);
  const src = path.join(sources[0].path, 'src'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'fixture.css'), 'div { color: red; }\n');
  assert.ok(await collectDimensionGates({ cwd: sources[0].path }), 'delivery gates must read the requested source changes');
  intactDecoy();
  console.log('git-host-environment: global config/auth admission, argument guards, cached status, task create/provision/facts/integrate/cleanup, rollback and memory; decoy work/index preserved');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
}
