import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-global-visible-'));
let barrier;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { GlobalDesktopWriteBarrier } = await import(pathToFileURL(compile('main/desktop/globalDesktopWriteBarrier.ts')));
  const { GlobalVisibleActionDispatcher, scopedGlobalVisibleRequestId, isRecordedGlobalVisibleRequest } =
    await import(pathToFileURL(compile('main/desktop/globalVisibleActionDispatcher.ts')));
  const { createCuaVisibleAction } = await import(pathToFileURL(compile('main/desktop/cuaVisibleAction.ts')));
  const { Win32VisibleControl } = await import(pathToFileURL(compile('main/desktop/win32VisibleControl.ts')));
  const { isRecordedDesktopOutcome } = await import(pathToFileURL(compile('main/desktop/recordedDesktopOutcome.ts')));
  const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
    legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyLegacyDelivery: () => true, verifyLegacyResolution: () => true };
  const proofs = new Map();
  const barrierAuthority = { legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyDelivery: ({ marker, evidenceId }) => proofs.get(evidenceId) === marker.operationId,
    executorStopped: () => true, verifyRecovery: () => true, verifyAbandonedLock: () => true };
  const evidenceByOperation = new Map();
  let originalId;
  const authority = {
    resolveLogicalOperationId: request => request.taskId === 'trusted-continuation'
      ? originalId : scopedGlobalVisibleRequestId(request.sessionId, request.taskId, request.requestId),
    classifyResult: (_request, value) => value?.effect === 'unknown' || value?.effect === 'partial'
      ? { outcome: 'unknown' } : { outcome: 'known', value },
    deliveryEvidence: (_request, operationId) => evidenceByOperation.get(operationId)
  };
  const root = path.join(temp, 'data');
  const open = async () => {
    barrier = await GlobalDesktopWriteBarrier.activate({ root, legacyRoots: [], legacyOutboxes: [], fence, authority: barrierAuthority });
    return new GlobalVisibleActionDispatcher(barrier, authority);
  };
  let dispatcher = await open();
  const context = (sessionId, taskId, extra = {}) => ({ sessionId, taskId, target: 'window', action: 'click', indicatorEpoch: 1,
    isCurrent: () => true, isIndicatorCurrent: epoch => epoch === 1, ...extra });
  const a = context('session-A', 'task-A'), b = context('session-B', 'task-B');
  const fingerprint = 'a'.repeat(64);
  let count = 0;
  const backend = async () => { count++; return { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' }; };
  originalId = scopedGlobalVisibleRequestId(a.sessionId, a.taskId, 'click-1');
  assert.equal(originalId, scopedGlobalVisibleRequestId(a.sessionId, a.taskId, 'click-1'));
  assert.notEqual(originalId, scopedGlobalVisibleRequestId(b.sessionId, b.taskId, 'click-1'));

  const first = await dispatcher.run(a, 'click-1', fingerprint, backend);
  assert.equal(first.reply.outcome, 'dispatched'); assert.equal(count, 1);
  assert.doesNotMatch(JSON.stringify(first), /deliveryToken|acknowledge/);
  const db = new DatabaseSync(path.join(root, 'global-desktop-write.sqlite'), { readOnly: true });
  const history = () => db.prepare('SELECT request_hash,operation_id,phase FROM global_desktop_history ORDER BY request_hash').all();
  const beforeBlocked = history();
  const duplicatePending = await dispatcher.run(a, 'click-1', fingerprint, backend);
  assert.deepEqual(duplicatePending.reply, { outcome: 'unknown', invocationId: first.reply.invocationId, reason: 'request-already-recorded' });
  assert.equal(isRecordedGlobalVisibleRequest(duplicatePending), true);
  assert.equal(isRecordedGlobalVisibleRequest({ ...duplicatePending }), false, 'a copied or model-provided value cannot forge host provenance');
  assert.equal('acknowledge' in duplicatePending, false, 'a duplicate cannot fabricate an engine acknowledgement');
  await assert.rejects(dispatcher.run(a, 'click-1', 'b'.repeat(64), backend), /different operation/);
  await assert.rejects(dispatcher.run({ ...a, target: 'different-window' }, 'click-1', fingerprint, backend), /different operation/);
  await assert.rejects(dispatcher.run({ ...a, action: 'type' }, 'click-1', fingerprint, backend), /different operation/);
  await assert.rejects(dispatcher.run(b, 'click-1', fingerprint, backend), error => {
    assert.equal(error.name, 'VisibleActionPreDispatchFailure');
    assert.equal(error.recoveryRequired, false, 'a clean rejection must not stop the first action while it awaits delivery');
    return true;
  });
  assert.equal(count, 1, 'global block must not enter the other task backend');
  assert.deepEqual(history(), beforeBlocked, 'global block must not create a second action record');
  assert.equal(barrier.inspect().operationId, first.reply.invocationId);

  assert.deepEqual(await first.acknowledge('model-supplied-id'), { outcome: 'unknown', reason: 'acknowledgement-failed' });
  assert.equal(barrier.inspect().operationId, first.reply.invocationId, 'a model-provided ID is not delivery proof');
  evidenceByOperation.set(first.reply.invocationId, 'untrusted-claim');
  assert.deepEqual(await first.acknowledge('untrusted-claim'), { outcome: 'unknown', reason: 'acknowledgement-failed' });
  assert.equal(barrier.inspect().operationId, first.reply.invocationId, 'authority must independently verify the proof');
  proofs.set('engine-proof-A', first.reply.invocationId); evidenceByOperation.set(first.reply.invocationId, 'engine-proof-A');
  const [ackA, duplicateAckA] = await Promise.all([first.acknowledge('ignored'), first.acknowledge('ignored-again')]);
  assert.deepEqual(ackA, { outcome: 'acknowledged' }); assert.deepEqual(duplicateAckA, ackA);
  assert.deepEqual(await first.acknowledge(), { outcome: 'acknowledged' });

  const second = await dispatcher.run(b, 'click-1', fingerprint, backend);
  assert.equal(second.reply.outcome, 'dispatched'); assert.equal(count, 2, 'unrelated tasks may reuse their public ID');
  proofs.set('engine-proof-B', second.reply.invocationId); evidenceByOperation.set(second.reply.invocationId, 'engine-proof-B');
  assert.deepEqual(await second.acknowledge(), { outcome: 'acknowledged' });
  const duplicateConfirmed = await dispatcher.run(a, 'click-1', fingerprint, backend);
  assert.equal(duplicateConfirmed.reply.outcome, 'unknown'); assert.equal(isRecordedGlobalVisibleRequest(duplicateConfirmed), true);
  await assert.rejects(dispatcher.run(context('new-session', 'trusted-continuation'), 'new-public-id', fingerprint, backend));
  assert.equal(count, 2, 'a trusted continuation must retain and cannot replay the original logical operation');

  // The first backend still owns the cross-process lock: a matching duplicate
  // performs only a SQLite read and cannot invalidate its eventual receipt.
  let started, releaseBackend, inFlightCalls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { releaseBackend = resolve; });
  const inFlight = dispatcher.run(a, 'in-flight', fingerprint, async () => {
    inFlightCalls++; started(); await gate; return { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' };
  });
  await ready;
  const duplicateInFlight = await dispatcher.run(a, 'in-flight', fingerprint, async () => assert.fail('duplicate executed'));
  assert.equal(isRecordedGlobalVisibleRequest(duplicateInFlight), true);
  assert.equal(duplicateInFlight.reply.outcome, 'unknown'); assert.equal(inFlightCalls, 1);
  releaseBackend();
  const completedInFlight = await inFlight;
  assert.equal(completedInFlight.reply.outcome, 'dispatched');
  assert.equal(completedInFlight.reply.invocationId, duplicateInFlight.reply.invocationId);
  proofs.set('engine-proof-in-flight', completedInFlight.reply.invocationId);
  evidenceByOperation.set(completedInFlight.reply.invocationId, 'engine-proof-in-flight');
  assert.deepEqual(await completedInFlight.acknowledge(), { outcome: 'acknowledged' });
  db.close(); barrier.close();

  barrier = GlobalDesktopWriteBarrier.open(root, barrierAuthority);
  dispatcher = new GlobalVisibleActionDispatcher(barrier, authority);
  const afterRestart = await dispatcher.run(b, 'click-1', fingerprint, backend);
  assert.equal(afterRestart.reply.outcome, 'unknown'); assert.equal(isRecordedGlobalVisibleRequest(afterRestart), true);
  assert.equal(count, 2, 'same scoped request remains non-replayable after restart');

  const invalid = context('session-C', 'task-C', { isIndicatorCurrent: () => false });
  await assert.rejects(dispatcher.run(invalid, 'click-2', fingerprint, backend), /not dispatched/);
  assert.equal(count, 2); assert.equal(barrier.inspect(), null);
  const rawIdDispatcher = new GlobalVisibleActionDispatcher(barrier, { ...authority, resolveLogicalOperationId: request => request.requestId });
  await assert.rejects(rawIdDispatcher.run(a, 'click-2', fingerprint, backend), /not dispatched/);
  assert.equal(count, 2);

  const pendingBeforeRestart = await dispatcher.run(a, 'pending-restart', fingerprint, backend);
  assert.equal(pendingBeforeRestart.reply.outcome, 'dispatched'); assert.equal(count, 3);
  barrier.close(); barrier = GlobalDesktopWriteBarrier.open(root, barrierAuthority);
  dispatcher = new GlobalVisibleActionDispatcher(barrier, authority);
  assert.equal(barrier.inspect().operationId, pendingBeforeRestart.reply.invocationId);
  const pendingAgain = await dispatcher.run(a, 'pending-restart', fingerprint, backend);
  assert.equal(pendingAgain.reply.outcome, 'unknown'); assert.equal(isRecordedGlobalVisibleRequest(pendingAgain), true);
  await assert.rejects(dispatcher.run(b, 'another-request', fingerprint, backend));
  assert.equal(count, 3, 'an unconfirmed result survives restart and blocks every task');
  await barrier.recover(pendingBeforeRestart.reply.invocationId, 'independent-audit', 'confirmed-applied', () => true);
  assert.equal((await dispatcher.run(a, 'pending-restart', fingerprint, backend)).reply.outcome, 'unknown');

  // Exercise the existing Cua bridge with a host-owned slot and simulated evidence.
  // This is a composition test, not a real driver or engine-delivery test.
  const c = context('session-C', 'task-C');
  const controller = new AbortController();
  let staged;
  const runCua = createCuaVisibleAction(dispatcher, () => ({
    lease: { owner: c.sessionId, turnId: 'turn-C', signal: controller.signal, isCurrent: () => true },
    indicatorEpoch: 1, isIndicatorCurrent: () => true, isTargetCurrent: () => true,
    stageDelivery: (id, value, acknowledge) => { staged = { id, value, acknowledge }; }
  }));
  const semantic = await runCua({ actor: { sessionId: c.sessionId, taskId: c.taskId, turnId: 'turn-C', isCurrent: () => true },
    hostWindowId: 'window', requestId: 'cua-1', fingerprint, action: 'click', targetGeneration: 'generation',
    isTargetCurrent: () => true, isCurrent: () => true }, async () => ({ ok: true, delivery: 'unknown',
    effect: 'unverifiable', verification: 'not_performed' }));
  assert.equal(semantic.outcome, 'dispatched'); assert.equal(staged.id, semantic.invocationId);
  assert.deepEqual(await staged.acknowledge('not-engine-proof'), { outcome: 'unknown', reason: 'acknowledgement-failed' });
  proofs.set('engine-proof-C', staged.id); evidenceByOperation.set(staged.id, 'engine-proof-C');
  assert.deepEqual(await staged.acknowledge('ignored'), { outcome: 'acknowledged' });

  // The Windows visible adapter also accepts this dispatcher. All platform
  // APIs and the executable launch are substitutes; no real app is started.
  let launchCalls = 0, winStaged;
  const win = new Win32VisibleControl({ dispatcher, resolveTarget: () => { throw new Error('not used'); },
    input: { move() {}, send() {}, async releaseAll() {} },
    windowApi: { valid: () => 1, minimized: () => 0, restore: () => 1, activate: () => 1, foreground: () => 1 },
    dipToPhysical: point => point, resolveExecutable: async file => file,
    launchExecutable: async () => { launchCalls++; return { pid: 42 }; } });
  const winActor = { sessionId: 'session-win', taskId: 'task-win', turnId: 'turn-win', isCurrent: () => true };
  const winSlot = { lease: { owner: winActor.sessionId, turnId: winActor.turnId, signal: controller.signal, isCurrent: () => true },
    indicatorEpoch: 1, isIndicatorCurrent: () => true, isTargetCurrent: () => true, onUnknown: () => assert.fail('unexpected unknown'),
    stageDelivery: (id, value, acknowledge) => { winStaged = { id, value, acknowledge }; } };
  const launched = await win.launch(winActor, 'C:\\fixture.exe', 'launch-1', winSlot);
  assert.equal(launched.outcome, 'dispatched'); assert.equal(launchCalls, 1);
  assert.deepEqual(await winStaged.acknowledge('model-id'), { outcome: 'unknown', reason: 'acknowledgement-failed' });
  proofs.set('engine-proof-win', winStaged.id); evidenceByOperation.set(winStaged.id, 'engine-proof-win');
  assert.deepEqual(await winStaged.acknowledge('ignored'), { outcome: 'acknowledged' });
  const repeatedLaunch = await win.launch(winActor, 'C:\\fixture.exe', 'launch-1', winSlot);
  assert.equal(repeatedLaunch.outcome, 'unknown');
  assert.equal(repeatedLaunch.invocationId, launched.invocationId);
  assert.equal(isRecordedDesktopOutcome(repeatedLaunch), true);
  assert.equal(barrier.inspect(), null, 'the duplicate read does not create a new pending action');
  assert.equal(launchCalls, 1);

  const uncertain = await dispatcher.run(a, 'uncertain', fingerprint, async () => ({ effect: 'partial' }));
  assert.equal(uncertain.reply.outcome, 'unknown'); assert.equal(barrier.inspect().phase, 'unknown');
  await assert.rejects(dispatcher.run(b, 'blocked', fingerprint, backend));
  assert.equal(count, 3, 'uncertain effects block all later tasks');
  await barrier.recover(uncertain.reply.invocationId, 'independent-audit', 'confirmed-applied', () => true);
  assert.equal((await dispatcher.run(a, 'uncertain', fingerprint, backend)).reply.outcome, 'unknown');
  console.log('global visible dispatcher: scoped identity, global block, private receipt, simulated delivery and restart passed');
} finally {
  try { barrier?.close(); } catch {}
  removeWorkspaceFixture(temp, 'desktop-global-visible-');
}
