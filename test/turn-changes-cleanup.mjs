/** Deleted sessions are purged; existing sessions retain their latest usable snapshot. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-cleanup-'));
try {
  const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
  const { scanTurnChangesRecords, sweepTurnChanges, purgeTurnChangesForSessions, startTurnChangesCleanupSweeper } =
    await import(pathToFileURL(compile('main/turnChanges/cleanup.ts')).href);
  const recordDir = name => { const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const writeRecord = (dir, owner, messageId = randomUUID()) => {
    const id = randomUUID();
    const summary = { id, state: 'ready', warnings: [], files: [{ path: 'a.ts', kind: 'modified', added: 1, removed: 1, revertible: true }] };
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ owner, messageId, roots: [], summary, files: [{ view: summary.files[0], abs: 'a.ts', before: null, beforeHash: null, after: null, diff: '+new' }] }));
    return { file, id, message: { id: messageId, role: 'assistant', turnChanges: summary } };
  };

  {
    const dir = recordDir('purge');
    const a = writeRecord(dir, 'gui:s1'), b = writeRecord(dir, 'gui:s1');
    const keep = writeRecord(dir, 'gui:s2'), dispatch = writeRecord(dir, 'dispatch:w1');
    const cache = path.join(dir, 'baseline-cache', 'objects'); fs.mkdirSync(cache, { recursive: true });
    const cached = path.join(cache, 'abc'); fs.writeFileSync(cached, 'shared');
    const temp = path.join(dir, 'pending.json.tmp'); fs.writeFileSync(temp, 'temporary');
    const result = await purgeTurnChangesForSessions(dir, ['s1']);
    assert.equal(result.removedFiles, 2);
    assert.ok(!fs.existsSync(a.file) && !fs.existsSync(b.file));
    assert.ok(fs.existsSync(keep.file) && fs.existsSync(dispatch.file) && fs.existsSync(cached) && fs.existsSync(temp));
    assert.equal((await purgeTurnChangesForSessions(dir, ['s1'])).removedFiles, 0);
  }
  {
    const dir = recordDir('sweep');
    const gone = writeRecord(dir, 'gui:gone');
    const corrupt = path.join(dir, 'broken.json'); fs.writeFileSync(corrupt, '{broken');
    const old = writeRecord(dir, 'gui:arch'), latest = writeRecord(dir, 'gui:arch');
    const liveOld = writeRecord(dir, 'gui:live'), liveLatest = writeRecord(dir, 'gui:live');
    const retainedWithoutHistory = writeRecord(dir, 'gui:no-history');
    const dispatchOld = writeRecord(dir, 'dispatch:w'), dispatchLatest = writeRecord(dir, 'dispatch:w');
    const otherDispatchSession = writeRecord(dir, 'dispatch:w');
    const histories = new Map([
      ['gui:arch', [old.message, latest.message]],
      ['gui:live', [liveOld.message, liveLatest.message]],
      ['dispatch:w', [dispatchOld.message, dispatchLatest.message]]
    ]);
    const result = await sweepTurnChanges(dir, {
      classify: owner => owner === null || owner === 'gui:gone' ? 'gone' : owner === 'gui:arch' ? 'done' : 'active',
      readers: owner => histories.has(owner) ? { live: () => histories.get(owner), durable: () => histories.get(owner) } : null
    });
    assert.equal(result.removedFiles, 6);
    assert.ok(!fs.existsSync(gone.file) && !fs.existsSync(corrupt) && !fs.existsSync(old.file) && !fs.existsSync(liveOld.file) && !fs.existsSync(dispatchOld.file));
    assert.ok(fs.existsSync(latest.file) && fs.existsSync(liveLatest.file) && fs.existsSync(retainedWithoutHistory.file));
    assert.ok(fs.existsSync(dispatchLatest.file) && !fs.existsSync(otherDispatchSession.file), 'dispatch retains one snapshot for its workspace');
    assert.equal((await scanTurnChangesRecords(dir)).length, 4);
  }
  {
    // If legacy scheduler messages are gone, keep one readable record using the
    // only remaining ordering evidence: the files' modification times.
    const dir = recordDir('dispatch-legacy');
    const older = writeRecord(dir, 'dispatch:w'), newer = writeRecord(dir, 'dispatch:w');
    fs.utimesSync(older.file, new Date('2020-01-01'), new Date('2020-01-01'));
    await sweepTurnChanges(dir, { classify: () => 'active', readers: () => ({ live: () => [], durable: () => [] }) });
    assert.ok(!fs.existsSync(older.file) && fs.existsSync(newer.file));
  }
  {
    // The production scheduler prunes a session after its new history is durable.
    const profile = recordDir('scheduled-profile'), dir = path.join(profile, 'turn-changes'); fs.mkdirSync(dir);
    const old = writeRecord(dir, 'gui:live'), latest = writeRecord(dir, 'gui:live');
    const messages = [old.message, latest.message];
    const ctx = { sessions: { get: id => id === 'live' ? {} : undefined },
      agentSessions: { entries: new Map([['live', { messages, closed: false }]]), store: { loadForReviewRetention: async () => messages } },
      config: { get: () => ({ workspaces: [] }) } };
    let request;
    const service = { setRetentionCallback: callback => { request = callback; }, isSnapshotBusy: () => false };
    startTurnChangesCleanupSweeper(ctx, profile, service);
    request('gui:live');
    const deadline = Date.now() + 4000;
    while (fs.existsSync(old.file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!fs.existsSync(old.file) && fs.existsSync(latest.file));
  }
  {
    // Settling a scheduler turn also removes older records from the same
    // workspace even when they belonged to a different legacy conversation.
    const profile = recordDir('scheduled-dispatch'), dir = path.join(profile, 'turn-changes'); fs.mkdirSync(dir);
    const olderSession = writeRecord(dir, 'dispatch:w'), latest = writeRecord(dir, 'dispatch:w');
    const foreign = writeRecord(dir, 'gui:other');
    const messages = [latest.message];
    const ctx = { sessions: { get: () => undefined }, agentSessions: null,
      config: { get: () => ({ workspaces: [{ id: 'w' }] }) },
      store: { loadChatForReviewRetention: async () => messages }, orchestrator: { buckets: new Map([['w', { display: messages }]]) } };
    let request;
    startTurnChangesCleanupSweeper(ctx, profile, { setRetentionCallback: callback => { request = callback; }, isSnapshotBusy: () => false });
    request('dispatch:w');
    const deadline = Date.now() + 4000;
    while (fs.existsSync(olderSession.file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!fs.existsSync(olderSession.file) && fs.existsSync(latest.file));
    const originalRead = fs.promises.readFile;
    let foreignReads = 0;
    fs.promises.readFile = async (file, ...args) => {
      if (String(file) === foreign.file) foreignReads++;
      return originalRead.call(fs.promises, file, ...args);
    };
    try {
      const newer = writeRecord(dir, 'dispatch:w'); messages.push(newer.message);
      request('dispatch:w', { id: newer.id, messageId: newer.message.id });
      const nextDeadline = Date.now() + 4000;
      while (fs.existsSync(latest.file) && Date.now() < nextDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(!fs.existsSync(latest.file) && fs.existsSync(newer.file));
      assert.equal(foreignReads, 0, 'later scheduler turns reuse the owner index instead of reading unrelated sessions');
    } finally { fs.promises.readFile = originalRead; }
  }
  {
    // Exercise the actual SessionsService.close chain using valid session IDs.
    const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
    const originalLoad = Module._load;
    require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
    }).outputText, filename);
    Module._load = function (request) {
      if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
      return originalLoad.apply(this, arguments);
    };
    try {
      const { SessionsService } = require(path.join(root, 'src/main/sessions.ts'));
      const parent = randomUUID(), child = randomUUID(), other = randomUUID();
      const row = (id, parentSessionId) => ({ id, parentSessionId, archived: true, pinned: true,
        type: 'terminal', runtime: 'pi', workspaceId: 'w', name: id, cwd: tmp, lifecycle: 'working', status: 'running' });
      const dir = recordDir('turn-changes');
      const p = writeRecord(dir, `gui:${parent}`), c = writeRecord(dir, `gui:${child}`);
      const keep = writeRecord(dir, `gui:${other}`), dispatch = writeRecord(dir, 'dispatch:w');
      const cfg = { activeWorkspaceId: 'w', workspaces: [{ id: 'w', path: tmp }] };
      const service = Object.create(SessionsService.prototype);
      Object.assign(service, { config: { get: () => cfg }, sessions: [row(parent), row(child, parent), row(other)],
        activeId: other, removedListeners: [], subtreeCloseWaiters: new Map(), launchTasks: new Map(), launchGen: new Map(),
        classifyBySession: new Map(), ptyWorkingSince: new Map(), get: id => service.sessions.find(s => s.id === id),
        persist() {}, broadcast() {}, rememberEnded() {}, notifyBus: { clearSession() {} }, notify: { push() {} }, awareness: null,
        resolveWorkspaceId: () => 'w', isChatRuntime: () => false, ptyMgr: { isRunning: () => true, kill() {} }, applyLifecycle() {} });
      service.close(parent);
      const deadline = Date.now() + 2000;
      while ((fs.existsSync(p.file) || fs.existsSync(c.file)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(!fs.existsSync(p.file) && !fs.existsSync(c.file));
      assert.ok(fs.existsSync(keep.file) && fs.existsSync(dispatch.file));
    } finally { Module._load = originalLoad; }
  }
  console.log('turn-changes-cleanup: deleted sessions, archived/live retention, cache isolation and real close chain passed');
} finally {
  const tempRoot = path.resolve(os.tmpdir());
  assert.ok(path.dirname(path.resolve(tmp)) === tempRoot && path.basename(tmp).startsWith('turn-changes-cleanup-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
