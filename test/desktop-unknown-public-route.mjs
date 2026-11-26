import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-unknown-public-route-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { withDesktopActivity } = await import(pathToFileURL(compile('main/desktop/guiDesktopInvocation.ts')));
  const { DesktopActivityRuntime } = await import(pathToFileURL(compile('main/desktop/desktopActivityRuntime.ts')));
  const { runAsGuiExecutionTurn, runAsPtyDesktopTurn, runAsAgentSession, runAsAgentWorkspace,
    runAsSchedulerTool, runWithSchedulerDesktopTurnSource, runAsCapturedSchedulerDesktopTurn } =
    await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const { IdempotentVisibleDispatcher } = await import(pathToFileURL(compile('main/desktop/idempotentVisibleDispatcher.ts')));
  const { Win32VisibleControl } = await import(pathToFileURL(compile('main/desktop/win32VisibleControl.ts')));

  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };

  function runtimeFixture(label) {
    const state = { current: true, releaseAll: 0, closed: 0, snapshots: [] };
    const runtime = new DesktopActivityRuntime({
      labels,
      createIndicator: () => ({
        async show(snapshot) { state.snapshots.push(snapshot); },
        close() { state.closed++; }
      }),
      async releaseAll() { state.releaseAll++; }
    });
    const owner = label === 'scheduler' ? 'orchestrator:workspace' : `${label}-owner`, turnId = `${label}-turn`;
    runtime.turns.begin(owner, turnId, () => state.current);
    const ctx = { desktopTurns: () => runtime.turns, sessions: { get: () => ({ name: label }) } };
    return { state, runtime, owner, turnId, ctx };
  }

  async function assertRouteStopsAndReports(label, invoke) {
    const fixture = runtimeFixture(label);
    let stopPromise;
    try {
      const execute = () => withDesktopActivity(fixture.ctx, true, undefined, async () => {
        stopPromise = fixture.runtime.stop();
        return { outcome: 'unknown', reason: `${label}-unknown` };
      });
      await assert.rejects(invoke(fixture, execute), /outcome may be unknown|outcome is unknown|Desktop activity is no longer current|turn ended after dispatch/i,
        `${label} must not expose an uncertain result as success`);
      await stopPromise;
      await fixture.runtime.activity.flushRendering();
      assert.ok(fixture.state.releaseAll >= 1, `${label} must release held input on stop`);
      assert.ok(fixture.state.snapshots.some(snapshot => snapshot.state === 'active'), `${label} must mount the indicator first`);
      assert.ok(fixture.state.snapshots.some(snapshot => snapshot.state === 'stopping' || snapshot.state === 'unknown'),
        `${label} must render the stopped/unknown state`);
    } finally {
      fixture.state.current = false;
      await fixture.runtime.dispose().catch(() => undefined);
    }
  }

  await assertRouteStopsAndReports('gui', (fixture, execute) => {
    const scope = { sessionId: fixture.owner, turnId: 'engine-gui', desktopTurnId: fixture.turnId,
      isCurrent: () => true, isDesktopCurrent: () => true };
    return runAsGuiExecutionTurn(scope, execute);
  });

  await assertRouteStopsAndReports('pty', (fixture, execute) => {
    const scope = { sessionId: fixture.owner, desktopTurnId: fixture.turnId, isDesktopCurrent: () => true };
    return runAsPtyDesktopTurn(scope, () => runAsAgentSession(fixture.owner, execute));
  });

  await assertRouteStopsAndReports('scheduler', (fixture, execute) => {
    const source = () => ({ sessionId: `orchestrator:workspace`, desktopTurnId: fixture.turnId, isDesktopCurrent: () => true });
    return runAsAgentWorkspace('workspace', () => runWithSchedulerDesktopTurnSource(source, () =>
      runAsCapturedSchedulerDesktopTurn(() => runAsSchedulerTool(execute))));
  });

  // Exercise the same public path through the local durable dispatcher and the
  // Windows bridge, with only in-memory target/input fixtures. The target is
  // invalidated during the fake activation, so the bridge must report unknown,
  // synchronously freeze the seat, and release input without touching the OS.
  {
    const fixture = runtimeFixture('win32-bridge');
    const receipts = new DesktopActionIdempotency(path.join(temp, 'receipts'));
    const dispatcher = new IdempotentVisibleDispatcher(receipts);
    const state = { targetCurrent: true, sent: 0, moved: 0, released: 0, unknown: [] };
    const actor = { sessionId: fixture.owner, taskId: 'win-task', turnId: fixture.turnId, isCurrent: () => true };
    const frame = {
      sessionId: actor.sessionId, taskId: actor.taskId, captureId: 'capture', surfaceId: 'display',
      surfaceGeneration: 'surface-generation', geometryRevision: 'geometry', expiresAt: Date.now() + 100000,
      width: 100, height: 100, sourceSize: { width: 100, height: 100 },
      region: { x: 0, y: 0, width: 100, height: 100 }, bounds: { x: 0, y: 0, width: 100, height: 100 },
      isCurrent: () => state.targetCurrent
    };
    const selection = {
      frame,
      window: { nativeHandle: '0x100', title: 'Fixture', titleTruncated: false, pid: 123,
        processImage: 'fixture.exe', processCreated: 'birth', bounds: { x: 0, y: 0, width: 100, height: 100 },
        dpi: 96, coordinateSpace: 'win32-screen-caller-dpi', limitations: [] },
      generation: 'window-generation',
      isCurrent: () => state.targetCurrent
    };
    const control = new Win32VisibleControl({
      dispatcher,
      resolveTarget: () => selection,
      input: {
        move() { state.moved++; },
        send() { state.sent++; },
        async releaseAll() { state.released++; }
      },
      windowApi: {
        valid: () => 1,
        minimized: () => 0,
        restore: () => 1,
        activate: () => { state.targetCurrent = false; return 1; },
        foreground: () => 0x100n
      },
      dipToPhysical: point => point
    });
    let stopPromise;
    try {
      const scope = { sessionId: fixture.owner, turnId: 'engine-bridge', desktopTurnId: fixture.turnId,
        isCurrent: () => true, isDesktopCurrent: () => true };
      await assert.rejects(runAsGuiExecutionTurn(scope, () => withDesktopActivity(fixture.ctx, true, undefined,
        (signal, delivery) => {
          const epoch = fixture.runtime.visibilityEpoch();
          const slot = {
            lease: delivery,
            indicatorEpoch: epoch,
            isIndicatorCurrent: value => fixture.runtime.visibilityEpoch() === value,
            isTargetCurrent: () => state.targetCurrent,
            onUnknown(result) { state.unknown.push(result); stopPromise = fixture.runtime.stop(); },
            stageDelivery() { throw new Error('must not stage an uncertain result'); }
          };
          return control.act(actor, { action: 'focus', windowId: 'window' }, 'bridge-unknown', slot, signal);
        })), /outcome may be unknown|outcome is unknown|Desktop activity is no longer current|turn ended after dispatch/i);
      await stopPromise;
      await fixture.runtime.activity.flushRendering();
      assert.equal(state.unknown.length, 1, 'the Windows bridge must report the uncertain result once');
      assert.equal(state.sent, 0, 'an invalidated target must not send native input');
      assert.equal(state.moved, 0, 'an invalidated target must not move the pointer');
      assert.ok(state.released >= 1, 'the bridge must release tracked input during failure cleanup');
    } finally {
      await fixture.runtime.dispose().catch(() => undefined);
      receipts.close();
    }
  }

  console.log('desktop unknown public route: GUI/PTY/scheduler stop, local dispatcher and Windows bridge passed');
} finally {
  removeWorkspaceFixture(temp, 'desktop-unknown-public-route-');
}
