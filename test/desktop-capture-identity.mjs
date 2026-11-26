import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-capture-identity-'));
let workerRuntime, schedulerRuntime;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { captureIdentity } = await load('main/desktop/captureIdentity.ts');
  const { lookDesktopInternal, lookDesktop, controlDesktop, desktopHost } = await load('main/capabilities/hosts/desktop.ts');
  const { WorkerDesktopEpochRuntime } = await load('main/desktop/workerEpochRuntime.ts');
  const { SchedulerDesktopEpochRuntime } = await load('main/desktop/schedulerEpochRuntime.ts');
  const { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool, runAsGuiExecutionTurn } = await load('main/agent/agentScope.ts');
  const { sourcePathKey } = await load('main/workspacePaths.ts');
  const root = path.join(temp, 'workspace'); fs.mkdirSync(root);
  const workspace = { id: 'ws', path: root, rootsRevision: 1, defaultRootId: 'root', controlRoot: root, roots: [{ id: 'root', path: root }] };
  const row = { id: 'worker', type: 'terminal', launchKind: 'agent', runtime: 'pi', workspaceId: 'ws', archived: false };
  const scope = { workspaceId: 'ws', cwd: root, roots: [{ rootId: 'root', path: root }], controlPhysicalPath: sourcePathKey(root),
    readableDirectories: [{ path: root, physicalPath: sourcePathKey(root) }] };
  const token = {}, guards = new Set();
  const sessions = { peek: id => id === row.id ? row : undefined, isChatRuntime: () => true,
    sessionScopeToken: id => id === row.id && !row.archived ? token : undefined,
    onBeforeArchive: fn => { guards.add(fn); return () => guards.delete(fn); } };
  workerRuntime = new WorkerDesktopEpochRuntime(path.join(temp, 'data'), sessions);
  let counter = 0;
  schedulerRuntime = new SchedulerDesktopEpochRuntime(path.join(temp, 'data'), { async confirmWithReceipt() {
    return { approvalId: `receipt-${++counter}`, decision: { confirmed: true, kind: 'allowOnce' } };
  } });
  const ctx = { sessions, config: { get: () => ({ workspaces: [workspace], activeWorkspaceId: 'ws' }) },
    agentSessions: { getWorkspaceContext: () => scope }, desktopWorkerTask: () => workerRuntime, desktopSchedulerTask: () => schedulerRuntime };
  await assert.rejects(captureIdentity(ctx), /authenticated workspace/);
  const old = await runAsAgentSession('worker', () => captureIdentity(ctx));
  assert.equal(old.sessionId, 'worker'); assert.equal(old.isCurrent(), true);
  for (const guard of guards) guard([row]);
  row.archived = true; assert.equal(old.isCurrent(), false);
  row.archived = false;
  const renewed = await runAsAgentSession('worker', () => captureIdentity(ctx));
  assert.notEqual(renewed.taskId, old.taskId, 'artifact and permission keys must include the new generation');
  assert.equal(old.isCurrent(), false); assert.equal(renewed.isCurrent(), true);
  const scheduler = () => runAsAgentWorkspace('ws', () => runAsSchedulerTool(() => captureIdentity(ctx)));
  const first = await scheduler(); assert.equal(first.taskId, 'receipt-1');
  assert.equal((await scheduler()).taskId, first.taskId); assert.equal(counter, 1);
  schedulerRuntime.closeSession('orchestrator:ws'); assert.equal(first.isCurrent(), false);
  assert.equal((await scheduler()).taskId, 'receipt-2');
  let captures = 0;
  ctx.desktopMetadata = () => ({ displayRegistry: () => ({ captureTarget(_task, surface) {
    if (surface !== 'known') throw new Error('Unknown display');
  } }) });
  ctx.desktopScreen = () => ({ look: async actor => { captures++; return { taskId: actor.taskId, authorizationCurrent: () => true }; } });
  schedulerRuntime.closeSession('orchestrator:ws');
  const look = args => runAsAgentWorkspace('ws', () => runAsSchedulerTool(() => lookDesktopInternal(ctx, args)));
  await assert.rejects(look({ surfaceId: 'invented' }), /Unknown display/);
  await assert.rejects(look({ surfaceId: 'known', region: { x: -1, y: 0, width: 1, height: 1 } }), /region/i);
  assert.equal(counter, 2, 'invalid requests must not ask for human confirmation');
  assert.equal((await look({ surfaceId: 'known' })).taskId, 'receipt-3');
  assert.equal(captures, 1);
  const publicLook = (args, platform) => runAsAgentWorkspace('ws', () => runAsSchedulerTool(() => lookDesktop(ctx, args, undefined, platform)));
  assert.equal((await publicLook({ surfaceId: 'known' }, 'windows')).taskId, 'receipt-3');
  assert.equal(captures, 2, 'public Windows route reaches the authorized capture service');
  for (const platform of ['macos', 'linux-x11', 'linux-wayland', 'linux-unknown', 'unsupported']) {
    const result = await publicLook({ surfaceId: 'known' }, platform);
    assert.equal(result.code, 'capability_unsupported');
    assert.equal(result.runtime, platform);
    for (const action of ['act', 'focus', 'launch']) {
      const unsupported = await runAsAgentWorkspace('ws', () => runAsSchedulerTool(() => controlDesktop(ctx, action, {}, undefined, platform)));
      assert.equal(unsupported.code, 'capability_unsupported'); assert.equal(unsupported.runtime, platform);
    }
  }
  assert.equal(captures, 2, 'unsupported platforms never capture');
  if (process.platform === 'win32') {
    ctx.desktopMetadata = () => ({ displayRegistry: () => ({ captureTarget: () => ({}), isCurrent: () => true }) });
    ctx.desktopScreen = () => ({ look: async () => ({ captureId: 'capture', path: 'fixture.png', authorizationCurrent: () => true }) });
    ctx.desktopControl = () => ({ register: () => { throw new Error('inventory failed'); } });
    const partial = await runAsAgentSession('worker', () => lookDesktopInternal(ctx, { surfaceId: 'known' }));
    assert.equal(partial.path, 'fixture.png'); assert.equal(partial.windowsComplete, false);
    assert.match(partial.windowsError, /inventory failed/);
    ctx.desktopTargets = () => ({ register: () => ({ windows: [{ windowId: 'visible-target' }], complete: true }) });
    ctx.desktopControl = () => { throw new Error('legacy writer must not be opened'); };
    const selectionOnly = await runAsAgentSession('worker', () => lookDesktopInternal(ctx, { surfaceId: 'known' }));
    assert.equal(selectionOnly.windows[0].windowId, 'visible-target');
    assert.equal(selectionOnly.windowsComplete, true, 'capture selection can reuse the registry without opening the legacy writer');
    delete ctx.desktopTargets;
    const calls = [];
    ctx.desktopControl = () => ({ act: async (actor, args) => { calls.push({ actor, args }); return { outcome: 'dispatched' }; },
      launch: async (actor, appId) => { calls.push({ actor, appId }); return { outcome: 'dispatched' }; } });
    await runAsAgentSession('worker', async () => {
      await desktopHost['desktop.act'](ctx, { requestId: 'act-1', surfaceId: 'display', action: 'click', target: { windowId: 'window', x: 1, y: 2 } });
      assert.equal(calls.at(-1).actor.sessionId, 'worker');
      assert.equal(calls.at(-1).args.displayId, 'display');
      await desktopHost['desktop.focus'](ctx, { requestId: 'focus-1', surfaceId: 'window' });
      assert.equal(calls.at(-1).args.action, 'focus');
      await desktopHost['desktop.launch'](ctx, { requestId: 'launch-1', appId: 'C:\\app.exe' });
      assert.equal(calls.at(-1).appId, 'C:\\app.exe');
      await assert.rejects(desktopHost['desktop.act'](ctx, { requestId: 'verify-1', surfaceId: 'display', action: 'click', target: { windowId: 'window' }, verify: true }), /verification/);
    });
  }
  // Product host routing with a visible backend installed: a missing lease must
  // fail before dispatch and must never fall back to the legacy approval path.
  let legacyCalls = 0, visibleCalls = [];
  ctx.desktopControl = () => ({ act: async () => { legacyCalls++; }, launch: async () => { legacyCalls++; } });
  ctx.desktopVisibleControl = () => ({ act: async (actor, lease, request, requestId) => {
    visibleCalls.push({ actor, lease, request, requestId }); return { outcome: 'dispatched' };
  }, launch: async (actor, lease, appId, requestId) => {
    visibleCalls.push({ actor, lease, appId, requestId }); return { outcome: 'dispatched' };
  } });
  const visibleArgs = { requestId: 'new-1', surfaceId: 'display', action: 'move', target: { windowId: 'window', x: 1, y: 2 } };
  const noCapture = await runAsAgentSession('worker', () => controlDesktop(ctx, 'act', { ...visibleArgs, action: 'click' }, undefined, 'windows'));
  assert.equal(noCapture.code, 'window_capture_required');
  await assert.rejects(runAsAgentSession('worker', () => controlDesktop(ctx, 'act', visibleArgs, undefined, 'windows')), /visible desktop run/);
  assert.equal(legacyCalls, 0);
  const controller = new AbortController();
  const lease = { owner: 'worker', turnId: 'visible-turn', signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  sessions.get = () => row;
  ctx.desktopTurns = () => ({ use: async (_owner, _turn, _target, execute) => execute(controller.signal, lease) });
  const gui = { sessionId: 'worker', turnId: 'engine-turn', desktopTurnId: 'visible-turn', isCurrent: () => true, isDesktopCurrent: () => true };
  const visibleCall = (action, args) => runAsAgentSession('worker', () => runAsGuiExecutionTurn(gui,
    () => controlDesktop(ctx, action, args, undefined, 'windows')));
  await visibleCall('act', visibleArgs);
  assert.equal(visibleCalls.at(-1).lease, lease);
  assert.equal(visibleCalls.at(-1).request.windowId, 'window');
  assert.equal(visibleCalls.at(-1).request.displayId, 'display');
  await visibleCall('act', { requestId: 'named-keys', surfaceId: 'display', action: 'key',
    target: { windowId: 'window', keys: ['Control', 'KeyA', 'Escape'] } });
  assert.deepEqual(visibleCalls.at(-1).request.keys, [0x11, 0x41, 0x1b]);
  const callCount = visibleCalls.length;
  await assert.rejects(visibleCall('act', { requestId: 'bad-key', surfaceId: 'display', action: 'key',
    target: { windowId: 'window', keys: ['Control', 'Ctrl'] } }), /duplicate/);
  await assert.rejects(visibleCall('act', { requestId: 'bad-name', surfaceId: 'display', action: 'key',
    target: { windowId: 'window', keys: ['Unknown'] } }), /Unsupported/);
  assert.equal(visibleCalls.length, callCount, 'invalid key names must not reach the desktop backend');
  await visibleCall('focus', { requestId: 'new-2', surfaceId: 'window' });
  assert.equal(visibleCalls.at(-1).request.action, 'focus');
  await visibleCall('launch', { requestId: 'new-3', appId: 'C:\\app.exe' });
  assert.equal(visibleCalls.at(-1).appId, 'C:\\app.exe');
  const originalVisible = ctx.desktopVisibleControl;
  ctx.desktopVisibleControl = () => { throw new Error('visible backend unavailable'); };
  await assert.rejects(visibleCall('act', visibleArgs), error => error.name === 'PreDispatchFailure');
  assert.equal(legacyCalls, 0, 'a failed visible backend may not fall back to legacy approval');
  ctx.desktopVisibleControl = originalVisible;
  const semanticLook = args => runAsAgentSession('worker', () => runAsGuiExecutionTurn(gui,
    () => lookDesktop(ctx, args, undefined, 'windows')));
  const semanticArgs = { surfaceId: 'display', mode: 'semantic', windowId: 'window' };
  assert.equal((await semanticLook(semanticArgs)).code, 'capability_unsupported');
  const semanticCalls = [];
  ctx.desktopSemanticControl = () => ({ observe: async (actor, lease, surfaceId, windowId) => {
    semanticCalls.push({ kind: 'observe', actor, lease, surfaceId, windowId }); return { snapshotId: 'snapshot', elements: [] };
  }, page: async (_actor, _lease, surfaceId, windowId, snapshotId, offset) => {
    semanticCalls.push({ kind: 'page', surfaceId, windowId, snapshotId, offset }); return { snapshotId, elements: [] };
  }, act: async (_actor, _lease, surfaceId, windowId, request) => {
    semanticCalls.push({ kind: 'act', surfaceId, windowId, request }); return { outcome: 'dispatched' };
  } });
  assert.equal((await semanticLook(semanticArgs)).semantic.snapshotId, 'snapshot');
  assert.equal(semanticCalls.at(-1).windowId, 'window');
  await semanticLook({ ...semanticArgs, snapshotId: 'snapshot', offset: 3 });
  assert.equal(semanticCalls.at(-1).offset, 3);
  await assert.rejects(async () => semanticLook({ ...semanticArgs, offset: 3 }), /Snapshot paging requires mode=semantic/);
  await assert.rejects(async () => semanticLook({ surfaceId: 'display', mode: 'image', windowId: 'window' }), /Window parameters require mode=semantic or mode=both/);
  await visibleCall('act', { surfaceId: 'display', requestId: 'semantic-1', action: 'click',
    target: { windowId: 'window', snapshotId: 'snapshot', ref: 'ref' } });
  assert.deepEqual(semanticCalls.at(-1).request, { snapshotId: 'snapshot', ref: 'ref', requestId: 'semantic-1', action: 'click' });
  await visibleCall('act', { surfaceId: 'display', requestId: 'semantic-2', action: 'set_value',
    target: { windowId: 'window', snapshotId: 'snapshot', ref: 'ref', value: '', delivery: 'foreground' } });
  assert.equal(semanticCalls.at(-1).request.value, '');
  assert.equal(semanticCalls.at(-1).surfaceId, 'display');
  await assert.rejects(visibleCall('act', { surfaceId: 'display', requestId: 'semantic-3', action: 'click',
    target: { windowId: 'window', snapshotId: 'snapshot', ref: 'ref', x: 1, y: 2 } }), /Invalid desktop semantic action/);
  await visibleCall('act', { surfaceId: 'display', requestId: 'double', action: 'double_click',
    target: { windowId: 'window', captureId: 'window-capture', x: 1, y: 2 } });
  assert.deepEqual(semanticCalls.at(-1).request.point, { x: 1, y: 2, count: 2, button: undefined });
  await visibleCall('act', { surfaceId: 'display', requestId: 'horizontal', action: 'scroll', target: { windowId: 'window', x: 1, y: 2, delta: 120, axis: 'horizontal' } });
  assert.equal(visibleCalls.at(-1).request.axis, 'horizontal');
  delete ctx.desktopControl;
  await visibleCall('focus', { requestId: 'visible-without-legacy', surfaceId: 'window' });
  assert.equal(visibleCalls.at(-1).request.action, 'focus', 'visible execution does not require constructing the legacy writer');
  controller.abort();
  assert.equal(visibleCalls.at(-1).actor.isCurrent(), false, 'stop invalidates the host actor');
  assert.equal(legacyCalls, 0);
  delete ctx.desktopTurns;
  delete ctx.desktopVisibleControl;
  delete ctx.desktopSemanticControl;
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runAsAgentSession('worker', () => captureIdentity(ctx, cancelled.signal)), /abort/i);
  console.log('desktop capture identity: host session, generation, receipt, cancellation and revocation passed');
} finally { schedulerRuntime?.close(); workerRuntime?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
