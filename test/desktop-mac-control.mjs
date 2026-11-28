import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-mac-control-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = name => import(pathToFileURL(compile(`main/desktop/${name}.ts`)));
  const { MacTargetRegistry, macCapturePoint } = await load('macTargetRegistry');
  const { MacVisibleControl } = await load('macVisibleControl');
  const { createIdempotentDesktopComposition } = await load('idempotentDesktopComposition');
  const composition = createIdempotentDesktopComposition(path.join(temp, 'receipts'));
  const display = { displayId: 1, taskId: 'task', surfaceId: 'display', surfaceGeneration: 'generation', geometryRevision: 'geometry',
    bounds: { x: -400, y: 0, width: 400, height: 200 }, scaleFactor: 2 };
  const window = { windowId: 19, pid: 23, layer: 0, alpha: 1, onScreen: true, title: 'Fixture', ownerName: 'Example',
    bounds: { x: -360, y: 20, width: 250, height: 100 } };
  let instance = 1, accessible = true, covered = false, overlayAllowsInput = false, released = 0, currentWindow = window;
  const native = { accessibilityTrusted: () => accessible, screenCaptureTrusted: () => true, retainRunningApplication: () => ({ pid: 23 }),
    applicationTerminated: () => false, sameApplication: (a, b) => a.pid === b.pid, releaseApplication: () => {},
    openAxWindows: () => ({ windows: [{ instance, windowId: 19 }], close: () => {} }), axWindowPid: () => 23,
    axWindowId: value => value.windowId, sameAxWindow: (a, b) => a.instance === b.instance, retainAxWindow: value => value,
    releaseAxWindow: () => { released++; }, isWindowOwnedBy: (pid, id) => pid === 23 && id === 19,
    windowAtPoint: () => overlayAllowsInput ? { pid: 23, windowId: 19 } : undefined };
  const targets = new MacTargetRegistry(native, () => ({ windows: covered ? [{ ...window, pid: 99, windowId: 99 }, currentWindow] : [currentWindow], complete: true }),
    () => currentWindow);
  const lifetime = new AbortController(), actor = { sessionId: 'fixture', taskId: 'task', isCurrent: () => true };
  const lease = { owner: actor.sessionId, turnId: 'turn', signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted };
  const frame = { ...display, captureId: 'capture', width: 300, height: 120, coordinateSpace: 'capture-pixel-v1', expiresAt: Date.now() + 6000,
    sourceSize: { width: 800, height: 400 }, region: { x: 80, y: 40, width: 300, height: 120 } };
  const before = targets.prepare(actor, display, lifetime.signal);
  const windowId = before.register(frame, () => true).windows[0].windowId;
  before.close();
  assert.equal(targets.resolve(actor, windowId).window.windowId, 19);
  assert.throws(() => targets.resolve({ ...actor, taskId: 'other' }, windowId), /stale/);
  assert.throws(() => targets.resolve(actor, '19'), /stale/, 'CG metadata cannot authorize a desktop action');
  assert.deepEqual(macCapturePoint(targets.resolve(actor, windowId), 20, 12), { x: -350, y: 26, coordinateSpace: 'platform-input-v1' });

  const calls = [];
  let driverAccessibility = true, uncertain = false, closeCount = 0, frameMatches = true, relocateOnFocus = false;
  let runningApps = [], observeLaunch = true;
  const driver = () => ({ async connect() {}, async close() { closeCount++; },
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'check_permissions') return { structuredContent: { screen_recording: true, accessibility: driverAccessibility } };
      if (name === 'get_window_state') return { structuredContent: { pid: 23, window_id: 19, screenshot_width: 500,
        screenshot_height: 200, window_bounds: { ...window.bounds, x: frameMatches ? window.bounds.x : 1 }, screenshot_scale: 2,
        screenshot_frame_valid: true } };
      if (name === 'bring_to_front') {
        if (relocateOnFocus) currentWindow = { ...window, bounds: { ...window.bounds, x: -350 } };
        return { structuredContent: { pid: 23, window_id: 19, activated: true, status: 'activated' } };
      }
      if (name === 'launch_app') {
        if (args.bundle_id === 'com.example.Missing') return { isError: true, structuredContent: { error: 'APP_NOT_INSTALLED', bundle_id: args.bundle_id } };
        if (!runningApps.length) runningApps = [{ pid: 42, launchDate: 700, active: false }];
        return { structuredContent: { pid: 42, bundle_id: args.bundle_id, launch_state: { process_running: true } } };
      }
      return { structuredContent: { effect: uncertain ? 'partial' : 'unverifiable' } };
    } });
  try {
    let locked = false, secureInput = false, pauseBeforeDispatch = false;
    const dispatcher = { run(...args) {
      if (pauseBeforeDispatch) secureInput = true;
      return composition.dispatcher.run(...args);
    } };
    const mac = new MacVisibleControl(() => targets, driver, () => 1, dispatcher, () => locked, () => secureInput,
      bundleId => {
        if (!observeLaunch) throw new Error('AppKit observation failed');
        return bundleId === 'com.example.App' ? runningApps : [];
      });
    const run = (request, id) => mac.execute(actor, lease, request, id);
    const drag = { action: 'drag', displayId: 'display', windowId, target: { windowId, x: 20, y: 12, toX: 30, toY: 16 } };
    locked = true;
    assert.equal((await run(drag, 'drag')).code, 'screen_locked');
    assert.deepEqual(calls, []);
    locked = false;
    const dragReceipt = await run(drag, 'drag');
    assert.equal(dragReceipt.outcome, 'dispatched');
    assert.deepEqual(calls.at(-1), ['drag', { pid: 23, window_id: 19, delivery_mode: 'foreground', button: 'left',
      from_x: 20, from_y: 12, to_x: 30, to_y: 16 }]);
    assert.deepEqual(await run(drag, 'drag'), dragReceipt);
    assert.equal(calls.filter(([name]) => name === 'drag').length, 1);
    covered = true;
    await assert.rejects(run(drag, 'covered'), /covered/);
    overlayAllowsInput = true;
    assert.equal((await run(drag, 'covered')).outcome, 'dispatched', 'an exact AX hit can distinguish a click-through overlay');
    overlayAllowsInput = false;
    covered = false;
    frameMatches = false;
    await assert.rejects(run(drag, 'other-frame'), /screenshot/);
    frameMatches = true;
    await assert.rejects(run({ ...drag, displayId: 'other' }, 'wrong-display'), /another display/);
    driverAccessibility = false;
    const missing = await run(drag, 'grant');
    assert.deepEqual(missing.permissions, ['accessibility']);
    assert.equal(missing.source, 'driver');
    secureInput = true;
    const beforeSecureInput = calls.length;
    assert.equal((await run({ action: 'focus', windowId: 'stale' }, 'secure-input')).code, 'secure_input_active');
    assert.equal(calls.length, beforeSecureInput, 'protected input must be reported before querying the driver or stale selection');
    secureInput = false;
    driverAccessibility = true;
    assert.equal((await run(drag, 'grant')).outcome, 'dispatched', 'a permission refusal does not reserve a request ID');
    const focus = await run({ action: 'focus', windowId }, 'focus');
    assert.equal(focus.effect, 'confirmed');
    const key = { ...drag, action: 'key', target: { keys: ['Command', 'KeyA'] } };
    pauseBeforeDispatch = true;
    assert.equal((await run(key, 'key')).code, 'secure_input_active');
    assert.equal(calls.filter(([name]) => name === 'hotkey').length, 0, 'a protected input transition during dispatch preparation must not reach the driver');
    pauseBeforeDispatch = false;
    secureInput = false;
    assert.equal((await run(key, 'key')).outcome, 'dispatched');
    assert.deepEqual(calls.at(-1), ['hotkey', { pid: 23, window_id: 19, delivery_mode: 'foreground', keys: ['cmd', 'a'] }]);
    await assert.rejects(run({ ...key, target: { keys: ['a', 'cmd'] } }, 'wrong-key'), /distinct modifiers/);
    await assert.rejects(run({ ...key, target: { keys: [65] } }, 'integer-key'), /named keys/);
    const scroll = { ...drag, action: 'scroll', target: { windowId, delta: -120 } };
    await assert.rejects(run(scroll, 'scroll'), /target\.x and target\.y.*returned display image/);
    await assert.rejects(run({ ...scroll, target: { ...scroll.target, x: 320, y: 52 } }, 'scroll'), /top-left.*300×120.*cropped/);
    assert.equal((await run({ ...scroll, target: { ...scroll.target, x: 20, y: 12 } }, 'scroll')).outcome, 'dispatched');
    assert.deepEqual(calls.at(-1), ['scroll', { pid: 23, window_id: 19, delivery_mode: 'foreground', direction: 'down', amount: 1, x: 20, y: 12 }]);
    const launch = { action: 'launch', appId: 'com.example.App' };
    const coldLaunch = await run(launch, 'launch');
    assert.equal(coldLaunch.effect, 'confirmed');
    assert.equal(coldLaunch.verification, 'not_performed');
    assert.deepEqual(coldLaunch.launch, { status: 'started', active: false });
    runningApps = [{ ...runningApps[0], active: true }];
    assert.deepEqual((await run(launch, 'warm-launch')).launch, { status: 'already_running', active: true });
    assert.deepEqual(await run(launch, 'launch'), coldLaunch, 'a duplicate request returns the original launch observation');
    assert.equal(calls.filter(([name]) => name === 'launch_app').length, 2);
    observeLaunch = false;
    const unobservedLaunch = await run(launch, 'unobserved-launch');
    assert.equal(unobservedLaunch.effect, 'unverifiable');
    assert.deepEqual(unobservedLaunch.launch, { status: 'unknown', active: null });
    observeLaunch = true;
    assert.equal((await run({ ...launch, appId: 'com.example.Missing' }, 'missing-app')).code, 'app_not_installed');
    await assert.rejects(run({ action: 'launch', appId: '/Applications/Example.app' }, 'wrong-app'), /bundle identifier/);

    uncertain = true;
    const beforeUncertain = calls.filter(([name]) => name === 'drag').length;
    for (let retry = 0; retry < 2; retry++) await assert.rejects(run(drag, 'uncertain'), /outcome is unknown/);
    assert.equal(calls.filter(([name]) => name === 'drag').length, beforeUncertain + 1);
    relocateOnFocus = true;
    assert.equal((await run({ action: 'focus', windowId }, 'focus-relocate')).effect, 'confirmed');
    assert.throws(() => targets.resolve(actor, windowId), /stale/, 'confirmed focus does not revive its former capture geometry');
    currentWindow = window;
    assert.throws(() => targets.resolve(actor, windowId), /stale/, 'a checked obsolete capture cannot revive if the window moves back');
    const freshWindowId = targets.prepare(actor, display, lifetime.signal).register(frame, () => true).windows[0].windowId;
    instance++;
    const beforeStale = calls.length;
    await assert.rejects(run({ ...drag, windowId: freshWindowId }, 'rebuilt'), /stale/);
    assert.equal(calls.length, beforeStale, 'a reused native window number does not dispatch');
    accessible = false;
    assert.equal(targets.prepare(actor, display, lifetime.signal).register(frame, () => true).unavailable, 1);
    lifetime.abort();
    assert.equal(released, 1, 'stopping releases the AX proof');
    assert.ok(closeCount >= 9);
  } finally { targets.close(); await composition.close(); }
  console.log('macOS desktop control: capture and window proofs, foreground Cua parameters, permissions, and durable receipts passed');
} finally { removeWorkspaceFixture(temp, 'desktop-mac-control-'); }
