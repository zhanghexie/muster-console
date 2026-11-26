import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';
import { copyWaylandStopHelper } from '../scripts/desktop-driver/copy-wayland-stop.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-wayland-stop-'));
const keepAlive = setInterval(() => {}, 1000);
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { WaylandStopIndicator } = await import(pathToFileURL(compile('main/desktop/waylandStopIndicator.ts')));
  const { DesktopActivityRuntime } = await import(pathToFileURL(compile('main/desktop/desktopActivityRuntime.ts')));
  const env = () => ({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', XDG_CURRENT_DESKTOP: 'KDE' });
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use Stop' };
  const snapshot = revision => ({ revision, state: 'active', target: 'fixture', escapeAvailable: false, labels });
  {
    const root = path.join(temp, 'package-fixture');
    fs.mkdirSync(path.join(root, 'src', 'main', 'desktop'), { recursive: true });
    fs.copyFileSync('src/main/desktop/waylandStopHelper.py', path.join(root, 'src', 'main', 'desktop', 'waylandStopHelper.py'));
    const output = copyWaylandStopHelper(root);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync('src/main/desktop/waylandStopHelper.py'));
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const fixture = (config = {}) => {
    let child, owner, spawned, reclaimed = 0;
    const factory = options => {
      spawned = options;
      child = new EventEmitter(); child.pid = 1234; child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.write = (line, callback) => {
        const input = JSON.parse(line); config.onWrite?.(input);
        if (!config.noResponse) queueMicrotask(() => {
          if (config.error) return emit({ kind: 'failure', reason: config.error });
          emit({ kind: 'heartbeat' });
          emit({ kind: 'mapped', pid: 1234, namespace: input.namespace, outputs: 2, revision: input.revision, ...config.receipt });
        });
        callback?.(); return true;
      };
      owner = { child, state: 'ready', ready: config.pendingOwner ? new Promise(() => {}) : Promise.resolve(),
        async reclaim() { reclaimed++; owner.state = 'released'; child.emit('close'); if (config.reclaimError) throw new Error('cannot reclaim'); } };
      return owner;
    };
    const emit = message => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
    return { factory, emit, get child() { return child; }, get spawned() { return spawned; }, get reclaimed() { return reclaimed; } };
  };
  const opts = (f, extra = {}) => ({ platform: 'linux', pythonPath: '/usr/bin/python3', helperPath: '/opt/metaagent/waylandStopHelper.py',
    env: env(), stop: async () => {}, unavailable() {}, spawn: f.factory, startupTimeoutMs: 200, heartbeatTimeoutMs: 300,
    verifyVisible: async () => ({ isCurrent: () => true, release() {} }), ...extra });

  for (const extra of [{ platform: 'win32' }, { env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' } },
    { env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } }]) {
    const f = fixture(), indicator = new WaylandStopIndicator(opts(f, extra));
    await assert.rejects(indicator.show(snapshot(1)), /requires Linux|native Wayland/);
    assert.equal(f.spawned, undefined, 'unsupported sessions must fail before spawning');
  }
  {
    const f = fixture(), indicator = new WaylandStopIndicator(opts(f, { verifyVisible: undefined }));
    await indicator.show(snapshot(1));
    assert.equal(indicator.isCurrent(), true, 'a healthy mapped helper needs no compositor-specific extension');
    indicator.close(); await indicator.whenClosed();
  }
  {
    const f = fixture(), receipts = [], invalidations = [], released = [], stopped = [], failures = [], inputs = [];
    const indicator = new WaylandStopIndicator(opts(f, { stop: async () => stopped.push(true), unavailable: reason => failures.push(reason),
      verifyVisible: async (receipt, invalidated) => { receipts.push(receipt); invalidations.push(invalidated); const id = receipt.revision;
        return { isCurrent: () => true, release: () => { released.push(id); invalidated(); } }; } }));
    await indicator.show(snapshot(1)); assert.equal(indicator.isCurrent(), true);
    assert.equal(receipts[0].outputs, 2); assert.equal(receipts[0].pid, 1234); assert.equal(Object.isFrozen(receipts[0]), true);
    assert.equal(f.spawned.spawnOptions.env.GDK_BACKEND, 'wayland'); assert.equal(f.spawned.spawnOptions.shell, false);
    assert.deepEqual(f.spawned.args, ['-I', '/opt/metaagent/waylandStopHelper.py']);
    await indicator.show(snapshot(2)); assert.deepEqual(released, [1]); assert.deepEqual(failures, [], 'retiring a proof may invoke its callback');
    f.emit({ kind: 'stop', revision: 1 }); f.emit({ kind: 'stop', revision: 1 }); await flush();
    assert.deepEqual(stopped, [true], 'even an old button click stops, exactly once');
    indicator.close(); await indicator.whenClosed(); assert.equal(f.reclaimed, 1); assert.deepEqual(released, [1, 2]);
    assert.equal(indicator.isCurrent(), false); assert.deepEqual(failures, []); void inputs;
  }
  for (const config of [{ receipt: { pid: 999 } }, { receipt: { outputs: 0 } }, { receipt: { namespace: 'other' } },
    { error: 'Install GTK Layer Shell 0.10 or later' }, { noResponse: true }, { pendingOwner: true }]) {
    const f = fixture(config), errors = [], indicator = new WaylandStopIndicator(opts(f, { startupTimeoutMs: 30, unavailable: reason => errors.push(reason) }));
    await assert.rejects(indicator.show(snapshot(1)), /receipt|Install|timed out/);
    await flush(); assert.equal(indicator.isCurrent(), false); assert.equal(f.reclaimed, 1); assert.ok(errors.length);
  }
  {
    const f = fixture(), failures = []; let released = false;
    const indicator = new WaylandStopIndicator(opts(f, { unavailable: reason => failures.push(reason),
      verifyVisible: async () => ({ isCurrent: () => false, release() { released = true; } }) }));
    await assert.rejects(indicator.show(snapshot(1)), /proof is unavailable/); await flush();
    assert.equal(f.reclaimed, 1); assert.equal(released, true); assert.match(failures[0], /proof/);
  }
  {
    const f = fixture({ reclaimError: true }), failures = [];
    const indicator = new WaylandStopIndicator(opts(f, { unavailable: reason => failures.push(reason) }));
    await indicator.show(snapshot(1)); indicator.close();
    await assert.rejects(indicator.whenClosed(), /cleanup is unconfirmed/);
    await assert.rejects(indicator.show(snapshot(1)), /cleanup is unconfirmed/);
    assert.match(failures[0], /cleanup is unconfirmed/);
  }
  {
    const f = fixture({ reclaimError: true });
    const indicator = new WaylandStopIndicator(opts(f, { verifyVisible: async () => ({ isCurrent: () => false, release() {} }) }));
    await assert.rejects(indicator.show(snapshot(1)), /failed and helper cleanup is unconfirmed/);
    assert.equal(f.reclaimed, 1, 'a startup failure must await cleanup before it is reported');
  }
  {
    let invalidate; const f = fixture(), failures = [];
    const indicator = new WaylandStopIndicator(opts(f, { unavailable: reason => failures.push(reason),
      verifyVisible: async (_receipt, cb) => { invalidate = cb; return { isCurrent: () => true, release() {} }; } }));
    await indicator.show(snapshot(1)); invalidate(); await flush();
    assert.equal(indicator.isCurrent(), false); assert.match(failures[0], /no longer be verified/); assert.equal(f.reclaimed, 1);
  }
  {
    const environment = env(), f = fixture(), failures = [];
    const indicator = new WaylandStopIndicator(opts(f, { env: environment, heartbeatTimeoutMs: 120, unavailable: reason => failures.push(reason) }));
    await indicator.show(snapshot(1)); environment.WAYLAND_DISPLAY = 'wayland-1';
    assert.equal(indicator.isCurrent(), false, 'dispatch checks must synchronously reject a changed session');
    await new Promise(resolve => setTimeout(resolve, 80)); assert.match(failures[0], /session changed/); assert.equal(f.reclaimed, 1);
  }
  {
    const f = fixture(), failures = [];
    const indicator = new WaylandStopIndicator(opts(f, { heartbeatTimeoutMs: 100, unavailable: reason => failures.push(reason) }));
    await indicator.show(snapshot(1)); await new Promise(resolve => setTimeout(resolve, 180));
    assert.match(failures[0], /stopped responding/); assert.equal(f.reclaimed, 1);
  }
  {
    const f = fixture(); let entered, finish, releases = 0, indicator;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { finish = resolve; });
    const runtime = new DesktopActivityRuntime({ labels, releaseAll: async () => { releases++; },
      createIndicator: (stop, unavailable) => indicator = new WaylandStopIndicator(opts(f, { stop, unavailable })) });
    runtime.turns.begin('worker', 'turn', () => true);
    const action = runtime.turns.use('worker', 'turn', 'fixture', async signal => { entered(signal); await gate; }).catch(error => error);
    const signal = await started; assert.equal(indicator.isCurrent(), true);
    f.emit({ kind: 'stop', revision: 1 }); assert.equal(signal.aborted, true);
    finish(); assert.ok(await action); await runtime.dispose(); assert.ok(releases > 0);
  }
  {
    let current = true, signal, finish, entered;
    const gate = new Promise(resolve => { finish = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const runtime = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
      createIndicator: () => ({ async show() {}, close() {}, isCurrent: () => current }) });
    runtime.turns.begin('worker', 'turn', () => true);
    const action = runtime.turns.use('worker', 'turn', 'fixture', async value => { signal = value; entered(); await gate; }).catch(error => error);
    await started; assert.equal(runtime.isVisible(), true);
    current = false; assert.equal(runtime.isVisible(), false); assert.equal(signal.aborted, true);
    current = true; assert.equal(runtime.isVisible(), false, 'a failed indicator must not revive its old epoch');
    finish(); assert.ok(await action); await runtime.dispose();
  }
  {
    const f = fixture({ reclaimError: true });
    const runtime = new DesktopActivityRuntime({ labels, releaseAll: async () => {},
      createIndicator: (stop, unavailable) => new WaylandStopIndicator(opts(f, { stop, unavailable, verifyVisible: undefined })) });
    runtime.turns.begin('worker', 'turn', () => true);
    await runtime.turns.use('worker', 'turn', 'fixture', async () => 'done', false);
    await assert.rejects(runtime.dispose(), /cleanup is unconfirmed/, 'host disposal must await the helper process');
  }
  console.log('Wayland Stop: simulated mapped controls, optional proof, health and cancellation passed; native Wayland not exercised');
} finally { clearInterval(keepAlive); removeWorkspaceFixture(temp, 'desktop-wayland-stop-'); }
