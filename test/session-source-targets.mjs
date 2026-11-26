/** Real source folders + actual session creation/launch + queue target capture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const originalLoad = Module._load;
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const targets = require(path.join(repo, 'src/main/sessions/targets.ts'));
const { SessionsService } = require(path.join(repo, 'src/main/sessions.ts'));
const factory = require(path.join(repo, 'src/main/sessions/createTerminal.ts'));
const queue = require(path.join(repo, 'src/main/tasks/delegateQueue.ts'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-source-targets-'));
try {
  const a = path.join(tmp, 'a'), b = path.join(tmp, 'b'), tree = path.join(tmp, 'external-tree');
  for (const folder of [a, b, tree]) fs.mkdirSync(folder);
  const sub = path.join(b, 'src'); fs.mkdirSync(sub);
  let cfg = { activeWorkspaceId: 'other', workspace: a, defaultRuntime: 'pi', workspaces: [
    { id: 'ws', path: a, name: 'multi', roots: [{ id: 'a', path: a }, { id: 'b', path: b }], defaultRootId: 'b', controlRoot: a, rootsRevision: 1 },
    { id: 'other', path: tree, name: 'other' }
  ] };
  const get = () => cfg;
  const resolve = (input, session) => targets.resolveSessionTarget(cfg, input, session);
  const target = await resolve({ workspaceId: 'ws' });
  assert.equal(target.cwd, b, 'new task uses defaultRootId, even with stale legacy path');
  assert.equal(target.controlRoot, a, 'management root is independent');
  assert.equal((await resolve({ workspaceId: 'ws', rootId: 'a' })).cwd, a);
  assert.equal((await resolve({ cwd: sub })).workspaceId, 'ws', 'second root is an ownership candidate');
  assert.equal((await resolve({ workspaceId: 'ws', cwd: sub })).sourceRoot.rootId, 'b');
  cfg.workspaces[0].roots.push({ id: 'nested', path: sub });
  assert.equal((await resolve({ workspaceId: 'ws', cwd: sub })).sourceRoot.rootId, 'nested');
  assert.equal((await resolve({ workspaceId: 'ws', rootId: 'b', cwd: sub })).sourceRoot.rootId, 'b', 'explicit parent source remains valid');
  cfg.workspaces[0].roots.pop();
  await assert.rejects(resolve({ workspaceId: 'missing' }), /workspace not found/);
  await assert.rejects(resolve({ workspaceId: 'ws', rootId: 'missing' }), /source folder not found/);
  await assert.rejects(resolve({ workspaceId: 'ws', rootId: 'a', cwd: sub }), /outside/);
  await assert.rejects(resolve({ workspaceId: 'ws', rootsRevision: 0 }), /changed/);
  await assert.rejects(resolve({ workspaceId: 'ws', cwd: 'relative' }), /absolute/);
  cfg.workspaces.push({ id: 'shared', path: b });
  await assert.rejects(resolve({ cwd: sub }), /ambiguous/);
  assert.equal(targets.legacySessionWorkspaceId(cfg, { cwd: sub }), '', 'legacy ambiguity cannot guess active workspace');
  assert.equal(targets.legacySessionWorkspaceId(cfg, { workspaceId: 'ws', cwd: sub }), 'ws');
  cfg.workspaces.pop();
  assert.deepEqual(targets.legacySessionSourceRoot(cfg, { cwd: sub }), { rootId: 'b', path: b, cwd: sub });
  assert.equal(targets.legacySessionWorkspaceId(cfg, { cwd: tmp }), '', 'outside does not guess active workspace');

  const isolated = { id: 'source', type: 'terminal', workspaceId: 'ws', cwd: tree, worktreePath: tree, sourceRoot: target.sourceRoot, worktreeSource: { mainRepo: b, commonDir: path.join(b, '.git') } };
  const loader = { config: { get }, runtimes: { get: id => ({ id, enabled: true }) }, ptyMgr: { isRunning: () => false } };
  const oldRow = { ...isolated, runtime: 'pi', worktreeBranch: 'ao/old', worktreeBaseBranch: 'main' };
  const migrated = SessionsService.prototype.normalizeLoadedSession.call(loader, oldRow);
  const legacyLoader = { ...loader, runtimes: { get: id => id === 'pi' ? { id, enabled: true } : undefined } };
  const legacyCursor = SessionsService.prototype.normalizeLoadedSession.call(legacyLoader, { ...oldRow, runtime: 'cursor', runtimeResumeToken: 'sdk-token' });
  assert.equal(legacyCursor.runtime, 'cursor', 'removed runtime must not be rebound to the default engine');
  assert.equal(legacyCursor.runtimeResumeToken, 'sdk-token');
  const removed = SessionsService.prototype.normalizeLoadedSession.call(legacyLoader, { ...oldRow, runtime: 'removed-manifest', externalSessionId: 'old-native-id' });
  assert.equal(removed.runtime, 'removed-manifest');
  assert.equal(removed.externalSessionId, 'old-native-id');
  assert.equal(migrated.worktreeGroups.version, 1);
  assert.deepEqual(migrated.worktreeGroups.groups[0].sourceRoot, target.sourceRoot);
  assert.deepEqual(SessionsService.prototype.normalizeLoadedSession.call(loader, JSON.parse(JSON.stringify(migrated))).worktreeGroups, migrated.worktreeGroups);
  const groups = { version: 1, primaryGroupId: 'second', groups: [
    { id: 'first', path: path.join(tmp, 'tree-a'), sourceRoot: { rootId: 'a', path: a, cwd: a },
      source: { mainRepo: a, commonDir: path.join(a, '.git') }, branch: 'ao/groups', baseBranch: 'main', repos: [] },
    { id: 'second', path: tree, sourceRoot: target.sourceRoot, source: isolated.worktreeSource,
      branch: 'ao/groups', baseBranch: 'feature', repos: [] }
  ] };
  const restored = SessionsService.prototype.normalizeLoadedSession.call(loader, {
    id: 'groups', name: 'Groups', type: 'terminal', workspaceId: 'ws', runtime: 'pi', cwd: tree,
    worktreeGroups: groups, worktreePath: groups.groups[0].path
  });
  assert.equal(restored.worktreePath, tree); assert.equal(restored.worktreeBaseBranch, 'feature');
  assert.deepEqual(restored.sourceRoot, target.sourceRoot, 'restart derives source from the named primary, not the default or first group');
  const bad = { ...restored, worktreeGroups: { ...groups, version: 2 } };
  const diagnosed = SessionsService.prototype.normalizeLoadedSession.call(loader, bad);
  assert.equal(diagnosed.worktreeGroups.version, 2);
  assert.match(diagnosed.meta.worktreeGroupsError, /invalid/);
  const invalidCloseRows = [{ ...diagnosed, archived: true }];
  assert.throws(() => SessionsService.prototype.close.call({ sessions: invalidCloseRows, config: { get } }, diagnosed.id), /invalid worktree group/);
  assert.equal(invalidCloseRows.length, 1, 'malformed topology retains its owner before any release or cleanup');
  const taskSubdir = path.join(tree, 'src'); fs.mkdirSync(taskSubdir);
  restored.cwd = taskSubdir;
  restored.interruptSnapshot = { interruptedAt: 1, lastActivityAt: 1, uncommitted: [], worktreeClean: true };
  const resumeRows = [restored];
  const resume = { sessions: resumeRows, isChatRuntime: () => false, persist() {}, broadcast() {},
    get: id => resumeRows.find(row => row.id === id),
    async createTerminal(input) {
      assert.equal(input.cwd, taskSubdir); assert.equal(input.sourceSessionId, restored.id);
      const row = { id: 'continued', type: 'terminal', cwd: input.cwd, workspaceId: input.workspaceId };
      resumeRows.push(row); return row;
    } };
  const continued = await SessionsService.prototype.resumeInterrupted.call(resume, restored.id);
  assert.deepEqual(continued.session.worktreeGroups, groups);
  assert.equal(continued.session.cwd, taskSubdir, 'resuming a group preserves its actual subdirectory cwd');
  assert.equal(restored.worktreeGroups, undefined); assert.equal(restored.worktreePath, undefined);
  assert.equal(restored.interruptSnapshot, undefined);
  const inherited = await resolve({ workspaceId: 'ws', cwd: tree }, isolated);
  assert.equal(inherited.cwd, tree);
  assert.deepEqual(inherited.sourceRoot, target.sourceRoot, 'external tree inherits recorded source');
  assert.throws(() => targets.registeredWorktreeSession([isolated, { ...isolated, workspaceId: 'other' }], tree), /ambiguous/);
  await assert.rejects(resolve({ workspaceId: 'ws', cwd: tree }), /outside/);
  assert.equal(targets.legacySessionWorkspaceId(cfg, { cwd: tree, worktreeSource: isolated.worktreeSource }), 'ws', 'legacy external tree uses source repo, not tree location');

  // Actual service orchestration and row factory; runtime spawn is the external boundary.
  const rows = [isolated], launches = [];
  const flow = { config: { get }, runtimes: { get: () => ({ enabled: true }) }, sessions: rows,
    isChatRuntime: () => true, notify: { push() {} }, usageStats: null, agentSessionsRef: null,
    applySelectDisplay() {}, persist() {}, broadcast() {}, get: (id) => rows.find((s) => s.id === id),
    async launchTerminal(session) { launches.push(session); }
  };
  const service = { config: { get }, sessions: rows, createTerminalCtx: () => flow };
  const create = (opts) => SessionsService.prototype.createTerminal.call(service, opts);
  const agent = await create({ workspaceId: 'ws', force: true });
  assert.equal(agent.cwd, b); assert.equal(agent.sourceRoot.rootId, 'b');
  const shell = await create({ workspaceId: 'ws', rootId: 'a', shellProfileId: 'powershell' });
  assert.equal(shell.cwd, a); assert.equal(shell.sourceRoot.rootId, 'a');
  const fork = await create({ sourceSessionId: 'source', cwd: tree, force: true });
  assert.equal(fork.workspaceId, 'ws'); assert.deepEqual(fork.sourceRoot, target.sourceRoot);
  const count = rows.length;
  await assert.rejects(create({ workspaceId: 'missing', force: true }), /workspace not found/);
  assert.equal(rows.length, count); assert.equal(launches.length, 3, 'invalid targets never create rows or launch');
  flow.isChatRuntime = () => false;
  const cliCreated = await create({ workspaceId: 'ws', runtime: 'codex', force: true,
    cliLaunchOptions: { model: 'test-model', permission: 'ask' } });
  assert.deepEqual(cliCreated.cliLaunchOptions, { model: 'test-model', permission: 'ask' }, 'CLI configuration persists on session');
  await assert.rejects(create({ workspaceId: 'ws', runtime: 'codex', force: true,
    cliLaunchOptions: { model: 'invalid & flag' } }), /模型 ID/);
  rows.splice(rows.findIndex(row => row.id === cliCreated.id), 1); launches.pop();
  flow.isChatRuntime = () => true;
  // GUI creation must finish its async source validation/open before delegate sends immediately.
  let enterLaunch, releaseLaunch;
  const launchEntered = new Promise(resolve => { enterLaunch = resolve; });
  const launchGate = new Promise(resolve => { releaseLaunch = resolve; });
  let guiCreated = false;
  const delayedGui = factory.createAgentTerminalSession({ ...flow, async launchTerminal() { enterLaunch(); await launchGate; } },
    { force: true }, await resolve({ workspaceId: 'ws', rootId: 'b' })).then(row => { guiCreated = true; return row; });
  await launchEntered; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(guiCreated, false, 'GUI creation cannot report success while host.open is still pending');
  releaseLaunch(); const createdGui = await delayedGui;
  rows.splice(rows.findIndex(row => row.id === createdGui.id), 1);

  // Real launch state machine: directory is pinned throughout allocate/resolve/spawn.
  const spawned = [], launchErrors = [];
  const launcher = {
    ...service, launchGen: new Map(), launchTasks: new Map(), isChatRuntime: () => false,
    runtimes: { get: () => ({ enabled: true }), prepareWorkspaceDirectories: async () => ({ args: [], note: 'Fixture cwd-only' }), allocate: async (_runtime, cwd) => { assert.equal(cwd, b); return 'allocated'; }, resolveLaunch: async () => ({ command: 'fixture', args: [] }) },
    ptyMgr: { spawn: async (...args) => { spawned.push(args); return 'fixture-generation'; }, desktopProcessGeneration: () => 'fixture-generation', killAndWait: async () => {}, isRunning: () => false },
    classifyBySession: new Map(), ensureStatusToken() {}, persist() {}, broadcast() {}, getWindow: () => null,
    workspaceIdFor: (s) => s.workspaceId, notify: { push: (notice) => launchErrors.push(notice) },
    bumpLaunchGen: SessionsService.prototype.bumpLaunchGen,
    applyLifecycle(s, next) { s.lifecycle = next; },
    isCurrentLaunch: SessionsService.prototype.isCurrentLaunch
  };
  await SessionsService.prototype.launchTerminal.call(launcher, agent, 'start');
  assert.equal(spawned[0][2], b, 'actual launch uses selected source cwd');
  fork.externalSessionId = 'fork-existing';
  await SessionsService.prototype.launchTerminal.call(launcher, fork, 'start');
  assert.equal(spawned[1][2], tree, 'shared fork retains external cwd through its registered owner');
  const failing = { ...agent, id: 'late', externalSessionId: undefined }; rows.push(failing);
  launcher.runtimes.allocate = async () => { cfg.workspaces[0].roots = [{ id: 'a', path: a }]; return 'allocated'; };
  await SessionsService.prototype.launchTerminal.call(launcher, failing, 'start');
  assert.equal(spawned.length, 2, 'removal during allocate prevents real spawn');
  assert.equal(failing.lifecycle, 'exited'); assert.match(failing.meta.launchError, /source folder not found/);
  assert.equal(launchErrors.length, 1);
  rows.pop(); cfg.workspaces[0].roots.push({ id: 'b', path: b });

  const saved = { ...agent, id: 'resume-race', runtime: 'qwen-cli', externalSessionId: 'saved-qwen' };
  rows.push(saved);
  let enterLookup, finishLookup;
  const lookupEntered = new Promise(resolve => { enterLookup = resolve; });
  const lookupResult = new Promise(resolve => { finishLookup = resolve; });
  launcher.runtimes.checkTerminalResume = () => { enterLookup(); return lookupResult; };
  const superseded = SessionsService.prototype.launchTerminal.call(launcher, saved, 'resume');
  await lookupEntered;
  launcher.runtimes.checkTerminalResume = async () => ({ status: 'attempt' });
  launcher.runtimes.resolveLaunch = async (_runtime, mode, sessionId) => {
    assert.equal(mode, 'resume');
    assert.equal(sessionId, 'saved-qwen');
    return { command: 'fixture', args: [] };
  };
  await SessionsService.prototype.launchTerminal.call(launcher, saved, 'resume');
  finishLookup({ status: 'missing' });
  await superseded;
  assert.equal(saved.externalSessionId, 'saved-qwen', 'a superseded resume lookup cannot clear the replacement session ID');
  assert.equal(spawned.length, 3);
  for (const [check, message] of [
    [{ status: 'missing' }, /找不到原对话/],
    [{ status: 'unsupported' }, /不支持恢复/],
    [{ status: 'unbound' }, /尚未绑定/],
    [{ status: 'failed', detail: 'permission denied' }, /permission denied/]
  ]) {
    launcher.runtimes.checkTerminalResume = async () => check;
    await assert.rejects(SessionsService.prototype.launchTerminal.call(launcher, saved, 'resume'), message);
    assert.equal(saved.externalSessionId, 'saved-qwen');
    assert.match(saved.meta.launchError, message);
    assert.equal(spawned.length, 3, 'a failed resume never launches a fresh conversation');
  }
  launcher.ptyMgr.isRunning = () => true;
  Object.assign(saved, { status: 'running', lifecycle: 'working' });
  launcher.runtimes.checkTerminalResume = async () => ({ status: 'missing' });
  await assert.rejects(SessionsService.prototype.launchTerminal.call(launcher, saved, 'resume'), /找不到原对话/);
  assert.equal(saved.lifecycle, 'working', 'a failed check leaves the live terminal alone');
  assert.equal(saved.status, 'running');
  launcher.ptyMgr.isRunning = () => false;
  let disposedMismatch = false;
  launcher.runtimes.checkTerminalResume = async () => ({ status: 'attempt' });
  launcher.runtimes.resolveLaunch = async () => ({
    command: 'fixture', args: [], externalSessionId: 'unrelated-native-id',
    dispose: () => { disposedMismatch = true; }
  });
  await assert.rejects(SessionsService.prototype.launchTerminal.call(launcher, saved, 'resume'), /不同的会话 ID/);
  assert.ok(disposedMismatch);
  assert.equal(saved.externalSessionId, 'saved-qwen');
  assert.equal(spawned.length, 3);
  saved.terminalResumeScope = { runtime: 'qwen-cli', cwd: a };
  await assert.rejects(SessionsService.prototype.launchTerminal.call(launcher, saved, 'resume'), /工作目录已变化/);
  launcher.runtimes.get = () => ({ enabled: true, terminalResume: 'by-id' });
  launcher.runtimes.allocate = async () => 'explicit-new';
  launcher.runtimes.resolveLaunch = async (_runtime, mode, sessionId) => {
    assert.equal(mode, 'new');
    assert.equal(sessionId, 'explicit-new');
    assert.equal(saved.externalSessionId, 'saved-qwen', 'the old ID survives until a new launch commits');
    return { command: 'fixture', args: [] };
  };
  const spawn = launcher.ptyMgr.spawn;
  launcher.ptyMgr.spawn = async () => { throw new Error('failed to start fixture'); };
  await assert.rejects(SessionsService.prototype.launchTerminal.call(launcher, saved, 'new'), /failed to start fixture/);
  assert.equal(saved.externalSessionId, 'saved-qwen');
  assert.deepEqual(saved.terminalResumeScope, { runtime: 'qwen-cli', cwd: a });
  launcher.ptyMgr.spawn = spawn;
  saved.activity = { kind: 'active', ts: 1 };
  saved.firstSignalAt = 1;
  saved.runtimeStartedAt = 1;
  await SessionsService.prototype.launchTerminal.call(launcher, saved, 'new');
  assert.equal(saved.externalSessionId, 'explicit-new');
  assert.deepEqual(saved.terminalResumeScope, { runtime: 'qwen-cli', cwd: b });
  assert.equal(saved.activity, undefined);
  assert.equal(saved.firstSignalAt, undefined);
  assert.ok(saved.runtimeStartedAt > 1);
  assert.equal(saved.meta.launchError, undefined);
  rows.pop();

  cfg.workspaces[0].defaultRootId = 'a'; cfg.workspaces[0].rootsRevision++;
  targets.assertSessionTargetCurrent(cfg, target);
  assert.equal(agent.cwd, b, 'default changes never relocate existing sessions');
  const stale = { ...flow, runtimes: { get() { cfg.workspaces[0].roots = [{ id: 'a', path: a }]; return { enabled: true }; } } };
  await assert.rejects(factory.createAgentTerminalSession(stale, { force: true }, target), /source folder not found/);
  assert.equal(rows.length, count, 'source removed while creating cannot materialize a session');
  cfg.workspaces[0].roots.push({ id: 'b', path: b });

  // Real group creation, provisioning and rollback are covered by task-worktree-create.mjs and session-task-worktree-create.mjs.
  const chat = require(path.join(repo, 'src/main/capabilities/hosts/chat.ts'));
  const skills = require(path.join(repo, 'src/main/agent/skillsList.ts'));
  const skillDir = path.join(b, '.agents/skills/source-b-only'); fs.mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillFile, '---\nname: source-b-only\ndescription: source fixture\n---\n\nDo source work.');
  const originalListSkills = skills.listAgentSkills;
  skills.listAgentSkills = async cwd => { assert.equal(cwd, b); return [{ name: 'source-b-only', filePath: skillFile, baseDir: skillDir, description: 'source fixture' }]; };
  try {
    const briefCtx = { config: { get }, workspaces:{list:()=>cfg.workspaces}, sessions: { ensureStatusToken() {} } };
    const {sendSessionMail}=require(path.join(repo,'src/main/messages/assignment.ts'));
    let delivered = 0;
    const invalidCtx = { ...briefCtx, sessions: { get: () => ({ ...agent, workspaceId: 'missing' }), isChatRuntime: () => true },
      agentSessions: { isOpen: () => true, send: async () => { delivered++; return { ok: true }; } } };
    await assert.rejects(sendSessionMail(invalidCtx, { sessionId: agent.id, text: 'must not deliver' }), /workspace not found/);
    assert.equal(delivered, 0, 'unknown workspace rejects before message delivery');
    const brief = await chat.buildBriefWithNamedSkills(briefCtx, undefined, '/skill:source-b-only', { workspaceRoot: a, skillCwd: b });
    assert.ok(brief.brief.includes(skillFile), 'second-root skill pointer survives management-root vocabulary/memory reads');
  } finally { skills.listAgentSkills = originalListSkills; }

  const delegate = require(path.join(repo, 'src/main/tasks/delegate.ts'));
  const taskHost = require(path.join(repo, 'src/main/capabilities/hosts/actors.ts'));
  const {setAgentMessagesUserDataDir,readAgentMessageLedger}=require(path.join(repo,'src/main/metaAgent/messageStore.ts'));
  setAgentMessagesUserDataDir(path.join(tmp,'userdata'));
  cfg.workspaces[0].path = b; // A real default-root projection, distinct from management.
  const guiMessages = [];
  const delegatedCtx = { config: { get }, workspaces: { list: () => cfg.workspaces, activePath: () => tree },
    resolveBubbleWorkspaceId: () => 'ws',
    sessions: {
      list: () => rows,
      listByWorkspace: () => [], isChatRuntime: () => true, injectStrategy: async () => 'initial-prompt',
      createTerminal: (opts) => create({ ...opts, force: true }), get: (id) => rows.find((s) => s.id === id),
      ensureStatusToken() {}, clearDonePhase() {}, setLiveStatus() {},
      broadcastMessagesChanged() {}
    }, agentSessions: { async send(id, text) { guiMessages.push({ id, text }); return { ok: true }; } },
    git: { async probeDirty(repo) { assert.equal(repo, b); return true; }, async resolveMainRepoFor(cwd, ceiling) { assert.equal(cwd, b); assert.equal(ceiling, b); return b; } }
  };
  assert.equal(taskHost.resolveActorControlRoot(delegatedCtx, { workspaceId: 'ws' }), a);
  delegatedCtx.sessions.listByWorkspace = () => [{ type: 'terminal', cwd: b, lifecycle: 'working' }];
  assert.equal(await delegate.recommendIsolate(delegatedCtx, 'ws', b), true, 'second root supplies the Git walk ceiling');
  delegatedCtx.sessions.listByWorkspace = () => [];
  const delegated = await delegate.delegateTask(delegatedCtx, { task: 'second root task', workspaceId: 'ws', rootId: 'b', isolate: false, select: false, notifyOrchestrator: false });
  assert.equal(delegated.session.cwd, b); assert.equal(delegated.session.sourceRoot.rootId, 'b');
  assert.equal(delegated.inject.mode,'gui-prompt');
  assert.deepEqual(guiMessages, [{ id: delegated.session.id, text: 'second root task' }]);
  assert.ok(!readAgentMessageLedger(a,'ws').messages.some(m=>m.to===delegated.session.id),'首次 GUI 任务不写邮箱');
  assert.equal(fs.existsSync(path.join(a,'.muster/tasks.json')),false,'不再自动建立共享任务表');
  assert.equal(fs.existsSync(path.join(b, '.muster/tasks.json')), false, 'source root does not acquire a second task table');

  // Queue uses the real enqueue/drain path and clones mutable caller options.
  queue.resetDelegateQueueForTests();
  const ctx = { config: { get }, sessions: { listByWorkspace: () => [] }, notify: { push() {} } };
  cfg.workspaces[0].defaultRootId = 'b';
  const input = { task: 'work', name: 'queued', isolate: false, repoSet: ['plugin'] };
  queue.enqueueDelegate(ctx, 'ws', input);
  input.repoSet.push('unexpected'); input.name = 'mutated';
  cfg.workspaces[0].defaultRootId = 'a'; cfg.workspaces[0].rootsRevision++;
  let drained;
  queue.bindDelegateRunner(async (_ctx, input) => { drained = input; const target = await resolve(input); assert.equal(target.cwd, b); return { notified: false }; });
  await queue.drainDelegateQueue('ws');
  assert.equal(drained.rootId, 'b'); assert.equal(drained.workspaceId, 'ws');
  assert.equal(drained.name, 'queued'); assert.deepEqual(drained.repoSet, ['plugin']);
  // Public multi-group delegation holds every root before its first await, then the queue owns the same snapshot.
  queue.resetDelegateQueueForTests();
  const { workspaceRootUsesFor } = require(path.join(repo, 'src/main/workspaceRootUses.ts'));
  const { workspaceRootDependencies } = require(path.join(repo, 'src/main/workspaceRootDependencies.ts'));
  require(path.join(repo, 'src/main/metaAgent/workspaceFile.ts')).patchWorkspaceFile(a, { maxConcurrentWorkers: 1 });
  delegatedCtx.sessions.listByWorkspace = () => Array.from({ length: 5 }, () => ({ type: 'terminal', lifecycle: 'working' }));
  const admissionGroups = [{ rootId: 'a', relativePath: '' }, { rootId: 'b', relativePath: '' }];
  const admission = delegate.delegateTask(delegatedCtx, { task: 'both sources', workspaceId: 'ws', rootId: 'a', isolate: true, isolationGroups: admissionGroups });
  assert.deepEqual(workspaceRootUsesFor(delegatedCtx.config).list('ws').map(use => use.rootId).sort(), ['a', 'b']);
  admissionGroups[1].rootId = 'mutated'; const multiQueued = await admission; assert.equal(multiQueued.queued, true);
  const dependencyCtx = { ...delegatedCtx, sessions: { ...delegatedCtx.sessions, rootDependencyRoster: () => rows }, tasks: { rootDependencyRoster: () => [] } };
  const queuedRoots = () => workspaceRootDependencies(dependencyCtx, cfg.workspaces[0]).filter(use => use.id === multiQueued.queueId).map(use => use.rootId).sort();
  assert.deepEqual(queuedRoots(), ['a', 'b']);
  const projection = queue.listDelegateSourceUses('ws'); projection[0].sourceRoots[1].rootId = 'mutated';
  assert.deepEqual(queuedRoots(), ['a', 'b']);
  cfg.workspaces[0].defaultRootId = 'b'; cfg.workspaces[0].roots.reverse(); cfg.workspaces[0].rootsRevision++;
  let finishMulti, shiftedInput;
  queue.bindDelegateRunner((_ctx, input) => { shiftedInput = input; return new Promise(resolve => { finishMulti = resolve; }); });
  delegatedCtx.sessions.listByWorkspace = () => [];
  const shifting = queue.drainDelegateQueue('ws');
  assert.equal(queue.listDelegateQueue('ws').length, 0); assert.deepEqual(queuedRoots(), ['a', 'b']);
  assert.equal(shiftedInput.rootId, 'a'); assert.deepEqual(shiftedInput.isolationGroups.map(group => group.rootId), ['a', 'b']);
  finishMulti({ notified: false }); await shifting; assert.deepEqual(queuedRoots(), []);
  // A second source moved while pending cannot silently redirect the admitted task.
  queue.enqueueDelegate(ctx, 'ws', { task: 'fixed sources', rootId: 'a', isolate: true, isolationGroups: [{ rootId: 'a', relativePath: '' }, { rootId: 'b', relativePath: '' }] });
  const rootB = cfg.workspaces[0].roots.find(root => root.id === 'b'); rootB.path = tree;
  const multiFailures = []; const unsubscribeMulti = queue.addDelegateDrainedListener((_id, _ws, result) => multiFailures.push(result));
  queue.bindDelegateRunner((_ctx, input) => delegate.delegateTask(delegatedCtx, input));
  const rowCount = rows.length; await queue.drainDelegateQueue('ws');
  assert.equal(multiFailures[0].ok, false); assert.match(multiFailures[0].error, /changed/); assert.equal(rows.length, rowCount);
  rootB.path = b; unsubscribeMulti(); queue.resetDelegateQueueForTests();
  queue.bindDelegateRunner(async (_ctx, input) => { await resolve(input); return { notified: false }; });
  queue.enqueueDelegate(ctx, 'ws', { task: 'second', rootId: 'b', isolate: false });
  cfg.workspaces[0].roots = [{ id: 'a', path: a }];
  const outcomes = [];
  queue.addDelegateDrainedListener((_q, _ws, outcome) => outcomes.push(outcome));
  await queue.drainDelegateQueue('ws');
  assert.equal(outcomes[0].ok, false); assert.match(outcomes[0].error, /source folder not found/);
  assert.equal(queue.listDelegateQueue('ws').length, 1, 'removed source fails visibly, never redirects');
  const closedWorkspace = cfg.workspaces.shift();
  await queue.drainDelegateQueue('ws');
  assert.match(outcomes.at(-1).error, /workspace not found/, 'closed workspace reaches queue failure callback');
  cfg.workspaces.unshift(closedWorkspace);

  if (process.platform === 'win32') {
    cfg.workspaces[0].roots.push({ id: 'b', path: b });
    const escape = path.join(b, 'escape'); fs.symlinkSync(tree, escape, 'junction');
    await assert.rejects(resolve({ workspaceId: 'ws', rootId: 'b', cwd: escape }), /outside/);
    const alias = path.join(tmp, 'alias'); fs.symlinkSync(b, alias, 'junction');
    assert.equal((await resolve({ workspaceId: 'ws', cwd: alias })).sourceRoot.rootId, 'b');
    const aliasWorkspace = { id: 'alias', path: alias, roots: [{ id: 'link', path: alias }], defaultRootId: 'link', controlRoot: alias };
    cfg.workspaces.push(aliasWorkspace);
    const pinned = await resolve({ workspaceId: 'alias' });
    fs.unlinkSync(alias); fs.symlinkSync(tree, alias, 'junction');
    await assert.rejects(resolve({ workspaceId: 'alias', capturedSource: pinned.sourceRoot }), /changed/);
  }
  // The real precheck IPC validates the requested revision and rechecks ownership
  // after Git awaits, so a removed source cannot yield a successful recommendation.
  const { registerSessionIpc } = require(path.join(repo, 'src/main/ipc/sessions.ts'));
  const { invokeIpcChannel } = require(path.join(repo, 'src/main/ipc/handle.ts'));
  cfg.workspaces[0] = { id: 'ws', path: a, roots: [{ id: 'a', path: a }, { id: 'b', path: b }], defaultRootId: 'b', controlRoot: a, rootsRevision: 9 };
  let ceiling;
  const precheckCtx = { config: { get }, sessions: { listByWorkspace: () => [], onSessionRemoved: () => () => {} }, resolveBubbleWorkspaceId: () => 'ws',
    runtimes: { get: () => undefined },
    git: { resolveMainRepoFor: async (_cwd, root) => { ceiling = root; return b; }, probeDirty: async () => false } };
  registerSessionIpc(precheckCtx);
  assert.deepEqual(await invokeIpcChannel('sessions:precheck', ['ws', 'b', 9]), { isolate: false, dirty: false });
  assert.equal(ceiling, b);
  await assert.rejects(invokeIpcChannel('sessions:precheck', ['ws', 'b', 8]), /changed/);
  precheckCtx.git.probeDirty = async () => { cfg.workspaces[0].roots.pop(); return false; };
  await assert.rejects(invokeIpcChannel('sessions:precheck', ['ws', 'b', 9]), /source folder not found/);
  cfg.workspaces[0].roots.push({ id: 'b', path: b });
  let publicCreate;
  precheckCtx.sessions = { ...delegatedCtx.sessions, list: () => [], listByWorkspace: () => Array.from({ length: 5 }, () => ({ type: 'terminal', lifecycle: 'working' })),
    createTerminal: async options => { publicCreate = options; return { id: 'public fixture' }; } };
  const publicGroups = [{ rootId: 'a', relativePath: '' }, { rootId: 'b', relativePath: '' }];
  await invokeIpcChannel('sessions:create', [{ workspaceId: 'ws', rootId: 'a', isolate: true, isolationGroups: publicGroups, capturedIsolationSources: [{ rootId: 'forged' }] }]);
  assert.deepEqual(publicCreate.isolationGroups, publicGroups); assert.equal(publicCreate.capturedIsolationSources, undefined);
  assert.equal(publicCreate.activate, undefined, 'existing create callers keep default activation');
  await invokeIpcChannel('sessions:create', [{ workspaceId: 'ws', rootId: 'a', activate: false }]);
  assert.equal(publicCreate.activate, false, 'split picker can create without replacing the primary pane');
  await invokeIpcChannel('sessions:create', [{ workspaceId: 'ws', runtime: 'codex', cliLaunchOptions: { model: 'test-model', permission: 'ask' } }]);
  assert.deepEqual(publicCreate.cliLaunchOptions, { model: 'test-model', permission: 'ask' }, 'blank-session IPC forwards CLI options');
  queue.resetDelegateQueueForTests(); publicCreate = undefined;
  precheckCtx.sessions.isChatRuntime = () => false;
  const publicQueued = await invokeIpcChannel('tasks:delegate', [{ workspaceId: 'ws', rootId: 'a', rootsRevision: 9, task: 'public queued', isolate: true,
    runtime: 'codex', cliLaunchOptions: { model: 'queued-model', permission: 'ask' },
    isolationGroups: publicGroups, skipConcurrencyQueue: true, capturedSource: { rootId: 'forged' }, capturedIsolationSources: [{ rootId: 'forged' }] }]);
  assert.equal(publicQueued.queued, true, 'public inputs cannot bypass host concurrency admission'); assert.equal(publicCreate, undefined);
  assert.deepEqual(queue.listDelegateSourceUses('ws')[0].sourceRoots.map(source => source.rootId), ['a', 'b']);
  let drainedCli;
  precheckCtx.sessions.listByWorkspace = () => [];
  queue.bindDelegateRunner(async (_ctx, input) => { drainedCli = input.cliLaunchOptions; return { notified: false }; });
  await queue.drainDelegateQueue('ws');
  assert.deepEqual(drainedCli, { model: 'queued-model', permission: 'ask' }, 'delegate IPC and queue preserve CLI options');
  queue.resetDelegateQueueForTests();
  Object.assign(precheckCtx, delegatedCtx);
  precheckCtx.sessions = { ...delegatedCtx.sessions, listByWorkspace: () => [],
    createTerminal: async options => { publicCreate = options; return delegatedCtx.sessions.createTerminal(options); },
    select: () => { throw new Error('split creation must not select the primary pane'); } };
  const splitTask = await invokeIpcChannel('tasks:delegate', [{ workspaceId: 'ws', rootId: 'b', rootsRevision: 9,
    task: 'split pane task', isolate: false, select: false }]);
  assert.ok(splitTask.session?.id); assert.equal(publicCreate.activate, false, 'delegate IPC preserves split background creation');
  console.log('[ok] session-source-targets');
} finally {
  queue.resetDelegateQueueForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
}
