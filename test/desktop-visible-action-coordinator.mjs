import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'visible-action-'));
const stores = [];
const barriers = [];
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const outboxFile = compile('main/desktop/writeOutbox.ts');
  const lockFile = compile('main/desktop/taskLock.ts');
  const barrierFile = compile('main/desktop/visibleActionBarrier.ts');
  const coordinatorFile = compile('main/desktop/visibleActionCoordinator.ts');
  const factoryFile = compile('main/desktop/visibleActionFactory.ts');
  const { WriteOutbox } = await import(pathToFileURL(outboxFile));
  const { DesktopTaskLock } = await import(pathToFileURL(lockFile));
  const { VisibleActionBarrier } = await import(pathToFileURL(barrierFile));
  const { VisibleActionCoordinator, VisibleActionPreDispatchFailure, VisibleActionAcknowledgementFailure } = await import(pathToFileURL(coordinatorFile));
  const { createVisibleActionRuntime } = await import(pathToFileURL(factoryFile));

  const dbPath = path.join(temp, 'outbox.sqlite');
  const lockDir = path.join(temp, 'locks');
  const barrierDbPath = dbPath;
  const openStore = () => { const store = new WriteOutbox(dbPath); stores.push(store); return store; };
  const openBarrier = () => { const barrier = new VisibleActionBarrier(barrierDbPath); barriers.push(barrier); return barrier; };
  let store = openStore();
  const make = (outbox = store, lock = new DesktopTaskLock(lockDir), barrier = openBarrier()) =>
    new VisibleActionCoordinator(outbox, lock, barrier);
  let coordinator = make();
  const context = (taskId, state = { current: true, visible: true, epoch: 1 }, sessionId = 'session-A') => ({
    sessionId, taskId, target: 'window-A', action: 'click', indicatorEpoch: 1,
    isCurrent: () => state.current, isIndicatorCurrent: epoch => state.visible && state.epoch === epoch
  });
  const pred = error => error instanceof VisibleActionPreDispatchFailure && error.code === 'pre-dispatch-failure';
  const ackPred = error => error instanceof VisibleActionAcknowledgementFailure && error.code === 'acknowledgement-rejected';
  let calls = 0;

  const firstCtx = context('loss');
  const first = await coordinator.run(firstCtx, async () => ({ count: ++calls, nested: ['ok', null] }));
  assert.equal(first.outcome, 'known');
  assert.deepEqual(first.value, { count: 1, nested: ['ok', null] });
  assert.equal(store.isTaskBlocked('session-A', 'loss'), true);
  assert.equal(store.get('session-A', first.invocationId).state, 'result');
  // A lost result must block a later tool request, regardless of its new ID or session.
  for (const [requestId, candidate] of [['request-2', firstCtx], ['request-3', context('loss', undefined, 'session-B')]]) {
    await assert.rejects(coordinator.run(candidate, async () => { calls++; return requestId; }),
      error => pred(error) && error.recoveryRequired === false);
  }
  assert.equal(calls, 1);
  const failBeforeDispatchRelease = { acquire: async task => {
    const release = await new DesktopTaskLock(lockDir).acquire(task);
    return async () => { await release(); throw new Error('release receipt lost'); };
  } };
  await assert.rejects(make(store, failBeforeDispatchRelease).run(firstCtx, async () => { calls++; }),
    error => pred(error) && error.recoveryRequired === true && /requires recovery/.test(error.message));
  assert.equal(calls, 1);
  await assert.rejects(coordinator.acknowledgeKnown({ ...firstCtx, target: 'window-B' }, first.invocationId, 'ack-wrong-target', first.deliveryToken), ackPred);
  await assert.rejects(coordinator.acknowledgeKnown(context('loss', undefined, 'session-B'), first.invocationId, 'ack-wrong-session', first.deliveryToken), ackPred);
  await assert.rejects(coordinator.acknowledgeKnown(firstCtx, first.invocationId, 'ack-wrong-token', 'A'.repeat(43)), ackPred);
  assert.deepEqual(await coordinator.acknowledgeKnown(firstCtx, first.invocationId, 'ack-1', first.deliveryToken), { outcome: 'acknowledged' });
  assert.deepEqual(await coordinator.acknowledgeKnown(firstCtx, first.invocationId, 'ack-1', first.deliveryToken), { outcome: 'acknowledged' }, 'same receipt is idempotent');
  assert.equal(store.isTaskBlocked('session-A', 'loss'), false);
  const second = await coordinator.run(firstCtx, async () => ({ count: ++calls }));
  assert.equal(second.outcome, 'known');
  assert.equal(calls, 2);
  assert.deepEqual(await coordinator.acknowledgeKnown(firstCtx, second.invocationId, 'ack-2', second.deliveryToken), { outcome: 'acknowledged' });

  const originalValue = { nested: { value: 1 } };
  const cloned = await coordinator.run(context('snapshot'), async () => originalValue);
  originalValue.nested.value = 2;
  assert.deepEqual(cloned.value, { nested: { value: 1 } }, 'returned JSON must be the durable readback, not the mutable backend object');

  const unknownCtx = context('unknown');
  const unknown = await coordinator.run(unknownCtx, async () => { throw new Error('backend may have acted'); });
  assert.equal(unknown.outcome, 'unknown');
  assert.equal(unknown.reason, 'backend-failed');
  assert.deepEqual(store.get('session-A', unknown.invocationId).result, { outcome: 'unknown' });
  await assert.rejects(coordinator.acknowledgeKnown(unknownCtx, unknown.invocationId, 'ack-unknown', 'A'.repeat(43)), ackPred);
  assert.equal(store.isTaskBlocked('session-A', 'unknown'), true);
  await assert.rejects(coordinator.run(unknownCtx, async () => true), pred);

  const invalidResultCtx = context('invalid-result');
  const invalidResult = await coordinator.run(invalidResultCtx, async () => new Date());
  assert.equal(invalidResult.outcome, 'unknown');
  assert.equal(invalidResult.reason, 'result-persistence-failed');
  assert.equal(store.get('session-A', invalidResult.invocationId).state, 'dispatched');
  await assert.rejects(coordinator.run(invalidResultCtx, async () => true), pred);
  const tooLarge = await coordinator.run(context('large-result'), async () => 'a'.repeat(65536));
  assert.equal(tooLarge.outcome, 'unknown');
  assert.equal(tooLarge.reason, 'result-persistence-failed');

  const commitThenThrow = Object.create(store);
  commitThenThrow.complete = (...args) => { store.complete(...args); throw new Error('result receipt lost'); };
  const persistLostCtx = context('persist-lost');
  const persistLost = await make(commitThenThrow).run(persistLostCtx, async () => ({ done: true }));
  assert.equal(persistLost.outcome, 'unknown');
  assert.equal(persistLost.reason, 'result-persistence-failed');
  assert.equal(store.get('session-A', persistLost.invocationId).result.outcome, 'known');
  await assert.rejects(coordinator.acknowledgeKnown(persistLostCtx, persistLost.invocationId, 'ack-lost-result', 'A'.repeat(43)), ackPred);
  await assert.rejects(coordinator.run(context('persist-lost', undefined, 'session-B'), async () => true), pred);

  const preparedBarrier = openBarrier();
  const prepareThenThrow = {
    read: (...args) => preparedBarrier.read(...args),
    isTaskBlocked: (...args) => preparedBarrier.isTaskBlocked(...args),
    begin: (...args) => preparedBarrier.begin(...args),
    matches: (...args) => preparedBarrier.matches(...args),
    finish: (...args) => preparedBarrier.finish(...args),
    prepareDelivery: (...args) => { preparedBarrier.prepareDelivery(...args); throw new Error('delivery token write receipt lost'); }
  };
  const tokenLostCtx = context('delivery-token-lost');
  const tokenLost = await make(store, new DesktopTaskLock(lockDir), prepareThenThrow).run(tokenLostCtx, async () => ({ ok: true }));
  assert.equal(tokenLost.outcome, 'unknown');
  assert.equal(tokenLost.reason, 'result-persistence-failed');
  assert.equal(Object.hasOwn(tokenLost, 'deliveryToken'), false);
  await assert.rejects(coordinator.acknowledgeKnown(tokenLostCtx, tokenLost.invocationId, 'ack-token-lost', 'A'.repeat(43)), ackPred);
  await assert.rejects(coordinator.run(tokenLostCtx, async () => true), pred);

  const preState = { current: true, visible: true, epoch: 1 };
  const preCtx = context('pre-dispatch', preState);
  const changedAfterMark = Object.create(store);
  changedAfterMark.markDispatched = (...args) => { store.markDispatched(...args); preState.current = false; };
  let preCalls = 0;
  let preId;
  await assert.rejects(make(changedAfterMark).run(preCtx, async () => { preCalls++; }), error => {
    preId = error.invocationId;
    return pred(error) && !!preId && error.recoveryRequired === true;
  });
  assert.equal(preCalls, 0, 'a stale context after durable marking must not call the backend');
  assert.equal(store.get('session-A', preId).state, 'dispatched');
  preState.current = true;
  await assert.rejects(coordinator.run(preCtx, async () => true), pred);

  const begunBarrier = openBarrier();
  const beginThenThrow = {
    read: (...args) => begunBarrier.read(...args),
    isTaskBlocked: (...args) => begunBarrier.isTaskBlocked(...args),
    prepareDelivery: (...args) => begunBarrier.prepareDelivery(...args),
    matches: (...args) => begunBarrier.matches(...args),
    finish: (...args) => begunBarrier.finish(...args),
    begin: (...args) => { begunBarrier.begin(...args); throw new Error('barrier receipt lost'); }
  };
  let barrierBackendCalls = 0;
  await assert.rejects(make(store, new DesktopTaskLock(lockDir), beginThenThrow).run(context('begin-lost'), async () => { barrierBackendCalls++; }), pred);
  assert.equal(barrierBackendCalls, 0);
  await assert.rejects(coordinator.run(context('begin-lost', undefined, 'session-B'), async () => true), pred);

  const postState = { current: true, visible: true, epoch: 1 };
  const postCtx = context('stop-during-result', postState);
  const stopAfterWrite = Object.create(store);
  stopAfterWrite.complete = (...args) => { store.complete(...args); postState.epoch++; };
  const stopped = await make(stopAfterWrite).run(postCtx, async () => ({ secret: 'must not disclose' }));
  assert.equal(stopped.outcome, 'unknown');
  assert.equal(stopped.reason, 'current-changed');
  assert.equal(Object.hasOwn(stopped, 'value'), false);
  assert.equal(store.isTaskBlocked('session-A', 'stop-during-result'), true);
  postState.epoch = 1;
  await assert.rejects(coordinator.acknowledgeKnown(postCtx, stopped.invocationId, 'ack-hidden-result', 'A'.repeat(43)), ackPred);
  await assert.rejects(coordinator.run(postCtx, async () => true), pred);

  const releaseStopState = { current: true, visible: true, epoch: 1 };
  const releaseStopCtx = context('stop-during-release', releaseStopState);
  const stopDuringReleaseLock = { acquire: async task => {
    const release = await new DesktopTaskLock(lockDir).acquire(task);
    return async () => { await release(); releaseStopState.visible = false; };
  } };
  const stopDuringRelease = await make(store, stopDuringReleaseLock).run(releaseStopCtx, async () => ({ hidden: true }));
  assert.equal(stopDuringRelease.outcome, 'unknown');
  assert.equal(stopDuringRelease.reason, 'current-changed');
  releaseStopState.visible = true;
  await assert.rejects(coordinator.run(releaseStopCtx, async () => true), pred);

  const controller = new AbortController();
  let backendEntered;
  let finishBackend;
  const entered = new Promise(resolve => { backendEntered = resolve; });
  const pendingBackend = new Promise(resolve => { finishBackend = resolve; });
  const abortCtx = { ...context('abort-inflight'), signal: controller.signal };
  const inFlight = coordinator.run(abortCtx, async () => { backendEntered(); return pendingBackend; });
  await entered;
  controller.abort();
  await assert.rejects(make().run(context('abort-inflight'), async () => true), pred);
  finishBackend({ ok: true });
  const aborted = await inFlight;
  assert.equal(aborted.outcome, 'unknown');
  assert.equal(aborted.reason, 'current-changed');
  assert.equal(store.isTaskBlocked('session-A', 'abort-inflight'), true);

  // A release may unlink the OS lock and still report failure; the independent
  // persistent barrier must block a fresh coordinator in another session.
  const releaseFailureLock = { acquire: async task => {
    const release = await new DesktopTaskLock(lockDir).acquire(task);
    return async () => { await release(); throw new Error('release outcome lost'); };
  } };
  const releaseFailCtx = context('release-fail');
  const releaseFailed = await make(store, releaseFailureLock).run(releaseFailCtx, async () => ({ applied: true }));
  assert.equal(releaseFailed.outcome, 'unknown');
  assert.equal(releaseFailed.reason, 'lock-release-failed');
  assert.equal(Object.hasOwn(releaseFailed, 'deliveryToken'), false);
  await assert.rejects(coordinator.acknowledgeKnown(releaseFailCtx, releaseFailed.invocationId, 'ack-release-hidden', 'A'.repeat(43)), ackPred);
  await assert.rejects(make().run(context('release-fail', undefined, 'session-B'), async () => true), pred);

  const ackFailCtx = context('ack-release-fail');
  const beforeAckFail = await coordinator.run(ackFailCtx, async () => ({ applied: true }));
  const ackFailed = await make(store, releaseFailureLock).acknowledgeKnown(ackFailCtx, beforeAckFail.invocationId, 'ack-release', beforeAckFail.deliveryToken);
  assert.deepEqual(ackFailed, { outcome: 'unknown', reason: 'lock-release-failed' });
  assert.equal(store.get('session-A', beforeAckFail.invocationId).state, 'delivered');
  await assert.rejects(coordinator.acknowledgeKnown(ackFailCtx, beforeAckFail.invocationId, 'ack-release', beforeAckFail.deliveryToken), ackPred);
  await assert.rejects(make().run(context('ack-release-fail', undefined, 'session-B'), async () => true), pred);

  const ackCommitCtx = context('ack-commit-lost');
  const beforeAckCommit = await coordinator.run(ackCommitCtx, async () => true);
  const ackCommitLost = Object.create(store);
  ackCommitLost.acknowledge = (...args) => { store.acknowledge(...args); throw new Error('ack response lost'); };
  assert.deepEqual(await make(ackCommitLost).acknowledgeKnown(ackCommitCtx, beforeAckCommit.invocationId, 'ack-lost', beforeAckCommit.deliveryToken),
    { outcome: 'unknown', reason: 'acknowledgement-failed' });
  await assert.rejects(coordinator.run(ackCommitCtx, async () => true), pred);

  const ackStopState = { current: true, visible: true, epoch: 1 };
  const ackStopCtx = context('ack-stop', ackStopState);
  const beforeAckStop = await coordinator.run(ackStopCtx, async () => true);
  const stopAfterAck = Object.create(store);
  stopAfterAck.acknowledge = (...args) => { store.acknowledge(...args); ackStopState.visible = false; };
  assert.deepEqual(await make(stopAfterAck).acknowledgeKnown(ackStopCtx, beforeAckStop.invocationId, 'ack-stop', beforeAckStop.deliveryToken),
    { outcome: 'unknown', reason: 'acknowledgement-failed' });
  ackStopState.visible = true;
  await assert.rejects(coordinator.run(ackStopCtx, async () => true), pred);

  const ackRollbackState = { current: true, visible: true, epoch: 1 };
  const ackRollbackCtx = context('ack-barrier-rollback', ackRollbackState);
  const beforeAckRollback = await coordinator.run(ackRollbackCtx, async () => true);
  const realBarrier = openBarrier();
  const stopInsideFinish = {
    read: (...args) => realBarrier.read(...args),
    isTaskBlocked: (...args) => realBarrier.isTaskBlocked(...args),
    prepareDelivery: (...args) => realBarrier.prepareDelivery(...args),
    begin: (...args) => realBarrier.begin(...args),
    matches: (...args) => realBarrier.matches(...args),
    finish: (task, marker, assertCurrent) => realBarrier.finish(task, marker, () => {
      ackRollbackState.visible = false;
      assertCurrent();
    })
  };
  assert.deepEqual(await make(store, new DesktopTaskLock(lockDir), stopInsideFinish)
    .acknowledgeKnown(ackRollbackCtx, beforeAckRollback.invocationId, 'ack-rollback', beforeAckRollback.deliveryToken),
  { outcome: 'unknown', reason: 'barrier-release-failed' });
  ackRollbackState.visible = true;
  assert.ok(realBarrier.read('ack-barrier-rollback'), 'the barrier deletion must roll back if validity changes before commit');
  await assert.rejects(coordinator.run(ackRollbackCtx, async () => true), pred);

  const raceCtx = context('ack-race');
  const raceResult = await coordinator.run(raceCtx, async () => ({ ok: 1 }));
  let startedRelease, continueRelease;
  const releaseStarted = new Promise(resolve => { startedRelease = resolve; });
  const releaseGate = new Promise(resolve => { continueRelease = resolve; });
  const waitingLock = { acquire: async task => {
    const release = await new DesktopTaskLock(lockDir).acquire(task);
    return async () => { startedRelease(); await releaseGate; await release(); };
  } };
  const raceAck = make(store, waitingLock).acknowledgeKnown(raceCtx, raceResult.invocationId, 'ack-race-1', raceResult.deliveryToken);
  await releaseStarted;
  await assert.rejects(make().acknowledgeKnown(raceCtx, raceResult.invocationId, 'ack-race-2', raceResult.deliveryToken), ackPred);
  await assert.rejects(make().run(raceCtx, async () => true), pred);
  continueRelease();
  assert.deepEqual(await raceAck, { outcome: 'acknowledged' });
  assert.equal((await coordinator.run(raceCtx, async () => true)).outcome, 'known');

  const badBarrierCtx = context('bad-barrier');
  const badBarrierDb = new DatabaseSync(barrierDbPath);
  badBarrierDb.prepare('INSERT INTO visible_action_barriers(task_hash,version,id,session_hash,invocation_id) VALUES (?,1,?,?,?)')
    .run(createHash('sha256').update('bad-barrier').digest('hex'), 'invalid-id', 'invalid-hash', 'invalid-invocation');
  badBarrierDb.close();
  await assert.rejects(coordinator.run(badBarrierCtx, async () => assert.fail('corrupt barrier dispatched')), pred);

  const corruptCtx = context('corrupt-outbox');
  const corrupt = await coordinator.run(corruptCtx, async () => true);
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE write_outbox SET result = ? WHERE id = ?').run('not-json', corrupt.invocationId);
  db.close();
  await assert.rejects(coordinator.acknowledgeKnown(corruptCtx, corrupt.invocationId, 'ack-corrupt', corrupt.deliveryToken), ackPred);
  await assert.rejects(coordinator.run(corruptCtx, async () => true), pred);

  const tamperedCtx = context('tampered-known');
  const tampered = await coordinator.run(tamperedCtx, async () => ({ approvedValue: 7 }));
  const tamperedDb = new DatabaseSync(dbPath);
  tamperedDb.prepare('UPDATE write_outbox SET result = ? WHERE id = ?')
    .run('{"outcome":"known","value":{"approvedValue":8}}', tampered.invocationId);
  tamperedDb.close();
  await assert.rejects(coordinator.acknowledgeKnown(tamperedCtx, tampered.invocationId, 'ack-tampered', tampered.deliveryToken), ackPred);
  await assert.rejects(coordinator.run(tamperedCtx, async () => true), pred);

  const bareCorrupt = store.create({ sessionId: 'session-A', taskId: 'bare-corrupt', source: 'desktop', action: 'click', target: 'window-A' });
  store.markDispatched('session-A', bareCorrupt);
  store.complete('session-A', bareCorrupt, { outcome: 'known', value: true });
  store.acknowledge('session-A', bareCorrupt, 'bare-receipt');
  const corruptDb = new DatabaseSync(dbPath);
  corruptDb.prepare('UPDATE write_outbox SET result = ? WHERE id = ?').run('not-json', bareCorrupt);
  corruptDb.close();
  await assert.rejects(coordinator.run(context('bare-corrupt'), async () => assert.fail('corrupt outbox dispatched')), pred);

  const forged = store.create({ sessionId: 'session-A', taskId: 'valid-json-corrupt', source: 'desktop', action: 'click', target: 'window-A' });
  store.markDispatched('session-A', forged);
  store.complete('session-A', forged, { outcome: 'known', value: true });
  store.acknowledge('session-A', forged, 'forged-receipt');
  const forgedDb = new DatabaseSync(dbPath);
  forgedDb.prepare('UPDATE write_outbox SET result = ? WHERE id = ?').run('{"outcome":"known","value":1e999}', forged);
  forgedDb.close();
  await assert.rejects(coordinator.run(context('valid-json-corrupt', undefined, 'session-B'), async () => assert.fail('non-finite result dispatched')), pred);

  const legacyTask = 'legacy-cross-session';
  const legacy = store.create({ sessionId: 'session-A', taskId: legacyTask, source: 'desktop', action: 'click', target: 'window-A' });
  store.markDispatched('session-A', legacy);
  store.complete('session-A', legacy, { outcome: 'known', value: true });
  await assert.rejects(coordinator.run(context(legacyTask, undefined, 'session-B'), async () => assert.fail('legacy outbox bypassed')), pred);
  store.acknowledge('session-A', legacy, 'legacy-receipt');
  assert.equal((await coordinator.run(context(legacyTask, undefined, 'session-B'), async () => true)).outcome, 'known');

  const legacyUnknownTask = 'legacy-unknown-cross-session';
  const legacyUnknown = store.create({ sessionId: 'session-A', taskId: legacyUnknownTask, source: 'desktop', action: 'click', target: 'window-A' });
  store.markDispatched('session-A', legacyUnknown);
  store.complete('session-A', legacyUnknown, { outcome: 'unknown' });
  store.acknowledge('session-A', legacyUnknown, 'legacy-unknown-receipt');
  await assert.rejects(coordinator.run(context(legacyUnknownTask, undefined, 'session-B'), async () => assert.fail('legacy unknown bypassed')), pred);
  assert.throws(() => new VisibleActionBarrier(path.join(temp, 'uninitialized.sqlite')), /no such table/i);

  // A separate Node process must see the task barrier even with a new session.
  const crossCtx = context('cross-process');
  const cross = await coordinator.run(crossCtx, async () => ({ ok: true }));
  assert.equal(cross.outcome, 'known');
  const script = `
    const [{WriteOutbox},{DesktopTaskLock},{VisibleActionBarrier},{VisibleActionCoordinator}] = await Promise.all(
      process.argv.slice(1,5).map(path => import(path)));
    const outbox = new WriteOutbox(process.argv[5]);
    const barrier = new VisibleActionBarrier(process.argv[7]);
    const coordinator = new VisibleActionCoordinator(outbox, new DesktopTaskLock(process.argv[6]), barrier);
    const context = {sessionId:'session-B',taskId:'cross-process',target:'window-A',action:'click',indicatorEpoch:1,
      isCurrent:()=>true,isIndicatorCurrent:()=>true};
    try { await coordinator.run(context, async()=>{throw Error('backend should not run')}); process.exitCode=2; }
    catch(error) {
      if(error.code!=='pre-dispatch-failure' || !String(error.cause?.message).includes(process.argv[8])) {
        console.error(error); process.exitCode=3;
      }
    }
    finally { barrier.close(); outbox.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script,
    ...[outboxFile, lockFile, barrierFile, coordinatorFile].map(file => pathToFileURL(file).href), dbPath, lockDir, barrierDbPath, 'Previous visible action'],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, `cross-process barrier failed: ${child.stderr}`);

  // The same entry point also refuses a real OS-level lock held by another process.
  const heldRelease = await new DesktopTaskLock(lockDir).acquire('cross-process');
  try {
    const lockedChild = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      ...[outboxFile, lockFile, barrierFile, coordinatorFile].map(file => pathToFileURL(file).href), dbPath, lockDir, barrierDbPath, 'locked by another coordinator'],
    { encoding: 'utf8', timeout: 10000 });
    assert.equal(lockedChild.status, 0, `cross-process lock failed: ${lockedChild.stderr}`);
  } finally { await heldRelease(); }

  // Reopening both SQLite and the marker directory must retain the block.
  store.close(); stores.pop();
  for (const barrier of barriers.splice(0)) barrier.close();
  store = openStore(); coordinator = make();
  await assert.rejects(coordinator.run(context('cross-process', undefined, 'session-B'), async () => true), pred);

  const restartCtx = context('token-restart');
  const beforeRestart = await coordinator.run(restartCtx, async () => ({ persisted: true }));
  assert.match(beforeRestart.deliveryToken, /^[A-Za-z0-9_-]{43}$/);
  store.close(); stores.pop();
  for (const barrier of barriers.splice(0)) barrier.close();
  store = openStore(); coordinator = make();
  assert.deepEqual(await coordinator.acknowledgeKnown(restartCtx, beforeRestart.invocationId, 'ack-restart', beforeRestart.deliveryToken),
    { outcome: 'acknowledged' });
  assert.equal((await coordinator.run(restartCtx, async () => true)).outcome, 'known');

  const factoryDb = path.join(temp, 'factory.sqlite');
  const factoryA = createVisibleActionRuntime(factoryDb, lockDir);
  const factoryB = createVisibleActionRuntime(factoryDb, lockDir);
  try {
    const factoryCtx = context('factory-task');
    const factoryResult = await factoryA.coordinator.run(factoryCtx, async () => ({ ok: true }));
    await assert.rejects(factoryB.coordinator.run(context('factory-task', undefined, 'session-B'), async () => true), pred);
    assert.deepEqual(await factoryA.coordinator.acknowledgeKnown(factoryCtx, factoryResult.invocationId, 'factory-ack', factoryResult.deliveryToken), { outcome: 'acknowledged' });
    assert.equal((await factoryB.coordinator.run(context('factory-task', undefined, 'session-B'), async () => true)).outcome, 'known');
  } finally {
    factoryA.close(); factoryA.close(); factoryB.close();
  }
  console.log('visible action coordinator: durable blocking, acknowledgement, stop and fault boundaries passed');
} finally {
  for (const barrier of barriers) barrier.close();
  for (const store of stores) store.close();
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(path.resolve('.tmp')));
  assert.ok(path.basename(resolved).startsWith('visible-action-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
