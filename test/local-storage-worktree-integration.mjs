/** Real Git and SessionsService: stale storage entries are reviewable without losing branch ownership. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-storage-worktree-')));
const originalLoad = Module._load;
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: (name) => name === 'userData' ? path.join(fixture, 'userdata') : fixture, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const { SessionsService } = require(path.join(project, 'src/main/sessions.ts'));
  const { StorageInventory } = require(path.join(project, 'src/main/storage/inventory.ts'));
  const { Store } = require(path.join(project, 'src/main/store.ts'));
  const { SessionPersister } = require(path.join(project, 'src/main/sessions/persister.ts'));
  const { normalizeSessionWorktrees } = require(path.join(project, 'src/shared/sessionWorktrees.ts'));
  const repo = path.join(fixture, 'repo'), userData = path.join(fixture, 'userdata');
  fs.mkdirSync(repo); fs.mkdirSync(userData);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.hooksPath', path.join(fixture, 'no-hooks'));
  fs.writeFileSync(path.join(repo, 'source.txt'), 'source'); git(repo, 'add', '.'); git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const initialHead = git(repo, 'rev-parse', 'HEAD');
  const workspace = { id: 'ws', path: repo, controlRoot: repo, defaultRootId: 'root', rootsRevision: 1, roots: [{ id: 'root', path: repo }] };
  let workspaces = [], closedWorkspaces = [workspace];
  const config = { get: () => ({ activeWorkspaceId: workspaces[0]?.id, workspaces, closedWorkspaces }) };
  const service = Object.create(SessionsService.prototype), released = [];
  const store = new Store();
  Object.assign(service, { config, sessions: [], git: { invalidateRepoCaches() {} }, notify: { push() {} },
    workspaceIdFor: () => 'ws', resolveWorkspaceId: () => 'ws', persist() {}, flushPersist() {}, broadcast() {},
    persister: new SessionPersister(store, () => service.sessions), rememberEnded() {}, finishDeletedSession() {},
    launchTasks: new Map(), launchGen: new Map(), classifyBySession: new Map(), ptyMgr: { killAndWait: async id => { released.push(id); }, isRunning: () => false }, isChatRuntime: () => false, applyLifecycle() {} });
  const inventory = new StorageInventory({ userData, workspaces: () => [{ id: 'ws', name: 'Workspace' }], sessions: () => structuredClone(service.sessions),
    themes: () => [], extensions: () => [], apps: async () => { throw new Error('unused'); }, builtinAppIds: new Set(),
    removeSession: id => service.deleteLocalStorageSession(id),
    preflightWorktree: (id, refs, discard) => service.preflightLocalStorageWorktree(id, refs, discard),
    cleanupWorktree: (id, discard) => service.cleanupArchivedWorktree(id, { discard }), removeTheme: () => ({ ok: false }),
    clearAttachments() {}, removeHandover: async () => {}, uninstallApp: async () => {} });
  function owner(name, tree, branch) {
    const root = { rootId: 'root', path: repo, cwd: repo };
    const session = { id: name, name, type: 'terminal', workspaceId: 'ws', archived: true, status: 'exited', cwd: repo, sourceRoot: root,
      worktreeGroups: { version: 1, cwdPolicy: 'source', primaryGroupId: 'root', groups: [{ id: 'root', path: tree, sourceRoot: root, source: { mainRepo: repo, commonDir: path.join(repo, '.git') }, branch, baseBranch: 'main', repos: [] }] } };
    normalizeSessionWorktrees(session); return session;
  }

  const cleanTree = path.join(fixture, 'removed-clean');
  git(repo, 'worktree', 'add', '-q', '-b', 'ao/removed-clean', cleanTree, 'main');
  git(repo, 'worktree', 'remove', cleanTree); git(repo, 'branch', '-d', 'ao/removed-clean');
  const cleanOwner = owner('clean-owner', cleanTree, 'ao/removed-clean');
  cleanOwner.retainedWorktreeOnly = true; service.sessions = [cleanOwner];
  const first = await inventory.scan(), clean = first.items.find(item => item.category === 'worktrees');
  assert.equal(clean.action, 'worktree'); assert.equal(clean.pathStatuses[0].status, 'missing');
  const cleanResult = (await inventory.clean(first.id, [{ id: clean.id }]))[0];
  assert.equal(cleanResult.status, 'completed', JSON.stringify(cleanResult));
  assert.equal(cleanOwner.worktreeGroups, undefined, 'only the verified stale session mapping is removed');
  assert.equal(service.sessions.length, 0); assert.equal(git(repo, 'rev-parse', 'HEAD'), initialHead);
  workspaces = [workspace]; closedWorkspaces = [];

  const unmergedTree = path.join(fixture, 'removed-unmerged');
  git(repo, 'worktree', 'add', '-q', '-b', 'ao/unmerged', unmergedTree, 'main');
  fs.writeFileSync(path.join(unmergedTree, 'unfinished.txt'), 'unmerged work');
  git(unmergedTree, 'add', '.'); git(unmergedTree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unmerged');
  const unmergedHead = git(unmergedTree, 'rev-parse', 'HEAD'); git(repo, 'worktree', 'remove', unmergedTree);
  const unmergedOwner = owner('unmerged-owner', unmergedTree, 'ao/unmerged'); service.sessions = [unmergedOwner];
  const second = await inventory.scan(), unmerged = second.items.find(item => item.category === 'worktrees');
  assert.equal(unmerged.action, 'worktree');
  const unmergedSession = second.items.find(item => item.action === 'session');
  const failed = await inventory.clean(second.id, [{ id: unmerged.id }, { id: unmergedSession.id }]);
  assert.deepEqual(failed.map(item => item.status), ['failed', 'failed']);
  assert.ok(failed[0].error.includes(unmergedTree), failed[0].error);
  assert.ok(service.sessions.includes(unmergedOwner), 'Git preflight runs before irreversible conversation deletion');
  assert.ok(unmergedOwner.worktreeGroups, 'unverified branch ownership retains the session mapping');
  assert.equal(git(repo, 'rev-parse', 'ao/unmerged'), unmergedHead, 'unmerged task commits survive');

  const sharedTree = path.join(fixture, 'shared-tree'), sharedBranch = 'ao/shared-tree';
  git(repo, 'worktree', 'add', '-q', '-b', sharedBranch, sharedTree, 'main');
  fs.writeFileSync(path.join(sharedTree, 'unfinished.txt'), 'unmerged work');
  git(sharedTree, 'add', '.'); git(sharedTree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unmerged');
  fs.writeFileSync(path.join(sharedTree, 'scratch.txt'), 'uncommitted work');
  const sharedOwner = owner('shared-owner', sharedTree, sharedBranch);
  const sharingChat = { id: 'sharing-chat', name: 'Sharing chat', type: 'terminal', workspaceId: 'ws', cwd: sharedTree, status: 'running' };
  service.sessions = [sharedOwner, sharingChat];
  const selectionFor = snapshot => snapshot.items.filter(item => item.action === 'session' || item.action === 'worktree')
    .map(item => ({ id: item.id, ...(item.action === 'worktree' ? { discardWorktree: true } : {}) }));
  const shared = await inventory.scan(), selected = selectionFor(shared);
  assert.equal(selected.length, 3);
  await assert.rejects(inventory.clean(shared.id, selected.filter(item => item.discardWorktree)), /缺少必删项目/);
  const normal = await inventory.clean(shared.id, selected.map(({ id }) => ({ id })));
  assert.deepEqual(normal.map(item => item.status), ['failed', 'failed', 'failed']);
  assert.deepEqual(service.sessions, [sharedOwner, sharingChat]);
  assert.ok(fs.existsSync(path.join(sharedTree, 'scratch.txt')));
  workspaces.push({ id: 'nested-workspace', path: sharedTree, controlRoot: sharedTree });
  const stillInUse = await inventory.scan();
  const blocked = await inventory.clean(stillInUse.id, selectionFor(stillInUse));
  assert.ok(blocked.every(item => item.status === 'failed' && item.error.includes('工作区文件夹')));
  assert.deepEqual(service.sessions, [sharedOwner, sharingChat]);
  workspaces.pop();
  const confirmed = await inventory.scan();
  const cleaned = await inventory.clean(confirmed.id, selectionFor(confirmed));
  assert.deepEqual(cleaned.map(item => item.status), ['started', 'started', 'completed'], JSON.stringify(cleaned));
  assert.ok(released.includes(sharedOwner.id) && released.includes(sharingChat.id));
  assert.equal(service.sessions.length, 0);
  assert.deepEqual(store.loadSessions(), []);
  assert.equal(fs.existsSync(sharedTree), false);
  assert.equal(git(repo, 'branch', '--list', sharedBranch), '');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), initialHead);
  assert.equal(fs.readFileSync(path.join(repo, 'source.txt'), 'utf8'), 'source');

  const residue = path.join(fixture, 'residue-tree'), residueBranch = 'ao/residue-tree';
  git(repo, 'worktree', 'add', '-q', '-b', residueBranch, residue, 'main');
  const residueOwner = owner('residue-owner', residue, residueBranch);
  residueOwner.retainedWorktreeOnly = true; service.sessions = [residueOwner];
  const residueScan = await inventory.scan();
  const lstat = fs.lstatSync;
  fs.lstatSync = (file, options) => {
    if (file === residue && options?.throwIfNoEntry === false && !fs.existsSync(residue)) {
      fs.mkdirSync(residue); fs.writeFileSync(path.join(residue, 'leftover.txt'), 'residual file');
    }
    return lstat(file, options);
  };
  try {
    const [result] = await inventory.clean(residueScan.id, selectionFor(residueScan));
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.ok(result.error.includes('目录仍存在'));
  } finally { fs.lstatSync = lstat; }
  assert.equal(service.sessions[0], residueOwner);
  assert.equal(git(repo, 'rev-parse', residueBranch), initialHead);
  assert.ok(fs.existsSync(path.join(residue, 'leftover.txt')));
  console.log('local-storage-worktree-integration: stale receipt, Git preflight and confirmed shared-worktree cascade passed');
} finally {
  Module._load = originalLoad;
  const target = path.resolve(fixture), base = fs.realpathSync(os.tmpdir());
  assert.ok(target.startsWith(`${base}${path.sep}local-storage-worktree-`));
  fs.rmSync(target, { recursive: true, force: true });
}
