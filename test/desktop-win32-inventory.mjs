import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-win32-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { enumerateWin32Windows, collectWin32Windows } = await import(pathToFileURL(compile('main/desktop/win32Inventory.ts')));
  let closes = 0;
  const fake = {
    enumerate: callback => { for (const handle of [1n, 2n, 3n, 4n]) if (!callback(handle)) return 0; return 1; },
    visible: handle => handle !== 4n, valid: () => 1, minimized: handle => handle === 2n,
    rect: (handle, out) => { if (handle === 3n) return 0; Object.assign(out, { left: -10, top: 20, right: 90, bottom: 70 }); return 1; },
    windowPid: (handle, out) => { out[0] = Number(handle) + 100; return 1; },
    titleLength: () => 5, title: (_handle, buffer) => { buffer.write('Hello', 0, 'utf16le'); return 5; }, dpi: () => 144,
    openProcess: (_access, _inherit, pid) => pid === 102 ? null : 9n,
    image: (_process, _flags, buffer, length) => { length[0] = buffer.write('C:\\app.exe', 0, 'utf16le') / 2; return 1; },
    times: (_process, created) => { created.low = 1; created.high = 2; return 1; }, closeHandle: () => { closes++; return 1; }
  };
  const simulated = collectWin32Windows(fake);
  assert.equal(simulated.complete, false); assert.equal(simulated.omitted, 1); assert.equal(simulated.windows.length, 2);
  assert.deepEqual(simulated.windows[0].bounds, { x: -10, y: 20, width: 100, height: 50 });
  assert.equal(simulated.windows[0].title, 'Hello'); assert.equal(simulated.windows[0].dpi, 144);
  assert.ok(simulated.windows[1].limitations.includes('process_identity_unavailable'));
  assert.ok(simulated.windows[1].limitations.includes('window_minimized'));
  assert.equal(closes, 2);
  assert.ok(collectWin32Windows(fake, 1).limitations.includes('inventory_truncated'));
  assert.throws(() => collectWin32Windows({ ...fake, enumerate: () => 0 }), /failed/);
  assert.throws(() => collectWin32Windows({ ...fake, closeHandle: () => 0 }), /close process query handle/);
  const missingDpi = collectWin32Windows({ ...fake, dpi: null });
  assert.ok(missingDpi.windows.every(window => window.limitations.includes('dpi_unavailable')));
  const counts = new Map();
  const stale = collectWin32Windows({ ...fake, windowPid: (handle, out) => {
    const count = (counts.get(handle) ?? 0) + 1; counts.set(handle, count);
    out[0] = Number(handle) + 100 + (handle === 1n && count > 1 ? 100 : 0); return 1;
  } });
  assert.equal(stale.windows.some(window => window.nativeHandle === '0x1'), false);
  assert.equal(stale.omitted, 2);
  let timeReads = 0;
  const reused = collectWin32Windows({ ...fake, times: (_process, created) => { created.low = 1; created.high = ++timeReads; return 1; } });
  assert.equal(reused.windows.some(window => window.nativeHandle === '0x1'), false);
  assert.equal(reused.omitted, 2);
  if (process.platform !== 'win32') {
    assert.throws(() => enumerateWin32Windows(), /unavailable on this platform/);
    console.log('desktop Win32 inventory: unsupported platform path passed; no native Windows test');
  } else {
    assert.throws(() => enumerateWin32Windows(0), /Invalid/);
    assert.throws(() => enumerateWin32Windows(2001), /Invalid/);
    const result = enumerateWin32Windows();
    assert.ok(result.windows.length > 0, 'real desktop must expose at least one visible window for this test');
    assert.ok(result.limitations.includes('window_incarnation_unverified'));
    for (const window of result.windows) {
      assert.match(window.nativeHandle, /^0x[0-9a-f]+$/);
      assert.ok(window.pid > 0 && window.bounds.width > 0 && window.bounds.height > 0);
      assert.equal(window.coordinateSpace, 'win32-screen-caller-dpi');
      assert.ok(window.limitations.includes('window_incarnation_unverified'));
      if (!window.processImage || !window.processCreated) assert.ok(window.limitations.includes('process_identity_unavailable'));
    }
    const limited = enumerateWin32Windows(1);
    assert.ok(limited.windows.length <= 1);
    if (result.windows.length > 1) assert.ok(limited.limitations.includes('inventory_truncated'));
    console.log(`desktop Win32 inventory: real visible-window metadata passed (${result.windows.length} observations); handles remain non-actionable`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
