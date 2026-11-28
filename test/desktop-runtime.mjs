import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-runtime-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { desktopRuntime, unavailableDesktopCapabilities, desktopOperationCapabilities } = await import(pathToFileURL(compile('main/desktop/runtime.ts')));
  assert.equal(desktopRuntime('win32', {}), 'windows');
  assert.equal(desktopRuntime('darwin', {}), 'macos');
  assert.equal(desktopRuntime('linux', { DISPLAY: ':0' }), 'linux-x11');
  assert.equal(desktopRuntime('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), 'linux-wayland');
  assert.equal(desktopRuntime('linux', { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }), 'linux-wayland');
  assert.equal(desktopRuntime('linux', { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }), 'linux-unknown');
  assert.equal(desktopRuntime('linux', {}), 'linux-unknown');
  assert.equal(desktopRuntime('freebsd', {}), 'unsupported');
  for (const runtime of ['windows', 'macos', 'linux-x11', 'linux-wayland', 'linux-unknown', 'unsupported']) {
    const capabilities = unavailableDesktopCapabilities(runtime);
    assert.equal(Object.keys(capabilities).length, 7);
    for (const status of Object.values(capabilities)) {
      assert.equal(status.available, false);
      assert.equal(status.backend, null);
      assert.equal(status.limitation, 'capability_unsupported');
      assert.ok(status.remediation.length > 0);
    }
  }
  for (const runtime of ['macos', 'linux-unknown', 'unsupported']) {
    assert.ok(Object.values(desktopOperationCapabilities(runtime, { capture: true, control: true })).every(status => !status.available));
  }
  const missing = desktopOperationCapabilities('windows', { capture: false, control: true });
  assert.equal(missing.capture.available, false);
  assert.equal(missing.foregroundInput.available, false);
  const captureOnly = desktopOperationCapabilities('windows', { capture: true, control: false });
  assert.equal(captureOnly.capture.available, true);
  assert.equal(captureOnly.foregroundInput.available, false);
  assert.equal(captureOnly.capture.grant, 'required');
  const visible = desktopOperationCapabilities('windows', { capture: true, control: true, visible: true, semantic: true });
  assert.equal(visible.capture.grant, 'not-required');
  assert.equal(visible.foregroundInput.grant, 'not-required');
  assert.equal(visible.foregroundInput.displayActions.hover, true);
  assert.equal(visible.semanticRead.backend, 'cua-driver');
  assert.equal(visible.semanticAct.available, true);
  assert.equal(desktopOperationCapabilities('windows', { capture: false, control: true, visible: true, semantic: true }).semanticRead.available, false);
  for (const runtime of ['linux-x11', 'linux-wayland']) {
    const linux = desktopOperationCapabilities(runtime, { capture: true, control: false, semantic: true, windowCapture: true });
    assert.equal(linux.capture.backend, 'electron');
    assert.equal(linux.windowCapture.backend, 'cua-driver');
    assert.equal(linux.windowCapture.grant, 'unknown');
    assert.equal(linux.foregroundInput.limitation, 'capture_bound_click_only');
    assert.equal(linux.foregroundInput.displayActions.scroll, false);
    assert.equal(linux.activate.available, false);
  }
  const mac = (status) => desktopOperationCapabilities('macos', { capture: true, control: true, semantic: true, mac: status });
  const notGranted = mac({ permissions: { screenRecording: false, accessibility: true } });
  assert.equal(notGranted.capture.limitation, 'permission_required');
  assert.match(notGranted.capture.remediation, /Screen & System Audio Recording.*Privacy & Security/);
  assert.equal(notGranted.foregroundInput.available, false);
  const screenshotOnly = mac({ permissions: { screenRecording: true, accessibility: false } });
  assert.equal(screenshotOnly.capture.available, true);
  assert.equal(screenshotOnly.semanticRead.limitation, 'permission_required');
  assert.match(screenshotOnly.activate.remediation, /Accessibility/);
  const permissions = { screenRecording: true, accessibility: true };
  assert.equal(mac({ permissions }).foregroundInput.grant, 'unknown');
  const granted = mac({ permissions, driverPermissions: permissions });
  assert.equal(granted.foregroundInput.available, true);
  assert.deepEqual(granted.foregroundInput.displayActions, { type: true, key: true, scroll: true, drag: true, move: false, hover: false });
  const driverMissing = mac({ permissions, driverPermissions: { ...permissions, accessibility: false } });
  assert.equal(driverMissing.capture.available, true);
  assert.equal(driverMissing.foregroundInput.grant, 'required');
  assert.equal(driverMissing.foregroundInput.source, 'driver');
  assert.equal(mac({ permissions, driverPermissionError: 'Driver read failed' }).foregroundInput.limitation, 'permission_check_failed');
  assert.equal(mac({ permissions, driverPermissions: permissions, secureInput: true }).foregroundInput.limitation, 'secure_input_active');
  assert.equal(mac({ permissions, driverPermissions: permissions, secureInput: true }).capture.available, true);
  assert.equal(mac({ permissions, screenLocked: true }).foregroundInput.limitation, 'screen_locked');
  assert.equal(mac({ permissions, screenLocked: true }).capture.available, true);
  assert.equal(mac({ permissions, driverError: 'Prepare the pinned driver' }).foregroundInput.limitation, 'dependency_missing');
  assert.equal(mac({ permissions, driverError: 'Prepare the pinned driver' }).capture.available, true);
  assert.equal(mac({ permissions, targetError: 'No AX adapter' }).activate.limitation, 'capability_unsupported');
  assert.equal(mac({}).capture.limitation, 'permission_check_failed');
  assert.match(unavailableDesktopCapabilities('linux-wayland').capture.remediation, /XWayland/);
  for (const capability of ['semanticAct', 'foregroundInput', 'backgroundInput']) {
    const status = unavailableDesktopCapabilities('linux-wayland')[capability];
    assert.equal(status.limitation, 'capability_unsupported');
    assert.match(status.remediation, /Native Wayland input is unavailable/);
    assert.match(status.remediation, /visible stop control/);
    assert.match(status.remediation, /XWayland only applies to X11 clients/);
  }
  console.log('desktop runtime: cross-platform unsupported matrix and Wayland detection passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
