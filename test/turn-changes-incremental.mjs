/** Negative controls for directory-sized review work: no sweep, watcher or workspace inventory. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-path-cost-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const entry = compile('main/turnChanges/service.ts');
if (process.argv.includes('--baseline-rescan')) {
  const target = path.join(tmp, 'compiled/main/turnChanges/tracker.mjs');
  const source = fs.readFileSync(target, 'utf8');
  assert(source.includes('for (const root of this.roots)'));
  fs.writeFileSync(target, source.replace('for (const root of this.roots)', 'await fs.promises.readdir(this.cwd); for (const root of this.roots)'));
}
const { TurnChangeService } = await import(pathToFileURL(entry));
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(work, `file-${i}.txt`), `value-${i}`);
const service = new TurnChangeService(path.join(tmp, 'store')); const trackers = [];
const original = { read: fs.readFileSync, readdir: fs.readdirSync, asyncList: fs.promises.readdir, open: fs.promises.open, watch: fs.watch, exec: cp.execFile };
let bodies = [], inventories = 0, watchers = 0, git = [];
const inWork = value => typeof value === 'string' && (value === work || value.startsWith(work + path.sep));
try {
  fs.readFileSync = function(value, ...args) { if (inWork(value)) bodies.push(String(value)); return original.read.call(this, value, ...args); };
  fs.readdirSync = function(value, ...args) { if (inWork(value)) inventories++; return original.readdir.call(this, value, ...args); };
  fs.promises.readdir = async function(value, ...args) { if (inWork(value)) inventories++; return original.asyncList.call(this, value, ...args); };
  fs.promises.open = async function(value, ...args) { if (inWork(value)) bodies.push(String(value)); return original.open.call(this, value, ...args); };
  fs.watch = function(value, ...args) { if (inWork(value)) watchers++; return original.watch.call(this, value, ...args); };
  cp.execFile = function(command, args, ...rest) { if (command === 'git') git.push([...args]); return original.exec.call(this, command, args, ...rest); };
  syncBuiltinESMExports();
  const empty = service.begin('gui:a', 'empty', work, [work]); trackers.push(empty); await empty.ready; await empty.finish();
  assert.deepEqual(bodies, [], 'empty turns must not read workspace file bodies');
  assert.equal(inventories, 0); assert.equal(watchers, 0);
  const t = service.begin('gui:a', 'one', work, [work]); trackers.push(t); await t.ready;
  const hookStart = performance.now();
  await t.toolStart('edit', 'write', { path: 'file-42.txt', content: 'changed' }, undefined, true);
  const prewriteMs = performance.now() - hookStart;
  fs.writeFileSync(path.join(work, 'file-42.txt'), 'changed'); await t.toolEnd('edit', true, undefined, true);
  const summary = await t.finish();
  assert.equal(summary.files.length, 1); assert.equal(summary.files[0].revertible, true);
  assert(bodies.length <= 3, `one touched file should need at most three body reads, got ${bodies.length}`);
  assert(bodies.every(value => value === path.join(work, 'file-42.txt')));
  assert.equal(inventories, 0, 'no directory enumeration even in a large source tree');
  assert.equal(watchers, 0, 'review does not create source watchers');
  assert(git.every(args => !args.includes('status') && !args.includes('ls-files')), 'identity queries do not inventory Git files');
  console.log(`turn-changes-incremental: ${bodies.length} body reads, ${inventories} inventories, ${watchers} watchers, ${git.length} identity calls, pre-write elapsed ${prewriteMs.toFixed(2)}ms`);
} finally {
  fs.readFileSync = original.read; fs.readdirSync = original.readdir; fs.promises.readdir = original.asyncList;
  fs.promises.open = original.open; fs.watch = original.watch; cp.execFile = original.exec; syncBuiltinESMExports();
  await Promise.allSettled(trackers.map(t => t.ready)); service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
