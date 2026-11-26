/** Real Git across three groups: global preflight, durable partial success, restart/retry. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(project, '.tmp'); fs.mkdirSync(tempRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(tempRoot, 'task-worktree-integrate-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const load = rel => import(pathToFileURL(compile(rel)).href);
const { integrateSessionWorktree } = await load('main/git/worktreeIntegrate.ts');
const { integrateTaskWorktrees } = await load('main/git/worktreeTaskIntegrate.ts');
const { mergeIsolateBranch } = await load('main/git/mergeIsolate.ts');
const { normalizeSessionWorktrees } = await load('shared/sessionWorktrees.ts');
const { sourcePathKey } = await load('main/workspacePaths.ts');
const { workspaceRootUsesFor } = await load('main/workspaceRootUses.ts');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const emptyConfig = path.join(fixture, 'gitconfig'); fs.writeFileSync(emptyConfig, '');
Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (folder, text) => { fs.writeFileSync(path.join(folder, 'same.txt'), text); git(folder, 'add', '.'); git(folder, 'commit', '-qm', text); };
function init(folder, tree) {
  fs.mkdirSync(folder, { recursive: true });
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'user.name', 'Fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
  git(folder, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(folder, '.gitignore'), 'Plugins/\n'); commit(folder, 'base');
  const base = git(folder, 'rev-parse', 'HEAD');
  git(folder, 'worktree', 'add', '-q', '-b', 'ao/task', tree, 'main');
  return base;
}
const source = (rootId, folder) => ({ rootId, path: folder, cwd: folder, physicalPath: sourcePathKey(folder) });
function setup(name, withNested = false) {
  const directory = path.join(fixture, name); fs.mkdirSync(directory);
  const groups = ['a', 'b', 'c'].map(id => {
    const main = path.join(directory, id), tree = path.join(directory, `tree-${id}`);
    const baseCommit = init(main, tree);
    const repos = [];
    if (withNested && id !== 'c') {
      const rel = 'Plugins/A'; const nestedMain = path.join(main, rel), nestedTree = path.join(tree, rel);
      const base = init(nestedMain, nestedTree); commit(nestedTree, `nested-${id}`);
      repos.push({ path: rel, branch: 'ao/task', baseBranch: 'main', baseCommit: base, kind: 'independent' });
    }
    commit(tree, `task-${id}`);
    return { id, path: tree, sourceRoot: source(id, main), source: { mainRepo: main, commonDir: path.join(main, '.git') }, branch: 'ao/task', baseBranch: 'main', baseCommit, repos };
  });
  const ws = { id: name, name, path: groups[2].source.mainRepo, controlRoot: groups[0].source.mainRepo,
    defaultRootId: 'c', rootsRevision: 1, roots: groups.map(group => ({ id: group.id, path: group.source.mainRepo })) };
  const cfg = { workspaces: [ws], activeWorkspaceId: ws.id };
  let owner = { id: name, name, type: 'terminal', workspaceId: ws.id, cwd: groups[0].path, sourceRoot: groups[0].sourceRoot,
    worktreeGroups: { version: 1, primaryGroupId: 'a', groups } };
  normalizeSessionWorktrees(owner);
  const saved = [], notices = [], phases = [], acceptances = [], archived = [], invalidations = [];
  const config = { get: () => cfg };
  const ctx = { config, git: { invalidateRepoCaches: paths => invalidations.push(paths) }, notify: { push: notice => notices.push(notice) },
    workspaceIdFor: () => ws.id, resolveWorkspaceId: () => ws.id, findSession: () => owner,
    persist: () => saved.push(JSON.parse(JSON.stringify(owner))), broadcast() {}, awareness: null, emitRuntimeFacts() {},
    setPhase: (_id, phase) => phases.push(phase), setLiveStatus() {}, recordAcceptance: (_id, acceptance) => acceptances.push(acceptance),
    setArchived: () => archived.push(true), archiveReleaseThenCleanup: () => { throw new Error('cleanup is not scheduled in this slice'); } };
  return { groups, ws, cfg, ctx, config, saved, notices, phases, acceptances, archived, invalidations,
    get owner() { return owner; }, restart() { owner = structuredClone(saved.at(-1)); normalizeSessionWorktrees(owner); } };
}
const mergeOpts = { noFf: true, skipNpmInstall: true, skipTypecheck: true, notifyUserOnFail: true };
const started = Date.now();
const heads = task => task.groups.flatMap(group => [git(group.source.mainRepo, 'rev-parse', 'main'),
  ...group.repos.map(repo => git(path.join(group.source.mainRepo, repo.path), 'rev-parse', 'main'))]);
const statuses = task => task.owner.worktreeGroups.groups.map(group => group.integration?.map(entry => entry.status));
try {
  const dirty = setup('dirty'); const original = heads(dirty);
  fs.writeFileSync(path.join(dirty.groups[1].path, 'untracked.txt'), 'user work');
  const pending = integrateSessionWorktree(dirty.ctx, dirty.owner.id, mergeOpts);
  assert.deepEqual(workspaceRootUsesFor(dirty.config).list(dirty.ws.id).map(use => use.rootId).sort(), ['a', 'b', 'c'], 'all roots are held before the first Git await');
  await assert.rejects(pending, /未提交改动/);
  assert.deepEqual(heads(dirty), original, 'a dirty second group prevents ALL merges');
  assert.deepEqual(statuses(dirty), [['not-started'], ['failed'], ['not-started']]);
  assert.equal(dirty.phases.length, 0); assert.equal(dirty.acceptances.length, 0); assert.equal(dirty.archived.length, 0);
  assert.ok(dirty.notices.length); assert.equal(workspaceRootUsesFor(dirty.config).list(dirty.ws.id).length, 0);

  const conflict = setup('conflict'); commit(conflict.groups[1].source.mainRepo, 'main-conflict');
  const conflictHeads = heads(conflict);
  await assert.rejects(integrateSessionWorktree(conflict.ctx, conflict.owner.id, mergeOpts), /冲突/);
  assert.deepEqual(heads(conflict), conflictHeads, 'a second-group merge-tree conflict is task-wide');
  assert.equal(git(conflict.groups[0].source.mainRepo, 'status', '--porcelain'), '');

  const target = setup('target'); git(target.groups[0].source.mainRepo, 'branch', 'release');
  const targetHeads = heads(target);
  await assert.rejects(integrateSessionWorktree(target.ctx, target.owner.id, { ...mergeOpts, targetBranch: 'release' }), /跨组任务合入停止/);
  assert.deepEqual(heads(target), targetHeads, 'a missing target in any group precedes the first merge');

  const busy = setup('busy'); const busyHeads = heads(busy);
  fs.writeFileSync(path.join(busy.groups[1].source.mainRepo, '.git', 'index.lock'), 'external operation');
  const busyResult = await integrateTaskWorktrees(busy.ctx, busy.owner, mergeOpts);
  assert.equal(busyResult.ok, false); assert.match(busyResult.message, /index.lock/);
  assert.deepEqual(heads(busy), busyHeads, 'a later locked index stops every group before any merge');

  const occupied = setup('occupied'); const occupiedHeads = heads(occupied);
  git(occupied.groups[1].source.mainRepo, 'branch', 'release');
  git(occupied.groups[1].source.mainRepo, 'worktree', 'add', '-q', path.join(fixture, 'occupied-release'), 'release');
  occupied.owner.worktreeGroups.groups[1].baseBranch = 'release';
  const occupiedResult = await integrateTaskWorktrees(occupied.ctx, occupied.owner, mergeOpts);
  assert.equal(occupiedResult.ok, false); assert.match(occupiedResult.message, /another worktree/);
  assert.deepEqual(heads(occupied), occupiedHeads);

  const partial = setup('partial', true); const before = heads(partial);
  const hook = path.join(partial.groups[1].source.mainRepo, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho fixture-second-group-hook >&2\nexit 1\n'); fs.chmodSync(hook, 0o755);
  await assert.rejects(integrateSessionWorktree(partial.ctx, partial.owner.id, mergeOpts), /fixture-second-group-hook/);
  assert.deepEqual(statuses(partial), [['merged', 'merged'], ['merged', 'failed'], ['not-started']]);
  const after = heads(partial);
  assert.notEqual(after[0], before[0]); assert.notEqual(after[1], before[1]); assert.notEqual(after[3], before[3]);
  assert.equal(after[2], before[2]); assert.equal(after[4], before[4]);
  assert.equal(partial.phases.length, 0); assert.equal(partial.acceptances.length, 0); assert.equal(partial.archived.length, 0);
  assert.equal(partial.owner.worktreeGroups.groups[1].integration.at(-1).gates.mergeHook, 'failed');
  assert.ok(partial.saved.some(row => row.worktreeGroups.groups[0].integration.every(entry => entry.status === 'merged') &&
    row.worktreeGroups.groups[1].integration.at(-1).status === 'not-started'), 'completed groups are saved before a later failure');
  // Reload exactly the persisted record, then retry without remerging successful repositories.
  partial.restart(); fs.unlinkSync(hook);
  const integrated = await integrateSessionWorktree(partial.ctx, partial.owner.id, mergeOpts);
  assert.equal(integrated.merged, true); assert.equal(integrated.cleanup, 'scheduled');
  assert.deepEqual(integrated.groups.map(group => [group.groupId, group.rootId, group.repos.map(repo => repo.repo)]),
    [['a', 'a', ['Plugins/A', '']], ['b', 'b', ['Plugins/A', '']], ['c', 'c', ['']]], 'duplicate nested labels remain grouped by stable identities');
  assert.deepEqual(statuses(partial), [['already-merged', 'already-merged'], ['already-merged', 'merged'], ['merged']]);
  const final = heads(partial); assert.equal(final[0], after[0]); assert.equal(final[1], after[1]); assert.equal(final[3], after[3]);
  assert.equal(partial.phases.length, 1); assert.equal(partial.acceptances.length, 1);
  assert.ok(partial.groups.every(group => fs.existsSync(group.path)), 'cleanup is delayed until the result is delivered');
  await new Promise(resolve => setTimeout(resolve, 2800));
  assert.equal(partial.archived.length, 1, 'successful multi-group integration schedules archive');
  const single = setup('source-single');
  single.owner.worktreeGroups.groups = [single.owner.worktreeGroups.groups[0]];
  single.owner.worktreeGroups.cwdPolicy = 'source';
  single.owner.cwd = single.groups[0].sourceRoot.cwd;
  const singleResult = await integrateSessionWorktree(single.ctx, single.owner.id, mergeOpts);
  assert.equal(singleResult.cleanup, 'scheduled', 'source-cwd single group also schedules cleanup');
  await new Promise(resolve => setTimeout(resolve, 2800));
  assert.equal(single.archived.length, 1);
  assert.equal(workspaceRootUsesFor(partial.config).list(partial.ws.id).length, 0);

  // Saved success alone is not proof: rewinding a target requires a fresh real merge.
  const rewound = setup('rewound');
  await integrateTaskWorktrees(rewound.ctx, rewound.owner, mergeOpts);
  git(rewound.groups[0].source.mainRepo, 'reset', '--hard', rewound.groups[0].baseCommit);
  const replay = await integrateTaskWorktrees(rewound.ctx, rewound.owner, mergeOpts);
  assert.equal(replay.ok, true); assert.equal(replay.groups[0].repos[0].status, 'merged');
  assert.equal(replay.groups[1].repos[0].status, 'already-merged');

  const locked = setup('locked');
  const first = integrateTaskWorktrees(locked.ctx, locked.owner, mergeOpts);
  await assert.rejects(integrateTaskWorktrees(locked.ctx, locked.owner, mergeOpts), /already running/);
  assert.equal((await first).ok, true);

  const changed = setup('changed'); const unchangedHeads = heads(changed); let broadcasts = 0;
  changed.ctx.broadcast = () => {
    if (++broadcasts === 2) commit(changed.groups[1].path, 'late-task-commit');
  };
  const changedResult = await integrateTaskWorktrees(changed.ctx, changed.owner, mergeOpts);
  assert.equal(changedResult.ok, false); assert.match(changedResult.message, /source commit changed/);
  assert.deepEqual(heads(changed), unchangedHeads, 'a later source commit after global preflight blocks the first write');
  assert.equal(statuses(changed)[1][0], 'failed');

  const replaced = setup('replaced'); const replacedHeads = heads(replaced);
  const replacement = path.join(fixture, 'same-common-other-worktree');
  git(replaced.groups[1].source.mainRepo, 'worktree', 'add', '-q', '--force', replacement, 'ao/task');
  let replacements = 0;
  replaced.ctx.broadcast = () => {
    if (++replacements !== 2) return;
    const dotGit = path.join(replaced.groups[1].path, '.git');
    fs.unlinkSync(dotGit); fs.copyFileSync(path.join(replacement, '.git'), dotGit);
  };
  const replacedResult = await integrateTaskWorktrees(replaced.ctx, replaced.owner, mergeOpts);
  assert.equal(replacedResult.ok, false); assert.match(replacedResult.message, /repository identity changed/);
  assert.deepEqual(heads(replaced), replacedHeads, 'same-common-dir private gitfile replacement cannot pass a write guard');
  assert.equal(workspaceRootUsesFor(replaced.config).list(replaced.ws.id).length, 0);

  const removed = setup('removed'); const removedHeads = heads(removed); let saves = 0;
  removed.ctx.broadcast = () => { if (++saves === 2) removed.ws.roots.pop(); };
  const removedResult = await integrateTaskWorktrees(removed.ctx, removed.owner, mergeOpts);
  assert.equal(removedResult.ok, false); assert.match(removedResult.message, /source folder not found/);
  assert.deepEqual(heads(removed), removedHeads); assert.equal(workspaceRootUsesFor(removed.config).list(removed.ws.id).length, 0);

  const stashGuard = setup('stash-guard'); const stashMain = stashGuard.groups[0].source.mainRepo;
  const stashHead = git(stashMain, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(stashMain, 'same.txt'), 'user-wip');
  const refused = await mergeIsolateBranch({ mainRepo: stashMain, worktreePath: stashGuard.groups[0].path,
    branch: 'ao/task', stashMain: true, skipNpmInstall: true, skipTypecheck: true,
    beforeWrite: async stage => { if (stage === 'merge') throw new Error('fixture-write-guard'); } });
  assert.equal(refused.ok, false); assert.match(refused.message, /改动保留在私有快照/);
  assert.equal(git(stashMain, 'rev-parse', 'HEAD'), stashHead, 'guard rejection cannot merge after stashing');
  const recoveryRef = git(stashMain, 'for-each-ref', '--format=%(refname)', 'refs/muster/integrate');
  assert.match(git(stashMain, 'show', recoveryRef + ':same.txt'), /user-wip/, 'the user work is retained and explicitly reported');
  assert.equal(partial.archived.length, 1, 'successful merge schedules archive exactly once');

  // A registered linked child cannot authorize merging a Junction to an unregistered source.
  const outside = setup('outside', true); const outsideHeads = heads(outside);
  const escaped = path.join(fixture, 'escaped-nested-source');
  const oldSource = path.join(outside.groups[0].source.mainRepo, 'Plugins/A');
  const childTree = path.join(outside.groups[0].path, 'Plugins/A');
  const oldGitDir = fs.readFileSync(path.join(childTree, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
  const gitDirRelative = path.relative(path.join(oldSource, '.git'), oldGitDir);
  for (const target of [oldSource, escaped]) assert.ok(path.resolve(target).startsWith(path.resolve(fixture) + path.sep));
  fs.renameSync(oldSource, escaped);
  fs.symlinkSync(escaped, oldSource, process.platform === 'win32' ? 'junction' : 'dir');
  fs.unlinkSync(path.join(childTree, '.git'));
  fs.writeFileSync(path.join(childTree, '.git'), `gitdir: ${path.join(escaped, '.git', gitDirRelative)}\n`);
  const outsideResult = await integrateTaskWorktrees(outside.ctx, outside.owner, mergeOpts);
  // 归因 2026-10-26（HEAD 即红）：该逃逸场景此前由容器范围守卫（worktreeTaskIntegrate.ts
  // 'outside its task/source container'）首拦，现由更早的嵌套身份校验
  // （workspaceExecutionContext.ts 'nested worktree repository identity changed'）先拒；
  // 合入仍被确定性阻止（下方 heads 断言），仅首拦守卫换人，断言对齐现行文案。
  assert.equal(outsideResult.ok, false);
  assert.match(outsideResult.message, /跨组任务合入停止：nested worktree repository identity changed/);
  assert.deepEqual(heads(outside), outsideHeads, 'no group merges an unregistered physical nested source');

  console.log(`ok task-worktree-integrate: real global preflight, hook/partial persistence, restart/retry, nested labels, target rewind, pre-write commit/gitfile/root races, leases and concurrency (${Date.now() - started}ms)`);
} finally {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(tempRoot) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
}
