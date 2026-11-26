/** Actual RuntimeHost scripts, session launch/relaunch, policy snapshots and PTY disposal. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { codexWorktreeFixture, fixtureGit } from './helpers/codex-worktree.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-workspace-'));
const fixtureBin = path.join(tmp, 'bin'); fs.mkdirSync(fixtureBin);
const pathVariable = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
const originalPath = process.env[pathVariable] ?? '';
for (const name of ['claude', 'codex', 'cursor-agent', 'gemini', 'opencode']) {
  fs.writeFileSync(path.join(fixtureBin, process.platform === 'win32' ? `${name}.cmd` : name),
    process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}
process.env[pathVariable] = fixtureBin + path.delimiter + originalPath;
const require = createRequire(import.meta.url); const ts = require('typescript'); const Module = require('node:module');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText
  // 源里含 import.meta（如 consoleProcessList 的 createRequire(import.meta.url)）会让 Node 24 的
  // 模块语法探测把 CJS 转译产物当 ESM 重跑（exports 未定义即崩）；CJS 等价物是 __filename。
  .replace(/\bimport\.meta\.url\b/g, '__filename'), filename);
const processes = []; const spawnCalls = [];
let beforeInteractiveSpawn;
const commandLine = call => typeof call.args === 'string' ? call.args : process.platform === 'win32' ? call.args[3] : call.args.join(' ');
const originalLoad = Module._load;
Module._load = function(request) {
  if (request === './interactiveOwner') return {
    InteractivePtyCancelledError: class extends Error {}, InteractivePtyStartupCleanupError: class extends AggregateError {},
    createOwnedInteractivePty(options) {
      let proc, complete;
      const completed = new Promise(resolve => { complete = resolve; });
      const ready = Promise.resolve().then(() => {
        beforeInteractiveSpawn?.();
        options.assertCurrent(); proc = options.spawn(options.launch);
        const exit = proc.exited;
        proc.exited = event => { options.commandExited?.(event.exitCode); exit(event); complete(event.exitCode); };
      });
      let closing;
      return { ready, completed, close() { return closing ??= ready.then(() => { proc.exited({ exitCode: 0 }); }, () => { complete(-1); }); } };
    }
  };
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  if (request === 'node-pty') return { spawn: (command, args, options) => {
    const proc = { pid: 0, writes: [], kills: 0, consoleLists: 0,
      _agent: { _getConsoleProcessList: async () => { proc.consoleLists++; return []; } },
      onData() {}, onExit(fn) { this.exited = fn; },
      kill() { this.kills++; void this._agent._getConsoleProcessList(); }, resize() {}, write(data) { this.writes.push(data); } };
    processes.push(proc); spawnCalls.push({ command, args, options }); return proc;
  } };
  return originalLoad.apply(this, arguments);
};
const { SessionsService } = require(path.join(repo, 'src/main/sessions.ts'));
const { PtyManager } = require(path.join(repo, 'src/main/pty/manager.ts'));
const { workspaceRootUsesFor } = require(path.join(repo, 'src/main/workspaceRootUses.ts'));
const { captureWorkspaceExecutionContext } = require(path.join(repo, 'src/main/workspaceExecutionContext.ts'));
const submit = require(path.join(repo, 'src/main/pty/submit.ts'));
const originalSubmit = submit.typeAndSubmit;
const deliveries = [];
submit.typeAndSubmit = async (...args) => { deliveries.push(args); return { typed: args[2].length, submits: 1, flat: args[2] }; };
const compile = createSharedCompiler(repo, path.join(tmp, 'compiled'));
const { RuntimeHost } = await import(pathToFileURL(compile('main/runtime/host.ts')));
const runtimes = new RuntimeHost({ userDataDir: path.join(tmp, 'ud'), builtinsDir: path.join(repo, 'src/main/runtime/builtins') });
await runtimes.ensureSeeded();
await runtimes.update('claude-code', { enabled: true });
// This suite checks CLI argv/workspace binding with a fake PTY, not vendor servers.
// Actual native transports have process-level coverage in builtin-native-communication.
const resolveCommand = runtimes.resolveLaunch.bind(runtimes);
const activityBindings = [];
const activitySignals = [];
const handleBindings = [];
let nextLaunchWarning;
runtimes.resolveLaunch = async (...args) => {
  args[6] = true;
  const launch = await resolveCommand(...args);
  if (args[7]) {
    assert.equal(args[7].MUSTER_SESSION_TOKEN, 'fixture-worker'); launch.processIds = [1234];
    launch.onActivity = listener => { activityBindings.push(listener); return () => {}; };
    launch.onSessionId = listener => { handleBindings.push(listener); return () => {}; };
    if (nextLaunchWarning) launch.warning = nextLaunchWarning;
  }
  return launch;
};
const a = path.join(tmp, 'a'); const b = path.join(tmp, '源 B'); const c = path.join(tmp, 'c'); const tree = path.join(tmp, 'task-tree');
for (const dir of [a, b, c, tree]) fs.mkdirSync(dir);
const workspace = { id: 'ws', name: 'CLI workspace', path: b, controlRoot: a, defaultRootId: 'b', rootsRevision: 1,
  roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
const cfg = { workspaces: [workspace], activeWorkspaceId: 'ws', defaultRuntime: 'claude-code', agentRules: [{ id: 'fixture', text: 'CLI workspace rule', enabled: true }] };
const config = { get: () => cfg }; const rootUses = workspaceRootUsesFor(config);
const s = { id: 'cli', name: 'CLI', type: 'terminal', launchKind: 'agent', runtime: 'claude-code', workspaceId: 'ws', cwd: b,
  configurePermissions: true,
  cliLaunchOptions: { model: 'test-model', permission: 'edits', reasoning: 'high' },
  sourceRoot: { rootId: 'b', path: b, cwd: b } };
const rows = [s]; const ptyMgr = new PtyManager(() => null); const launchErrors = [];
const auxiliaryLeases = new Set();
ptyMgr.getHostEnv = () => ({ MUSTER_SESSION_TOKEN: 'fixture-worker' });
ptyMgr.onAuxiliaryPids = (id, pids) => {
  assert.equal(id, 'cli'); assert.deepEqual(pids, [1234]);
  const lease = {}; auxiliaryLeases.add(lease); return () => auxiliaryLeases.delete(lease);
};
const launcher = { config, sessions: rows, runtimes, ptyMgr, launchGen: new Map(), launchTasks: new Map(), classifyBySession: new Map(),
  applyLifecycle: (session, next) => { session.lifecycle = next; },
  applyActivitySignal: (id, kind, event) => { activitySignals.push({ id, kind, event }); },
  isChatRuntime: () => false, ensureStatusToken() {}, persist() {}, broadcast() {}, getWindow: () => null,
  workspaceIdFor: row => row.workspaceId, notify: { push: notice => launchErrors.push(notice) },
  sweepInjectFiles() {}, scheduleInjectFileDelete() {}, deferTypePrompt: async () => {},
  injectStrategy: async () => 'relaunch-resume',
  launchTerminal: SessionsService.prototype.launchTerminal,
  updateRuntimeHandle: SessionsService.prototype.updateRuntimeHandle,
  bumpLaunchGen: SessionsService.prototype.bumpLaunchGen, isCurrentLaunch: SessionsService.prototype.isCurrentLaunch,
  getCliWorkspaceContext: SessionsService.prototype.getCliWorkspaceContext
};
try {
  const context = captureWorkspaceExecutionContext(cfg, s);
  const upgraded = new RuntimeHost({ userDataDir: path.join(tmp, 'upgrade-ud'), builtinsDir: path.join(repo, 'src/main/runtime/builtins') });
  const upgradeScripts = path.join(upgraded.rootDir, 'scripts'); fs.mkdirSync(upgradeScripts, { recursive: true });
  const oldRegistry = JSON.parse(fs.readFileSync(path.join(repo, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  const nativeIds = ['claude-code', 'codex', 'cursor-cli', 'gemini'];
  oldRegistry.runtimes = oldRegistry.runtimes.filter(entry => nativeIds.includes(entry.id));
  for (const entry of oldRegistry.runtimes) {
    entry.builtinScriptVersion--; entry.label = `User ${entry.id}`; entry.extraArgs = ['--user-option'];
    fs.writeFileSync(path.join(upgradeScripts, entry.script), 'export async function allocate(){return {sessionId:"old"}};export function resolveLaunch(){return {command:"node",args:[]}}');
  }
  fs.writeFileSync(path.join(upgraded.rootDir, 'registry.json'), JSON.stringify(oldRegistry));
  await upgraded.ensureSeeded();
  for (const id of nativeIds) {
    assert.equal((await upgraded.prepareWorkspaceDirectories(id, context)).args[1], a);
    assert.equal(upgraded.get(id).label, `User ${id}`); assert.deepEqual(upgraded.get(id).extraArgs, ['--user-option']);
  }
  for (const id of ['claude-code', 'codex', 'cursor-cli', 'gemini']) {
    const options = await runtimes.prepareWorkspaceDirectories(id, context);
    assert.deepEqual(options.args, [id === 'gemini' ? '--include-directories' : '--add-dir', a]);
    const extra = [...options.args]; await runtimes.appendPrompt(id, 'fixture task', extra);
    const resolved = await runtimes.resolveLaunch(id, 'start', 'fixture-id', b, extra);
    const command = process.platform === 'win32' ? resolved.args[3] : resolved.args.join(' ');
    assert.ok(command.includes(options.args[0])); assert.ok(command.includes(a));
    if (extra.includes('--')) assert.ok(command.indexOf(options.args[0]) < command.indexOf(' -- '), 'directory flag stays before prompt separator');
  }
  assert.equal((await runtimes.prepareWorkspaceDirectories('opencode', context)).args.length, 0);
  const many = { ...context, writableDirectories: [context.writableDirectories[1], ...Array.from({ length: 6 }, (_, i) => ({ path: path.join(tmp, `extra${i}`), physicalPath: '' }))] };
  await assert.rejects(runtimes.prepareWorkspaceDirectories('gemini', many), /at most 5/);
  await assert.rejects(runtimes.prepareWorkspaceDirectories('gemini', { ...context, writableDirectories: [{ path: path.join(tmp, 'a,b'), physicalPath: '' }] }), /comma/);
  const isolated = captureWorkspaceExecutionContext(cfg, { ...s, cwd: tree, worktreePath: tree, worktreeSource: { mainRepo: b } });
  assert.deepEqual((await runtimes.prepareWorkspaceDirectories('codex', isolated)).args, [], 'isolated source roots never become writable CLI flags');
  console.log('ok: actual seeded native flags, prompt ordering, Gemini limits and isolation');

  let enterAllocate; let releaseAllocate;
  const entered = new Promise(resolve => { enterAllocate = resolve; });
  const gate = new Promise(resolve => { releaseAllocate = resolve; });
  runtimes.allocate = async () => { enterAllocate(); await gate; return 'fixture-id'; };
  nextLaunchWarning = 'fixture initial identity warning';
  const launching = SessionsService.prototype.launchTerminal.call(launcher, s, 'start', undefined, undefined, true);
  assert.deepEqual(rootUses.list('ws').map(use => use.rootId), ['a', 'b'], 'all roots held before first await');
  await entered;
  workspace.roots.push({ id: 'c', path: c }); workspace.defaultRootId = 'a'; workspace.path = a; workspace.rootsRevision++;
  releaseAllocate(); await launching;
  nextLaunchWarning = undefined;
  assert.equal(launchErrors.at(-1)?.text, 'fixture initial identity warning', 'unsupported identity isolation is visible after initial launch');
  launchErrors.length = 0;
  assert.equal(auxiliaryLeases.size, 1, 'owned backend identity is bound for the launched worker');
  activityBindings[0]('idle', 'codex-turn');
  assert.deepEqual(activitySignals, [{ id: 'cli', kind: 'idle', event: 'codex-turn' }]);
  assert.equal(spawnCalls.length, 1); assert.equal(spawnCalls[0].options.cwd, b);
  assert.match(commandLine(spawnCalls[0]), /--model test-model/);
  assert.match(commandLine(spawnCalls[0]), /--permission-mode acceptEdits/);
  assert.match(commandLine(spawnCalls[0]), /--effort high/);
  assert.ok(commandLine(spawnCalls[0]).includes(a)); assert.ok(!commandLine(spawnCalls[0]).includes(c), 'in-flight root addition does not widen flags');
  const first = launcher.getCliWorkspaceContext('cli'); assert.deepEqual(first.workspaceContext.roots.map(root => root.rootId), ['a', 'b']);
  const { uploadScope } = require(path.join(repo, 'src/main/browser/uploadScope.ts'));
  const { runAsAgentSession } = require(path.join(repo, 'src/main/agent/agentScope.ts'));
  const token = {}, uploadCtx = { config, sessions: { peek: () => s, sessionScopeToken: () => token,
    isChatRuntime: () => false, getCliWorkspaceContext: id => launcher.getCliWorkspaceContext(id) },
  agentSessions: { getWorkspaceContext: () => captureWorkspaceExecutionContext(cfg, s) } };
  const firstUploadScope = await runAsAgentSession('cli', async () => uploadScope(uploadCtx));
  assert.deepEqual(firstUploadScope.dirs, first.workspaceContext.readableDirectories);
  assert.equal(firstUploadScope.dirs.some(dir => dir.path === c), false, 'a root added during launch cannot widen the existing CLI tool scope');
  const firstPrompt = fs.readFileSync(commandLine(spawnCalls[0]).match(/请使用 UTF-8 编码读取并立即执行任务文件：([^"\s]+)/)[1], 'utf8');
  assert.ok(firstPrompt.includes(JSON.stringify(b))); assert.ok(firstPrompt.includes(JSON.stringify(a))); assert.ok(!firstPrompt.includes(JSON.stringify(c)));
  assert.ok(firstPrompt.includes('does not intercept native CLI file tools'), '任务简报声明宿主不拦原生 CLI 文件工具（assignment 版文案，已英文化）');
  assert.match(firstPrompt, /CLI workspace rule/);
  assert.match(firstPrompt, /MUSTER_STATUS_URL/);
  assert.doesNotMatch(firstPrompt, /HOST(?:-EXT)?\.md|managed-rules/);

  runtimes.checkTerminalResume = async (runtime, cwd, id) => {
    assert.equal(runtime, 'claude-code');
    assert.equal(cwd, b);
    return { status: id === 'fixture-id' ? 'attempt' : 'unbound' };
  };
  const savedHandle = s.externalSessionId;
  delete s.externalSessionId;
  const allocateAfterStart = runtimes.allocate;
  runtimes.allocate = async () => { assert.fail('prompt relaunch must never allocate a conversation'); };
  await assert.rejects(SessionsService.prototype.relaunchWithPrompt.call(launcher, 'cli', 'unbound task'), /尚未绑定原生会话/);
  assert.equal(s.externalSessionId, undefined);
  assert.equal(spawnCalls.length, 1);
  assert.equal(launcher.getCliWorkspaceContext('cli'), first);
  assert.equal(ptyMgr.isRunning('cli'), true);
  runtimes.allocate = allocateAfterStart;
  handleBindings[0](savedHandle);
  assert.equal(s.externalSessionId, savedHandle, 'the still-running PTY can finish binding its native ID');
  launchErrors.length = 0;

  nextLaunchWarning = 'fixture runtime identity warning';
  const relaunched = await SessionsService.prototype.relaunchWithPrompt.call(launcher, 'cli', 'new task');
  nextLaunchWarning = undefined;
  assert.equal(launchErrors.at(-1)?.text, 'fixture runtime identity warning', 'unsupported identity isolation is visible after relaunch');
  launchErrors.length = 0;
  const second = launcher.getCliWorkspaceContext('cli'); assert.notEqual(second, first);
  handleBindings[0]('stale-handle');
  assert.equal(s.externalSessionId, savedHandle, 'a retired PTY cannot change the restored handle');
  assert.throws(() => firstUploadScope.assertCurrent(), /no longer current/, 'relaunch invalidates the original CLI tool scope');
  const cliUploadScope = await runAsAgentSession('cli', async () => uploadScope(uploadCtx));
  assert.equal(cliUploadScope.cwd, second.workspaceContext.cwd);
  assert.deepEqual(cliUploadScope.dirs, second.workspaceContext.readableDirectories);
  activityBindings[0]('active', 'codex-turn');
  assert.equal(activitySignals.length, 1, 'a replaced launch cannot change the new session');
  activityBindings[1]('active', 'codex-turn');
  assert.equal(activitySignals.length, 2, 'relaunch is bound to its own native activity');
  s.activity = { kind: 'blocked' };
  activityBindings[1]('active', 'codex-turn-heartbeat');
  assert.equal(activitySignals.length, 2, 'a heartbeat cannot erase an approval wait');
  delete s.activity;
  assert.equal(auxiliaryLeases.size, 1, 'relaunch waits actual old process closure before creating the replacement');
  assert.deepEqual(second.workspaceContext.roots.map(root => root.rootId), ['a', 'b', 'c']);
  assert.equal(spawnCalls[1].options.cwd, b); assert.ok(commandLine(spawnCalls[1]).includes(c));
  assert.match(commandLine(spawnCalls[1]), /--model test-model/);
  assert.match(commandLine(spawnCalls[1]), /--permission-mode acceptEdits/);
  assert.ok(fs.readFileSync(relaunched.injectFile, 'utf8').includes(JSON.stringify(c)));
  assert.equal(rootUses.list('ws').length, 3, 'old roots release only after the awaited old process exit');
  processes[0].exited({ exitCode: 0 });
  assert.equal(auxiliaryLeases.size, 1, 'old backend identity releases with its own launch');
  assert.equal(rootUses.list('ws').length, 3); assert.equal(launcher.getCliWorkspaceContext('cli'), second, 'late old process exit cannot erase new scope');
  ptyMgr.kill('cli'); assert.equal(rootUses.list('ws').length, 3, 'asynchronous kill does not release early');
  processes[1].exited({ exitCode: 0 }); assert.equal(rootUses.list('ws').length, 0); assert.equal(launcher.getCliWorkspaceContext('cli'), undefined);
  assert.throws(() => cliUploadScope.assertCurrent(), /no longer current/, 'actual PTY disposal invalidates upload authority');
  assert.equal(auxiliaryLeases.size, 0, 'all backend identity leases release at actual exit');
  console.log('ok: capture before await, immutable in-flight scope, restart refresh and actual PTY exit ownership');

  // M-10：relaunch 失败必须把会话从 starting 写回 exited 并留 launchError——否则 UI 永远
  // 停在 starting（旧 pty 已 kill，无退出回调可救）
  {
    s.status = 'running'; s.lifecycle = 'running';
    const origResolveLaunch = runtimes.resolveLaunch.bind(runtimes);
    runtimes.resolveLaunch = async (id, mode) => {
      if (mode === 'resume') throw new Error('resolveLaunch boom');
      return origResolveLaunch(id, mode);
    };
    try {
      await assert.rejects(
        () => SessionsService.prototype.relaunchWithPrompt.call(launcher, 'cli', '失败简报'),
        /resolveLaunch boom/
      );
    } finally {
      runtimes.resolveLaunch = origResolveLaunch;
    }
    assert.equal(s.status, 'exited', 'M-10：失败写回 exited（不留 starting 假活）');
    assert.equal(s.lifecycle, 'exited');
    assert.match(String(s.meta?.launchError ?? ''), /resolveLaunch boom/, 'launchError 留痕');
    assert.equal(launcher.launchTasks.size, 0, 'launchTasks 已清');
    assert.equal(launchErrors.at(-1)?.text, 'resolveLaunch boom');
    launchErrors.length = 0;
  }

  // A removed non-cwd root also invalidates an in-flight launch, rather than being silently authorized.
  delete s.externalSessionId;
  runtimes.allocate = async () => { workspace.roots = workspace.roots.filter(root => root.id !== 'c'); return 'late'; };
  await SessionsService.prototype.launchTerminal.call(launcher, s, 'start');
  assert.equal(spawnCalls.length, 2); assert.match(s.meta.launchError, /source folder not found/);
  assert.equal(rootUses.list('ws').length, 0); assert.equal(launchErrors.length, 1);
  console.log('ok: non-cwd source removal rejects spawn and releases every pending root');

  const { beginCliWorkspaceContext } = require(path.join(repo, 'src/main/sessions/cliWorkspaceContext.ts'));
  const { sessionCaptureDirectory } = require(path.join(repo, 'src/main/desktop/sessionCaptureAccess.ts'));
  const captureLease = beginCliWorkspaceContext(config, s, rows, path.join(tmp, 'ud'));
  assert.ok(captureLease.workspaceContext.readableDirectories.some(dir => dir.path === sessionCaptureDirectory(path.join(tmp, 'ud'), s.id)));
  assert.ok(!captureLease.workspaceContext.writableDirectories.some(dir => dir.path === sessionCaptureDirectory(path.join(tmp, 'ud'), s.id)));
  captureLease.dispose();
  let releasedNative = 0;
  const abandoned = beginCliWorkspaceContext(config, s, rows);
  abandoned.own(() => { releasedNative++; });
  abandoned.finishLaunch(); abandoned.dispose();
  assert.equal(releasedNative, 1, 'superseded / failed preparation releases its provider once');
  const liveLease = beginCliWorkspaceContext(config, s, rows);
  liveLease.own(() => { releasedNative++; });
  await ptyMgr.spawn('native-resource', { command: 'node', args: [], env: { NATIVE_TEST_TOKEN: 'fixture-only' } }, b, 100, 20, liveLease.dispose);
  liveLease.commit('native transport', undefined, '\x1b'); liveLease.finishLaunch();
  assert.equal(spawnCalls.at(-1).options.env.NATIVE_TEST_TOKEN, 'fixture-only');
  assert.equal(releasedNative, 1, 'successful launch retains resources');
  processes.at(-1).exited({ exitCode: 0 }); liveLease.dispose();
  assert.equal(releasedNative, 2, 'actual process exit releases its provider');
  await new Promise(resolve => setImmediate(resolve));
  const naturallyExited = processes.at(-1);
  assert.equal(naturallyExited.kills, 1, 'natural exit closes its remaining PTY / conhost handles');
  assert.equal(naturallyExited.consoleLists, process.platform === 'win32' ? 0 : 1, 'dead Windows PIDs must not invoke AttachConsole');
  ptyMgr.kill('native-resource'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(naturallyExited.kills, 1, 'closing an exited tab cannot dispose a native PTY twice');
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const platform of ['win32', 'darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const args = ['/d', '/s', '/c', 'tool --remote "ws://127.0.0.1:1" --dir "path with spaces"'];
      await ptyMgr.spawn(`platform-${platform}`, { command: 'fixture', args, windowsVerbatimArguments: true }, b);
      assert.deepEqual(spawnCalls.at(-1).args, platform === 'win32' ? args.join(' ') : args);
      assert.equal(spawnCalls.at(-1).options.useConptyDll, undefined, 'keep the existing PTY backend on all platforms');
      processes.at(-1).exited({ exitCode: 0 });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(processes.at(-1).consoleLists, platform === 'win32' ? 0 : 1);
    }
  } finally { Object.defineProperty(process, 'platform', platformDescriptor); }

  await ptyMgr.spawn('delivery', { command: 'node', args: [] }, b);
  const firstDesktopGeneration = ptyMgr.desktopProcessGeneration('delivery');
  assert.ok(firstDesktopGeneration, 'a running PTY has a host-owned desktop process generation');
  const writer = ptyMgr.captureWriter('delivery'); const oldProcess = processes.at(-1);
  const delivery = originalSubmit({ write: (id, data) => {
    const written = writer.write(id, data);
    if (data !== '\r') ptyMgr.spawn(id, { command: 'node', args: [] }, b);
    return written;
  } }, 'delivery', 'old task file', { afterTypeMs: 1, enterGapMs: 1 });
  await assert.rejects(delivery, /提交失败/);
  assert.deepEqual(oldProcess.writes, ['old task file']);
  assert.deepEqual(processes.at(-1).writes, [], 'Enter cannot land in a replacement process');
  assert.notEqual(ptyMgr.desktopProcessGeneration('delivery'), firstDesktopGeneration, 'a replacement PTY cannot reuse the desktop process generation');
  assert.equal(writer.write('delivery', 'late task'), false);
  console.log('ok: real typeAndSubmit refuses a process replaced between text and Enter');

  const shell = { ...s, id: 'shell-fixture', name: 'Shell fixture', launchKind: 'shell',
    shellProfileId: process.platform === 'win32' ? 'powershell' : 'bash', status: 'starting', lifecycle: 'starting' };
  rows.push(shell); launcher.launchShellSession = SessionsService.prototype.launchShellSession;
  await SessionsService.prototype.launchTerminal.call(launcher, shell, 'start');
  const shellLease = launcher.getCliWorkspaceContext(shell.id);
  assert.ok(shellLease?.workspaceContext, 'actual shell launch owns a captured directory lease');
  const shellToken = {}, shellCtx = { config, sessions: { peek: () => shell, sessionScopeToken: () => shellToken,
    isChatRuntime: () => true, getCliWorkspaceContext: id => launcher.getCliWorkspaceContext(id) },
    agentSessions: { getWorkspaceContext: () => { throw new Error('shell must not use GUI scope'); } } };
  const shellScope = await runAsAgentSession(shell.id, async () => uploadScope(shellCtx));
  assert.deepEqual(shellScope.dirs, shellLease.workspaceContext.readableDirectories);
  processes.at(-1).exited({ exitCode: 0 });
  assert.equal(launcher.getCliWorkspaceContext(shell.id), undefined);
  assert.throws(() => shellScope.assertCurrent(), /no longer current/);
  console.log('ok: shell launch binds and releases its captured host-tool scope');
  const profiles = require(path.join(repo, 'src/main/shell/profiles.ts'));
  const originalShellResolver = profiles.resolveShellLaunchAsync;
  let shellStarted, releaseShell;
  const shellStartedPromise = new Promise(resolve => { shellStarted = resolve; });
  profiles.resolveShellLaunchAsync = () => { shellStarted(); return new Promise(resolve => { releaseShell = resolve; }); };
  const staleShell = { ...shell, id: 'stale-shell', name: 'Stale shell' }; rows.push(staleShell);
  try {
    const before = spawnCalls.length;
    const pendingShell = SessionsService.prototype.launchTerminal.call(launcher, staleShell, 'start');
    await shellStartedPromise;
    launcher.bumpLaunchGen(staleShell.id);
    releaseShell({ command: 'fixture-shell', args: [] }); await pendingShell;
    assert.equal(spawnCalls.length, before, 'replaced shell launch must not spawn after its async resolver returns');
    assert.equal(launcher.getCliWorkspaceContext(staleShell.id), undefined);
    assert.equal(rootUses.list('ws').length, 0, 'superseded shell releases its pending root leases');
  } finally { profiles.resolveShellLaunchAsync = originalShellResolver; }

  const taskTree = path.join(tmp, 'isolated Codex');
  const codex = { ...s, ...codexWorktreeFixture(b, taskTree, 'b'), id: 'codex-isolated-fixture', runtime: 'codex',
    externalSessionId: undefined, cliLaunchOptions: undefined };
  rows.push(codex);
  runtimes.allocate = async (id, cwd) => {
    assert.equal(id, 'codex');
    assert.equal(cwd, taskTree, 'the built-in attempt must install hooks in the task checkout');
    return 'codex-pending-isolated-fixture';
  };
  const previousResolver = runtimes.resolveLaunch;
  runtimes.resolveLaunch = async (id, mode, token, cwd, args, fork, probe, env, options, isolatedWorktree) => {
    assert.equal(id, 'codex');
    assert.equal(cwd, taskTree);
    assert.equal(isolatedWorktree, true);
    return resolveCommand(id, mode, token, cwd, args, fork, probe, undefined, options, isolatedWorktree);
  };
  try {
    const before = spawnCalls.length;
    await launcher.launchTerminal(codex, 'start');
    assert.equal(spawnCalls.length, before + 1);
    assert.equal(spawnCalls.at(-1).options.cwd, taskTree);
    assert.ok(commandLine(spawnCalls.at(-1)).includes(`--cd ${process.platform === 'win32' ? `"${taskTree}"` : taskTree}`));
    assert.equal(codex.cwd, b, 'session registration still refers to the source checkout');
    assert.equal(fixtureGit(taskTree, 'branch', '--show-current'), codex.worktreeBranch);
    processes.at(-1).exited({ exitCode: 0 });
    beforeInteractiveSpawn = () => fixtureGit(taskTree, 'switch', '-qc', 'another-branch');
    await launcher.launchTerminal(codex, 'start');
    beforeInteractiveSpawn = undefined;
    assert.equal(spawnCalls.length, before + 1);
    assert.match(launchErrors.at(-1).text, /branch changed/);
    const missing = path.join(tmp, 'missing legacy tree');
    const legacyCodex = { ...codex, cwd: missing, worktreePath: missing, worktreeGroups: undefined };
    const { healMissingSessionWorktree } = require(path.join(repo, 'src/main/git/worktreeSessionOps.ts'));
    assert.throws(() => healMissingSessionWorktree({ ...launcher, git: {} }, legacyCodex), /missing legacy tree/);
    assert.equal(legacyCodex.cwd, missing);
    assert.equal(legacyCodex.worktreePath, missing);
  } finally { runtimes.resolveLaunch = previousResolver; }
} finally {
  ptyMgr.killAll(); for (const proc of processes) proc.exited?.({ exitCode: 0 });
  process.env[pathVariable] = originalPath;
  submit.typeAndSubmit = originalSubmit;
  Module._load = originalLoad;
}
console.log('cli-workspace-context: OK');
