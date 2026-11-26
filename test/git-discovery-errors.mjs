import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd(); fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'git-discovery-errors-'));
// Install before importing simple-git, which captures spawn at module load.
const originalSpawn = cp.spawn;
let delayedRoot, delayedStatusScript, delayedCalls = 0;
cp.spawn = function(command, args, options) {
  if (delayedRoot && /^git(?:\.exe)?$/i.test(path.basename(String(command))) && args.includes('status')
    && String(options?.cwd).toLowerCase() === delayedRoot.toLowerCase()) {
    delayedCalls++; return originalSpawn.call(this, process.execPath, [delayedStatusScript, ...args], options);
  }
  return originalSpawn.call(this, command, args, options);
};
syncBuiltinESMExports();
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = path.join(fixture, 'empty.gitconfig'); fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
const { findGitRootsDetailed, isPathInsideWorkspace } = await import(pathToFileURL(compile('main/git/scan.ts')).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const init = dir => {
  fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Discovery fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base'); git(dir, 'add', '.');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'); return dir;
};
const a = init(path.join(fixture, 'source-a'));
const b = init(path.join(fixture, 'source-b'));
const content = path.join(a, 'Content'); fs.mkdirSync(content);
init(path.join(content, 'DeepRepo'));
const missing = path.join(fixture, 'offline');
const notDirectory = path.join(fixture, 'file.txt'); fs.writeFileSync(notDirectory, 'file');
const sources = [{ id: 'a', path: a }, { id: 'b', path: b }, { id: 'missing', path: missing }];
const cfg = { workspace: a, activeWorkspaceId: 'one', worktreeStorageRoot: path.join(fixture, 'managed'),
  workspaces: [{ id: 'one', path: a, roots: sources, defaultRootId: 'a', controlRoot: a, rootsRevision: 0 }] };
const svc = new GitService({ get: () => cfg });
const read = fs.promises.readdir; const denied = new Set([content]); let reads = 0;
fs.promises.readdir = async function(dir, options) {
  reads++;
  if (denied.has(path.resolve(dir))) throw Object.assign(new Error('Access denied by fixture'), { code: 'EACCES' });
  return read.call(this, dir, options);
};
try {
  assert.equal((await findGitRootsDetailed(missing)).issues[0].code, 'ENOENT');
  assert.equal((await findGitRootsDetailed(notDirectory)).issues[0].code, 'ENOTDIR');
  assert(isPathInsideWorkspace(a, path.parse(a).root), 'a drive/filesystem root includes descendants');
  const first = await svc.listReposDetailed(false, [], 'one');
  assert.equal(first.issueCount, 2);
  assert(first.repos.some(r => r.rootId === 'b'), 'healthy sources survive a failed scan elsewhere');
  assert(first.issues.some(e => e.rootId === 'a' && e.path === content && e.code === 'EACCES'));
  assert(first.issues.some(e => e.rootId === 'missing' && e.code === 'ENOENT'));
  const before = reads;
  await svc.listReposDetailed(); assert.equal(reads, before, 'a failure is cached until explicit retry');
  await assert.rejects(svc.discoverNestedReposDetailedFor(a), /discovery incomplete/);
  const blocked = await svc.addSessionWorktreeGroup(a, 'incomplete-scan');
  assert.equal(blocked.ok, false); assert.match(blocked.message, /discovery incomplete/);
  assert(!fs.existsSync(cfg.worktreeStorageRoot), 'incomplete discovery creates no task checkout');
  assert.equal((await svc.discoverNestedReposDetailedFor(b)).healthy.length, 0, 'unrelated failure does not block a healthy source');
  console.log('ok: partial results, root errors and incomplete isolation fail before any checkout');

  denied.clear(); fs.mkdirSync(missing);
  const recovered = await svc.listReposDetailed(true, [], 'one');
  assert.equal(recovered.issueCount, 0, 'recovery clears every reported source');
  assert(recovered.repos.some(r => r.path === path.join(content, 'DeepRepo')));
  assert.deepEqual((await svc.discoverNestedReposDetailedFor(a)).healthy, ['Content/DeepRepo']);
  const refreshed = await svc.refreshRepos('one');
  assert.equal(refreshed.issueCount, 0);
  console.log('ok: explicit retry discovers recovered nested directories and reports scheduler failures');

  const offlineName = b + '-offline'; fs.renameSync(b, offlineName);
  const offline = await svc.listReposDetailed(false, [], 'one');
  assert(!offline.repos.some(r => r.rootId === 'b'), 'cached repositories disappear when their source is offline');
  assert(offline.issues.some(e => e.rootId === 'b' && e.code === 'ENOENT'));
  fs.renameSync(offlineName, b);
  const many = path.join(a, 'many'); fs.mkdirSync(many);
  for (let i = 0; i < 110; i++) { const dir = path.join(many, String(i)); fs.mkdirSync(dir); denied.add(dir); }
  const bounded = await svc.listReposDetailed(true, [], 'one');
  assert.equal(bounded.issues.length, 100); assert.equal(bounded.issueCount, 110);
  await assert.rejects(svc.discoverNestedReposDetailedFor(a), /discovery incomplete/);
  assert(fs.existsSync(path.join(content, 'DeepRepo/.git')), 'sources are retained');
  console.log('ok: offline sources never revive cached rows; bounded IPC preserves the full error count');
  cfg.workspaces.push({ id: 'two', path: b, roots: [{ id: 'two-b', path: b }], defaultRootId: 'two-b', controlRoot: b, rootsRevision: 0 });
  const start = svc.startListRepos.bind(svc); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  svc.startListRepos = async (force, scope) => {
    if (scope.workspace.id === 'two') { entered(); await gate; } return start(force, scope);
  };
  const refresh = svc.refreshRepos(); const rejected = assert.rejects(refresh, /scope changed/);
  await ready; cfg.workspaces[0] = { ...cfg.workspaces[0], rootsRevision: 1 }; release(); await rejected;
  console.log('ok: refreshing all workspaces rechecks every scope before returning a result');

  const statusCfg = { workspace: b, activeWorkspaceId: 'status', workspaces: [{ id: 'status', path: b, controlRoot: b,
    roots: [{ id: 'b', path: b }], defaultRootId: 'b', rootsRevision: 0 }] };
  const statusSvc = new GitService({ get: () => statusCfg });
  const client = statusSvc.client(b), raw = client.raw.bind(client);
  client.raw = async args => { if (args[0] === 'status') throw Error('fixture status unavailable'); return raw(args); };
  const failedStatus = await statusSvc.listReposDetailed();
  assert.equal(failedStatus.repos.length, 0, 'unread status is never published as a clean row');
  assert.equal(failedStatus.issueCount, 1);
  assert(failedStatus.issues.some(issue => issue.code === 'GIT_STATUS' && issue.rootId === 'b' && issue.path === b));
  client.raw = raw;
  const statusRecovered = await statusSvc.listReposDetailed();
  assert.equal(statusRecovered.issueCount, 0, 'status failure is retried without rescanning or caching a clean fallback');
  assert.equal(statusRecovered.repos.length, 1);

  const linked = path.join(fixture, 'status-linked'); git(b, 'worktree', 'add', '-qb', 'status-linked', linked);
  const linkedClient = statusSvc.client(linked), linkedRaw = linkedClient.raw.bind(linkedClient);
  linkedClient.raw = async args => { if (args[0] === 'status') throw Error('fixture linked status unavailable'); return linkedRaw(args); };
  const linkedFailure = await statusSvc.listReposDetailed(false, [linked]);
  assert(!linkedFailure.repos.some(repo => repo.path === linked));
  assert(linkedFailure.issues.some(issue => issue.code === 'GIT_STATUS' && issue.path === linked));
  linkedClient.raw = linkedRaw;
  assert((await statusSvc.listReposDetailed(false, [linked])).repos.some(repo => repo.path === linked));
  console.log('ok: source and requested linked status failures are visible, omit unknown rows and recover');

  // Deterministically delay the real Git status command past the former 10s
  // limit, using only our fixture checkout and owned child process.
  const delayedStatus = path.join(fixture, 'delayed-status.cjs');
  fs.writeFileSync(delayedStatus, `const delay=setTimeout(()=>{const r=require('node:child_process').spawnSync('git',process.argv.slice(2),{cwd:process.cwd(),env:process.env});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)},11000);process.once('exit',()=>clearTimeout(delay));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{clearTimeout(delay);process.exit(1)});`);
  fs.writeFileSync(path.join(b, 'slow-status-WIP.txt'), 'retain real untracked work');
  delayedRoot = b; delayedStatusScript = delayedStatus;
  try {
    const slow = await new GitService({ get: () => statusCfg }).listReposDetailed();
    assert.equal(delayedCalls, 1, 'test actually exercised the delayed subprocess');
    assert.equal(slow.issueCount, 0, 'legitimate >10s status completes within the bounded service timeout');
    assert.equal(slow.repos[0]?.dirty, true, 'real Git sees the fixture WIP after the delay');
  } finally { delayedRoot = undefined; }
  console.log('ok: large-checkout status can exceed 10 seconds without a false timeout or clean result');
} finally { fs.promises.readdir = read; cp.spawn = originalSpawn; syncBuiltinESMExports(); }
