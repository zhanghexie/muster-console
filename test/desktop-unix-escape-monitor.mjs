import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-unix-escape-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { UnixEscapeMonitor } = await import(pathToFileURL(compile('main/desktop/unixEscapeMonitor.ts')));
  const { createMacEscapeNative, openMacEscapeNative, loadMacEscapeLibraries } = await import(pathToFileURL(compile('main/desktop/unixEscapeNativeMac.ts')));
  const { assertX11InputVersion, x11EscapeProcessStart, x11EscapePeer, assertX11EscapePeerCurrent, assertX11EscapeProcSelf,
    x11EscapeEvent, x11EscapeKeycodes, createX11EscapeNative, openX11EscapeNative, loadX11EscapeLibraries } = await import(pathToFileURL(compile('main/desktop/unixEscapeNativeX11.ts')));
  const workerPath = compile('main/desktop/unixEscapeWorker.ts');
  const { createUnixEscapeWorker } = await import(pathToFileURL(workerPath));
  const { DesktopActivityRuntime } = await import(pathToFileURL(compile('main/desktop/desktopActivityRuntime.ts')));
  const { spawnOwnedProcess } = await import(pathToFileURL(compile('main/agentSession/process/owner.ts')));

  if (process.platform !== 'darwin') assert.throws(() => openMacEscapeNative(), /requires macOS/);
  if (process.platform !== 'linux') assert.throws(() => openX11EscapeNative(), /requires little-endian Linux/);
  assert.throws(() => loadMacEscapeLibraries(() => { throw new Error('missing'); }), /frameworks are unavailable/);
  for (const lib of ['libxcb.so.1', 'libxcb-xinput.so.0', null]) {
    assert.throws(() => loadX11EscapeLibraries(name => { if (name === lib) throw new Error('missing'); return {}; }), /Install.*XInput/);
  }
  const makeMac = (overrides = {}) => {
    let callback, closed = 0;
    const api = { permission: () => true, secureInput: () => false, enabled: () => true,
      start(fn) { callback = fn; }, poll() {}, close() { closed++; }, ...overrides };
    return { api, emit: (...args) => callback(...args), get closed() { return closed; } };
  };
  for (const [overrides, reason] of [
    [{ permission: () => false }, /Input Monitoring/], [{ secureInput: () => true }, /Secure Input/],
    [{ enabled: () => false }, /disabled/], [{ start: () => { throw new Error('tap failed'); } }, /tap failed/]
  ]) {
    const mac = makeMac(overrides);
    assert.throws(() => createMacEscapeNative(mac.api), reason); assert.equal(mac.closed, 1);
  }
  {
    let secure = false, enabled = true;
    const mac = makeMac({ secureInput: () => secure, enabled: () => enabled }), native = createMacEscapeNative(mac.api);
    mac.emit(10, 12, false); assert.equal(native.poll(), false);
    mac.emit(10, 53, true); assert.equal(native.poll(), true, 'a key held before monitoring began still stops');
    mac.emit(10, 53, false); assert.equal(native.poll(), true); assert.equal(native.poll(), false);
    mac.emit(0xfffffffe, 0, false); assert.throws(() => native.poll(), /tap was disabled/);
    native.close(); native.close(); assert.equal(mac.closed, 1);
    const another = createMacEscapeNative(makeMac({ secureInput: () => secure, enabled: () => enabled }).api);
    secure = true; assert.throws(() => another.poll(), /Secure Input/); another.close();
    secure = false; const third = createMacEscapeNative(makeMac({ secureInput: () => secure, enabled: () => enabled }).api);
    enabled = false; assert.throws(() => third.poll(), /disabled/); third.close();
  }

  assert.throws(() => assertX11InputVersion(2, 0), /2\.1/);
  assert.throws(() => assertX11InputVersion(1, 9), /2\.1/);
  assert.doesNotThrow(() => assertX11InputVersion(2, 1));
  const stat = (pid, state = 'S', start = '987') => `${pid} (name with ) space) ${state} ${Array.from({ length: 18 }, (_, i) => i + 4).join(' ')} ${start} 23`;
  assert.equal(x11EscapeProcessStart(123, stat(123)), '987');
  for (const text of [stat(124), stat(123, 'Z'), stat(123, 'S', 'bad'), '123 (short) S 1']) {
    assert.throws(() => x11EscapeProcessStart(123, text));
  }
  const self = { start: '101', namespace: '4:1' }, server = { start: '202', namespace: '4:1' };
  assert.doesNotThrow(() => assertX11EscapeProcSelf(self, { ...self }));
  assert.throws(() => assertX11EscapeProcSelf(self, { ...self, start: '102' }), /proc mount/);
  assert.throws(() => assertX11EscapeProcSelf(self, { ...self, namespace: '4:2' }), /proc mount/);
  const peer = x11EscapePeer(1, 900, 42, self, server, '/usr/bin/Xorg');
  assert.equal(peer.serverPid, 42); assert.equal(Object.isFrozen(peer), true);
  assert.throws(() => x11EscapePeer(2, 900, 42, self, server, '/usr/bin/Xorg'), /Remote/);
  assert.throws(() => x11EscapePeer(1, 900, 900, self, server, '/usr/bin/Xorg'), /credentials/);
  assert.throws(() => x11EscapePeer(1, 900, 42, self, { ...server, namespace: '4:2' }, '/usr/bin/Xorg'), /namespace/);
  assert.throws(() => x11EscapePeer(1, 900, 42, self, server, '/usr/bin/Xwayland'), /XWayland/);
  assert.doesNotThrow(() => assertX11EscapePeerCurrent(peer, self, server, '/usr/bin/Xorg'));
  assert.throws(() => assertX11EscapePeerCurrent(peer, self, { ...server, start: '203' }, '/usr/bin/Xorg'), /changed/);
  assert.throws(() => assertX11EscapePeerCurrent(peer, self, server, '/usr/bin/new'), /changed/);
  const mapping = Buffer.alloc(32 + 3 * 2 * 4); mapping[0] = 1; mapping[1] = 2; mapping.writeUInt32LE(6, 4);
  mapping.writeUInt32LE(0xff1b, 32 + 2 * 4);
  const keys = x11EscapeKeycodes(8, 10, mapping); assert.deepEqual([...keys], [9]);
  assert.throws(() => x11EscapeKeycodes(8, 10, mapping.subarray(0, 40)), /length/);
  const none = Buffer.from(mapping); none.writeUInt32LE(0, 32 + 2 * 4);
  assert.throws(() => x11EscapeKeycodes(8, 10, none), /no Escape mapping/);
  const xevent = (type, extension, eventType, detail) => { const b = Buffer.alloc(32); b[0] = type; b[1] = extension; b.writeUInt16LE(eventType, 8); b.writeUInt32LE(detail, 16); return b; };
  assert.equal(x11EscapeEvent(xevent(35, 131, 13, 9), 131, keys), 'escape');
  assert.equal(x11EscapeEvent(xevent(35, 131, 13, 8), 131, keys), 'ignore');
  assert.equal(x11EscapeEvent(xevent(35, 130, 13, 9), 131, keys), 'ignore');
  assert.equal(x11EscapeEvent(xevent(35, 131, 14, 9), 131, keys), 'ignore');
  assert.equal(x11EscapeEvent(xevent(34, 0, 0, 0), 131, keys), 'mapping');
  assert.throws(() => x11EscapeEvent(Buffer.alloc(32), 131, keys), /protocol error/);
  {
    let clock = 0, currentKeys = new Set([9]), syncs = 0, closed = 0, connected = true, broken = false;
    const raw = [], backend = { opcode: 131, mapping: () => currentKeys, next: () => raw.shift() ?? null,
      assertConnected() { if (!connected) throw new Error('disconnected'); }, sync() { syncs++; if (broken) throw new Error('server hung'); },
      close() { closed++; } };
    const native = createX11EscapeNative(backend, () => clock);
    assert.equal(native.poll(), false); raw.push(xevent(35, 131, 13, 9)); assert.equal(native.poll(), true);
    currentKeys = new Set([8]); raw.push(xevent(34, 0, 0, 0), xevent(35, 131, 13, 8));
    assert.equal(native.poll(), true, 'a keyboard remap must refresh the Escape key');
    clock = 501; assert.equal(native.poll(), false); assert.equal(syncs, 1);
    clock = 1002; broken = true; assert.throws(() => native.poll(), /server hung/);
    broken = false; connected = false; assert.throws(() => native.poll(), /disconnected/);
    native.close(); native.close(); assert.equal(closed, 1);
  }

  {
    const messages = []; let result = false, closed = 0;
    const worker = createUnixEscapeWorker({ poll: () => result, close: () => { closed++; } }, message => messages.push(message));
    worker.tick(); result = true; worker.tick(); worker.tick();
    assert.deepEqual(messages.map(message => message.kind), ['heartbeat', 'escape', 'heartbeat', 'heartbeat']);
    worker.close(); worker.close(); assert.equal(closed, 1); assert.throws(() => worker.tick(), /closed/);
  }

  const environment = () => ({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', HOME: '/home/fixture', NODE_OPTIONS: '--untrusted' });
  const fixture = (config = {}) => {
    let child, owner, reclaimed = 0;
    const factory = options => {
      assert.equal(options.command, process.execPath); assert.equal(options.spawnOptions.shell, false);
      assert.deepEqual(options.spawnOptions.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      assert.equal(options.spawnOptions.env.NODE_OPTIONS, undefined);
      assert.equal(options.spawnOptions.env.MUSTER_UNIX_ESCAPE_WORKER, '1');
      child = new EventEmitter(); child.connected = true; child.pid = 900;
      owner = { child, state: config.ownerPending ? 'starting' : 'ready', ready: config.ownerPending ? new Promise(() => {}) : Promise.resolve(),
        async reclaim() { reclaimed++; child.connected = false; child.emit('disconnect'); child.emit('close'); owner.state = 'released'; if (config.reclaimError) throw new Error('cleanup failed'); } };
      if (!config.noReady) queueMicrotask(() => {
        const peer = { workerPid: 900, workerStart: '101', serverPid: 42, serverStart: '202', namespace: '4:1', serverExecutable: '/usr/bin/Xorg', ...config.peer };
        child.emit('message', { kind: 'ready', ...(!config.mac && !config.omitPeer ? { peer } : {}) });
        if (config.afterReady) config.afterReady(child);
      });
      return owner;
    };
    return { factory, get child() { return child; }, get reclaimed() { return reclaimed; } };
  };
  const opts = (f, extra = {}) => ({ workerFile: path.join(temp, 'worker.cjs'), platform: 'linux', env: environment(),
    verifyNativeX11: () => true, onEscape() {}, onFailure() {}, spawn: f.factory, startupTimeoutMs: 100, heartbeatTimeoutMs: 250, ...extra });
  for (const extra of [
    { platform: 'win32' }, { env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } },
    { env: { XDG_SESSION_TYPE: 'x11' } }, { verifyNativeX11: undefined }
  ]) {
    const f = fixture(), monitor = new UnixEscapeMonitor(opts(f, extra));
    await assert.rejects(monitor.start(), /requires|Wayland|native X11|DISPLAY/); assert.equal(f.reclaimed, 0);
  }
  for (const [config, extra] of [
    [{}, { verifyNativeX11: () => false }], [{ omitPeer: true }, {}],
    [{ peer: { workerPid: 901 } }, {}], [{ peer: { serverExecutable: '/usr/bin/Xwayland' } }, {}]
  ]) {
    const f = fixture(config), monitor = new UnixEscapeMonitor(opts(f, extra));
    await assert.rejects(monitor.start(), /host proof|server peer/); assert.equal(f.reclaimed, 1);
  }
  {
    const f = fixture(), hits = [], failures = [], proofs = [], monitor = new UnixEscapeMonitor(opts(f, {
      verifyNativeX11: evidence => { proofs.push(evidence); return evidence.serverPid === 42 && evidence.serverStart === '202'; },
      onEscape: () => hits.push('stop'), onFailure: reason => failures.push(reason) }));
    assert.equal(monitor.provenance, 'unknown'); assert.equal(monitor.syntheticEscape, 'may-stop');
    await monitor.start(); f.child.emit('message', { kind: 'heartbeat' }); f.child.emit('message', { kind: 'escape' });
    assert.deepEqual(hits, ['stop']); assert.deepEqual(failures, []);
    assert.ok(proofs.length >= 1); assert.equal(Object.isFrozen(proofs[0]), true); assert.equal(proofs[0].workerPid, 900);
    await monitor.stop(); await monitor.stop(); assert.equal(f.reclaimed, 1);
    f.child.emit('message', { kind: 'escape' }); assert.deepEqual(hits, ['stop']);
  }
  for (const config of [{ noReady: true }, { ownerPending: true }]) {
    const f = fixture(config), monitor = new UnixEscapeMonitor(opts(f, { startupTimeoutMs: 25 }));
    await assert.rejects(monitor.start(), /did not become ready/); assert.equal(f.reclaimed, 1);
  }
  {
    const f = fixture({ ownerPending: true }), monitor = new UnixEscapeMonitor(opts(f, { startupTimeoutMs: 500 }));
    const starting = monitor.start(); await new Promise(resolve => setImmediate(resolve)); await monitor.stop();
    await assert.rejects(starting, /stopped/); assert.equal(f.reclaimed, 1);
  }
  {
    let failure; const f = fixture(), monitor = new UnixEscapeMonitor(opts(f, { heartbeatTimeoutMs: 100, onFailure: reason => { failure = reason; } }));
    await monitor.start(); await new Promise(resolve => setTimeout(resolve, 180));
    assert.match(failure, /stopped responding/); await monitor.stop(); assert.equal(f.reclaimed, 1);
  }
  {
    let trusted = true, failure; const f = fixture(), monitor = new UnixEscapeMonitor(opts(f, { heartbeatTimeoutMs: 100, verifyNativeX11: () => trusted, onFailure: reason => { failure = reason; } }));
    await monitor.start(); trusted = false; await new Promise(resolve => setTimeout(resolve, 80));
    assert.match(failure, /host proof/); await monitor.stop();
  }
  {
    let failure; const f = fixture({ mac: true, afterReady: child => child.emit('message', { kind: 'failure', reason: 'Secure Input enabled' }) });
    const monitor = new UnixEscapeMonitor(opts(f, { platform: 'darwin', onFailure: reason => { failure = reason; } }));
    await assert.rejects(monitor.start(), /Secure Input/); assert.match(failure, /Secure Input/); assert.equal(f.reclaimed, 1);
  }
  {
    const f = fixture(), labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
    let enter, finish, releases = 0;
    const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { finish = resolve; });
    const runtime = new DesktopActivityRuntime({ labels, releaseAll: async () => { releases++; },
      createIndicator: () => ({ show: async () => {}, close() {} }),
      createEscapeMonitor: (onEscape, onFailure) => new UnixEscapeMonitor(opts(f, { onEscape, onFailure })) });
    runtime.turns.begin('worker', 'turn', () => true);
    const action = runtime.turns.use('worker', 'turn', 'fixture', async signal => { enter(signal); await gate; }).catch(error => error);
    const signal = await entered; f.child.emit('message', { kind: 'escape' });
    assert.equal(signal.aborted, true); finish(); assert.ok(await action); await runtime.dispose(); assert.ok(releases > 0);
  }
  {
    const f = fixture(), labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
    let button, reported; const snapshots = [];
    const runtime = new DesktopActivityRuntime({ labels, releaseAll: async () => {}, reportMonitorFailure: reason => { reported = reason; },
      createIndicator: stop => { button = stop; return { show: async snapshot => { snapshots.push(snapshot); }, close() {} }; },
      createEscapeMonitor: (onEscape, onFailure) => new UnixEscapeMonitor(opts(f, { onEscape, onFailure, verifyNativeX11: () => false })) });
    runtime.turns.begin('worker', 'turn', () => true);
    assert.equal(await runtime.turns.use('worker', 'turn', 'fixture', async () => 1), 1);
    assert.match(reported, /host proof/); assert.equal(snapshots.at(-1).escapeAvailable, false);
    await button(); await runtime.dispose(); assert.equal(f.reclaimed, 1);
  }
  {
    // Real supervised child and IPC; its signal is simulated and never reads a keyboard.
    const script = path.join(temp, 'fake-stop-worker.cjs');
    fs.writeFileSync(script, `process.send({kind:'ready'}); setInterval(() => process.send({kind:'heartbeat'}), 40); setTimeout(() => process.send({kind:'escape'}), 120);`);
    let caught; const event = new Promise(resolve => { caught = resolve; });
    const f = fixture(), monitor = new UnixEscapeMonitor(opts(f, { platform: 'darwin', workerFile: script,
      startupTimeoutMs: 3000, heartbeatTimeoutMs: 1000, onEscape: caught,
      spawn: config => spawnOwnedProcess({ ...config, spawnOptions: { ...config.spawnOptions,
        env: { ...config.spawnOptions.env, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } } }) }));
    await monitor.start(); await event; await monitor.stop();
  }
  if (process.platform === 'win32') {
    // The real worker must report unsupported platform while remaining alive
    // long enough for its supervised process group to be reclaimed.
    const f = fixture(), monitor = new UnixEscapeMonitor(opts(f, { platform: 'darwin', workerFile: workerPath, startupTimeoutMs: 3000,
      spawn: config => spawnOwnedProcess({ ...config, spawnOptions: { ...config.spawnOptions,
        env: { ...config.spawnOptions.env, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } } }) }));
    await assert.rejects(monitor.start(), /This platform has no Unix Escape listener/);
    await monitor.stop();
  }
  console.log('Unix Escape: macOS/X11 mocked events, health, session/permission failures and stop integration passed; no native macOS/Linux execution');
} finally { removeWorkspaceFixture(temp, 'desktop-unix-escape-'); }
