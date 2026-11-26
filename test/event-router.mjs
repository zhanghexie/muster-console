import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-router-'));
let log;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const { EventLog } = await import(pathToFileURL(compile('main/awareness/eventLog.ts')).href);
  const { EventRouter } = await import(pathToFileURL(compile('main/awareness/eventRouter.ts')).href);
  const reported = [];
  const broken = new EventRouter({ append() { throw new Error('disk failed'); } }, async () => {}, () => true,
    (error, workspaceId) => reported.push({ error: error.message, workspaceId }));
  const oldConsoleError = console.error;
  try {
    console.error = () => {};
    assert.throws(() => broken.publish({ workspaceId: 'w' }), /disk failed/);
    assert.throws(() => broken.publish({ workspaceId: 'w' }), /disk failed/);
  } finally { console.error = oldConsoleError; }
  assert.deepEqual(reported, [{ error: 'disk failed', workspaceId: 'w' }], 'persistence failures are surfaced');
  log = new EventLog(path.join(tmp, 'db'));
  const base = { subject: 'worker', workspaceId: 'w', source: 'file', types: ['changed'], scope: '', mode: 'instant', createdAt: Date.now(), expiresAt: null };
  const sub = log.subscribe(base);
  let failed = true; const delivered = [];
  const router = new EventRouter(log, async (_sub, event) => {
    if (failed) throw new Error('offline');
    delivered.push(event.id);
  });
  const add = (scope, workspaceId) => log.append({ source: 'file', type: 'changed', scope, workspaceId, receivedAt: Date.now(), summary: 'changed', payload: '{}' }).event;
  add('wrong-workspace', 'other');
  const wanted = add('right-workspace', 'w');
  await assert.rejects(router.replay(), /offline/);
  assert.ok(log.subscriptions('worker')[0].cursor < wanted.sequence, 'failed delivery remains pending');
  failed = false;
  await router.replay();
  assert.deepEqual(delivered, [wanted.id]);
  await router.replay();
  assert.deepEqual(delivered, [wanted.id], 'successful delivery is not repeated');
  assert.equal(log.subscriptions('worker')[0].cursor, wanted.sequence);
  const newer = log.subscribe({ ...base, subject: 'second' });
  assert.equal(newer.startCursor, wanted.sequence, 'new subscription does not expose previous events');
  assert.equal(log.unsubscribe(sub.id, 'worker'), true);
  await router.shutdown(); log.close(); log = undefined;
  const pendingLog = new EventLog(path.join(tmp, 'shutdown'));
  let release;
  try {
    pendingLog.subscribe(base);
    const first = pendingLog.append({ source: 'file', type: 'changed', scope: '', workspaceId: 'w', receivedAt: Date.now(), summary: 'one', payload: '{}' }).event;
    const pendingRouter = new EventRouter(pendingLog, async () => { await new Promise(resolve => { release = resolve; }); });
    const replay = pendingRouter.replay();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    let drained = false;
    const drain = pendingRouter.shutdown().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    const late = pendingRouter.publish({ source: 'file', type: 'changed', scope: '', workspaceId: 'w', receivedAt: Date.now(), summary: 'two', payload: '{}' }).event;
    release(); await replay; await drain;
    assert.equal(pendingLog.subscriptions('worker')[0].cursor, first.sequence, 'accepted receipt is saved before closing the log');
    assert.throws(() => pendingRouter.publish({ source: 'file' }), /closed/);
    const recovered = [];
    const next = new EventRouter(pendingLog, async (_sub, event) => { recovered.push(event.id); });
    await next.replay(); assert.deepEqual(recovered, [late.id], 'shutdown does not consume a not-yet-delivered durable event');
    await next.shutdown();
    pendingLog.append({ source: 'file', type: 'changed', scope: '', workspaceId: 'w', receivedAt: Date.now(), summary: 'sync-stop', payload: '{}' });
    let finishReentry, reentryStop, reentryDrained = false;
    const reentryGate = new Promise(resolve => { finishReentry = resolve; });
    const reentrant = new EventRouter(pendingLog, async () => {
      reentryStop = reentrant.shutdown().then(() => { reentryDrained = true; });
      await reentryGate;
    });
    const acceptedReentry = reentrant.replay();
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(reentryStop);
      assert.equal(reentryDrained, false, 'a synchronous delivery callback cannot hide its accepted replay from shutdown');
    } finally { finishReentry(); await acceptedReentry; await reentryStop; }
  } finally { release?.(); pendingLog.close(); }
} finally {
  log?.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
console.log('event-router: ok');
