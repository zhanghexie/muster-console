import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-idempotent-visible-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const { IdempotentVisibleDispatcher } = await import(pathToFileURL(compile('main/desktop/idempotentVisibleDispatcher.ts')));
  const { createLocalDesktopDeliverySelector } = await import(pathToFileURL(compile('main/desktop/localDesktopDeliverySelector.ts')));
  const { DesktopTaskLockCleanupError, DesktopTaskLockContendedError, DesktopTaskLockReleaseError } = await import(pathToFileURL(compile('main/desktop/taskLock.ts')));
  const { PreDispatchFailure } = await import(pathToFileURL(compile('main/desktop/preDispatchFailure.ts')));
  const root = path.join(temp, 'receipts');
  let receipts = new DesktopActionIdempotency(root), dispatcher = new IdempotentVisibleDispatcher(receipts);
  let current = true, indicator = true, calls = 0;
  const context = { sessionId: 'session', taskId: 'task', target: 'window', action: 'win32.click', indicatorEpoch: 1,
    isCurrent: () => current, isIndicatorCurrent: epoch => indicator && epoch === 1 };
  const fingerprint = 'a'.repeat(64);
  const effect = { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' };
  const backend = async () => { calls++; return effect; };
  for (const [failure, recovery] of [
    [new DesktopTaskLockCleanupError([new Error('fixture')]), true],
    [new DesktopTaskLockReleaseError([new Error('fixture')]), true],
    [new DesktopTaskLockContendedError(), false]
  ]) {
    const broken = new IdempotentVisibleDispatcher({ async run() { throw failure; } });
    await assert.rejects(broken.run(context, 'lock', fingerprint, backend), error => error.recoveryRequired === recovery);
  }
  const staleBeforeInsert = new IdempotentVisibleDispatcher({ async run(_session, _task, _id, _request, _current, execute) {
    return execute(() => { throw new PreDispatchFailure('turn changed before writing'); });
  } });
  await assert.rejects(staleBeforeInsert.run(context, 'stale-before-insert', fingerprint, backend),
    error => error.recoveryRequired === false);
  assert.equal(calls, 0, 'lock and pre-insert failures cannot dispatch the backend');
  let checks = 0, retried = 0;
  await assert.rejects(dispatcher.run({ ...context, isCurrent: () => ++checks < 4 }, 'stale-real', fingerprint, backend),
    error => error.recoveryRequired === false);
  assert.equal(calls, 0, 'a turn that expires before the real receipt insert cannot dispatch');
  const retriedBeforeInsert = await dispatcher.run(context, 'stale-real', fingerprint, async () => { retried++; return effect; });
  assert.equal(retriedBeforeInsert.reply.outcome, 'dispatched');
  assert.equal(retried, 1, 'a proven pre-insert failure may reuse its request ID');
  // Old Windows code stored the original request as the fingerprint, rather
  // than this adapter's projected request. Preserve its no-replay boundary
  // and do not describe the earlier outcome as known.
  await receipts.run('session', 'task', 'legacy-known', { action: 'click', windowId: 'old-window' }, () => true,
    async mark => { mark(); return { outcome: 'dispatched' }; });
  await assert.rejects(receipts.run('session', 'task', 'legacy-pending', { action: 'click', windowId: 'old-window' }, () => true,
    async mark => { mark(); throw new Error('old executor disappeared'); }), /old executor disappeared/);
  for (const id of ['legacy-known', 'legacy-pending']) {
    await assert.rejects(dispatcher.run(context, id, fingerprint, backend),
      error => /current attempt was not dispatched/.test(error.message) && /earlier record whose result may be unknown/.test(error.message));
  }
  assert.equal(calls, 0, 'legacy receipt conflicts must never dispatch the current attempt');
  const first = await dispatcher.run(context, 'known', fingerprint, backend);
  const replay = await dispatcher.run(context, 'known', fingerprint, backend);
  assert.equal(first.reply.outcome, 'dispatched');
  assert.deepEqual(replay.reply, first.reply);
  assert.equal(calls, 1, 'a repeated request must not dispatch twice');
  assert.deepEqual(await first.acknowledge(), { outcome: 'unknown', reason: 'acknowledgement-failed' },
    'the adapter must not invent proof that an engine consumed the result');
  await assert.rejects(dispatcher.run(context, 'known', 'b'.repeat(64), backend), /not dispatched/);
  assert.equal(calls, 1);

  const failed = await dispatcher.run(context, 'failed', fingerprint, async () => { calls++; throw new Error('private backend failure'); });
  assert.equal(failed.reply.outcome, 'unknown');
  assert.ok(!JSON.stringify(failed).includes('private'));
  const failedAgain = await dispatcher.run(context, 'failed', fingerprint, backend);
  assert.equal(failedAgain.reply.outcome, 'unknown');
  assert.equal(calls, 2, 'a failed dispatch is never automatically replayed');
  const uncertain = await dispatcher.run({ ...context, action: 'cua.click' }, 'uncertain', fingerprint,
    async () => ({ ok: false, delivery: 'unknown', effect: 'partial', verification: 'not_performed' }));
  assert.equal(uncertain.reply.outcome, 'unknown');

  const changed = await dispatcher.run(context, 'changed', fingerprint, async () => { calls++; current = false; return effect; });
  assert.equal(changed.reply.outcome, 'unknown', 'losing the turn after dispatch is not reported as success');
  current = true;
  const readStored = await dispatcher.run(context, 'changed', fingerprint, backend);
  assert.equal(readStored.reply.outcome, 'unknown', 'a stopped action must not become known just because a later turn is current');
  assert.equal(calls, 3, 'reading the durable unknown does not redispatch');
  indicator = false;
  await assert.rejects(dispatcher.run(context, 'hidden', fingerprint, backend), /not dispatched/);
  indicator = true;
  receipts.close();

  // A process can die after marking dispatch and before saving its result.
  // Recreate that durable state without executing a real desktop action.
  const digest = value => createHash('sha256').update(value).digest('hex');
  const db = new DatabaseSync(path.join(root, 'action-receipts.sqlite'));
  db.prepare("INSERT INTO desktop_action_receipts(request_hash,fingerprint,state,result) VALUES(?,?,'pending',NULL)")
    .run(digest(JSON.stringify(['session', 'task', 'crashed'])),
      digest(JSON.stringify({ action: 'win32.click', fingerprint, target: 'window', version: 1 })));
  db.close();
  receipts = new DesktopActionIdempotency(root); dispatcher = new IdempotentVisibleDispatcher(receipts);
  const persisted = await dispatcher.run(context, 'known', fingerprint, backend);
  assert.deepEqual(persisted.reply, first.reply, 'known results survive reopening without claiming delivery');
  const pending = await dispatcher.run(context, 'crashed', fingerprint, backend);
  assert.equal(pending.reply.outcome, 'unknown');
  assert.equal(calls, 3, 'a pending receipt from a crashed process must not be replayed');
  receipts.close();

  const selector = createLocalDesktopDeliverySelector();
  const lease = { owner: 'session', turnId: 'turn', signal: new AbortController().signal, isCurrent: () => true };
  const slot = selector.win32({ sessionId: 'session', taskId: 'task', turnId: 'turn', isCurrent: () => true },
    { lease, indicatorEpoch: 1, isIndicatorCurrent: () => true, isTargetCurrent: () => true, onUnknown() {} });
  assert.equal(slot.lease, lease);
  let acknowledged = false;
  assert.equal(slot.stageDelivery('id', effect, async () => { acknowledged = true; return { outcome: 'acknowledged' }; }), undefined);
  assert.equal(acknowledged, false, 'the common slot must not fabricate a model-delivery receipt');
  console.log('Desktop visible dispatcher: durable deduplication, uncertain outcomes and honest delivery boundaries passed');
} finally { removeWorkspaceFixture(temp, 'desktop-idempotent-visible-'); }
