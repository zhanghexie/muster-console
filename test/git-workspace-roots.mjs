import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd();
fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'git-workspace-roots-'));
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = path.join(fixture, 'empty.gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Multi roots fixture');
  git(dir, 'config', 'user.email', 'roots@example.invalid');
  fs.writeFileSync(path.join(dir, 'same.txt'), path.basename(dir));
  git(dir, 'add', '.');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return dir;
}
const a = path.join(fixture, 'non-git'); fs.mkdirSync(a);
const b = init(path.join(fixture, 'source-b'));
const nested = init(path.join(b, 'Plugins/Nested'));
const c = init(path.join(fixture, 'source-c'));
const extra = init(path.join(fixture, 'extra'));
const makeWorkspace = (id, roots) => ({ id, name: id, openedAt: 0, path: roots[0].path,
  roots, defaultRootId: roots[0].id, controlRoot: roots[0].path, rootsRevision: 0 });
let cfg = { workspace: a, activeWorkspaceId: 'one', worktreeStorageRoot: path.join(fixture, 'managed'),
  workspaces: [makeWorkspace('one', [{ id: 'a', path: a }, { id: 'b', path: b }, { id: 'nested', path: nested }]),
    makeWorkspace('two', [{ id: 'c', path: c }])] };
const svc = new GitService({ get: () => cfg, update: patch => { cfg = { ...cfg, ...patch }; } });
const originalRead = fs.promises.readdir;
const walks = [];
fs.promises.readdir = async function(dir, options) { walks.push(path.resolve(dir)); return originalRead.call(this, dir, options); };
try {
  const originalSummaryRead = svc.summarizeRepo;
  svc.summarizeRepo = () => { throw Error('Directory choices must not query repository status'); };
  const locations = await svc.listRepoLocations(false, 'one');
  assert(locations.repos.some(r => r.path === b && r.rootId === 'b'));
  assert.equal(locations.repos.filter(r => r.path === nested).length, 1);
  assert.equal(locations.repos.find(r => r.path === nested).rootId, 'nested');
  assert(locations.repos.every(r => !('dirty' in r) && !('branch' in r)), 'topology is not a fabricated clean summary');
  const locationWalks = walks.length;
  const [locationsA, locationsB] = await Promise.all([svc.listRepoLocations(false, 'one'), svc.listRepoLocations(false, 'one')]);
  assert.deepEqual(locationsA, locationsB);
  assert.equal(walks.length, locationWalks, 'directory choices reuse discovery without walking again');
  await assert.rejects(svc.listRepoLocations(false, 'missing'), /workspace not found|工作区不存在/);
  svc.summarizeRepo = originalSummaryRead;
  console.log('ok: repository choices reuse topology, preserve source membership and never query status');
  const one = await svc.listRepos(false, [], 'one');
  assert(one.some(r => r.path === b), 'non-Git default must not hide the second source repository');
  assert.equal(one.find(r => r.path === nested)?.rootId, 'nested', 'overlap belongs to the more specific registered root');
  assert.equal(one.find(r => r.path === b)?.workspaceId, 'one');
  assert.equal(one.filter(r => r.path === nested).length, 1);
  assert.equal(walks.filter(p => p === nested).length, 1, 'overlapping source roots scan once');
  const before = walks.length;
  await svc.listRepos(false, [], 'one');
  await svc.discoverNestedReposDetailedFor(b);
  assert.equal(walks.length, before, 'status/preflight reuse topology');
  assert.equal((await svc.status(b)).branch, 'main', 'secondary root accepted before changing the UI');
  const two = await svc.listRepos(false, [], 'two');
  assert.deepEqual(two.map(r => r.path), [c], 'explicit workspace does not use the active workspace');
  await assert.rejects(svc.listRepos(false, [], 'missing'), /workspace not found|工作区不存在/);
  console.log('ok: all source roots, most-specific membership, deduplication and explicit workspace');
  const rootOrder = cfg.workspaces[0].roots.map(r => r.id);
  const partialSummaries = await svc.withWorkspace({ workspaceId: 'one', rootsRevision: 0 }, () => svc.repoSummaries([b, nested]));
  assert.deepEqual(partialSummaries.repos.map(r => r.path).sort(), [b, nested].sort());
  assert.equal(partialSummaries.repos.find(r => r.path === nested)?.rootId, 'nested');
  assert.deepEqual(cfg.workspaces[0].roots.map(r => r.id), rootOrder, 'background summary ownership must not reorder configured roots');

  const built = await svc.addSessionWorktreeGroup(b, 'roots001-aaaa-bbbb-cccc-000000000001');
  assert.equal(built.ok, true, built.message);
  assert.equal((await svc.listRepos(false, [built.path], 'one')).find(r => r.path === built.path)?.worktree, true);
  assert(!(await svc.listRepos(false, [built.path], 'two')).some(r => r.path === built.path), 'requested tree must belong to the requested workspace');
  const oldOne = cfg.workspaces[0];
  cfg = { ...cfg, workspaces: [{ ...oldOne, rootsRevision: 1, roots: [oldOne.roots[0]] }, cfg.workspaces[1]] };
  await assert.rejects(svc.status(b), /未知仓库|Unknown repository/);
  await assert.rejects(svc.status(built.path), /未知仓库|Unknown repository/);
  assert(!(await svc.listRepos(false, [], 'one')).some(r => r.path === b), 'cached topology cannot restore removed membership');
  cfg = { ...cfg, workspaces: [cfg.workspaces[0], { ...cfg.workspaces[1], rootsRevision: 1,
    roots: [...cfg.workspaces[1].roots, { id: 'shared-b', path: b }] }] };
  assert.equal((await svc.status(b)).branch, 'main', 'another workspace keeps its own source membership');
  assert(!(await svc.listRepos(false, [built.path], 'one')).some(r => r.path === built.path), 'other workspace membership does not leak into this list');
  assert((await svc.listRepos(false, [built.path], 'two')).some(r => r.path === built.path));
  console.log('ok: fresh source/linked authorization; shared workspace membership survives independently');

  // Lists in different workspaces must not share one promise; a root edit rejects
  // old in-flight results before they can reach the UI or become an allow index.
  const originalSummary = svc.summarizeRepo.bind(svc);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  svc.summarizeRepo = async (...args) => { entered(); await gate; return originalSummary(...args); };
  const oldRead = svc.listRepos(false, [], 'two');
  await ready;
  cfg = { ...cfg, workspaces: [cfg.workspaces[0], { ...cfg.workspaces[1], rootsRevision: 2,
    roots: [cfg.workspaces[1].roots[0]] }] };
  const oldRejected = assert.rejects(oldRead, /changed|变更/);
  const otherRead = svc.listRepos(false, [], 'one');
  release();
  await oldRejected;
  assert.deepEqual(await otherRead, []);
  svc.summarizeRepo = originalSummary;
  await assert.rejects(svc.status(built.path), /未知仓库|Unknown repository/);
  const added = init(path.join(c, 'AddedAfterSnapshot'));
  assert(!(await svc.listRepos(false, [], 'two')).some(r => r.path === added));
  const scanCount = walks.length;
  const [freshA, freshB] = await Promise.all([svc.listRepos(true, [], 'two'), svc.listRepos(true, [], 'two')]);
  assert(freshA.some(r => r.path === added)); assert.deepEqual(freshA, freshB);
  assert.equal(walks.slice(scanCount).filter(p => p === c).length, 1, 'parallel manual requests share one fresh traversal');
  assert.equal((await svc.refreshRepos('two')).workspaceIds.join(), 'two');
  console.log('ok: revision cancellation, per-workspace single-flight and manual fresh snapshot');

  // Canonical Git paths and registered Junction aliases identify one checkout;
  // a Junction inside a root must not grant access to an unrelated repository.
  const alias = path.join(fixture, 'source-alias'); fs.symlinkSync(c, alias, process.platform === 'win32' ? 'junction' : 'dir');
  cfg = { ...cfg, workspaces: [cfg.workspaces[0], { ...cfg.workspaces[1], path: alias, controlRoot: alias, rootsRevision: 3,
    roots: [{ id: 'alias-c', path: alias }, { id: 'canonical-c', path: c }] }] };
  const aliasList = await svc.listRepos(false, [], 'two');
  assert.equal(aliasList.length, 2, 'root aliases do not duplicate physical checkouts');
  cfg = { ...cfg, workspaces: [cfg.workspaces[0], { ...cfg.workspaces[1], rootsRevision: 4, roots: [{ id: 'alias-c', path: alias }] }] };
  assert.equal((await svc.status(c)).branch, 'main', 'canonical Git path recognizes a registered source alias');
  const outside = init(path.join(fixture, 'outside'));
  fs.symlinkSync(outside, path.join(a, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(svc.status(path.join(a, 'escape')), /未知仓库|Unknown repository/);
  assert(!((await svc.listRepos(true, [], 'one')).some(r => r.path.includes('escape'))));
  cfg = { ...cfg, workspaces: [...cfg.workspaces, makeWorkspace('closed', [{ id: 'closed-source', path: outside }])] };
  assert.equal((await svc.status(outside)).branch, 'main');
  cfg = { ...cfg, workspaces: cfg.workspaces.filter(w => w.id !== 'closed') };
  await assert.rejects(svc.status(outside), /未知仓库|Unknown repository/, 'closing a workspace revokes its source roots');
  cfg = { ...cfg, workspaces: [...cfg.workspaces, makeWorkspace('closed', [{ id: 'closed-source', path: outside }])] };
  assert.equal((await svc.status(outside)).branch, 'main', 'reopening restores the registered scope');
  cfg = { ...cfg, workspaces: cfg.workspaces.filter(w => w.id !== 'closed') };
  console.log('ok: physical aliases share membership; an internal Junction cannot expand the scope');

  const secondCheckout = path.join(fixture, 'second-checkout');
  git(c, 'worktree', 'add', '-q', '-b', 'second-checkout', secondCheckout);
  cfg = { ...cfg, workspaces: [cfg.workspaces[0], { ...cfg.workspaces[1], rootsRevision: 5,
    roots: [...cfg.workspaces[1].roots, { id: 'checkout', path: secondCheckout }] }] };
  const checkouts = await svc.listRepos(false, [], 'two');
  assert(checkouts.some(r => r.path === secondCheckout && r.rootId === 'checkout'));
  assert(checkouts.some(r => r.rootId === 'alias-c'), 'linked checkout is not collapsed by commonDir');
  const checkoutLocations = await svc.listRepoLocations(false, 'two');
  assert.equal(checkoutLocations.repos.find(r => r.path === secondCheckout)?.worktree, true, 'choices exclude linked source checkouts just as summaries do');
  const externalCheckout = path.join(fixture, 'external-checkout');
  git(c, 'worktree', 'add', '-q', '-b', 'external-checkout', externalCheckout);
  const requestedLocations = await svc.listRepoLocations(false, 'two', [externalCheckout]);
  assert(requestedLocations.repos.some(r => r.path === externalCheckout && r.worktree && r.workspaceId === 'two'),
    'directory-first panel retains explicitly requested external task worktrees');
  assert(!requestedLocations.repos.find(r => r.path === externalCheckout)?.dirty, 'directory choices do not imply status');
  const newlyAdded = init(path.join(c, 'AddedForChoices'));
  assert(!(await svc.listRepoLocations(false, 'two')).repos.some(r => r.path === newlyAdded));
  const beforeChoicesRefresh = walks.length;
  svc.summarizeRepo = () => { throw Error('Manual directory refresh must not query status'); };
  const [choiceRefreshA, choiceRefreshB] = await Promise.all([svc.listRepoLocations(true, 'two'), svc.listRepoLocations(true, 'two')]);
  assert.deepEqual(choiceRefreshA, choiceRefreshB);
  assert(choiceRefreshA.repos.some(r => fs.realpathSync(r.path) === fs.realpathSync(newlyAdded)), 'refresh retains registered alias paths while discovering the physical checkout');
  assert.equal(walks.slice(beforeChoicesRefresh).filter(p => p === c).length, 1, 'concurrent manual choices share one traversal');
  svc.summarizeRepo = originalSummaryRead;
  console.log('ok: linked checkouts retain separate source/root identity despite a shared commonDir');
  const beforeRefresh = walks.length;
  const [refreshA, refreshB] = await Promise.all([svc.refreshRepos('two'), svc.refreshRepos('two')]);
  assert.deepEqual(refreshA, refreshB);
  assert.equal(walks.slice(beforeRefresh).filter(p => p === c).length, 1, 'catalog refresh also coalesces concurrent manual requests');
  await assert.rejects(svc.refreshRepos(''), /workspace not found/);
  console.log('ok: manual refresh via the scheduler returns one fresh shared result');
} finally { fs.promises.readdir = originalRead; }
