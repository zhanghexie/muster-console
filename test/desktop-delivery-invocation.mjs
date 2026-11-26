import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-delivery-invocation-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { runWithDesktopDeliveryInvocation, captureInvocationWin32Slot, captureInvocationCuaSlot } =
    await import(pathToFileURL(compile('main/desktop/desktopDeliveryInvocation.ts')));
  let visible = true, target = true, actorCurrent = true;
  const abort = new AbortController();
  const actor = { sessionId: 'session', taskId: 'task', turnId: 'turn', isCurrent: () => actorCurrent };
  const lease = { owner: 'session', turnId: 'turn', signal: abort.signal, isCurrent: () => !abort.signal.aborted };
  const input = { actor, lease, indicatorEpoch: 1, targetWindowId: 'host-window', isIndicatorCurrent: epoch => visible && epoch === 1,
    isTargetCurrent: () => target, onUnknown() {} };
  let calls = 0;
  const selector = { win32: (a, context) => { calls++; assert.equal(a, actor); assert.equal(context.lease, lease); return 'windows-slot'; },
    cua: (_request, context) => { calls++; assert.equal(context.isTargetCurrent(), true); return 'semantic-slot'; } };
  assert.throws(() => captureInvocationWin32Slot(selector, actor), /changed/);
  await runWithDesktopDeliveryInvocation(input, async () => {
    assert.equal(captureInvocationWin32Slot(selector, actor), 'windows-slot');
    const request = { actor, hostWindowId: 'host-window', isTargetCurrent: () => target };
    assert.equal(captureInvocationCuaSlot(selector, request), 'semantic-slot');
    assert.throws(() => captureInvocationCuaSlot(selector, { ...request, hostWindowId: 'other' }), /target changed/);
    assert.throws(() => captureInvocationWin32Slot(selector, { ...actor, taskId: 'other' }), /changed/);
    assert.throws(() => runWithDesktopDeliveryInvocation(input, async () => {}), /unavailable/, 'nested tool scopes cannot borrow a slot');
    target = false;
    assert.throws(() => captureInvocationCuaSlot(selector, request), /changed/);
    target = true; visible = false;
    assert.throws(() => captureInvocationWin32Slot(selector, actor), /changed/);
    visible = true; abort.abort();
    assert.throws(() => captureInvocationWin32Slot(selector, actor), /changed/);
  });
  assert.equal(calls, 2);
  assert.throws(() => runWithDesktopDeliveryInvocation(input, async () => {}), /unavailable/);
  const secondAbort = new AbortController();
  const second = { ...input, lease: { ...lease, signal: secondAbort.signal, isCurrent: () => !secondAbort.signal.aborted } };
  let late;
  await runWithDesktopDeliveryInvocation(second, async () => {
    late = new Promise((resolve, reject) => setImmediate(() => {
      try { resolve(captureInvocationWin32Slot(selector, actor)); } catch (error) { reject(error); }
    }));
  });
  await assert.rejects(late, /changed/, 'an inherited async context cannot outlive its host tool call');
  console.log('desktop delivery invocation: owner, target, indicator, stop and nested-scope binding passed');
} finally { removeWorkspaceFixture(temp, 'desktop-delivery-invocation-'); }
