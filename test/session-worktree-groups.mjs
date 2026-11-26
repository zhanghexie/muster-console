/** Persisted task topology, primary projection, transfer and fail-closed legacy writers. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'session-worktree-groups-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { sessionWorktreeGroups, normalizeSessionWorktrees, projectPrimaryWorktree, syncSingleWorktreeGroup,
  clearSessionWorktreeMetadata, transferSessionWorktrees, assertSingleWorktreeGroup } = await import(pathToFileURL(compile('shared/sessionWorktrees.ts')));
try {
  const main = path.join(fixture, 'source-a');
  const tree = path.join(fixture, 'tree-a');
  const nested = [{ path: 'Plugins/A/vendor/B', branch: 'ao/task', baseBranch: 'dev', kind: 'submodule', baseCommit: 'abcdef' }];
  const legacy = { id: 'task', sourceRoot: { rootId: 'a', path: main, cwd: main }, worktreePath: tree,
    worktreeSource: { mainRepo: main, commonDir: path.join(main, '.git') }, worktreeBranch: 'ao/task', worktreeBaseBranch: 'feature', worktreeRepoSet: nested };
  assert.equal(legacy.worktreeGroups, undefined);
  normalizeSessionWorktrees(legacy);
  const single = structuredClone(legacy.worktreeGroups);
  assert.equal(single.version, 1);
  assert.equal(single.primaryGroupId, 'task:legacy');
  assert.equal(single.groups[0].sourceRoot.rootId, 'a');
  assert.deepEqual(single.groups[0].repos, nested);
  legacy.worktreeRepoSet[0].baseBranch = 'release';
  legacy.worktreeBaseBranch = 'release';
  syncSingleWorktreeGroup(legacy);
  assert.equal(legacy.worktreeGroups.groups[0].baseBranch, 'release');
  assert.equal(legacy.worktreeGroups.groups[0].repos[0].baseBranch, 'release');
  assert.equal(single.groups[0].repos[0].baseBranch, 'dev', 'the saved snapshot is independent');
  const loaded = JSON.parse(JSON.stringify(legacy)); normalizeSessionWorktrees(loaded);
  assert.deepEqual(loaded, legacy, 'migration is idempotent through disk round-trip');
  normalizeSessionWorktrees({ id: 'old', worktreePath: tree }); // Unresolved old identity is retained, not invented.
  assert.equal(sessionWorktreeGroups({ id: 'shared' }), undefined);

  const secondMain = path.join(fixture, 'source-b'); const secondTree = path.join(fixture, 'tree-b');
  const state = { version: 1, primaryGroupId: single.primaryGroupId, groups: [
    { id: 'second', path: secondTree, sourceRoot: { rootId: 'b', path: secondMain, cwd: secondMain },
      source: { mainRepo: secondMain, commonDir: path.join(secondMain, '.git') }, branch: 'ao/task', baseBranch: 'dev',
      repos: [{ path: 'Plugins/A/vendor/B', branch: 'ao/task', kind: 'independent' }],
      integration: [{ repo: '', branch: 'ao/task', target: 'dev', status: 'failed', message: 'conflict' },
        { repo: 'Plugins/A/vendor/B', branch: 'ao/task', status: 'not-started' }] },
    { ...single.groups[0], integration: [{ repo: '', branch: 'ao/task', target: 'feature', status: 'merged' }] }
  ] };
  const owner = { ...structuredClone(legacy), worktreePath: secondTree, worktreeGroups: state };
  normalizeSessionWorktrees(owner);
  assert.equal(owner.worktreePath, tree, 'the named primary wins over array order and a stale legacy projection');
  assert.equal(owner.worktreeBaseBranch, 'feature');
  const selectedChild = { rootId: 'selected-child', path: path.join(main, 'child'), cwd: path.join(main, 'child', 'src') };
  const childSession = { ...structuredClone(owner), sourceRoot: selectedChild };
  normalizeSessionWorktrees(childSession);
  assert.deepEqual(childSession.sourceRoot, selectedChild, 'container projection must preserve the originally selected child source');
  childSession.worktreeGroups.sourceRoots = [selectedChild];
  normalizeSessionWorktrees(childSession);
  assert.deepEqual(childSession.worktreeGroups.sourceRoots, [selectedChild]);
  assert.deepEqual(owner.worktreeRepoSet, nested);
  const reordered = JSON.parse(JSON.stringify(owner)); reordered.worktreeGroups.groups.reverse(); projectPrimaryWorktree(reordered);
  assert.equal(reordered.worktreePath, tree);
  assert.equal(reordered.worktreeGroups.groups[0].integration[0].status, 'merged');
  assert.equal(reordered.worktreeGroups.groups[1].integration[0].status, 'failed');
  assert.throws(() => syncSingleWorktreeGroup(owner), /group-aware/);
  assert.throws(() => assertSingleWorktreeGroup(owner), /group-aware/);
  assert.equal(owner.worktreeGroups.groups.length, 2);

  const shared = { id: 'fork', cwd: tree };
  assert.equal(shared.worktreeGroups, undefined, 'a cwd alone confers no cleanup ownership');
  transferSessionWorktrees(owner, shared);
  assert.equal(shared.worktreeGroups.groups.length, 2);
  assert.equal(shared.worktreePath, tree);
  for (const field of ['worktreeGroups', 'worktreePath', 'worktreeSource', 'worktreeBranch', 'worktreeBaseBranch', 'worktreeRepoSet']) assert.equal(owner[field], undefined, `old owner releases ${field}`);
  state.groups[0].repos[0].branch = 'changed';
  assert.equal(shared.worktreeGroups.groups[0].repos[0].branch, 'ao/task', 'transfer does not share mutable accounting');
  clearSessionWorktreeMetadata(shared);
  assert.equal(sessionWorktreeGroups(shared), undefined);

  const invalid = edit => {
    const bad = structuredClone(reordered); edit(bad.worktreeGroups);
    assert.throws(() => normalizeSessionWorktrees(bad), /worktree/, 'bad saved groups never fall back to valid-looking legacy fields');
    assert.ok(bad.worktreeGroups, 'keep the damaged saved collection available for diagnosis');
  };
  invalid(s => { s.version = 2; });
  invalid(s => { s.groups = []; });
  invalid(s => { s.primaryGroupId = 'missing'; });
  invalid(s => { s.groups[1].id = s.groups[0].id; });
  invalid(s => { s.groups[1].path = s.groups[0].path; });
  invalid(s => { s.groups[1].source.commonDir = s.groups[0].source.commonDir; });
  invalid(s => { delete s.groups[1].sourceRoot; });
  invalid(s => { s.groups[0].integration[0].status = 'unknown'; });
  invalid(s => { s.groups[0].integration[0].repo = 'outside'; });
  invalid(s => { s.groups[0].integration[0].headCommit = 'not-a-commit'; });
  invalid(s => { s.groups[0].integration[0].targetCommit = '../target'; });
  invalid(s => { s.groups[0].integration[0].mergedCommit = 'not-a-commit'; });
  const cleanup = { repo: '', branch: 'ao/task', status: 'removed', treeRemoved: true, branchRemoved: true };
  invalid(s => { s.groups[0].cleanup = [{ ...cleanup, repo: '../outside' }]; });
  invalid(s => { s.groups[0].cleanup = [{ ...cleanup, treeRemoved: false }]; });
  invalid(s => { s.groups[0].cleanup = [{ ...cleanup, headCommit: 'not-a-commit' }]; });
  invalid(s => { s.groups[0].cleanup = [{ ...cleanup, commonDir: '../git' }]; });
  invalid(s => { s.groups[0].cleanup = [cleanup, cleanup]; });
  invalid(s => { s.groups[0].integration.push(s.groups[0].integration[0]); });
  invalid(s => { s.groups[0].path = '../outside'; });
  invalid(s => { s.groups[0].baseCommit = 'not-a-commit'; });
  invalid(s => { s.sourceRoots = [{ rootId: 'bad', path: '../invalid', cwd: main }]; });
  invalid(s => { s.sourceRoots = [selectedChild, selectedChild]; });
  for (const unsafe of ['../outside', 'Plugins/../../outside', '/absolute', 'A\\B', 'A//B', 'A/./B', 'D:/repo']) invalid(s => { s.groups[0].repos[0].path = unsafe; });
  console.log('ok session-worktree-groups: legacy/disk migration, named primary, independent nested layouts, saved merge results, transfer and corrupt metadata');
} finally {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
}
