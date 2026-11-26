/** Real Git Worker checks/snapshots across all task groups, preserving partial success. */
// @test-shards 3
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { inShard } from './helpers/shard.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(project, '.tmp'); fs.mkdirSync(tempRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(tempRoot, 'task-worktree-worker-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
// sessionsHost imports the Electron app path via delegate; isolate it in this Node/Git fixture.
const electron = path.join(fixture, 'compiled/node_modules/electron'); fs.mkdirSync(electron, { recursive: true });
fs.appendFileSync(path.join(electron, 'index.cjs'), `module.exports.app.getPath = () => ${JSON.stringify(fixture)};\n`);
const load = rel => import(pathToFileURL(compile(rel)).href);
const { beforeRequestIntegrate, afterNeedsYouReported } = await load('main/agentSession/workerTreeGuard.ts');
const { normalizeSessionWorktrees } = await load('shared/sessionWorktrees.ts');
const { sourcePathKey } = await load('main/workspacePaths.ts');
const { workspaceRootUsesFor } = await load('main/workspaceRootUses.ts');
const { beginTaskWorktreeOperation } = await load('main/git/worktreeTaskOperation.ts');
// 通信单通道：requestIntegrate 的知会进消息账本（挂账层已退役）
const { setAgentMessagesUserDataDir, readAgentMessageBody, readAgentMessageLedger } = await load('main/metaAgent/messageStore.ts');
setAgentMessagesUserDataDir(fixture);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const source = (rootId, folder) => ({ rootId, path: folder, cwd: folder, physicalPath: sourcePathKey(folder) });
function init(main, tree) {
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
  git(main, 'config', 'commit.gpgsign', 'false');
  git(main, 'config', 'core.hooksPath', path.join(main, '.git', 'hooks'));
  git(main, 'config', 'core.quotepath', 'false');
  fs.writeFileSync(path.join(main, '.gitignore'), 'Plugins/\n'); fs.writeFileSync(path.join(main, 'base.txt'), 'base');
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'base');
  const baseCommit = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', '-q', '-b', 'ao/task', tree, 'main');
  return baseCommit;
}
function setup(name, nested = false) {
  const directory = path.join(fixture, name); fs.mkdirSync(directory);
  const groups = ['a', 'b', 'c'].map(id => {
    const main = path.join(directory, id), tree = path.join(directory, `tree-${id}`);
    const baseCommit = init(main, tree), repos = [];
    if (nested && id !== 'c') {
      for (const rel of ['Plugins/A', 'Plugins/A/Plugins/B']) {
        const base = init(path.join(main, rel), path.join(tree, rel));
        repos.push({ path: rel, branch: 'ao/task', baseBranch: 'main', baseCommit: base, kind: 'independent' });
      }
    }
    return { id, path: tree, sourceRoot: source(id, main), source: { mainRepo: main, commonDir: path.join(main, '.git') }, branch: 'ao/task', baseBranch: 'main', baseCommit, repos };
  });
  const ws = { id: name, name, path: groups[2].source.mainRepo, controlRoot: groups[0].source.mainRepo,
    defaultRootId: 'c', rootsRevision: 1, roots: groups.map(group => ({ id: group.id, path: group.source.mainRepo })) };
  const cfg = { workspaces: [ws], activeWorkspaceId: ws.id };
  const owner = { id: name, name, type: 'terminal', workspaceId: ws.id, cwd: groups[0].path, sourceRoot: groups[0].sourceRoot,
    worktreeGroups: { version: 1, primaryGroupId: 'a', groups } };
  normalizeSessionWorktrees(owner);
  const nudges = [], config = { get: () => cfg };
  const ctx = { config, sessions: { get: id => id === owner.id ? structuredClone(owner) : undefined },
    agentSessions: { getTurnStartedAt: () => undefined, injectHostNudge: async (_id, text) => nudges.push(text) } };
  return { owner, groups, ws, cfg, config, ctx, nudges };
}
const status = folder => git(folder, 'status', '--porcelain');
const head = folder => git(folder, 'rev-parse', 'HEAD');
const dirty = folder => fs.writeFileSync(path.join(folder, '中文 space.txt'), 'user work');
function queue(task) {
  const sent = [], ledgerPath = () => task.cfg.workspaces[0].path;
  Object.assign(task.ctx.sessions, {
    resolveSessionRef: ({ sessionId }) => ({ id: sessionId }),
    peek: id => (id === task.owner.id ? task.owner : undefined),
    peekEnded: () => undefined,
    broadcastMessagesChanged: () => {}
  });
  task.ctx.workspaces = { list: () => task.cfg.workspaces, activePath: ledgerPath };
  task.ctx.resolveBubbleWorkspaceId = () => task.ws.id;
  task.ctx.orchestrator = { isBusy: () => false, send: async text => sent.push(text) };
  return { sent, get asks() { return readAgentMessageLedger(ledgerPath(), task.ws.id).messages.filter(mail => mail.kind === 'ask'); } };
}
function hook(group, name, body) {
  const script = path.join(path.dirname(group.path), `${group.id}-${name}.cjs`);
  fs.writeFileSync(script, body);
  const quoted = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  const hookFile = path.join(group.source.commonDir, 'hooks', name);
  fs.writeFileSync(hookFile, `#!/bin/sh\n${quoted(process.execPath)} ${quoted(script)}\n`, { mode: 0o755 });
  return hookFile;
}
try {
  if (inShard(0)) {
    const task = setup('all-groups', true);
    const leaf = path.join(task.groups[1].path, 'Plugins/A/Plugins/B'); dirty(leaf);
    const original = head(leaf);
    const { cleanupTaskWorktrees } = await load('main/git/worktreeTaskCleanup.ts');
    const { integrateTaskWorktrees } = await load('main/git/worktreeTaskIntegrate.ts');
    const pending = afterNeedsYouReported(task.ctx, task.owner.id);
    assert.deepEqual(workspaceRootUsesFor(task.config).list(task.ws.id).map(use => use.rootId).sort(), ['a', 'b', 'c'], 'holds every task source before the first await');
    assert.throws(() => beginTaskWorktreeOperation(task.config, task.owner.id, 'cleanup'), /already running/);
    await assert.rejects(() => cleanupTaskWorktrees({ ...task.ctx, findSession: () => task.owner }, task.owner, 'archive'), /already running/);
    await assert.rejects(() => integrateTaskWorktrees({ ...task.ctx, findSession: () => task.owner }, task.owner), /already running/);
    const result = await pending;
    assert.equal(result.dirty, true, 'dirty files confined to the second group must be detected');
    assert.ok(result.warnings.some(text => text.includes('b') && text.includes('Plugins/A/Plugins/B') && text.includes('中文 space.txt')));
    assert.equal(head(leaf), original, 'needs_you never makes a commit');
    assert.equal(workspaceRootUsesFor(task.config).list(task.ws.id).length, 0);
    const sourceMain = task.groups[1].source.mainRepo;
    fs.writeFileSync(path.join(sourceMain, 'source-staged.txt'), 'source index'); git(sourceMain, 'add', 'source-staged.txt');
    fs.writeFileSync(path.join(sourceMain, 'source-loose.txt'), 'source loose');
    const sourceIndex = fs.readFileSync(path.join(sourceMain, '.git', 'index'));
    const sourceStatus = status(sourceMain);
    const snapped = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.equal(snapped.fallbackCommit, true); assert.equal(snapped.fallbackError, undefined);
    assert.equal(status(leaf), ''); assert.match(git(leaf, 'log', '-1', '--format=%s'), /\[host\] P11/);
    assert.equal(status(sourceMain), sourceStatus); assert.deepEqual(fs.readFileSync(path.join(sourceMain, '.git', 'index')), sourceIndex);
    assert.equal(snapped.worktreeGroups.length, 3);
    assert.deepEqual(snapped.worktreeGroups.map(group => group.rootId), ['a', 'b', 'c']);
    const { sessionsHost } = await load('main/capabilities/hosts/sessions.ts');
    const notices = queue(task);
    task.ws.defaultRootId = 'b'; task.ws.roots.reverse(); task.ws.rootsRevision++;
    const requested = await sessionsHost['sessions.requestIntegrate'](task.ctx, { sessionId: task.owner.id });
    assert.equal(requested.ok, true); assert.equal(notices.asks.length, 1); assert.equal(notices.sent.length, 0, 'mail must not use the retired direct injection channel');
    // 通信单通道：账本条目带 intent/tag/branch；host 校验的 worktreeGroups 在上行文案与工具结果里
    assert.equal(notices.asks[0].meta.intent, 'integrate');
    assert.equal(notices.asks[0].meta.tag, 'notice');
    assert.equal(notices.asks[0].meta.branch, requested.branch);
    assert.deepEqual(requested.worktreeGroups.map(group => group.path), task.groups.map(group => group.path));
    const noticeText = readAgentMessageBody(task.cfg.workspaces[0].path, task.ws.id, notices.asks[0]);
    assert.ok(noticeText.includes('来源 b') && noticeText.includes(task.groups[1].path));
    assert.equal(noticeText.match(/嵌套仓 Plugins\/A：/g).length, 2);
    assert.equal(requested.assertCurrent, undefined, 'internal guards are never serialized in the tool result');
    console.log('ok: all groups and deepest nested dirty/snapshot with untouched source');
  }
  if (inShard(1)) {
    const task = setup('invalid-last'); dirty(task.groups[0].path);
    const last = path.join(task.groups[2].path, '.git'); const saved = fs.readFileSync(last);
    fs.chmodSync(last, 0o666);
    fs.writeFileSync(last, fs.readFileSync(path.join(task.groups[1].path, '.git')), { flag: 'r+' });
    const failed = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.equal(failed.fallbackCommit, false); assert.ok(failed.fallbackError);
    assert.equal(git(task.groups[0].path, 'diff', '--cached', '--name-only'), '', 'all identities pass before any staging');
    assert.equal(head(task.groups[0].path), task.groups[0].baseCommit);
    fs.writeFileSync(last, saved, { flag: 'r+' });
    assert.equal(workspaceRootUsesFor(task.config).list(task.ws.id).length, 0);
    const lock = path.join(task.groups[2].source.commonDir, 'worktrees', fs.readdirSync(path.join(task.groups[2].source.commonDir, 'worktrees'))[0], 'locked');
    fs.writeFileSync(lock, 'externally locked');
    const locked = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.ok(locked.fallbackError); assert.equal(task.nudges.length, 0);
    assert.equal(git(task.groups[0].path, 'diff', '--cached', '--name-only'), '');
    fs.unlinkSync(lock);
    const { readGitDirectories } = await load('main/git/repoIdentity.ts');
    const index = path.join(readGitDirectories(task.groups[2].path).gitDir, 'index');
    const oldIndex = fs.readFileSync(index);
    fs.writeFileSync(index, Buffer.alloc(12, 0), { flag: 'r+' });
    const unavailable = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.ok(unavailable.fallbackError);
    assert.equal(git(task.groups[0].path, 'diff', '--cached', '--name-only'), '', 'last-group status read failure stops all staging');
    fs.writeFileSync(index, oldIndex, { flag: 'r+' });
    const checked = await beforeRequestIntegrate(task.ctx, task.owner.id);
    task.owner.worktreeGroups.groups[2].branch = 'ao/transferred';
    assert.throws(() => checked.assertCurrent(), /ownership changed/);
    console.log('ok: bad last gitfile/lock globally prevents staging');
  }
  if (inShard(2)) {
    const task = setup('partial'); for (const group of task.groups) dirty(group.path);
    const hook = path.join(task.groups[1].source.commonDir, 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho second-group-rejected >&2\nexit 1\n', { mode: 0o755 });
    const result = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.equal(result.fallbackCommit, false); assert.match(result.snapshots.find(repo => repo.status === 'failed').message, /second-group-rejected/);
    assert.equal(status(task.groups[0].path), '');
    assert.notEqual(head(task.groups[0].path), task.groups[0].baseCommit, 'completed snapshot is durable');
    assert.equal(head(task.groups[1].path), task.groups[1].baseCommit);
    assert.match(git(task.groups[1].path, 'diff', '--cached', '--name-only'), /中文 space/);
    assert.equal(git(task.groups[2].path, 'diff', '--cached', '--name-only'), '', 'later group is not staged');
    const completed = head(task.groups[0].path);
    fs.unlinkSync(hook);
    const retry = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.equal(retry.fallbackCommit, true); assert.equal(head(task.groups[0].path), completed, 'retry does not create another snapshot of the completed group');
    for (const group of task.groups) assert.equal(status(group.path), '');
    console.log('ok: hook failure preserves earlier commit/index and retry uses live state');
  }
  if (inShard(3)) {
    const task = setup('hook-ref-change'); dirty(task.groups[0].path);
    const external = task.groups[1];
    const file = hook(task.groups[0], 'post-commit', `const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))); require('node:child_process').execFileSync('git', ['-C', ${JSON.stringify(external.path)}, 'commit', '--allow-empty', '-qm', 'external late commit'], { env });`);
    const before = head(task.groups[0].path);
    const result = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.equal(result.fallbackCommit, false); assert.match(result.snapshots.find(repo => repo.status === 'failed').message, /commit changed after preflight/);
    assert.notEqual(head(task.groups[0].path), before, 'own completed commit is retained');
    assert.notEqual(head(external.path), external.baseCommit, 'external commit is retained');
    assert.equal(result.snapshots.find(repo => repo.groupId === 'a').committed, true);
    assert.equal(git(task.groups[2].path, 'diff', '--cached', '--name-only'), '');
    assert.equal(workspaceRootUsesFor(task.config).list(task.ws.id).length, 0);
    fs.unlinkSync(file);
    console.log('ok: late task ref changes stop later snapshots and retain every commit');
  }
  if (inShard(4)) {
    const task = setup('hook-dirty'); dirty(task.groups[0].path);
    const late = path.join(task.groups[0].path, 'late.txt');
    const file = hook(task.groups[0], 'post-commit', `require('node:fs').writeFileSync(${JSON.stringify(late)}, 'post-hook user work');`);
    const { sessionsHost } = await load('main/capabilities/hosts/sessions.ts'); const notices = queue(task);
    await assert.rejects(() => sessionsHost['sessions.requestIntegrate'](task.ctx, { sessionId: task.owner.id }), /宿主提示.*交付检查未通过/);
    assert.equal(notices.asks.length, 0); assert.equal(notices.sent.length, 0);
    assert.equal(fs.readFileSync(late, 'utf8'), 'post-hook user work'); assert.match(git(task.groups[0].path, 'log', '-1', '--format=%s'), /\[host\] P11/);
    fs.unlinkSync(file);
    console.log('ok: a post-commit hook leaving dirty files cannot produce a successful integration request');
  }
  if (inShard(5)) {
    const task = setup('gitlink'); const group = task.groups[0];
    const remote = path.join(fixture, 'submodule-remote'); init(remote, path.join(fixture, 'remote-tree'));
    const relative = 'Child 项目', sourceChild = path.join(group.source.mainRepo, relative), taskChild = path.join(group.path, relative);
    git(group.source.mainRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', remote, relative);
    const { readGitDirectories } = await load('main/git/repoIdentity.ts');
    git(sourceChild, 'config', 'user.name', 'Fixture'); git(sourceChild, 'config', 'user.email', 'fixture@example.invalid');
    git(sourceChild, 'config', 'commit.gpgsign', 'false');
    git(sourceChild, 'config', 'core.hooksPath', path.join(readGitDirectories(sourceChild).commonDir, 'hooks'));
    git(group.source.mainRepo, 'commit', '-qm', 'add real submodule');
    git(group.source.mainRepo, 'worktree', 'remove', group.path);
    git(group.source.mainRepo, 'branch', '-f', 'ao/task', 'main');
    git(group.source.mainRepo, 'worktree', 'add', '-q', group.path, 'ao/task');
    const childBase = head(sourceChild);
    git(sourceChild, 'worktree', 'add', '-q', '-b', 'ao/child', taskChild, 'HEAD');
    const repo = { path: relative, branch: 'ao/child', baseBranch: 'main', baseCommit: childBase, kind: 'submodule' };
    group.repos.push(repo); group.baseCommit = head(group.source.mainRepo);
    Object.assign(task.owner.worktreeGroups.groups[0], { repos: [repo], baseCommit: group.baseCommit });
    normalizeSessionWorktrees(task.owner);
    dirty(taskChild);
    fs.writeFileSync(path.join(sourceChild, 'source.txt'), 'source staged'); git(sourceChild, 'add', 'source.txt');
    fs.writeFileSync(path.join(sourceChild, 'loose.txt'), 'source loose');
    const sourceIndexFile = path.join(readGitDirectories(sourceChild).gitDir, 'index');
    const beforeStatus = status(sourceChild), beforeIndex = fs.readFileSync(sourceIndexFile), parentHead = head(group.source.mainRepo);
    const snapped = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.equal(snapped.fallbackCommit, true, snapped.fallbackError);
    assert.equal(status(taskChild), ''); assert.equal(status(group.path), '');
    assert.notEqual(head(taskChild), childBase);
    assert.match(git(group.path, 'ls-tree', 'HEAD', '--', relative), new RegExp(`^160000 commit ${head(taskChild)}`));
    assert.equal(head(group.source.mainRepo), parentHead); assert.equal(head(sourceChild), childBase);
    assert.equal(status(sourceChild), beforeStatus); assert.deepEqual(fs.readFileSync(sourceIndexFile), beforeIndex);
    const entries = snapped.snapshots.filter(repo => repo.groupId === 'a');
    assert.deepEqual(entries.map(entry => entry.repo), [relative, ''], 'actual submodule commits before its parent gitlink snapshot');
    assert.ok(entries.every(entry => entry.committed));
    console.log('ok: actual submodule gitlink snapshots child then parent, preserving source user work/index');
  }
  if (inShard(6)) {
    const task = setup('late-gitfile'); dirty(task.groups[0].path);
    const checked = await beforeRequestIntegrate(task.ctx, task.owner.id);
    fs.writeFileSync(path.join(task.groups[0].path, '.git'), fs.readFileSync(path.join(task.groups[1].path, '.git')), { flag: 'r+' });
    assert.throws(() => checked.assertCurrent(), /repository identity\/branch changed/);
    assert.equal(head(task.groups[0].source.mainRepo), task.groups[0].baseCommit, 'source checkout remains unchanged');
    assert.notEqual(git(task.groups[0].source.mainRepo, 'rev-parse', 'ao/task'), task.groups[0].baseCommit, 'completed snapshot remains in its original repository');
    assert.equal(git(task.groups[1].source.mainRepo, 'rev-parse', 'ao/task'), task.groups[1].baseCommit, 'replacement repository has no host snapshot');
    console.log('ok: physical Git identity is rechecked after snapshot and before integration notice');
  }
  if (inShard(7)) {
    const task = setup('fake-primary'); dirty(task.groups[0].path);
    const original = task.groups[0].source.mainRepo;
    const fake = path.join(path.dirname(original), 'fake-primary'); fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, '.git'), `gitdir: ${path.join(original, '.git')}\n`);
    const fakeRoot = source('a', fake);
    task.ws.roots[0].path = fake; task.ws.controlRoot = fake;
    Object.assign(task.owner.worktreeGroups.groups[0], { sourceRoot: fakeRoot, source: { mainRepo: fake, commonDir: path.join(original, '.git') } });
    task.owner.sourceRoot = fakeRoot; normalizeSessionWorktrees(task.owner);
    const result = await beforeRequestIntegrate(task.ctx, task.owner.id);
    assert.match(result.fallbackError, /宿主提示.*交付检查未通过/);
    assert.equal(git(task.groups[0].path, 'diff', '--cached', '--name-only'), '', 'a primary gitfile clone outside the real source registration cannot authorize any staging');
    assert.equal(head(original), task.groups[0].baseCommit);
    console.log('ok: common-dir equality alone cannot authorize a fake primary checkout');
  }
} catch (error) {
  console.error('[worker-guard regression]', error);
  throw error;
} finally {
  const target = path.resolve(fixture);
  assert.ok(target.startsWith(`${path.resolve(tempRoot)}${path.sep}task-worktree-worker-`));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
