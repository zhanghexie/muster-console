/** Delayed revert persistence must not republish cleared or replaced host history. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript'), Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src/main/turnChanges/ipc.ts');
let source = fs.readFileSync(file, 'utf8');
if (process.argv.includes('--baseline-stale-publish')) {
  const guard = 'current.isCurrent() && current.message.turnChanges?.id === snapshotId';
  assert(source.includes(guard));
  source = source.replace(guard, 'true');
}
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const handlers = new Map();
let revertImpl;
const service = { setCollisionHandler() {}, revert: (...args) => revertImpl(...args) };
const module = new Module(file);
module.require = name => {
  if (name === '../../shared/i18n') return { t: (key, values = {}) => key.replace(/\{\{(\w+)\}\}/g, (_match, field) => String(values[field] ?? '')) };
  if (name === '../workspaceExecutionContext') return { pathWritableInContext: () => true }; // Path policy has real-filesystem coverage in workspace-execution-context.
  if (name === '../ipc/handle') return { handle: (name, callback) => handlers.set(name, callback) };
  if (name === './runtime') return { turnChanges: () => service };
  if (name === './retention') return { latestAvailableSnapshot: async () => null };
  if (name === '../agent/schedulerWorkspaceContext') return {
    captureSchedulerWorkspaceContext: () => ({ writableDirectories: [{ path: root }] })
  };
  if (name === '../agentSession/host/base') return {
    syncEntry: (host, entry) => host.sync(entry), persistEntry: (host, entry) => host.persist(entry)
  };
  if (name === './collisions') return { recordTurnFileCollision() {} };
  return require(name);
};
module._compile(compiled, file);
const { registerTurnChangesIpc } = module.exports;

function fixture(kind, failure) {
  const calls = { syncs: [], persists: [], events: [], bucketPersists: [], reverts: [] };
  const message = { id: 'message', role: 'assistant', turnChanges: { id: 'snapshot', state: 'ready', files: [], warnings: [] } };
  const entry = { sessionId: 'gui-session', cwd: root, messages: [message], closed: false };
  const bucket = { display: [message] };
  const gui = {
    entries: new Map([['gui-session', entry]]),
    getWorkspaceContext: () => ({ writableDirectories: [{ path: root }] }),
    sync: current => {
      calls.syncs.push(current);
      if (failure === 'gui-sync') throw new Error('fixture GUI sync failed');
    },
    persist: current => {
      calls.persists.push(current);
      if (failure === 'gui-persist') throw new Error('fixture GUI persistence failed');
    }
  };
  const dispatch = {
    buckets: new Map([['workspace', bucket]]),
    emit: (...args) => {
      calls.events.push(args);
      if (failure === 'dispatch-emit') throw new Error('fixture dispatch emit failed');
    },
    persistBucket: id => {
      calls.bucketPersists.push(id);
      if (failure === 'dispatch-persist') throw new Error('fixture dispatch persistence failed');
    }
  };
  const ctx = { agentSessions: gui, orchestrator: dispatch, config: { get: () => ({}) } };
  registerTurnChangesIpc(ctx);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  revertImpl = (...args) => { calls.reverts.push(args); return gate; };
  const target = { kind, id: kind === 'gui' ? 'gui-session' : 'workspace', messageId: message.id };
  const pending = handlers.get('turnChanges:revert')({}, target);
  assert.equal(typeof calls.reverts[0][4], 'function', 'current path policy reaches the restore operation');
  assert.deepEqual(calls.reverts.map(args => args.slice(0, 4)), [['snapshot', `${kind === 'gui' ? 'gui' : 'dispatch'}:${target.id}`, 'message', [root]]]);
  const result = {
    ok: true, restored: ['changed.txt'], conflicts: [],
    summary: { id: 'snapshot', state: 'ready', files: [{ path: 'changed.txt', reverted: true, revertible: false }], warnings: [] }
  };
  return { calls, message, entry, bucket, gui, dispatch, pending, result, release: () => release(result) };
}

const published = calls => calls.syncs.length + calls.persists.length + calls.events.length + calls.bucketPersists.length;
let scenarios = 0;
for (const kind of ['gui', 'dispatch']) {
  const current = fixture(kind);
  current.release();
  const normal = await current.pending;
  assert.equal(normal.ok, true);
  assert.deepEqual(normal.restored, ['changed.txt']);
  assert.deepEqual(current.message.turnChanges, current.result.summary);
  if (kind === 'gui') {
    assert.deepEqual(current.calls.syncs, [current.entry]);
    assert.deepEqual(current.calls.persists, [current.entry]);
    assert.equal(current.calls.events.length, 0);
  } else {
    assert.deepEqual(current.calls.events, [['agent:message', { ...current.message, workspaceId: 'workspace' }]]);
    assert.deepEqual(current.calls.bucketPersists, ['workspace']);
    assert.equal(current.calls.syncs.length, 0);
  }
  scenarios++;

  const stale = kind === 'gui' ? [
    ['clear', f => { f.entry.messages = []; }],
    ['closed', f => { f.entry.closed = true; }],
    ['removed entry', f => { f.gui.entries.delete('gui-session'); }],
    ['replaced entry', f => { f.gui.entries.set('gui-session', { ...f.entry }); }],
    ['replaced message', f => { f.entry.messages = [{ ...f.message }]; }]
  ] : [
    ['clear', f => { f.bucket.display = []; }],
    ['removed bucket', f => { f.dispatch.buckets.delete('workspace'); }],
    ['replaced bucket', f => { f.dispatch.buckets.set('workspace', { ...f.bucket }); }],
    ['replaced message', f => { f.bucket.display = [{ ...f.message }]; }]
  ];
  stale.push(['changed snapshot', f => { f.message.turnChanges = { ...f.message.turnChanges, id: 'another-snapshot' }; }]);
  stale.push(['removed snapshot', f => { delete f.message.turnChanges; }]);
  for (const [name, mutate] of stale) {
    const f = fixture(kind);
    mutate(f);
    const unchanged = f.message.turnChanges;
    assert.equal(published(f.calls), 0, `${kind} ${name}: no publication while persistence is pending`);
    f.release();
    const result = await f.pending;
    assert.equal(result.ok, true, `${kind} ${name}: actual restoration result survives stale UI`);
    assert.deepEqual(result.restored, ['changed.txt']);
    assert.equal(published(f.calls), 0, `${kind} ${name}: removed history must not be published or persisted`);
    assert.equal(f.message.turnChanges, unchanged, `${kind} ${name}: do not overwrite a stale message or new snapshot`);
    scenarios++;
  }
}

for (const failure of ['gui-sync', 'gui-persist', 'dispatch-emit', 'dispatch-persist']) {
  const f = fixture(failure.startsWith('gui') ? 'gui' : 'dispatch', failure);
  f.release();
  const result = await f.pending;
  assert.equal(result.ok, false, failure);
  assert.match(result.error, /界面同步失败/, failure);
  assert.deepEqual(result.restored, ['changed.txt'], `${failure}: publication failure must retain already restored files`);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.summary, f.result.summary);
  assert.equal(f.message.turnChanges.files[0].reverted, true);
  scenarios++;
}
assert.equal(handlers.has('turnChanges:prewarmScheduler'), false, 'review no longer registers a workspace prewarm IPC');
console.log(`turn-changes-ipc-revert: ${scenarios} deferred persistence, stale history/snapshot and publication failure scenarios passed`);
