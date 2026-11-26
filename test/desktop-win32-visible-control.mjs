import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'win32-visible-control-'));
let serial = 0;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = async name => import(pathToFileURL(compile(`main/desktop/${name}.ts`)));
  const { Win32VisibleControl, Win32VisibleUnknownError, createWin32PointHitTest } = await load('win32VisibleControl');
  const { Win32Targets } = await load('win32Targets');
  const { TrackedWin32Input } = await load('trackedWin32Input');
  const { createVisibleActionRuntime } = await load('visibleActionFactory');
  const { VisibleActionDispatcher } = await load('visibleActionDispatcher');
  const { DesktopActionIdempotency } = await load('actionIdempotency');
  const { PreDispatchFailure, PreDispatchRecoveryRequired } = await load('preDispatchFailure');
  const { VisibleActionPreDispatchFailure } = await load('visibleActionCoordinator');
  const { DesktopActivityRuntime } = await load('desktopActivityRuntime');
  const { GlobalVisibleActionDispatcher } = await load('globalVisibleActionDispatcher');
  const { isRecordedDesktopOutcome } = await load('recordedDesktopOutcome');

  {
    const changes = [];
    const hit = createWin32PointHitTest({ setDpiContext(value) { changes.push(value); return value === -4 ? 7 : 8; },
      windowFromPoint: point => point.x === 10 ? 0x201n : 0x301n,
      rootWindow: handle => handle === 0x201n ? 0x100n : 0x300n });
    assert.equal(hit(0x100n, 'generation', { x: 10, y: 20 }), true);
    assert.equal(hit(0x100n, 'generation', { x: 11, y: 20 }), false);
    assert.deepEqual(changes, [-4, 7, -4, 7], 'physical DPI awareness must always be restored');
    assert.throws(() => hit(0x100n, 'generation', { x: Infinity, y: 20 }), /Invalid/);
    const cannotRestore = createWin32PointHitTest({ setDpiContext: value => value === -4 ? 7 : 0,
      windowFromPoint: () => 0x201n, rootWindow: () => 0x100n });
    assert.throws(() => cannotRestore(0x100n, 'generation', { x: 10, y: 20 }), /restore DPI/);
  }

  function fixture(overrides = {}) {
    const id = ++serial, root = path.join(temp, `scenario-${id}`);
    const runtime = createVisibleActionRuntime(path.join(root, 'outbox.sqlite'), path.join(root, 'locks'));
    const receipts = new DesktopActionIdempotency(path.join(root, 'receipts'));
    const dispatcher = new VisibleActionDispatcher(receipts, runtime.coordinator);
    const state = { visible: true, actorCurrent: true, targetCurrent: true, hit: true, foreground: 0x100n,
      valid: true, sent: [], moves: [], activations: 0, acknowledgements: new Map(), unknowns: [], launchCalls: 0,
      sendHook: undefined, launchHook: undefined };
    const actor = { sessionId: `session-${id}`, taskId: `task-${id}`, turnId: 'turn', isCurrent: () => state.actorCurrent };
    const controller = new AbortController();
    const slot = { lease: { owner: actor.sessionId, turnId: actor.turnId, signal: controller.signal, isCurrent: () => !controller.signal.aborted }, indicatorEpoch: 1,
      isIndicatorCurrent: epoch => state.visible && epoch === 1, isTargetCurrent: () => state.targetCurrent,
      isPointOnTarget: (handle, generation, point) => state.hit && handle === 0x100n && generation === 'generation' &&
        point.x >= 200 && point.x < 800 && point.y >= 400 && point.y < 800,
      onUnknown(result) { state.unknowns.push(result); },
      stageDelivery(invocation, value, acknowledge) { state.acknowledgements.set(invocation, { value, acknowledge }); } };
    const window = { nativeHandle: '0x100', title: 'Fixture', titleTruncated: false, pid: 123, processImage: 'C:\\fixture.exe',
      processCreated: 'process-birth', bounds: { x: 100, y: 200, width: 300, height: 200 }, dpi: 96,
      coordinateSpace: 'win32-screen-caller-dpi', limitations: [] };
    const targets = new Win32Targets(() => ({ windows: state.valid ? [window] : [], complete: true }),
      { observe: () => 'generation', current: () => state.valid, release() {}, close() {} });
    const frame = { sessionId: actor.sessionId, taskId: actor.taskId, captureId: 'capture', surfaceId: 'display',
      surfaceGeneration: 'display-generation', geometryRevision: 'geometry', expiresAt: Date.now() + 100000,
      width: 300, height: 200, sourceSize: { width: 300, height: 200 },
      region: { x: 0, y: 0, width: 300, height: 200 }, bounds: { x: 100, y: 200, width: 300, height: 200 },
      isCurrent: () => state.valid };
    const windowId = targets.register(frame).windows[0].windowId;
    const rawInput = {
      move(x, y) { state.moves.push({ x, y }); },
      send(events) { state.sent.push(...events.map(event => ({ ...event }))); state.sendHook?.(events[0]); }
    };
    const tracked = new TrackedWin32Input(rawInput);
    const winapi = { valid: () => state.valid ? 1 : 0, minimized: () => 0, restore: () => 1,
      activate: handle => { state.foreground = handle; state.activations++; return 1; }, foreground: () => state.foreground };
    const control = new Win32VisibleControl({ dispatcher, resolveTarget: (owner, id) => targets.resolve(owner.sessionId, owner.taskId, id),
      input: tracked, windowApi: winapi, dipToPhysical: point => ({ x: point.x * 2, y: point.y * 2 }),
      resolveExecutable: async file => file,
      launchExecutable: async (file, signal) => { await state.launchHook?.(file, signal); signal?.throwIfAborted(); state.launchCalls++; return { pid: 42 }; },
      ...overrides
    });
    const act = (action, requestId, more = {}, signal) => control.act(actor, { action, windowId, ...more }, requestId, slot, signal);
    const acknowledge = async result => {
      const delivery = state.acknowledgements.get(result.invocationId);
      assert.ok(delivery, 'host retains the delivery closure');
      assert.deepEqual(await delivery.acknowledge(`delivery-${result.invocationId}`), { outcome: 'acknowledged' });
    };
    return { actor, slot, state, controller, control, tracked, windowId, act, acknowledge,
      close() { targets.close(); receipts.close(); runtime.close(); } };
  }

  // A durable read of this exact request is not a new uncertain dispatch.
  // The same public text from an ordinary dispatcher is not trusted evidence.
  for (const recorded of [true, false]) {
    let entered = 0;
    const dispatcher = recorded ? new GlobalVisibleActionDispatcher({
      async run() { return { outcome: 'unknown', operationId: 'prior', reason: 'request-already-recorded', recordedRequest: true }; },
      async acknowledge() { throw new Error('not expected'); }
    }, { resolveLogicalOperationId: () => 'host-owned-prior', classifyResult: value => value, deliveryEvidence: () => undefined }) : {
      async run() { return { reply: { outcome: 'unknown', invocationId: 'prior', reason: 'request-already-recorded' } }; }
    };
    const f = fixture({ dispatcher, launchExecutable: async () => { entered++; return { pid: 42 }; } });
    try {
      const result = await f.control.launch(f.actor, 'C:\\fixture.exe', 'duplicate', f.slot);
      assert.equal(result.outcome, 'unknown');
      assert.equal(entered, 0);
      assert.equal(isRecordedDesktopOutcome(result), recorded);
      assert.equal(isRecordedDesktopOutcome({ ...result }), false, 'the private proof cannot be copied');
      assert.equal(f.state.unknowns.length, recorded ? 0 : 1);
    } finally { f.close(); }
  }

  // The structured recovery flag, not a message or invocation ID, is authoritative.
  for (const failure of [new VisibleActionPreDispatchFailure('arbitrary message', undefined, undefined, true),
    new VisibleActionPreDispatchFailure('another message', 'persisted-invocation', undefined, true)]) {
    const f = fixture({ dispatcher: { async run() { throw failure; } } });
    try {
      await assert.rejects(f.act('focus', 'needs-recovery'), PreDispatchRecoveryRequired);
      assert.equal(f.state.activations, 0);
    } finally { f.close(); }
  }
  {
    const failure = new VisibleActionPreDispatchFailure('arbitrary message', 'unrelated-invocation', undefined, false);
    const f = fixture({ dispatcher: { async run() { throw failure; } } });
    try { await assert.rejects(f.act('focus', 'safe-retry'), PreDispatchFailure); }
    finally { f.close(); }
  }

  // No visible indicator, current lease, private slot, target, or hit proof means no OS dispatch.
  for (const missing of ['visible', 'lease', 'slot', 'target', 'hit-proof', 'unknown-handler', 'wrong-owner', 'wrong-turn']) {
    const f = fixture();
    try {
      if (missing === 'visible') f.state.visible = false;
      if (missing === 'lease') f.controller.abort();
      if (missing === 'slot') delete f.slot.stageDelivery;
      if (missing === 'target') f.state.valid = false;
      if (missing === 'hit-proof') delete f.slot.isPointOnTarget;
      if (missing === 'unknown-handler') delete f.slot.onUnknown;
      if (missing === 'wrong-owner') f.slot.lease.owner = 'different-owner';
      if (missing === 'wrong-turn') f.slot.lease.turnId = 'different-turn';
      await assert.rejects(f.act('drag', 'missing', { x: 10, y: 20, toX: 20, toY: 25 }), PreDispatchFailure);
      assert.equal(f.state.activations, 0); assert.equal(f.state.sent.length, 0); assert.equal(f.state.moves.length, 0);
    } finally { f.close(); }
  }

  // Staging may not acknowledge before the final action result exists.
  {
    const f = fixture();
    try {
      let staged, premature;
      f.slot.stageDelivery = async (_id, _value, acknowledge) => {
        staged = acknowledge;
        premature = await acknowledge('before-result');
      };
      const result = await f.act('focus', 'stage-only');
      assert.equal(result.outcome, 'dispatched');
      assert.deepEqual(premature, { outcome: 'unknown', reason: 'acknowledgement-failed' });
      await assert.rejects(f.act('focus', 'still-blocked'), PreDispatchFailure);
      assert.deepEqual(await staged('trusted-engine-delivery'), { outcome: 'acknowledged' });
      const next = await f.act('focus', 'now-allowed');
      assert.equal(next.outcome, 'dispatched');
    } finally { f.close(); }
  }

  // A window may need activation first. If another window still covers the point,
  // no pointer input is sent and the prior activation is conservatively unknown.
  {
    const f = fixture();
    try {
      f.state.hit = false;
      const result = await f.act('drag', 'covered', { x: 10, y: 20, toX: 20, toY: 25 });
      assert.equal(result.outcome, 'unknown');
      assert.equal(f.state.unknowns.length, 1, 'unknown input must synchronously freeze via the host callback');
      assert.equal(f.state.activations, 1); assert.equal(f.state.sent.length, 0); assert.equal(f.state.moves.length, 0);
    } finally { f.close(); }
  }

  // Request arrays are snapshotted before the asynchronous durable dispatch.
  {
    const f = fixture();
    try {
      const keys = [0x11, 0x43];
      const pending = f.act('key', 'immutable-keys', { keys });
      keys[0] = 0x12; keys.push(0x41);
      const result = await pending;
      assert.equal(result.outcome, 'dispatched');
      assert.deepEqual(f.state.sent.map(event => event.vk), [0x11, 0x43, 0x43, 0x11]);
      await f.acknowledge(result);
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.slot.isPointOnTarget = async () => false;
      const result = await f.act('drag', 'async-hit-proof', { x: 10, y: 20, toX: 20, toY: 25 });
      assert.equal(result.outcome, 'unknown');
      assert.equal(f.state.sent.length, 0); assert.equal(f.state.moves.length, 0);
    } finally { f.close(); }
  }

  // The host must synchronously freeze globally; a failed/asynchronous callback is itself an error.
  for (const handler of [() => { throw new Error('freeze failed'); }, async () => {}]) {
    const f = fixture();
    try {
      f.slot.onUnknown = handler; f.state.hit = false;
      await assert.rejects(f.act('drag', 'bad-freeze', { x: 10, y: 20, toX: 20, toY: 25 }), Win32VisibleUnknownError);
      assert.equal(f.state.sent.length, 0);
    } finally { f.close(); }
  }

  // A host callback can synchronously start global stop without awaiting its own seat.
  {
    const f = fixture(); let stopping;
    const activity = new DesktopActivityRuntime({
      labels: { active: 'active', stopping: 'stopping', unknown: 'unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'unavailable' },
      createIndicator: () => ({ async show() {}, close() {} }), releaseAll: () => f.tracked.releaseAll()
    });
    try {
      activity.turns.noteUserInstruction(f.actor.sessionId, 'instruction');
      activity.turns.begin(f.actor.sessionId, 'turn', f.actor.isCurrent, true, 'instruction');
      f.state.hit = false;
      const running = activity.turns.use(f.actor.sessionId, 'turn', 'fixture', (signal, lease) => {
        const epoch = activity.visibilityEpoch();
        return f.control.act(f.actor, { action: 'drag', windowId: f.windowId, x: 10, y: 20, toX: 20, toY: 25 }, 'unknown-stop', {
          ...f.slot, lease, indicatorEpoch: epoch, isIndicatorCurrent: value => activity.visibilityEpoch() === value,
          onUnknown() { stopping = activity.stop(); }
        }, signal);
      });
      await assert.rejects(running);
      assert.ok(stopping); await stopping;
      assert.equal(f.state.sent.length, 0);
      activity.turns.begin('other-session', 'turn', () => true);
      await assert.rejects(activity.turns.use('other-session', 'turn', 'fixture', async () => 'not run'), /new user instruction/i);
    } finally { await activity.dispose(); f.close(); }
  }

  // Dispatch and delivery are separate; same ID never redispatches and a new ID blocks until host acknowledgement.
  {
    const f = fixture();
    try {
      const operation = new AbortController();
      const first = await f.act('drag', 'one', { x: 10, y: 20, toX: 20, toY: 25, button: 'left' }, operation.signal);
      assert.equal(first.outcome, 'dispatched'); assert.equal(first.value.effect, 'unverifiable');
      assert.deepEqual(f.state.moves, [{ x: 220, y: 440 }, { x: 240, y: 450 }]);
      assert.deepEqual(f.state.sent.map(event => event.flags), [2, 4]);
      const again = await f.act('drag', 'one', { x: 10, y: 20, toX: 20, toY: 25, button: 'left' });
      assert.equal(again.invocationId, first.invocationId); assert.equal(f.state.sent.length, 2);
      await assert.rejects(f.act('drag', 'one', { x: 11, y: 20, toX: 20, toY: 25 }), /different operation/);
      await assert.rejects(f.act('drag', 'two', { x: 10, y: 20, toX: 20, toY: 25 }), PreDispatchFailure);
      assert.equal(f.state.sent.length, 2, 'undelivered result blocks a fresh request');
      assert.ok(!JSON.stringify(first).includes('deliveryToken'));
      operation.abort();
      await f.acknowledge(first); // A finished seat signal is not the run-level delivery lease.
      const second = await f.act('drag', 'two', { x: 10, y: 20, toX: 20, toY: 25 });
      assert.equal(second.outcome, 'dispatched'); assert.equal(f.state.sent.length, 4);
      await f.acknowledge(second);
    } finally { f.close(); }
  }

  // Actual activity stop aborts the seat while held input is still released.
  {
    const f = fixture(); let stopping, visible = false;
    const activity = new DesktopActivityRuntime({
      labels: { active: 'active', stopping: 'stopping', unknown: 'unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'unavailable' },
      createIndicator: () => ({ async show() { visible = true; }, close() { visible = false; } }),
      releaseAll: () => f.tracked.releaseAll()
    });
    try {
      activity.turns.noteUserInstruction(f.actor.sessionId, 'instruction');
      activity.turns.begin(f.actor.sessionId, 'turn', f.actor.isCurrent, true, 'instruction');
      f.state.sendHook = event => { if (event.kind === 'key' && !((event.flags ?? 0) & 2)) stopping = activity.stop(); };
      const operation = activity.turns.use(f.actor.sessionId, 'turn', 'fixture', (signal, lease) => {
        const epoch = activity.visibilityEpoch();
        assert.equal(visible, true); assert.notEqual(epoch, undefined);
        return f.control.act(f.actor, { action: 'type', windowId: f.windowId, text: 'AB' }, 'actual-stop', {
          ...f.slot, lease, indicatorEpoch: epoch, isIndicatorCurrent: value => activity.visibilityEpoch() === value
        }, signal);
      });
      await assert.rejects(operation);
      assert.ok(stopping); await stopping;
      assert.deepEqual(f.state.sent.map(event => event.flags), [4, 6]);
      f.state.sendHook = undefined;
      const retry = await f.act('type', 'actual-stop', { text: 'AB' });
      assert.equal(retry.outcome, 'unknown'); assert.equal(f.state.sent.length, 2);
    } finally { await activity.dispose(); f.close(); }
  }

  // A failed release is not cleared from the tracker or reported as successful input.
  {
    const f = fixture();
    try {
      f.state.sendHook = event => { if (event.kind === 'key' && ((event.flags ?? 0) & 2)) throw new Error('release failed'); };
      const result = await f.act('type', 'failed-release', { text: 'A' });
      assert.equal(result.outcome, 'unknown');
      await assert.rejects(f.control.releaseAll(), /release failed/i);
      f.state.sendHook = undefined;
      await f.control.releaseAll();
      assert.ok(f.state.sent.filter(event => event.kind === 'key' && ((event.flags ?? 0) & 2)).length >= 2);
    } finally { f.close(); }
  }

  // Remaining native Windows input and horizontal scrolling.
  {
    const f = fixture();
    try {
      const cases = [
        ['move', { x: 2, y: 3 }], ['hover', { x: 2, y: 3 }],
        ['drag', { x: 2, y: 3, toX: 20, toY: 30, button: 'right' }],
        ['scroll', { x: 2, y: 3, delta: 120 }], ['scroll', { x: 2, y: 3, delta: -120, axis: 'horizontal' }],
        ['type', { text: '中A' }], ['key', { keys: [0x11, 0x43] }], ['focus', {}]
      ];
      for (let i = 0; i < cases.length; i++) {
        const [action, args] = cases[i], before = f.state.sent.length;
        const result = await f.act(action, `case-${i}`, args);
        assert.equal(result.outcome, 'dispatched');
        const events = f.state.sent.slice(before);
        if (action === 'drag') assert.deepEqual(events.map(event => event.flags), [8, 16]);
        if (action === 'scroll' && args.axis === 'horizontal') assert.deepEqual(events, [{ kind: 'mouse', flags: 0x1000, data: -120 }]);
        if (action === 'type') assert.deepEqual(events.map(event => event.scan), [20013, 20013, 65, 65]);
        await f.acknowledge(result);
      }
      await assert.rejects(f.act('move', 'outside', { x: 301, y: 2 }), PreDispatchFailure);
      await assert.rejects(f.act('drag', 'outside-drag', { x: 2, y: 3, toX: 300, toY: 3 }), PreDispatchFailure);
      await assert.rejects(f.act('type', 'bad-type', { text: '' }), PreDispatchFailure);
    } finally { f.close(); }
  }

  // Stop after a press: release is still attempted, outcome is unknown, and neither same nor fresh ID replays it.
  {
    const f = fixture();
    try {
      const operation = new AbortController();
      f.state.sendHook = event => { if (event.kind === 'key' && !((event.flags ?? 0) & 2)) operation.abort(); };
      const first = await f.act('type', 'interrupted', { text: 'A' }, operation.signal);
      assert.equal(first.outcome, 'unknown');
      assert.deepEqual(f.state.sent.map(event => event.flags), [4, 6]);
      const count = f.state.sent.length;
      const repeated = await f.act('type', 'interrupted', { text: 'A' });
      assert.equal(repeated.outcome, 'unknown'); assert.equal(f.state.sent.length, count);
      await assert.rejects(f.act('type', 'next', { text: 'B' }), PreDispatchFailure);
      assert.equal(f.state.sent.length, count);
    } finally { f.close(); }
  }

  // Loss of target or foreground after key-down must still release, then report unknown.
  for (const lost of ['target', 'foreground']) {
    const f = fixture();
    try {
      f.state.sendHook = event => { if (event.kind === 'key' && !((event.flags ?? 0) & 2)) {
        if (lost === 'target') f.state.valid = false; else f.state.foreground = 0x200n;
      } };
      const result = await f.act('type', `lost-${lost}`, { text: 'AB' });
      assert.equal(result.outcome, 'unknown');
      assert.deepEqual(f.state.sent.map(event => event.flags), [4, 6]);
    } finally { f.close(); }
  }

  // Failed delivery staging cannot expose success or unblock another write.
  {
    const f = fixture();
    try {
      f.slot.stageDelivery = () => { throw new Error('private delivery slot unavailable'); };
      const result = await f.act('focus', 'delivery-failure');
      assert.equal(result.outcome, 'unknown'); assert.equal(result.reason, 'delivery-unavailable');
      await assert.rejects(f.act('focus', 'blocked-next'), PreDispatchFailure);
    } finally { f.close(); }
  }

  // Launch uses the same private delivery barrier; the final native pre-spawn signal rechecks validity.
  {
    const f = fixture();
    try {
      const app = 'C:\\Program Files\\Example\\app.exe';
      const result = await f.control.launch(f.actor, app, 'launch-one', f.slot);
      assert.equal(result.outcome, 'dispatched'); assert.equal(result.value.pid, 42); assert.equal(f.state.launchCalls, 1);
      const repeated = await f.control.launch(f.actor, app, 'launch-one', f.slot);
      assert.equal(repeated.invocationId, result.invocationId); assert.equal(f.state.launchCalls, 1);
      await assert.rejects(f.control.launch(f.actor, app, 'launch-two', f.slot), PreDispatchFailure);
      await f.acknowledge(result);
      f.state.launchHook = async () => { f.state.targetCurrent = false; };
      const interrupted = await f.control.launch(f.actor, app, 'launch-two', f.slot);
      assert.equal(interrupted.outcome, 'unknown'); assert.equal(f.state.launchCalls, 1);
    } finally { f.close(); }
  }

  // Optional explicit Windows integration: only an owned Electron fixture is controlled.
  if (process.env.DESKTOP_TEST_ELECTRON) {
    assert.equal(process.platform, 'win32');
    const executable = process.env.DESKTOP_TEST_ELECTRON;
    assert.ok(path.isAbsolute(executable) && fs.existsSync(executable));
    const url = name => pathToFileURL(compile(`main/desktop/${name}.ts`)).href;
    const modules = Object.fromEntries(['win32VisibleControl', 'win32ControlRuntime', 'win32Targets', 'trackedWin32Input', 'win32Input',
      'win32Applications', 'win32Inventory', 'win32WindowGeneration', 'desktopActivityRuntime', 'visibleActionFactory',
      'visibleActionDispatcher', 'actionIdempotency'].map(name => [name, url(name)]));
    const fixtureFile = path.join(temp, 'native-fixture.cjs'), fixtureData = path.join(temp, 'native-data');
    const html = `<!doctype html><title>Win32 Visible Fixture</title><input id="field" autofocus style="display:block;margin-top:24px"><div id="wheel" style="margin-top:16px;width:180px;height:40px;background:#ddd" onwheel="this.dataset.x=String(event.deltaX)">Wheel</div>`;
    fs.writeFileSync(fixtureFile, `
const {app, BrowserWindow, screen} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const modules = ${JSON.stringify(modules)}, data = ${JSON.stringify(fixtureData)};
  const {Win32VisibleControl, createWin32PointHitTest} = await import(modules.win32VisibleControl);
  const {Win32ControlRuntime} = await import(modules.win32ControlRuntime);
  const {TrackedWin32Input} = await import(modules.trackedWin32Input);
  const {createWin32Input} = await import(modules.win32Input);
  const {createWin32WindowApi} = await import(modules.win32Applications);
  const {enumerateWin32WindowsPhysical} = await import(modules.win32Inventory);
  const {DesktopActivityRuntime} = await import(modules.desktopActivityRuntime);
  const {createVisibleActionRuntime} = await import(modules.visibleActionFactory);
  const {VisibleActionDispatcher} = await import(modules.visibleActionDispatcher);
  const {DesktopActionIdempotency} = await import(modules.actionIdempotency);
  app.setPath('userData', data);
  await app.whenReady();
  const work = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({x:work.x+30,y:work.y+30,width:450,height:260,title:'Win32 Visible Fixture',show:true,
    webPreferences:{contextIsolation:true,sandbox:true}});
  const indicator = new BrowserWindow({x:work.x+work.width-190,y:work.y+20,width:160,height:55,show:false,focusable:false,
    frame:false,alwaysOnTop:true,webPreferences:{sandbox:true}});
  let runtime, receipts, sourceControl, activity;
  try {
    await win.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(html)}));
    win.setTitle('Win32 Visible Fixture');
    await indicator.loadURL('data:text/html,<p>AI desktop test</p>');
    win.setAlwaysOnTop(true,'screen-saver'); win.show(); win.focus(); await new Promise(resolve => setTimeout(resolve, 300));
    const actor = {sessionId:'native-session',taskId:'native-task',turnId:'turn',isCurrent:()=>!win.isDestroyed()};
    const inventory = () => {
      const result = enumerateWin32WindowsPhysical();
      return {...result,windows:result.windows.map(window => {
        const a = screen.screenToDipPoint({x:window.bounds.x,y:window.bounds.y});
        const b = screen.screenToDipPoint({x:window.bounds.x+window.bounds.width,y:window.bounds.y+window.bounds.height});
        return {...window,bounds:{x:a.x,y:a.y,width:b.x-a.x,height:b.y-a.y}};
      })};
    };
    const noApproval = async () => {throw new Error('Unexpected product approval');};
    sourceControl = new Win32ControlRuntime(data,{confirm:noApproval,confirmWithReceipt:noApproval},
      point=>screen.dipToScreenPoint(point),point=>screen.screenToDipPoint(point));
    const bounds = win.getContentBounds();
    const frame = {sessionId:actor.sessionId,taskId:actor.taskId,captureId:'synthetic-frame',surfaceId:'screen',
      surfaceGeneration:'screen-generation',geometryRevision:'fixture-geometry',expiresAt:Date.now()+60000,
      width:bounds.width,height:bounds.height,sourceSize:{width:bounds.width,height:bounds.height},
      region:{x:0,y:0,width:bounds.width,height:bounds.height},bounds,isCurrent:()=>!win.isDestroyed()};
    let offset=0, windowId;
    do { const page=sourceControl.register(actor,frame,{bounds},()=>!win.isDestroyed(),offset); windowId=page.windows.find(item=>item.title==='Win32 Visible Fixture')?.windowId; offset=page.nextOffset; }
    while (!windowId && offset!==null);
    if (!windowId) throw new Error('Fixture target not found');
    const tracked = new TrackedWin32Input(createWin32Input());
    activity = new DesktopActivityRuntime({labels:{active:'Active',stopping:'Stopping',unknown:'Unknown',escape:'Esc',stop:'Stop',escapeUnavailable:'Stop'},
      releaseAll:()=>tracked.releaseAll(),createIndicator:()=>({async show(){indicator.showInactive();if(!indicator.isVisible())throw new Error('indicator hidden');},close(){indicator.hide();}})});
    runtime = createVisibleActionRuntime(path.join(data,'outbox.sqlite'),path.join(data,'locks'));
    receipts = new DesktopActionIdempotency(path.join(data,'receipts'));
    const dispatcher = new VisibleActionDispatcher(receipts,runtime.coordinator);
    const control = new Win32VisibleControl({dispatcher,input:tracked,windowApi:createWin32WindowApi(),
      resolveTarget:(owner,id)=>sourceControl.visibleTarget(owner,id),dipToPhysical:p=>screen.dipToScreenPoint(p)});
    const hit = createWin32PointHitTest();
    const secondHit = createWin32PointHitTest();
    if(typeof secondHit !== 'function')throw new Error('Second point hit tester unavailable');
    const koffi = require('koffi'), user = koffi.load('user32.dll');
    const debugPoint = koffi.struct('MetaAgentFixtureDebugPoint',{x:'int32',y:'int32'});
    const debugDpi = user.func('__stdcall','SetThreadDpiAwarenessContext','intptr_t',['intptr_t']);
    const debugAt = user.func('__stdcall','WindowFromPoint','intptr_t',[debugPoint]);
    const debugPacked = user.func('__stdcall','WindowFromPoint','intptr_t',['int64']);
    const debugRoot = user.func('__stdcall','GetAncestor','intptr_t',['intptr_t','uint32']);
    const debugForeground = user.func('__stdcall','GetForegroundWindow','intptr_t',[]);
    const checkedHit=(handle,generation,point)=>{
      const matched=hit(handle,generation,point);
      if(!matched){const old=debugDpi(-4);const under=BigInt(debugAt(point)??0);const root=under?BigInt(debugRoot(under,2)??0):0n;
        const packed=BigInt.asIntN(64,(BigInt(point.y>>>0)<<32n)|BigInt(point.x>>>0));const packedUnder=BigInt(debugPacked(packed)??0);debugDpi(old);
        const rootBounds=inventory().windows.find(w=>BigInt(w.nativeHandle)===root)?.bounds;
        console.error('HIT_DIAGNOSTIC '+JSON.stringify({expected:handle.toString(16),under:under.toString(16),root:root.toString(16),packedUnder:packedUnder.toString(16),foreground:BigInt(debugForeground()??0).toString(16),rootBounds,focused:win.isFocused(),point,bounds:win.getBounds(),content:win.getContentBounds(),display:screen.getPrimaryDisplay().scaleFactor}));}
      return matched;
    };
    activity.turns.noteUserInstruction(actor.sessionId,'native-user-message');
    activity.turns.begin(actor.sessionId,'turn',actor.isCurrent,true,'native-user-message');
    const rectFor = id => win.webContents.executeJavaScript('(() => {const r=document.getElementById('+JSON.stringify(id)+').getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()');
    async function run(action,id,args={}) {
      let acknowledge;
      const result = await activity.turns.use(actor.sessionId,'turn','Owned fixture',(signal,lease)=>{
        const epoch=activity.visibilityEpoch();
        if(epoch===undefined || !indicator.isVisible()) throw new Error('Visible indicator missing');
        return control.act(actor,{action,windowId,...args},id,{lease,indicatorEpoch:epoch,
          isIndicatorCurrent:value=>activity.visibilityEpoch()===value,
          isTargetCurrent:()=>sourceControl.visibleTarget(actor,windowId).isCurrent(),
          isPointOnTarget:checkedHit,onUnknown(){void activity.stop().catch(error=>console.error(error));},
          stageDelivery(_id,_value,ack){acknowledge=ack;}},signal);
      });
      if(result.outcome!=='dispatched'||!acknowledge)throw new Error('Fixture dispatch failed: '+JSON.stringify(result));
      if((await acknowledge('delivered-'+id)).outcome!=='acknowledged')throw new Error('Fixture delivery failed');
      return result;
    }
    const wheel=await rectFor('wheel');
    await run('focus','focus-window');
    await run('type','type-field',{text:'Hello中'});
    await run('scroll','horizontal-wheel',{...wheel,delta:120,axis:'horizontal'});
    const childScript=path.join(data,'owned-child.cjs'), marker=path.join(data,'owned-child-started');
    fs.writeFileSync(childScript,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"started");setTimeout(()=>process.exit(0),1500)');
    const previousNodeOptions=process.env.NODE_OPTIONS;
    let launchedPid;
    try {
      process.env.NODE_OPTIONS='--require "'+childScript.split(path.sep).join('/')+'"';
      const preloadProbe=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},['-e','process.exit(0)'],{encoding:'utf8',env:process.env});
      if(preloadProbe.status!==0||!fs.existsSync(marker))throw new Error('Owned child preload fixture failed: '+preloadProbe.stderr);
      fs.unlinkSync(marker);
      let acknowledge;
      const launch = await activity.turns.use(actor.sessionId,'turn','Owned fixture',(signal,lease)=>{
        const epoch=activity.visibilityEpoch();
        return control.launch(actor,${JSON.stringify(process.execPath)},'launch-owned-child',{lease,indicatorEpoch:epoch,
          isIndicatorCurrent:value=>activity.visibilityEpoch()===value,isTargetCurrent:()=>!win.isDestroyed(),
          onUnknown(){void activity.stop().catch(error=>console.error(error));},stageDelivery(_id,_value,ack){acknowledge=ack;}},signal);
      });
      if(launch.outcome!=='dispatched'||!launch.value.pid||!acknowledge)throw new Error('Owned fixture launch failed: '+JSON.stringify(launch));
      launchedPid=launch.value.pid;
      if((await acknowledge('delivered-launch')).outcome!=='acknowledged')throw new Error('Launch delivery failed');
      for(let i=0;i<80&&!fs.existsSync(marker);i++)await new Promise(resolve=>setTimeout(resolve,50));
      if(!fs.existsSync(marker)||fs.readFileSync(marker,'utf8')!=='started')throw new Error('Owned process did not produce its marker');
      let exited=false;
      for(let i=0;i<80;i++){
        try{process.kill(launchedPid,0);}catch(error){if(error.code==='ESRCH'){exited=true;break;}throw error;}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!exited)throw new Error('Owned process did not exit after its timer');
    } finally {
      if(previousNodeOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previousNodeOptions;
    }
    await new Promise(resolve=>setTimeout(resolve,300));
    const readback=await win.webContents.executeJavaScript('({value:document.getElementById("field").value,wheel:Number(document.getElementById("wheel").dataset.x)})');
    if(readback.value!=='Hello中'||!Number.isFinite(readback.wheel)||readback.wheel===0)throw new Error('Fixture readback: '+JSON.stringify(readback));
    console.log('WIN32_VISIBLE_FIXTURE_OK '+JSON.stringify({...readback,indicator:true,launch:true}));
  } finally {
    await activity?.dispose(); receipts?.close(); runtime?.close(); sourceControl?.close();
    if(!indicator.isDestroyed())indicator.destroy(); if(!win.isDestroyed())win.destroy();
  }
})().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(executable, [fixtureFile], { encoding: 'utf8', timeout: 45000, env });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /WIN32_VISIBLE_FIXTURE_OK/);
    console.log(result.stdout.trim());
  }
  console.log('Windows visible control: target proofs, delivery barrier, idempotency, cancellation and input paths passed');
} finally { removeWorkspaceFixture(temp, 'win32-visible-control-'); }
