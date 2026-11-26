import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'platform-escape-availability-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { platformEscapeAvailability, preflightMacInputMonitoring, nativeMacInputPreflight } = await import(
    pathToFileURL(compile('main/desktop/platformEscapeAvailability.ts'))
  );

  let calls = 0;
  let loaded;
  assert.equal(await nativeMacInputPreflight(name => {
    loaded = name;
    return { func: (symbol, result, parameters) => {
      assert.equal(symbol, 'CGPreflightListenEventAccess');
      assert.equal(result, 'bool');
      assert.deepEqual(parameters, []);
      return () => true;
    } };
  }), true);
  assert.equal(loaded, '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  await assert.rejects(nativeMacInputPreflight(() => ({ func: () => () => 1 })), /Invalid/);
  const granted = () => { calls++; return true; };
  const mac = await platformEscapeAvailability({ platform: 'darwin', env: {}, macInputPreflight: granted });
  assert.equal(calls, 1);
  assert.deepEqual(mac.macInputMonitoring, { permission: 'granted', subject: 'calling-process' });
  assert.equal(mac.escapeAvailable, false, 'permission alone must never enable Escape');
  assert.equal(mac.listener, 'handled-elsewhere');
  assert.equal(mac.reason, 'macos-listener-managed-separately');
  assert.match(mac.remediation, /separate listener/);
  assert.match(mac.remediation, /Synthetic input cannot be reliably distinguished/);
  assert.equal(mac.injectedInputFilter, 'unavailable');
  assert.equal(mac.indicatorVisibility, 'not-checked');

  const required = await platformEscapeAvailability({ platform: 'darwin', env: {}, macInputPreflight: () => false });
  assert.equal(required.macInputMonitoring.permission, 'required');
  assert.match(required.remediation, /Input Monitoring/);
  const failed = await platformEscapeAvailability({ platform: 'darwin', env: {}, macInputPreflight: () => { throw new Error('symbol missing'); } });
  assert.equal(failed.macInputMonitoring.permission, 'unknown', 'native errors are not user denial');
  assert.equal(await preflightMacInputMonitoring('darwin', () => undefined), 'unknown');
  assert.equal(await preflightMacInputMonitoring('darwin', async () => { throw new Error('missing Koffi'); }), 'unknown');
  if (process.platform !== 'darwin') {
    assert.equal(await preflightMacInputMonitoring('darwin'), 'unknown', 'an unavailable native framework must be reported');
  }
  assert.equal(await preflightMacInputMonitoring('linux', granted), 'unknown');
  assert.equal(calls, 1, 'the macOS native API must not run on another platform');

  const x11 = await platformEscapeAvailability({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, macInputPreflight: granted });
  assert.equal(x11.runtime, 'linux-x11');
  assert.equal(x11.reason, 'x11-listener-managed-separately');
  assert.equal(x11.listener, 'handled-elsewhere');
  assert.match(x11.remediation, /Synthetic input cannot be reliably distinguished/);
  assert.equal(x11.escapeAvailable, false);
  assert.equal((await platformEscapeAvailability({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' } })).reason, 'x11-display-unavailable');

  const wayland = await platformEscapeAvailability({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } });
  assert.equal(wayland.runtime, 'linux-wayland', 'XWayland is not native Wayland coverage');
  assert.equal(wayland.escapeAvailable, false);
  assert.equal(wayland.indicatorVisibility, 'not-checked');
  assert.match(wayland.remediation, /visible stop control separately/);
  assert.equal((await platformEscapeAvailability({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' } })).runtime, 'linux-unknown');
  assert.equal((await platformEscapeAvailability({ platform: 'linux', env: {} })).reason, 'linux-session-unknown');
  assert.equal((await platformEscapeAvailability({ platform: 'win32', env: {} })).listener, 'handled-elsewhere');
  assert.equal((await platformEscapeAvailability({ platform: 'freebsd', env: {} })).reason, 'platform-unsupported');
  assert.equal(calls, 1);
  console.log('platform Escape availability: permission, provenance and visibility boundaries passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
