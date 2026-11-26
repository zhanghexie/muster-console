import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd(); fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(project, '.tmp', 'rg-cancel-'));
const compile = createSharedCompiler(project, path.join(temp, 'compiled'));
const rg = await import(pathToFileURL(compile('main/workspaceRg.ts')).href);
const originalSpawn = childProcess.spawn;
let last, kills = 0, spawns = 0;
childProcess.spawn = (binary, args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.kill = () => { kills++; child.emit('close', null); return true; };
  // No PID: this transport test focuses on rg lifetime, not taskkill implementation.
  spawns++; last = { child, binary, args }; return child;
};
syncBuiltinESMExports();
try {
  const cancelled = new AbortController(); cancelled.abort();
  assert((await rg.listPathsDetailed(temp, { signal: cancelled.signal })).cancelled);
  assert.equal(spawns, 0, 'pre-cancelled work never starts a process');
  const running = new AbortController();
  const result = rg.listPathsDetailed(temp, { signal: running.signal, max: 3 });
  last.child.stdout.emit('data', 'one.txt\n');
  running.abort();
  assert((await result).cancelled); assert.equal(kills, 1);
  running.abort(); assert.equal(kills, 1, 'settled work unhooks its abort handler');

  const timeout = rg.searchTextDetailed(temp, { query: 'needle', timeoutMs: 1 });
  assert((await timeout).timedOut);
  const capped = rg.listPathsDetailed(temp, { max: 2 });
  last.child.stdout.emit('data', 'a.txt\nb.txt\nc.txt\n');
  const cappedResult = await capped;
  assert.deepEqual(cappedResult.items, ['a.txt', 'b.txt']); assert(cappedResult.truncated);
  const overflow = rg.listPathsDetailed(temp);
  last.child.stdout.emit('data', 'x'.repeat(1024 * 1024 + 1));
  assert((await overflow).truncated, 'oversized unterminated stdout reports incomplete results');
  const failed = rg.searchTextDetailed(temp, { query: 'needle' });
  last.child.stderr.emit('data', 'expected permission failure'); last.child.emit('close', 2);
  await assert.rejects(failed, /permission failure/);
  console.log('workspace-rg-cancel: OK (pre/in-flight cancel, timeout, cap, overflow, errors)');
} finally {
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  assert.equal(path.dirname(temp), path.join(project, '.tmp'));
  fs.rmSync(temp, { recursive: true, force: true });
}
