import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, '.tmp', 'desktop-inventory-process-'));
try {
  const compile = createSharedCompiler(root, path.join(temp, 'compiled'));
  const { runDesktopInventory } = await import(pathToFileURL(compile('main/desktop/inventoryProcess.ts')));
  const workerFile = path.join(temp, 'inventory-worker.cjs');
  const worker = { file: workerFile, limit: 1, timeoutMs: 1000 };
  const sample = runtime => ({ windows: [{ nativeHandle: 'private', title: 'Example', pid: 42,
    ...(runtime === 'macos' ? { windowId: 1, ownerName: 'Example app' } : { processImage: null }),
    bounds: { x: -5, y: 10, width: 80, height: 40 }, coordinateSpace: runtime === 'windows' ? 'win32-screen-caller-dpi' : runtime === 'macos' ? 'coregraphics-screen-space' : 'x11-root-pixels', limitations: [] }],
    complete: true, omitted: 0, limitations: [] });
  const makeLaunch = run => (_file, args, options) => {
    assert.deepEqual(args, ['1']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(options.env.NODE_OPTIONS, undefined);
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
    child.kill = () => { child.killed = true; return true; };
    queueMicrotask(() => run(child));
    return child;
  };
  for (const [platform, env, runtime] of [
    ['win32', { NODE_OPTIONS: '--bad' }, 'windows'], ['darwin', {}, 'macos'],
    ['linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':1' }, 'linux-x11']
  ]) {
    const result = await runDesktopInventory({ workerFile: worker.file, limit: worker.limit, timeoutMs: worker.timeoutMs, platform, env,
      launch: makeLaunch(child => { child.emit('message', { ok: true, runtime, result: sample(runtime) }); child.exitCode = 0; child.emit('close', 0); }) });
    assert.equal(result.runtime, runtime);
    assert.equal(result.observations.length, 1);
    if (runtime === 'macos') assert.equal(result.observations[0].appLabel, 'Example app');
    assert.equal('nativeHandle' in result.observations[0], false);
    assert.ok(Object.values(result.capabilities).every(value => value.available === false));
  }
  assert.throws(() => runDesktopInventory({ workerFile, platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':1' } }), /linux-wayland/);
  assert.throws(() => runDesktopInventory({ workerFile, platform: 'linux', env: {} }), /linux-unknown/);
  await assert.rejects(runDesktopInventory({ workerFile, limit: 1, platform: 'win32', env: {},
    launch: makeLaunch(child => { child.emit('message', { ok: true, runtime: 'macos', result: sample('macos') }); child.exitCode = 0; child.emit('close', 0); }) }), /valid response/);
  await assert.rejects(runDesktopInventory({ workerFile, limit: 1, platform: 'win32', env: {},
    launch: makeLaunch(child => { child.emit('message', { ok: true, runtime: 'windows', result: sample('windows') }); child.emit('message', {}); }) }), /multiple responses/);
  await assert.rejects(runDesktopInventory({ workerFile, limit: 1, platform: 'win32', env: {},
    launch: makeLaunch(child => { child.emit('message', { ok: false, error: 'native permission denied' }); child.exitCode = 1; child.emit('close', 1); }) }), /native permission denied/);
  await assert.rejects(runDesktopInventory({ workerFile, limit: 1, platform: 'win32', env: {},
    launch: makeLaunch(child => { const invalid = sample('windows'); invalid.windows[0].bounds.width = -1;
      child.emit('message', { ok: true, runtime: 'windows', result: invalid }); child.exitCode = 0; child.emit('close', 0); }) }), /Invalid desktop inventory response/);
  await assert.rejects(runDesktopInventory({ workerFile, limit: 1, platform: 'win32', env: {},
    launch: makeLaunch(child => { child.exitCode = 0; child.emit('close', 0); }) }), /without a valid response/);
  await assert.rejects(runDesktopInventory({ workerFile, limit: 1, timeoutMs: 10, platform: 'win32', env: {}, launch: makeLaunch(() => {}) }), /timed out.*termination requested/);
  const controller = new AbortController();
  const cancelled = runDesktopInventory({ workerFile, limit: 1, platform: 'win32', env: {}, signal: controller.signal, launch: makeLaunch(() => {}) });
  controller.abort(); await assert.rejects(cancelled, /cancelled.*termination requested/);
  if (process.platform === 'win32') {
    await build({ entryPoints: [path.join(root, 'src/main/desktop/inventoryWorker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: workerFile, packages: 'external', logLevel: 'silent' });
    const real = await runDesktopInventory({ workerFile, limit: 50, timeoutMs: 15_000 });
    assert.equal(real.runtime, 'windows');
    assert.ok(real.observations.every(item => !('nativeHandle' in item)));
    console.log(`desktop inventory process: Windows child returned ${real.observations.length} metadata observations`);
  } else console.log('desktop inventory process: real Windows child not run on this platform');
  console.log('desktop inventory process: platform branches, errors, cancellation and timeout passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
