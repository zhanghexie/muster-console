import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-cua-apps-'));
const keepAlive = setInterval(() => {}, 1000);
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { CuaAppDiscovery, CuaAppDiscoveryError } = await import(pathToFileURL(compile('main/desktop/cuaAppDiscovery.ts')));
  const { CuaTransport } = await import(pathToFileURL(compile('main/desktop/cuaTransport.ts')));
  const { ManagedStdioTransport } = await import(pathToFileURL(compile('main/desktop/managedStdioTransport.ts')));
  const { spawnOwnedProcess } = await import(pathToFileURL(compile('main/agentSession/process/owner.ts')));
  const actor = (overrides = {}) => ({ sessionId: 'session', taskId: 'task', turnId: 'turn', isCurrent: () => true, ...overrides });
  const row = (name, running = true, extras = {}) => ({ name, pid: running ? 123 : 0, running, active: false,
    kind: 'desktop', bundle_id: 'private.bundle', launch_path: '/private/secret', windows: [{ title: 'private title' }], ...extras });
  const response = apps => ({ structuredContent: { apps, processes: [{ name: 'ignored private process', pid: 999 }] } });
  const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const fixture = (config = {}) => {
    let creates = 0, connects = 0, calls = 0, closes = 0;
    const factory = () => {
      creates++;
      return { async connect() { connects++; if (config.connect) return config.connect(); },
        async call(name, args, signal) { calls++; assert.equal(name, 'list_apps'); assert.deepEqual(args, {}); assert.ok(signal);
          return config.call ? config.call(signal) : (Object.hasOwn(config, 'response') ? config.response : response([])); },
        async close() { closes++; if (config.close) return config.close(); } };
    };
    return { factory, get creates() { return creates; }, get connects() { return connects; }, get calls() { return calls; }, get closes() { return closes; } };
  };
  const options = (f, extra = {}) => ({ createConnection: f.factory, platform: 'win32', ttlMs: 1000,
    requestTimeoutMs: 400, cleanupTimeoutMs: 200, ...extra });
  const code = expected => error => error instanceof CuaAppDiscoveryError && error.code === expected;
  const tick = () => new Promise(resolve => setImmediate(resolve));

  for (const platform of ['win32', 'darwin', 'linux']) {
    const f = fixture({ response: response([
      row('Fixture Browser', true, { active: true }), row('Fixture Editor', false, { kind: 'uwp' }),
      row('Other', true, { kind: null, bundle_id: null, launch_path: null }),
    ]) });
    const app = new CuaAppDiscovery(options(f, { platform, env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } }));
    const page = await app.discover(actor(), { query: 'fixture', limit: 1 });
    assert.equal(f.creates, 1); assert.equal(f.calls, 1); assert.equal(f.closes, 1, 'driver must close before result disclosure');
    assert.equal(page.total, 2); assert.equal(page.apps.length, 1); assert.equal(page.nextOffset, 1);
    assert.equal(page.apps[0].name, 'Fixture Browser'); assert.equal(page.apps[0].installed, null);
    assert.equal(page.apps[0].active, platform === 'linux' ? null : true);
    const next = app.page(actor(), page.snapshotId, page.nextOffset, 1);
    assert.equal(next.apps[0].installed, true); assert.equal(next.nextOffset, null);
    assert.equal(next.coverage.completeness, 'unverified');
    assert.equal(next.coverage.platform, platform);
    assert.equal(next.apps[0].appId, platform === 'darwin' ? 'private.bundle' : undefined);
    assert.ok(!JSON.stringify(next).includes('/private/secret'), 'no launch paths escape the host');
    assert.ok(!Object.hasOwn(next.apps[0], 'pid') && !Object.hasOwn(next.apps[0], 'windows'));
    assert.throws(() => app.page(actor({ taskId: 'other' }), page.snapshotId, 0), code('stale'));
    assert.throws(() => app.page(actor(), page.snapshotId, 99), code('invalid'));
    await app.close();
  }
  for (const [env, expected] of [
    [{ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, 'unknown'],
    [{ XDG_SESSION_TYPE: ' X11 ', DISPLAY: ':0' }, 'x11'],
    [{ XDG_SESSION_TYPE: 'x11' }, 'unknown'],
    [{ DISPLAY: ':0' }, 'x11'],
    [{ XDG_SESSION_TYPE: ' WAYLAND ', WAYLAND_DISPLAY: 'wayland-0' }, 'wayland'],
    [{ DISPLAY: ':0', WAYLAND_DISPLAY: '   ' }, 'x11']
  ]) {
    const f = fixture({ response: response([row('Fixture')]) });
    const app = new CuaAppDiscovery(options(f, { platform: 'linux', env }));
    const page = await app.discover(actor());
    assert.equal(page.coverage.session, expected, 'discovery must report the same Linux session as host capability detection');
    if (expected === 'unknown') assert.ok(page.coverage.limitations.includes('desktop_display_unavailable_or_unverified'));
    await app.close();
  }
  {
    const f = fixture({ response: response([row('Ｆｉｘｔｕｒｅ\u202E App', true), row('Fixture App', false)]) });
    const app = new CuaAppDiscovery(options(f));
    const page = await app.discover(actor(), { query: 'fixture', status: 'running' });
    assert.equal(page.total, 1); assert.equal(page.apps[0].running, true); assert.ok(!page.apps[0].name.includes('\u202e'));
    const installed = await app.discover(actor(), { status: 'installed_not_running' });
    assert.equal(installed.total, 1); assert.equal(installed.apps[0].installed, true);
    assert.throws(() => app.page(actor(), page.snapshotId, 0), code('stale'), 'new discovery retires old pages');
    await app.close();
  }
  {
    const rows = Array.from({ length: 5001 }, (_, i) => row(i === 5000 ? 'Only late match' : `Fixture ${i}`));
    const f = fixture({ response: response(rows) }), app = new CuaAppDiscovery(options(f));
    const page = await app.discover(actor(), { query: 'Only late match' });
    assert.equal(page.total, 0); assert.equal(page.coverage.sourceTruncated, true);
    const all = await app.discover(actor(), { limit: 50 });
    assert.equal(all.total, 2000); assert.equal(all.coverage.sourceTruncated, true); assert.equal(all.coverage.snapshotTruncated, true);
    await app.close();
  }
  {
    const f = fixture({ response: response(Array.from({ length: 50 }, (_, i) => row(`${i}-${'界'.repeat(160)}`))) });
    const app = new CuaAppDiscovery(options(f)); let page = await app.discover(actor(), { limit: 50 }), seen = 0;
    while (true) {
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8000); assert.ok(page.apps.length > 0); seen += page.apps.length;
      if (page.nextOffset === null) break;
      page = app.page(actor(), page.snapshotId, page.nextOffset, 50);
    }
    assert.equal(seen, 50); await app.close();
  }
  for (const invalid of [null, {}, { isError: true }, response([null]), response([{ name: 'x', pid: 1, running: false, active: false }]),
    response([{ name: 'x', pid: 1, running: true, active: 'yes' }])]) {
    const f = fixture({ response: invalid }), app = new CuaAppDiscovery(options(f));
    await assert.rejects(app.discover(actor()), code(invalid?.isError ? 'driver_error' : 'invalid_driver_response'));
    assert.equal(f.closes, 1); await app.close();
  }
  {
    const missing = Object.assign(new Error('PRIVATE PATH'), { code: 'ENOENT' });
    const f = fixture({ connect: () => Promise.reject(missing) }), app = new CuaAppDiscovery(options(f));
    await assert.rejects(app.discover(actor()), error => code('dependency_missing')(error) && !error.message.includes('PRIVATE'));
    assert.equal(f.closes, 1); await app.close();
  }
  {
    const gate = defer(), cleanup = defer(), external = new AbortController(), f = fixture({ connect: () => gate.promise, close: () => cleanup.promise });
    const app = new CuaAppDiscovery(options(f)); let settled = false;
    const pending = app.discover(actor(), {}, external.signal).finally(() => { settled = true; });
    await tick(); external.abort(); await tick(); assert.equal(f.closes, 1); assert.equal(settled, false, 'cancel waits for confirmed cleanup');
    cleanup.resolve(); await assert.rejects(pending, code('cancelled'));
    gate.resolve(); await tick(); assert.equal(f.calls, 0, 'late connect must not dispatch'); await app.close();
  }
  {
    const gate = defer(), lifetime = new AbortController(), f = fixture({ call: () => gate.promise });
    const app = new CuaAppDiscovery(options(f)); const pending = app.discover(actor({ lifetimeSignal: lifetime.signal }));
    await tick(); lifetime.abort(); await assert.rejects(pending, code('cancelled')); assert.equal(f.closes, 1);
    gate.resolve(response([row('late')])); await tick(); await app.close();
  }
  {
    const closing = defer(), started = defer(), controller = new AbortController();
    const f = fixture({ response: response([row('Fixture')]), close: () => { started.resolve(); return closing.promise; } });
    const app = new CuaAppDiscovery(options(f)), pending = app.discover(actor(), {}, controller.signal);
    await started.promise;
    controller.abort(); closing.resolve(); await assert.rejects(pending, code('cancelled'));
    assert.equal(f.closes, 1, 'cancellation while cleanup is pending must not disclose the result'); await app.close();
  }
  {
    let alive = true; const gate = defer(), f = fixture({ call: () => gate.promise });
    const app = new CuaAppDiscovery(options(f)), pending = app.discover(actor({ isCurrent: () => alive }));
    await tick(); alive = false; await assert.rejects(pending, code('cancelled')); assert.equal(f.closes, 1);
    gate.resolve(response([])); await app.close();
  }
  {
    const gate = defer(), f = fixture({ call: () => gate.promise }), app = new CuaAppDiscovery(options(f, { requestTimeoutMs: 30 }));
    await assert.rejects(app.discover(actor()), code('timeout')); assert.equal(f.closes, 1); gate.resolve(response([])); await app.close();
  }
  for (const cleanup of [() => Promise.reject(new Error('PRIVATE')), () => new Promise(() => {})]) {
    const failures = [], f = fixture({ response: response([row('Fixture')]), close: cleanup });
    const app = new CuaAppDiscovery(options(f, { cleanupTimeoutMs: 25, onCleanupError: error => failures.push(error.code) }));
    await assert.rejects(app.discover(actor()), error => code('cleanup_unconfirmed')(error) && !error.message.includes('PRIVATE'));
    await assert.rejects(app.discover(actor({ turnId: 'next' })), code('cleanup_unconfirmed'));
    await assert.rejects(app.close(), code('cleanup_unconfirmed')); assert.deepEqual(failures, ['cleanup_unconfirmed']);
  }
  {
    const controller = new AbortController(), f = fixture({ response: response([row('Fixture')]) }), app = new CuaAppDiscovery(options(f));
    const captured = actor({ lifetimeSignal: controller.signal }), page = await app.discover(captured);
    controller.abort(); assert.throws(() => app.page(captured, page.snapshotId, 0), code('stale'));
    await app.close();
  }
  {
    const controller = new AbortController(), f = fixture({ response: response([row('Fixture')]) }), app = new CuaAppDiscovery(options(f));
    const page = await app.discover(actor(), {}, controller.signal); controller.abort();
    assert.throws(() => app.page(actor(), page.snapshotId, 0), code('stale'));
    await app.close();
  }
  {
    const f = fixture({ response: response([row('Fixture')]) }), app = new CuaAppDiscovery(options(f));
    await assert.rejects(app.discover(actor(), {}, { aborted: false }), code('invalid'));
    await assert.rejects(app.discover(actor({ lifetimeSignal: { aborted: false, addEventListener() {}, removeEventListener() {} } })), code('invalid'));
    const page = await app.discover(actor()); assert.equal(page.total, 1); assert.equal(f.creates, 1, 'invalid signals must not leak an operation slot');
    await app.close();
  }
  {
    let now = 1000; const f = fixture({ response: response([row('Fixture')]) }), app = new CuaAppDiscovery(options(f, { ttlMs: 100, now: () => now }));
    const page = await app.discover(actor()); now += 101;
    assert.throws(() => app.page(actor(), page.snapshotId, 0), code('stale')); await app.close();
  }
  {
    const environment = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' };
    const f = fixture({ response: response([row('Fixture')]) }), app = new CuaAppDiscovery(options(f, { platform: 'linux', env: environment }));
    const page = await app.discover(actor()); environment.WAYLAND_DISPLAY = 'wayland-1';
    assert.throws(() => app.page(actor(), page.snapshotId, 0), code('stale'));
    await assert.rejects(app.discover(actor()), code('stale')); await app.close();
  }
  {
    const environment = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, gate = defer(), f = fixture({ call: () => gate.promise });
    const app = new CuaAppDiscovery(options(f, { platform: 'linux', env: environment })), pending = app.discover(actor());
    await tick(); environment.DISPLAY = ':1'; await assert.rejects(pending, code('stale')); assert.equal(f.closes, 1);
    gate.resolve(response([])); await app.close();
  }
  {
    const gate = defer(), f = fixture({ call: () => gate.promise }), app = new CuaAppDiscovery(options(f));
    const pending = app.discover(actor()); await tick();
    await assert.rejects(app.discover(actor()), code('busy'));
    const stopping = app.stopAll(); await assert.rejects(pending, code('cancelled')); await stopping;
    assert.equal(f.closes, 1); gate.resolve(response([])); await app.close();
  }
  {
    // Exercise this adapter through the real CuaTransport/ManagedStdioTransport
    // with a synthetic MCP server and child; it never enumerates real apps.
    const script = path.join(temp, 'fake-cua-mcp.cjs');
    fs.writeFileSync(script, `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio:'ignore' });
child.once('spawn', () => {
  process.stderr.write('CHILD ' + child.pid + '\\n');
  let pending = '';
  process.stdin.on('data', data => { pending += data; let end;
    while ((end = pending.indexOf('\\n')) >= 0) {
      const message = JSON.parse(pending.slice(0,end)); pending = pending.slice(end+1);
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,
        result:{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}})+'\\n');
      if (message.method === 'tools/call') { process.stderr.write('CALL\\n'); if (process.argv[2] !== 'hang')
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'fixture'}],
          structuredContent:{apps:[{name:'Synthetic Fixture',pid:0,running:false,active:false}]}}})+'\\n'); }
    }
  });
});
setInterval(() => {}, 1000);`);
    for (const mode of ['normal', 'hang']) {
      const called = defer(); let rootPid, childPid, buffer = '';
      const createConnection = () => new CuaTransport(process.execPath, process.env, () => ({
        client: new Client({ name: 'discovery-fixture', version: '1' }),
        transport: new ManagedStdioTransport(process.execPath, process.env, 150, [script, mode], config => {
          const owner = spawnOwnedProcess(config); rootPid = owner.child.pid;
          owner.child.stderr.on('data', chunk => {
            buffer += chunk.toString();
            const match = buffer.match(/CHILD (\d+)/); if (match) childPid = Number(match[1]);
            if (buffer.includes('CALL\n')) called.resolve();
          });
          return owner;
        }, path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1'))
      }));
      const app = new CuaAppDiscovery({ createConnection, platform: 'win32', requestTimeoutMs: 5000, cleanupTimeoutMs: 9000 });
      if (mode === 'normal') {
        const page = await app.discover(actor()); assert.equal(page.apps[0].name, 'Synthetic Fixture');
      } else {
        const controller = new AbortController(), pending = app.discover(actor(), {}, controller.signal);
        await called.promise; controller.abort(); await assert.rejects(pending, code('cancelled'));
      }
      assert.ok(rootPid && childPid);
      assert.throws(() => process.kill(rootPid, 0), /ESRCH/, 'the synthetic driver root must be gone before returning');
      assert.throws(() => process.kill(childPid, 0), /ESRCH/, 'the synthetic driver descendant must also be gone');
      await app.close();
    }
  }
  assert.throws(() => new CuaAppDiscovery({ platform: 'freebsd', createConnection: () => ({}) }), code('unsupported_platform'));
  assert.throws(() => new CuaAppDiscovery({ platform: 'win32' }), code('dependency_missing'));
  assert.throws(() => new CuaAppDiscovery({ platform: 'win32', binary: 'relative-driver' }), code('invalid'));
  console.log('Cua app discovery: platform projection, bounded snapshots, cancellation and cleanup simulations passed; no real app data or native cross-platform run');
} finally { clearInterval(keepAlive); removeWorkspaceFixture(temp, 'desktop-cua-apps-'); }
