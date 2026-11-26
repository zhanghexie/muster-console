/** Supervised IPC fixture + real Pi AgentSession, gateway, Cua and SQLite receipt. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const root = process.cwd(), prefix = 'gui-pi-delivery-';
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', prefix));
const compiled = path.join(tmp, 'compiled'), compile = createSharedCompiler(root, compiled);
const load = async file => import(pathToFileURL(compile(file)));
const { GuiPiDesktopDelivery, hasGuiPiDesktopDeliveryScope, captureGuiPiCuaDeliverySlot, captureGuiPiWin32DeliverySlot } = await load('main/agentSession/drivers/pi/desktopDelivery.ts');
await load('main/agentSession/drivers/pi/childDesktopDelivery.ts');
await load('main/agentSession/drivers/pi/customTools.ts');
const { createGuiHostToolGateway } = await load('main/agentSession/tools/gateway.ts');
const { createVisibleActionRuntime } = await load('main/desktop/visibleActionFactory.ts');
const { WriteOutbox } = await load('main/desktop/writeOutbox.ts');
const { DesktopTaskLock } = await load('main/desktop/taskLock.ts');
const { VisibleActionBarrier } = await load('main/desktop/visibleActionBarrier.ts');
const { VisibleActionCoordinator } = await load('main/desktop/visibleActionCoordinator.ts');
const { DesktopActivityRuntime } = await load('main/desktop/desktopActivityRuntime.ts');
const { CuaSemanticRuntime } = await load('main/desktop/cuaSemanticRuntime.ts');
const { createCuaVisibleAction } = await load('main/desktop/cuaVisibleAction.ts');
const { CuaVisibleBridge } = await load('main/desktop/cuaVisibleBridge.ts');
const { DesktopActionIdempotency } = await load('main/desktop/actionIdempotency.ts');
const { VisibleActionDispatcher } = await load('main/desktop/visibleActionDispatcher.ts');
const { GlobalDesktopWriteBarrier } = await load('main/desktop/globalDesktopWriteBarrier.ts');
const { GlobalVisibleActionDispatcher, scopedGlobalVisibleRequestId } = await load('main/desktop/globalVisibleActionDispatcher.ts');
const { createGlobalDeliveryEvidenceVault } = await load('main/desktop/globalDeliveryEvidenceVault.ts');
const owner = 'gui:fixture', taskId = 'task', desktopTurn = 'desktop-turn';

async function exercise(mode) {
  const dir = path.join(tmp, mode); fs.mkdirSync(dir);
  const globalMode = mode.startsWith('global-');
  if (globalMode) mode = mode.slice('global-'.length);
  const db = path.join(dir, 'outbox.sqlite');
  let resumeAcquire, acquiredResolve, finishLate;
  const acquired = new Promise(resolve => { acquiredResolve = resolve; });
  const proceed = new Promise(resolve => { resumeAcquire = resolve; });
  const late = new Promise(resolve => { finishLate = resolve; });
  let holdAcquire = false;
  let durable, globalBarrier, vault;
  if (globalMode) {
    const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
      legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
      verifyLegacyDelivery: () => true, verifyLegacyResolution: () => true };
    vault = createGlobalDeliveryEvidenceVault(() => globalBarrier.inspect());
    globalBarrier = await GlobalDesktopWriteBarrier.activate({ root: path.join(dir, 'global'), legacyRoots: [], legacyOutboxes: [], fence,
      authority: { legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
        verifyDelivery: vault.verifier.verifyDelivery, executorStopped: () => true, verifyRecovery: () => true, verifyAbandonedLock: () => true } });
  } else if (mode === 'stop-in-lock' || mode === 'exit-in-lock' || mode === 'timeout-in-lock') {
    const outbox = new WriteOutbox(db), barrier = new VisibleActionBarrier(db), realLock = new DesktopTaskLock(path.join(dir, 'locks'));
    const lock = { async acquire(task) {
      const release = await realLock.acquire(task);
      if (holdAcquire) { acquiredResolve(); await proceed; }
      return release;
    } };
    durable = { coordinator: new VisibleActionCoordinator(outbox, lock, barrier), close() { barrier.close(); outbox.close(); } };
  } else durable = createVisibleActionRuntime(db, path.join(dir, 'locks'));
  const receipts = new DesktopActionIdempotency(path.join(dir, 'receipts'));
  const dispatcher = globalMode ? new GlobalVisibleActionDispatcher(globalBarrier, {
    resolveLogicalOperationId: value => scopedGlobalVisibleRequestId(value.sessionId, value.taskId, value.requestId),
    classifyResult: (_request, value) => ({ outcome: 'known', value }), deliveryEvidence: vault.verifier.deliveryEvidence
  }) : new VisibleActionDispatcher(receipts, durable.coordinator);
  const activity = new DesktopActivityRuntime({
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' },
    createIndicator: () => ({ show: async () => {}, close() {} }), releaseAll: async () => {}
  });
  let hostTurn = 'host-turn', currentDesktopTurn = desktopTurn, targetCurrent = true, indicatorCurrent = true;
  let calls = 0, ackCount = 0, lease, stop, observedProof, expectedDigest, doneMessage, failure;
  const reports = [], controls = new Map();
  const child = fork(path.join(root, 'test/fixtures/gui-pi-delivery-child.mjs'), [], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
  });
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  const childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const delivery = new GuiPiDesktopDelivery(() => hostTurn, () => child.connected, reason => reports.push(reason), 2000,
    globalMode ? { stager: vault.stager, issuer: vault.issuer, inspectMarker: () => globalBarrier.inspect() } : undefined);
  let prematureAck;
  child.once('disconnect', () => delivery.end());
  child.once('exit', () => delivery.end());
  delivery.begin(1, hostTurn);
  const actor = { sessionId: owner, taskId, turnId: desktopTurn, isCurrent: () => hostTurn === 'host-turn' };
  const persisted = createCuaVisibleAction(dispatcher, request => {
    const slot = captureGuiPiCuaDeliverySlot(request, { lease, indicatorEpoch: activity.visibilityEpoch(),
      isIndicatorCurrent: epoch => indicatorCurrent && activity.visibilityEpoch() === epoch, isTargetCurrent: () => targetCurrent });
    return { ...slot, stageDelivery(id, value, ack) {
      prematureAck = ack;
      return slot.stageDelivery(id, value, async receipt => {
        ackCount++;
        if (mode === 'duplicate-in-ack') {
          await assert.rejects(delivery.run({ generation: 1, id: 'call-1', signal: new AbortController().signal,
            isCurrent: () => true }, async () => { throw new Error('duplicate must not execute'); }), /Duplicate/);
        }
        if (mode === 'stop-during-ack') { delivery.end(); stop = activity.stop(); }
        if (mode === 'exit-during-ack') { child.kill(); await childExit; }
        if (mode === 'stop-in-lock' || mode === 'exit-in-lock' || mode === 'timeout-in-lock') {
          holdAcquire = true;
          const result = ack(receipt).finally(() => finishLate());
          await acquired;
          if (mode === 'exit-in-lock') { child.kill(); await childExit; }
          else if (mode === 'stop-in-lock') { delivery.end(); stop = activity.stop(); }
          else await new Promise(resolve => setTimeout(resolve, 2200));
          resumeAcquire();
          return result;
        }
        return ack(receipt);
      });
    } };
  });
  const semantic = new CuaSemanticRuntime({
    resolveTarget: () => ({ pid: 12, windowId: 34, generation: 'target-generation', isCurrent: () => targetCurrent }),
    createConnection: () => ({ async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
      async call(name) {
        if (name === 'get_window_state') return { structuredContent: { pid: 12, window_id: 34, snapshot_id: 's00000001',
          elements_complete: true, elements: [{ element_token: 's00000001:0', role: 'Button', label: 'Open', actions: ['invoke'] }] } };
        calls++; return { structuredContent: { effect: 'confirmed' } };
      }, async close() {} }), runPersistedAction: persisted
  });
  const bridge = new CuaVisibleBridge({ runtime: semantic, activity,
    resolveTarget: () => ({ isCurrent: () => targetCurrent }), reportStopError: error => reports.push(error) });
  activity.turns.noteUserInstruction(owner, 'message');
  activity.turns.begin(owner, desktopTurn, () => hostTurn === 'host-turn', true, 'message');
  const observe = () => activity.turns.use(owner, desktopTurn, 'window',
    (signal, lease) => bridge.observe(actor, lease, undefined, 'window', signal), false);
  // Both parallel calls model actions against one observation. Starting a second
  // observation would invalidate the first reference before either action runs.
  const parallelObservation = mode === 'parallel' ? await observe() : undefined;
  const tool = { id: 'host.desktop.act', label: 'desktop', description: 'offline fixture', permissionClass: 'write',
    resultFormat: 'execute-result-json', parameters: Type.Object({ requestId: Type.String() }),
    async execute(args, ctx) {
      if (mode === 'win32') {
        return activity.turns.use(owner, desktopTurn, 'window', async (seatSignal, currentLease) => {
          const slot = captureGuiPiWin32DeliverySlot(actor, { lease: currentLease, indicatorEpoch: activity.visibilityEpoch(),
            isIndicatorCurrent: epoch => indicatorCurrent && activity.visibilityEpoch() === epoch,
            isTargetCurrent: () => targetCurrent, onUnknown() {} });
          const effect = { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' };
          const result = await dispatcher.run({ sessionId: owner, taskId, target: 'window', action: 'win32.click',
            indicatorEpoch: slot.indicatorEpoch, isCurrent: slot.lease.isCurrent, isIndicatorCurrent: slot.isIndicatorCurrent,
            signal: slot.lease.signal }, args.requestId, 'a'.repeat(64), async () => { seatSignal.throwIfAborted(); calls++; return effect; });
          if (result.reply.outcome !== 'dispatched') return JSON.stringify({ ok: true, result: result.reply });
          prematureAck = result.acknowledge;
          await slot.stageDelivery(result.reply.invocationId, effect, async receipt => { ackCount++; return result.acknowledge(receipt); });
          return JSON.stringify({ ok: true, result: { outcome: 'dispatched', invocationId: result.reply.invocationId, value: effect } });
        });
      }
      const page = parallelObservation ?? await observe();
      const value = await activity.turns.use(owner, desktopTurn, 'window', (seatSignal, currentLease) => {
        lease = currentLease;
        return bridge.act(actor, currentLease, undefined, 'window', { snapshotId: page.snapshotId, ref: page.elements[0].ref,
          requestId: args.requestId, action: 'click' }, AbortSignal.any([ctx.signal, seatSignal]));
      });
      return JSON.stringify({ ok: true, result: mode === 'projection-change' ? { ...value, effect: 'changed' } : value });
    }
  };
  const gateway = createGuiHostToolGateway({ sessionId: owner, cwd: dir, hostTools: [tool],
    getTurnId: () => hostTurn, getDesktopTurnId: () => currentDesktopTurn,
    getPolicyState: () => ({ mode: 'auto', planExecuting: false }), requestApproval: async () => ({ approved: true }) });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  child.on('message', message => {
    if (message.type === 'done') { doneMessage = message; finish(); return; }
    if (message.type === 'failure') { failure = message.message; finish(); return; }
    if (message.type === 'phase' && message.name === 'tool_execution_end') {
      assert.equal(ackCount, 0, 'a tool execution end is not a delivery receipt');
      if (mode === 'stop') { delivery.end(); stop = activity.stop(); }
      if (mode === 'host-change') hostTurn = 'next-host-turn';
      if (mode === 'desktop-change') currentDesktopTurn = 'next-desktop-turn';
      if (mode === 'target-change') targetCurrent = false;
      if (mode === 'indicator-change') indicatorCurrent = false;
      return;
    }
    if (message.type === 'cancel') { controls.get(message.id)?.abort(); return; }
    if (message.type !== 'call') return;
    const controller = new AbortController(); controls.set(message.id, controller);
    const current = () => child.connected && hostTurn === 'host-turn' && !controller.signal.aborted;
    const execute = async () => {
      if (message.method === 'tool') {
        const args = message.args;
        const result = await delivery.run({ generation: message.generation, id: args.toolCallId,
          name: mode === 'missing-tool-name' ? undefined : args.id.replace(/\./g, '_'),
          signal: controller.signal, isCurrent: current }, () => gateway.invoke(args.id, args.args, { id: args.toolCallId, signal: controller.signal }));
        if (result.desktopDeliveryProof) {
          if (globalMode && prematureAck) {
            assert.equal((await prematureAck('early')).outcome, 'unknown');
            assert.ok(globalBarrier.inspect(), 'before IPC delivery the global marker must remain');
          }
          observedProof = result.desktopDeliveryProof;
          expectedDigest = createHash('sha256').update(result.text, 'utf16le').digest('hex');
          const forged = await delivery.acknowledge(1, args.toolCallId, 'forged-proof', expectedDigest, new AbortController().signal);
          assert.equal(forged.outcome, 'unknown');
          assert.equal((await delivery.acknowledge(2, args.toolCallId, observedProof, expectedDigest, new AbortController().signal)).outcome, 'unknown');
          assert.equal((await delivery.acknowledge(1, 'wrong-call', observedProof, expectedDigest, new AbortController().signal)).outcome, 'unknown');
          assert.equal((await delivery.acknowledge(1, args.toolCallId, observedProof, 'a'.repeat(64), new AbortController().signal)).outcome, 'unknown');
          if (mode === 'duplicate') {
            await assert.rejects(delivery.run({ generation: 1, id: args.toolCallId, signal: new AbortController().signal,
              isCurrent: () => true }, async () => { throw new Error('duplicate must not execute'); }), /Duplicate/);
          }
          if (mode === 'generation-change') {
            delivery.end(); hostTurn = 'next-host-turn'; delivery.begin(2, hostTurn);
          }
        }
        if (mode === 'tamper-in-transit' && result.desktopDeliveryProof) result.text = result.text.slice(0, -1);
        return result;
      }
      if (message.method === 'desktop.deliveryAck') {
        const pending = delivery.acknowledge(message.generation, message.args.toolCallId, message.args.proof, message.args.textDigest, controller.signal);
        const duplicate = await delivery.acknowledge(message.generation, message.args.toolCallId, message.args.proof, message.args.textDigest, controller.signal);
        assert.equal(duplicate.outcome, 'unknown', 'a concurrent proof replay must not invoke the closure again');
        const outcome = await pending;
        const replay = await delivery.acknowledge(message.generation, message.args.toolCallId, message.args.proof, message.args.textDigest, controller.signal);
        assert.equal(replay.outcome, 'unknown', 'a consumed proof must not be replayed within the live turn');
        return outcome;
      }
      if (message.method === 'desktop.deliveryAbandon') { delivery.abandon(message.generation, message.args.toolCallId, message.args.proof); return; }
      throw new Error('Unknown fixture call');
    };
    void execute().then(result => { if (child.connected && !controller.signal.aborted) child.send({ type: 'reply', id: message.id, ok: true, result }); },
      error => { if (child.connected && !controller.signal.aborted) child.send({ type: 'reply', id: message.id, ok: false, error: error.message }); })
      .finally(() => controls.delete(message.id));
  });
  child.send({ type: 'start', mode, compiled, dir });
  const timeout = setTimeout(() => { failure = 'child fixture timed out'; child.kill(); finish(); }, 15000);
  try {
    const exitOrDone = await Promise.race([finished.then(() => 'done'), childExit.then(() => 'exit')]);
    if (mode === 'exit' || mode === 'exit-in-lock' || mode === 'exit-during-ack') assert.equal(exitOrDone, 'exit', 'the peer must exit before it can finish');
    else assert.equal(exitOrDone, 'done', `fixture exited unexpectedly: ${stderr}`);
    if (failure) throw new Error(failure);
    if (mode === 'stop-in-lock' || mode === 'exit-in-lock' || mode === 'timeout-in-lock') await late;
    const exit = await childExit;
    if (mode === 'exit') assert.equal(exit.code, 71);
    else if (mode !== 'exit-in-lock' && mode !== 'exit-during-ack') assert.equal(exit.code, 0, stderr);
    assert.equal(calls, mode === 'missing-tool-name' ? 0 : 1, `unexpected desktop action count in ${mode}: ${JSON.stringify(doneMessage)}`);
    if (doneMessage) {
      assert.equal(doneMessage.messages.includes('deliveryToken'), false);
      if (observedProof) assert.equal(doneMessage.messages.includes(observedProof), false, 'private IPC proof entered Pi content');
    }
    if (mode === 'parallel') {
      const results = JSON.parse(doneMessage.messages);
      const refused = results.find(result => result.isError);
      assert.equal(results.length, 2);
      assert.match(refused?.content[0]?.text ?? '', /Desktop semantic snapshot is unavailable/);
    }
    const success = mode === 'normal' || mode === 'win32' || mode === 'parallel';
    if (success) {
      assert.equal(ackCount, 1, JSON.stringify({ mode, globalMode, reports, doneMessage }));
      assert.deepEqual(reports, []);
      const replay = await delivery.acknowledge(1, 'call-1', observedProof, expectedDigest, new AbortController().signal);
      assert.equal(replay.outcome, 'unknown');
      if (globalMode) assert.equal(globalBarrier.inspect(), null);
      else assert.equal((await durable.coordinator.run({ sessionId: owner, taskId, target: 'window', action: 'next', indicatorEpoch: 1,
        isCurrent: () => true, isIndicatorCurrent: () => true }, async () => ({ ok: true }))).outcome, 'known');
    } else if (mode === 'missing-tool-name') {
      assert.equal(ackCount, 0);
      assert.equal(globalBarrier.inspect(), null, 'missing native call identity must reject before dispatch');
    } else {
      assert.equal(ackCount, mode === 'stop-in-lock' || mode === 'exit-in-lock' || mode === 'timeout-in-lock' ||
        mode === 'duplicate-in-ack' || mode === 'stop-during-ack' || mode === 'exit-during-ack' ? 1 : 0);
      if (globalMode) assert.ok(globalBarrier.inspect(), `${mode} must retain the global marker`);
      else {
        const outbox = new WriteOutbox(db);
        try { assert.equal(outbox.isTaskBlocked(owner, taskId), true, `${mode} must retain the pending result`); }
        finally { outbox.close(); }
      }
    }
  } finally {
    clearTimeout(timeout); resumeAcquire(); delivery.close();
    if (child.connected) child.kill();
    await childExit; if (stop) await stop;
    await semantic.close(); await activity.dispose(); receipts.close(); durable?.close(); vault?.close(); globalBarrier?.close();
  }
}

try {
  // An async descendant can outlive its tool call. Its stale scope must still
  // be selected, then rejected by capture, rather than falling back elsewhere.
  const delivery = new GuiPiDesktopDelivery(() => 'scope-turn', () => true, () => {});
  delivery.begin(1, 'scope-turn');
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let descendant;
  assert.equal(hasGuiPiDesktopDeliveryScope(), false);
  await delivery.run({ generation: 1, id: 'scope-test', signal: new AbortController().signal, isCurrent: () => true }, async () => {
    assert.equal(hasGuiPiDesktopDeliveryScope(), true);
    descendant = ready.then(() => {
      assert.equal(hasGuiPiDesktopDeliveryScope(), true);
      assert.throws(() => captureGuiPiCuaDeliverySlot({ actor: {}, targetGeneration: 'target', isTargetCurrent: () => true }, {}), /context is unavailable/);
    });
    return { ok: true, text: 'scope fixture' };
  });
  assert.equal(hasGuiPiDesktopDeliveryScope(), false);
  release();
  await descendant;
  delivery.close();
  for (const mode of ['normal', 'win32', 'parallel', 'rewrite', 'missing-result', 'projection-change', 'tamper-in-transit', 'stop', 'host-change',
    'desktop-change', 'generation-change', 'target-change', 'indicator-change', 'duplicate', 'duplicate-in-ack', 'exit', 'stop-in-lock', 'exit-in-lock', 'timeout-in-lock']) await exercise(mode);
  for (const mode of ['normal', 'win32', 'parallel', 'rewrite', 'missing-result', 'tamper-in-transit', 'stop', 'host-change',
    'generation-change', 'target-change', 'indicator-change', 'duplicate', 'duplicate-in-ack', 'exit',
    'stop-during-ack', 'exit-during-ack', 'missing-tool-name']) await exercise(`global-${mode}`);
  console.log('gui-pi-delivery: real Pi IPC, gateway, Cua/Win32 and durable lifetime boundaries passed');
} finally { removeWorkspaceFixture(tmp, prefix); }
