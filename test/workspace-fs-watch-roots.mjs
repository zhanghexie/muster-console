import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workspace-watch-roots-'));
const a = path.join(temp, 'a'), b = path.join(temp, 'b'), nested = path.join(a, 'src');
const task = path.join(a, '.worktrees', 'task'), alias = path.join(temp, 'alias-b');
for (const dir of [nested, path.join(b, 'src'), task]) fs.mkdirSync(dir, { recursive: true });
for (const root of [a, b]) fs.writeFileSync(path.join(root, 'src/same.txt'), root === a ? 'A' : 'B');
fs.writeFileSync(path.join(task, 'inside.txt'), 'task');
fs.symlinkSync(b, alias, 'junction');
const outside = path.join(temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
fs.symlinkSync(outside, path.join(a, 'escape'), 'junction');
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { WorkspaceFsWatcher } = await import(pathToFileURL(compile('main/workspaceFsWatcher.ts')).href);
const workspace = { id: 'ws', path: a, controlRoot: a, defaultRootId: 'a', rootsRevision: 0,
  roots: [{ id: 'a', path: a }, { id: 'b', path: b }, { id: 'nested', path: nested }, { id: 'task', path: task }] };
const second = { id: 'shared', path: alias, controlRoot: alias, defaultRootId: 'alias', rootsRevision: 0, roots: [{ id: 'alias', path: alias }] };
let config = { workspaces: [workspace, second] };
const events = [], automated = [], calls = [];
const ctx = { config: { get: () => config }, getWindow: () => ({ isDestroyed: () => false,
  webContents: { send: (channel, payload) => { assert.equal(channel, 'fs:changed'); events.push(payload); } } }) };
const settle = () => new Promise(resolve => setTimeout(resolve, 280));
const originalWatch = fs.watch;
let failB = false;
fs.watch = (root, options, callback) => {
  assert.equal(options.recursive, true);
  if (root === b && failB) throw new Error('expected watch permission failure');
  const watcher = new EventEmitter();
  Object.assign(watcher, { root, callback, closed: false, close() { this.closed = true; this.emit('close'); } });
  calls.push(watcher); return watcher;
};
const watcher = new WorkspaceFsWatcher(ctx);
watcher.onChanged = (workspaceId, paths, rootId) => automated.push({ workspaceId, rootId, paths });
try {
  watcher.syncFromConfig();
  assert.equal(calls.length, 3, 'parent/child and cross-workspace Junction aliases share physical watches; explicit skipped task root has its own');
  assert.equal([...watcher.bindingsByPhysical.values()].find(bucket => bucket.some(binding => binding.physical === path.resolve(b))).length, 2, 'logical roots sharing one physical directory must share one prefix-index bucket');
  const watchA = calls.find(w => w.root === a), watchB = calls.find(w => w.root === b), watchTask = calls.find(w => w.root === task);
  watchA.callback('change', 'src/same.txt'); watchB.callback('change', 'src/same.txt');
  watchA.callback('change', '.git/index'); watchA.callback('change', '.worktrees/task/inside.txt');
  watchA.callback('change', 'escape/secret.txt'); watchA.callback('change', '../b/src/same.txt');
  watchTask.callback('change', 'inside.txt');
  await settle();
  assert.equal(events.length, 5);
  assert.deepEqual(events.find(e => e.rootId === 'a').relativePaths, ['src/same.txt']);
  assert.deepEqual(events.find(e => e.rootId === 'nested').relativePaths, ['same.txt']);
  assert.deepEqual(events.find(e => e.rootId === 'b').relativePaths, ['src/same.txt']);
  assert.deepEqual(events.find(e => e.rootId === 'alias').relativePaths, ['src/same.txt']);
  assert.deepEqual(events.find(e => e.rootId === 'task').relativePaths, ['inside.txt']);
  assert.equal(automated.length, events.length);
  assert(events.every(e => e.rootsRevision === 0));

  events.length = 0; automated.length = 0;
  for (let i = 0; i < 1200; i++) watchA.callback('change', `file-${i}.txt`);
  await settle();
  assert.deepEqual(events.map(e => [e.rootId, e.relativePaths]), [['a', ['']]], 'event storms collapse to one root-scoped batch');
  watchA.callback('change', 'src/same.txt');
  config = { workspaces: [{ ...workspace, rootsRevision: 1, roots: workspace.roots.filter(r => r.id !== 'b') }, second] };
  watcher.syncFromConfig();
  events.length = 0; automated.length = 0;
  await settle();
  assert.equal(events.length, 0, 'queued previous revision must not survive root changes');
  assert.equal(calls.length, 3, 'unchanged physical handles remain mounted');
  watchB.callback('change', 'src/same.txt'); await settle();
  assert.deepEqual(events.map(e => e.workspaceId), ['shared'], 'removed logical root loses delivery while another workspace retains its shared watch');
  config = { workspaces: [config.workspaces[0]] }; watcher.syncFromConfig();
  assert.equal(watchB.closed, true);
  events.length = 0; watchB.callback('change', 'src/same.txt'); await settle(); assert.equal(events.length, 0);
  assert.throws(() => watcher.refreshRoot('ws', 'removed'), /source folder not found/);

  // A failed asynchronous root check must not poison a replacement binding with the same ID.
  const originalStat = fs.promises.stat;
  let enterStat, rejectStat;
  const enteredStat = new Promise(resolve => { enterStat = resolve; });
  const heldStat = new Promise((_resolve, reject) => { rejectStat = reject; });
  fs.promises.stat = async (...args) => {
    if (args[0] === a) { enterStat(); return heldStat; }
    return originalStat(...args);
  };
  try {
    watchA.callback('change', 'delayed.txt');
    await enteredStat;
    config = { workspaces: [{ ...config.workspaces[0], rootsRevision: 2 }] };
    watcher.syncFromConfig(); events.length = 0; automated.length = 0;
    rejectStat(new Error('expected stale root check failure'));
    await settle();
    assert.equal(events.length, 0, 'failed checks from an old revision must not emit errors');
    assert.equal(watcher.errorForRoot('ws', 'a'), undefined, 'old checks must not overwrite current root status');
  } finally { fs.promises.stat = originalStat; }

  config = { workspaces: [workspace] }; failB = true; watcher.syncFromConfig();
  assert.match(watcher.errorForRoot('ws', 'b'), /permission failure/);
  assert(events.some(e => e.rootId === 'b' && e.error && !e.relativePaths.length));
  failB = false; assert.equal(watcher.refreshRoot('ws', 'b'), undefined);
  const restoredB = calls.filter(w => w.root === b).at(-1);
  restoredB.emit('error', new Error('expected runtime watch failure'));
  assert.equal(restoredB.closed, true);
  assert.match(watcher.errorForRoot('ws', 'b'), /runtime watch failure/);
  assert.equal(watcher.refreshRoot('ws', 'b'), undefined);
  const beforeReplace = calls.filter(w => w.root === b).at(-1);
  beforeReplace.callback('change', 'src/same.txt');
  fs.renameSync(b, path.join(temp, 'old-b'));
  fs.mkdirSync(path.join(b, 'src'), { recursive: true }); fs.writeFileSync(path.join(b, 'src/same.txt'), 'new B');
  assert.equal(watcher.refreshRoot('ws', 'b'), undefined);
  assert.equal(beforeReplace.closed, true, 'same pathname with a replaced directory must remount its watch');
  events.length = 0; automated.length = 0;
  calls.filter(w => w.root === b).at(-1).callback('change', 'src/same.txt');
  watcher.stopAll(); await settle(); assert.equal(events.length, 0); assert.equal(automated.length, 0);
} finally { await watcher.shutdown(); fs.watch = originalWatch; }

// Native watcher: two source roots, overlapping root and shared Junction alias.
config = { workspaces: [{ ...workspace, roots: workspace.roots.filter(r => r.id !== 'task') }, second] };
events.length = 0; calls.length = 0;
fs.watch = (...args) => { calls.push(args[0]); return originalWatch(...args); };
const native = new WorkspaceFsWatcher(ctx);
try {
  native.syncFromConfig();
  assert.equal(calls.length, 2);
  const expected = ['a', 'b', 'nested', 'alias'];
  const delivered = (id) => events.some(event => event.rootId === id);
  const deadline = Date.now() + 5000;
  // Watchers on sibling folders can begin delivering at different times.
  while (!expected.every(delivered) && Date.now() < deadline) {
    if (!delivered('a') || !delivered('nested')) fs.appendFileSync(path.join(a, 'src/same.txt'), ' external');
    if (!delivered('b') || !delivered('alias')) fs.appendFileSync(path.join(b, 'src/same.txt'), ' external');
    await new Promise(resolve => setTimeout(resolve, 270));
  }
  for (const id of expected) assert(delivered(id), `native root ${id} must deliver`);
  assert(events.filter(e => e.rootId === 'b').every(e => e.relativePaths.includes('src/same.txt')));
  assert(events.filter(e => e.rootId === 'nested').every(e => e.relativePaths.includes('same.txt')));
  const missing = path.join(a, 'missing');
  config = { workspaces: [{ ...config.workspaces[0], rootsRevision: 1, roots: [...config.workspaces[0].roots, { id: 'offline', path: missing }] }, second] };
  native.syncFromConfig(); assert.match(native.errorForRoot('ws', 'offline'), /ENOENT/);
  fs.mkdirSync(missing); fs.writeFileSync(path.join(missing, 'returned.txt'), 'restored');
  assert.equal(native.refreshRoot('ws', 'offline'), undefined);
  assert.equal(calls.length, 2, 'restored child reuses its parent watch');
} finally {
  await native.shutdown(); fs.watch = originalWatch;
  assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('workspace-fs-watch-roots: OK (physical sharing, logical fanout, revision, storm, errors/retry, native events)');
