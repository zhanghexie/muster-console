import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-setup-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = name => import(pathToFileURL(compile(`main/${name}.ts`)));
  const { readDesktopSetup, desktopSetupIssue, openDesktopPermissionSettings } = await load('desktop/desktopSetup');
  const { desktopRuntime } = await load('desktop/runtime');
  const { isWebIpcAllowed } = await load('ipc/accessPolicy');
  const { attachEventRelay, onWebEventBroadcast } = await load('webAccess/relay');
  const { readCuaMacPermissions } = await load('desktop/macVisibleControl');
  const noOperation = () => assert.fail('setup must not perform a desktop operation');
  const wired = {
    desktopScreen: noOperation, desktopTurns: noOperation,
    desktopWindowList: noOperation, desktopSemanticControl: noOperation
  };
  let native = { permissions: { screenRecording: false, accessibility: false } };
  let driver = { screenRecording: true, accessibility: true };
  let checks = 0;
  const mac = { ...wired, desktopMac: { status: () => native, checkDriverPermissions: async () => { checks++; return driver; } } };
  const probe = (host = mac, isPackaged = false) => readDesktopSetup(host, 'macos', isPackaged, noOperation);
  const missing = (...permissions) => ({ code: 'permission_required', permissions });
  const signal = new AbortController().signal;
  assert.deepEqual(await readCuaMacPermissions({ async call(name, args, receivedSignal) {
    assert.equal(name, 'check_permissions');
    assert.deepEqual(args, { prompt: false });
    assert.equal(receivedSignal, signal);
    return { structuredContent: { screen_recording: true, accessibility: false } };
  } }, signal), { screenRecording: true, accessibility: false });
  await assert.rejects(readCuaMacPermissions({ async call() {
    return { structuredContent: { screen_recording: 'unknown', accessibility: false } };
  } }, signal), /invalid macOS permission status/);
  assert.deepEqual(await probe(), { macApp: 'electron', issues: [{ ...missing('screenRecording', 'accessibility'), source: 'host' }] });
  assert.equal(checks, 0);
  native = { permissions: { screenRecording: true, accessibility: false }, driverError: 'Missing pinned Cua driver' };
  assert.deepEqual(await probe(mac, true), { macApp: 'muster', issues: [
    { code: 'dependency_missing', detail: 'Missing pinned Cua driver' }, { ...missing('accessibility'), source: 'host' }
  ] });
  native = { permissionError: 'Native read failed' };
  assert.deepEqual((await probe()).issues, [{ code: 'permission_check_failed', source: 'host', detail: 'Native read failed' }]);
  native = { permissions: { screenRecording: true, accessibility: true } };
  driver = { screenRecording: true, accessibility: false };
  assert.deepEqual((await probe()).issues, [{ ...missing('accessibility'), source: 'driver' }], 'the embedded driver can still report a missing grant');
  driver.accessibility = true;
  assert.deepEqual((await probe()).issues, [], 'refresh must query grants again instead of trusting the prior result');
  assert.equal(checks, 2);
  native.secureInput = true;
  assert.deepEqual((await probe()).issues, [{ code: 'secure_input_active' }]);
  assert.equal((await probe({ ...wired })).issues[0].code, 'capability_unsupported');

  for (const [platform, env] of [['win32', {}], ['linux', { DISPLAY: ':0' }], ['linux', { WAYLAND_DISPLAY: 'wayland-0' }]]) {
    const runtime = desktopRuntime(platform, env);
    assert.deepEqual(await readDesktopSetup(wired, runtime, true, () => 'driver'), { issues: [] });
    const absent = await readDesktopSetup(wired, runtime, true, () => { throw new Error('Missing pinned Cua driver'); });
    assert.deepEqual(absent, { issues: [{ code: 'dependency_missing', detail: 'Missing pinned Cua driver' }] });
    assert.equal((await readDesktopSetup({}, runtime, false, noOperation)).issues[0].code, 'capability_unsupported');
    assert.equal(desktopSetupIssue({ ok: false, ...missing('accessibility') }, platform), undefined);
    assert.deepEqual(await openDesktopPermissionSettings(platform, 'accessibility', noOperation), { ok: false, code: 'unsupported_platform' });
  }
  assert.equal((await readDesktopSetup({}, desktopRuntime('linux', {}), false, noOperation)).issues[0].code, 'capability_unsupported');
  assert.deepEqual(desktopSetupIssue({ ok: false, ...missing('accessibility', 'accessibility', 'unknown') }, 'darwin'), missing('accessibility'));
  assert.deepEqual(desktopSetupIssue({ ok: true, windowsCode: 'permission_required' }, 'darwin'), { ...missing('accessibility'), source: 'host' });
  assert.deepEqual(desktopSetupIssue({ ok: false, ...missing('accessibility'), source: 'driver' }, 'darwin'), { ...missing('accessibility'), source: 'driver' });
  assert.equal(desktopSetupIssue({ ok: false, code: 'secure_input_active' }, 'darwin').code, 'secure_input_active');
  assert.equal(desktopSetupIssue({ ok: true, capabilities: { capture: missing('screenRecording') } }, 'darwin'), undefined);
  assert.deepEqual(desktopSetupIssue({ ok: false, code: 'permission_check_failed', message: 'Read failed' }, 'darwin'),
    { code: 'permission_check_failed', detail: 'Read failed' });

  const opened = [];
  const open = permission => openDesktopPermissionSettings('darwin', permission, async url => opened.push(url));
  assert.deepEqual(await open('screenRecording'), { ok: true });
  assert.deepEqual(await open('accessibility'), { ok: true });
  assert.deepEqual(await open('x-apple.systempreferences:other'), { ok: false, code: 'invalid_permission' });
  assert.deepEqual(await open('constructor'), { ok: false, code: 'invalid_permission' });
  assert.deepEqual(await openDesktopPermissionSettings('darwin', 'screenRecording', async () => { throw new Error('System Settings launch failed'); }),
    { ok: false, code: 'open_failed' });
  assert.deepEqual(opened, [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
  ]);
  assert.equal(isWebIpcAllowed('desktopSetup:status', []), false);
  assert.equal(isWebIpcAllowed('desktopSetup:openSettings', ['accessibility']), false);
  assert.equal(isWebIpcAllowed('desktopSetup:requestPermission', ['accessibility']), false);
  assert.equal(isWebIpcAllowed('desktopSetup:revealApp', []), false);
  const local = [], web = [];
  const win = { webContents: { send: (...message) => local.push(message) } };
  attachEventRelay(win);
  const dispose = onWebEventBroadcast((...message) => web.push(message));
  win.webContents.send('ui:desktopSetup', { issues: [missing('accessibility')] });
  dispose();
  assert.equal(local.length, 1);
  assert.equal(web.length, 0);
  console.log('desktop setup: fresh permissions, capability reasons, allowed settings links and local-only transport passed');
} finally { removeWorkspaceFixture(temp, 'desktop-setup-'); }
