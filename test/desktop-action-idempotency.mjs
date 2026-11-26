import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-idempotency-'));
let store;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const dir = path.join(temp, 'data'); store = new DesktopActionIdempotency(dir);
  let count = 0;
  const execute = async mark => { mark(); return { outcome: 'dispatched', value: { calls: ++count } }; };
  const request = { action: 'click', target: { x: 1, y: 2 } };
  const run = (id, value = request) => store.run('session', 'task', id, value, () => true, execute);
  const first = await run('one'); assert.equal(first.outcome, 'dispatched'); assert.equal(count, 1);
  assert.deepEqual(await run('one', { target: { y: 2, x: 1 }, action: 'click' }), first);
  assert.equal(count, 1, 'the same request ID returns the durable receipt without redispatch');
  await assert.rejects(run('one', { action: 'click', target: { x: 2, y: 2 } }), /different operation/);
  store.close(); store = new DesktopActionIdempotency(dir);
  assert.deepEqual(await run('one'), first); assert.equal(count, 1, 'receipt survives restart');
  await assert.rejects(store.run('session', 'task', 'preflight', request, () => true, async () => { throw new Error('target expired'); }), /target expired/);
  assert.equal((await run('preflight')).outcome, 'dispatched', 'pre-dispatch failure allows retry with the same ID');
  await assert.rejects(store.run('session', 'task', 'lost', request, () => true, async mark => { mark(); count++; throw new Error('connection lost'); }), /connection lost/);
  assert.deepEqual(await run('lost'), { outcome: 'unknown' }); assert.equal(count, 3, 'a pending operation is never replayed');
  assert.equal((await store.run('other', 'task', 'one', request, () => true, execute)).outcome, 'dispatched');
  assert.equal(count, 4, 'request IDs are scoped to the host session and task');
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const ongoing = store.run('session', 'task', 'pending', request, () => true, async mark => {
    mark(); started(); await new Promise(resolve => { release = resolve; }); return { outcome: 'dispatched', value: 'done' };
  });
  await entered;
  assert.deepEqual(await run('pending'), { outcome: 'unknown' }, 'an in-flight request must not be dispatched again');
  release(); assert.equal((await ongoing).outcome, 'dispatched');
  assert.deepEqual(await run('pending'), { outcome: 'dispatched', value: 'done' });
  let currentAtCommit = true;
  const interrupted = store.run('session', 'task', 'interrupted-at-commit', request, () => currentAtCommit, async mark => {
    mark();
    queueMicrotask(() => { currentAtCommit = false; });
    return { outcome: 'dispatched', value: 'backend returned before cancellation was processed' };
  });
  await assert.rejects(interrupted, /no longer current/);
  currentAtCommit = true;
  assert.deepEqual(await run('interrupted-at-commit'), { outcome: 'unknown' },
    'the durable receipt must remain unknown if the originating turn changes before persistence');
  const otherConnection = new DatabaseSync(path.join(dir, 'action-receipts.sqlite'));
  try {
    const key = createHash('sha256').update(JSON.stringify(['session', 'task', 'lost-before-save'])).digest('hex');
    await assert.rejects(store.run('session', 'task', 'lost-before-save', request, () => true, async mark => {
      mark();
      otherConnection.prepare('DELETE FROM desktop_action_receipts WHERE request_hash = ?').run(key);
      return { outcome: 'dispatched' };
    }), /receipt could not be persisted; outcome is unknown/);
  } finally { otherConnection.close(); }
  await assert.rejects(run('bad request id'), /request identity/);
  await assert.rejects(store.run('session', 'task', 'stale', request, () => false, execute), /no longer current/);
  console.log('desktop action idempotency: durable replay, conflict, unknown and session scope passed');
} finally { store?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
