import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-linux-gio-'));
let receipts;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const { LinuxDesktopLauncher, LinuxLaunchError } = await import(pathToFileURL(compile('main/desktop/linuxDesktopLaunch.ts')));
  const { LINUX_GIO_LAUNCH_WORKER_SOURCE } = await import(pathToFileURL(compile('main/desktop/linuxGioLaunchWorker.ts')));
  receipts = new DesktopActionIdempotency(path.join(temp, 'receipts'));
  const controller = () => new AbortController();
  const actor = (overrides = {}) => ({ sessionId: 'session', taskId: 'task', turnId: 'turn',
    lifetimeSignal: controller().signal, isCurrent: () => true, ...overrides });
  const env = () => ({ HOME: '/home/test', XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', PATH: '/usr/bin' });
  const proof = (overrides = {}) => ({ desktopFileId: 'org.example.Test.desktop', filePath: '/usr/share/applications/org.example.Test.desktop',
    sha256: 'a'.repeat(64), isCurrent: () => true, ...overrides });
  const fakeFile = bytes => {
    let position = 0;
    return { realpathSync: p => p, openSync: () => { position = 0; return 1; },
      fstatSync: () => ({ isFile: () => true, size: bytes.length }),
      readSync: (_fd, target, offset, length) => { const count = bytes.copy(target, offset, position, position + length); position += count; return count; },
      closeSync: () => {} };
  };
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const code = expected => error => error instanceof LinuxLaunchError && error.code === expected;
  const createFixture = (overrides = {}) => {
    const state = { created: 0, prepared: 0, launched: 0, closed: 0, stopped: [], seen: [] };
    const options = { platform: 'linux', env: env(), receipts, timeoutMs: 1000, cleanupTimeoutMs: 500,
      resolveReference: (_actor, reference) => { assert.equal(reference, 'opaque-ref'); return proof(); },
      onUnknown: result => { state.stopped.push(result); },
      createWorker: environment => {
        state.created++; state.seen.push(environment);
        return { async prepare(value) { state.prepared++; state.proof = value; },
          async launch() { state.launched++; return true; }, async close() { state.closed++; } };
      }, ...overrides };
    return { state, launcher: new LinuxDesktopLauncher(options), options };
  };

  // A desktop file ID is resolved by GIO, with no shell or arbitrary launch arguments.
  // This exercises the helper protocol with fake GIO; it is not a Linux ABI test.
  {
    const bytes = Buffer.from('[Desktop Entry]\nExec="/opt/Example App/bin" --label="two words"\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const processStub = new EventEmitter();
    processStub.connected = true;
    const messages = [], calls = [];
    processStub.send = (message, callback) => { messages.push(message); callback?.(); };
    processStub.exit = status => { processStub.exitCode = status; };
    const makeLib = library => ({ func(name) {
      if (name === 'g_desktop_app_info_new') return id => { calls.push(['resolve', id]); return { app: true }; };
      if (name === 'g_desktop_app_info_get_filename') return () => '/usr/share/applications/example.desktop';
      if (name === 'g_app_launch_context_new') return () => ({ context: true });
      if (name === 'g_app_launch_context_unsetenv') return (_context, key) => { calls.push(['unset', key]); };
      if (name === 'g_app_info_launch') return (...args) => { calls.push(['launch', ...args]); return 1; };
      if (name === 'g_object_unref') return () => {};
      throw new Error(`unexpected ${library} symbol ${name}`);
    } });
    const fakeKoffi = { load: name => makeLib(name) };
    const fakeFs = fakeFile(bytes);
    vm.runInNewContext(LINUX_GIO_LAUNCH_WORKER_SOURCE, { Buffer, process: processStub, require: name => {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { createHash };
      if (name === '/trusted/koffi') return fakeKoffi;
      throw new Error('unexpected module');
    } });
    processStub.emit('message', { type: 'prepare', desktopId: 'example.desktop', filePath: '/usr/share/applications/example.desktop',
      sha256: digest, koffiPath: '/trusted/koffi' });
    assert.equal(messages[0].type, 'prepared');
    processStub.emit('message', { type: 'launch' });
    assert.equal(messages[1].type, 'result'); assert.equal(messages[1].accepted, true);
    assert.equal(calls[0][1], 'example.desktop');
    const launch = calls.find(call => call[0] === 'launch');
    assert.equal(launch[2], null, 'GIO receives no caller-supplied files or arguments');
    assert.equal(launch[4], null);
    assert.ok(calls.some(call => call[0] === 'unset' && call[1] === 'ELECTRON_RUN_AS_NODE'));
  }
  {
    const makeFake = actualPath => {
      const processStub = new EventEmitter(), messages = [], calls = [];
      processStub.connected = true; processStub.exit = () => {};
      processStub.send = (message, callback) => { messages.push(message); callback?.(); };
      const koffi = { load: () => ({ func(name) {
        if (name === 'g_desktop_app_info_new') return () => ({});
        if (name === 'g_desktop_app_info_get_filename') return () => actualPath;
        if (name === 'g_object_unref') return () => {};
        if (name === 'g_app_info_launch') return () => { calls.push('launch'); return 1; };
        throw new Error('unexpected native call');
      } }) };
      vm.runInNewContext(LINUX_GIO_LAUNCH_WORKER_SOURCE, { Buffer, process: processStub, require: name => {
        if (name === 'node:fs') return fakeFile(Buffer.alloc(0));
        if (name === 'node:path') return path;
        if (name === 'node:crypto') return { createHash };
        return koffi;
      } });
      return { processStub, messages, calls };
    };
    const fake = makeFake('/usr/share/applications/foo/bar.desktop');
    fake.processStub.emit('message', { type: 'prepare', desktopId: 'foo-bar.desktop', filePath: '/usr/share/applications/foo-bar.desktop',
      sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), koffiPath: '/trusted/koffi' });
    assert.equal(fake.messages[0].code, 'TARGET_CHANGED', 'ambiguous ID resolving to a different file must be rejected');
    assert.equal(fake.calls.length, 0);
  }
  {
    let content = Buffer.from('original');
    const fakeFs = { realpathSync: p => p, openSync: () => 1, fstatSync: () => ({ isFile: () => true, size: content.length }),
      readSync: (_fd, target, offset, length) => { if (offset) return 0; return content.copy(target, offset, 0, length); }, closeSync() {} };
    const processStub = new EventEmitter(), messages = []; let launches = 0;
    processStub.connected = true; processStub.exit = () => {};
    processStub.send = (message, callback) => { messages.push(message); callback?.(); };
    const koffi = { load: () => ({ func(name) {
      if (name === 'g_desktop_app_info_new') return () => ({});
      if (name === 'g_desktop_app_info_get_filename') return () => '/usr/share/applications/example.desktop';
      if (name === 'g_object_unref') return () => {};
      if (name === 'g_app_info_launch') return () => { launches++; return 1; };
      throw new Error('unexpected native call');
    } }) };
    vm.runInNewContext(LINUX_GIO_LAUNCH_WORKER_SOURCE, { Buffer, process: processStub, require: name => {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { createHash };
      return koffi;
    } });
    processStub.emit('message', { type: 'prepare', desktopId: 'example.desktop', filePath: '/usr/share/applications/example.desktop',
      sha256: createHash('sha256').update(content).digest('hex'), koffiPath: '/trusted/koffi' });
    assert.equal(messages[0].type, 'prepared');
    content = Buffer.from('changed!');
    processStub.emit('message', { type: 'launch' });
    assert.equal(messages[1].code, 'TARGET_CHANGED');
    assert.equal(launches, 0, 'a changed desktop file must not be launched');
  }

  for (const platform of ['win32', 'darwin']) {
    assert.throws(() => createFixture({ platform }), code('unsupported_platform'));
  }
  for (const value of [{ HOME: '/home/test', XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
    { HOME: '/home/test', XDG_SESSION_TYPE: 'x11' }, { HOME: '/home/test', XDG_SESSION_TYPE: 'wayland' }]) {
    assert.throws(() => createFixture({ env: value }), code('session_unavailable'));
  }
  assert.throws(() => createFixture({ env: { ...env(), XDG_DATA_DIRS: '/usr/share:relative' } }), code('invalid'));
  {
    const f = createFixture({ env: { HOME: '/home/test', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' } });
    assert.equal((await f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'wayland' })).outcome, 'dispatched');
    assert.equal(f.state.launched, 1); await f.launcher.close();
  }
  {
    const f = createFixture();
    const first = await f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'once' });
    assert.deepEqual(first, { outcome: 'dispatched', delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' });
    assert.deepEqual(await f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'once' }), first);
    assert.equal(f.state.created, 1, 'a matching receipt must not create a second worker');
    assert.equal(f.state.prepared, 1); assert.equal(f.state.launched, 1); assert.equal(f.state.closed, 1);
    assert.equal((await f.launcher.launch(actor({ taskId: 'other-task' }), { reference: 'opaque-ref', requestId: 'once' })).outcome, 'dispatched');
    assert.equal(f.state.launched, 2, 'another task has its own request identity');
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'args', args: ['--flag'] }), code('invalid'));
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'bad id' }), code('invalid'));
    await f.launcher.close();
  }
  {
    const f = createFixture({ resolveReference: () => proof({ desktopFileId: '../bad.desktop' }) });
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'bad-ref' }), code('stale_reference'));
    assert.equal(f.state.created, 0); await f.launcher.close();
  }
  {
    let changed = false;
    const f = createFixture({ resolveReference: () => proof({ sha256: (changed ? 'b' : 'a').repeat(64) }) });
    assert.equal((await f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'same-id-changed' })).outcome, 'dispatched');
    changed = true;
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'same-id-changed' }), error =>
      code('receipt_unavailable')(error) && /earlier action.*unknown/.test(error.message));
    assert.equal(f.state.launched, 1); await f.launcher.close();
  }
  {
    const first = createFixture();
    assert.equal((await first.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'different-session-env' })).outcome, 'dispatched');
    await first.launcher.close();
    const second = createFixture({ env: { ...env(), DISPLAY: ':1' } });
    await assert.rejects(second.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'different-session-env' }), code('receipt_unavailable'));
    assert.equal(second.state.launched, 0, 'an old receipt must not be returned as a launch in another graphical environment');
    await second.launcher.close();
  }
  {
    const old = { action: 'launch', appId: 'old-app' };
    await assert.rejects(receipts.run('session', 'task', 'legacy-pending', old, () => true, async mark => {
      mark(); throw new Error('simulated interruption');
    }));
    const f = createFixture();
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'legacy-pending' }), error =>
      code('receipt_unavailable')(error) && /earlier action.*unknown/.test(error.message));
    assert.equal(f.state.created, 0); await f.launcher.close();
  }
  {
    const before = deferred(), entered = deferred(), signal = controller(), state = { launches: 0, closes: 0 };
    const f = createFixture({ createWorker: () => ({ async prepare() { entered.resolve(); await before.promise; },
      async launch() { state.launches++; return true; }, async close() { state.closes++; } }) });
    const request = { reference: 'opaque-ref', requestId: 'cancel-before' };
    const pending = f.launcher.launch(actor(), request, signal.signal); await entered.promise; signal.abort();
    await assert.rejects(pending, code('cancelled')); assert.equal(state.launches, 0); assert.equal(state.closes, 1);
    before.resolve(); await f.launcher.close();
  }
  {
    const after = deferred(), entered = deferred(), signal = controller(), state = { launches: 0, closes: 0 }, stopped = [];
    const f = createFixture({ onUnknown: result => { stopped.push(result); }, createWorker: () => ({ async prepare() {},
      async launch() { state.launches++; entered.resolve(); return after.promise; }, async close() { state.closes++; } }) });
    const request = { reference: 'opaque-ref', requestId: 'cancel-after' };
    const pending = f.launcher.launch(actor(), request, signal.signal); await entered.promise; signal.abort();
    assert.deepEqual(await pending, { outcome: 'unknown', reason: 'cancelled' });
    assert.equal(state.launches, 1); assert.equal(state.closes, 1); assert.equal(stopped.length, 1);
    assert.equal((await f.launcher.launch(actor(), request)).outcome, 'unknown');
    assert.equal(state.launches, 1, 'unknown request must not be launched again');
    after.resolve(true); await f.launcher.close();
  }
  {
    const after = deferred(), entered = deferred(), environment = env();
    const f = createFixture({ env: environment, createWorker: () => ({ async prepare() {},
      async launch() { entered.resolve(); return after.promise; }, async close() {} }) });
    const pending = f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'changed-after-dispatch' });
    await entered.promise; environment.DISPLAY = ':1'; after.resolve(true);
    assert.deepEqual(await pending, { outcome: 'unknown', reason: 'session-changed' });
    assert.equal(f.state.stopped.length, 1); await f.launcher.close();
  }
  {
    const gate = deferred(), entered = deferred(), environment = env();
    const f = createFixture({ env: environment, createWorker: () => ({ async prepare() { entered.resolve(); await gate.promise; },
      async launch() { assert.fail('changed environment must not launch'); }, async close() {} }) });
    const pending = f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'changed-env' });
    await entered.promise; environment.DISPLAY = ':1'; gate.resolve();
    await assert.rejects(pending, code('session_unavailable')); await f.launcher.close();
  }
  {
    const never = deferred(); let closed = 0;
    const f = createFixture({ timeoutMs: 30, createWorker: () => ({ async prepare() { await never.promise; },
      async launch() { assert.fail('timed-out preparation must not launch'); }, async close() { closed++; } }) });
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'prepare-timeout' }), code('timeout'));
    assert.equal(closed, 1); never.resolve(); await f.launcher.close();
  }
  {
    const gate = deferred(), entered = deferred(); let closed = 0, stopped = 0;
    const f = createFixture({ onUnknown() { stopped++; }, createWorker: () => ({ async prepare() {},
      async launch() { entered.resolve(); return gate.promise; }, async close() { closed++; } }) });
    const pending = f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'stop-running' });
    await entered.promise;
    const stopping = f.launcher.stopAll();
    assert.deepEqual(await pending, { outcome: 'unknown', reason: 'cancelled' });
    await stopping;
    assert.equal(closed, 1); assert.equal(stopped, 1);
    gate.resolve(true); await f.launcher.close();
  }
  {
    const f = createFixture({ createWorker: () => ({ async prepare() { throw new LinuxLaunchError('dependency_missing', 'not_dispatched', 'Install GLib/GIO'); },
      async launch() { assert.fail('missing GIO must not launch'); }, async close() {} }) });
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'no-gio' }), code('dependency_missing'));
    await f.launcher.close();
  }
  if (process.platform === 'win32') {
    const f = createFixture({ createWorker: undefined });
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'real-child-no-linux-gio' }), error =>
      error instanceof LinuxLaunchError && ['dependency_missing', 'stale_reference'].includes(error.code) && error.outcome === 'not_dispatched');
    await f.launcher.close();
  }
  {
    const f = createFixture({ createWorker: () => ({ async prepare() {}, async launch() { return 'not-a-boolean'; }, async close() {} }) });
    assert.deepEqual(await f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'invalid-gio-result' }), { outcome: 'unknown', reason: 'gio-failed' });
    assert.equal(f.state.stopped.length, 1); await f.launcher.close();
  }
  {
    let count = 0;
    const f = createFixture({ onUnknown() { count++; throw new Error('stop failed'); }, createWorker: () => ({ async prepare() {}, async launch() { return false; }, async close() {} }) });
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'stop-failed' }), error =>
      code('stop_unconfirmed')(error) && error.outcome === 'unknown');
    assert.equal(count, 1, 'a failed unknown handler must not be silently retried'); await f.launcher.close();
  }
  {
    const f = createFixture({ createWorker: () => ({ async prepare() {}, async launch() { return true; }, async close() { throw new Error('cleanup'); } }) });
    assert.deepEqual(await f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'cleanup-failed' }), { outcome: 'unknown', reason: 'cleanup-unconfirmed' });
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'after-cleanup' }), code('cleanup_unconfirmed'));
    await assert.rejects(f.launcher.close(), code('cleanup_unconfirmed'));
  }
  {
    const f = createFixture({ createWorker: () => ({ async prepare() { throw new Error('missing'); },
      async launch() { assert.fail('preparation failed'); }, async close() { throw new Error('cleanup'); } }) });
    await assert.rejects(f.launcher.launch(actor(), { reference: 'opaque-ref', requestId: 'pre-cleanup-failed' }), error =>
      code('cleanup_unconfirmed')(error) && error.outcome === 'not_dispatched');
    await assert.rejects(f.launcher.close(), code('cleanup_unconfirmed'));
  }
  console.log('Linux GIO launch: scoped receipts, target binding, sessions, cancellation and cleanup passed (simulated native GIO)');
} finally {
  receipts?.close();
  removeWorkspaceFixture(temp, 'desktop-linux-gio-');
}
