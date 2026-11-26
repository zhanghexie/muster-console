import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'cua-visible-composition-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActivityRuntime } = await import(pathToFileURL(compile('main/desktop/desktopActivityRuntime.ts')));
  const { CuaSemanticRuntime } = await import(pathToFileURL(compile('main/desktop/cuaSemanticRuntime.ts')));
  const { createCuaVisibleAction } = await import(pathToFileURL(compile('main/desktop/cuaVisibleAction.ts')));
  const { createVisibleActionRuntime } = await import(pathToFileURL(compile('main/desktop/visibleActionFactory.ts')));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const { VisibleActionDispatcher } = await import(pathToFileURL(compile('main/desktop/visibleActionDispatcher.ts')));

  async function scenario(ephemeral, stopBeforeDelivery = false, missingSlot = false, recoveryFailure = false, wrongOwner = false, stalePinnedTarget = false) {
    const label = ephemeral ? 'ephemeral' : stopBeforeDelivery ? 'stopped-turn' : missingSlot ? 'missing-slot' :
      recoveryFailure ? 'recovery' : wrongOwner ? 'wrong-owner' : stalePinnedTarget ? 'stale-pinned' : 'host-turn';
    let visible = false, hostSignal, hostDelivery, acknowledgement, calls = 0, driverCloses = 0;
    const activity = new DesktopActivityRuntime({
      labels: { active: 'active', stopping: 'stopping', unknown: 'unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'unavailable' },
      createIndicator: () => ({ async show() { visible = true; }, close() { visible = false; } }),
      async releaseAll() {}
    });
    const root = path.join(temp, label);
    const actionRuntime = createVisibleActionRuntime(path.join(root, 'outbox.sqlite'), path.join(root, 'locks'));
    const receipts = new DesktopActionIdempotency(path.join(root, 'receipts'));
    const dispatcher = new VisibleActionDispatcher(receipts, actionRuntime.coordinator);
    let turnCurrent = true, targetCurrent = true, slotTargetCurrent = true;
    if (recoveryFailure) {
      const outbox = actionRuntime.coordinator.outbox, create = outbox.create.bind(outbox);
      outbox.create = (...args) => { const id = create(...args); targetCurrent = false; return id; };
    }
    const owner = `session-${label}`, actor = { sessionId: owner, taskId: `task-${label}`, turnId: 'turn', isCurrent: () => turnCurrent };
    const persistedAction = createCuaVisibleAction(dispatcher, () => missingSlot ? undefined : ({
      lease: wrongOwner ? { ...hostDelivery, owner: 'other-owner' } : hostDelivery,
      indicatorEpoch: activity.visibilityEpoch(), isIndicatorCurrent: value => activity.visibilityEpoch() === value,
      isTargetCurrent: () => slotTargetCurrent, stageDelivery(_id, _value, ack) { acknowledgement = ack; } }));
    const semantic = new CuaSemanticRuntime({
      resolveTarget: () => ({ pid: 12, windowId: 34, generation: 'window-generation', isCurrent: () => targetCurrent }),
      createConnection: () => ({ async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
        async call(name, args) {
          if (name === 'get_window_state') return { structuredContent: { pid: 12, window_id: 34, snapshot_id: 's00000001',
            elements_complete: true, elements: [{ element_token: 's00000001:0', role: 'Button', label: 'Open', actions: ['invoke'] }] } };
          calls++; return { structuredContent: { effect: 'confirmed' } };
        }, async close() { driverCloses++; } }),
      runPersistedAction: ephemeral ? async (request, dispatch, semanticSignal) => {
        const epoch = activity.visibilityEpoch();
        const result = await dispatcher.run({ sessionId: request.actor.sessionId, taskId: request.actor.taskId,
          target: request.hostWindowId, action: `semantic:${request.action}`, indicatorEpoch: epoch,
          isCurrent: request.isCurrent,
          isIndicatorCurrent: value => activity.visibilityEpoch() === value,
          signal: semanticSignal }, request.requestId, request.fingerprint, dispatch);
        if (result.reply.outcome === 'unknown') return result.reply;
        acknowledgement = result.acknowledge;
        return result.reply;
      } : persistedAction
    });
    try {
      activity.turns.noteUserInstruction(owner, 'message');
      activity.turns.begin(owner, 'turn', () => turnCurrent, true, 'message');
      const page = await activity.turns.use(owner, 'turn', label, signal => semantic.observe(actor, 'window', signal), false);
      assert.equal(visible, true, 'indicator must be mounted before desktop observation');
      const running = activity.turns.use(owner, 'turn', label, (signal, delivery) => {
        hostSignal = signal; hostDelivery = delivery;
        assert.equal(delivery.owner, owner); assert.equal(delivery.turnId, 'turn');
        assert.equal(Object.isFrozen(delivery), true);
        return semantic.act(actor, { snapshotId: page.snapshotId, ref: page.elements[0].ref,
          requestId: 'request', action: 'click' }, signal);
      });
      if (missingSlot || wrongOwner) {
        await assert.rejects(running, /delivery context is unavailable/);
        assert.equal(calls, 0, 'missing delivery correlation must fail before any native action');
        assert.equal(hostDelivery.signal.aborted, false, 'a proven pre-dispatch failure must not stop the whole desktop run');
        return;
      }
      if (recoveryFailure) {
        await assert.rejects(running, error => error.name === 'PreDispatchRecoveryRequired' && /requires recovery/.test(error.message));
        assert.equal(calls, 0, 'failure after recording intent must still not call the backend');
        assert.equal(hostDelivery.signal.aborted, true, 'uncertain durable cleanup must pause the run');
        return;
      }
      const result = await running;
      assert.equal(result.outcome, 'dispatched'); assert.equal(result.effect, 'confirmed');
      assert.equal(calls, 1); assert.equal(driverCloses, 1, 'private driver is retired after the semantic action');
      if (ephemeral) await assert.rejects(acknowledgement('delivery'), /rejected/,
        'the closed semantic session cannot be used as a delivery lifetime');
      else if (stalePinnedTarget) {
        targetCurrent = false;
        assert.equal(slotTargetCurrent, true, 'a later target lookup alone is insufficient');
        await assert.rejects(acknowledgement('delivery'), /rejected/,
          'the original pinned window generation must remain current through delivery');
      }
      else if (stopBeforeDelivery) {
        const stopping = activity.stop();
        assert.equal(activity.isVisible(), true, 'the indicator may still be visible immediately after stop');
        assert.equal(hostSignal.aborted, false, 'a completed seat signal is no longer linked to the desktop run');
        assert.equal(hostDelivery.signal.aborted, true, 'the run-level delivery signal aborts synchronously');
        assert.equal(hostDelivery.isCurrent(), false);
        await assert.rejects(acknowledgement('delivery'), /rejected/, 'a stopped run cannot confirm a late result');
        await stopping;
      }
      else {
        const firstAck = acknowledgement;
        const nextPage = await activity.turns.use(owner, 'turn', label, signal => semantic.observe(actor, 'window', signal), false);
        await assert.rejects(activity.turns.use(owner, 'turn', label, (signal, delivery) => {
          hostSignal = signal; hostDelivery = delivery;
          return semantic.act(actor, { snapshotId: nextPage.snapshotId, ref: nextPage.elements[0].ref,
            requestId: 'second-request', action: 'click' }, signal);
        }), /not dispatched/, 'a second write waits for the first delivery');
        assert.equal(calls, 1, 'the blocked second request never reaches the driver');
        assert.equal(hostDelivery.signal.aborted, false, 'a proven pre-dispatch block must not stop the run');
        assert.deepEqual(await firstAck('delivery'), { outcome: 'acknowledged' },
          'the first delivered result can still clear its barrier');
      }
    } finally {
      await semantic.close();
      await activity.dispose();
      receipts.close(); actionRuntime.close();
    }
  }
  await scenario(true);
  await scenario(false);
  await scenario(false, true);
  await scenario(false, false, true);
  await scenario(false, false, false, true);
  await scenario(false, false, false, false, true);
  await scenario(false, false, false, false, false, true);
  console.log('Cua visible composition: session cleanup and host delivery lifetime passed');
} finally { removeWorkspaceFixture(temp, 'cua-visible-composition-'); }
