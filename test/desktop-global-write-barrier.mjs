import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-global-barrier-'));
const opened = new Set();
const children = new Set();
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const moduleFile = compile('main/desktop/globalDesktopWriteBarrier.ts');
  const { GlobalDesktopWriteBarrier } = await import(pathToFileURL(moduleFile));
  const { GlobalDesktopWriteStore, GlobalDesktopWriteRejected } = await import(pathToFileURL(compile('main/desktop/globalDesktopWriteStore.ts')));
  const { DesktopTaskLockCleanupError } = await import(pathToFileURL(compile('main/desktop/taskLock.ts')));
  const { WriteOutbox } = await import(pathToFileURL(compile('main/desktop/writeOutbox.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
    legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyLegacyDelivery: () => true, verifyLegacyResolution: () => true };
  let excluded = true, continuationsExcluded = true, delivered = true, stopped = true, recovery = true, lockRecovery = true;
  let deliveryChecks = 0, denyDeliveryAt = -1, lastLockRecordValid = null;
  const authority = {
    legacyWritersExcluded: () => excluded, legacyAutomaticContinuationsExcluded: () => continuationsExcluded,
    verifyDelivery: ({ evidenceId }) => { deliveryChecks++; return delivered && deliveryChecks !== denyDeliveryAt && evidenceId === 'receipt'; },
    executorStopped: () => stopped,
    verifyRecovery: ({ evidenceId }) => recovery && evidenceId === 'independent-audit',
    verifyAbandonedLock: ({ evidenceId, lockRecordValid }) => { lastLockRecordValid = lockRecordValid; return lockRecovery && evidenceId === 'stopped-owner-audit'; }
  };
  const validFence = { isQuiescent: () => true, holdsExclusiveFence: () => true };
  const context = (requestId, taskId = 'task-A', sessionId = 'session-A', extra = {}) => ({
    requestId, taskId, sessionId, action: 'click', target: 'window', fingerprint: 'a'.repeat(64),
    isCurrent: () => true, timeoutMs: 2000, ...extra
  });
  const known = value => ({ outcome: 'known', value });
  const create = async (name, extra = {}) => {
    const root = path.join(temp, name);
    const barrier = await GlobalDesktopWriteBarrier.activate({ root, legacyRoots: [root], legacyOutboxes: [], fence, authority, ...extra });
    opened.add(barrier); return { root, barrier };
  };
  const close = barrier => { barrier.close(); opened.delete(barrier); };
  const dbFile = root => path.join(root, 'global-desktop-write.sqlite');
  const lockFile = root => path.join(root, 'global-write-locks', `${createHash('sha256').update('muster-global-desktop-write-v1').digest('hex')}.lock`);

  await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: path.join(temp, 'no-fence'), legacyRoots: [], legacyOutboxes: [], fence: { ...fence, allOutboxesEnumerated: () => false }, authority }), /fence/);
  await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: path.join(temp, 'no-roots-proof'), legacyRoots: [], legacyOutboxes: [], fence: { ...fence, allLegacyRootsEnumerated: () => false }, authority }), /fence/);
  await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: path.join(temp, 'old-continuations'), legacyRoots: [], legacyOutboxes: [], fence: { ...fence, legacyAutomaticContinuationsExcluded: () => false }, authority }), /fence/);
  assert.throws(() => GlobalDesktopWriteBarrier.open(path.join(temp, 'missing'), authority));
  {
    const root = path.join(temp, 'incomplete'); fs.mkdirSync(root);
    fs.writeFileSync(dbFile(root), '');
    const incomplete = new GlobalDesktopWriteStore(dbFile(root), true); incomplete.close();
    assert.throws(() => GlobalDesktopWriteBarrier.open(root, authority), /not fully activated/);
  }

  const { root, barrier } = await create('main');
  continuationsExcluded = false;
  await assert.rejects(barrier.run(context('unfenced-continuation'), async () => assert.fail('old continuation entered backend')), /not durably excluded/);
  continuationsExcluded = true;
  assert.equal(barrier.inspect(), null, 'loss of the continuation fence cannot create a marker');
  const first = await barrier.run(context('request-A'), async () => known({ clicked: true }));
  assert.equal(first.outcome, 'known');
  assert.deepEqual(first.value, { clicked: true });
  assert.equal(barrier.inspect().phase, 'known');
  await assert.rejects(barrier.run(context('request-B', 'task-B', 'session-B'), async () => assert.fail('unconfirmed action bypassed')), error => {
    assert.equal(error.name, 'PreDispatchFailure'); assert.match(error.message, /Previous desktop write/); return true;
  });

  // A failed rollback cannot turn a rejected write into a clean rejection.
  const dbExec = barrier.store.db.exec;
  barrier.store.db.exec = function(sql) {
    if (sql === 'ROLLBACK') throw new Error('injected rollback failure');
    return dbExec.call(this, sql);
  };
  try {
    await assert.rejects(barrier.run(context('rollback-failure'), async () => assert.fail('rollback failure dispatched')), error => {
      assert.equal(error.name, 'GlobalDesktopPreDispatchRecoveryRequired'); return true;
    });
  } finally {
    barrier.store.db.exec = dbExec;
    barrier.store.db.exec('ROLLBACK');
  }
  assert.equal(barrier.inspect().operationId, first.operationId);

  // A prior marker rejection is not clean if releasing our lock fails.
  let lockChecks = 0;
  await assert.rejects(barrier.run(context('rejected-release-failure', 'task-B', 'session-B', {
    isCurrent: () => { if (++lockChecks === 2) fs.appendFileSync(lockFile(root), ' '); return true; }
  }), async () => assert.fail('lock failure dispatched')), error => {
    assert.equal(error.name, 'GlobalDesktopPreDispatchRecoveryRequired'); return true;
  });
  assert.equal(barrier.inspect().operationId, first.operationId);
  await barrier.recoverAbandonedLock('stopped-owner-audit', validFence);

  // A partially created lock with failed cleanup is not ordinary contention.
  const acquire = barrier.lock.acquire;
  barrier.lock.acquire = async () => { throw new DesktopTaskLockCleanupError([new Error('write'), new Error('cleanup')]); };
  try {
    await assert.rejects(barrier.run(context('lock-creation-failure'), async () => assert.fail('lock creation failure dispatched')), error => {
      assert.equal(error.name, 'GlobalDesktopPreDispatchRecoveryRequired'); return true;
    });
  } finally { barrier.lock.acquire = acquire; }
  assert.equal(barrier.inspect().operationId, first.operationId);

  await assert.rejects(barrier.acknowledge(context('request-A'), first.operationId, 'x'.repeat(43), 'receipt'), /evidence/);
  delivered = false;
  await assert.rejects(barrier.acknowledge(context('request-A'), first.operationId, first.deliveryToken, 'receipt'), /evidence/);
  delivered = true;
  await assert.rejects(barrier.acknowledge(context('request-A', 'other-task'), first.operationId, first.deliveryToken, 'receipt'), /evidence/);
  assert.deepEqual(await barrier.acknowledge(context('request-A'), first.operationId, first.deliveryToken, 'receipt'), { outcome: 'confirmed' });
  assert.equal(barrier.inspect(), null);
  await assert.rejects(barrier.run(context('request-A', 'new-task', 'new-session'), async () => assert.fail('request replayed')), /different operation/);

  // The rejection type from a host callback does not prove that our already
  // committed marker was absent or rolled back.
  let callbackChecks = 0, callbackOperation;
  await assert.rejects(barrier.run(context('callback-rejected', 'task-A', 'session-A', {
    isCurrent: () => { if (++callbackChecks === 4) throw new GlobalDesktopWriteRejected('host callback'); return true; }
  }), async () => assert.fail('callback failure dispatched')), error => {
    assert.equal(error.name, 'GlobalDesktopPreDispatchRecoveryRequired');
    callbackOperation = error.operationId; assert.equal(typeof callbackOperation, 'string'); return true;
  });
  assert.equal(barrier.inspect().operationId, callbackOperation);
  await barrier.recover(callbackOperation, 'independent-audit', 'confirmed-not-applied', () => true);
  const second = await barrier.run(context('request-B', 'task-B', 'session-B'), async () => known('ok'));
  assert.equal(second.outcome, 'known');
  close(barrier);
  let reopened = GlobalDesktopWriteBarrier.open(root, authority); opened.add(reopened);
  assert.equal(reopened.inspect().operationId, second.operationId, 'known but undelivered survives reopening');
  assert.deepEqual(await reopened.acknowledge(context('request-B', 'task-B', 'session-B'), second.operationId, second.deliveryToken, 'receipt'), { outcome: 'confirmed' });

  const uncertain = await reopened.run(context('uncertain'), async () => ({ outcome: 'unknown' }));
  assert.deepEqual({ outcome: uncertain.outcome, reason: uncertain.reason }, { outcome: 'unknown', reason: 'backend-uncertain' });
  await assert.rejects(reopened.run(context('other', 'task-B', 'session-B'), async () => assert.fail('unknown bypassed')), /Previous desktop write/);
  stopped = false;
  await assert.rejects(reopened.recover(uncertain.operationId, 'independent-audit', 'confirmed-applied', () => true), /Independent/);
  stopped = true; recovery = false;
  await assert.rejects(reopened.recover(uncertain.operationId, 'independent-audit', 'confirmed-applied', () => true), /Independent/);
  recovery = true;
  assert.deepEqual(await reopened.recover(uncertain.operationId, 'independent-audit', 'confirmed-applied', () => true), { outcome: 'resolved' });
  await assert.rejects(reopened.run(context('uncertain', 'new-task', 'new-session'), async () => assert.fail('unknown action replayed')), /different operation/);

  const failed = await reopened.run(context('backend-throws'), async () => { throw new Error('response lost'); });
  assert.equal(failed.reason, 'backend-failed');
  assert.deepEqual(await reopened.recover(failed.operationId, 'independent-audit', 'confirmed-not-applied', () => true), { outcome: 'resolved' });

  const malformed = await reopened.run(context('backend-malformed'), async () => ({ outcome: 'known', value: true, extra: 'untrusted' }));
  assert.equal(malformed.reason, 'backend-uncertain');
  assert.equal(reopened.inspect().phase, 'unknown');
  await reopened.recover(malformed.operationId, 'independent-audit', 'confirmed-applied', () => true);
  let validAfterAction = true;
  const invalidated = await reopened.run(context('invalidated', 'task-A', 'session-A', { isCurrent: () => validAfterAction }), async () => {
    validAfterAction = false; return known(true);
  });
  assert.equal(invalidated.reason, 'current-changed');
  assert.equal(reopened.inspect().phase, 'unknown');
  await reopened.recover(invalidated.operationId, 'independent-audit', 'confirmed-applied', () => true);

  let settleBackend;
  const timeout = await reopened.run(context('timeout', 'task-A', 'session-A', { timeoutMs: 10 }), async () =>
    await new Promise(resolve => { settleBackend = resolve; }));
  assert.equal(timeout.outcome, 'unknown'); assert.equal(timeout.reason, 'timeout');
  assert.throws(() => reopened.close(), /still running/);
  await assert.rejects(reopened.run(context('while-inflight', 'task-B', 'session-B'), async () => assert.fail('lock bypassed')), /locked/);
  settleBackend(known(true));
  await reopened.drain();
  await assert.rejects(reopened.run(context('after-timeout', 'task-B', 'session-B'), async () => assert.fail('marker bypassed')), /Previous desktop write/);
  await reopened.recover(timeout.operationId, 'independent-audit', 'confirmed-applied', () => true);

  const ctl = new AbortController();
  let finishAbort, startedAbort;
  const started = new Promise(resolve => { startedAbort = resolve; });
  const inFlight = reopened.run(context('abort', 'task-A', 'session-A', { signal: ctl.signal }), async () => {
    startedAbort(); return await new Promise(resolve => { finishAbort = resolve; });
  });
  await started; ctl.abort();
  const aborted = await inFlight;
  assert.equal(aborted.reason, 'interrupted');
  finishAbort(known(true)); await reopened.drain();
  await reopened.recover(aborted.operationId, 'independent-audit', 'confirmed-not-applied', () => true);

  let finishBrokenSignal;
  const brokenSignal = { aborted: false, addEventListener() {}, removeEventListener() { throw new Error('listener cleanup failed'); } };
  const broken = await reopened.run(context('broken-signal', 'task-A', 'session-A', { signal: brokenSignal, timeoutMs: 10 }), async () =>
    await new Promise(resolve => { finishBrokenSignal = resolve; }));
  assert.equal(broken.outcome, 'unknown');
  await assert.rejects(reopened.run(context('while-broken-backend', 'task-B', 'session-B'), async () => assert.fail('in-flight backend lost its lock')), /locked/);
  finishBrokenSignal(known(true)); await reopened.drain();
  await reopened.recover(broken.operationId, 'independent-audit', 'confirmed-applied', () => true);

  let validityChecks = 0, dispatches = 0, preparedOperation;
  await assert.rejects(reopened.run(context('cancel-before-dispatch', 'task-A', 'session-A', { isCurrent: () => ++validityChecks < 4 }), async () => {
    dispatches++; return known(true);
  }), error => {
    assert.equal(error.name, 'GlobalDesktopPreDispatchRecoveryRequired');
    assert.equal(typeof error.operationId, 'string'); preparedOperation = error.operationId; return true;
  });
  assert.equal(dispatches, 0);
  assert.equal(reopened.inspect().phase, 'prepared');
  await reopened.recover(preparedOperation, 'independent-audit', 'confirmed-not-applied', () => true);

  const locked = await reopened.run(context('tamper-lock'), async () => {
    fs.appendFileSync(lockFile(root), ' ');
    return known(true);
  });
  assert.equal(locked.reason, 'lock-release-failed');
  assert.ok(reopened.inspect());
  await assert.rejects(reopened.recoverAbandonedLock('stopped-owner-audit', { ...validFence, holdsExclusiveFence: () => false }), /fence/);
  lockRecovery = false;
  await assert.rejects(reopened.recoverAbandonedLock('stopped-owner-audit', validFence), /evidence/);
  lockRecovery = true;
  await reopened.recoverAbandonedLock('stopped-owner-audit', validFence);
  assert.ok(reopened.inspect(), 'removing a stale lock does not remove the marker');
  await reopened.recover(locked.operationId, 'independent-audit', 'confirmed-applied', () => true);

  const ackLock = await reopened.run(context('ack-lock-failure'), async () => known(true));
  const verifyDelivery = authority.verifyDelivery;
  let tampered = false;
  authority.verifyDelivery = input => {
    if (!tampered) { tampered = true; fs.appendFileSync(lockFile(root), ' '); }
    return verifyDelivery(input);
  };
  assert.deepEqual(await reopened.acknowledge(context('ack-lock-failure'), ackLock.operationId, ackLock.deliveryToken, 'receipt'),
    { outcome: 'unknown', reason: 'lock-release-failed' });
  authority.verifyDelivery = verifyDelivery;
  assert.equal(reopened.inspect().operationId, ackLock.operationId, 'failed lock release must retain the marker');
  await reopened.recoverAbandonedLock('stopped-owner-audit', validFence);
  assert.deepEqual(await reopened.acknowledge(context('ack-lock-failure'), ackLock.operationId, ackLock.deliveryToken, 'receipt'), { outcome: 'confirmed' });

  // A process can crash while creating its lock, leaving an incomplete record.
  // It still needs a host fence and independent evidence; age/PID are irrelevant.
  fs.writeFileSync(lockFile(root), '{');
  await assert.rejects(reopened.run(context('partial-lock'), async () => assert.fail('partial lock bypassed')), /locked/);
  await reopened.recoverAbandonedLock('stopped-owner-audit', validFence);
  assert.equal(lastLockRecordValid, false);
  const afterPartial = await reopened.run(context('partial-lock'), async () => known(true));
  await reopened.acknowledge(context('partial-lock'), afterPartial.operationId, afterPartial.deliveryToken, 'receipt');

  const resultFault = new DatabaseSync(dbFile(root));
  resultFault.exec("CREATE TRIGGER global_fail_result BEFORE UPDATE ON global_desktop_history WHEN NEW.phase='known' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  const resultUnknown = await reopened.run(context('result-write-failure'), async () => known({ effect: true }));
  assert.equal(resultUnknown.reason, 'result-persistence-failed');
  assert.equal(reopened.inspect().phase, 'prepared');
  await assert.rejects(reopened.run(context('result-write-bypass', 'task-B', 'session-B'), async () => assert.fail('result failure bypassed')), /Previous desktop write/);
  resultFault.exec('DROP TRIGGER global_fail_result'); resultFault.close();
  await reopened.recover(resultUnknown.operationId, 'independent-audit', 'confirmed-applied', () => true);

  const deletion = await reopened.run(context('delete-failure'), async () => known({ effect: true }));
  const inject = new DatabaseSync(dbFile(root));
  inject.exec("CREATE TRIGGER global_fail_delete BEFORE DELETE ON global_desktop_marker BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.deepEqual(await reopened.acknowledge(context('delete-failure'), deletion.operationId, deletion.deliveryToken, 'receipt'),
    { outcome: 'unknown', reason: 'barrier-finalization-failed' });
  assert.equal(reopened.inspect().operationId, deletion.operationId);
  inject.exec('DROP TRIGGER global_fail_delete'); inject.close();
  deliveryChecks = 0; denyDeliveryAt = 4;
  assert.deepEqual(await reopened.acknowledge(context('delete-failure'), deletion.operationId, deletion.deliveryToken, 'receipt'),
    { outcome: 'unknown', reason: 'barrier-finalization-failed' });
  assert.equal(reopened.inspect().operationId, deletion.operationId, 'lost proof rolls back marker deletion');
  denyDeliveryAt = -1;
  assert.deepEqual(await reopened.acknowledge(context('delete-failure'), deletion.operationId, deletion.deliveryToken, 'receipt'), { outcome: 'confirmed' });

  // Corruption and a removed marker cannot silently turn an unresolved history row into permission.
  const corrupt = await reopened.run(context('corrupt-marker'), async () => known(true));
  const corruptDb = new DatabaseSync(dbFile(root));
  corruptDb.exec('DELETE FROM global_desktop_marker'); corruptDb.close();
  assert.throws(() => reopened.inspect(), /inconsistent/);
  await assert.rejects(reopened.run(context('after-corrupt'), async () => assert.fail('corrupt history bypassed')), /inconsistent/);
  assert.equal(corrupt.outcome, 'known');
  close(reopened);

  {
    const terminal = await create('terminal-corruption');
    const result = await terminal.barrier.run(context('terminal-request'), async () => known(true));
    await terminal.barrier.acknowledge(context('terminal-request'), result.operationId, result.deliveryToken, 'receipt');
    const db = new DatabaseSync(dbFile(terminal.root));
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('UPDATE global_desktop_history SET audit_hash=NULL WHERE operation_id=?').run(result.operationId);
    db.close();
    await assert.rejects(terminal.barrier.run(context('after-terminal-corruption'), async () => assert.fail('corrupt audit bypassed')), /Invalid global desktop action history/);
    close(terminal.barrier);
  }

  // Real child-process crash: a prepared row and orphaned file lock survive.
  const crash = await create('crash');
  close(crash.barrier);
  const moduleUrl = pathToFileURL(moduleFile).href;
  const childScript = `
    const { GlobalDesktopWriteBarrier } = await import(process.argv[1]);
    const authority = { legacyWritersExcluded:()=>true, legacyAutomaticContinuationsExcluded:()=>true, verifyDelivery:()=>true, executorStopped:()=>true,
      verifyRecovery:()=>true, verifyAbandonedLock:()=>true };
    const barrier = GlobalDesktopWriteBarrier.open(process.argv[2], authority);
    const context = {requestId:'crash-request',sessionId:'s1',taskId:'t1',action:'click',target:'w',fingerprint:'a'.repeat(64),isCurrent:()=>true,timeoutMs:1000};
    await barrier.run(context, async()=>{ process.exit(73); });
    process.exit(2);
  `;
  const crashed = spawn(process.execPath, ['--input-type=module', '-e', childScript, moduleUrl, crash.root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(crashed); let crashErr = ''; crashed.stderr.on('data', data => { crashErr += data; });
  const [crashCode] = await once(crashed, 'exit'); children.delete(crashed);
  assert.equal(crashCode, 73, crashErr);
  const afterCrash = GlobalDesktopWriteBarrier.open(crash.root, authority); opened.add(afterCrash);
  const crashMarker = afterCrash.inspect(); assert.equal(crashMarker.phase, 'prepared');
  const crashContext = { requestId: 'crash-request', sessionId: 's1', taskId: 't1', action: 'click', target: 'w',
    fingerprint: 'a'.repeat(64), isCurrent: () => true, timeoutMs: 1000 };
  const crashRetry = await afterCrash.run(crashContext, async () => assert.fail('crashed request replayed'));
  assert.equal(crashRetry.reason, 'request-already-recorded'); assert.equal(crashRetry.operationId, crashMarker.operationId);
  await assert.rejects(afterCrash.run(context('fresh-after-crash', 'new-task', 'new-session'), async () => assert.fail('crash replayed')), /locked/);
  await afterCrash.recoverAbandonedLock('stopped-owner-audit', validFence);
  await assert.rejects(afterCrash.run(context('fresh-after-unlock', 'new-task', 'new-session'), async () => assert.fail('crash marker bypassed')), /Previous desktop write/);
  await afterCrash.recover(crashMarker.operationId, 'independent-audit', 'confirmed-not-applied', () => true);
  await assert.rejects(afterCrash.run(context('crash-request', 'new-task', 'new-session'), async () => assert.fail('crashed request replayed')), /different operation/);
  const afterRecovery = await afterCrash.run(context('fresh-after-recovery'), async () => known(true));
  await afterCrash.acknowledge(context('fresh-after-recovery'), afterRecovery.operationId, afterRecovery.deliveryToken, 'receipt');
  close(afterCrash);

  // A child exits normally after an unknown outcome and releases the lock;
  // another process/task must still see the durable unknown marker.
  const unknownRestart = await create('unknown-restart');
  close(unknownRestart.barrier);
  const unknownScript = `
    const { GlobalDesktopWriteBarrier } = await import(process.argv[1]);
    const authority = { legacyWritersExcluded:()=>true, legacyAutomaticContinuationsExcluded:()=>true, verifyDelivery:()=>true, executorStopped:()=>true,
      verifyRecovery:()=>true, verifyAbandonedLock:()=>true };
    const barrier = GlobalDesktopWriteBarrier.open(process.argv[2], authority);
    const context = {requestId:'unknown-request',sessionId:'s1',taskId:'t1',action:'click',target:'w',fingerprint:'a'.repeat(64),isCurrent:()=>true,timeoutMs:1000};
    const result = await barrier.run(context, async()=>({outcome:'unknown'}));
    barrier.close(); if(result.outcome!=='unknown') process.exitCode=2;
  `;
  const unknownChild = spawn(process.execPath, ['--input-type=module', '-e', unknownScript, moduleUrl, unknownRestart.root],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(unknownChild); let unknownErr = ''; unknownChild.stderr.on('data', data => { unknownErr += data; });
  const [unknownCode] = await once(unknownChild, 'exit'); children.delete(unknownChild); assert.equal(unknownCode, 0, unknownErr);
  assert.equal(fs.existsSync(lockFile(unknownRestart.root)), false, 'child released the OS file lock');
  const unknownOpened = GlobalDesktopWriteBarrier.open(unknownRestart.root, authority); opened.add(unknownOpened);
  const unknownMarker = unknownOpened.inspect(); assert.equal(unknownMarker.phase, 'unknown');
  const unknownContext = { requestId: 'unknown-request', sessionId: 's1', taskId: 't1', action: 'click', target: 'w',
    fingerprint: 'a'.repeat(64), isCurrent: () => true, timeoutMs: 1000 };
  const unknownRetry = await unknownOpened.run(unknownContext, async () => assert.fail('unknown request replayed'));
  assert.equal(unknownRetry.reason, 'request-already-recorded'); assert.equal(unknownRetry.operationId, unknownMarker.operationId);
  await assert.rejects(unknownOpened.run(context('other-request', 'new-task', 'new-session'), async () => assert.fail('unknown restart bypassed')), /Previous desktop write/);
  await unknownOpened.recover(unknownMarker.operationId, 'independent-audit', 'confirmed-applied', () => true);
  await assert.rejects(unknownOpened.run(context('unknown-request', 'new-task', 'new-session'), async () => assert.fail('unknown request replayed')), /different operation/);
  close(unknownOpened);

  // Two independent processes contend on the same global lock, even for different tasks.
  const concurrent = await create('concurrent');
  const concurrentScript = `
    const { GlobalDesktopWriteBarrier } = await import(process.argv[1]);
    const authority = { legacyWritersExcluded:()=>true, legacyAutomaticContinuationsExcluded:()=>true, verifyDelivery:()=>true, executorStopped:()=>true, verifyRecovery:()=>true, verifyAbandonedLock:()=>true };
    const barrier = GlobalDesktopWriteBarrier.open(process.argv[2], authority);
    const context = {requestId:'child',sessionId:'child-session',taskId:'child-task',action:'click',target:'w',fingerprint:'a'.repeat(64),isCurrent:()=>true,timeoutMs:5000};
    const result = await barrier.run(context, async()=>{ process.send({stage:'entered'}); await new Promise(r=>process.once('message',r)); return {outcome:'known',value:true}; });
    process.send({stage:'finished',result}); barrier.close(); process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', concurrentScript, moduleUrl, concurrent.root],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  children.add(child); let childErr = ''; child.stderr.on('data', data => { childErr += data; });
  const [entered] = await once(child, 'message'); assert.equal(entered.stage, 'entered');
  const childContext = { requestId: 'child', sessionId: 'child-session', taskId: 'child-task', action: 'click', target: 'w', fingerprint: 'a'.repeat(64), isCurrent: () => true, timeoutMs: 5000 };
  const childRetry = await concurrent.barrier.run(childContext, async () => assert.fail('child request replayed'));
  assert.equal(childRetry.reason, 'request-already-recorded');
  assert.equal(childRetry.operationId, concurrent.barrier.inspect().operationId);
  await assert.rejects(concurrent.barrier.run(context('parent-concurrent', 'other-task', 'other-session'), async () => assert.fail('concurrent dispatch')), /locked/);
  const finishing = once(child, 'message'); child.send('finish');
  const [finished] = await finishing; assert.equal(finished.stage, 'finished'); assert.equal(finished.result.outcome, 'known');
  const [childCode] = await once(child, 'exit'); children.delete(child); assert.equal(childCode, 0, childErr);
  await assert.rejects(concurrent.barrier.run(context('parent-after', 'other-task', 'other-session'), async () => assert.fail('unconfirmed child bypassed')), /Previous desktop write/);
  await concurrent.barrier.acknowledge(childContext, finished.result.operationId, finished.result.deliveryToken, 'receipt');
  close(concurrent.barrier);

  // Until the first executor commits a marker, the second cannot establish
  // whether its request and parameters match the lock owner.
  const early = await create('before-registration');
  const earlyPeer = GlobalDesktopWriteBarrier.open(early.root, authority); opened.add(earlyPeer);
  const earlyAcquire = early.barrier.lock.acquire;
  let signalLocked, allowRegistration;
  const lockedFirst = new Promise(resolve => { signalLocked = resolve; });
  const registerFirst = new Promise(resolve => { allowRegistration = resolve; });
  early.barrier.lock.acquire = async function(key) {
    const release = await earlyAcquire.call(this, key);
    signalLocked(); await registerFirst; return release;
  };
  const originalRequest = early.barrier.run(context('before-marker'), async () => known(true));
  await lockedFirst;
  await assert.rejects(earlyPeer.run(context('before-marker'), async () => assert.fail('unregistered duplicate dispatched')), error => {
    assert.equal(error.name, 'PreDispatchFailure'); assert.match(error.message, /locked/); return true;
  });
  assert.equal(earlyPeer.inspect(), null);
  allowRegistration();
  const registered = await originalRequest;
  assert.equal(registered.outcome, 'known');
  assert.deepEqual(await early.barrier.acknowledge(context('before-marker'), registered.operationId, registered.deliveryToken, 'receipt'), { outcome: 'confirmed' });
  close(earlyPeer); close(early.barrier);

  // A contender can commit after the first snapshot but before our EEXIST.
  // Check the new snapshot instead of treating contention as identity proof.
  for (const scenario of ['same', 'different', 'rollback-failure']) {
    const contended = await create(`contended-recheck-${scenario}`);
    const peer = GlobalDesktopWriteBarrier.open(contended.root, authority); opened.add(peer);
    const acquireContended = contended.barrier.lock.acquire;
    const originalExec = contended.barrier.store.db.exec;
    let markEntered, releasePeer, peerJob;
    const entered = new Promise(resolve => { markEntered = resolve; });
    const peerGate = new Promise(resolve => { releasePeer = resolve; });
    const peerContext = context('contended-request');
    contended.barrier.lock.acquire = async function(key) {
      peerJob = peer.run(peerContext, async () => { markEntered(); await peerGate; return known(true); });
      await entered;
      if (scenario === 'rollback-failure') contended.barrier.store.db.exec = function(sql) {
        if (sql === 'ROLLBACK') throw new Error('injected contended recheck rollback failure');
        return originalExec.call(this, sql);
      };
      return acquireContended.call(this, key);
    };
    const request = context('contended-request', 'task-A', 'session-A', scenario === 'same' ? {} : { fingerprint: 'b'.repeat(64) });
    try {
      if (scenario === 'different') await assert.rejects(contended.barrier.run(request, async () => assert.fail('conflicting contender dispatched')), /different operation/);
      else if (scenario === 'rollback-failure') await assert.rejects(contended.barrier.run(request, async () => assert.fail('unsafe contender dispatched')), error => {
        assert.equal(error.name, 'GlobalDesktopPreDispatchRecoveryRequired'); return true;
      });
      else {
        const duplicate = await contended.barrier.run(request, async () => assert.fail('duplicate contender dispatched'));
        assert.equal(duplicate.reason, 'request-already-recorded');
        assert.equal(duplicate.operationId, peer.inspect().operationId);
      }
    } finally {
      if (scenario === 'rollback-failure') {
        contended.barrier.store.db.exec = originalExec;
        contended.barrier.store.db.exec('ROLLBACK');
      }
      releasePeer();
    }
    const result = await peerJob;
    assert.deepEqual(await peer.acknowledge(peerContext, result.operationId, result.deliveryToken, 'receipt'), { outcome: 'confirmed' });
    close(peer); close(contended.barrier);
  }

  // Recheck after acquiring the lock if another executor committed between
  // the initial lookup and acquisition.
  const race = await create('lookup-race');
  const racePeer = GlobalDesktopWriteBarrier.open(race.root, authority); opened.add(racePeer);
  const originalAcquire = race.barrier.lock.acquire;
  let peerResult;
  race.barrier.lock.acquire = async function(key) {
    peerResult = await racePeer.run(context('racing-request'), async () => known(true));
    return originalAcquire.call(this, key);
  };
  const raced = await race.barrier.run(context('racing-request'), async () => assert.fail('racing request replayed'));
  race.barrier.lock.acquire = originalAcquire;
  assert.equal(raced.reason, 'request-already-recorded'); assert.equal(raced.operationId, peerResult.operationId);
  assert.deepEqual(await racePeer.acknowledge(context('racing-request'), peerResult.operationId, peerResult.deliveryToken, 'receipt'), { outcome: 'confirmed' });
  close(racePeer); close(race.barrier);

  // Legacy marker and outbox rows anywhere in the enumerated prior storage block activation.
  {
    const legacyRoot = path.join(temp, 'legacy-marker');
    const journal = new DesktopDispatchJournal(path.join(legacyRoot, 'dispatch'));
    await journal.begin('old-unrelated-task', { appId: 'a', surfaceId: 's', action: 'click' });
    await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: legacyRoot, legacyRoots: [], legacyOutboxes: [], fence, authority }), /blocked/,
      'the global root is always scanned even if omitted from the legacy list');
    await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: legacyRoot, legacyRoots: [legacyRoot], legacyOutboxes: [], fence, authority }), /blocked/);
  }
  {
    const shared = path.join(temp, 'multi-root-global'), oldA = path.join(temp, 'old-A'), oldB = path.join(temp, 'old-B');
    const journal = new DesktopDispatchJournal(path.join(oldB, 'dispatch'));
    await journal.begin('unrelated-old-task', { appId: 'a', surfaceId: 's', action: 'click' });
    await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: shared, legacyRoots: [oldA, oldB], legacyOutboxes: [], fence, authority }), /activation/i);
    assert.equal(fs.existsSync(dbFile(shared)), false, 'an unresolved marker in any old root prevents activation');
  }
  {
    const legacyRoot = path.join(temp, 'legacy-outbox'); fs.mkdirSync(legacyRoot);
    const oldFile = path.join(legacyRoot, 'old.sqlite');
    const outbox = new WriteOutbox(oldFile);
    const old = outbox.create({ sessionId: 'old-session', taskId: 'old-task', source: 'desktop', action: 'click', target: 'w' });
    outbox.markDispatched('old-session', old);
    await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: legacyRoot, legacyRoots: [legacyRoot], legacyOutboxes: [oldFile], fence, authority }), /activation/i);
    outbox.complete('old-session', old, { outcome: 'known', value: true });
    outbox.acknowledge('old-session', old, 'receipt'); outbox.close();
    let evidence;
    const denyDelivery = { ...fence, verifyLegacyDelivery: item => { evidence = item; return false; } };
    await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: legacyRoot, legacyRoots: [legacyRoot], legacyOutboxes: [oldFile], fence: denyDelivery, authority }), /activation/i);
    assert.equal(evidence.kind, 'outbox'); assert.match(evidence.identity, /^[0-9a-f]{64}$/); assert.match(evidence.resultHash, /^[0-9a-f]{64}$/);
    const clean = await GlobalDesktopWriteBarrier.activate({ root: legacyRoot, legacyRoots: [legacyRoot], legacyOutboxes: [oldFile], fence, authority });
    opened.add(clean); close(clean);
  }
  {
    const legacyRoot = path.join(temp, 'legacy-receipt');
    const old = new DesktopActionIdempotency(legacyRoot);
    await old.run('s', 't', 'r', { action: 'click' }, () => true, async mark => { mark(); return { outcome: 'dispatched', value: { dispatched: true } }; });
    old.close();
    const preview = await GlobalDesktopWriteBarrier.previewLegacy({ root: legacyRoot, legacyRoots: [legacyRoot], legacyOutboxes: [], fence });
    assert.equal(preview.receiptCount, 1); assert.equal(preview.delivery, 'unverified');
    const clean = await GlobalDesktopWriteBarrier.activate({ root: legacyRoot, legacyRoots: [legacyRoot], legacyOutboxes: [], fence, authority });
    assert.equal(clean.inspectLegacyEpoch().receiptCount, 1);
    assert.equal(clean.inspectLegacyEpoch().delivery, 'unverified');
    opened.add(clean); close(clean);
  }
  {
    const legacyRoot = path.join(temp, 'legacy-unknown'); fs.mkdirSync(legacyRoot);
    const oldFile = path.join(legacyRoot, 'old.sqlite');
    const outbox = new WriteOutbox(oldFile);
    const old = outbox.create({ sessionId: 'old-session', taskId: 'old-task', source: 'desktop', action: 'click', target: 'w' });
    outbox.markDispatched('old-session', old); outbox.complete('old-session', old, { outcome: 'unknown' });
    outbox.resolveUnknown('old-session', old, 'confirmed-applied', 'old-audit');
    outbox.acknowledge('old-session', old, 'receipt'); outbox.close();
    let seen;
    const oldFence = { ...fence, verifyLegacyResolution: row => { seen = row; return false; } };
    await assert.rejects(GlobalDesktopWriteBarrier.activate({ root: legacyRoot, legacyRoots: [legacyRoot], legacyOutboxes: [oldFile], fence: oldFence, authority }), /activation/i);
    assert.equal(seen.invocationId, old); assert.equal(seen.taskId, 'old-task'); assert.equal(seen.auditId, 'old-audit');
    oldFence.verifyLegacyResolution = row => row.invocationId === old && row.taskId === 'old-task' && row.auditId === 'old-audit';
    const clean = await GlobalDesktopWriteBarrier.activate({ root: legacyRoot, legacyRoots: [legacyRoot], legacyOutboxes: [oldFile], fence: oldFence, authority });
    opened.add(clean); close(clean);
  }

  console.log('global desktop write barrier: simulated effects, real SQLite, restart, process lock, recovery and legacy checks passed');
} finally {
  for (const child of children) { try { child.kill(); } catch {} }
  for (const barrier of opened) { try { barrier.close(); } catch {} }
  removeWorkspaceFixture(temp, 'desktop-global-barrier-');
}
