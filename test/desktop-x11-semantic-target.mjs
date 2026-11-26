import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-x11-semantic-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createX11PropertyApi, X11WindowGeneration, x11WindowId } = await import(pathToFileURL(compile('main/desktop/x11WindowGeneration.ts')));
  const { resolveX11SemanticTarget } = await import(pathToFileURL(compile('main/desktop/x11SemanticTarget.ts')));
  const { resolveMacSemanticTarget } = await import(pathToFileURL(compile('main/desktop/macSemanticTarget.ts')));
  const { CuaSemanticRuntime } = await import(pathToFileURL(compile('main/desktop/cuaSemanticRuntime.ts')));

  const baseEnv = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XAUTHORITY: '/tmp/xauth', LC_ALL: 'other', XPROPFORMATS: '/tmp/untrusted' };
  const store = new Map(), calls = [];
  let failure = null, badRead = false, duringRead = null;
  const run = (file, args, options) => {
    calls.push({ file, args: [...args], options });
    if (failure) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error(failure), { code: failure }) };
    const id = args[1];
    const operation = args.includes('-set') ? 'set' : args.includes('-remove') ? 'remove' : 'read';
    const index = args.indexOf(operation === 'set' ? '-set' : operation === 'remove' ? '-remove' : '-f');
    const name = args[index + 1], key = `${id}/${name}`;
    if (operation === 'set') store.set(key, args[index + 2]);
    else if (operation === 'remove') store.delete(key);
    else {
      duringRead?.();
      if (badRead) return { status: 0, stdout: `${name} = "bad"\n`, stderr: '' };
      const value = store.get(key);
      return { status: 0, stdout: value ? `${name} = "${value}"\n` : `${name}:  not found.\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const env = { ...baseEnv };
  const nativeX11 = () => true; // Simulated host proof; environment variables alone are insufficient.
  const api = createX11PropertyApi({ platform: 'linux', env, run, timeoutMs: 300, verifyNativeX11: nativeX11 });
  const generations = new X11WindowGeneration(api);
  assert.equal(x11WindowId('0x0000002A'), '0x2a');
  for (const invalid of ['42', '0x0', '0x100000000', '0x2a; touch file', '-root']) assert.throws(() => x11WindowId(invalid), /Invalid/);
  for (const unsupported of [
    { platform: 'darwin', env }, { platform: 'win32', env },
    { platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } },
    { platform: 'linux', env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } },
    { platform: 'linux', env: { DISPLAY: ':0' } },
    { platform: 'linux', env: { XDG_SESSION_TYPE: 'tty', DISPLAY: ':0' } },
    { platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' } }
  ]) assert.throws(() => createX11PropertyApi({ ...unsupported, run }), /X11|Wayland/);
  assert.throws(() => createX11PropertyApi({ platform: 'linux', env, executable: 'xprop', run }), /absolute/);
  assert.throws(() => createX11PropertyApi({ platform: 'linux', env, timeoutMs: 0, run }), /timeout/);
  assert.throws(() => createX11PropertyApi({ platform: 'linux', env, run }), /native X11 display proof/);
  assert.throws(() => createX11PropertyApi({ platform: 'linux', env, run, verifyNativeX11: () => false }), /Native X11 display proof/);
  assert.throws(() => resolveMacSemanticTarget(), /macOS.*unavailable/);

  const first = generations.observe('0x0000002a');
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(generations.observe('0x2a'), first, 'one registry shares a generation across actors');
  assert.equal(generations.current('0x2a', first), true);
  assert.equal(calls[0].file, '/usr/bin/xprop');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 300);
  assert.equal(calls[0].options.env.LC_ALL, 'C');
  assert.equal(calls[0].options.env.XPROPFORMATS, undefined);
  assert.deepEqual(calls[0].args.slice(0, 2), ['-id', '0x2a']);
  const property = calls[0].args[calls[0].args.indexOf('-set') + 1];
  const key = `0x2a/${property}`;
  assert.equal(store.get(key), first);
  assert.throws(() => api.write('0x2a', property, 'a;evil'), /generation/);
  assert.throws(() => api.read('0x2a', 'INVALID'), /property/);

  const actor = { sessionId: 'session', taskId: 'task', turnId: 'turn', isCurrent: () => true };
  let ownerLive = true, captureLive = true, selectionLive = true;
  const selection = {
    window: { nativeHandle: '0x2a', pid: 123 }, generation: first,
    owner: { nativeHandle: '0x2a', pid: 123, processStart: '123456', source: 'xres-local', isCurrent: () => ownerLive },
    capture: { nativeHandle: '0x2a', generation: first, markerEstablishedBeforeCapture: true, isCurrent: () => captureLive },
    isCurrent: () => selectionLive
  };
  const targets = { resolve(sessionId, taskId, id) {
    if (sessionId !== 'session' || taskId !== 'task' || id !== 'opaque-selection') throw new Error('selection unavailable');
    return selection;
  } };
  const options = { platform: 'linux', env };
  const resolve = (selected = targets, currentActor = actor, id = 'opaque-selection', opts = options) =>
    resolveX11SemanticTarget(selected, generations, currentActor, id, opts);
  const proof = resolve();
  assert.deepEqual({ pid: proof.pid, windowId: proof.windowId, generation: proof.generation }, { pid: 123, windowId: 42, generation: first });
  assert.equal(Object.isFrozen(proof), true);
  assert.throws(() => resolve(targets, { ...actor, sessionId: 'other' }), /unavailable/);
  assert.throws(() => resolve(targets, actor, '0x2a'), /unavailable/, 'native XIDs are not host selections');
  assert.throws(() => resolve(targets, actor, 'opaque-selection', { platform: 'linux', env: { ...env, XDG_SESSION_TYPE: 'wayland' } }), /Wayland/);
  assert.throws(() => resolve(targets, actor, 'opaque-selection', { platform: 'linux', env: { ...env, DISPLAY: ':1' } }), /changed/,
    'a marker on one X server cannot authorize a driver in another session');
  assert.throws(() => resolve(targets, actor, 'opaque-selection', { platform: 'linux', env: { ...env, DBUS_SESSION_BUS_ADDRESS: 'other' } }), /changed/,
    'the semantic driver must use the same accessibility session');
  const changed = patch => ({ resolve: () => ({ ...selection, ...patch }) });
  assert.throws(() => resolve(changed({ owner: { ...selection.owner, source: 'ewmh' } })), /unverified/);
  assert.throws(() => resolve(changed({ owner: { ...selection.owner, processStart: '' } })), /unverified/);
  assert.throws(() => resolve(changed({ owner: { ...selection.owner, pid: 999 } })), /unverified/);
  assert.throws(() => resolve(changed({ capture: { ...selection.capture, markerEstablishedBeforeCapture: false } })), /unverified/);
  assert.throws(() => resolve(changed({ capture: { ...selection.capture, generation: 'f'.repeat(48) } })), /unverified/);
  assert.throws(() => resolve(changed({ capture: { ...selection.capture, nativeHandle: '0x2b' } })), /unverified/);
  assert.throws(() => resolve({ resolve: () => ({ window: selection.window, generation: first, isCurrent: () => true }) }), /proofs/,
    'an inventory row and a marker cannot substitute for trusted owner and capture evidence');

  const latched = resolve();
  ownerLive = false; assert.equal(latched.isCurrent(), false);
  ownerLive = true; assert.equal(latched.isCurrent(), false, 'a failed proof must not revive');
  const callbackPinned = resolve();
  const oldOwnerCallback = selection.owner.isCurrent;
  selection.owner.isCurrent = () => true; ownerLive = false;
  assert.equal(callbackPinned.isCurrent(), false, 'later replacement of a proof callback is not trusted');
  selection.owner.isCurrent = oldOwnerCallback; ownerLive = true;
  const captureProof = resolve(); captureLive = false; assert.equal(captureProof.isCurrent(), false); captureLive = true;
  const selectionProof = resolve(); selectionLive = false; assert.equal(selectionProof.isCurrent(), false); selectionLive = true;

  let persisted = 0, driverCalls = 0, closed = 0;
  const driver = {
    async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
    async call(name, args) {
      driverCalls++;
      assert.equal(name, 'get_window_state');
      assert.deepEqual({ pid: args.pid, windowId: args.window_id }, { pid: 123, windowId: 42 });
      return { structuredContent: { pid: args.pid, window_id: args.window_id, snapshot_id: 's00000001', elements_complete: true,
        elements: [{ element_token: 's00000001:0', role: 'Button', label: 'Run', actions: ['invoke'] }] } };
    },
    async close() { closed++; }
  };
  const runtime = new CuaSemanticRuntime({ platform: 'linux', resolveTarget: (current, id) => resolve(targets, current, id),
    createConnection: () => driver, runPersistedAction: async (_request, dispatch) => { persisted++; return { outcome: 'dispatched', value: await dispatch() }; } });
  const page = await runtime.observe(actor, 'opaque-selection');
  assert.equal(driverCalls, 1);
  // Simulate XID reuse by the same process with unchanged title and geometry.
  store.delete(key);
  const second = generations.observe('0x2a');
  assert.notEqual(second, first);
  assert.equal(proof.isCurrent(), false);
  await assert.rejects(runtime.act(actor, { snapshotId: page.snapshotId, ref: page.elements[0].ref, requestId: 'a', action: 'click' }), /current|stale|changed/i);
  assert.equal(persisted, 0, 'a stale XID must not reach the persisted action gate');
  assert.equal(driverCalls, 1, 'no action reaches the semantic driver');
  await runtime.close(); assert.ok(closed >= 1);

  // A server/property error permanently invalidates old proofs, including after recovery.
  failure = 'ETIMEDOUT'; assert.equal(generations.current('0x2a', second), false); failure = null;
  assert.equal(generations.current('0x2a', second), false);
  const third = generations.observe('0x2a'); assert.notEqual(third, second);
  badRead = true; assert.equal(generations.current('0x2a', third), false); badRead = false;
  assert.equal(generations.current('0x2a', third), false);
  const fourth = generations.observe('0x2a');
  duringRead = () => { duringRead = null; store.delete(key); };
  assert.equal(generations.current('0x2a', fourth), false, 'replacement during a live check is rejected');
  const fifth = generations.observe('0x2a');
  env.DISPLAY = ':1'; assert.equal(generations.current('0x2a', fifth), false);
  env.DISPLAY = ':0'; assert.equal(generations.current('0x2a', fifth), false, 'display changes cannot revive a proof');
  assert.throws(() => generations.observe('0x2a'), /display identity/);
  assert.throws(() => generations.close(), /Could not remove/, 'cleanup failure after a display change is explicit');

  let uncertainValue, removed = false;
  const uncertain = new X11WindowGeneration({
    sameSession() { return true; },
    write(_id, _property, value) { uncertainValue = value; throw new Error('write timed out after dispatch'); },
    read() { return uncertainValue ?? null; },
    remove() { removed = true; uncertainValue = undefined; }
  });
  assert.throws(() => uncertain.observe('0x2a'), /timed out/);
  assert.equal(typeof uncertainValue, 'string');
  uncertain.close();
  assert.equal(removed, true, 'a write with uncertain outcome remains eligible for cleanup');

  let failCleanup = true, cleanupValue;
  const retryCleanup = new X11WindowGeneration({
    sameSession() { return true; },
    write(_id, _property, value) { cleanupValue = value; },
    read() { if (failCleanup) throw new Error('offline'); return cleanupValue ?? null; },
    remove() { cleanupValue = undefined; }
  });
  assert.throws(() => retryCleanup.observe('0x2b'), /offline/);
  assert.throws(() => retryCleanup.close(), /Could not remove/);
  failCleanup = false; retryCleanup.close();
  assert.equal(cleanupValue, undefined, 'failed cleanup can be retried without reviving a proof');

  let verifiedNative = true;
  const nativeProbe = new X11WindowGeneration(createX11PropertyApi({ platform: 'linux', env: { ...baseEnv }, run,
    verifyNativeX11: () => verifiedNative }));
  const probeGeneration = nativeProbe.observe('0x2c');
  verifiedNative = false;
  assert.equal(nativeProbe.current('0x2c', probeGeneration), false, 'loss of native X11 proof invalidates the marker');
  verifiedNative = true;
  assert.equal(nativeProbe.current('0x2c', probeGeneration), false, 'a lost native X11 proof cannot revive');
  assert.throws(() => nativeProbe.close(), /Could not remove/);

  const missing = createX11PropertyApi({ platform: 'linux', env: { ...baseEnv }, verifyNativeX11: nativeX11,
    run: () => ({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }) });
  assert.throws(() => missing.read('0x2a', property), /install x11-utils/);
  console.log('desktop X11 semantic target: simulated platform, proof, lifecycle and stale-dispatch checks passed');
} finally { removeWorkspaceFixture(temp, 'desktop-x11-semantic-'); }
