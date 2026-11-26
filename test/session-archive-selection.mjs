/** Real SessionsService archive selection, with resource cleanup isolated from user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-selection-'));
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
  const row = (id, createdAt, extra = {}) => ({ id, name: id, type: 'terminal', launchKind: 'agent',
    runtime: 'pi', workspaceId: 'w', createdAt, cwd: tmp, lifecycle: 'idle', status: 'running', ...extra });
  function setup(rows, activeId) {
    const service = Object.create(SessionsService.prototype);
    Object.assign(service, {
      sessions: rows, activeId, config: { get: () => ({ activeWorkspaceId: 'w', workspaces: [{ id: 'w', path: tmp }] }) },
      lastActiveByWs: new Map([['w', activeId]]),
      launchTasks: new Map(), launchGen: new Map(), classifyBySession: new Map(),
      get: id => service.sessions.find(s => s.id === id), persist() {}, broadcast() {},
      isChatRuntime: () => true,
      resolveWorkspaceId: () => 'w', ptyMgr: { isRunning: () => false, kill() {} },
      applyLifecycle(s, next) { s.lifecycle = next; }, archiveReleaseThenCleanup: async () => {}
    });
    return service;
  }

  {
    const parent = row('parent', 1, { phase: { value: 'done', source: 'user', ts: 1 } });
    const child = row('child', 2, { parentSessionId: 'parent', lifecycle: 'working', activity: { kind: 'active', guiTurn: true, ts: Date.now() } });
    const service = setup([parent, child], 'parent');
    service.notifyBus = { report() {} };
    service.emitSessionFactKind = () => {};
    assert.deepEqual(service.archiveExecutionIds('parent'), ['child']);
    service.applyActivitySignal('parent', 'active', 'pre-tool-use');
    assert.equal(parent.phase.value, 'done', 'tool noise keeps the explicit completion');
    service.applyActivitySignal('parent', 'active', 'gui-turn-start');
    assert.equal(parent.phase, undefined, 'an actual new turn reopens manually completed work');
  }
  {
    const service = setup([row('worker', 1)], 'worker');
    const detach = service.onBeforeArchive(() => { throw new Error('epoch storage failed'); });
    assert.throws(() => service.removeByWorkspace('w'), /epoch storage failed/);
    assert.ok(service.get('worker'), 'failed close must not be swallowed');
    assert.equal(service.lastActiveByWs.get('w'), 'worker');
    detach();
  }
  {
    const { WorkerDesktopEpochRuntime } = require(path.join(root, 'src/main/desktop/workerEpochRuntime.ts'));
    const service = setup([row('worker', 1)], 'worker');
    const runtime = new WorkerDesktopEpochRuntime(path.join(tmp, 'runtime'), service);
    assert.deepEqual(runtime.currentBinding('worker'), { epoch: 'worker', anchor: 'worker', generation: 0 });
    const captured = runtime.epochs.capture('worker', 'w');
    service.setArchived('worker', true);
    assert.equal(captured.isCurrent(), false);
    assert.throws(() => runtime.currentBinding('worker'), /unavailable/);
    await Promise.resolve();
    service.setArchived('worker', false);
    assert.equal(runtime.currentBinding('worker').generation, 1);
    assert.equal(captured.isCurrent(), false);
    runtime.close();
  }
  {
    const { WorkerDesktopEpochRuntime } = require(path.join(root, 'src/main/desktop/workerEpochRuntime.ts'));
    const service = setup([row('worker', 1)], 'worker');
    const runtime = new WorkerDesktopEpochRuntime(path.join(tmp, 'archive-before-use'), service);
    // After restart, archive may happen before the first wait or capture.
    service.setArchived('worker', true);
    await Promise.resolve();
    service.setArchived('worker', false);
    assert.equal(runtime.currentBinding('worker').generation, 1);
    runtime.close();
    const unavailable = path.join(tmp, 'not-a-directory'); fs.writeFileSync(unavailable, 'fixture');
    const blockedService = setup([row('blocked', 1)], 'blocked');
    const blocked = new WorkerDesktopEpochRuntime(unavailable, blockedService);
    assert.throws(() => blockedService.setArchived('blocked', true));
    assert.equal(blockedService.get('blocked').archived, undefined);
    blocked.close();
  }

  {
    const { SqliteDesktopEpochHistory } = require(path.join(root, 'src/main/desktop/epochHistory.ts'));
    const { WorkerDesktopEpochs, bindWorkerEpochArchive } = require(path.join(root, 'src/main/desktop/workerEpoch.ts'));
    const { DatabaseSync } = require('node:sqlite');
    const dbFile = path.join(tmp, 'batch-epochs.sqlite');
    const history = new SqliteDesktopEpochHistory(dbFile);
    history.generation('parent'); history.generation('child');
    const faultDb = new DatabaseSync(dbFile);
    faultDb.exec("CREATE TRIGGER fail_parent BEFORE UPDATE ON desktop_epoch_sessions WHEN OLD.session_id='parent' BEGIN SELECT RAISE(ABORT, 'injected epoch failure'); END");
    const service = setup([row('parent', 1), row('child', 2, { parentSessionId: 'parent' })], 'parent');
    const epochs = new WorkerDesktopEpochs(service, history);
    const detach = bindWorkerEpochArchive(service, epochs);
    assert.throws(() => service.setArchived('parent', true), /injected epoch failure/);
    assert.equal(service.get('parent').archived, undefined);
    assert.equal(service.get('child').archived, undefined);
    assert.equal(history.generation('parent'), 0);
    assert.equal(history.generation('child'), 0, 'batch epoch updates roll back together');
    detach(); faultDb.close(); history.close();
  }
  {
    const { SqliteDesktopEpochHistory } = require(path.join(root, 'src/main/desktop/epochHistory.ts'));
    const { WorkerDesktopEpochs, bindWorkerEpochArchive } = require(path.join(root, 'src/main/desktop/workerEpoch.ts'));
    const history = new SqliteDesktopEpochHistory(':memory:');
    const service = setup([row('worker', 1)], 'worker');
    const epochs = new WorkerDesktopEpochs(service, history);
    const detach = bindWorkerEpochArchive(service, epochs);
    const old = epochs.capture('worker', 'w');
    service.setArchived('worker', true);
    assert.equal(history.generation('worker'), 1);
    await Promise.resolve();
    service.setArchived('worker', false);
    assert.equal(old.isCurrent(), false);
    assert.equal(epochs.capture('worker', 'w').generation, 1);
    history.close();
    assert.throws(() => service.setArchived('worker', true));
    assert.equal(service.get('worker').archived, undefined, 'failed epoch persistence prevents archive success');
    detach();
  }
  {
    const service = setup([row('parent', 1), row('child', 2, { parentSessionId: 'parent' })], 'parent');
    const observed = [];
    const stop = service.onBeforeArchive(rows => { observed.push(rows.map(item => item.id)); throw Error('epoch persistence failed'); });
    assert.throws(() => service.setArchived('parent', true), /epoch persistence failed/);
    assert.equal(service.get('parent').archived, undefined);
    assert.equal(service.get('child').archived, undefined);
    assert.equal(service.activeId, 'parent');
    assert.deepEqual(new Set(observed[0]), new Set(['parent', 'child']), 'all targets are checked before any archive mutation');
    stop();
    const stopAsync = service.onBeforeArchive(() => Promise.resolve());
    assert.throws(() => service.setArchived('parent', true), /synchronously/);
    assert.equal(service.get('parent').archived, undefined);
    stopAsync();
    service.setArchived('parent', true);
    assert.equal(service.get('parent').archived, true);
    assert.equal(service.get('child').archived, true);
  }
  {
    const service = setup([row('worker', 1)], 'worker');
    const { uploadScope } = require(path.join(root, 'src/main/browser/uploadScope.ts'));
    const { runAsAgentSession } = require(path.join(root, 'src/main/agent/agentScope.ts'));
    const { sourcePathKey } = require(path.join(root, 'src/main/workspacePaths.ts'));
    const captured = { workspaceId: 'w', cwd: tmp, roots: [], controlPhysicalPath: sourcePathKey(tmp),
      readableDirectories: [{ path: tmp, physicalPath: sourcePathKey(tmp) }] };
    const ctx = { sessions: service, config: service.config, agentSessions: { entries: new Map(), getWorkspaceContext: () => captured } };
    const { captureSafetyContext } = require(path.join(root, 'src/main/safety/bindings.ts'));
    const safetyCurrent = captureSafetyContext(ctx, { actorId: 'worker', workspaceId: 'w' });
    assert.equal(safetyCurrent(), true);
    ctx.agentSessions.entries.set('worker', { workspaceId: 'w', execution: { id: 'turn' }, activeTurnStartedAt: 1 });
    const guiSafetyCurrent = captureSafetyContext(ctx, { actorId: 'worker', workspaceId: 'w' });
    assert.equal(guiSafetyCurrent(), true);
    await runAsAgentSession('worker', async () => {
      const oldScope = uploadScope(ctx);
      const original = service.sessionScopeToken('worker');
      service.setArchived('worker', true);
      assert.equal(service.sessionScopeToken('worker'), undefined);
      await Promise.resolve();
      service.setArchived('worker', false);
      assert.notEqual(service.sessionScopeToken('worker'), original);
      assert.equal(safetyCurrent(), false, 'archive and restore must not revive an earlier safety approval');
      assert.equal(guiSafetyCurrent(), false, 'the same applies while an agent host entry remains present');
      assert.equal(captureSafetyContext(ctx, { actorId: 'worker', workspaceId: 'w' })(), true);
      assert.throws(() => oldScope.assertCurrent(), /no longer current/);
      assert.doesNotThrow(() => uploadScope(ctx).assertCurrent());
    });
    service.sessions = [];
    assert.throws(() => captureSafetyContext(ctx, { actorId: 'worker', workspaceId: 'w' }), /会话不存在/,
      'a leftover GUI host entry cannot replace the registered session');
  }
  {
    // 真实顺序为 newest → current → next → oldest；内部数组的首行恰好是末尾。
    const service = setup([row('oldest', 1), row('next', 2), row('current', 3), row('newest', 4)], 'current');
    service.setArchived('current', true);
    assert.equal(service.activeId, 'next', '归档当前项后选列表下一行');
  }
  {
    const service = setup([row('oldest', 1), row('middle', 2), row('newest', 3)], 'oldest');
    service.setArchived('oldest', true);
    assert.equal(service.activeId, 'middle', '末行无下一项时选择紧邻的上一行');
  }
  {
    const service = setup([row('other', 1), row('child', 100, { parentSessionId: 'parent' }),
      row('parent', 2, { pinned: true, pinnedAt: 9 }), row('after', 3)], 'parent');
    service.setArchived('parent', true);
    assert.equal(service.activeId, 'after', '置顶父会话归档时跳过同时归档的子会话');
  }
  {
    const service = setup([row('old', 1), row('child', 100, { parentSessionId: 'parent' }),
      row('parent', 5), row('after', 3)], 'child');
    service.setArchived('parent', true, { activeId: 'child', nextId: 'parent' });
    assert.equal(service.activeId, 'after', '父会话归档时，当前子会话和同枝提示均被跳过');
  }
  {
    const service = setup([row('shell', 8, { launchKind: 'shell' }), row('last-agent', 2),
      row('current', 3), row('foreign', 100, { workspaceId: 'other' }),
      row('hidden', 2.5, { hidden: true }), row('archived', 2.4, { archived: true })], 'current');
    service.setArchived('current', true);
    assert.equal(service.activeId, 'last-agent', '忽略其他工作区、隐藏和已归档会话');
    service.setArchived('last-agent', true);
    assert.equal(service.activeId, 'shell', '工作会话末尾可接到终端分组');
  }
  {
    const service = setup([row('first', 3), row('second', 2), row('last', 1)], 'first');
    service.setArchived('second', true);
    assert.equal(service.activeId, 'first', '归档非当前会话不改变选中');
    service.setArchived('first', true, { activeId: 'first', nextId: 'last' });
    assert.equal(service.activeId, 'last', '左栏提供的可见下一行生效');
  }
  {
    const service = setup([row('first', 3), row('second', 2), row('last', 1),
      row('foreign', 4, { workspaceId: 'other' }), row('hidden', 4, { hidden: true })], 'first');
    service.setArchived('first', true, { activeId: 'stale', nextId: 'last' });
    assert.equal(service.activeId, 'second', '过期选中提示不能覆盖主进程的选择');
    service.setArchived('second', true, { activeId: 'second', nextId: 'foreign' });
    assert.equal(service.activeId, 'last', '不接受跨工作区提示');
    service.setArchived('last', true, { activeId: 'last', nextId: 'hidden' });
    assert.equal(service.activeId, null, '没有合法候选时置空，不选隐藏会话');
  }
  console.log('session-archive-selection: real service selection passed');
} finally {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
}
