import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd();
fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'git-operation-scope-'));
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = path.join(fixture, 'empty.gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const compiled = path.join(fixture, 'compiled');
const compile = createSharedCompiler(project, compiled);
const electron = path.join(compiled, 'node_modules/electron');
fs.mkdirSync(electron, { recursive: true });
fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
fs.writeFileSync(path.join(electron, 'index.mjs'), 'export const ipcMain = { handle() {} };');
const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
const { parseUnifiedDiff } = await import(pathToFileURL(compile('main/git/adopt.ts')).href);
const { registerGitIpc } = await import(pathToFileURL(compile('main/ipc/git.ts')).href);
const { invokeIpcChannel } = await import(pathToFileURL(compile('main/ipc/handle.ts')).href);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function init(name) {
  const dir = path.join(fixture, name); fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'Scope fixture'); git(dir, 'config', 'user.email', 'scope@example.invalid');
  fs.writeFileSync(path.join(dir, 'same.txt'), `${name}\n`); git(dir, 'add', '.'); git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return dir;
}
const a = init('a'), b = init('b');
const workspace = (id, root) => ({ id, name: id, openedAt: 0, path: root,
  roots: [{ id: `${id}-root`, path: root }], rootsRevision: 0, defaultRootId: `${id}-root`, controlRoot: root });
let config = { workspace: a, activeWorkspaceId: 'one', workspaces: [workspace('one', a), workspace('two', b)],
  worktreeStorageRoot: path.join(fixture, 'managed') };
const cfg = { get: () => config, update: patch => { config = { ...config, ...patch }; } };
const service = new GitService(cfg);
registerGitIpc({ git: service, config: cfg, getWindow: () => null, sessions: { list: () => [] } });
const one = { workspaceId: 'one', rootsRevision: 0 }, two = { workspaceId: 'two', rootsRevision: 0 };
const invoke = (scope, method, ...args) => invokeIpcChannel('git:invokeScoped', [scope, method, args]);
const changeRevision = () => { config = { ...config, workspaces: config.workspaces.map(w => w.id === 'one' ? { ...w, rootsRevision: w.rootsRevision + 1 } : w) }; };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
try {
  const summaries = await invoke(one, 'repoSummaries', [a]);
  assert.equal(summaries.workspaceId, 'one'); assert.equal(summaries.repos.length, 1);
  assert.equal(summaries.repos[0].path, a); assert.equal(summaries.repos[0].branch, 'main');
  await assert.rejects(invoke(one, 'repoSummaries', [a, b]), /未知仓库|Unknown repository/);
  await assert.rejects(invoke(one, 'repoSummaries', [a, a, a]), /invalid repository summary batch/);
  await assert.rejects(invoke(one, 'repoSummaries', [null]), /invalid repository summary batch/);
  console.log('ok: scoped summary batches query explicit targets only, enforce two-repo bound and reject cross-workspace reads');
  // A cached result or another open workspace does not authorize this request.
  assert.equal((await invoke(two, 'status', b)).branch, 'main');
  for (const method of ['status', 'log', 'listBranches', 'stageAll', 'commit', 'checkout', 'worktreeAdd']) {
    await assert.rejects(invoke(one, method, b, method === 'commit' ? 'wrong scope' : { name: 'wrong', create: true, dirName: 'wrong' }), /未知仓库|Unknown repository/);
  }
  assert.equal(git(b, 'branch', '--show-current'), 'main');
  await assert.rejects(invokeIpcChannel('git:status', [b]), /未知仓库|Unknown repository/, 'legacy IPC binds the initiating active scope');
  for (const bad of [undefined, {}, { workspaceId: '', rootsRevision: 0 }, { workspaceId: 'missing', rootsRevision: 0 }, { workspaceId: 'one', rootsRevision: 10 }, { workspaceId: 'one', rootsRevision: -1 }]) {
    await assert.rejects(invoke(bad, 'status', a), /scope|workspace not found/);
  }
  for (const bad of ['invokeScoped', '__proto__', 'withWorkspace', 'listRepos']) await assert.rejects(invoke(one, bad), /invalid scoped Git operation/);
  console.log('ok: actual IPC scope validation, cached cross-workspace reads/writes rejected, explicit allowlist');

  fs.writeFileSync(path.join(b, 'same.txt'), 'scope two change\n');
  assert((await invoke(two, 'stage', b, ['same.txt'])).ok);
  assert((await invoke(two, 'commit', b, 'scope two commit')).ok);
  assert.equal(git(b, 'log', '-1', '--format=%s'), 'scope two commit');
  assert.equal(git(a, 'log', '-1', '--format=%s'), 'fixture');
  assert((await invoke(two, 'checkout', b, { name: 'scope-two-branch', create: true })).ok);
  const results = await Promise.all([invoke(one, 'workspaceRoot'), invoke(two, 'workspaceRoot')]);
  assert.deepEqual(results, [{ path: a, workspaceId: 'one' }, { path: b, workspaceId: 'two' }]);
  console.log('ok: non-active workspace staging, commit, branch creation and concurrent owners');

  const empty = path.join(fixture, 'empty-default'); fs.mkdirSync(empty);
  config = { ...config, workspaces: [...config.workspaces, workspace('init-owner', empty)] };
  assert((await invoke({ workspaceId: 'init-owner', rootsRevision: 0 }, 'initRepo')).ok);
  assert(fs.existsSync(path.join(empty, '.git')), 'implicit init cwd comes from the requested workspace');
  assert.equal(git(a, 'log', '-1', '--format=%s'), 'fixture');

  const emptyScope = { workspaceId: 'init-owner', rootsRevision: 0 };
  git(empty, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const emptyPage = { commits: [], branchHeads: [], hasMore: false };
  assert.deepEqual(await invoke(emptyScope, 'log', empty, 0, 80, 'HEAD'), emptyPage);
  assert.deepEqual(await invoke(emptyScope, 'log', empty, 0, 80, '--all'), emptyPage);
  await assert.rejects(invoke(emptyScope, 'log', empty, 0, 80, 'missing-history-ref'), /missing-history-ref/);

  // Commit history only needs refs. A broken index must not turn an unborn HEAD into a log failure.
  const indexPath = path.join(empty, '.git', 'index');
  const historyTrace = path.join(fixture, 'empty-history.trace.jsonl');
  fs.writeFileSync(indexPath, 'broken index\n');
  process.env.GIT_TRACE2_EVENT = historyTrace;
  try {
    assert.deepEqual(await invoke(emptyScope, 'log', empty, 0, 80, 'HEAD'), emptyPage);
    const events = fs.readFileSync(historyTrace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(!events.some(event => event.event === 'cmd_name' && event.name === 'log'), 'unborn HEAD should skip git log');
    assert(!events.some(event => event.event === 'exit' && event.code !== 0), 'empty history should require only successful Git commands');
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
    fs.unlinkSync(indexPath);
  }

  const headRef = path.join(empty, '.git', 'refs', 'heads', 'main');
  fs.writeFileSync(headRef, 'broken\n');
  await assert.rejects(invoke(emptyScope, 'log', empty, 0, 80, 'HEAD'));
  fs.writeFileSync(headRef, 'f'.repeat(git(a, 'rev-parse', 'HEAD').length) + '\n');
  await assert.rejects(invoke(emptyScope, 'log', empty, 0, 80, 'HEAD'), /bad object|cannot read/i);
  fs.unlinkSync(headRef);

  fs.writeFileSync(path.join(empty, 'first.txt'), 'first\n');
  assert((await invoke(emptyScope, 'stageAll', empty)).ok);
  assert.deepEqual(await invoke(emptyScope, 'log', empty), emptyPage);
  git(empty, 'config', 'user.name', 'Scope fixture');
  git(empty, 'config', 'user.email', 'scope@example.invalid');
  assert((await invoke(emptyScope, 'commit', empty, 'first commit')).ok);
  const firstPage = await invoke(emptyScope, 'log', empty, 0, 80, 'HEAD');
  assert.deepEqual(firstPage.commits.map(({ commit }) => commit.message), ['first commit']);
  assert.deepEqual(firstPage.branchHeads.map(({ name }) => name), ['main']);
  assert.equal(firstPage.hasMore, false);

  git(empty, 'symbolic-ref', 'HEAD', 'refs/heads/orphan');
  assert.deepEqual(await invoke(emptyScope, 'log', empty, 0, 80, 'HEAD'), {
    ...firstPage, commits: []
  });
  assert.deepEqual(await invoke(emptyScope, 'log', empty, 0, 80, '--all'), firstPage);
  git(empty, 'checkout', '-q', '--detach', 'main');
  assert.deepEqual((await invoke(emptyScope, 'log', empty)).commits, firstPage.commits);
  assert.deepEqual((await invoke(emptyScope, 'log', empty, 1)).commits, []);

  config = { ...config, workspaces: config.workspaces.filter(w => w.id !== 'init-owner') };
  console.log('ok: scoped init, empty history before first commit, and errors for invalid or broken refs');

  // Revocation between checkout status and checkout must stop before mutation.
  await invoke(one, 'status', a);
  const client = service.clients.get(service.key(a));
  const originalStatus = client.status.bind(client);
  const ready = deferred(), release = deferred();
  client.status = async () => { const result = await originalStatus(); ready.resolve(); await release.promise; return result; };
  const stale = invoke(one, 'checkout', a, { name: 'stale-branch', create: true });
  await ready.promise; changeRevision(); release.resolve();
  await assert.rejects(stale, /scope changed/);
  assert.equal(git(a, 'branch', '--show-current'), 'main');
  assert.equal(git(a, 'branch', '--list', 'stale-branch'), '');
  client.status = originalStatus;
  // Active UI workspace is now two; the stale scope one must not operate.
  config = { ...config, activeWorkspaceId: 'two', workspace: b };
  const current = service.currentOperationScope();
  assert.deepEqual(current, two);
  await assert.rejects(invoke(one, 'stageAll', a), /scope changed/);
  console.log('ok: root revision changes during multi-step checkout prevent branch mutation');

  const currentOne = { workspaceId: 'one', rootsRevision: 1 };
  service.invalidateSummary(a);
  await invoke(currentOne, 'status', a);
  service.invalidateSummary(a);
  const currentClient = service.clients.get(service.key(a));
  const currentStatus = currentClient.status.bind(currentClient);
  const readReady = deferred(), readRelease = deferred();
  currentClient.status = async () => { const result = await currentStatus(); readReady.resolve(); await readRelease.promise; return result; };
  const oldRead = invoke(currentOne, 'status', a);
  await readReady.promise; changeRevision(); readRelease.resolve();
  await assert.rejects(oldRead, /scope changed/, 'in-flight status must not return under a removed revision');
  currentClient.status = currentStatus;
  const newestOne = { workspaceId: 'one', rootsRevision: 2 };
  const tree = await invoke(newestOne, 'worktreeAdd', a, { dirName: 'scope-linked', newBranch: 'ao/scoped', baseRef: 'main' });
  assert(tree.ok, tree.message);
  assert.equal((await invoke(newestOne, 'status', tree.path)).branch, 'ao/scoped');
  await assert.rejects(invoke(two, 'status', tree.path), /未知仓库|Unknown repository/);
  fs.writeFileSync(path.join(tree.path, 'same.txt'), 'scoped linked change\n');
  const preview = await invoke(newestOne, 'adoptPreview', tree.path);
  assert(preview.ok, preview.message);
  const keys = parseUnifiedDiff(preview.diff).flatMap(file => file.hunks.map(hunk => ({ ...hunk.key, file: file.path })));
  const originalAllowed = service.assertAllowed.bind(service);
  service.assertAllowed = async (repo) => {
    // The actual production adopter must consult permission after --check.
    if (repo === a) changeRevision();
    return originalAllowed(repo);
  };
  await assert.rejects(invoke(newestOne, 'adoptHunks', tree.path, keys), /scope changed/);
  service.assertAllowed = originalAllowed;
  assert.equal(fs.readFileSync(path.join(a, 'same.txt'), 'utf8').trim(), 'a', 'revoked adopt must not write the main tree');
  assert.equal(git(a, 'diff', '--cached', '--name-only'), '');
  const cleanupScope = { workspaceId: 'one', rootsRevision: 3 };
  const adopted = await invoke(cleanupScope, 'adoptHunks', tree.path, keys);
  assert(adopted.ok, adopted.message);
  assert.equal(fs.readFileSync(path.join(a, 'same.txt'), 'utf8').trim(), 'scoped linked change');
  git(a, 'reset', '--hard', 'HEAD'); git(tree.path, 'reset', '--hard', 'HEAD');

  // Agent PR creation resolves the linked checkout and pushes the approved SHA
  // even if the branch ref advances in the window just before Git runs.
  const nested = path.join(tree.path, 'src'); fs.mkdirSync(nested);
  assert.equal(await service.withWorkspace(cleanupScope, () => service.checkoutForCwd(nested)), tree.path);
  await assert.rejects(service.withWorkspace(two, () => service.checkoutForCwd(nested)), /未知仓库|Unknown repository/);
  const remote = path.join(fixture, 'review-remote.git');
  git(a, 'init', '--bare', remote);
  git(a, 'remote', 'add', 'origin', remote);
  const pushUrl = git(tree.path, 'remote', 'get-url', '--push', 'origin');
  const head = git(tree.path, 'rev-parse', 'HEAD');
  const pushApproved = beforePush => service.withWorkspace(cleanupScope, () =>
    service.pushBranch(tree.path, 'ao/scoped', { pushUrl, head, beforePush }));
  assert.equal((await pushApproved(() => { throw new Error('cancelled'); })).ok, false);
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)'), '');
  const pushed = await pushApproved(() => git(tree.path, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'unapproved'));
  assert(pushed.ok, pushed.message);
  assert.notEqual(git(tree.path, 'rev-parse', 'HEAD'), head);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/ao/scoped'), head);
  git(tree.path, 'reset', '--hard', head);

  assert((await invoke(cleanupScope, 'worktreeRemove', tree.path)).ok);
  git(a, 'branch', '-d', 'ao/scoped');
  console.log('ok: stale status rejection, linked worktree scope, adopt preview and scoped cleanup');
} finally {
  const target = path.resolve(fixture);
  assert(target.startsWith(path.resolve(project, '.tmp') + path.sep));
  fs.rmSync(target, { recursive: true, force: true });
}
