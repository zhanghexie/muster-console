/** Actual SessionsService close/archive/discard: release first, keep residual owner, flush before next write. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join(project, '.tmp'); fs.mkdirSync(temp, { recursive: true });
const fixture = fs.mkdtempSync(path.join(temp, 'session-task-worktree-cleanup-'));
require.extensions['.ts'] = (module, filename) => {
  let source = fs.readFileSync(filename, 'utf8');
  if (process.env.TEST_RESTORE_TASK_CLOSE === '1' && filename === path.join(project, 'src/main/sessions.ts')) {
    source = execFileSync('git', ['show', 'HEAD:src/main/sessions.ts'], { cwd: project, encoding: 'utf8' });
  }
  if (process.env.TEST_RESTORE_CLEANUP_FLUSH === '1' && filename.endsWith(`${path.sep}worktreeTaskCleanup.ts`)) {
    const changed = source.replaceAll('ctx.flushPersist?.();', '');
    assert.notEqual(changed, source, 'red proof must actually remove immediate result flushing'); source = changed;
  }
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText, filename);
};
const originalLoad = Module._load;
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => fixture, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const { SessionsService } = require(path.join(project, 'src/main/sessions.ts'));
const { GitService } = require(path.join(project, 'src/main/git/service.ts'));
const { normalizeSessionWorktrees } = require(path.join(project, 'src/shared/sessionWorktrees.ts'));
const { workspaceRootUsesFor } = require(path.join(project, 'src/main/workspaceRootUses.ts'));
const { integrateSessionWorktree } = require(path.join(project, 'src/main/git/worktreeIntegrate.ts'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let sequence = 0;
function setup(name) {
  const groups = ['a', 'b'].map(id => {
    const main = path.join(fixture, `${name}-${id}`), tree = path.join(fixture, `${name}-tree-${id}`);
    fs.mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid'); git(main, 'config', 'core.hooksPath', path.join(fixture, 'no-hooks'));
    fs.writeFileSync(path.join(main, 'same.txt'), 'base'); git(main, 'add', '.'); git(main, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
    git(main, 'worktree', 'add', '-q', '-b', 'ao/task', tree, 'main');
    return { id, path: tree, branch: 'ao/task', baseBranch: 'main', repos: [], sourceRoot: { rootId: id, path: main, cwd: main }, source: { mainRepo: main, commonDir: path.join(main, '.git') } };
  });
  const cfg = { activeWorkspaceId: name, workspaces: [{ id: name, path: groups[1].source.mainRepo, controlRoot: groups[0].source.mainRepo,
    defaultRootId: 'b', rootsRevision: 1, roots: groups.map(group => ({ id: group.id, path: group.source.mainRepo })) }] };
  const owner = { id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, name, type: 'terminal', runtime: 'pi', launchKind: 'agent', archived: true, cwd: groups[0].path,
    workspaceId: name, sourceRoot: groups[0].sourceRoot, worktreeGroups: { version: 1, primaryGroupId: 'a', groups } };
  normalizeSessionWorktrees(owner);
  const service = Object.create(SessionsService.prototype), events = [], disk = [], notices = [], persistenceErrors = [];
  Object.assign(service, { config: { get: () => cfg }, sessions: [owner], notify: { push: entry => notices.push(entry) }, activeId: owner.id,
    isChatRuntime: () => true, applySelectDisplay() {}, applyLifecycle() {}, workspaceIdFor: () => name, resolveWorkspaceId: () => name,
    get: id => service.sessions.find(row => row.id === id), rememberEnded: () => events.push('ended'), notifySessionRemoved() {},
    launchTasks: new Map(), launchGen: new Map(), classifyBySession: new Map(), ptyWorkingSince: new Map(), notifyBus: { clearSession() {} },
    awareness: null, usageStats: null, ptyMgr: { kill: () => events.push('kill'), isRunning: () => false },
    chatBridge: { async release() { events.push('release'); }, async close() { events.push('purge'); }, open() { events.push('open'); } },
    persister: { schedule() {}, flush: () => disk.push(structuredClone(service.sessions)),
      async flushStrict(validate, projectRows, commit) { validate(); disk.push(structuredClone(projectRows(service.sessions))); commit(); } },
    broadcast() {
      const row = service.sessions.find(row => row.id === owner.id), saved = disk.at(-1)?.find(row => row.id === owner.id);
      if (!row?.worktreeGroups) return;
      for (const group of row.worktreeGroups.groups) for (const entry of group.cleanup ?? []) {
        if (!entry.treeRemoved) continue;
        const recorded = saved?.worktreeGroups?.groups.find(g => g.id === group.id)?.cleanup?.find(e => e.repo === entry.repo);
        try { assert.equal(recorded?.treeRemoved, true, 'completed tree removal must be flushed before broadcast/another Git operation'); }
        catch (error) { persistenceErrors.push(error); throw error; }
      }
    }
  });
  service.git = new GitService(service.config);
  return { service, owner, groups, events, disk, notices, persistenceErrors };
}
async function until(task, predicate) {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (task.persistenceErrors.length) throw task.persistenceErrors[0];
    assert.ok(Date.now() < deadline, 'session cleanup did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
try {
  const automatic = setup('automatic');
  automatic.owner.archived = false;
  automatic.owner.cwd = automatic.owner.sourceRoot.cwd;
  automatic.owner.worktreeGroups.cwdPolicy = 'source';
  const integrateCtx = { ...automatic.service.worktreeCtx(), awareness: null, emitRuntimeFacts() {},
    setPhase() {}, setLiveStatus() {}, recordAcceptance() {},
    setArchived: (id, archived) => automatic.service.setArchived(id, archived),
    archiveReleaseThenCleanup: session => automatic.service.archiveReleaseThenCleanup(session) };
  const mergeResult = await integrateSessionWorktree(integrateCtx, automatic.owner.id, { skipNpmInstall: true, skipTypecheck: true });
  assert.equal(mergeResult.cleanup, 'scheduled');
  await until(automatic, () => automatic.owner.archived && !automatic.owner.worktreeGroups);
  assert.ok(automatic.groups.every(group => !fs.existsSync(group.path)), 'merge schedules actual archive and safe Git cleanup');

  const clean = setup('clean'); let releaseEngine;
  const gate = new Promise(resolve => { releaseEngine = resolve; });
  clean.service.chatBridge.release = async () => { clean.events.push('release'); await gate; };
  assert.doesNotThrow(() => clean.service.close(clean.owner.id));
  assert.equal(clean.service.sessions.length, 1, 'the real close entry retains its owner before releasing the GUI driver');
  assert.deepEqual(workspaceRootUsesFor(clean.service.config).list('clean').map(use => use.rootId).sort(), ['a', 'b']);
  await clean.service.select(clean.owner.id);
  assert.equal(clean.owner.archived, true);
  assert.equal(clean.events.includes('open'), false, 'opening history during cleanup must not restart the runtime');
  await assert.rejects(clean.service.createTerminal({ sourceSessionId: clean.owner.id, cwd: clean.groups[1].path, workspaceId: 'clean' }), /cleanup already running/);
  assert.throws(() => clean.service.setArchived(clean.owner.id, false), /cleanup already running/);
  assert.ok(clean.groups.every(group => fs.existsSync(group.path)));
  releaseEngine(); await until(clean, () => clean.service.sessions.length === 0);
  assert.ok(clean.groups.every(group => !fs.existsSync(group.path)));
  assert.ok(clean.events.indexOf('release') < clean.events.indexOf('ended')); assert.equal(clean.events.filter(e => e === 'purge').length, 1);
  assert.equal(clean.persistenceErrors.length, 0);

  const dirty = setup('dirty'); dirty.owner.hidden = true;
  fs.writeFileSync(path.join(dirty.groups[1].path, 'user.txt'), 'must survive close');
  await assert.rejects(dirty.service.deletePermanently([dirty.owner.id], 'human'), /未提交改动/);
  assert.equal(dirty.service.sessions[0], dirty.owner); assert.equal(dirty.owner.archived, true); assert.equal(dirty.owner.hidden, undefined);
  assert.equal(dirty.owner.meta.orphanWorktree, 'dirty'); assert.equal(dirty.events.includes('purge'), false, 'retained ownership also retains conversation history');
  assert.equal(dirty.disk.at(-1)[0].worktreeGroups.groups.length, 2, 'restart has both completed and retained groups');
  assert.equal(fs.readFileSync(path.join(dirty.groups[1].path, 'user.txt'), 'utf8'), 'must survive close');
  await dirty.service.select(dirty.owner.id);
  assert.equal(dirty.events.includes('open'), false, 'history stays readable after partial cleanup');
  await assert.rejects(dirty.service.continueArchived(dirty.owner.id), /不完整/);
  assert.equal(dirty.owner.archived, true, 'failed continuation cannot unarchive an incomplete owner');
  fs.unlinkSync(path.join(dirty.groups[1].path, 'user.txt'));
  dirty.service.close(dirty.owner.id); await until(dirty, () => dirty.service.sessions.length === 0);

  const retained = setup('keep-worktree');
  const retainedFile = path.join(retained.groups[1].path, 'unsaved.txt');
  fs.writeFileSync(retainedFile, 'still here');
  const retainedPreview = retained.service.deletePreview(retained.owner.id);
  assert.equal(retainedPreview.worktrees.length, 2);
  await assert.rejects(retained.service.deletePermanently([retained.owner.id], 'human', { fingerprint: 'stale', keepWorktrees: true }), /状态已变化/);
  await retained.service.deletePermanently([retained.owner.id], 'human', { fingerprint: retainedPreview.fingerprint, keepWorktrees: true });
  assert.equal(retained.service.peek(retained.owner.id), undefined);
  assert.equal(retained.service.list().length, 0);
  assert.equal(retained.disk.at(-1)[0].retainedWorktreeOnly, true);
  assert.equal(retained.events.includes('purge'), true);
  assert.equal(fs.readFileSync(retainedFile, 'utf8'), 'still here');
  fs.unlinkSync(retainedFile);
  assert.equal((await retained.service.cleanupArchivedWorktree(retained.owner.id)).ok, true);
  assert.equal(retained.disk.at(-1).length, 0);

  const ignored = setup('ignored');
  fs.appendFileSync(path.join(ignored.groups[1].source.commonDir, 'info', 'exclude'), '\nprivate-cache/\n');
  fs.mkdirSync(path.join(ignored.groups[1].path, 'private-cache'));
  fs.writeFileSync(path.join(ignored.groups[1].path, 'private-cache', 'user.txt'), 'ignored user work');
  await assert.rejects(ignored.service.deletePermanently([ignored.owner.id], 'human'), /忽略的文件/);
  assert.equal(fs.readFileSync(path.join(ignored.groups[1].path, 'private-cache', 'user.txt'), 'utf8'), 'ignored user work');
  const legacyRemove = await ignored.service.git.worktreeRemove(ignored.groups[1].path);
  assert.equal(legacyRemove.ok, false, 'legacy non-forced removal also protects ignored files');
  assert.match(legacyRemove.message, /忽略的文件/);
  assert.equal(fs.readFileSync(path.join(ignored.groups[1].path, 'private-cache', 'user.txt'), 'utf8'), 'ignored user work');

  const missing = setup('missing-registration');
  const missingTree = missing.groups[1].path, missingMain = missing.groups[1].source.mainRepo;
  git(missingMain, 'worktree', 'remove', missingTree);
  const missingHead = git(missingMain, 'rev-parse', 'ao/task');
  await missing.service.deletePermanently([missing.owner.id], 'human');
  assert.equal(missing.service.get(missing.owner.id), undefined, 'missing registration does not trap an archived session');
  assert.equal(git(missingMain, 'rev-parse', 'ao/task'), missingHead, 'unverified branch is never deleted');
  assert.ok(missing.notices.some(notice => notice.text.includes('分支已保留') && notice.text.includes('ao/task')));

  const unknown = setup('unknown-directory');
  unknown.owner.worktreeGroups.groups = [unknown.owner.worktreeGroups.groups[0]];
  unknown.owner.worktreeGroups.cwdPolicy = 'source';
  unknown.owner.cwd = unknown.owner.sourceRoot.cwd;
  const unknownTree = unknown.groups[0].path, unknownMain = unknown.groups[0].source.mainRepo;
  git(unknownMain, 'worktree', 'remove', unknownTree);
  fs.mkdirSync(path.join(unknownTree, '.dev-sandbox'), { recursive: true });
  const protectedFile = path.join(unknownTree, '.dev-sandbox', 'user.txt');
  fs.writeFileSync(protectedFile, 'uncommitted user data');
  await assert.rejects(unknown.service.deletePermanently([unknown.owner.id], 'human'), /unregistered directory/);
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'uncommitted user data', 'ordinary delete cannot remove unknown files');
  const preview = await unknown.service.previewForceRemoveUnregistered(unknown.owner.id, unknownTree);
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'uncommitted user data', 'preview does not delete anything');
  fs.writeFileSync(path.join(unknownTree, 'changed-after-preview.txt'), 'changed');
  const stale = await unknown.service.forceRemoveUnregistered(unknown.owner.id, preview.token);
  assert.equal(stale.ok, false, 'changed directory identity invalidates confirmation');
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'uncommitted user data');
  await assert.rejects(unknown.service.forceRemoveUnregistered(unknown.owner.id, preview.token), /过期/);
  fs.mkdirSync(path.join(unknownTree, '.dev-sandbox', '.git'));
  const nestedPreview = await unknown.service.previewForceRemoveUnregistered(unknown.owner.id, unknownTree);
  const nested = await unknown.service.forceRemoveUnregistered(unknown.owner.id, nestedPreview.token);
  assert.equal(nested.ok, false, 'force cleanup must not recursively remove a nested Git repository');
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'uncommitted user data');
  fs.rmdirSync(path.join(unknownTree, '.dev-sandbox', '.git'));
  const referencedPreview = await unknown.service.previewForceRemoveUnregistered(unknown.owner.id, unknownTree);
  unknown.service.sessions.push({ id: 'borrower', archived: true, worktreePath: unknownTree });
  const referenced = await unknown.service.forceRemoveUnregistered(unknown.owner.id, referencedPreview.token);
  assert.equal(referenced.ok, false, 'another session reference prevents force cleanup');
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'uncommitted user data');
  unknown.service.sessions.pop();
  const approved = await unknown.service.previewForceRemoveUnregistered(unknown.owner.id, unknownTree);
  const forceResult = await unknown.service.forceRemoveUnregistered(unknown.owner.id, approved.token);
  assert.equal(forceResult.ok, true, forceResult.message);
  assert.equal(fs.existsSync(unknownTree), false, 'explicit confirmation deletes only the selected directory');
  assert.ok(git(unknownMain, 'rev-parse', 'ao/task'), 'force cleanup retains the branch');
  assert.ok(fs.existsSync(unknown.groups[1].path), 'a different worktree remains untouched');
  await unknown.service.deletePermanently([unknown.owner.id], 'human');
  assert.equal(unknown.service.get(unknown.owner.id), undefined);

  const multi = setup('unknown-multi');
  const multiTree = multi.groups[1].path, multiMain = multi.groups[1].source.mainRepo;
  git(multiMain, 'worktree', 'remove', multiTree);
  fs.mkdirSync(multiTree); fs.writeFileSync(path.join(multiTree, 'explicitly-discarded.txt'), 'selected');
  const otherWork = path.join(multi.groups[0].path, 'other-user-work.txt');
  fs.writeFileSync(otherWork, 'must survive');
  const multiPreview = await multi.service.previewForceRemoveUnregistered(multi.owner.id, multiTree);
  const multiResult = await multi.service.forceRemoveUnregistered(multi.owner.id, multiPreview.token);
  assert.equal(multiResult.ok, true, multiResult.message);
  assert.equal(fs.existsSync(multiTree), false);
  assert.equal(fs.readFileSync(otherWork, 'utf8'), 'must survive', 'force does not remove another task group');
  await assert.rejects(multi.service.deletePermanently([multi.owner.id], 'human'), /未提交改动/);
  assert.equal(fs.readFileSync(otherWork, 'utf8'), 'must survive');

  const archive = setup('archive'); archive.owner.archived = false;
  archive.service.setArchived(archive.owner.id, true);
  await until(archive, () => !archive.owner.worktreeGroups);
  assert.equal(archive.service.sessions.length, 1); assert.equal(archive.owner.archived, true);
  assert.equal(archive.events.includes('purge'), false); assert.equal(archive.owner.cwd, archive.groups[0].sourceRoot.cwd);

  const discard = setup('discard'); fs.writeFileSync(path.join(discard.groups[1].path, 'discard.txt'), 'explicitly discard');
  assert.equal((await discard.service.discardWorktree(discard.owner.id)).ok, true);
  assert.ok(discard.groups.every(group => !fs.existsSync(group.path))); assert.equal(discard.owner.worktreeGroups, undefined);
  assert.equal(discard.events.filter(event => event === 'release').length, 1);

  const cascade = setup('cascade');
  const parent = { id: '00000000-0000-4000-8000-999999999999', name: 'parent', type: 'terminal', runtime: 'pi', launchKind: 'agent',
    archived: true, workspaceId: cascade.owner.workspaceId, cwd: cascade.groups[0].sourceRoot.cwd };
  cascade.owner.parentSessionId = parent.id;
  cascade.service.sessions.unshift(parent);
  cascade.service.removedListeners = [];
  cascade.service.notifySessionRemoved = SessionsService.prototype.notifySessionRemoved;
  fs.writeFileSync(path.join(cascade.groups[1].path, 'user.txt'), 'child changes survive');
  cascade.service.close(parent.id);
  await until(cascade, () => cascade.owner.meta?.orphanWorktree === 'dirty');
  assert.ok(cascade.service.get(parent.id), '子树有未提交改动时保留父，不能留下悬空子记录');
  assert.ok(cascade.service.get(cascade.owner.id));
  fs.unlinkSync(path.join(cascade.groups[1].path, 'user.txt'));
  cascade.service.close(cascade.owner.id);
  await until(cascade, () => cascade.service.sessions.length === 0);
  assert.equal(cascade.service.subtreeCloseWaiters.size, 0, '子清理成功后继续删父并解除监听');
  console.log('session-task-worktree-cleanup: passed real service release/owner retention/archive/discard/persistence');
} finally {
  const target = path.resolve(fixture);
  assert.ok(target.startsWith(`${path.resolve(temp)}${path.sep}session-task-worktree-cleanup-`));
  fs.rmSync(target, { recursive: true, force: true });
  Module._load = originalLoad;
}
