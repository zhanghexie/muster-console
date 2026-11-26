/** Actual launch generation/lifecycle code; runtime allocation and process boundary are controlled. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const root = process.cwd(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-recovery-'));
const load = Module._load;
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file
}).outputText, file);
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return load.apply(this, arguments);
};
try {
  const { SessionsService } = require(path.join(root, 'src/main/sessions.ts'));
  const cfg = { activeWorkspaceId: 'w', defaultRuntime: 'test-cli', workspaces: [{ id: 'w', path: tmp,
    roots: [{ id: 'source', path: tmp }], defaultRootId: 'source', controlRoot: tmp, rootsRevision: 1 }] };
  const session = { id: 'child', type: 'terminal', name: 'child', runtime: 'test-cli', cwd: tmp,
    workspaceId: 'w', lifecycle: 'starting', status: 'starting', createdAt: 1 };
  const service = Object.create(SessionsService.prototype), events = [], notices = [], spawned = [];
  Object.assign(service, { config: { get: () => cfg }, sessions: [session],
    launchGen: new Map(), launchTasks: new Map(), ptyWorkingSince: new Map(),
    lifecycleListeners: [(_s, prev, next) => events.push([prev, next])],
    isChatRuntime: () => false, ensureStatusToken() {}, persist() {}, broadcast() {}, emitSessionFactKind() {}, getWindow: () => null,
    notify: { push: n => notices.push(n) }, ptyMgr: { spawn: async (...args) => { spawned.push(args); return 'fixture-generation'; }, desktopProcessGeneration: () => 'fixture-generation', killAndWait: async () => {} },
    runtimes: { get: () => ({ enabled: true }), prepareWorkspaceDirectories: async () => ({ args: [], note: 'test' }),
      allocate: async () => { throw new Error('controlled start failure'); }, resolveLaunch: async () => ({ command: 'test', args: [] }) }
  });
  await service.launchTerminal(session, 'start');
  assert.equal(session.status, 'exited'); assert.match(session.meta.launchError, /controlled start failure/);
  assert.deepEqual(events, [['starting', 'exited']], '启动失败必须经过真正的生命周期边沿，父会话才收到原因');
  assert.equal(notices.length, 1);
  session.status = 'starting'; session.lifecycle = 'starting';
  service.runtimes.allocate = async () => 'recovered';
  await service.launchTerminal(session, 'start');
  assert.equal(session.status, 'running'); assert.equal(session.meta.launchError, undefined);
  assert.equal(spawned.length, 1);

  // Two overlapping starts: the superseded allocation rejects after the replacement succeeds.
  session.externalSessionId = undefined; session.status = 'starting';
  let rejectOld, entered;
  const allocated = new Promise(resolve => { entered = resolve; });
  service.runtimes.allocate = () => { entered(); return new Promise((_resolve, reject) => { rejectOld = reject; }); };
  const old = service.launchTerminal(session, 'start'); await allocated;
  service.runtimes.allocate = async () => 'replacement';
  await service.launchTerminal(session, 'start');
  rejectOld(new Error('late superseded failure')); await old;
  assert.equal(session.status, 'running', '过期启动失败不能覆盖已恢复会话');
  assert.equal(session.meta.launchError, undefined); assert.equal(notices.length, 1);
  assert.equal(spawned.length, 2);
  console.log('session-launch-recovery: real failure edge, original-session recovery and stale rejection passed');
} finally { Module._load = load; fs.rmSync(tmp, { recursive: true, force: true }); }
