// @test-shards 3
/** Real Git task cleanup: reverse dependencies, partial ownership, missing trees and ref races. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { inShard } from './helpers/shard.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join(project, '.tmp'); fs.mkdirSync(temp, { recursive: true });
const fixture = fs.mkdtempSync(path.join(temp, 'task-worktree-cleanup-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const load = rel => {
  const file = compile(rel);
  if (rel === 'main/git/worktreeTaskCleanup.ts' && process.env.TEST_RESTORE_CLEANUP_CAS === '1') {
    const original = fs.readFileSync(file, 'utf8');
    const changed = original.replace('delete refs/heads/${item.branch} ${item.head}', 'delete refs/heads/${item.branch}');
    assert.notEqual(changed, original, 'red proof must actually restore unconditional branch deletion');
    fs.writeFileSync(file, changed);
  }
  return import(pathToFileURL(file).href);
};
const { cleanupTaskWorktrees } = await load('main/git/worktreeTaskCleanup.ts');
const { integrateTaskWorktrees } = await load('main/git/worktreeTaskIntegrate.ts');
const { cleanupNestedWorktree } = await load('main/git/nestedRepos.ts');
const { healMissingSessionWorktree, discardSessionWorktree, cleanupSessionWorktreeOnArchive } = await load('main/git/worktreeSessionOps.ts');
const { normalizeSessionWorktrees } = await load('shared/sessionWorktrees.ts');
const { workspaceRootUsesFor } = await load('main/workspaceRootUses.ts');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, value) => { fs.writeFileSync(path.join(cwd, 'same.txt'), value); git(cwd, 'add', '.'); git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-qm', value); };
function init(main, tree) {
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main'); git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
  git(main, 'config', 'core.hooksPath', path.join(fixture, 'no-hooks'));
  fs.writeFileSync(path.join(main, '.gitignore'), 'children/\n'); commit(main, 'baseline');
  const baseCommit = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', '-q', '-b', 'ao/task', tree, 'main'); commit(tree, 'task');
  git(main, 'merge', '--ff-only', 'ao/task');
  return baseCommit;
}
function setup(name, depth = 0) {
  const directory = path.join(fixture, name); fs.mkdirSync(directory);
  const groups = ['a', 'b', 'c'].map(id => {
    const main = path.join(directory, `源 ${id}`), tree = path.join(directory, `tree-${id}`);
    const baseCommit = init(main, tree), repos = [];
    if (id === 'b') for (let level = 1; level <= depth; level++) {
      const rel = Array(level).fill('children/plugin').join('/');
      repos.push({ path: rel, branch: 'ao/task', baseBranch: 'main', baseCommit: init(path.join(main, rel), path.join(tree, rel)), kind: 'independent' });
    }
    return { id, path: tree, sourceRoot: { rootId: id, path: main, cwd: main }, source: { mainRepo: main, commonDir: path.join(main, '.git') },
      branch: 'ao/task', baseBranch: 'main', baseCommit, repos };
  });
  const ws = { id: name, path: groups[2].source.mainRepo, controlRoot: groups[0].source.mainRepo, defaultRootId: 'c', rootsRevision: 1,
    roots: groups.map(group => ({ id: group.id, path: group.source.mainRepo })) };
  let owner = { id: name, name, type: 'terminal', workspaceId: name, cwd: groups[0].path, sourceRoot: groups[0].sourceRoot,
    worktreeGroups: { version: 1, primaryGroupId: 'a', groups } };
  normalizeSessionWorktrees(owner);
  const cfg = { workspaces: [ws], activeWorkspaceId: name }, config = { get: () => cfg };
  const saved = [], flushed = [], notices = [], others = [];
  const ctx = { config, git: { invalidateRepoCaches() {}, deleteBranchForce: async (repo, branch) => {
      try { git(repo, 'branch', '-D', branch); return { ok: true }; }
      catch (error) { return { ok: false, message: String(error) }; }
    } }, notify: { push: entry => notices.push(entry) },
    workspaceIdFor: () => name, resolveWorkspaceId: () => name, findSession: () => owner, sessions: () => [owner, ...others],
    persist: () => saved.push(structuredClone(owner)), flushPersist: () => flushed.push(structuredClone(owner)), broadcast() {} };
  return { groups, ws, cfg, config, ctx, notices, saved, flushed, others,
    get owner() { return owner; }, restart() { owner = structuredClone(flushed.at(-1)); normalizeSessionWorktrees(owner); } };
}
function removeOwned(folder) {
  const target = path.resolve(folder), root = path.resolve(fixture);
  assert.ok(target.startsWith(`${root}${path.sep}`), 'recursive deletion must stay inside the owned fixture');
  fs.rmSync(target, { recursive: true, force: true });
}
const main = group => group.source.mainRepo;
const allEntries = task => task.owner.worktreeGroups.groups.flatMap(group => group.cleanup);
const started = Date.now();
try {
  if (inShard(0)) {
    const complete = setup('complete', 3);
    const result = await cleanupTaskWorktrees(complete.ctx, complete.owner, 'archive');
    assert.equal(result.ok, true, result.message); assert.equal(complete.owner.worktreeGroups, undefined);
    assert.equal(complete.owner.cwd, main(complete.groups[0]), 'default and collection order cannot redirect the fallback');
    for (const group of complete.groups) {
      assert.equal(fs.existsSync(group.path), false); assert.equal(git(main(group), 'worktree', 'list', '--porcelain').includes(group.path.replaceAll('\\', '/')), false);
      assert.throws(() => git(main(group), 'rev-parse', '--verify', 'ao/task'));
    }
    assert.ok(complete.flushed.some(s => s.worktreeGroups?.groups[1].cleanup.some(e => e.treeRemoved && !e.branchRemoved)), 'tree removal is on disk before the ref operation');

    const submodule = setup('submodule', 2), moduleGroup = submodule.groups[1];
    const parentRel = moduleGroup.repos.at(-1).path, parentMain = path.join(main(moduleGroup), parentRel), parentTree = path.join(moduleGroup.path, parentRel);
    const origin = path.join(fixture, 'module-origin'); init(origin, path.join(fixture, 'module-origin-tree'));
    const rel = 'children/子模块 space';
    git(parentMain, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '-f', origin, rel); commit(parentMain, 'add real submodule');
    git(parentTree, '-c', 'submodule.recurse=false', 'merge', '--ff-only', 'main');
    assert.ok(git(parentTree, 'ls-tree', 'HEAD', '--', rel).startsWith('160000 commit '), 'cleanup fixture must contain a real gitlink');
    const moduleMain = path.join(parentMain, rel), moduleTree = path.join(parentTree, rel);
    const moduleBase = git(moduleMain, 'rev-parse', 'HEAD');
    git(moduleMain, 'worktree', 'add', '-q', '-b', 'ao/task', moduleTree, 'main'); commit(moduleTree, 'module task');
    git(parentTree, 'add', '-f', '--', rel); git(parentTree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'task gitlink');
    git(parentMain, '-c', 'submodule.recurse=false', 'merge', '--ff-only', 'ao/task'); git(moduleMain, 'merge', '--ff-only', 'ao/task');
    submodule.owner.worktreeGroups.groups[1].repos.push({ path: `${parentRel}/${rel}`, branch: 'ao/task', baseBranch: 'main', baseCommit: moduleBase, kind: 'submodule' });
    fs.writeFileSync(path.join(moduleTree, 'user.txt'), 'submodule user work');
    assert.equal((await cleanupTaskWorktrees(submodule.ctx, submodule.owner, 'archive')).ok, false);
    assert.ok(submodule.owner.worktreeGroups.groups[1].cleanup.every(e => !e.treeRemoved), 'dirty depth-three submodule retains every ancestor');
    fs.unlinkSync(path.join(moduleTree, 'user.txt')); submodule.restart();
    const moduleResult = await cleanupTaskWorktrees(submodule.ctx, submodule.owner, 'archive');
    assert.equal(moduleResult.ok, true, moduleResult.message);
    assert.equal(fs.existsSync(moduleGroup.path), false, 'empty gitlink restoration allows removal of containing linked trees');
    assert.equal(fs.readFileSync(path.join(moduleMain, 'same.txt'), 'utf8'), 'module task', 'the source submodule checkout is preserved');

    const dirty = setup('dirty', 3), b = dirty.groups[1], leaf = b.repos.at(-1).path;
    fs.writeFileSync(path.join(b.path, leaf, 'user.txt'), 'keep user files');
    await cleanupSessionWorktreeOnArchive(dirty.ctx, dirty.owner);
    assert.equal(fs.existsSync(dirty.groups[0].path), false); assert.equal(fs.existsSync(dirty.groups[2].path), false);
    assert.equal(fs.readFileSync(path.join(b.path, leaf, 'user.txt'), 'utf8'), 'keep user files');
    assert.ok(dirty.owner.worktreeGroups.groups[1].cleanup.every(e => e.status === 'retained' && !e.treeRemoved));
    dirty.restart(); assert.throws(() => healMissingSessionWorktree(dirty.ctx, dirty.owner), /不完整/);
    fs.unlinkSync(path.join(b.path, leaf, 'user.txt'));
    assert.equal((await cleanupTaskWorktrees(dirty.ctx, dirty.owner, 'archive')).ok, true, 'restart retries actual remaining registrations');

    const missing = setup('missing', 1), missingGroup = missing.groups[1];
    const otherTree = path.join(fixture, 'unrelated-missing');
    git(main(missingGroup), 'worktree', 'add', '-q', '-b', 'ao/other', otherTree, 'main'); removeOwned(otherTree);
    removeOwned(missingGroup.path);
    assert.equal((await cleanupTaskWorktrees(missing.ctx, missing.owner, 'archive')).ok, true, 'targeted remove supports missing registered trees');
    assert.ok(git(main(missingGroup), 'worktree', 'list', '--porcelain').includes('refs/heads/ao/other'), 'unrelated dangling registration was not globally pruned');

    const lock = setup('locked', 2), locked = path.join(lock.groups[1].path, lock.groups[1].repos.at(-1).path);
    git(locked, 'worktree', 'lock', '--reason', 'external user', locked);
    assert.equal((await cleanupTaskWorktrees(lock.ctx, lock.owner, 'discard')).ok, false);
    assert.equal(fs.existsSync(locked), true, 'explicit discard does not override an external worktree lock');
    assert.ok(lock.owner.worktreeGroups.groups[1].cleanup.every(e => !e.treeRemoved));
    git(locked, 'worktree', 'unlock', locked);
  }
  if (inShard(1)) {
    const legacyIgnored = setup('legacy-ignored', 1), legacyGroup = legacyIgnored.groups[1], legacyRepo = legacyGroup.repos[0].path;
    const legacyMain = path.join(main(legacyGroup), legacyRepo), legacyTree = path.join(legacyGroup.path, legacyRepo);
    fs.appendFileSync(path.join(legacyMain, '.git', 'info', 'exclude'), '\nprivate-cache/\n');
    fs.mkdirSync(path.join(legacyTree, 'private-cache'));
    fs.writeFileSync(path.join(legacyTree, 'private-cache', 'user.txt'), 'ignored user work');
    const legacyResult = await cleanupNestedWorktree({ mainRepo: main(legacyGroup), repo: legacyRepo, containerRoot: legacyGroup.path, branch: 'ao/task', baseBranch: 'main' });
    assert.equal(legacyResult.removed, false); assert.match(legacyResult.message, /忽略的文件/);
    assert.equal(fs.readFileSync(path.join(legacyTree, 'private-cache', 'user.txt'), 'utf8'), 'ignored user work');

    const unmerged = setup('unmerged', 2), b = unmerged.groups[1], leaf = path.join(b.path, b.repos.at(-1).path);
    commit(leaf, 'new unmerged work'); const head = git(leaf, 'rev-parse', 'HEAD');
    assert.equal((await cleanupTaskWorktrees(unmerged.ctx, unmerged.owner, 'archive')).ok, false);
    assert.equal(git(leaf, 'rev-parse', 'HEAD'), head); assert.ok(unmerged.owner.worktreeGroups.groups[1].cleanup.every(e => !e.treeRemoved));
    const closed = await cleanupTaskWorktrees(unmerged.ctx, unmerged.owner, 'close');
    assert.equal(closed.ok, true, 'closing detaches a clean tree while retaining its unmerged branch');
    assert.match(closed.message, /分支已保留/);
    const nestedMain = path.join(main(b), b.repos.at(-1).path);
    assert.equal(git(nestedMain, 'rev-parse', 'ao/task'), head, 'close preserves unmerged commits');
    assert.equal(unmerged.owner.worktreeGroups, undefined);

    const broken = setup('broken', 1), brokenTree = path.join(broken.groups[1].path, broken.groups[1].repos[0].path);
    const gitfile = path.join(brokenTree, '.git'); fs.unlinkSync(gitfile); fs.writeFileSync(gitfile, 'gitdir: nowhere\n');
    assert.equal((await discardSessionWorktree(broken.ctx, broken.owner.id)).ok, false);
    assert.equal(fs.existsSync(path.join(brokenTree, 'same.txt')), true); assert.equal(fs.existsSync(broken.groups[1].path), true);
    assert.ok(broken.owner.worktreeGroups.groups[1].cleanup.every(e => !e.treeRemoved), 'unknown nested identity retains its containing tree even for discard');

    const reused = setup('reused'); const reusedGroup = reused.groups[1];
    git(main(reusedGroup), 'worktree', 'remove', reusedGroup.path);
    const second = path.join(fixture, 'branch-reused'); git(main(reusedGroup), 'worktree', 'add', '-q', second, 'ao/task');
    assert.equal((await cleanupTaskWorktrees(reused.ctx, reused.owner, 'archive')).ok, false);
    assert.equal(fs.existsSync(second), true); assert.equal(git(second, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ao/task');
    assert.equal(reused.owner.worktreeGroups.groups[1].cleanup[0].branchRemoved, false, 'absence is not proof of ref ownership');

    const forced = setup('forced'); fs.writeFileSync(path.join(forced.groups[1].path, 'dirty.txt'), 'explicitly discarded');
    assert.equal((await discardSessionWorktree(forced.ctx, forced.owner.id)).ok, true, 'approved discard can remove dirty but verified trees');

    const forceBranch = setup('force-branch'); commit(forceBranch.groups[1].path, 'unmerged force delete');
    const forceResult = await cleanupTaskWorktrees(forceBranch.ctx, forceBranch.owner, 'discard', { forceBranches: true });
    assert.equal(forceResult.ok, true, forceResult.message);
    let forceBranchExists = true;
    try { git(main(forceBranch.groups[1]), 'show-ref', '--verify', '--quiet', 'refs/heads/ao/task'); }
    catch { forceBranchExists = false; }
    assert.equal(forceBranchExists, false, 'explicit force cleanup removes an unmerged branch');
  }
  if (inShard(2)) {
    const concurrent = setup('concurrent'); let resolveRelease;
    const releasing = new Promise(resolve => { resolveRelease = resolve; });
    const cleanup = cleanupTaskWorktrees(concurrent.ctx, concurrent.owner, 'archive', { release: () => releasing });
    assert.deepEqual(workspaceRootUsesFor(concurrent.config).list(concurrent.ws.id).map(use => use.rootId).sort(), ['a', 'b', 'c']);
    await assert.rejects(integrateTaskWorktrees(concurrent.ctx, concurrent.owner), /cleanup already running/);
    await assert.rejects(cleanupTaskWorktrees(concurrent.ctx, concurrent.owner, 'discard'), /cleanup already running/);
    assert.ok(concurrent.groups.every(group => fs.existsSync(group.path)), 'no deletion before the engine releases');
    resolveRelease(); assert.equal((await cleanup).ok, true);
    assert.equal(workspaceRootUsesFor(concurrent.config).list(concurrent.ws.id).length, 0);

    const late = setup('late-ref'), lateGroup = late.groups[1]; let changed = false;
    late.ctx.broadcast = () => {
      const entry = late.owner.worktreeGroups?.groups[1].cleanup?.[0];
      if (!changed && entry?.treeRemoved && !entry.branchRemoved) {
        changed = true;
        const parent = git(main(lateGroup), 'rev-parse', 'ao/task'), tree = git(main(lateGroup), 'rev-parse', 'ao/task^{tree}');
        const newer = git(main(lateGroup), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', parent, '-m', 'late user commit');
        git(main(lateGroup), 'update-ref', 'refs/heads/ao/task', newer);
      }
    };
    assert.equal((await cleanupTaskWorktrees(late.ctx, late.owner, 'archive')).ok, false);
    assert.equal(changed, true); assert.ok(git(main(lateGroup), 'log', '-1', '--format=%s', 'ao/task').includes('late user commit'));
    assert.equal(late.owner.worktreeGroups.groups[1].cleanup[0].treeRemoved, true);

    const reappeared = setup('reappeared', 1), parent = reappeared.groups[1], childPath = path.join(parent.path, parent.repos[0].path); let wrote = false;
    reappeared.ctx.broadcast = () => {
      const entry = reappeared.owner.worktreeGroups?.groups[1].cleanup?.find(e => e.repo);
      if (!wrote && entry?.status === 'removed') { wrote = true; fs.mkdirSync(childPath, { recursive: true }); fs.writeFileSync(path.join(childPath, 'replacement.txt'), 'new user directory'); }
    };
    assert.equal((await cleanupTaskWorktrees(reappeared.ctx, reappeared.owner, 'archive')).ok, false);
    assert.equal(fs.readFileSync(path.join(childPath, 'replacement.txt'), 'utf8'), 'new user directory');
    assert.equal(reappeared.owner.worktreeGroups.groups[1].cleanup.find(e => !e.repo).treeRemoved, false, 'parent cannot erase a directory that appeared after child removal');

    const borrowed = setup('borrowed'); borrowed.others.push({ id: 'other', cwd: borrowed.groups[1].path });
    assert.equal((await cleanupTaskWorktrees(borrowed.ctx, borrowed.owner, 'discard')).ok, false);
    assert.ok(borrowed.groups.every(group => fs.existsSync(group.path)), 'an active borrowing session prevents cleanup before any deletion');
    borrowed.others[0].archived = true;
    assert.equal((await cleanupTaskWorktrees(borrowed.ctx, borrowed.owner, 'archive')).ok, true);
  }
  console.log(`task-worktree-cleanup: passed (${Date.now() - started}ms)`);
} finally {
  const target = path.resolve(fixture);
  assert.ok(target.startsWith(`${path.resolve(temp)}${path.sep}task-worktree-cleanup-`));
  fs.rmSync(target, { recursive: true, force: true });
}
