/** Read-only production GitService benchmark. Example:
 * node scripts/measure-workspace-git.mjs --root D:/MetaApp --root D:/MetaApp/unrealengine
 * Artifacts/control metadata belong to this repository's ignored .tmp, outside measured roots.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from '../test/helpers/shared-compile.mjs';

const project = process.cwd(), rootPaths = [];
let output = path.join(project, '.tmp/workspace-git-perf.json');
let locationsOnly = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--locations-only') { locationsOnly = true; continue; }
  const option = process.argv[i], value = process.argv[++i];
  if (!value || !['--root', '--output'].includes(option)) throw Error('Usage: --root <directory> [--root <directory>] [--output <json>]');
  if (option === '--root') rootPaths.push(fs.realpathSync(value)); else output = path.resolve(value);
}
if (!rootPaths.length) throw Error('At least one --root is required');
const key = value => path.resolve(String(value)).replace(/\\/g, '/').toLowerCase();
const inside = (value, root) => key(value) === key(root) || key(value).startsWith(key(root) + '/');
const artifactRoot = path.join(project, '.tmp');
if (rootPaths.some(root => inside(artifactRoot, root) || inside(output, root))) throw Error('Measurement artifacts must be outside measured source roots');
for (const root of rootPaths) assert.ok(fs.statSync(root).isDirectory());
fs.mkdirSync(artifactRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(artifactRoot, 'workspace-git-perf-'));
const control = path.join(fixture, 'control'); fs.mkdirSync(control);
// Avoid inherited repository/index redirects and optional status index writes.
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
Object.assign(process.env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(fixture, 'empty.gitconfig') });
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

let metrics, directChildren = 0, pendingReads = 0;
const watchedChildren = new WeakSet();
function guard(file) {
  if (typeof file !== 'string' && !Buffer.isBuffer(file)) return;
  if (rootPaths.some(root => inside(file, root)) && key(file).split('/').includes('.metaagent')) {
    throw Error(`Refusing source .metaAgent storage access: ${file}`);
  }
}
const readonlyGit = new Set(['status', 'rev-parse', 'rev-list', 'symbolic-ref', 'log', 'show', 'diff', 'ls-files', 'ls-tree']);
function gitKind(command, args = []) {
  if (!/^git(?:\.exe)?$/i.test(path.basename(String(command)))) throw Error(`Unexpected subprocess: ${command}`);
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--git-dir' || arg === '--work-tree') { guard(args[++i]); continue; }
    if (readonlyGit.has(arg)) return arg;
    if (arg === 'config' && args.slice(i + 1).some(value => /^--(?:get|get-all|get-regexp|list)$|^-l$/.test(String(value)))) return 'config-read';
    if (arg === 'worktree' && args[i + 1] === 'list') return 'worktree-list';
    if (!arg.startsWith('-')) throw Error(`Refusing non-read-only Git command: ${arg}`);
  }
  throw Error('Unrecognized Git command');
}
function track(child, kind, args = []) {
  if (watchedChildren.has(child)) return child;
  watchedChildren.add(child); directChildren++;
  if (metrics) { metrics.gitProcesses++; metrics.peakGitProcesses = Math.max(metrics.peakGitProcesses, directChildren);
    metrics.gitCommands[kind] = (metrics.gitCommands[kind] ?? 0) + 1; }
  const phaseMetrics = metrics;
  child.once('close', code => {
    directChildren--;
    if (phaseMetrics && code !== 0) {
      if (kind === 'rev-parse' && args.includes('@{u}')) phaseMetrics.expectedMissingUpstream++;
      else phaseMetrics.gitFailures++;
    }
  });
  return child;
}
const spawn = cp.spawn, execFile = cp.execFile;
cp.spawn = function (command, args, options) { const kind = gitKind(command, args); return track(spawn.call(this, command, args, options), kind, args); };
cp.execFile = function (command, ...args) { const kind = gitKind(command, args[0]); return track(execFile.call(this, command, ...args), kind, args[0]); };
cp.execFile[promisify.custom] = function (command, ...args) {
  const kind = gitKind(command, args[0]); const result = execFile[promisify.custom](command, ...args);
  track(result.child, kind, args[0]); return result;
};
const readdir = fs.promises.readdir;
fs.promises.readdir = async function (file, ...args) {
  guard(file); pendingReads++;
  if (metrics) { metrics.readdir++; metrics.peakReaddir = Math.max(metrics.peakReaddir, pendingReads); }
  try {
    const entries = await readdir.call(this, file, ...args);
    if (metrics) metrics.entries += entries.length;
    return entries;
  } finally { pendingReads--; }
};
for (const object of [fs, fs.promises]) for (const name of ['readFile', 'readFileSync', 'stat', 'statSync', 'access', 'accessSync']) {
  if (typeof object[name] !== 'function') continue;
  const original = object[name]; object[name] = function (file, ...args) { guard(file); return original.call(this, file, ...args); };
}
// Any production watcher allocation is a benchmark failure, rather than a hidden leak.
fs.watch = () => { throw Error('Git discovery/list must not allocate workspace watchers'); };
syncBuiltinESMExports();
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
const { readGitDirectories } = await import(pathToFileURL(compile('main/git/repoIdentity.ts')).href);
const roots = [{ id: 'control', path: control }, ...rootPaths.map((value, index) => ({ id: `root-${index}`, path: value }))];
const workspace = { id: 'measured', path: rootPaths[0], controlRoot: control, roots, defaultRootId: 'root-0', rootsRevision: 0 };
const service = new GitService({ get: () => ({ workspace: workspace.path, activeWorkspaceId: workspace.id,
  workspaces: [workspace], gitExtraReposByWorkspace: {} }) });
const samples = [];
const resources = () => process.getActiveResourcesInfo().filter(name => /Process|Pipe|FS|TCP|Timer|Timeout/i.test(name)).sort();
async function drain() {
  for (let i = 0; i < 600 && directChildren; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(directChildren, 0, 'all benchmark Git subprocesses exited'); assert.equal(pendingReads, 0);
}
async function phase(name, run) {
  metrics = { readdir: 0, entries: 0, peakReaddir: 0, gitProcesses: 0, peakGitProcesses: 0, gitCommands: {}, gitFailures: 0, expectedMissingUpstream: 0, warnings: [] };
  const start = performance.now(), value = await run();
  const elapsedMs = Number((performance.now() - start).toFixed(2)), drainStart = performance.now();
  await drain(); await new Promise(resolve => setImmediate(resolve));
  const drainMs = Number((performance.now() - drainStart).toFixed(2));
  const sample = { name, elapsedMs, drainMs, ...metrics, activeGitProcesses: directChildren, resources: resources() };
  if (Array.isArray(value)) sample.repos = value.length;
  else if (value?.repos) { sample.repos = value.repos.length; sample.issues = value.issueCount; }
  else if (value?.roots) { sample.repos = value.roots.length; sample.issues = value.issues.length; }
  else if (value?.healthy) sample.repos = value.healthy.length;
  sample.successful = sample.gitFailures === 0 && sample.warnings.length === 0;
  samples.push(sample); console.log(JSON.stringify(sample)); metrics = undefined; return value;
}
const warn = console.warn;
console.warn = (...args) => { metrics?.warnings.push(args.map(String).join(' ')); warn(...args); };
const existsRead = file => { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function sourceState(repo) {
  const dirs = readGitDirectories(repo); if (!dirs) return undefined;
  const head = existsRead(path.join(dirs.gitDir, 'HEAD'));
  const ref = head?.toString('utf8').trim().match(/^ref: (refs\/[^\0\\]+)$/)?.[1];
  const resolved = ref && !ref.split('/').includes('..') ? existsRead(path.join(dirs.commonDir, ref)) : null;
  return { head, index: existsRead(path.join(dirs.gitDir, 'index')), resolved,
    packed: ref && !resolved ? existsRead(path.join(dirs.commonDir, 'packed-refs')) : null };
}
const baselineResources = resources();
const topology = await phase('first-topology', () => service.discovery.rootsManyDetailed(roots.map(root => root.path)));
// Sandbox accounts may differ from the source owner. Trust only discovered paths
// in our disposable config; never mutate the user's global config or source repos.
const safePath = value => String(value).replace(/\\/g, '/').replace(/"/g, '\\"');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, `[safe]\n${topology.roots.map(repo => `\tdirectory = "${safePath(repo)}"`).join('\n')}\n`);
const states = topology.roots.map(repo => [repo, sourceState(repo)]);
await phase('cached-directory-choices', () => service.listRepoLocations(false, workspace.id));
await phase('repeated-directory-choices', () => service.listRepoLocations(false, workspace.id));
if (locationsOnly) {
  await phase('manual-directory-refresh', () => service.listRepoLocations(true, workspace.id));
  await phase('directory-choices-after-refresh', () => service.listRepoLocations(false, workspace.id));
} else {
  await phase('first-list-status', () => service.listRepos(false, [], workspace.id));
  await phase('cached-list', () => service.listRepos(false, [], workspace.id));
  await phase('manual-list-refresh', () => service.listRepos(true, [], workspace.id));
  await phase('cached-after-refresh', () => service.listRepos(false, [], workspace.id));
}
await phase('cached-topology', () => service.discovery.rootsManyDetailed(roots.map(root => root.path)));
for (const root of rootPaths.filter(root => topology.roots.some(repo => key(repo) === key(root)))) {
  await phase(`cached-nested:${path.basename(root)}`, () => service.discoverNestedReposDetailedFor(root));
}
for (const [repo, before] of states) assert.deepEqual(sourceState(repo), before, `source HEAD/ref/index changed: ${repo}`);
const report = { measuredAt: new Date().toISOString(), node: process.version, roots: rootPaths, fixture, baselineResources, samples,
  sourceHeadsAndIndexesUnchanged: true, sourceMetaAgentNodeReads: 0, sourceWrites: 'no checkout/branch/config/index writes; GIT_OPTIONAL_LOCKS=0',
  caveats: 'Warm OS cache; discovery and list/status measured separately; excludes worktree checkout/provision and dispatch; direct child processes only; native Git filesystem reads are not instrumented; disposable Git config trusts only discovered repos for sandbox ownership compatibility; failed/fallback samples are explicitly marked unsuccessful.' };
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Report: ${output}`);
