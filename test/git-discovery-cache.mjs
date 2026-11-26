import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd();
// A staged gate snapshot starts without the ignored .tmp directory.
fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'git-discovery-cache-'));
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = path.join(fixture, 'empty.gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
const { cleanupSessionWorktreeOnArchive } = await import(pathToFileURL(compile('main/git/worktreeSessionOps.ts')).href);
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Discovery fixture');
  git(dir, 'config', 'user.email', 'discovery@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return dir;
}
const workspace = path.join(fixture, 'workspace');
const main = init(path.join(workspace, 'main'));
const deep = 'Content/assets/deep/a/b/c/repo';
init(path.join(main, deep));
const child = deep + '/vendor/child';
init(path.join(main, child));
const ignoredReference = init(path.join(main, '.dev-sandbox', 'reference'));
fs.writeFileSync(path.join(main, '.gitignore'), '.dev-sandbox/\n');
let currentWorkspace = workspace;
const svc = new GitService({
  get: () => ({ workspace: currentWorkspace, activeWorkspaceId: 'one',
    workspaces: [{ id: 'one', path: currentWorkspace }], worktreeStorageRoot: path.join(fixture, 'managed') })
});
const originalRead = fs.promises.readdir;
let walks = [];
fs.promises.readdir = async function (dir, options) {
  if (path.resolve(dir).startsWith(path.resolve(workspace))) walks.push(String(dir));
  return originalRead.call(this, dir, options);
};
async function settle(result, id) {
  const session = { id, type: 'terminal', cwd: result.path, meta: {}, worktreePath: result.path,
    worktreeBranch: result.branch, worktreeBaseBranch: result.baseBranch,
    worktreeSource: result.source, worktreeRepoSet: result.repos };
  const notices = [];
  await cleanupSessionWorktreeOnArchive({ git: svc, config: { get: () => ({}) },
    notify: { push: n => notices.push(n) }, persist() {}, broadcast() {}, findSession: () => session }, session);
  assert.equal(fs.existsSync(result.path), false, JSON.stringify(notices));
}
try {
  // The list and dispatch overlap on first read: share one enclosing scan.
  const [list, discovered] = await Promise.all([svc.listRepos(), svc.discoverNestedReposDetailedFor(main)]);
  assert(list.some(r => r.path === path.join(main, child)), 'Git list includes repositories deeper than five levels');
  assert(list.some(r => r.path === ignoredReference), 'browsing shows independent ignored repositories');
  assert.deepEqual(discovered.healthy, [deep, child]);
  assert.equal(walks.filter(p => path.resolve(p) === path.resolve(main)).length, 1);
  const explicit = await svc.discoverNestedReposDetailedFor(main, { includeIgnored: true });
  assert(explicit.healthy.includes('.dev-sandbox/reference'), 'explicit subtree discovery includes ignored repositories');
  assert.deepEqual((await svc.discovery.nested(main, [ignoredReference], true)).healthy, [deep, child], 'explicit workspace exclusions still win');
  const ignoredHead = path.join(ignoredReference, '.git', 'HEAD');
  const headContents = fs.readFileSync(ignoredHead);
  fs.writeFileSync(ignoredHead, 'ref: refs/heads/missing\n');
  const unhealthy = await svc.discoverNestedReposDetailedFor(main, { includeIgnored: true });
  assert(unhealthy.skipped.some(repo => repo.path === '.dev-sandbox/reference'), 'ignored repositories receive commit health checks before selection');
  fs.writeFileSync(ignoredHead, headContents);
  assert.deepEqual((await svc.discoverNestedReposDetailedFor(main)).healthy, [deep, child], 'explicit discovery does not widen later automatic isolation');
  const readCount = walks.length;
  discovered.healthy.length = 0;
  assert.deepEqual((await svc.discoverNestedReposDetailedFor(main)).healthy, [deep, child]);

  const added = 'Plugins/AddedAfterRefresh';
  init(path.join(main, added));
  const normal = await svc.listRepos();
  assert(!normal.some(r => r.path === path.join(main, added)), 'normal status refresh reuses repository topology');
  const first = await svc.addSessionWorktreeGroup(main, 'cache001-aaaa-bbbb-cccc-000000000001');
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(first.repos.map(r => r.path).sort(), [deep, child].sort());
  await settle(first, 'cache001');
  assert.equal(walks.length, readCount, 'dispatch, construction, cleanup and status refresh perform no source directory traversal');
  console.log('ok: list/preflight/create/cleanup reuse the same topology, including Content repos and deep descendants');

  const refreshed = await svc.listRepos(true);
  assert(refreshed.some(r => r.path === path.join(main, added)));
  assert((await svc.discoverNestedReposDetailedFor(main)).healthy.includes(added));
  const afterManual = walks.length;
  const second = await svc.addSessionWorktreeGroup(main, 'cache002-aaaa-bbbb-cccc-000000000002');
  assert.equal(second.ok, true, second.message);
  assert(second.repos.some(r => r.path === added));
  await settle(second, 'cache002');
  assert.equal(walks.length, afterManual, 'worktree mutation must not invalidate source topology');
  console.log('ok: explicit refresh replaces the snapshot, then the next group uses it without rescanning');

  // A cached healthy candidate can become invalid. Fresh Git worktree creation must
  // fail and preserve source contents rather than trusting the old health verdict.
  fs.renameSync(path.join(main, deep, '.git', 'HEAD'), path.join(main, deep, '.git', 'HEAD.saved'));
  const failed = await svc.addSessionWorktreeGroup(main, 'cache003-aaaa-bbbb-cccc-000000000003');
  assert.equal(failed.ok, false);
  assert.equal(fs.readFileSync(path.join(main, deep, 'a.txt'), 'utf8'), 'base\n');
  assert.equal(walks.length, afterManual);
  fs.renameSync(path.join(main, deep, '.git', 'HEAD.saved'), path.join(main, deep, '.git', 'HEAD'));
  console.log('ok: stale health cannot bypass fresh Git validation; a broken source is retained');

  // Root directory mtime and active workspace changes must not evict other snapshots.
  const other = init(path.join(fixture, 'other'));
  currentWorkspace = other;
  await svc.listRepos();
  currentWorkspace = workspace;
  const beforeReturn = walks.length;
  await svc.listRepos();
  assert.equal(walks.length, beforeReturn);
  console.log('ok: workspace snapshots survive switching and filesystem noise');

  // Reproduce manual refresh arriving while a slow ordinary summary read is in flight.
  // It must await the fresh topology instead of returning the old list and secretly
  // scanning afterwards, which would leave the UI showing the stale result.
  const newest = 'Plugins/RefreshDuringSummary';
  init(path.join(main, newest));
  const originalSummary = svc.summarizeRepo.bind(svc);
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  svc.summarizeRepo = async (...args) => {
    started();
    await gate;
    return originalSummary(...args);
  };
  const oldRead = svc.listRepos();
  await ready;
  const scanCount = walks.length;
  const forceA = svc.listRepos(true);
  const forceB = svc.listRepos(true);
  release();
  const [oldList, newA, newB] = await Promise.all([oldRead, forceA, forceB]);
  assert(!oldList.some(r => r.path === path.join(main, newest)));
  assert(newA.some(r => r.path === path.join(main, newest)));
  assert.deepEqual(newA, newB);
  assert.equal(walks.slice(scanCount).filter(p => path.resolve(p) === path.resolve(workspace)).length, 1);
  console.log('ok: concurrent manual refresh waits for one fresh scan and returns its result');
} finally {
  fs.promises.readdir = originalRead;
}
