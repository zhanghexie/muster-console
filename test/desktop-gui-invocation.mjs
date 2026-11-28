import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-gui-invocation-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { withDesktopActivity } = await import(pathToFileURL(compile('main/desktop/guiDesktopInvocation.ts')));
  const { DesktopActivity } = await import(pathToFileURL(compile('main/desktop/desktopActivity.ts')));
  const { DesktopTurns } = await import(pathToFileURL(compile('main/desktop/desktopTurns.ts')));
  const { GlobalVisibleActionDispatcher } = await import(pathToFileURL(compile('main/desktop/globalVisibleActionDispatcher.ts')));
  const { inheritRecordedDesktopOutcome, isRecordedDesktopOutcome } = await import(pathToFileURL(compile('main/desktop/recordedDesktopOutcome.ts')));
  const { runAsGuiExecutionTurn, runAsPtyDesktopTurn, runAsAgentWorkspace, runAsSchedulerTool, runAsAgentSession,
    runWithSchedulerDesktopTurnSource, runAsCapturedSchedulerDesktopTurn } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  assert.equal(await withDesktopActivity({}, false, undefined, async () => 4), 4, 'legacy execution stays compatible until the service is assembled');
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const shown = [];
  const activity = new DesktopActivity({ show: async snapshot => { shown.push(snapshot); }, close: () => {} }, async () => {}, labels);
  const turns = new DesktopTurns(activity);
  const ctx = { desktopTurns: () => turns, sessions: { get: () => ({ name: 'Session' }) } };
  turns.begin('worker', 'desktop-turn', () => true);
  const scope = { sessionId: 'worker', turnId: 'engine-turn', desktopTurnId: 'desktop-turn', isCurrent: () => true, isDesktopCurrent: () => true };
  await assert.rejects(withDesktopActivity(ctx, false, undefined, async () => 0), /execution context/, 'an unbound caller must not silently bypass the indicator');
  const result = await runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, false, undefined, async signal => {
    assert.equal(signal.aborted, false);
    assert.equal(shown.at(-1).state, 'active', 'the indicator must mount before desktop dispatch');
    return 5;
  }));
  assert.equal(result, 5);
  await assert.rejects(runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, false, undefined,
    async () => { throw new Error('observation failed'); })), /observation failed/);
  assert.equal(await runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, true, undefined, async () => 6)), 6,
    'a failed read must not pause the input seat');
  let unblock, activeEntered;
  const busy = new Promise(resolve => { activeEntered = resolve; });
  const queuedGate = new Promise(resolve => { unblock = resolve; });
  const busyCall = runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, true, undefined, async () => { activeEntered(); await queuedGate; return 7; }));
  await busy;
  const abort = new AbortController();
  const queuedCall = runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, true, abort.signal, async () => 8));
  const queuedResult = queuedCall.catch(error => error);
  abort.abort(); unblock();
  assert.equal(await busyCall, 7);
  assert.ok(await queuedResult);
  assert.equal(await runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, true, undefined, async () => 9)), 9,
    'an external cancellation before dispatch must not mark the input outcome unknown');
  const dispatcher = new GlobalVisibleActionDispatcher({
    async run() { return { outcome: 'unknown', operationId: 'prior', reason: 'request-already-recorded', recordedRequest: true }; },
    async acknowledge() { throw new Error('not expected'); }
  }, { resolveLogicalOperationId: () => 'host-owned-prior', classifyResult: value => value, deliveryEvidence: () => undefined });
  const prior = await dispatcher.run({ sessionId: 'worker', taskId: 'task', target: 'window', action: 'click', indicatorEpoch: 1,
    isCurrent: () => true, isIndicatorCurrent: () => true }, 'prior', 'a'.repeat(64), async () => { throw new Error('must not dispatch'); });
  const projection = inheritRecordedDesktopOutcome(prior, { ...prior.reply });
  assert.equal(isRecordedDesktopOutcome(projection), true);
  assert.equal(isRecordedDesktopOutcome(inheritRecordedDesktopOutcome({ ...prior }, { ...prior.reply })), false);
  assert.equal(await runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, true, undefined, async () => projection)), projection);
  assert.equal(await runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, true, undefined, async () => 10)), 10,
    'a proven duplicate must leave the active run usable');
  await assert.rejects(runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, true, undefined, async () => ({ outcome: 'unknown' }))), /outcome is unknown/);
  await assert.rejects(runAsGuiExecutionTurn(scope, () => withDesktopActivity(ctx, true, undefined, async () => ({ outcome: 'dispatched' }))));

  const schedulerSnapshots = [];
  const schedulerActivity = new DesktopActivity({ show: async snapshot => { schedulerSnapshots.push(snapshot); }, close: () => {} }, async () => {}, labels);
  const schedulerTurns = new DesktopTurns(schedulerActivity), owner = 'orchestrator:ws';
  const schedulerCtx = { desktopTurns: () => schedulerTurns, sessions: { get: () => undefined },
    workspaces: { list: () => [{ id: 'unrelated', name: 'Other' }, { id: 'ws', name: '桌面测试' }] } };
  schedulerTurns.begin(owner, 'scheduler-turn', () => true);
  let current = true;
  const source = () => ({ sessionId: owner, desktopTurnId: 'scheduler-turn', isDesktopCurrent: () => current });
  const schedulerCall = fn => runAsAgentWorkspace('ws', () => runWithSchedulerDesktopTurnSource(source, () =>
    runAsCapturedSchedulerDesktopTurn(() => runAsSchedulerTool(fn))));
  assert.equal(await schedulerCall(() => withDesktopActivity(schedulerCtx, false, undefined, async () => 9)), 9);
  assert.equal(schedulerSnapshots.at(-1).target, '调度 · 桌面测试', 'show the scheduler workspace name instead of its synthetic owner ID');
  await assert.rejects(schedulerCall(() => runAsAgentSession('worker', () => withDesktopActivity(schedulerCtx, false, undefined, async () => 1))), /execution context/,
    'a nested worker may not borrow the scheduler identity');
  current = false;
  await assert.rejects(schedulerCall(() => withDesktopActivity(schedulerCtx, false, undefined, async () => 1)), /execution context/);
  schedulerTurns.end(owner, 'scheduler-turn');
  const ptyActivity = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels);
  const ptyTurns = new DesktopTurns(ptyActivity), ptyCtx = { desktopTurns: () => ptyTurns, sessions: { get: () => ({ name: 'CLI' }) } };
  ptyTurns.begin('cli', 'pty-turn', () => true);
  const ptyScope = { sessionId: 'cli', desktopTurnId: 'pty-turn', isDesktopCurrent: () => true };
  const ptyCall = caller => runAsPtyDesktopTurn(ptyScope, () => runAsAgentSession(caller, () =>
    withDesktopActivity(ptyCtx, false, undefined, async () => 12)));
  assert.equal(await ptyCall('cli'), 12);
  await assert.rejects(ptyCall('other-cli'), /execution context/, 'a CLI invocation cannot borrow a different session');
  let stillCurrent = true, entered, complete;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { complete = resolve; });
  const staleScope = { ...ptyScope, isDesktopCurrent: () => stillCurrent };
  const staleCall = runAsPtyDesktopTurn(staleScope, () => runAsAgentSession('cli', () =>
    withDesktopActivity(ptyCtx, true, undefined, async () => { entered(); await pending; return { outcome: 'dispatched' }; })));
  const staleResult = staleCall.catch(error => error);
  await started;
  stillCurrent = false; complete();
  assert.match(String(await staleResult), /outcome may be unknown/, 'late results from a stale PTY request must not claim success');
  await assert.rejects(ptyActivity.start(ptyActivity.createTurn('other', 'next', () => true), 'window'), /new user instruction/,
    'an uncertain late result must also pause the shared input seat');
  ptyTurns.end('cli', 'pty-turn');
  console.log('desktop invocation: GUI/scheduler trusted turns, visible dispatch and unknown latch passed');
} finally { removeWorkspaceFixture(temp, 'desktop-gui-invocation-'); }
