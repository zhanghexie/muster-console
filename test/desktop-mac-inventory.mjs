import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-mac-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { collectMacWindows, enumerateMacWindows } = await import(pathToFileURL(compile('main/desktop/macInventory.ts')));
  let closed = 0;
  const valid = { windowId: 42, pid: 17, ownerName: 'App', title: null, bounds: { x: -200, y: 10, width: 640, height: 480 } };
  const rows = [valid, { ...valid, windowId: 43, title: 'x'.repeat(1025), ownerName: null }, null, { ...valid, windowId: 42 }];
  const source = { count: () => rows.length, read: index => rows[index], close: () => { closed++; } };
  const result = collectMacWindows(source);
  assert.equal(closed, 1); assert.equal(result.complete, false); assert.equal(result.omitted, 2);
  assert.equal(result.windows.length, 2); assert.equal(result.windows[0].nativeHandle, '42');
  assert.deepEqual(result.windows[0].bounds, valid.bounds);
  assert.ok(result.windows[0].limitations.includes('window_name_unavailable'));
  assert.ok(result.windows[1].limitations.includes('owner_name_unavailable'));
  assert.ok(result.windows[1].limitations.includes('name_truncated'));
  assert.ok(result.windows.every(window => window.limitations.includes('window_incarnation_unverified')));
  assert.ok(collectMacWindows(source, 1).limitations.includes('inventory_truncated'));
  assert.throws(() => collectMacWindows(source, 0), /Invalid/);
  assert.throws(() => collectMacWindows({ ...source, read: () => { throw new Error('failed'); } }), /failed/);
  assert.equal(closed, 4);
  if (process.platform !== 'darwin') assert.throws(() => enumerateMacWindows(), /unavailable on this platform/);
  else {
    const native = enumerateMacWindows();
    assert.ok(native.limitations.includes('window_incarnation_unverified'));
    assert.ok(native.windows.every(window => window.coordinateSpace === 'coregraphics-screen-space'));
  }
  console.log(process.platform === 'darwin' ? 'desktop macOS inventory: native and error paths passed' : 'desktop macOS inventory: simulated paths passed; no macOS native test');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
