import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { acquireTestLease } from './helpers/lease.mjs';

const releaseLease = acquireTestLease(process.cwd());
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-mac-semantic-target-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { resolveMacSemanticTarget } = await import(pathToFileURL(compile('main/desktop/macSemanticTarget.ts')));

  let appEpoch = 'app-1';
  let windowEpoch = 'window-1';
  let selectionLive = true;
  let actorLive = true;
  let releasedApps = 0;
  let releasedWindows = 0;
  const native = {
    accessibilityTrusted: () => true,
    screenCaptureTrusted: () => true,
    retainRunningApplication: () => ({ kind: 'app', epoch: appEpoch }),
    applicationTerminated: app => app?.epoch !== appEpoch,
    sameApplication: (left, right) => left?.kind === 'app' && right?.kind === 'app' && left.epoch === right.epoch,
    releaseApplication: () => { releasedApps++; },
    openAxWindows: () => ({ windows: [{ kind: 'window', epoch: windowEpoch }], close() {} }),
    axWindowPid: window => window?.kind === 'window' ? 4242 : null,
    axWindowId: window => window?.kind === 'window' ? 77 : null,
    sameAxWindow: (left, right) => left?.kind === 'window' && right?.kind === 'window' && left.epoch === right.epoch,
    retainAxWindow: window => ({ ...window, retained: true }),
    releaseAxWindow: () => { releasedWindows++; },
    isWindowOwnedBy: (pid, windowId) => pid === 4242 && windowId === 77
  };
  const actor = { sessionId: 'session', taskId: 'task', turnId: 'turn', isCurrent: () => actorLive };
  const selection = { pid: 4242, windowId: 77, generation: 'mac-generation-1', isCurrent: () => selectionLive };
  const selections = {
    resolve(sessionId, taskId, id) {
      assert.deepEqual({ sessionId, taskId, id }, { sessionId: 'session', taskId: 'task', id: 'opaque-selection' });
      return selection;
    }
  };

  const target = resolveMacSemanticTarget(native, selections, actor, 'opaque-selection');
  assert.deepEqual({ pid: target.pid, windowId: target.windowId, generation: target.generation },
    { pid: 4242, windowId: 77, generation: 'mac-generation-1' });
  assert.ok(target.limitations.includes('numeric_driver_identity_not_atomic'));
  assert.ok(target.limitations.includes('macos_native_adapter_requires_real_macos_validation'));
  assert.equal(target.isCurrent(), true);

  // Capture/action proof loss invalidates and closes the retained references;
  // restoring a callback or the numeric id cannot revive the target.
  const appsBeforeTargetClose = releasedApps;
  selectionLive = false;
  assert.equal(target.isCurrent(), false);
  selectionLive = true;
  assert.equal(target.isCurrent(), false);
  target.close();
  assert.equal(target.isCurrent(), false);
  assert.equal(releasedApps, appsBeforeTargetClose + 1); assert.equal(releasedWindows, 1);

  const processTarget = resolveMacSemanticTarget(native, selections, actor, 'opaque-selection');
  appEpoch = 'app-2';
  assert.equal(processTarget.isCurrent(), false, 'a PID with a new process instance is stale');
  appEpoch = 'app-1';
  assert.equal(processTarget.isCurrent(), false, 'a failed process proof cannot revive');
  assert.equal(releasedApps >= 2, true); assert.equal(releasedWindows >= 2, true);

  const appsBeforeWindowTarget = releasedApps;
  const windowsBeforeWindowTarget = releasedWindows;
  const windowTarget = resolveMacSemanticTarget(native, selections, actor, 'opaque-selection');
  windowEpoch = 'window-2';
  assert.equal(windowTarget.isCurrent(), false, 'same window id with a new AX window is stale');
  assert.equal(releasedApps > appsBeforeWindowTarget, true); assert.equal(releasedWindows, windowsBeforeWindowTarget + 1);

  actorLive = false;
  assert.throws(() => resolveMacSemanticTarget(native, selections, actor, 'opaque-selection'), /actor/);
  actorLive = true;
  selectionLive = false;
  assert.throws(() => resolveMacSemanticTarget(native, selections, actor, 'opaque-selection'), /capture.*current/);
  console.log('desktop macOS semantic target: mocked host selection, capture/action invalidation and numeric-driver limitation passed; no macOS native test');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
  releaseLease();
}
