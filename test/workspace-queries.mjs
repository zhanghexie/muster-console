import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd();
fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(project, '.tmp', 'workspace-queries-'));
const compile = createSharedCompiler(project, path.join(temp, 'compiled'));
const { WorkspaceQueries } = await import(pathToFileURL(compile('main/workspaceQueries.ts')).href);
const { rankWorkspaceFiles } = await import(pathToFileURL(compile('shared/workspaceQuery.ts')).href);
const a = path.join(temp, 'a'), b = path.join(temp, 'b');
const nested = path.join(a, 'sub[1]'), task = path.join(a, '.worktrees', 'task');
for (const dir of [a, b, nested, task]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(a, 'same.txt'), 'needle A');
fs.writeFileSync(path.join(b, 'same.txt'), 'needle B\nneedle B2\nneedle B3');
fs.writeFileSync(path.join(nested, 'same.txt'), 'needle nested');
fs.writeFileSync(path.join(task, 'same.txt'), 'needle task');
fs.writeFileSync(path.join(a, '.gitignore'), 'ignored.txt\n');
fs.writeFileSync(path.join(a, 'ignored.txt'), 'needle ignored');
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(a, `bulk-${i}.txt`), 'needle large root');
const outside = path.join(temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle secret');
fs.symlinkSync(outside, path.join(a, 'escape'), 'junction');
const roots = [{ id: 'a', path: a }, { id: 'b', path: b }, { id: 'nested', path: nested },
  { id: 'task', path: task }, { id: 'offline', path: path.join(temp, 'missing') }];
const workspace = { id: 'ws', path: a, roots, controlRoot: a, defaultRootId: 'a', rootsRevision: 0 };
let config = { workspaces: [workspace], activeWorkspaceId: 'ws' };
const getConfig = () => config;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const entered = async promise => {
  let timer;
  try { await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('query did not enter expected stage')), 5000); })]); }
  finally { clearTimeout(timer); }
};
try {
  const queries = new WorkspaceQueries(getConfig);
  const listed = await queries.list('ws', { max: 20, includeHidden: true, includeIgnored: true });
  assert(listed.items.length <= 20);
  assert(listed.truncated);
  assert.match(listed.roots.find(r => r.rootId === 'offline').error, /ENOENT/);
  for (const id of ['a', 'b', 'nested', 'task']) assert(listed.items.some(item => item.fileRef.rootId === id));
  assert.equal(listed.items.filter(item => item.fileRef.rootId === 'nested' && item.path === 'same.txt').length, 1);
  assert(!listed.items.some(item => item.fileRef.rootId === 'a' && /sub\[1\]|\.worktrees|escape/.test(item.path)), 'physical child scope and escaped globs must not duplicate or leak');
  assert(listed.items.every(item => path.isAbsolute(item.absolutePath)));
  const ignored = await queries.list('ws', { rootIds: ['a'], includeHidden: true, includeIgnored: true, query: 'ignored' });
  assert.deepEqual(ignored.items.map(item => item.path), ['ignored.txt'], '@ retains enumeration of gitignored files');
  const hits = await queries.search('ws', { query: 'needle', max: 8 });
  assert(hits.items.length <= 8);
  assert.deepEqual(hits.items.slice(0, 4).map(hit => hit.fileRef.rootId), ['a', 'b', 'nested', 'task']);
  assert(hits.items.every(hit => hit.fileRef.relativePath === hit.path));
  assert(!hits.items.some(hit => hit.preview.includes('secret')));
  const tiny = await queries.search('ws', { query: 'needle', max: 1 });
  assert.equal(tiny.items.length, 1); assert.equal(tiny.roots.filter(r => r.truncated).length, 4);
  const onlyNested = await queries.search('ws', { rootIds: ['nested'], query: 'needle' });
  assert.deepEqual(onlyNested.items.map(hit => hit.fileRef), [{ workspaceId: 'ws', rootId: 'nested', relativePath: 'same.txt' }]);
  await assert.rejects(queries.list('wrong'), /workspace not found/);
  await assert.rejects(queries.list('ws', { rootIds: ['removed'] }), /source folder not found/);
  await assert.rejects(queries.list('ws', { max: Infinity }), /query budget/);
  const ranked = rankWorkspaceFiles(listed.items, 'same', 3);
  assert.equal(new Set(ranked.map(item => item.fileRef.rootId)).size, 3, 'UI candidate limit preserves small roots');

  let running = 0, peak = 0, calls = 0;
  const slow = new WorkspaceQueries(getConfig, {
    listPathsDetailed: async (_root, opts) => {
      calls++; running++; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 30)); running--;
      return { items: ['same.txt'], truncated: false, timedOut: false, cancelled: opts.signal.aborted };
    }, searchTextDetailed: async () => { throw new Error('unused'); }
  });
  const [first, second] = await Promise.all([slow.list('ws', { requestId: 'first' }), slow.list('ws', { requestId: 'second' })]);
  assert.equal(peak, 2, 'process cap is shared by simultaneous queries');
  assert.equal(calls, 8); assert(!first.cancelled && !second.cancelled);
  const cancelEntered = deferred(); let aborts = 0;
  const cancellable = new WorkspaceQueries(getConfig, {
    listPathsDetailed: async (_root, opts) => {
      cancelEntered.resolve();
      await new Promise(resolve => opts.signal.addEventListener('abort', () => { aborts++; resolve(); }, { once: true }));
      return { items: ['same.txt'], truncated: false, timedOut: false, cancelled: true };
    }, searchTextDetailed: async () => { throw new Error('unused'); }
  });
  const pending = cancellable.list('ws', { requestId: 'cancel' });
  await entered(cancelEntered.promise);
  assert(cancellable.cancel('ws', 'cancel'));
  const cancelled = await pending;
  assert(cancelled.cancelled); assert.deepEqual(cancelled.items, []); assert(aborts > 0);
  assert(!cancellable.cancel('ws', 'cancel'));

  const versionEntered = deferred(); let versionAborted = false;
  let notifyConfigChange = () => {};
  const versioned = new WorkspaceQueries(getConfig, {
    listPathsDetailed: async (_root, opts) => {
      versionEntered.resolve();
      await new Promise(resolve => opts.signal.addEventListener('abort', () => { versionAborted = true; resolve(); }, { once: true }));
      return { items: ['same.txt'], truncated: false, timedOut: false, cancelled: true };
    }, searchTextDetailed: async () => { throw new Error('unused'); }
  }, listener => { notifyConfigChange = listener; return () => { notifyConfigChange = () => {}; }; });
  const old = versioned.list('ws'); await entered(versionEntered.promise);
  config = { ...config, workspaces: [{ ...workspace, rootsRevision: 1, roots: roots.filter(root => root.id !== 'b') }] };
  notifyConfigChange();
  const stale = await old;
  assert(versionAborted); assert(stale.cancelled); assert.deepEqual(stale.items, []); assert.match(stale.error, /folders changed/);
  const alias = path.join(temp, 'alias'); fs.symlinkSync(b, alias, 'junction');
  config = { ...config, workspaces: [{ ...workspace, rootsRevision: 2, roots: [...roots, { id: 'alias', path: alias }] }] };
  const movedEntered = deferred(), movedRelease = deferred();
  const moved = new WorkspaceQueries(getConfig, {
    listPathsDetailed: async () => {
      movedEntered.resolve(); await movedRelease.promise;
      return { items: ['same.txt'], truncated: false, timedOut: false, cancelled: false };
    }, searchTextDetailed: async () => { throw new Error('unused'); }
  });
  const beforeMove = moved.list('ws', { rootIds: ['alias'] }); await entered(movedEntered.promise);
  fs.unlinkSync(alias); fs.symlinkSync(outside, alias, 'junction');
  fs.writeFileSync(path.join(outside, 'same.txt'), 'replacement'); movedRelease.resolve();
  const movedResult = await beforeMove;
  assert.deepEqual(movedResult.items, []); assert.match(movedResult.roots[0].error, /location changed/);
  console.log('workspace-queries: OK (real rg, scopes, identity, budgets, global concurrency, cancel/version)');
} finally {
  assert.equal(path.dirname(temp), path.join(project, '.tmp'));
  fs.rmSync(temp, { recursive: true, force: true });
}
