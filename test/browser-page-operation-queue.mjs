/** Per-tab Agent mutation ordering, cross-tab concurrency, lifecycle and waiting cancellation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-page-operation-queue-'));
const compile = createSharedCompiler(root, tmp);
const { BrowserPageOperationQueue } = await import(pathToFileURL(compile('main/browser/pageOperationQueue.ts')));
const gate = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

try {
  // The first tab is held inside an action. Its second/third actions must stay queued,
  // while another tab reaches its gate immediately (no wall-clock timing assumptions).
  const queue = new BrowserPageOperationQueue();
  const events = [];
  const firstGate = gate();
  const otherGate = gate();
  const first = queue.run('a', async () => {
    events.push('a1:start');
    await firstGate.promise;
    events.push('a1:end');
    return 1;
  });
  const second = queue.run('a', () => { events.push('a2'); return 2; });
  const third = queue.run('a', () => { events.push('a3'); return 3; });
  const other = queue.run('b', async () => { events.push('b:start'); await otherGate.promise; return 4; });
  assert.deepEqual(events, ['a1:start', 'b:start']);
  assert.equal(queue.size, 2);
  otherGate.resolve();
  assert.equal(await other, 4);
  assert.equal(queue.size, 1);
  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3]);
  assert.deepEqual(events, ['a1:start', 'b:start', 'a1:end', 'a2', 'a3']);
  assert.equal(queue.size, 0);

  // Both asynchronous failures and synchronous throws release the lane for later work.
  const failedGate = gate();
  const failed = queue.run('a', () => failedGate.promise);
  const failedAssertion = assert.rejects(failed, /action failed/);
  const thrown = queue.run('a', () => { throw new Error('synchronous failure'); });
  const thrownAssertion = assert.rejects(thrown, /synchronous failure/);
  const recovered = queue.run('a', () => 'recovered');
  failedGate.reject(new Error('action failed'));
  await Promise.all([failedAssertion, thrownAssertion]);
  assert.equal(await recovered, 'recovered');
  assert.equal(queue.size, 0);

  // An identity captured at arrival must be checked again after waiting. Old guest work
  // cannot silently resolve a replacement guest, even if its tabId is unchanged.
  let generation = 1;
  const oldGuestGate = gate();
  const oldGuest = queue.run('a', () => oldGuestGate.promise);
  let staleRan = false;
  const expectedGeneration = generation;
  const stale = queue.run('a', () => { staleRan = true; }, {
    assertCurrent: () => assert.equal(generation, expectedGeneration, 'guest generation changed')
  });
  const staleAssertion = assert.rejects(stale, /guest generation changed/);
  generation++;
  oldGuestGate.resolve();
  await oldGuest;
  await staleAssertion;
  assert.equal(staleRan, false);
  assert.equal(queue.size, 0);

  // Closing a tab settles all waiters promptly, without releasing a running action's lock.
  const closeGate = gate();
  const running = queue.run('closed', () => closeGate.promise);
  let closedRan = false;
  const closed = queue.run('closed', () => { closedRan = true; });
  const closedAssertion = assert.rejects(closed, /tab closed/);
  queue.cancelPending('closed', new Error('tab closed'));
  await closedAssertion; // Does not wait for the running action.
  assert.equal(closedRan, false);
  assert.equal(queue.size, 1);
  closeGate.resolve();
  await running;
  assert.equal(queue.size, 0);

  // An individual aborted waiter is removed, and the next operation retains its FIFO slot.
  const abortGate = gate();
  const head = queue.run('a', () => abortGate.promise);
  const controller = new AbortController();
  const abortReason = new Error('waiting request cancelled');
  let cancelledRan = false;
  const cancelled = queue.run('a', () => { cancelledRan = true; }, { signal: controller.signal });
  const cancelledAssertion = assert.rejects(cancelled, (error) => error === abortReason);
  const afterCancelled = queue.run('a', () => 'after cancellation');
  controller.abort(abortReason);
  await cancelledAssertion;
  assert.equal(cancelledRan, false);
  abortGate.resolve();
  await head;
  assert.equal(await afterCancelled, 'after cancellation');
  assert.equal(queue.size, 0);

  // Cancellation of an already-started action does not allow overlapping mutations.
  const activeGate = gate();
  const activeController = new AbortController();
  const active = queue.run('a', () => activeGate.promise, { signal: activeController.signal });
  let nextRan = false;
  const next = queue.run('a', () => { nextRan = true; });
  activeController.abort();
  await Promise.resolve();
  assert.equal(nextRan, false);
  activeGate.resolve('action completed');
  assert.equal(await active, 'action completed');
  await next;
  assert.equal(nextRan, true);
  assert.equal(queue.size, 0);

  // A request already cancelled/invalid at arrival never creates a lane or runs a callback.
  const preCancelled = new AbortController();
  preCancelled.abort(abortReason);
  await assert.rejects(queue.run('a', () => assert.fail('pre-cancelled operation ran'), {
    signal: preCancelled.signal
  }), (error) => error === abortReason);
  await assert.rejects(queue.run('a', () => assert.fail('closed operation ran'), {
    assertCurrent: () => { throw new Error('closed lifecycle'); }
  }), /closed lifecycle/);
  assert.equal(queue.size, 0);

  // Shutdown settles pending promises in every lane; no lane remains once active work settles.
  const shutdownGateA = gate();
  const shutdownGateB = gate();
  const shutdownA = queue.run('a', () => shutdownGateA.promise);
  const shutdownB = queue.run('b', () => shutdownGateB.promise);
  const pendingA = assert.rejects(queue.run('a', () => assert.fail('shutdown a ran')), /stopped/);
  const pendingB = assert.rejects(queue.run('b', () => assert.fail('shutdown b ran')), /stopped/);
  queue.cancelPending('a', new Error('operations stopped'));
  queue.cancelPending('b', new Error('operations stopped'));
  await Promise.all([pendingA, pendingB]);
  shutdownGateA.resolve();
  shutdownGateB.resolve();
  await Promise.all([shutdownA, shutdownB]);
  assert.equal(queue.size, 0);
  console.log('browser-page-operation-queue: all assertions passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
