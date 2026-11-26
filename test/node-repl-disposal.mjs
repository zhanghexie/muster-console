import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-disposal-'));
const sessions = [], managers = [], restore = [];
const until = async predicate => { const deadline = Date.now() + 3000; while (!predicate()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
try {
  const compile = createSharedCompiler(process.cwd(), fixture);
  const { NodeReplSession } = await import(pathToFileURL(compile('main/nodeRepl/session.ts')));
  const { NodeReplManager } = await import(pathToFileURL(compile('main/nodeRepl/manager.ts')));
  const idle = new NodeReplSession(); sessions.push(idle);
  await idle.run('globalThis.timer = setInterval(() => {}, 1000); 1');
  const worker = idle.worker, originalTerminate = worker.terminate.bind(worker);
  let allowTermination, exited = false, disposed = false;
  restore.push(() => { worker.terminate = originalTerminate; allowTermination?.(); });
  worker.once('exit', () => { exited = true; });
  worker.terminate = () => new Promise((resolve, reject) => { allowTermination = () => originalTerminate().then(resolve, reject); });
  const closing = idle.dispose(); closing.then(() => { disposed = true; });
  assert.equal(idle.dispose(), closing, 'concurrent disposal shares termination barrier');
  await until(() => allowTermination);
  assert.equal(disposed, false, 'dispose does not resolve on a termination request');
  await assert.rejects(idle.run('2'), /disposed/);
  allowTermination(); await closing; worker.terminate = originalTerminate;
  assert.equal(exited, true, 'native worker exit precedes successful disposal');
  assert.equal(idle.isCurrentGeneration(idle.generation), false, 'disposed session has no usable current generation');

  const queued = new NodeReplSession(); sessions.push(queued);
  const active = queued.run('new Promise(() => {})', { timeoutMs: 5000 });
  await until(() => queued.activeRuns === 1);
  const pending = queued.run('globalThis.mustNotRun = true; 2');
  await queued.dispose();
  assert.equal((await active).status, 'cancel');
  assert.equal((await pending).status, 'cancel');
  assert.equal(queued.worker, null, 'accepted queued work cannot rebuild a disposed worker');

  const late = new NodeReplSession(); sessions.push(late);
  const lateResult = late.run('new Promise(resolve => setTimeout(() => resolve("late result"), 150))');
  await until(() => late.activeRuns === 1);
  const lateWorker = late.worker, terminateLate = lateWorker.terminate.bind(lateWorker);
  lateWorker.terminate = async () => { throw Error('late worker termination denied'); };
  try {
    await assert.rejects(late.dispose(), /termination denied/);
    assert.equal((await lateResult).status, 'cancel', 'a disposed generation cannot publish a late success when terminate failed');
  } finally { lateWorker.terminate = terminateLate; await late.dispose(); }

  const timeout = new NodeReplSession(); sessions.push(timeout);
  const timeoutResult = timeout.run('new Promise(() => {})', { timeoutMs: 1000 });
  await until(() => timeout.activeRuns === 1);
  const timeoutWorker = timeout.worker, terminateTimeout = timeoutWorker.terminate.bind(timeoutWorker);
  timeoutWorker.terminate = async () => { throw Error('timeout termination denied'); };
  try {
    const result = await timeoutResult;
    assert.equal(result.status, 'error', 'timeout does not claim successful kernel reset after terminate failed');
    assert.match(result.text, /回收失败/);
  } finally { timeoutWorker.terminate = terminateTimeout; await timeout.dispose(); }

  const manager = new NodeReplManager(); managers.push(manager);
  const bad = manager.getOrCreate('bad'), good = manager.getOrCreate('good');
  await Promise.all([bad.run('1'), good.run('2')]);
  const badWorker = bad.worker, terminateBad = badWorker.terminate.bind(badWorker);
  let goodExited = false;
  good.worker.once('exit', () => { goodExited = true; });
  badWorker.terminate = async () => { throw Error('fixture terminate denied'); };
  try {
    const all = manager.disposeAll();
    assert.throws(() => manager.getOrCreate('new'), /stopping/);
    await assert.rejects(all, /fixture terminate denied/);
    assert.equal(goodExited, true, 'one failed terminate does not skip another session');
    assert.equal(manager.size, 1, 'failed owner stays registered');
    assert.equal(manager.peek('bad'), bad);
  } finally { badWorker.terminate = terminateBad; }
  await manager.disposeAll();
  assert.equal(manager.size, 0, 'retry can release a previously failed owner');
  console.log('node-repl-disposal: OK (real threads, queue admission, error aggregation and retry)');
} finally {
  for (const reset of restore) reset();
  await Promise.allSettled([...sessions.map(session => session.dispose()), ...managers.map(manager => manager.disposeAll())]);
  fs.rmSync(fixture, { recursive: true, force: true });
}
