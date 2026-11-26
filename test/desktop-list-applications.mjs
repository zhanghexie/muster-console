import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-list-apps-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { listDesktop } = await import(pathToFileURL(compile('main/capabilities/hosts/desktop.ts')));
  const { CuaAppDiscovery, CuaAppDiscoveryError } = await import(pathToFileURL(compile('main/desktop/cuaAppDiscovery.ts')));
  const { DesktopActivity } = await import(pathToFileURL(compile('main/desktop/desktopActivity.ts')));
  const { DesktopTurns } = await import(pathToFileURL(compile('main/desktop/desktopTurns.ts')));
  const { DESKTOP_TOOL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/desktop.ts')));
  const { runAsAgentWorkspace, runAsAgentSession, runAsGuiExecutionTurn, runAsSchedulerTool,
    runWithSchedulerDesktopTurnSource, runAsCapturedSchedulerDesktopTurn } =
    await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const { sourcePathKey } = await import(pathToFileURL(compile('main/workspacePaths.ts')));
  const workspace = { id: 'workspace', name: 'Workspace', path: temp, rootsRevision: 1,
    defaultRootId: 'root', controlRoot: temp, roots: [{ id: 'root', path: temp }] };
  const config = { get: () => ({ activeWorkspaceId: 'workspace', workspaces: [workspace] }) };
  const metadata = { list: async () => ({ displays: { surfaces: [], omitted: 0 }, windows: { ok: true, data: {
    runtime: 'windows', complete: true, omitted: 0, limitations: [], capabilities: {}, observations: [] } } }) };
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  let shown = false, calls = 0, closes = 0, taskId = 'task-1', turn = 'turn-1', current = true, captureRequests = 0;
  const activity = new DesktopActivity({ show: async () => { shown = true; }, close: () => {} }, async () => {}, labels);
  const turns = new DesktopTurns(activity), owner = 'orchestrator:workspace';
  turns.begin(owner, turn, () => current);
  const discovery = new CuaAppDiscovery({ platform: 'win32', createConnection: () => ({
    async connect() { assert.equal(shown, true, 'indicator precedes discovery'); },
    async call() { calls++; return { structuredContent: { apps: [
      { name: 'Fixture One', pid: 123, running: true, active: false, kind: 'desktop', launch_path: '/private' },
      { name: 'Fixture Two', pid: 0, running: false, active: false, kind: 'desktop' }
    ] } }; },
    async close() { closes++; }
  }) });
  const ctx = { config, sessions: { get: () => undefined }, desktopMetadata: () => metadata,
    desktopTurns: () => turns, desktopAppDiscovery: () => discovery,
    desktopSchedulerTask: () => ({ ensureCapture: async () => { captureRequests++; throw new Error('Unexpected screen capture request'); },
      currentBinding: () => taskId ? { epoch: taskId } : null }) };
  const source = () => ({ sessionId: owner, desktopTurnId: turn, isDesktopCurrent: () => current });
  const call = fn => runAsAgentWorkspace('workspace', () => runWithSchedulerDesktopTurnSource(source, () =>
    runAsCapturedSchedulerDesktopTurn(() => runAsSchedulerTool(fn))));
  const listed = await call(() => listDesktop(ctx));
  assert.ok(listed.displays); assert.ok(listed.windows); assert.equal('applications' in listed, false);
  assert.equal(calls, 0, 'legacy listing does not start the application backend');
  const disabled = await call(() => listDesktop({ ...ctx, desktopAppDiscovery: undefined }, { view: 'applications' }));
  assert.equal(disabled.code, 'capability_unsupported');
  const failedStartup = await call(() => listDesktop({ ...ctx, desktopAppDiscovery: undefined, desktopTurns: undefined,
    desktopUnavailableReason: 'Desktop initialization failed; check the workbench log.' }, { view: 'applications' }));
  assert.equal(failedStartup.message, 'Desktop initialization failed; check the workbench log.');
  const noLease = await call(() => listDesktop({ ...ctx, desktopTurns: undefined }, { view: 'applications' }));
  assert.equal(noLease.code, 'capability_unsupported'); assert.equal(calls, 0);
  await assert.rejects(runAsAgentWorkspace('workspace', () => runAsSchedulerTool(() => listDesktop(ctx, { view: 'applications' }))), /execution context/);
  for (const args of [
    { query: 'x' }, { view: 'bogus' }, { view: 'applications', displayOffset: 0 },
    { view: 'applications', offset: 1 }, { view: 'applications', snapshotId: 'a', query: 'x' },
    { view: 'applications', snapshotId: '', offset: 0 }, { view: 'applications', limit: 11 },
    { view: 'applications', status: 'unknown' }, { view: 'applications', query: 'x'.repeat(129) }
  ]) await assert.rejects(async () => call(() => listDesktop(ctx, args)), /Invalid|require/);
  const first = await call(() => listDesktop(ctx, { view: 'applications', query: 'Fixture', limit: 1 }));
  assert.equal(captureRequests, 0, 'application metadata must never ask for screen capture');
  assert.equal(first.applicationDiscovery.available, true); assert.equal(first.applications.total, 2);
  assert.equal(first.applications.nextOffset, 1); assert.equal(first.applications.apps[0].running, true);
  assert.ok(!JSON.stringify(first).includes('/private')); assert.equal(calls, 1); assert.equal(closes, 1);
  const next = await call(() => listDesktop(ctx, { view: 'applications', snapshotId: first.applications.snapshotId, offset: 1, limit: 1 }));
  assert.equal(next.applications.apps[0].installed, true); assert.equal(next.applications.nextOffset, null); assert.equal(calls, 1);
  taskId = 'task-2';
  const wrongTask = await call(() => listDesktop(ctx, { view: 'applications', snapshotId: first.applications.snapshotId }));
  assert.equal(wrongTask.code, 'stale'); taskId = 'task-1';
  turns.end(owner, turn); turn = 'turn-2'; turns.begin(owner, turn, () => current);
  const wrongTurn = await call(() => listDesktop(ctx, { view: 'applications', snapshotId: first.applications.snapshotId }));
  assert.equal(wrongTurn.code, 'stale');
  const filter = await call(() => listDesktop(ctx, { view: 'applications', status: 'installed_not_running' }));
  assert.equal(filter.applications.total, 1); assert.equal(filter.applications.apps[0].running, false);
  taskId = null;
  const withoutTask = await call(() => listDesktop(ctx, { view: 'applications', limit: 1 }));
  assert.equal(withoutTask.applications.total, 2);
  const withoutTaskNext = await call(() => listDesktop(ctx, { view: 'applications', snapshotId: withoutTask.applications.snapshotId,
    offset: withoutTask.applications.nextOffset, limit: 1 }));
  assert.equal(withoutTaskNext.applications.nextOffset, null);
  taskId = 'task-1';
  const taskStarted = await call(() => listDesktop(ctx, { view: 'applications', snapshotId: withoutTask.applications.snapshotId }));
  assert.equal(taskStarted.code, 'stale', 'an observed task binding change invalidates a turn-local snapshot');
  const noEpochCtx = { ...ctx, desktopSchedulerTask: undefined };
  const noEpoch = await call(() => listDesktop(noEpochCtx, { view: 'applications', limit: 1 }));
  assert.equal(noEpoch.applications.total, 2);
  const noEpochNext = await call(() => listDesktop(noEpochCtx, { view: 'applications', snapshotId: noEpoch.applications.snapshotId,
    offset: noEpoch.applications.nextOffset, limit: 1 }));
  assert.equal(noEpochNext.applications.nextOffset, null);
  const broken = { ...ctx, desktopAppDiscovery: () => ({ discover: async () => {
    throw new CuaAppDiscoveryError('dependency_missing', 'Prepare the pinned driver');
  } }) };
  const error = await call(() => listDesktop(broken, { view: 'applications' }));
  assert.equal(error.code, 'dependency_missing'); assert.match(error.message, /pinned driver/);
  let entered, slowClosed = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const slow = new CuaAppDiscovery({ platform: 'win32', createConnection: () => ({
    async connect() {}, async call() { entered(); return new Promise(() => {}); }, async close() { slowClosed++; }
  }) });
  const abort = new AbortController();
  const pending = call(() => listDesktop({ ...ctx, desktopAppDiscovery: () => slow }, { view: 'applications' }, abort.signal));
  await started; abort.abort();
  await assert.rejects(pending, /cancel|abort|interrupt/i);
  assert.equal(slowClosed, 1, 'cancellation reclaims the driver before the host call ends');
  await slow.close();
  const missingLease = { ...ctx, desktopTurns: () => ({ use: async (_owner, _turn, _target, fn) => fn(new AbortController().signal) }) };
  await assert.rejects(call(() => listDesktop(missingLease, { view: 'applications' })), /visible desktop run/);
  const workerSession = { workspaceId: 'workspace', archived: false }, token = {};
  const workerScope = { workspaceId: 'workspace', cwd: temp, roots: [{ rootId: 'root', path: temp }],
    controlPhysicalPath: sourcePathKey(temp), readableDirectories: [{ path: temp, physicalPath: sourcePathKey(temp) }] };
  const workerCtx = { ...ctx, sessions: { get: () => ({ name: 'Worker' }), peek: () => workerSession,
    sessionScopeToken: () => token, isChatRuntime: () => true }, agentSessions: { getWorkspaceContext: () => workerScope },
    desktopWorkerTask: () => ({ epochs: { capture: () => ({ generation: 1, isCurrent: () => true }) } }) };
  const workerTurn = { sessionId: 'worker', turnId: 'engine', desktopTurnId: 'worker-turn', isCurrent: () => true, isDesktopCurrent: () => true };
  turns.begin('worker', 'worker-turn', () => true);
  const workerCall = fn => runAsGuiExecutionTurn(workerTurn, () => runAsAgentSession('worker', fn));
  const otherSession = await workerCall(() => listDesktop(workerCtx, { view: 'applications', snapshotId: filter.applications.snapshotId }));
  assert.equal(otherSession.code, 'stale');
  const workerPage = await workerCall(() => listDesktop(workerCtx, { view: 'applications', limit: 1 }));
  assert.equal(workerPage.applications.total, 2);
  turns.end('worker', 'worker-turn');
  current = false;
  await assert.rejects(call(() => listDesktop(ctx, { view: 'applications' })), /execution context/);
  const schema = DESKTOP_TOOL_DEFS.find(item => item.name === 'desktop.list').parameters.properties;
  assert.deepEqual(schema.view.enum, ['metadata', 'applications', 'windows']); assert.equal(schema.query.maxLength, 128);
  turns.end(owner, turn); await activity.stop(false); await discovery.close();
  console.log('desktop list applications: configured lease, compatibility, paging, actor and error paths passed');
} finally { removeWorkspaceFixture(temp, 'desktop-list-apps-'); }
