import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-global-evidence-'));
const opened = new Set();
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { GlobalDesktopWriteBarrier } = await import(pathToFileURL(compile('main/desktop/globalDesktopWriteBarrier.ts')));
  const { GlobalVisibleActionDispatcher, scopedGlobalVisibleRequestId } = await import(pathToFileURL(compile('main/desktop/globalVisibleActionDispatcher.ts')));
  const { createGlobalDeliveryEvidenceVault } = await import(pathToFileURL(compile('main/desktop/globalDeliveryEvidenceVault.ts')));
  const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
    legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyLegacyDelivery: () => true, verifyLegacyResolution: () => true };
  let serial = 0;
  const binding = { engine: 'codex', connectionId: 'connection-generation-1', hostTurnId: 'host-turn-1',
    engineTurnId: 'native-turn-1', toolCallId: 'call-1', toolName: 'desktop.act' };
  const fingerprint = 'ab'.repeat(32);

  async function fixture(kind = 'win32', engine = 'codex', valueOverride) {
    const root = path.join(temp, `data-${++serial}`), controller = new AbortController();
    const context = { sessionId: 'session-A', taskId: 'task-A', target: 'window-A', action: 'click', indicatorEpoch: 1,
      signal: controller.signal, isCurrent: () => !controller.signal.aborted, isIndicatorCurrent: epoch => epoch === 1 };
    const request = { sessionId: context.sessionId, taskId: context.taskId, target: context.target,
      action: context.action, requestId: 'request-1', fingerprint };
    let barrier;
    const vault = createGlobalDeliveryEvidenceVault(() => barrier.inspect());
    const authority = { legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
      verifyDelivery: vault.verifier.verifyDelivery, executorStopped: () => true,
      verifyRecovery: () => true, verifyAbandonedLock: () => true };
    barrier = await GlobalDesktopWriteBarrier.activate({ root, legacyRoots: [], legacyOutboxes: [], fence, authority });
    const dispatcher = new GlobalVisibleActionDispatcher(barrier, {
      resolveLogicalOperationId: value => scopedGlobalVisibleRequestId(value.sessionId, value.taskId, value.requestId),
      classifyResult: (_request, value) => ({ outcome: 'known', value }), deliveryEvidence: vault.verifier.deliveryEvidence
    });
    const value = valueOverride ?? (kind === 'cua'
      ? { ok: true, delivery: 'unknown', effect: 'unverifiable', verification: 'not_performed' }
      : { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed', pid: 42 });
    let calls = 0;
    const result = await dispatcher.run(context, request.requestId, fingerprint, async () => { calls++; return value; });
    assert.equal(result.reply.outcome, 'dispatched');
    const marker = barrier.inspect(), eventBinding = { ...binding, engine };
    const body = kind === 'cua' ? { outcome: 'dispatched', ...value, invocationId: marker.operationId }
      : { outcome: 'dispatched', invocationId: marker.operationId, value };
    const outputText = JSON.stringify({ ok: true, result: body });
    const stage = () => vault.stager.stage({ marker, value, signal: controller.signal, isCurrent: context.isCurrent });
    const bind = handle => vault.stager.bindOutput(handle, { binding: eventBinding, kind, outputText });
    const observed = { ...eventBinding, outputText };
    const close = () => { vault.close(); barrier.close(); opened.delete(close); };
    opened.add(close);
    return { root, controller, context, request, vault, barrier, dispatcher, result, marker, value, stage, bind, observed,
      calls: () => calls, close, authority };
  }

  // These event invocations are trusted-tracker substitutes. They exercise the
  // vault and actual SQLite barrier, not a live Codex or Pi engine connection.
  for (const [kind, engine] of [['win32', 'codex'], ['cua', 'scheduler-pi'], ['cua', 'gui-pi']]) {
    const f = await fixture(kind, engine);
    assert.equal(f.vault.stager.withVerifiedEvent, undefined, 'staging must not grant the issuer capability');
    assert.equal(f.vault.verifier.withVerifiedEvent, undefined);
    assert.deepEqual(await f.result.acknowledge(), { outcome: 'unknown', reason: 'acknowledgement-failed' });
    assert.equal(f.barrier.inspect().operationId, f.marker.operationId, 'an early ack cannot clear the SQLite marker');
    const stage = f.stage(); f.bind(stage);
    const other = { ...f.context, sessionId: 'session-B', taskId: 'task-B' };
    await assert.rejects(f.dispatcher.run(other, 'another-request', fingerprint, async () => assert.fail('must not dispatch')));
    assert.equal(f.calls(), 1);
    let delayed, releaseDelayed;
    const outcome = await f.vault.issuer.withVerifiedEvent(stage, f.observed, async () => {
      const id = f.vault.verifier.deliveryEvidence(f.request, f.marker.operationId);
      assert.match(id, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(f.vault.verifier.deliveryEvidence({ ...f.request, taskId: 'other' }, f.marker.operationId), undefined);
      assert.equal(f.vault.verifier.deliveryEvidence({ ...f.request, fingerprint: 'b'.repeat(64) }, f.marker.operationId), undefined);
      assert.equal(f.vault.verifier.deliveryEvidence(f.request, 'wrong-operation'), undefined);
      assert.equal(f.vault.verifier.verifyDelivery({ marker: f.marker, evidenceId: id }), true);
      for (const key of ['operationId', 'requestHash', 'contextHash', 'fingerprintHash', 'phase', 'resultHash', 'tokenHash']) {
        assert.equal(f.vault.verifier.verifyDelivery({ marker: { ...f.marker, [key]: 'changed' }, evidenceId: id }), false, key);
      }
      assert.equal(f.vault.verifier.verifyDelivery({ marker: f.marker, evidenceId: 'made-up' }), false);
      const gate = new Promise(resolve => { releaseDelayed = resolve; });
      delayed = gate.then(() => f.vault.verifier.verifyDelivery({ marker: f.marker, evidenceId: id }));
      return f.result.acknowledge();
    });
    assert.deepEqual(outcome, { outcome: 'acknowledged' });
    assert.equal(f.barrier.inspect(), null);
    releaseDelayed();
    assert.equal(await delayed, false, 'an inherited async scope cannot replay a proof after the tracker returns');
    assert.equal(f.vault.verifier.deliveryEvidence(f.request, f.marker.operationId), undefined);
    await assert.rejects(f.vault.issuer.withVerifiedEvent(stage, f.observed, () => f.result.acknowledge()), /consumed|unavailable/);
    const db = new DatabaseSync(path.join(f.root, 'global-desktop-write.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT phase FROM global_desktop_history WHERE operation_id=?').get(f.marker.operationId).phase, 'confirmed');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM global_desktop_marker').get().count, 0);
    db.close(); f.close();
  }

  // The staged marker, result and serialized output must all agree; a failed
  // stage is not replaced while the same durable operation remains unresolved.
  {
    const f = await fixture();
    assert.throws(() => f.vault.stager.stage({ marker: { ...f.marker, resultHash: '0'.repeat(64) }, value: f.value,
      signal: f.controller.signal, isCurrent: () => true }), /does not match/);
    assert.throws(() => f.vault.stager.stage({ marker: f.marker, value: { ...f.value, pid: 9 },
      signal: f.controller.signal, isCurrent: () => true }), /does not match/);
    const stage = f.stage();
    assert.throws(() => f.vault.stager.bindOutput(stage, { binding, kind: 'win32',
      outputText: f.observed.outputText.replace(f.marker.operationId, '00000000-0000-4000-8000-000000000000') }), /does not match/);
    assert.throws(f.stage, /already exists/);
    await assert.rejects(f.vault.issuer.withVerifiedEvent(stage, f.observed, () => f.result.acknowledge()), /consumed|unavailable/);
    assert.equal(f.barrier.inspect().operationId, f.marker.operationId);
    f.close();
  }

  // An event must match every host identity and every code unit of its text.
  // Each mismatch permanently revokes that staged operation, leaving it blocked.
  for (const [key, wrong] of [['engine', 'gui-pi'], ['connectionId', 'other-connection'], ['hostTurnId', 'other-host-turn'],
    ['engineTurnId', 'other-native-turn'], ['toolCallId', 'other-call'], ['toolName', 'other-tool'],
    ['outputText', '{"ok":false}']]) {
    const f = await fixture(), stage = f.stage(); f.bind(stage);
    let entered = false;
    await assert.rejects(f.vault.issuer.withVerifiedEvent(stage, { ...f.observed, [key]: wrong }, async () => {
      entered = true; return f.result.acknowledge();
    }), /does not match/);
    assert.equal(entered, false, key);
    await assert.rejects(f.vault.issuer.withVerifiedEvent(stage, f.observed, () => f.result.acknowledge()), /consumed|unavailable/);
    assert.equal(f.barrier.inspect().operationId, f.marker.operationId, key);
    assert.deepEqual(await f.result.acknowledge(), { outcome: 'unknown', reason: 'acknowledgement-failed' });
    f.close();
  }

  // Different unpaired UTF-16 surrogates have the same replacement UTF-8
  // bytes; they must nevertheless not count as the exact same engine text.
  {
    const value = { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed', note: '\ud800' };
    const f = await fixture('win32', 'codex', value), stage = f.stage();
    const text = f.observed.outputText.replace('\\ud800', '\ud800');
    const differentText = text.replace('\ud800', '\udc00');
    assert.notEqual(text, differentText);
    assert.deepEqual(Buffer.from(text), Buffer.from(differentText));
    f.vault.stager.bindOutput(stage, { binding, kind: 'win32', outputText: text });
    await assert.rejects(f.vault.issuer.withVerifiedEvent(stage, { ...f.observed, outputText: differentText },
      () => f.result.acknowledge()), /does not match/);
    assert.equal(f.barrier.inspect().operationId, f.marker.operationId); f.close();
  }

  // Cancellation between the verified event and ack revokes proof, and a new
  // barrier instance still observes the same unresolved SQLite marker.
  {
    const f = await fixture(), stage = f.stage(); f.bind(stage);
    const result = await f.vault.issuer.withVerifiedEvent(stage, f.observed, async () => {
      f.controller.abort(); return f.result.acknowledge();
    });
    assert.equal(result.outcome, 'unknown');
    assert.equal(f.barrier.inspect().operationId, f.marker.operationId);
    f.close();
    const reopened = GlobalDesktopWriteBarrier.open(f.root, f.authority);
    assert.equal(reopened.inspect().operationId, f.marker.operationId);
    reopened.close();
  }

  // A concurrent duplicate cannot steal, invalidate or independently issue
  // the first confirmation. A forged handle never enters the callback.
  {
    const f = await fixture(), stage = f.stage(); f.bind(stage);
    let release, ready;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { ready = resolve; });
    const first = f.vault.issuer.withVerifiedEvent(stage, f.observed, async () => {
      ready(); await gate; return f.result.acknowledge();
    });
    await started;
    await assert.rejects(f.vault.issuer.withVerifiedEvent(stage, f.observed, () => f.result.acknowledge()), /consumed|unavailable/);
    await assert.rejects(f.vault.issuer.withVerifiedEvent({}, f.observed, () => f.result.acknowledge()), /Invalid/);
    assert.deepEqual(await f.result.acknowledge(), { outcome: 'unknown', reason: 'acknowledgement-failed' });
    release();
    assert.deepEqual(await first, { outcome: 'acknowledged' });
    assert.equal(f.barrier.inspect(), null); f.close();
  }

  // Explicit revocation during the trusted callback also prevents clearing.
  {
    const f = await fixture(), stage = f.stage(); f.bind(stage);
    const result = await f.vault.issuer.withVerifiedEvent(stage, f.observed, async () => {
      f.vault.stager.discard(stage); return f.result.acknowledge();
    });
    assert.equal(result.outcome, 'unknown');
    assert.equal(f.barrier.inspect().operationId, f.marker.operationId); f.close();
  }

  // A host lifetime that has once reported stale cannot revive an evidence
  // scope even if a faulty predicate later returns true again.
  {
    const f = await fixture();
    let valid = true;
    const stage = f.vault.stager.stage({ marker: f.marker, value: f.value, signal: f.controller.signal, isCurrent: () => valid });
    f.bind(stage);
    const result = await f.vault.issuer.withVerifiedEvent(stage, f.observed, async () => {
      valid = false;
      assert.equal(f.vault.verifier.deliveryEvidence(f.request, f.marker.operationId), undefined);
      valid = true;
      assert.equal(f.vault.verifier.deliveryEvidence(f.request, f.marker.operationId), undefined);
      return f.result.acknowledge();
    });
    assert.equal(result.outcome, 'unknown');
    assert.equal(f.barrier.inspect().operationId, f.marker.operationId); f.close();
  }

  console.log('global delivery evidence: SQLite composition, binding, cancellation, replay and concurrency passed; engine events simulated');
} finally {
  for (const close of opened) { try { close(); } catch {} }
  removeWorkspaceFixture(temp, 'desktop-global-evidence-');
}
