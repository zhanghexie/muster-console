import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-win32-bridge-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { Win32VisibleBridge } = await import(pathToFileURL(compile('main/desktop/win32VisibleBridge.ts')));
  let visible = 1, target = true, stops = 0, calls = 0, slotUnavailable = false, targetMissing = false;
  const abort = new AbortController();
  const actor = { sessionId: 'session', taskId: 'task', isCurrent: () => !abort.signal.aborted };
  const lease = { owner: 'session', turnId: 'turn', signal: abort.signal, isCurrent: () => !abort.signal.aborted };
  let captured;
  const control = { async act(owner, request, requestId, slot) {
    calls++; captured = { owner, request, requestId, slot }; return { outcome: 'dispatched', invocationId: 'id', value: { delivery: 'dispatched' } };
  }, async launch(owner, appId, requestId, slot) { calls++; captured = { owner, appId, requestId, slot }; return { outcome: 'dispatched' }; } };
  const selector = { win32(owner, context) { if (slotUnavailable) throw new Error('engine scope unavailable');
    assert.equal(context.lease, lease); return { ...context, owner }; }, cua() {} };
  const bridge = new Win32VisibleBridge({ control, selector, activity: { visibilityEpoch: () => visible,
    stop: async () => { stops++; abort.abort(); } }, resolveTarget: () => targetMissing ? undefined : ({ isCurrent: () => target }),
    isPointOnTarget: () => true, reportStopError: error => { throw error; } });
  const request = { windowId: 'window', action: 'move', x: 1, y: 2 };
  await bridge.act(actor, lease, request, 'request');
  assert.equal(calls, 1);
  assert.equal(captured.owner.turnId, 'turn');
  assert.equal(captured.slot.isTargetCurrent(), true);
  slotUnavailable = true;
  await assert.rejects(bridge.act(actor, lease, request, 'no-slot'), error => error.name === 'PreDispatchFailure');
  assert.equal(calls, 1, 'missing engine scope is proved to be before dispatch');
  slotUnavailable = false;
  targetMissing = true;
  assert.throws(() => bridge.act(actor, lease, request, 'missing'), /target changed/i);
  targetMissing = false;
  target = false;
  assert.equal(captured.slot.isTargetCurrent(), false, 'issued slots track target changes');
  assert.throws(() => bridge.act(actor, lease, request, 'stale'), /not dispatched|target changed/i);
  target = true; visible = undefined;
  assert.throws(() => bridge.launch(actor, lease, 'app', 'hidden'), /not dispatched|indicator/i);
  visible = 2;
  await bridge.launch(actor, lease, 'app', 'launch');
  assert.equal(calls, 2);
  captured.slot.onUnknown({ outcome: 'unknown' });
  assert.equal(stops, 1);
  assert.equal(captured.owner.isCurrent(), false, 'unknown outcome freezes later actions synchronously');
  assert.throws(() => bridge.launch(actor, lease, 'app', 'stopped'), /not dispatched|current/i);
  console.log('Windows visible bridge: host lease, target, indicator and unknown stop binding passed');
} finally { removeWorkspaceFixture(temp, 'desktop-win32-bridge-'); }
