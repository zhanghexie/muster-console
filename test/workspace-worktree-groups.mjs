/** Real linked checkouts: all task directory mappings and secondary-group provenance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(project, '.tmp'); fs.mkdirSync(tempRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(tempRoot, 'workspace-worktree-groups-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const load = rel => import(pathToFileURL(compile(rel)).href);
const { captureWorkspaceExecutionContext, additionalExecutionDirectories } = await load('main/workspaceExecutionContext.ts');
const { resolveSessionTarget, registeredWorktreeSession } = await load('main/sessions/targets.ts');
const { decideToolCallPermission } = await load('main/agentSession/tools/policy.ts');
const { sourcePathKey } = await load('main/workspacePaths.ts');
const { normalizeSessionWorktrees } = await load('shared/sessionWorktrees.ts');
const { cleanupSessionWorktreeOnArchive, discardSessionWorktree, healMissingSessionWorktree } = await load('main/git/worktreeSessionOps.ts');
const { integrateSessionWorktree } = await load('main/git/worktreeIntegrate.ts');
const { GitService } = await load('main/git/service.ts');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const emptyConfig = path.join(fixture, 'gitconfig'); fs.writeFileSync(emptyConfig, '');
Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function init(source, tree) {
  fs.mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(source, 'same.txt'), path.basename(source));
  git(source, 'add', '.'); git(source, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git(source, 'worktree', 'add', '-q', '-b', 'ao/task', tree, 'main');
}
try {
  const a = path.join(fixture, 'a'), b = path.join(fixture, 'b');
  const ta = path.join(fixture, 'tree-a'), tb = path.join(fixture, 'tree-b');
  init(a, ta); init(b, tb);
  const source = (rootId, folder) => ({ rootId, path: folder, cwd: folder, physicalPath: sourcePathKey(folder) });
  const group = (id, folder, tree) => ({ id, path: tree, sourceRoot: source(id, folder),
    source: { mainRepo: folder, commonDir: path.join(folder, '.git') }, branch: 'ao/task', baseBranch: 'main', repos: [] });
  const workspace = { id: 'ws', name: 'Multi', path: b, controlRoot: a, defaultRootId: 'b', rootsRevision: 1,
    roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
  const config = { workspaces: [workspace], activeWorkspaceId: 'ws' };
  const owner = { id: 'owner', name: 'Task', type: 'terminal', workspaceId: 'ws', cwd: ta, sourceRoot: source('a', a),
    worktreeGroups: { version: 1, primaryGroupId: 'a', groups: [group('b', b, tb), group('a', a, ta)] } };
  normalizeSessionWorktrees(owner);
  const context = captureWorkspaceExecutionContext(config, owner);
  assert.equal(context.cwd, ta);
  assert.deepEqual(context.writableDirectories.map(dir => dir.path), [tb, ta]);
  assert.deepEqual(context.mappings.map(map => [map.rootId, map.sourcePath, map.worktreePath]), [['b', b, tb], ['a', a, ta]]);
  assert.deepEqual(additionalExecutionDirectories(context), [tb]);
  const decide = (tool, file) => decideToolCallPermission({ mode: 'auto', planExecuting: false,
    engineToolName: tool, input: { path: file }, cwd: ta, workspaceContext: context,
    hostToolIds: [], hostClassOf: () => 'edit', userRules: [] }).decision;
  for (const folder of [ta, tb]) assert.equal(decide('Write', path.join(folder, 'new.txt')), 'auto');
  for (const folder of [a, b]) {
    assert.equal(decide('Write', path.join(folder, 'new.txt')), 'deny');
    assert.equal(decide('Read', path.join(folder, 'same.txt')), 'auto');
  }
  const borrower = { id: 'borrowed', type: 'terminal', workspaceId: 'ws', cwd: tb, sourceRoot: source('b', b) };
  assert.equal(registeredWorktreeSession([owner, borrower], tb, 'ws'), owner);
  assert.deepEqual(captureWorkspaceExecutionContext(config, borrower, [owner, borrower]).writableDirectories.map(dir => dir.path), [tb, ta]);
  assert.equal(borrower.worktreeGroups, undefined, 'a borrowed second-group path does not acquire ownership');
  const target = await resolveSessionTarget(config, { workspaceId: 'ws', cwd: tb }, owner);
  assert.equal(target.sourceRoot.rootId, 'b'); assert.equal(target.sourceRoot.cwd, b);
  await assert.rejects(resolveSessionTarget(config, { workspaceId: 'ws', rootId: 'a', cwd: tb }, owner), /changed/);
  workspace.roots.pop();
  assert.throws(() => captureWorkspaceExecutionContext(config, owner), /source folder not found/);
  workspace.roots.push({ id: 'b', path: b });
  const originalGitfile = fs.readFileSync(path.join(tb, '.git'));
  fs.copyFileSync(path.join(ta, '.git'), path.join(tb, '.git'));
  assert.throws(() => captureWorkspaceExecutionContext(config, owner), /repository identity changed/);
  fs.unlinkSync(path.join(tb, '.git')); // Windows Git/copy can mark a gitfile read-only.
  fs.writeFileSync(path.join(tb, '.git'), originalGitfile);
  const alias = path.join(fixture, 'source-alias');
  fs.symlinkSync(b, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedOwner = structuredClone(owner); aliasedOwner.worktreeGroups.groups[0].sourceRoot.path = alias;
  workspace.roots[1].path = alias;
  captureWorkspaceExecutionContext(config, aliasedOwner);
  fs.unlinkSync(alias); fs.symlinkSync(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => captureWorkspaceExecutionContext(config, aliasedOwner), /source folder changed/);
  fs.unlinkSync(alias); workspace.roots[1].path = b;

  let mutations = 0; const notices = [];
  const lifecycle = { git: new Proxy({}, { get: () => () => { mutations++; throw new Error('must not mutate'); } }),
    config: { get: () => config }, notify: { push: notice => notices.push(notice) },
    workspaceIdFor: () => 'ws', resolveWorkspaceId: () => 'ws', persist() {}, broadcast() {}, findSession: () => owner };
  const invalidOwner = structuredClone(owner);
  invalidOwner.worktreeGroups.groups[0].source.commonDir = path.join(a, '.git');
  lifecycle.findSession = () => invalidOwner;
  await assert.rejects(cleanupSessionWorktreeOnArchive(lifecycle, invalidOwner), /invalid or duplicate worktree source repository/);
  await assert.rejects(discardSessionWorktree(lifecycle, invalidOwner.id), /invalid or duplicate worktree source repository/);
  await assert.rejects(integrateSessionWorktree(lifecycle, owner.id), /invalid or duplicate worktree source repository/);
  assert.throws(() => healMissingSessionWorktree(lifecycle, invalidOwner), /invalid or duplicate worktree source repository/);
  lifecycle.findSession = () => owner;
  healMissingSessionWorktree(lifecycle, owner);
  assert.equal(mutations, 0, 'malformed topology cannot mutate any group through a lifecycle entry');
  assert.equal(owner.worktreeGroups.groups.length, 2);
  assert.equal(fs.existsSync(path.join(ta, 'same.txt')), true);
  assert.equal(fs.existsSync(path.join(tb, 'same.txt')), true);
  // Existing one-group operations must update the saved collection before restart.
  git(a, 'branch', 'release');
  const single = structuredClone(owner);
  single.id = 'single'; single.worktreeGroups.groups = [single.worktreeGroups.groups[1]];
  normalizeSessionWorktrees(single);
  const service = new GitService({ get: () => ({ ...config, workspace: a, worktreeStorageRoot: path.join(fixture, 'managed') }) });
  fs.writeFileSync(path.join(tb, 'same.txt'), 'public-merge-source');
  git(tb, 'add', '.'); git(tb, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'public merge');
  const publicMerge = await service.mergeIsolateBranch(tb, 'ao/task', { skipNpmInstall: true, skipTypecheck: true,
    sourceCommit: git(b, 'rev-parse', 'main'),
    beforeWrite: async () => { throw new Error('untrusted task guard'); }, sourceGitlinks: [] });
  assert.equal(publicMerge.ok, true, 'public options cannot inject coordinator-only callbacks');
  assert.equal(fs.readFileSync(path.join(b, 'same.txt'), 'utf8'), 'public-merge-source', 'a forged sourceCommit cannot replace the authorized source branch');
  const integrating = { ...lifecycle, git: service, findSession: () => single,
    awareness: null, emitRuntimeFacts() {}, setPhase() {}, setLiveStatus() {}, recordAcceptance() {}, setArchived() {} };
  const integrated = await integrateSessionWorktree(integrating, single.id, { targetBranch: 'release', skipNpmInstall: true, skipTypecheck: true });
  assert.equal(integrated.merged, true);
  assert.equal(single.worktreeBaseBranch, 'release');
  assert.equal(single.worktreeGroups.groups[0].baseBranch, 'release', 'merge target persists into the normalized group');
  const diskCopy = JSON.parse(JSON.stringify(single)); normalizeSessionWorktrees(diskCopy);
  assert.equal(diskCopy.worktreeBaseBranch, 'release');
  await cleanupSessionWorktreeOnArchive(integrating, single);
  assert.equal(single.worktreeGroups, undefined, 'cleanup clears new accounting as well as legacy projections');
  assert.equal(single.worktreePath, undefined);
  assert.equal(fs.existsSync(ta), false);
  assert.equal(fs.existsSync(tb), true, 'the other fixture checkout is independent');
  integrating.findSession = () => undefined; // The production archive callback is harmless after fixture disposal.
  console.log('ok workspace-worktree-groups: true Git mappings, read/write SDK scope, secondary borrow/source, identity/Junction/removal checks and lifecycle protection');
} finally {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(tempRoot) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
}
