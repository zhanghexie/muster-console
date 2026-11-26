import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-x11-owner-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { parseLinuxProcessStat, parseXresReply, selectXresOwner, openX11OwnerNative, loadX11Libraries,
    assertX11SocketFamily, assertX11ServerIdentity, assertX11ClientIdentity, assertX11ProcessUnchanged, assertX11XresVersion, assertX11ClientMachine,
    createX11DestroyTracker, createX11EventQueue } = await import(pathToFileURL(compile('main/desktop/x11OwnerNative.ts')));
  const { createX11OwnerWorker } = await import(pathToFileURL(compile('main/desktop/x11OwnerWorker.ts')));
  const { X11OwnerProvider } = await import(pathToFileURL(compile('main/desktop/x11OwnerProvider.ts')));
  const { resolveX11SemanticTarget } = await import(pathToFileURL(compile('main/desktop/x11SemanticTarget.ts')));
  const stat = (pid, comm, state = 'S', start = '987654') => `${pid} (${comm}) ${state} ${Array.from({ length: 18 }, (_, i) => i + 4).join(' ')} ${start} 23`;
  assert.equal(parseLinuxProcessStat(stat(42, 'name with ) spaces'), 42), '987654');
  for (const input of [stat(43, 'other'), stat(42, 'zombie', 'Z'), stat(42, 'dead', 'X'), '42 (short) S 1 2', stat(42, 'x', 'S', 'bad')]) {
    assert.throws(() => parseLinuxProcessStat(input, 42));
  }
  assert.equal(parseLinuxProcessStat(stat(42, 'traced', 't'), 42), '987654');
  if (process.platform !== 'linux') assert.throws(() => openX11OwnerNative(), /Linux/);
  for (const library of ['libxcb.so.1', 'libxcb-res.so.0', null]) {
    assert.throws(() => loadX11Libraries(name => { if (name === library) throw new Error('missing'); return {}; }), /install.*XCB.*XRes/);
  }
  const self = { pid: 900, start: '100', namespace: '4:1' }, server = { pid: 33, start: '200', namespace: '4:1' };
  const client = { pid: 123, start: '300', namespace: '4:1' };
  assert.doesNotThrow(() => assertX11SocketFamily(1));
  assert.throws(() => assertX11SocketFamily(2), /Remote or forwarded/);
  assert.doesNotThrow(() => assertX11ServerIdentity(self, server, '/usr/bin/Xorg'));
  assert.throws(() => assertX11ServerIdentity(self, { ...server, namespace: '4:2' }, '/usr/bin/Xorg'), /namespace/);
  assert.throws(() => assertX11ServerIdentity(self, server, '/usr/bin/Xwayland'), /XWayland/);
  assert.throws(() => assertX11ServerIdentity(self, server, 'relative'), /native X11/);
  assert.doesNotThrow(() => assertX11ClientIdentity(self, server, client));
  assert.throws(() => assertX11ClientIdentity(self, server, { ...client, pid: server.pid }), /server-owned/);
  assert.throws(() => assertX11ClientIdentity(self, server, { ...client, namespace: '4:2' }), /namespace/);
  assert.doesNotThrow(() => assertX11ProcessUnchanged(client, { ...client }));
  for (const altered of [{ ...client, pid: 124 }, { ...client, start: '301' }, { ...client, namespace: '4:2' }]) {
    assert.throws(() => assertX11ProcessUnchanged(client, altered), /changed/);
  }
  for (const [major, minor] of [[1, 0], [1, 1], [0, 9], [NaN, 2], [2, -1], [65536, 0]]) assert.throws(() => assertX11XresVersion(major, minor), /XRes 1.2/);
  for (const [major, minor] of [[1, 2], [2, 0]]) assert.doesNotThrow(() => assertX11XresVersion(major, minor));
  for (const [machine, hostname] of [['', ''], ['Host.local', 'host'], ['host', 'HOST.local'], ['host\0', 'host']]) {
    assert.doesNotThrow(() => assertX11ClientMachine(machine, hostname));
  }
  assert.throws(() => assertX11ClientMachine('remote', 'host'), /remote machine/);
  assert.throws(() => assertX11ClientMachine('host', ''), /remote machine/);
  assert.throws(() => createX11EventQueue(createX11DestroyTracker(), () => ({ type: 0, nativeHandle: '0x1' }), () => {}).drain(), /asynchronous/);
  assert.throws(() => createX11EventQueue(createX11DestroyTracker(), () => ({ type: 2, nativeHandle: '0x1' }), () => {}).drain(), /backlog/);

  const own = 0x600000, target = 0x1200000;
  const packet = rows => {
    const extra = rows.reduce((n, row) => n + 12 + row.values.length * 4, 0), result = Buffer.alloc(32 + extra);
    result[0] = 1; result.writeUInt32LE(extra / 4, 4); result.writeUInt32LE(rows.length, 8);
    let offset = 32;
    for (const row of rows) {
      result.writeUInt32LE(row.client, offset); result.writeUInt32LE(row.mask, offset + 4); result.writeUInt32LE(row.values.length, offset + 8);
      offset += 12; for (const value of row.values) { result.writeUInt32LE(value, offset); offset += 4; }
    }
    return result;
  };
  const values = [{ client: own, mask: 2, values: [900] }, { client: target, mask: 2, values: [123] }];
  assert.deepEqual(parseXresReply(packet(values)), values);
  assert.equal(selectXresOwner(values, own, 900, target), 123);
  assert.equal(selectXresOwner([values[0]], own, 900, own), 900);
  for (const bad of [[], [values[1]], [values[0]], [{ ...values[0], values: [901] }, values[1]],
    [values[0], { ...values[1], values: [0] }], [values[0], { ...values[1], values: [1, 2] }],
    [values[0], values[1], values[1]], [values[0], { ...values[1], mask: 1 }]]) {
    assert.throws(() => selectXresOwner(bad, own, 900, target));
  }
  assert.throws(() => selectXresOwner(values, own, 900, 0));
  const invalidPacket = packet(values); invalidPacket.writeUInt32LE(65535, 40);
  assert.throws(() => parseXresReply(invalidPacket), /length/);
  assert.throws(() => parseXresReply(packet(values).subarray(0, 40)), /length|Truncated/);
  const trailing = Buffer.concat([packet(values), Buffer.alloc(4)]); trailing.writeUInt32LE((trailing.length - 32) / 4, 4);
  assert.throws(() => parseXresReply(trailing), /Unexpected/);

  const observation = (nativeHandle = '0x2a') => ({ nativeHandle, pid: 123, processStart: '111', workerPid: 900,
    serverPid: 33, serverStart: '222', serverExecutable: '/usr/lib/xorg/Xorg', namespace: '4:4026530000' });
  let events = [], changed = false, destroyed = [], fail = false, closed = false;
  const native = { probe(id) { if (fail) throw new Error('client disappeared'); return { ...observation(id), ...(changed ? { processStart: '112' } : {}) }; },
    destroyed() { const result = destroyed; destroyed = []; return result; }, close() { closed = true; } };
  const worker = createX11OwnerWorker(native, msg => events.push(msg), 5000);
  worker.receive({ id: 1, op: 'probe', nativeHandle: '0x0000002A' });
  assert.equal(events.pop().observation.nativeHandle, '0x2a');
  changed = true; worker.receive({ id: 2, op: 'probe', nativeHandle: '0x2a' });
  assert.deepEqual(events.map(e => e.kind), ['invalidated', 'result']); assert.equal(events.at(-1).ok, false); events = []; changed = false;
  worker.receive({ id: 3, op: 'probe', nativeHandle: '0x2a' }); events = [];
  destroyed = ['0x2a']; fail = true; worker.receive({ id: 4, op: 'probe', nativeHandle: '0x2a' });
  assert.deepEqual(events.map(e => e.kind), ['invalidated', 'result']); assert.equal(events.at(-1).ok, false);
  assert.throws(() => worker.receive({ id: 0, op: 'probe', nativeHandle: '0x2a' }), /Invalid/);
  worker.close(); assert.equal(closed, true);

  // A probe may consume the XCB event queue between the worker's two drains.
  // The old implementation lost another window's DestroyNotify in that gap.
  {
    const tracker = createX11DestroyTracker(), out = [], raw = []; let destroyDuringProbe = false;
    const queue = createX11EventQueue(tracker, () => raw.shift() ?? null, () => {});
    const interleaved = { probe(id) { tracker.watch(id); if (destroyDuringProbe) { raw.push({ type: 17, nativeHandle: '0x2a' }); queue.drain(); } return observation(id); },
      destroyed() { return queue.destroyed(); }, close() {} };
    const w = createX11OwnerWorker(interleaved, message => out.push(message), 5000);
    w.receive({ id: 1, op: 'probe', nativeHandle: '0x2a' });
    w.receive({ id: 2, op: 'probe', nativeHandle: '0x2b' }); out.length = 0;
    destroyDuringProbe = true;
    w.receive({ id: 3, op: 'probe', nativeHandle: '0x2b' });
    assert.deepEqual(out.map(message => [message.kind, message.nativeHandle]), [['invalidated', '0x2a'], ['result', undefined]]);
    assert.equal(tracker.isDead('0x2a'), true);
    assert.deepEqual(tracker.take(), []);
    w.close();
  }

  const env = () => ({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XAUTHORITY: '/tmp/xauth', HOME: '/home/fixture', NODE_OPTIONS: '--untrusted' });
  const makeFactory = (config = {}) => {
    let child, owner, reclaimed = 0;
    const factory = options => {
      assert.equal(options.spawnOptions.shell, false);
      assert.equal(options.command, process.execPath);
      assert.ok(path.isAbsolute(options.args[0]));
      assert.deepEqual(options.spawnOptions.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      assert.equal(options.spawnOptions.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(options.spawnOptions.env.NODE_OPTIONS, undefined);
      assert.equal(options.spawnOptions.env.MUSTER_X11_OWNER_WORKER, '1');
      child = new EventEmitter(); child.pid = 900; child.connected = true;
      child.send = (request, callback) => {
        callback?.(null);
        if (config.onSend) return config.onSend(request, child);
        queueMicrotask(() => child.emit('message', { kind: 'result', id: request.id, ok: true, observation: observation(request.nativeHandle) }));
      };
      owner = { child, state: 'ready', ready: Promise.resolve(), exited: new Promise(() => {}),
        async reclaim() { reclaimed++; child.connected = false; child.emit('disconnect'); child.emit('close'); if (config.reclaimError) throw new Error('reclaim failed'); owner.state = 'released'; } };
      if (!config.noReady) queueMicrotask(() => child.emit('message', { kind: 'ready' }));
      return owner;
    };
    return { factory, get child() { return child; }, get reclaimed() { return reclaimed; } };
  };
  const options = (factory, currentEnv = env(), overrides = {}) => ({ workerFile: path.join(temp, 'fixture-worker.cjs'), platform: 'linux', env: currentEnv,
    timeoutMs: 100, freshnessMs: 1000, spawn: factory,
    verifyNativeX11: async row => ({ serverPid: row.serverPid, serverStart: row.serverStart, isCurrent: () => true }),
    verifySemanticApp: async row => ({ pid: row.pid, processStart: row.processStart, isCurrent: () => true }), ...overrides });

  const good = makeFactory(), goodEnv = env(); let now = 0;
  const provider = await X11OwnerProvider.open(options(good.factory, goodEnv, { now: () => now }));
  assert.equal(provider.sameSession({ ...goodEnv }), true);
  assert.equal(provider.sameSession({ ...goodEnv, DISPLAY: ':1' }), false);
  const proof = await provider.prove('0x0000002a');
  assert.deepEqual({ nativeHandle: proof.nativeHandle, pid: proof.pid, processStart: proof.processStart, source: proof.source },
    { nativeHandle: '0x2a', pid: 123, processStart: '111', source: 'xres-local' });
  assert.equal(proof.isCurrent(), true); assert.equal(Object.isFrozen(proof), true);
  const renewed = await provider.revalidate(proof);
  assert.equal(proof.isCurrent(), false, 'revalidation never revives an old proof');
  assert.equal(renewed.isCurrent(), true);
  const actor = { sessionId: 's', taskId: 't', turnId: 'turn', isCurrent: () => true };
  const generation = 'a'.repeat(48), capture = { nativeHandle: '0x2a', generation, markerEstablishedBeforeCapture: true, isCurrent: () => true };
  const targetProof = resolveX11SemanticTarget({ resolve: () => ({ window: { nativeHandle: '0x2a', pid: 123 }, generation,
    owner: renewed, capture, isCurrent: () => true }) }, { current: () => true, sameSession: value => provider.sameSession(value) },
  actor, 'owned-selection', { platform: 'linux', env: goodEnv });
  assert.equal(targetProof.isCurrent(), true);
  good.child.emit('message', { kind: 'invalidated', nativeHandle: '0x2a' });
  assert.equal(renewed.isCurrent(), false); assert.equal(targetProof.isCurrent(), false);
  await assert.rejects(provider.revalidate(renewed), /expired/);
  const expiring = await provider.prove('0x2a'); now = 1001;
  assert.equal(expiring.isCurrent(), false); now = 0; assert.equal(expiring.isCurrent(), false, 'expired proof never revives');
  const envProof = await provider.prove('0x2a'); goodEnv.DISPLAY = ':1';
  assert.equal(envProof.isCurrent(), false); goodEnv.DISPLAY = ':0'; assert.equal(envProof.isCurrent(), false);
  const disconnected = await provider.prove('0x2a'); good.child.connected = false;
  assert.equal(disconnected.isCurrent(), false, 'a disconnected worker cannot retain a live proof');
  await provider.close(); assert.equal(good.reclaimed, 1);

  for (const config of [
    { platform: 'darwin' }, { env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } },
    { env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } },
    { verifyNativeX11: undefined }, { verifySemanticApp: undefined }, { freshnessMs: 0 }, { timeoutMs: 0 }
  ]) await assert.rejects(X11OwnerProvider.open(options(makeFactory().factory, env(), config)));

  for (const callbackOverrides of [
    { verifyNativeX11: async row => ({ serverPid: row.serverPid + 1, serverStart: row.serverStart, isCurrent: () => true }) },
    { verifyNativeX11: async row => ({ serverPid: row.serverPid, serverStart: row.serverStart, isCurrent: () => false }) },
    { verifySemanticApp: async row => ({ pid: row.pid + 1, processStart: row.processStart, isCurrent: () => true }) },
    { verifySemanticApp: async () => { throw new Error('forwarded client'); } }
  ]) {
    const fixture = makeFactory(), p = await X11OwnerProvider.open(options(fixture.factory, env(), callbackOverrides));
    await assert.rejects(p.prove('0x2a')); await p.close();
  }
  {
    const fixture = makeFactory(), p = await X11OwnerProvider.open(options(fixture.factory));
    fixture.child.emit('message', { kind: 'invalidated', nativeHandle: '0x2b' });
    await assert.rejects(p.prove('0x2a'), /Unexpected X11 owner invalidation/); await p.close();
  }
  {
    let count = 0;
    const fixture = makeFactory({ onSend(request, child) { const row = observation(request.nativeHandle);
      if (++count > 1) row.processStart = '112';
      queueMicrotask(() => child.emit('message', { kind: 'result', id: request.id, ok: true, observation: row })); } });
    const p = await X11OwnerProvider.open(options(fixture.factory)), prior = await p.prove('0x2a');
    await assert.rejects(p.revalidate(prior), /identity changed/);
    assert.equal(prior.isCurrent(), false); await p.close();
  }
  {
    const fixture = makeFactory({ noReady: true });
    await assert.rejects(X11OwnerProvider.open(options(fixture.factory, env(), { timeoutMs: 20 })), /startup timed out/);
    assert.equal(fixture.reclaimed, 1);
  }
  {
    const fixture = makeFactory(), p = await X11OwnerProvider.open(options(fixture.factory, env(), {
      timeoutMs: 20, verifySemanticApp: async () => new Promise(() => {}) }));
    await assert.rejects(p.prove('0x2a'), /verification timed out/); await p.close();
  }
  {
    const fixture = makeFactory({ onSend(request, child) { queueMicrotask(() => child.emit('message', {
      kind: 'result', id: request.id, ok: true, observation: observation('0x2b') })); } });
    const p = await X11OwnerProvider.open(options(fixture.factory));
    await assert.rejects(p.prove('0x2a'), /Invalid X11 owner observation/); await p.close();
  }
  {
    const fixture = makeFactory({ onSend(request, child) { queueMicrotask(() => child.emit('message', {
      kind: 'result', id: request.id, ok: true, observation: { ...observation(request.nativeHandle), serverExecutable: '/usr/bin/Xwayland' } })); } });
    const p = await X11OwnerProvider.open(options(fixture.factory));
    await assert.rejects(p.prove('0x2a'), /Invalid X11 owner observation/); await p.close();
  }
  {
    const fixture = makeFactory({ onSend(request, child) { queueMicrotask(() => child.emit('message', {
      kind: 'result', id: request.id, ok: false, error: 'XRes 1.2 or local client PID unavailable' })); } });
    const p = await X11OwnerProvider.open(options(fixture.factory));
    await assert.rejects(p.prove('0x2a'), /XRes/); await p.close();
  }
  {
    const fixture = makeFactory({ onSend() {} }), p = await X11OwnerProvider.open(options(fixture.factory, env(), { timeoutMs: 20 }));
    await assert.rejects(p.prove('0x2a'), /timed out/); await p.close(); assert.equal(fixture.reclaimed, 1);
  }
  {
    const fixture = makeFactory({ onSend() {} }), p = await X11OwnerProvider.open(options(fixture.factory));
    const abort = new AbortController(), pending = p.prove('0x2a', abort.signal); abort.abort();
    await assert.rejects(pending, /cancelled/); await p.close();
  }
  {
    let cleanup;
    const fixture = makeFactory({ reclaimError: true }), p = await X11OwnerProvider.open(options(fixture.factory, env(), { onCleanupError: e => { cleanup = e; } }));
    fixture.child.emit('message', { kind: 'unexpected' });
    await assert.rejects(p.close(), /reclaim failed/); await new Promise(resolve => setImmediate(resolve));
    assert.match(cleanup.message, /reclaim failed/);
  }
  console.log('X11 owner provider: XRes parsing, namespace/server/app gates, invalidation, timeouts and cleanup simulations passed; Linux native execution not run');
} finally { removeWorkspaceFixture(temp, 'desktop-x11-owner-'); }
