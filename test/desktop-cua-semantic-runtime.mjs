import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'cua-runtime-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { CuaSemanticRuntime } = await import(pathToFileURL(compile('main/desktop/cuaSemanticRuntime.ts')));
const { CuaVisibleBridge } = await import(pathToFileURL(compile('main/desktop/cuaVisibleBridge.ts')));
const { captureInvocationCuaSlot } = await import(pathToFileURL(compile('main/desktop/desktopDeliveryInvocation.ts')));
const { createCuaVisibleAction } = await import(pathToFileURL(compile('main/desktop/cuaVisibleAction.ts')));
const { GlobalVisibleActionDispatcher } = await import(pathToFileURL(compile('main/desktop/globalVisibleActionDispatcher.ts')));
const { isRecordedDesktopOutcome } = await import(pathToFileURL(compile('main/desktop/recordedDesktopOutcome.ts')));

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
const actor = (sessionId, taskId = 'task', turnId = 'turn', isCurrent = () => true) => ({ sessionId, taskId, turnId, isCurrent });

function fixture(extra = {}) {
  const drivers = [], resolverCalls = [], persisted = [], behaviors = [];
  const targets = new Map([
    ['host-a', { pid: 11, windowId: 21, generation: 'a-1', valid: true }],
    ['host-b', { pid: 12, windowId: 22, generation: 'b-1', valid: true }]
  ]);
  class FakeDriver {
    constructor(behavior) { this.behavior = behavior; this.calls = []; this.closeCount = 0; this.closed = false; }
    async connect() { this.behavior.connectStarted?.(); if (this.behavior.connectGate) await this.behavior.connectGate; if (this.behavior.connectError) throw new Error('private native connection error'); }
    async setValueDelivery(platform) { this.platform = platform; if (this.behavior.deliveryError) throw new Error('private schema error'); return this.behavior.delivery ?? 'mode-parameter'; }
    async call(name, args) {
      this.calls.push({ name, args });
      if (name === 'get_window_state') {
        this.behavior.observeStarted?.();
        if (this.behavior.observeGate) await this.behavior.observeGate;
        if (this.behavior.observeError) throw new Error('private native pid 123');
        const elements = Array.from({ length: this.behavior.count ?? 1 }, (_, i) => ({
          element_token: `s00000001:${i}`, role: this.behavior.role ?? 'Button', label: this.behavior.label ?? 'Same title',
          value: this.behavior.value ?? 'v'.repeat(this.behavior.large ? 256 : 0), actions: this.behavior.actions ?? ['invoke']
        }));
        return { structuredContent: { pid: args.pid, window_id: args.window_id, snapshot_id: 's00000001', elements_complete: true, elements } };
      }
      this.behavior.actionStarted?.();
      if (this.behavior.actionGate) await this.behavior.actionGate;
      if (this.behavior.actionError) throw new Error('private native window identifier');
      return this.behavior.actionResult ?? { isError: false, structuredContent: { effect: 'confirmed' } };
    }
    async close() {
      this.closeCount++;
      if (this.behavior.closeStarted) this.behavior.closeStarted();
      if (this.behavior.closeGate) await this.behavior.closeGate;
      if (this.behavior.closeError) throw new Error('private process path');
      this.closed = true;
    }
  }
  const opts = {
    resolveTarget(a, id) {
      resolverCalls.push({ sessionId: a.sessionId, id });
      const target = targets.get(id);
      if (!target) throw new Error('private resolver error');
      return { pid: target.pid, windowId: target.windowId, generation: target.generation, isCurrent: () => target.valid };
    },
    createConnection() { const d = new FakeDriver(behaviors.shift() ?? {}); drivers.push(d); return d; },
    async runPersistedAction(request, dispatch, signal) {
      persisted.push({ phase: 'before', request });
      try { return { outcome: 'dispatched', value: await dispatch(signal), invocationId: 'receipt' }; }
      catch { return { outcome: 'unknown', invocationId: 'receipt' }; }
    },
    ...extra
  };
  return { runtime: new CuaSemanticRuntime(opts), drivers, resolverCalls, persisted, behaviors, targets };
}
const request = page => ({ snapshotId: page.snapshotId, ref: page.elements[0].ref, requestId: 'request-1', action: 'click' });
const hasCode = code => error => error.code === code;

try {
  // The trusted duplicate result survives Cua's projection and must not stop
  // the active owner. Copying the same public fields does not carry the proof.
  for (const recorded of [true, false]) {
    let stops = 0;
    const life = new AbortController(), lease = { owner: 'duplicate', turnId: 'turn', signal: life.signal, isCurrent: () => !life.signal.aborted };
    const owner = { sessionId: 'duplicate', taskId: 'task', isCurrent: () => !life.signal.aborted };
    const dispatcher = recorded ? new GlobalVisibleActionDispatcher({
      async run() { return { outcome: 'unknown', operationId: 'prior', reason: 'request-already-recorded', recordedRequest: true }; },
      async acknowledge() { throw new Error('not expected'); }
    }, { resolveLogicalOperationId: () => 'host-owned-prior', classifyResult: value => value, deliveryEvidence: () => undefined }) : {
      async run() { return { reply: { outcome: 'unknown', invocationId: 'prior', reason: 'request-already-recorded' } }; }
    };
    const f = fixture({ runPersistedAction: createCuaVisibleAction(dispatcher, () => ({ lease, indicatorEpoch: 1,
      isIndicatorCurrent: epoch => epoch === 1, isTargetCurrent: () => true, stageDelivery() { throw new Error('not expected'); } })) });
    const bridge = new CuaVisibleBridge({ runtime: f.runtime, activity: { visibilityEpoch: () => 1, stop: async () => { stops++; } },
      resolveTarget: () => ({ surfaceId: 'display', isCurrent: () => true }), reportStopError: error => { throw error; } });
    const page = await bridge.observe(owner, lease, 'display', 'host-a');
    const result = await bridge.act(owner, lease, 'display', 'host-a', request(page));
    assert.equal(result.outcome, 'unknown');
    assert.equal(isRecordedDesktopOutcome(result), recorded);
    assert.equal(isRecordedDesktopOutcome({ ...result }), false);
    assert.equal(stops, recorded ? 0 : 1);
    assert.equal(f.drivers[0].calls.filter(call => call.name === 'click').length, 0);
    await f.runtime.close();
  }
  // The driver may take time to exit after producing an action result. A stop
  // during cleanup cannot be reported as a current successful action.
  {
    const closing = deferred(), release = deferred();
    let current = true;
    const f = fixture(); f.behaviors.push({ closeStarted: closing.resolve, closeGate: release.promise });
    const owner = actor('cleanup-stale', 'task', 'turn', () => current);
    const page = await f.runtime.observe(owner, 'host-a');
    const pending = f.runtime.act(owner, request(page));
    await closing.promise; current = false; release.resolve();
    const result = await pending;
    assert.equal(result.outcome, 'unknown');
    assert.equal(f.drivers[0].calls.filter(call => call.name === 'click').length, 1);
    await f.runtime.close();
  }
  {
    const closing = deferred(), release = deferred();
    let current = true;
    const priorDispatcher = new GlobalVisibleActionDispatcher({
      async run() { return { outcome: 'unknown', operationId: 'prior', reason: 'request-already-recorded', recordedRequest: true }; },
      async acknowledge() { throw new Error('not expected'); }
    }, { resolveLogicalOperationId: () => 'host-owned-prior', classifyResult: value => value, deliveryEvidence: () => undefined });
    const life = new AbortController(), owner = actor('recorded-cleanup', 'task', 'turn', () => current);
    const lease = { owner: owner.sessionId, turnId: owner.turnId, signal: life.signal, isCurrent: () => current };
    const f = fixture({ runPersistedAction: createCuaVisibleAction(priorDispatcher, () => ({ lease, indicatorEpoch: 1,
      isIndicatorCurrent: () => true, isTargetCurrent: () => true, stageDelivery() { throw new Error('not expected'); } })) });
    f.behaviors.push({ closeStarted: closing.resolve, closeGate: release.promise });
    const page = await f.runtime.observe(owner, 'host-a');
    const pending = f.runtime.act(owner, request(page));
    await closing.promise; current = false; release.resolve();
    const result = await pending;
    assert.equal(result.outcome, 'unknown');
    assert.equal(isRecordedDesktopOutcome(result), false, 'stale cleanup must not preserve a safe duplicate proof');
    assert.equal(f.drivers[0].calls.filter(call => call.name === 'click').length, 0);
    await f.runtime.close();
  }
  // Exercise the host bridge against the real semantic registry and private
  // invocation context, while the native driver and engine remain fixtures.
  {
    let active = true, visible = 7, staged = 0;
    const life = new AbortController(), lease = { owner: 'bridge', turnId: 'turn', signal: life.signal, isCurrent: () => active };
    const owner = { sessionId: 'bridge', taskId: 'task', isCurrent: () => active };
    const selector = { cua: (request, context) => { staged++; assert.equal(request.hostWindowId, 'host-a');
      assert.equal(context.lease, lease); assert.equal(context.isTargetCurrent(), true); return {}; }, win32() {} };
    const f = fixture({ async runPersistedAction(request, dispatch, signal) {
      captureInvocationCuaSlot(selector, request);
      return { outcome: 'dispatched', value: await dispatch(signal), invocationId: 'receipt' };
    } });
    const bridge = new CuaVisibleBridge({ runtime: f.runtime, activity: { visibilityEpoch: () => visible,
      stop: async () => { active = false; life.abort(); } },
      resolveTarget: (_actor, id) => ({ surfaceId: 'display', isCurrent: () => id === 'host-a' && active }), reportStopError: error => { throw error; } });
    const page = await bridge.observe(owner, lease, 'display', 'host-a');
    assert.equal((await bridge.page(owner, lease, 'display', 'host-a', page.snapshotId, 0)).snapshotId, page.snapshotId);
    await assert.rejects(bridge.page(owner, lease, 'display', 'host-b', page.snapshotId, 0), /different window/);
    await assert.rejects(bridge.act(owner, lease, 'other-display', 'host-a', request(page)), error => error.name === 'PreDispatchFailure');
    await assert.rejects(bridge.act(owner, lease, 'display', 'host-b', request(page)), error => error.name === 'PreDispatchFailure');
    assert.equal(staged, 0, 'a snapshot cannot be relabeled to another window');
    assert.equal((await bridge.act(owner, lease, 'display', 'host-a', request(page))).outcome, 'dispatched');
    assert.equal(staged, 1);
    assert.equal(f.drivers[0].closeCount, 1);
    await assert.rejects(bridge.act(owner, lease, 'display', 'host-a', request(page)), error => error.name === 'PreDispatchFailure');
    visible = undefined;
    await assert.rejects(bridge.observe(owner, lease, 'display', 'host-a'), /indicator/);
    await f.runtime.close();
  }
  // Stopping the whole desktop run must promptly reclaim a driver left idle
  // after observation, without relying on a later action or TTL sweep.
  {
    const f = fixture(), closed = deferred(), life = new AbortController();
    f.behaviors.push({ closeStarted: closed.resolve });
    const owner = { ...actor('lifetime'), lifetimeSignal: life.signal };
    const page = await f.runtime.observe(owner, 'host-a');
    life.abort();
    let timer;
    try {
      await Promise.race([closed.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cua driver stayed alive after stop')), 500); })]);
    } finally { clearTimeout(timer); }
    assert.equal(f.drivers[0].closeCount, 1);
    await assert.rejects(f.runtime.page(owner, page.snapshotId, 0), hasCode('stale'));
    await f.runtime.close();
  }
  {
    const f = fixture(), closeStarted = deferred(), closeGate = deferred();
    f.behaviors.push({ closeStarted: closeStarted.resolve, closeGate: closeGate.promise });
    const owner = actor('stop-all');
    const old = await f.runtime.observe(owner, 'host-a');
    let stopped = false;
    const stopping = f.runtime.stopAll().then(() => { stopped = true; });
    await closeStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'stop waits for the driver process to be reclaimed');
    closeGate.resolve();
    await stopping;
    await assert.rejects(f.runtime.page(owner, old.snapshotId, 0), hasCode('stale'));
    const fresh = await f.runtime.observe(owner, 'host-a');
    assert.notEqual(fresh.snapshotId, old.snapshotId, 'a later user turn can open a new driver session');
    await f.runtime.close();
  }
  // Same labels do not identify targets; refs belong to the exact actor triple.
  {
    const f = fixture({ platform: 'darwin' });
    const a = actor('session-a'), b = actor('session-b');
    const one = await f.runtime.observe(a, 'host-a');
    const two = await f.runtime.observe(b, 'host-b');
    assert.equal(one.elements[0].label, two.elements[0].label);
    assert.notEqual(one.snapshotId, two.snapshotId);
    assert.equal(f.drivers[0].platform, 'darwin');
    assert.equal(f.drivers[0].calls[0].args.pid, 11);
    assert.equal(f.drivers[1].calls[0].args.pid, 12);
    assert.doesNotMatch(JSON.stringify(one), /element_token|window_id|"pid"/);
    await assert.rejects(f.runtime.observe(actor('unregistered'), '21'), hasCode('stale'));
    assert.equal(f.drivers.length, 2, 'a model-supplied numeric handle cannot start a driver');
    await assert.rejects(f.runtime.page(b, one.snapshotId, 0), hasCode('stale'));
    await assert.rejects(f.runtime.page(actor('session-a', 'other-task'), one.snapshotId, 0), hasCode('stale'));
    await assert.rejects(f.runtime.act(actor('session-a', 'task', 'other-turn'), request(one)), hasCode('stale'));
    const outcome = await f.runtime.act(a, request(one));
    assert.deepEqual(outcome, { outcome: 'dispatched', ok: true, delivery: 'unknown', effect: 'confirmed', verification: 'not_performed', invocationId: 'receipt' });
    assert.equal(f.persisted[0].phase, 'before');
    assert.equal(f.persisted[0].request.hostWindowId, 'host-a');
    assert.match(f.persisted[0].request.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(f.drivers[0].closeCount, 1);
    await assert.rejects(f.runtime.page(a, one.snapshotId, 0), hasCode('stale'));
    await f.runtime.close(); assert.equal(f.drivers[1].closeCount, 1);
  }

  // Pin native identity and action arguments across every async boundary.
  {
    const connectStarted = deferred(), connectGate = deferred();
    const target = { pid: 11, windowId: 21, generation: 'pinned', isCurrent: () => true };
    const f = fixture({ resolveTarget: () => target });
    f.behaviors.push({ connectStarted: connectStarted.resolve, connectGate: connectGate.promise });
    const opening = f.runtime.observe(actor('pin'), 'host-a'); await connectStarted.promise;
    target.pid = 99; target.windowId = 999; target.generation = 'changed';
    connectGate.resolve(); await opening;
    assert.equal(f.drivers[0].calls[0].args.pid, 11);
    assert.equal(f.drivers[0].calls[0].args.window_id, 21);
    await f.runtime.close();
  }
  {
    const entered = deferred(), proceed = deferred();
    const f = fixture({ runPersistedAction: async (input, dispatch, signal) => {
      entered.resolve(input); await proceed.promise;
      return { outcome: 'dispatched', value: await dispatch(signal) };
    } });
    const a = actor('immutable'), page = await f.runtime.observe(a, 'host-a'), input = request(page);
    const pending = f.runtime.act(a, input); const persisted = await entered.promise;
    input.ref = 'other'; input.action = 'set_value'; input.value = 'mutated';
    proceed.resolve(); const outcome = await pending;
    assert.equal(outcome.effect, 'confirmed');
    assert.equal(persisted.action, 'click'); assert.match(persisted.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(f.drivers[0].calls.at(-1).name, 'click');
    assert.equal('value' in f.drivers[0].calls.at(-1).args, false);
    await f.runtime.close();
  }

  // Switching observations closes the old process and invalidates its refs;
  // reusing a native handle with a new generation never revives the old one.
  {
    const f = fixture(), a = actor('worker');
    const old = await f.runtime.observe(a, 'host-a');
    const switched = await f.runtime.observe(a, 'host-b');
    assert.equal(f.drivers[0].closed, true);
    await assert.rejects(f.runtime.page(a, old.snapshotId, 0), hasCode('stale'));
    f.targets.get('host-b').valid = false;
    await assert.rejects(f.runtime.page(a, switched.snapshotId, 0), hasCode('stale'));
    assert.equal(f.drivers[1].closed, true);
    f.targets.set('host-b', { pid: 12, windowId: 22, generation: 'b-2', valid: true });
    const fresh = await f.runtime.observe(a, 'host-b');
    assert.notEqual(fresh.snapshotId, switched.snapshotId);
    await assert.rejects(f.runtime.act(a, request(switched)), hasCode('stale'));
    await f.runtime.close();
  }

  // Bounded pages preserve refs only after they have actually been returned.
  {
    const f = fixture(); f.behaviors.push({ count: 100, large: true });
    const a = actor('paged'); let page = await f.runtime.observe(a, 'host-a'), seen = page.elements.length;
    const id = page.snapshotId;
    assert.ok(JSON.stringify(page).length < 12000);
    assert.notEqual(page.nextOffset, null);
    while (page.nextOffset !== null) {
      page = await f.runtime.page(a, id, page.nextOffset);
      assert.ok(JSON.stringify(page).length < 12000);
      seen += page.elements.length;
    }
    assert.equal(seen, 100);
    assert.equal(page.complete, true);
    await f.runtime.close();
  }

  // Session projection withholds values whose sensitivity cannot be verified.
  {
    const f = fixture(); f.behaviors.push({ role: 'Password', value: 'synthetic-secret', label: 'contains synthetic-secret' });
    const page = await f.runtime.observe(actor('redacted'), 'host-a');
    assert.equal(page.elements[0].value, undefined);
    assert.ok(page.limitations.includes('semantic_values_redacted'));
    assert.doesNotMatch(JSON.stringify(page), /synthetic-secret/);
    await f.runtime.close();
  }

  // Missing durable execution never dispatches. Refusal is retained as a
  // negative effect; partial effects remain unknown, even through the wrapper.
  {
    const f = fixture({ runPersistedAction: undefined }), a = actor('readonly');
    const page = await f.runtime.observe(a, 'host-a');
    await assert.rejects(f.runtime.act(a, request(page)), /Durable/);
    assert.equal(f.drivers[0].calls.length, 1);
    await f.runtime.page(a, page.snapshotId, 0);
    await f.runtime.close();
  }
  for (const effect of ['refused', 'not_applied', 'partial', 'unknown']) {
    const f = fixture(), a = actor(`effect-${effect}`);
    f.behaviors.push({ actionResult: { isError: true, structuredContent: { effect, code: 'backend_refused', window_id: 21 } } });
    const page = await f.runtime.observe(a, 'host-a');
    const result = await f.runtime.act(a, request(page));
    assert.equal(result.ok, false);
    assert.equal(result.effect, effect);
    assert.equal(result.verification, 'not_performed');
    assert.equal(result.outcome, effect === 'refused' || effect === 'not_applied' ? 'dispatched' : 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /window_id/);
    await f.runtime.close();
  }
  {
    const fake = { ok: true, delivery: 'unknown', effect: 'confirmed', verification: 'not_performed' };
    const f = fixture({ runPersistedAction: async () => ({ outcome: 'dispatched', value: fake }) });
    const a = actor('no-dispatch'), page = await f.runtime.observe(a, 'host-a');
    const result = await f.runtime.act(a, request(page));
    assert.equal(result.outcome, 'unknown', 'a wrapper cannot claim a dispatch it never made');
    assert.equal(f.drivers[0].calls.length, 1); await f.runtime.close();
  }
  {
    const f = fixture({ runPersistedAction: async (_request, dispatch) => {
      const value = await dispatch();
      try { await dispatch(); } catch { return { outcome: 'unknown' }; }
      return { outcome: 'dispatched', value };
    } });
    const a = actor('double-dispatch'), page = await f.runtime.observe(a, 'host-a');
    const result = await f.runtime.act(a, request(page));
    assert.equal(result.outcome, 'unknown');
    assert.equal(f.drivers[0].calls.filter(call => call.name === 'click').length, 1);
    await f.runtime.close();
  }
  {
    const started = deferred(), release = deferred();
    let unhandled;
    const listener = error => { unhandled = error; };
    process.on('unhandledRejection', listener);
    try {
      const f = fixture({ runPersistedAction: async (_request, dispatch) => { void dispatch(); await started.promise; return { outcome: 'unknown' }; } });
      f.behaviors.push({ actionStarted: started.resolve, actionGate: release.promise });
      const a = actor('discarded-dispatch'), page = await f.runtime.observe(a, 'host-a');
      assert.equal((await f.runtime.act(a, request(page))).outcome, 'unknown');
      release.resolve(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(unhandled, undefined, 'late failure from a discarded dispatch promise must be observed');
      await f.runtime.close();
    } finally { process.off('unhandledRejection', listener); }
  }
  {
    const f = fixture({ runPersistedAction: async (_request, dispatch) => {
      const value = await dispatch();
      return { outcome: 'dispatched', value: { ...value, ok: true, effect: 'confirmed' }, invocationId: 'private/path' };
    } });
    f.behaviors.push({ actionResult: { isError: true, structuredContent: { effect: 'refused' } } });
    const a = actor('mismatched-receipt'), page = await f.runtime.observe(a, 'host-a');
    const result = await f.runtime.act(a, request(page));
    assert.equal(result.outcome, 'unknown', 'a mismatched durable receipt cannot become success');
    assert.equal(result.invocationId, undefined, 'unsafe receipt identifiers are not disclosed');
    await f.runtime.close();
  }

  // Same-actor observe/act and same-target cross-actor operations cannot race.
  {
    const f = fixture(), started = deferred(), release = deferred(), a = actor('a'), b = actor('b');
    f.behaviors.push({ actionStarted: started.resolve, actionGate: release.promise });
    const first = await f.runtime.observe(a, 'host-a');
    const second = await f.runtime.observe(b, 'host-a');
    const action = f.runtime.act(a, request(first));
    await started.promise;
    assert.equal(f.drivers[1].closed, true, 'a write revokes other observations of the same native target');
    await assert.rejects(f.runtime.page(b, second.snapshotId, 0), hasCode('stale'));
    await assert.rejects(f.runtime.page(a, first.snapshotId, 0), hasCode('busy'));
    await assert.rejects(f.runtime.observe(b, 'host-a'), hasCode('busy'));
    release.resolve(); assert.equal((await action).effect, 'confirmed');
    await f.runtime.close();
  }
  {
    const f = fixture(), started = deferred(), release = deferred(), a = actor('slow-observe');
    f.behaviors.push({ observeStarted: started.resolve, observeGate: release.promise });
    const observing = f.runtime.observe(a, 'host-a'); await started.promise;
    await assert.rejects(f.runtime.observe(a, 'host-b'), hasCode('busy'));
    release.resolve(); const page = await observing;
    assert.equal(page.elements.length, 1);
    await f.runtime.close();
  }
  {
    const f = fixture(), closingA = deferred(), closingB = deferred(), allowB = deferred();
    f.behaviors.push({ closeStarted: closingA.resolve }, { closeStarted: closingB.resolve, closeGate: allowB.promise });
    const a = actor('cancel-before-dispatch-a'), b = actor('cancel-before-dispatch-b');
    const page = await f.runtime.observe(a, 'host-a'); await f.runtime.observe(b, 'host-a');
    const controller = new AbortController();
    const action = f.runtime.act(a, request(page), controller.signal).catch(error => error);
    await closingB.promise; controller.abort(); await closingA.promise;
    allowB.resolve(); assert.equal((await action).code, 'stale');
    assert.equal(f.persisted.length, 0, 'abort during peer cleanup must not dispatch');
    await f.runtime.close();
  }
  {
    const f = fixture(), started = deferred(), release = deferred(), a = actor('changed-during-observe');
    f.behaviors.push({ observeStarted: started.resolve, observeGate: release.promise });
    const observing = f.runtime.observe(a, 'host-a').catch(error => error); await started.promise;
    f.targets.get('host-a').valid = false; release.resolve();
    assert.equal((await observing).code, 'stale');
    assert.equal(f.drivers[0].closed, true); await f.runtime.close();
  }

  // Cancelled in-flight driver work stays unknown and cannot finish until
  // process cleanup is confirmed, even if the fake backend never returns.
  {
    const f = fixture(), started = deferred(), never = deferred(), closeStarted = deferred(), closeGate = deferred();
    f.behaviors.push({ actionStarted: started.resolve, actionGate: never.promise, closeStarted: closeStarted.resolve, closeGate: closeGate.promise });
    const a = actor('cancel'), page = await f.runtime.observe(a, 'host-a'), controller = new AbortController();
    let finished = false;
    const action = f.runtime.act(a, request(page), controller.signal).then(value => { finished = true; return value; });
    await started.promise; controller.abort(); await closeStarted.promise;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    closeGate.resolve(); const result = await action;
    assert.equal(result.outcome, 'unknown'); assert.equal(result.effect, 'unknown'); assert.equal(result.ok, false);
    assert.equal(f.drivers[0].closeCount, 1);
    await f.runtime.close();
  }
  {
    const f = fixture(), started = deferred(), never = deferred();
    f.behaviors.push({ observeStarted: started.resolve, observeGate: never.promise });
    const opening = f.runtime.observe(actor('close-observation'), 'host-a').catch(error => error);
    await started.promise; await f.runtime.close();
    assert.equal((await opening).code, 'closed', 'runtime close interrupts a pending observation');
    assert.equal(f.drivers[0].closed, true);
    never.resolve();
  }
  {
    const f = fixture(), started = deferred(), never = deferred();
    f.behaviors.push({ connectStarted: started.resolve, connectGate: never.promise });
    const opening = f.runtime.observe(actor('close-connect'), 'host-a').catch(error => error);
    await started.promise; await f.runtime.close();
    assert.equal((await opening).code, 'closed', 'closing must invalidate a pending driver connection');
    assert.equal(f.drivers[0].closed, true);
    never.resolve();
  }
  {
    const inner = new AbortController(), started = deferred(), never = deferred();
    const f = fixture({ runPersistedAction: async (_request, dispatch) => {
      try { return { outcome: 'dispatched', value: await dispatch(inner.signal) }; }
      catch { return { outcome: 'unknown' }; }
    } });
    f.behaviors.push({ actionStarted: started.resolve, actionGate: never.promise });
    const a = actor('inner-cancel'), page = await f.runtime.observe(a, 'host-a');
    const action = f.runtime.act(a, request(page)); await started.promise; inner.abort();
    const result = await action;
    assert.equal(result.outcome, 'unknown'); assert.equal(f.drivers[0].closed, true);
    never.resolve(); await f.runtime.close();
  }
  {
    const f = fixture(), started = deferred(), never = deferred();
    f.behaviors.push({ actionStarted: started.resolve, actionGate: never.promise });
    const a = actor('close-action'), page = await f.runtime.observe(a, 'host-a');
    const action = f.runtime.act(a, request(page));
    await started.promise; await f.runtime.close();
    assert.equal((await action).outcome, 'unknown', 'runtime close interrupts in-flight work');
    assert.equal(f.drivers[0].closed, true);
    never.resolve();
  }

  // Limits, TTL, stale actors, driver crash and failed cleanup are explicit.
  {
    let now = 1_000;
    const f = fixture({ maxSessions: 1, ttlMs: 10_000, now: () => now });
    const a = actor('capacity-a'), b = actor('capacity-b');
    await f.runtime.observe(a, 'host-a');
    await assert.rejects(f.runtime.observe(b, 'host-b'), hasCode('capacity'));
    now += 10_001; await f.runtime.sweep(); assert.equal(f.drivers[0].closed, true);
    await f.runtime.observe(b, 'host-b'); await f.runtime.close();
  }
  {
    let current = true;
    const f = fixture(), a = actor('stale', 'task', 'turn', () => current);
    const page = await f.runtime.observe(a, 'host-a'); current = false;
    await assert.rejects(f.runtime.page(a, page.snapshotId, 0), hasCode('stale'));
    assert.equal(f.drivers[0].closed, true); await f.runtime.close();
  }
  {
    const f = fixture(), a = actor('crash'); f.behaviors.push({ observeError: true });
    await assert.rejects(f.runtime.observe(a, 'host-a'), error => error.code === 'driver' && !error.message.includes('123'));
    assert.equal(f.drivers[0].closed, true); await f.runtime.close();
  }
  for (const behavior of [{ connectError: true }, { deliveryError: true }]) {
    const f = fixture(); f.behaviors.push(behavior);
    await assert.rejects(f.runtime.observe(actor('startup-error'), 'host-a'), error =>
      error.code === 'driver' && (!behavior.deliveryError || /set_value delivery capability/.test(error.message)));
    assert.equal(f.drivers[0].closed, true, 'startup failure must reclaim its process');
    await f.runtime.close();
  }
  assert.throws(() => fixture({ platform: 'freebsd' }), hasCode('invalid'));
  {
    const f = fixture(), a = actor('action-crash'); f.behaviors.push({ actionError: true });
    const page = await f.runtime.observe(a, 'host-a');
    const outcome = await f.runtime.act(a, request(page));
    assert.equal(outcome.outcome, 'unknown'); assert.equal(outcome.effect, 'unknown');
    assert.doesNotMatch(JSON.stringify(outcome), /private native/);
    assert.equal(f.drivers[0].closed, true); await f.runtime.close();
  }
  for (const platform of ['win32', 'darwin', 'linux']) {
    const f = fixture({ platform });
    await f.runtime.observe(actor(`platform-${platform}`), 'host-a');
    assert.equal(f.drivers[0].platform, platform);
    await f.runtime.close();
  }
  {
    const f = fixture({ platform: 'linux' }), a = actor('set-value-unavailable');
    f.behaviors.push({ delivery: 'unavailable', actions: ['invoke', 'set_value'] });
    const page = await f.runtime.observe(a, 'host-a');
    assert.ok(page.limitations.includes('semantic_set_value_unavailable'));
    assert.deepEqual(page.elements[0].actions, ['invoke']);
    await assert.rejects(f.runtime.act(a, { ...request(page), action: 'set_value', value: 'text' }), hasCode('invalid'));
    assert.equal(f.persisted.length, 0, 'an unsupported action must not enter the durable dispatcher');
    assert.equal(f.drivers[0].calls.length, 1);
    await f.runtime.close();
  }
  {
    const f = fixture({ platform: 'darwin' }), a = actor('mac-background-only');
    f.behaviors.push({ delivery: 'background-only' });
    const page = await f.runtime.observe(a, 'host-a');
    const result = await f.runtime.act(a, { ...request(page), action: 'set_value', value: 'text' });
    assert.equal(result.ok, true);
    assert.equal('delivery_mode' in f.drivers[0].calls.at(-1).args, false);
    await f.runtime.close();
  }
  {
    const f = fixture(), a = actor('cleanup-failure'); f.behaviors.push({ closeError: true });
    const page = await f.runtime.observe(a, 'host-a');
    await assert.rejects(f.runtime.act(a, request(page)), error => error.code === 'cleanup_unconfirmed' && error.outcome === 'unknown');
    await assert.rejects(f.runtime.observe(actor('next'), 'host-b'), hasCode('cleanup_unconfirmed'));
    await assert.rejects(f.runtime.close(), hasCode('cleanup_unconfirmed'));
  }
  {
    let notified;
    const f = fixture({ ttlMs: 10, onCleanupError: error => { notified = error; } });
    f.behaviors.push({ closeError: true }); await f.runtime.observe(actor('timer'), 'host-a');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(notified?.code, 'cleanup_unconfirmed');
    await assert.rejects(f.runtime.close(), hasCode('cleanup_unconfirmed'));
  }
  {
    const f = fixture({ ttlMs: 10 }), a = actor('timer-success');
    const page = await f.runtime.observe(a, 'host-a');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.drivers[0].closed, true, 'expired idle observations must reclaim their process');
    await assert.rejects(f.runtime.page(a, page.snapshotId, 0), hasCode('stale'));
    await f.runtime.close();
  }

  console.log('Cua semantic runtime: scoped refs, durable actions, races, cancellation and cleanup passed');
} finally {
  removeWorkspaceFixture(temp, 'cua-runtime-');
}
