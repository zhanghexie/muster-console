import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-win32-runtime-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { Win32VisibleRuntime } = await import(pathToFileURL(compile('main/desktop/win32VisibleRuntime.ts')));
  let indicatorClosed = false, inputs = 0, driverPaths = 0, stages = 0, releaseDriver, driverClosing;
  const driverGate = new Promise(resolve => { releaseDriver = resolve; });
  const driverIsClosing = new Promise(resolve => { driverClosing = resolve; });
  const drivers = [];
  const makeDriver = () => {
    const driver = { closeCount: 0, async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
      async call(name, args) {
        if (name === 'get_window_state') return { structuredContent: { pid: 11, window_id: 21, snapshot_id: 's00000001',
          elements_complete: true, elements: [{ element_token: 's00000001:0', role: 'Button', label: 'Fixture', actions: ['invoke'] }] } };
        assert.equal(args.element_token, 's00000001:0');
        return { isError: false, structuredContent: { effect: 'confirmed' } };
      }, async close() { this.closeCount++; if (drivers.indexOf(this) === 1) { driverClosing(); await driverGate; } } };
    drivers.push(driver); return driver;
  };
  const targets = { visibleTarget: () => ({ frame: { surfaceId: 'display' }, isCurrent: () => true }),
    semanticTarget: () => ({ pid: 11, windowId: 21, generation: 'generation', isCurrent: () => true }) };
  const selector = { cua: (_request, context) => ({ ...context, stageDelivery(_id, _value, acknowledge) {
    stages++; assert.equal(typeof acknowledge, 'function');
  } }), win32: () => { throw new Error('unused'); } };
  const dispatcher = { async run(context, _requestId, _fingerprint, dispatch) {
    return { reply: { outcome: 'dispatched', invocationId: randomUUID(), value: await dispatch(context.signal) },
      acknowledge: async () => ({ outcome: 'acknowledged' }) };
  } };
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const system = new Win32VisibleRuntime({ labels, dispatcher, selector, targets: () => targets, dipToPhysical: point => point,
    driverPath: () => { driverPaths++; throw new Error('unused'); }, reportStopError: error => { throw error; },
    createIndicator: () => ({ show: async () => {}, close: () => { indicatorClosed = true; } }),
    createInput: () => { inputs++; return { move() {}, send() {} }; },
    createWindowApi: () => ({ valid: () => 1, minimized: () => 0, restore: () => 1, activate: () => 1, foreground: () => 21 }),
    createPointHitTest: () => () => true, createCuaConnection: makeDriver });
  system.windowsControl();
  assert.equal(inputs, 0, 'window setup must not initialize native input until needed');
  assert.equal(driverPaths, 0);
  const owner = { sessionId: 'session', taskId: 'task', isCurrent: () => true };
  system.activity.turns.begin('session', 'turn', () => true);
  const observe = () => system.activity.turns.use('session', 'turn', 'window',
    (signal, lease) => system.semanticControl().observe(owner, lease, 'display', 'window', signal), false);
  const page = await observe();
  const action = await system.activity.turns.use('session', 'turn', 'window',
    (signal, lease) => system.semanticControl().act(owner, lease, 'display', 'window',
      { snapshotId: page.snapshotId, ref: page.elements[0].ref, requestId: 'request', action: 'click' }, signal));
  assert.equal(action.outcome, 'dispatched');
  assert.equal(stages, 1, 'the real semantic runtime stages its result through the shared host selector');
  assert.equal(drivers[0].closeCount, 1);
  await observe();
  const stopping = system.activity.stop();
  await driverIsClosing;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(indicatorClosed, false, 'the shared indicator stays visible until the Cua helper exits');
  releaseDriver();
  await stopping;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(indicatorClosed, true);
  assert.equal(drivers[1].closeCount, 1);
  await system.dispose();
  assert.throws(() => system.semanticControl(), /closed/);
  assert.equal(inputs, 0);
  {
    let beginCall, closeStarted, releaseClose, shown = false;
    const called = new Promise(resolve => { beginCall = resolve; });
    const closing = new Promise(resolve => { closeStarted = resolve; });
    const closeGate = new Promise(resolve => { releaseClose = resolve; });
    const discovered = new Win32VisibleRuntime({ labels, dispatcher, selector, targets: () => targets, dipToPhysical: point => point,
      driverPath: () => { throw new Error('fixture uses a private connection'); }, reportStopError: error => { throw error; },
      createIndicator: () => ({ async show() { shown = true; }, close() { shown = false; } }),
      createCuaConnection: () => ({ async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
        async call(name) { assert.equal(name, 'list_apps'); beginCall(); return new Promise(() => {}); },
        async close() { closeStarted(); await closeGate; } }) });
    try {
      discovered.activity.turns.begin('discover', 'turn', () => true);
      const pending = discovered.activity.turns.use('discover', 'turn', 'applications', (signal, lease) =>
        discovered.appDiscovery().discover({ sessionId: 'discover', taskId: 'task', turnId: 'turn',
          lifetimeSignal: lease.signal, isCurrent: () => lease.isCurrent() }, {}, signal), false).catch(error => error);
      await called;
      const stopping = discovered.activity.stop();
      await closing; assert.equal(shown, true, 'the indicator stays visible until application discovery is reclaimed');
      releaseClose(); await stopping;
      assert.ok(await pending); assert.equal(shown, false);
      await discovered.dispose();
      assert.throws(() => discovered.appDiscovery(), /closed/);
    } finally { releaseClose(); await discovered.dispose(); }
  }
  {
    const cleanup = [];
    const broken = new Win32VisibleRuntime({ labels, dispatcher, selector, targets: () => targets, dipToPhysical: point => point,
      driverPath: () => { throw new Error('unused'); }, reportStopError() {},
      createIndicator: () => ({ async show() {}, close() {} }), createCuaConnection() {
        return { async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
          async call() { return { structuredContent: { pid: 11, window_id: 21, snapshot_id: 's00000001', elements: [] } }; },
          async close() { cleanup.push('semantic'); throw new Error('semantic stop failed'); } };
      } });
    broken.activity.turns.begin('session', 'turn', () => true);
    await broken.activity.turns.use('session', 'turn', 'window',
      (signal, lease) => broken.semanticControl().observe(owner, lease, 'display', 'window', signal), false);
    const discovery = broken.appDiscovery();
    const originalStop = discovery.stopAll.bind(discovery);
    discovery.stopAll = () => { cleanup.push('discovery'); return originalStop(); };
    await assert.rejects(broken.activity.stop(), /desktop driver cleanup failed/i);
    assert.deepEqual(new Set(cleanup), new Set(['semantic', 'discovery']));
    await assert.rejects(broken.dispose(), /cleanup failed/i);
  }
  console.log('Windows visible runtime: shared seat, semantic action and awaited helper cleanup passed');
} finally { removeWorkspaceFixture(temp, 'desktop-win32-runtime-'); }
