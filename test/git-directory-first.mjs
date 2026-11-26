/** Browsing independent ignored repos needs no Git process; slow status TTL starts at completion. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd();
fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'git-directory-first-'));
const workspace = path.join(fixture, 'workspace');
function entry(relative) {
  const repo = path.join(workspace, relative);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return repo;
}
const main = entry('');
const plugin = entry('Plugins/P');
const deep = entry('Plugins/Group/P/src/nested');
const reference = entry('.dev-sandbox/clone');
fs.writeFileSync(path.join(main, '.gitignore'), 'Plugins/\n.dev-sandbox/\n');
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const originalExec = cp.execFile;
let processes = 0;
cp.execFile = () => { processes++; throw Error('Directory discovery must not launch Git'); };
cp.execFile[promisify.custom] = cp.execFile;
syncBuiltinESMExports();
try {
  const { GitRepoDiscoveryCache } = await import(pathToFileURL(compile('main/git/discoveryCache.ts')).href);
  const discovery = new GitRepoDiscoveryCache();
  const result = await discovery.rootsManyDetailed([workspace, main]);
  assert.deepEqual(new Set(result.roots), new Set([main, plugin, deep, reference]), 'parent ignore rules never hide independent browsing entries');
  assert.equal(processes, 0, 'directory publication must not wait for commit health');
  assert.deepEqual(result.issues, []);
  assert.deepEqual(new Set(await discovery.roots(main)), new Set([main, plugin, deep, reference]));
  console.log('ok: directory discovery keeps ignored/deep independent repos and launches zero Git processes');
} finally {
  cp.execFile = originalExec;
  syncBuiltinESMExports();
}

const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
const service = new GitService({ get: () => ({ workspace, workspaces: [{ id: 'one', path: workspace }], activeWorkspaceId: 'one' }) });
const originalNow = Date.now;
let now = 10_000, statusReads = 0;
Date.now = () => now;
service.readGitProbeMtime = async () => 1;
service.readHeadBranch = async () => null;
service.client = () => ({ raw: async args => {
  assert.deepEqual(args, ['status', '--porcelain']);
  statusReads++;
  now += 5_000; // deterministic reproduction of a query slower than its two-second TTL
  return '';
} });
try {
  const first = await service.summarizeRepo(main);
  assert.equal(first.dirty, false);
  assert.strictEqual(await service.summarizeRepo(main), first);
  assert.equal(statusReads, 1, 'an immediately repeated slow status must hit the fresh cache');
  now += 1_999;
  await service.summarizeRepo(main);
  assert.equal(statusReads, 1, 'TTL is fixed at completion, not extended by cache reads');
  now++;
  await service.summarizeRepo(main);
  assert.equal(statusReads, 2, 'expired status is actually queried again');
  console.log('ok: slow porcelain TTL starts at completion and expires without sliding');
} finally { Date.now = originalNow; }

// A manual scan publishes directories immediately, while an old status is still
// running. New readers must wait for that process and query afresh, never reuse it.
service.assertAllowed = async repo => repo;
let finishStatus, statusStarted;
let fullStatusReads = 0;
const statusGate = new Promise(resolve => { finishStatus = resolve; });
const started = new Promise(resolve => { statusStarted = resolve; });
service.client = () => ({ status: async () => {
  fullStatusReads++;
  if (fullStatusReads === 1) { statusStarted(); await statusGate; }
  return { current: fullStatusReads === 1 ? 'old' : 'fresh', tracking: null, ahead: 0, behind: 0, files: [] };
} });
const oldStatus = service.status(main);
await started;
const refreshed = await service.listRepoLocations(true, 'one');
assert(refreshed.repos.some(repo => repo.path === main), 'directory refresh does not await the old status');
const freshStatus = service.status(main);
finishStatus();
assert.equal((await oldStatus).branch, 'old');
assert.equal((await freshStatus).branch, 'fresh');
assert.equal(fullStatusReads, 2);
assert.equal((await service.status(main)).branch, 'fresh');
assert.equal(fullStatusReads, 2, 'only the post-refresh status enters the cache');

let finishSummary, summaryStarted;
let summaryReads = 0;
const summaryGate = new Promise(resolve => { finishSummary = resolve; });
const readySummary = new Promise(resolve => { summaryStarted = resolve; });
service.client = () => ({ raw: async () => {
  summaryReads++;
  if (summaryReads === 1) { summaryStarted(); await summaryGate; return ''; }
  return ' M changed.txt\n';
} });
const staleSummary = service.summarizeRepo(main);
await readySummary;
await service.listRepoLocations(true, 'one');
finishSummary();
await staleSummary;
assert.equal((await service.summarizeRepo(main)).dirty, true);
assert.equal(summaryReads, 2, 'late pre-refresh summaries cannot refill the cache');
console.log('ok: manual directory refresh stays prompt and rejects late status/summary cache writes');

await service.listRepoLocations(true, 'one');
let finishShared, sharedStarted;
const sharedGate = new Promise(resolve => { finishShared = resolve; });
const readyShared = new Promise(resolve => { sharedStarted = resolve; });
let sharedReads = 0;
service.client = () => ({ raw: async () => { sharedReads++; sharedStarted(); await sharedGate; return ''; } });
const sharedA = service.summarizeBounded(main);
const sharedB = service.summarizeBounded(main);
assert.strictEqual(sharedA, sharedB, 'resource/content panels share one in-flight repo summary');
await readyShared;
finishShared();
await Promise.all([sharedA, sharedB]);
assert.equal(sharedReads, 1);
console.log('ok: simultaneous panel requests do not duplicate repository status processes');
