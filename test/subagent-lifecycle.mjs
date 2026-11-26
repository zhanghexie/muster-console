/** Real SessionsService archive/delete methods; controlled resource cleanup, no user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-lifecycle-'));
const originalLoad = Module._load;
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
try {
  const { SessionsService } = require(path.join(root, 'src/main/sessions.ts'));
  const { beginTaskWorktreeOperation } = require(path.join(root, 'src/main/git/worktreeTaskOperation.ts'));
  const row = (id, parentSessionId, archived = false) => ({ id, parentSessionId, archived, pinned: true,
    type: 'terminal', runtime: 'pi', workspaceId: 'w', name: id, cwd: tmp, lifecycle: 'working', status: 'running' });
  function setup() {
    const cfg = { activeWorkspaceId: 'w', workspaces: [{ id: 'w', path: tmp }] };
    const service = Object.create(SessionsService.prototype), released = [], removed = [];
    Object.assign(service, { config: { get: () => cfg },
      sessions: [row('p'), row('c', 'p'), row('g', 'c'), row('sibling', 'p'), row('old', 'c', true), row('other')],
      activeId: 'g', removedListeners: [], subtreeCloseWaiters: new Map(),
      launchTasks: new Map(), launchGen: new Map(), classifyBySession: new Map(), ptyWorkingSince: new Map(),
      get: id => service.sessions.find(s => s.id === id), persist() {}, broadcast() {}, rememberEnded() {},
      notify: { push() {} }, notifyBus: { clearSession() {} }, awareness: null,
      resolveWorkspaceId: () => 'w', isChatRuntime: () => false,
      ptyMgr: { isRunning: () => true, kill() {}, async killAndWait() {} },
      applyLifecycle(s, next) { s.lifecycle = next; assert.equal(service.get('p')?.archived, true, '子退出前父须先归档'); },
      archiveReleaseThenCleanup: async s => { released.push(s.id); }
    });
    service.onSessionRemoved(s => removed.push(s.id));
    return { service, released, removed };
  }
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  {
    const { service, released } = setup();
    // 子可先单独归档，断言仅针对本枝（退出回调不应要求父已归档）。
    service.applyLifecycle = (s, next) => { s.lifecycle = next; };
    service.setArchived('c', true);
    for (const id of ['c', 'g', 'old']) assert.equal(service.get(id).archived, true);
    for (const id of ['p', 'sibling', 'other']) assert.equal(service.get(id).archived, false);
    await tick();
    assert.deepEqual(released, ['g', 'c'], '已单独归档的子不重复清理');
    service.setArchived('p', true);
    for (const id of ['p', 'c', 'g', 'sibling', 'old']) assert.equal(service.get(id).archived, true);
    assert.equal(service.get('other').archived, false);
    assert.equal(service.activeId, 'other');
    assert.equal(service.get('p').pinned, undefined);
    await tick();
    service.setArchived('p', false);
    assert.equal(service.get('c').archived, true, '恢复父不擅自恢复已归档子');
  }
  {
    const { service, removed } = setup();
    service.applyLifecycle = (s, next) => { s.lifecycle = next; };
    service.setArchived('c', true); await tick(); service.close('c'); await tick();
    assert.deepEqual(removed, ['g', 'old', 'c']);
    assert.deepEqual(service.sessions.map(s => s.id), ['p', 'sibling', 'other']);
    service.setArchived('p', true); await tick(); service.close('p'); await tick();
    assert.deepEqual(service.sessions.map(s => s.id), ['other']);
  }
  {
    const { service, removed } = setup();
    for (const s of service.sessions) s.archived = true;
    const original = service.closeOne.bind(service);
    service.closeOne = (id, opts) => { if (id !== 'g') original(id, opts); };
    service.close('p');
    assert.ok(service.get('p') && service.get('c') && service.get('g'), '后代残留时保留父链');
    assert.equal(service.get('p').lifecycle, 'exited', '等待后代也须停止父进程');
    assert.ok(service.get('other'));
    original('g', { allowUnarchived: true }); await tick();
    assert.equal(service.get('c'), undefined); assert.equal(service.get('p'), undefined);
    assert.ok(removed.indexOf('g') < removed.indexOf('c') && removed.indexOf('c') < removed.indexOf('p'));
    assert.equal(service.subtreeCloseWaiters.size, 0);
  }
  {
    const { service, removed } = setup();
    for (const s of service.sessions) s.archived = true;
    const op = beginTaskWorktreeOperation(service.config, 'g', 'integrate');
    assert.throws(() => service.close('p'), /already running/);
    assert.deepEqual(removed, []); op.release();
    assert.equal(service.sessions.length, 6);
  }
  {
    const { service, released, removed } = setup();
    const op = beginTaskWorktreeOperation(service.config, 'g', 'integrate');
    assert.throws(() => service.setArchived('p', true), /already running/);
    assert.equal(service.get('p').archived, false);
    assert.equal(service.get('c').archived, false);
    assert.deepEqual(released, []); assert.deepEqual(removed, []); op.release();
    service.setArchived('p', true); // 默认退出回调同时验证父先标归档，不再唤醒父。
    assert.equal(service.get('g').archived, true);
  }
  console.log('subagent-lifecycle: cascade archive/delete, isolated child, deferred cleanup and preflight passed');
} finally { Module._load = originalLoad; fs.rmSync(tmp, { recursive: true, force: true }); }
