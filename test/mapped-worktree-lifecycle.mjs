/** Real Git: aggregate cwd, shared children, append transactions and delayed borrower release. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const originalLoad = Module._load;
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const project = process.cwd();
const load = name => require(path.join(project, 'src', name));
const { SessionsService } = load('main/sessions.ts');
const { GitService } = load('main/git/service.ts');
const { captureWorkspaceExecutionContext, pathWritableInContext } = load('main/workspaceExecutionContext.ts');
const { isolationRecommendation } = load('main/sessions/isolationPolicy.ts');
const { attachTaskWorktrees } = load('main/git/worktreeAttach.ts');
const { cleanupTaskWorktrees } = load('main/git/worktreeTaskCleanup.ts');
const { healMissingSessionWorktree } = load('main/git/worktreeSessionOps.ts');
const { workspaceRootUsesFor } = load('main/workspaceRootUses.ts');
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'mapped-worktree-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8',
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), stdio: ['ignore','pipe','pipe'] }).trim();
const init = folder => {
  fs.mkdirSync(folder, { recursive: true }); git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'core.autocrlf', 'false'); git(folder, 'config', 'user.name', 'Fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(folder, '.gitignore'), 'child/\n'); fs.writeFileSync(path.join(folder, 'file.txt'), 'baseline\n');
  git(folder, 'add', '.'); git(folder, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
};
try {
  const root = path.join(fixture, 'aggregate'); fs.mkdirSync(root);
  const a = path.join(root, 'a'), b = path.join(root, 'b'), c = path.join(root, 'c');
  for (const folder of [a,b,c]) init(folder);
  init(path.join(a, 'child'));
  init(path.join(a, 'child', 'grandchild'));
  const ws = { id: 'ws', name: 'Aggregate', path: root, controlRoot: root, defaultRootId: 'all', rootsRevision: 1,
    roots: [{ id: 'all', path: root }, { id: 'alias-a', path: a }] };
  const cfg = { defaultRuntime: 'pi', workspace: root, activeWorkspaceId: 'ws', workspaces: [ws], worktreeStorageRoot: path.join(fixture, 'trees') };
  const config = { get: () => cfg }, gitService = new GitService(config), rows = [], notices = [];
  const flow = { config, git: gitService, runtimes: { get: () => ({ enabled: true, surface: 'chat' }) }, sessions: rows,
    isChatRuntime: () => true, notify: { push: n => notices.push(n) }, usageStats: null, agentSessionsRef: null,
    applySelectDisplay() {}, persist() {}, broadcast() {}, get: id => rows.find(row => row.id === id), async launchTerminal() {} };
  const service = { config, sessions: rows, createTerminalCtx: () => flow };
  const create = opts => SessionsService.prototype.createTerminal.call(service, { workspaceId: 'ws', rootId: 'all', force: true, ...opts });
  const ctx = { ...flow, workspaceIdFor: () => 'ws', resolveWorkspaceId: () => 'ws', findSession: id => rows.find(row => row.id === id), sessions: () => rows };
  const recommendationCtx = { config, git: gitService, sessions: { listByWorkspace: () => rows } };
  assert.equal((await isolationRecommendation(recommendationCtx, 'ws', a)).isolate, false);
  // An active worker never changes the default for a clean repository.
  rows.push({ id: 'busy', name: 'busy', type: 'terminal', cwd: a, workspaceId: 'ws', lifecycle: 'working', createdAt: 0 });
  assert.equal((await isolationRecommendation(recommendationCtx, 'ws', a)).isolate, false);
  rows.length = 0;
  fs.writeFileSync(path.join(a, 'file.txt'), 'human dirty\n');
  assert.equal((await isolationRecommendation(recommendationCtx, 'ws', a)).isolate, true);
  const probe = gitService.probeDirty; gitService.probeDirty = async () => null;
  assert.equal((await isolationRecommendation(recommendationCtx, 'ws', a)).dirty, null); gitService.probeDirty = probe;
  const owner = await create({ cwd: root, isolate: true, isolationGroups: [{ rootId: 'all', relativePath: 'a' }] });
  assert.equal(owner.cwd, root); assert.equal(owner.worktreeGroups.cwdPolicy, 'source');
  assert.equal(owner.worktreeGroups.groups.length, 1); assert.equal(owner.worktreeRepoSet.length, 0);
  assert.equal(fs.readFileSync(path.join(owner.worktreePath, 'file.txt'), 'utf8'), 'baseline\n');
  assert.equal(fs.readFileSync(path.join(a, 'file.txt'), 'utf8'), 'human dirty\n');
  const context = captureWorkspaceExecutionContext(cfg, owner, rows);
  assert.equal(pathWritableInContext(path.join(a, 'file.txt'), context), false);
  assert.equal(pathWritableInContext(root, context), false, 'ancestor deletion cannot reopen the source');
  assert.equal(pathWritableInContext(path.join(b, 'new.txt'), context), true);
  assert.equal(pathWritableInContext(path.join(a, 'child', 'new.txt'), context), true, 'unmapped independent nested repository stays shared');
  assert.equal(pathWritableInContext(path.join(owner.worktreePath, 'new.txt'), context), true);
  const alias = path.join(root, 'alias'); fs.symlinkSync(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(pathWritableInContext(path.join(alias, 'new.txt'), context), false); fs.unlinkSync(alias);
  const onlyA = owner.worktreePath;
  const plan = attachTaskWorktrees(ctx, owner.id, [{ rootId: 'all', relativePath: 'b' }]);
  assert.ok(workspaceRootUsesFor(config).list('ws').length, 'append pins the source before first await');
  assert.equal((await plan).created, false); assert.equal(owner.worktreeGroups.groups.length, 1);
  // Repeated selections through overlapping roots are idempotent.
  assert.equal((await attachTaskWorktrees(ctx, owner.id, [{ rootId: 'all', relativePath: 'a' }, { rootId: 'alias-a', relativePath: '' }], true)).created, false);
  await assert.rejects(attachTaskWorktrees(ctx, owner.id, [{ rootId: 'all', relativePath: 'a', repoSet: ['child'] }], true), /实际子仓/);
  const added = await attachTaskWorktrees(ctx, owner.id, [{ rootId: 'all', relativePath: 'b' }], true);
  assert.equal(added.activation, 'next-connection'); assert.equal(owner.cwd, root); assert.equal(owner.worktreePath, onlyA);
  assert.equal(owner.worktreeGroups.groups.length, 2); assert.equal(owner.worktreeGroups.revision, 2);
  assert.equal(context.mappings.length, 1, 'current connection retains its immutable scope');
  const materialize = gitService.materializeSessionWorktreeGroup;
  gitService.materializeSessionWorktreeGroup = async () => ({ ok: false, message: 'append fixture failure' });
  const before = JSON.stringify(owner.worktreeGroups);
  assert.equal((await attachTaskWorktrees(ctx, owner.id, [{ rootId: 'all', relativePath: 'c' }], true)).ok, false);
  assert.equal(JSON.stringify(owner.worktreeGroups), before); assert.equal(owner.cwd, root);
  gitService.materializeSessionWorktreeGroup = materialize;
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  owner.hidden = true;
  await assert.rejects(attachTaskWorktrees(ctx, owner.id, [{ rootId: 'all', relativePath: 'c' }], true), /persistent agent/);
  delete owner.hidden;
  let failFlush = true;
  ctx.flushPersist = () => { if (failFlush) { failFlush = false; throw Error('fixture publication flush'); } };
  await assert.rejects(attachTaskWorktrees(ctx, owner.id, [{ rootId: 'all', relativePath: 'c' }], true), /publication flush/);
  assert.equal(JSON.stringify(owner.worktreeGroups), before, 'failed publication restores previous metadata before removing new resources');
  delete ctx.flushPersist;
  const borrower = await create({ cwd: root, sourceSessionId: owner.id });
  const { guardTaskWorktrees } = load('main/git/worktreeTaskWorker.ts');
  const borrowerFacts = await guardTaskWorktrees({ ...ctx, sessions: { get: ctx.findSession } }, borrower, false);
  assert.equal(borrowerFacts.failure, undefined); assert.equal(borrowerFacts.paths.length, 0);
  await assert.rejects(guardTaskWorktrees({ ...ctx, sessions: { get: ctx.findSession } }, borrower, true), /owned worktree/);
  assert.equal(borrower.worktreeGroups.borrowedFrom, owner.id); borrower.archived = true;
  let releaseBorrower;
  const releasing = cleanupTaskWorktrees(ctx, borrower, 'archive', { release: () => new Promise(resolve => { releaseBorrower = resolve; }) });
  assert.equal((await cleanupTaskWorktrees(ctx, owner, 'archive')).ok, false, 'archived does not mean the borrowing connection has released');
  assert.equal(fs.existsSync(onlyA), true); releaseBorrower(); await releasing;
  assert.equal(borrower.worktreeGroups, undefined); assert.equal(borrower.cwd, root);
  assert.equal((await cleanupTaskWorktrees(ctx, owner, 'archive')).ok, true);
  assert.equal(owner.cwd, root); assert.equal(owner.worktreeGroups, undefined);
  assert.equal(fs.readFileSync(path.join(a, 'file.txt'), 'utf8'), 'human dirty\n');
  const withChild = await create({ cwd: root, isolate: true, isolationGroups: [{ rootId: 'all', relativePath: 'a', repoSet: ['child'] }] });
  const nestedContext = captureWorkspaceExecutionContext(cfg, withChild, rows);
  assert.equal(nestedContext.mappings.length, 2);
  assert.equal(pathWritableInContext(path.join(a, 'child', 'file.txt'), nestedContext), false, 'selected nested source is reference-only');
  assert.equal((await cleanupTaskWorktrees(ctx, withChild, 'archive')).ok, true);
  // The actual prepared members can include a Git ancestor between two selected repositories.
  const deepOwner = await create({ cwd: root });
  const { beginWorktreeRepositoryOperation } = load('main/git/worktreeTaskOperation.ts');
  const { sourcePathKey } = load('main/workspacePaths.ts');
  const releaseMiddle = beginWorktreeRepositoryOperation(sourcePathKey(path.join(a, 'child', '.git')));
  const deepSelection = [{ rootId: 'all', relativePath: 'a' }, { rootId: 'all', relativePath: 'a/child/grandchild' }];
  try {
    const blocked = await attachTaskWorktrees(ctx, deepOwner.id, deepSelection, true);
    assert.equal(blocked.ok, false); assert.match(blocked.message, /repository operation already running/);
    assert.equal(deepOwner.worktreeGroups, undefined, 'inferred middle repository is locked before any resource is published');
  } finally { releaseMiddle(); }
  assert.equal((await attachTaskWorktrees(ctx, deepOwner.id, deepSelection, true)).ok, true);
  assert.deepEqual(deepOwner.worktreeRepoSet.map(repo => repo.path), ['child', 'child/grandchild']);
  assert.equal((await cleanupTaskWorktrees(ctx, deepOwner, 'archive')).ok, true);
  // Mapped single-group loss fails closed and retains the original cwd and provenance.
  const lost = await create({ cwd: root, isolate: true, isolationGroups: [{ rootId: 'all', relativePath: 'c' }] });
  assert.equal((await gitService.worktreeRemove(lost.worktreePath)).ok, true);
  assert.throws(() => healMissingSessionWorktree(ctx, lost), /不完整/);
  assert.equal(lost.cwd, root); assert.ok(lost.worktreeGroups);
  console.log('ok mapped-worktree-lifecycle: dirty defaults, aggregate cwd, mixed writes, aliases, append/rollback, delayed borrower release, single-group loss');
} finally {
  Module._load = originalLoad;
  assert.ok(path.resolve(fixture).startsWith(path.join(project, '.tmp') + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
}
