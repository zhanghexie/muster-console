import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { acquireTestLease } from './helpers/lease.mjs';

const releaseLease = acquireTestLease(process.cwd());
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-mac-window-identity-'));

try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { MacWindowIdentity } = await import(pathToFileURL(compile('main/desktop/macWindowIdentity.ts')));

  let permissions = { accessibility: true, screen: true };
  let appEpoch = 'app-1';
  let windowEpoch = 'window-1';
  let owned = true;
  let openSnapshots = 0;
  let closedSnapshots = 0;
  let releasedApps = 0;
  let releasedWindows = 0;
  let appSequence = 0;
  const makeApp = epoch => ({ kind: 'app', epoch, sequence: ++appSequence });
  const makeWindow = epoch => ({ kind: 'window', epoch });
  const native = {
    accessibilityTrusted: () => permissions.accessibility,
    screenCaptureTrusted: () => permissions.screen,
    retainRunningApplication: () => makeApp(appEpoch),
    applicationTerminated: application => application?.kind !== 'app' || application.epoch !== appEpoch,
    sameApplication: (left, right) => left?.kind === 'app' && right?.kind === 'app' && left.epoch === right.epoch,
    releaseApplication: application => { if (application?.kind === 'app') releasedApps++; },
    openAxWindows: () => {
      openSnapshots++;
      const windows = owned ? [makeWindow(windowEpoch)] : [];
      return { windows, close: () => { closedSnapshots++; } };
    },
    axWindowPid: window => window?.kind === 'window' ? 4242 : null,
    axWindowId: window => window?.kind === 'window' ? 77 : null,
    sameAxWindow: (left, right) => left?.kind === 'window' && right?.kind === 'window' && left.epoch === right.epoch,
    retainAxWindow: window => window?.kind === 'window' ? { ...window, retained: true } : null,
    releaseAxWindow: window => { if (window?.retained === true) releasedWindows++; },
    isWindowOwnedBy: (pid, windowId) => pid === 4242 && windowId === 77 && owned
  };

  const identity = MacWindowIdentity.acquire(native, 4242, 77);
  assert.deepEqual({ pid: identity.pid, windowId: identity.windowId }, { pid: 4242, windowId: 77 });
  assert.equal(identity.current(), true, 'a stable process/window pair is current');
  assert.ok(openSnapshots >= 2 && closedSnapshots === openSnapshots, 'each AX snapshot is closed');

  // The host checks the retained process/window before and after capture and
  // before/after each action. A same-numbered window incarnation invalidates it.
  windowEpoch = 'window-2';
  assert.equal(identity.current(), false, 'same CGWindowID after recreation is stale');
  windowEpoch = 'window-1';
  assert.equal(identity.current(), false, 'a failed identity check cannot revive');
  const appsBeforeClose = releasedApps;
  identity.close();
  identity.close();
  assert.equal(releasedApps, appsBeforeClose + 1); assert.equal(releasedWindows, 1);

  const processIdentity = MacWindowIdentity.acquire(native, 4242, 77);
  appEpoch = 'app-2';
  assert.equal(processIdentity.current(), false, 'PID reuse with a new NSRunningApplication is stale');
  appEpoch = 'app-1';
  assert.equal(processIdentity.current(), false, 'a process proof cannot revive after failure');
  const processAppsBeforeClose = releasedApps;
  processIdentity.close();
  assert.equal(releasedApps, processAppsBeforeClose + 1); assert.equal(releasedWindows, 2);

  permissions = { accessibility: false, screen: true };
  assert.throws(() => MacWindowIdentity.acquire(native, 4242, 77), /Accessibility.*Screen Recording/);
  permissions = { accessibility: true, screen: false };
  assert.throws(() => MacWindowIdentity.acquire(native, 4242, 77), /Accessibility.*Screen Recording/);
  permissions = { accessibility: true, screen: true };
  owned = false;
  assert.throws(() => MacWindowIdentity.acquire(native, 4242, 77), /owner/);
  owned = true;

  const ambiguous = {
    ...native,
    openAxWindows: () => ({ windows: [makeWindow('a'), makeWindow('b')], close: () => { closedSnapshots++; } })
  };
  assert.throws(() => MacWindowIdentity.acquire(ambiguous, 4242, 77), /Ambiguous/);

  const cleanupFailure = MacWindowIdentity.acquire(native, 4242, 77);
  const releaseWindow = native.releaseAxWindow;
  native.releaseAxWindow = () => { throw new Error('AX release failed'); };
  assert.throws(() => cleanupFailure.close(), /release/);
  native.releaseAxWindow = releaseWindow;

  assert.throws(() => MacWindowIdentity.acquire(native, 0, 77), /Invalid/);
  assert.throws(() => MacWindowIdentity.acquire(native, 4242, 0), /Invalid/);
  assert.ok(releasedApps >= 3 && releasedWindows >= 2);
  console.log('desktop macOS window identity: mocked permission, process/window incarnation, stale and cleanup paths passed; no macOS native test');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
  releaseLease();
}
