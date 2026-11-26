import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd();
// Keep Git metadata short even when the checkout itself is a long managed path.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'worktree-management-'));
fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const config = path.join(root, 'empty.gitconfig');
fs.writeFileSync(config, '');
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const compile = createSharedCompiler(project, path.join(root, 'compiled'));
const { GitService } = await import(pathToFileURL(compile('main/git/service.ts')).href);
const { discoverNestedReposDetailed } = await import(pathToFileURL(compile('main/git/nestedRepos.ts')).href);
const { cleanupSessionWorktreeOnArchive } = await import(pathToFileURL(compile('main/git/worktreeSessionOps.ts')).href);
const { findGitRoots } = await import(pathToFileURL(compile('main/git/scan.ts')).href);
const { resolveRepoIdentity } = await import(pathToFileURL(compile('main/git/repoIdentity.ts')).href);
const reports = [];
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function init(dir, name = 'a.txt') {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Worktree review');
  git(dir, 'config', 'user.email', 'review@example.invalid');
  fs.writeFileSync(path.join(dir, name), 'base\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return dir;
}
function service(workspace) {
  return new GitService({ get: () => ({ workspace, worktreeStorageRoot: path.join(root, 'managed'), activeWorkspaceId: 'review', workspaces: [{ id: 'review', path: workspace }] }) });
}
function ctx(svc, session) {
  return { git: svc, config: { get: () => ({}) }, notify: { push: (n) => reports.push({ notification: n.text }) },
    workspaceIdFor: () => 'review', resolveWorkspaceId: () => 'review', persist() {}, broadcast() {}, findSession: () => session };
}
function report(value) { reports.push(value); console.log('ok:', value.case); }

// Three repository levels: A -> Plugins/B -> vendors/C.
{
  const main = init(path.join(root, 'deep'));
  init(path.join(main, 'Plugins', 'B'));
  init(path.join(main, 'Plugins', 'B', 'vendors', 'C'));
  const svc = service(main);
  const discovered = await discoverNestedReposDetailed(main);
  const built = await svc.addSessionWorktreeGroup(main, '10000001-aaaa-bbbb-cccc-000000000001');
  assert.equal(built.ok, true, built.message);
  const cExists = fs.existsSync(path.join(built.path, 'Plugins', 'B', 'vendors', 'C', 'a.txt'));
  assert.equal(cExists, true);
  const uiRoots = (await findGitRoots(main)).map(p => path.relative(main, p));
  report({ case: 'deep-nested-repository-omitted', discovered, group: built.repos, cExists, uiRoots });
}

// Child repo worktree is placed beside the child, under the parent workspace.
{
  const outer = init(path.join(root, 'outer'));
  const child = init(path.join(outer, 'Plugins', 'B'));
  init(path.join(child, 'vendors', 'C'));
  const svc = service(outer);
  const built = await svc.addSessionWorktreeGroup(child, '10000002-aaaa-bbbb-cccc-000000000002');
  assert.equal(built.ok, true, built.message);
  const resolved = await svc.resolveMainRepoFor(built.path);
  const common = git(built.path, 'rev-parse', '--git-common-dir');
  assert.equal(resolved, child);
  report({ case: 'child-worktree-resolves-to-wrong-repository', child, worktree: built.path, resolved, common });
}

// Folder workspace has no root Git repo: lifecycle loses the child repo identity.
{
  const workspace = path.join(root, 'folder-workspace');
  const main = init(path.join(workspace, 'A'));
  init(path.join(main, 'Plugins', 'B'));
  const svc = service(workspace);
  const built = await svc.addSessionWorktreeGroup(main, '10000003-aaaa-bbbb-cccc-000000000003');
  assert.equal(built.ok, true, built.message);
  const dirtyFile = path.join(built.path, 'Plugins', 'B', 'a.txt');
  fs.writeFileSync(dirtyFile, 'uncommitted task work\n');
  const before = git(path.dirname(dirtyFile), 'status', '--porcelain');
  const resolved = await svc.resolveMainRepoFor(built.path);
  const session = { id: 'review', name: 'Review fixture', worktreePath: built.path, worktreeBranch: built.branch, worktreeBaseBranch: built.baseBranch, worktreeRepoSet: built.repos };
  await cleanupSessionWorktreeOnArchive(ctx(svc, session), session);
  assert.equal(resolved, main);
  assert.equal(fs.existsSync(dirtyFile), true);
  assert.equal(fs.existsSync(built.path), true);
  report({ case: 'folder-workspace-archive-dirty-child', resolved, dirtyBefore: before,
    dirtyFileSurvives: fs.existsSync(dirtyFile), containerSurvives: fs.existsSync(built.path), session });
}

// Provision sees incomplete container, before nested worktrees have been created.
{
  const main = init(path.join(root, 'provision'));
  init(path.join(main, 'Plugins', 'A'));
  const svc = service(main);
  const command = `node -e "require('node:fs').writeFileSync('provision-observed.json',JSON.stringify({hasPlugin:require('node:fs').existsSync('Plugins/A/a.txt')}))"`;
  const built = await svc.addSessionWorktreeGroup(main, '10000004-aaaa-bbbb-cccc-000000000004', undefined, [command]);
  assert.equal(built.ok, true, built.message);
  const observation = JSON.parse(fs.readFileSync(path.join(built.path, 'provision-observed.json'), 'utf8'));
  assert.equal(observation.hasPlugin, true);
  report({ case: 'provision-before-plugins', observation, afterCreationHasPlugin: fs.existsSync(path.join(built.path, 'Plugins', 'A', 'a.txt')) });
}
// A real submodule must respect the gitlink commit selected by its superproject.
{
  const library = init(path.join(root, 'submodule-library'));
  const pinned = git(library, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(library, 'a.txt'), 'new library version\n');
  git(library, 'add', '.');
  git(library, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'new library version');
  const main = init(path.join(root, 'submodule-parent'));
  git(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'vendor');
  git(path.join(main, 'vendor'), 'checkout', '--detach', pinned);
  git(main, 'add', '.');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'pin submodule');
  const svc = service(main);
  const built = await svc.addSessionWorktreeGroup(main, '10000005-aaaa-bbbb-cccc-000000000005');
  assert.equal(built.ok, true, built.message);
  const actual = git(path.join(built.path, 'vendor'), 'rev-parse', 'HEAD');
  assert.equal(actual, pinned);
  assert.equal(git(built.path, 'status', '--porcelain'), '');
  const taskFile = path.join(built.path, 'vendor', 'new-task-file.txt');
  fs.writeFileSync(taskFile, 'submodule diff\n');
  const preview = await svc.adoptPreview(path.join(built.path, 'vendor'));
  assert.equal(preview.ok, true, preview.message);
  assert.equal(path.resolve(preview.targetRepo), path.join(main, 'vendor'));
  fs.unlinkSync(taskFile);
  const session = { id: 'submodule', name: 'Submodule', worktreePath: built.path, worktreeBranch: built.branch, worktreeBaseBranch: built.baseBranch, worktreeRepoSet: built.repos };
  await cleanupSessionWorktreeOnArchive(ctx(svc, session), session);
  assert.equal(fs.existsSync(built.path), false, 'Clean submodule group must archive successfully');
  report({ case: 'submodule-starts-from-default-instead-of-gitlink', pinned, actual, group: built.repos, archived: !fs.existsSync(built.path) });
}

// A selected grandchild includes its ancestors; clean groups remove deepest first.
{
  const main = init(path.join(root, 'cleanup-deep'));
  init(path.join(main, 'B')); init(path.join(main, 'B', 'C'));
  const svc = service(main);
  const built = await svc.addSessionWorktreeGroup(main, '20000001-test', ['B/C']);
  assert.equal(built.ok, true, built.message);
  assert.deepEqual(built.repos.map(r => r.path), ['B', 'B/C']);
  const s = { id: 'deep', name: 'Deep', worktreePath: built.path, worktreeBranch: built.branch,
    worktreeBaseBranch: built.baseBranch, worktreeRepoSet: built.repos, worktreeSource: built.source };
  fs.writeFileSync(path.join(built.path, 'a.txt'), 'dirty root');
  await cleanupSessionWorktreeOnArchive(ctx(svc, s), s);
  assert.equal(fs.existsSync(path.join(built.path, 'B/C/.git')), true, 'Preflight root before deleting children');
  git(built.path, 'restore', 'a.txt');
  await cleanupSessionWorktreeOnArchive(ctx(svc, s), s);
  assert.equal(fs.existsSync(built.path), false);
  for (const rel of ['', 'B', 'B/C']) assert.equal(git(path.join(main, rel), 'worktree', 'list', '--porcelain').includes(built.branch), false);
  console.log('ok: deep selection, root preflight, deepest-first cleanup');
}

// Existing in-project worktrees still resolve through their gitfile and remain explicitly selectable.
{
  const main = init(path.join(root, 'legacy'));
  const legacy = path.join(main, '.worktrees', 'old');
  git(main, 'worktree', 'add', '-b', 'ao/old', legacy);
  const svc = service(main);
  const { ensureWorktreesExclude, ensureGitDirectoryExcludes } = await import(pathToFileURL(compile('main/git/worktree.ts')).href);
  ensureWorktreesExclude(legacy);
  ensureGitDirectoryExcludes(legacy, ['generated']);
  assert.match(fs.readFileSync(path.join(main, '.git/info/exclude'), 'utf8'), /\/generated\//);
  assert.equal(await svc.resolveMainRepoFor(legacy), main);
  assert.equal((await svc.listRepos(true)).some(r => r.path === legacy), false);
  const explicit = await svc.listRepos(false, [legacy]);
  assert.equal(explicit.find(r => r.path === legacy)?.worktree, true);
  git(legacy, 'checkout', '-b', 'ao/renamed');
  assert.equal((await svc.listRepos(false, [legacy])).find(r => r.path === legacy)?.branch, 'ao/renamed');
  git(legacy, 'checkout', 'ao/old');
  const s = { id: 'old', name: 'Old', worktreePath: legacy, worktreeBranch: 'ao/old', worktreeBaseBranch: 'main' };
  await cleanupSessionWorktreeOnArchive(ctx(svc, s), s);
  assert.equal(fs.existsSync(legacy), false);
  console.log('ok: legacy path, common-dir excludes, explicit Git access, cleanup');
}

// Broken identity must preserve the whole group, even if the parent itself looks clean.
{
  const main = init(path.join(root, 'broken-identity')); init(path.join(main, 'B'));
  const svc = service(main);
  const built = await svc.addSessionWorktreeGroup(main, '20000002-test');
  assert.equal(built.ok, true, built.message);
  const file = path.join(built.path, 'B', '.git');
  const saved = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, 'gitdir: missing-directory\n', { flag: 'r+' }); fs.truncateSync(file, Buffer.byteLength('gitdir: missing-directory\n'));
  const s = { id: 'broken', name: 'Broken', worktreePath: built.path, worktreeBranch: built.branch,
    worktreeBaseBranch: built.baseBranch, worktreeRepoSet: built.repos };
  await cleanupSessionWorktreeOnArchive(ctx(svc, s), s);
  assert.equal(fs.existsSync(path.join(built.path, 'B/a.txt')), true);
  assert.equal(s.meta.orphanWorktree, 'locked');
  fs.writeFileSync(file, saved, { flag: 'r+' }); fs.truncateSync(file, Buffer.byteLength(saved));
  s.worktreeSource = { mainRepo: main, commonDir: path.join(root, 'wrong-source') };
  await cleanupSessionWorktreeOnArchive(ctx(svc, s), s);
  assert.equal(fs.existsSync(built.path), true);
  console.log('ok: broken child and replaced source preserve group');
}

// A registered second source and separated Git metadata need no workspace ancestor.
{
  const main = init(path.join(root, 'extra'));
  const workspace = init(path.join(root, 'other-workspace'));
  const storage = path.join(root, 'custom-storage');
  let config = { workspace, activeWorkspaceId: 'ws', worktreeStorageRoot: storage,
    workspaces: [{ id: 'ws', path: workspace, defaultRootId: 'workspace', controlRoot: workspace,
      roots: [{ id: 'workspace', path: workspace }], rootsRevision: 0 }] };
  const svc = new GitService({ get: () => config });
  await assert.rejects(svc.addSessionWorktreeGroup(main, '20000003-test'), /未知仓库|Unknown repository/);
  config = { ...config, workspaces: [{ ...config.workspaces[0], rootsRevision: 1,
    roots: [...config.workspaces[0].roots, { id: 'extra', path: main }] }] };
  const built = await svc.addSessionWorktreeGroup(main, '20000003-test');
  assert.equal(built.ok, true, built.message);
  assert.equal(built.path.startsWith(storage + path.sep), true);
  assert.equal(await svc.resolveMainRepoFor(built.path), main);
  assert.equal((await svc.listRepos(false, [built.path])).find(r => r.path === built.path)?.worktree, true);
  git(main, 'init', '--separate-git-dir', path.join(root, 'extra-git-data'));
  // Moving the common dir requires Git's own repair before linked worktrees can be used again.
  git(main, 'worktree', 'repair');
  assert.equal(await resolveRepoIdentity(built.path), null, 'unknown separated metadata must not guess a source');
  assert.equal((await resolveRepoIdentity(built.path, [main]))?.mainRepo, main);
  const ambiguous = path.join(root, 'ambiguous-source'); fs.mkdirSync(ambiguous);
  fs.writeFileSync(path.join(ambiguous, '.git'), `gitdir: ${path.join(root, 'extra-git-data')}\n`);
  assert.equal(await resolveRepoIdentity(built.path, [main, ambiguous]), null, 'two distinct known sources cannot choose the first');
  assert.equal(await svc.resolveMainRepoFor(built.path), main);
  fs.writeFileSync(path.join(built.path, 'a.txt'), 'separate metadata diff\n');
  const preview = await svc.adoptPreview(built.path);
  assert.equal(preview.ok, true, preview.message);
  assert.equal(path.resolve(preview.targetRepo), main);
  console.log('ok: custom storage, extra repository, separate git directory');
}

{
  const main = init(path.join(root, 'provision-fails'));
  const built = await service(main).addSessionWorktreeGroup(main, '20000004-test', undefined, ['node -e "process.exit(2)"']);
  assert.equal(built.ok, true);
  assert.match(built.message, /provision.*失败/);
  assert.equal(fs.existsSync(built.path), true);
  console.log('ok: provisioning failure retains tree and returns warning');
}
console.log('Worktree management regressions passed');

// Git's registration lock is a reproducible removal failure; it must preserve the container.
{
  const main = init(path.join(root, 'locked-child')); init(path.join(main, 'B'));
  const svc = service(main);
  const built = await svc.addSessionWorktreeGroup(main, '20000006-test');
  assert.equal(built.ok, true, built.message);
  const child = path.join(built.path, 'B');
  git(path.join(main, 'B'), 'worktree', 'lock', child);
  const s = { id: 'locked', name: 'Locked', worktreePath: built.path, worktreeBranch: built.branch,
    worktreeBaseBranch: built.baseBranch, worktreeRepoSet: built.repos };
  await cleanupSessionWorktreeOnArchive(ctx(svc, s), s);
  assert.equal(fs.existsSync(path.join(child, 'a.txt')), true);
  assert.equal(s.meta.orphanWorktree, 'locked');
  git(path.join(main, 'B'), 'worktree', 'unlock', child);
  await cleanupSessionWorktreeOnArchive(ctx(svc, s), s);
  assert.equal(fs.existsSync(built.path), false);
  console.log('ok: locked child preserves container and retries after unlock');
}

// The host's existing fallback snapshot must include ignored nested repositories.
{
  const main = init(path.join(root, 'worker-group')); init(path.join(main, 'B')); init(path.join(main, 'B/C'));
  const svc = service(main);
  const built = await svc.addSessionWorktreeGroup(main, '20000005-test');
  assert.equal(built.ok, true, built.message);
  fs.writeFileSync(path.join(built.path, 'B/C/a.txt'), 'nested worker change\n');
  const { beforeRequestIntegrate } = await import(pathToFileURL(compile('main/agentSession/workerTreeGuard.ts')).href);
  const session = { worktreePath: built.path, worktreeRepoSet: built.repos };
  const guarded = await beforeRequestIntegrate({ sessions: { get: () => session } }, 'worker');
  assert.equal(guarded.fallbackCommit, true);
  assert.equal(git(path.join(built.path, 'B/C'), 'status', '--porcelain'), '');
  assert.match(git(path.join(built.path, 'B/C'), 'log', '-1', '--format=%B'), /\[host\]/);
  console.log('ok: nested Worker fallback commit');
}
fs.rmSync(root, { recursive: true, force: true });
