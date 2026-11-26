import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'scheduler-continuation-restart-'));
let detach, log, ledger, epochs;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const read = fs.readFileSync;
  let runtimeFile, reverted = false;
  if (process.env.MUSTER_TEST_ORIGINAL_SCHEDULER_RESUME === '1') fs.readFileSync = function(file, ...args) {
    const value = read.call(this, file, ...args);
    if (typeof value !== 'string' || !String(file).replaceAll('\\', '/').endsWith('/resumeWait/runtime.ts')) return value;
    const source = value.replaceAll('\r\n', '\n');
    const expected = `return ctx.desktopEpochs.continuationBinding\n              ? ctx.desktopEpochs.continuationBinding(wait.owner) : ctx.desktopEpochs.currentBinding(wait.owner);`;
    assert.ok(source.includes(expected), 'scheduler restart control must replace the exact binding');
    reverted = true;
    return source.replace(expected, 'return ctx.desktopEpochs.currentBinding(wait.owner);');
  };
  try { runtimeFile = compile('main/resumeWait/runtime.ts'); } finally { fs.readFileSync = read; }
  if (process.env.MUSTER_TEST_ORIGINAL_SCHEDULER_RESUME === '1') assert.equal(reverted, true);
  const load = file => import(pathToFileURL(compile(file)).href);
  const { attachResumeWait } = await import(pathToFileURL(runtimeFile));
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const { SchedulerDesktopEpochRuntime } = await load('main/desktop/schedulerEpochRuntime.ts');
  const { DesktopResumeStateLedger } = await load('main/desktop/desktopResumeState.ts');
  const { DesktopActivity } = await load('main/desktop/desktopActivity.ts');
  const { DesktopTurns } = await load('main/desktop/desktopTurns.ts');
  const { beginSchedulerDesktopTurn } = await load('main/agent/orchestrator/internal.ts');
  const { runAsAgentWorkspace, runAsSchedulerTool, runWithSchedulerDesktopTurnSource, runAsCapturedSchedulerDesktopTurn } = await load('main/agent/agentScope.ts');
  const { resumeWaitHost } = await load('main/capabilities/hosts/resumeWait.ts');
  const mailStore = await load('main/metaAgent/messageStore.ts');
  const data = path.join(temp, 'data'), owner = 'orchestrator:ws', bucket = { busy: true }, delivered = [];
  mailStore.setAgentMessagesUserDataDir(data);
  const labels = { active: 'Active', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const ui = { confirmWithReceipt: async () => assert.fail('visible identity must not revive a legacy approval') };
  let turns, visibility;
  const ctx = {
    config: { get: () => ({}) },
    workspaces: { list: () => [{ id: 'ws', path: data }] }, desktopTurns: () => turns,
    desktopEpochs: { currentBinding: id => epochs.currentBinding(id), continuationBinding: id => epochs.continuationBinding(id) },
    sessions: { get: () => undefined, isChatRuntime: () => true, onLifecycle: () => () => {}, onPhaseFlip: () => () => {}, onSessionRemoved: () => () => {} },
    orchestrator: { buckets: new Map([['ws', bucket]]), isBusy: () => false, onEvent: () => () => {}, getHumanWait: () => null,
      async send(_text, _ws, _images, opts) {
        if (!opts.beforeStart()) { opts.onSkipped?.(); return; }
        const batch = await opts.notification.prepare();
        delivered.push({ batch, delivery: opts.notification });
        await opts.notification.accepted(batch);
      } },
    notify: { push() {} }, pty: { getBufferTail() {} }
  };
  function attach() {
    visibility = undefined;
    epochs = new SchedulerDesktopEpochRuntime(data, ui, () => visibility);
    ledger = new DesktopResumeStateLedger(path.join(data, 'desktop', 'stop.sqlite'));
    turns = new DesktopTurns(new DesktopActivity({ show: async () => { visibility = 1; }, close() { visibility = undefined; } },
      async () => {}, labels, undefined, undefined, ledger));
    log = new EventLog(data); ctx.eventRouter = new EventRouter(log, async () => {}); detach = attachResumeWait(ctx, data);
  }
  function close() { detach?.(); detach = undefined; log?.close(); log = undefined; ledger?.close(); ledger = undefined; epochs?.close(); epochs = undefined; }
  attach();
  await turns.stop();
  turns.noteUserInstruction(owner, 'new-user-message');
  beginSchedulerDesktopTurn({ ctx }, bucket, 'ws', 'new-user-message');
  const firstTask = await turns.use(owner, bucket.desktopTurnId, 'fixture', async () => epochs.ensureCapture(owner, () => true));
  const oldBinding = epochs.currentBinding(owner);
  assert.equal(oldBinding.epoch, firstTask);
  const wait = await runAsAgentWorkspace('ws', () => runAsSchedulerTool(() => runWithSchedulerDesktopTurnSource(
    () => ({ sessionId: owner, desktopTurnId: bucket.desktopTurnId, isDesktopCurrent: () => true }),
    () => runAsCapturedSchedulerDesktopTurn(async () => {
      const accepted = resumeWaitHost.waitFor(ctx, { condition: { kind: 'time', at: '2099-01-01T00:00:00Z' }, note: 'resume scheduler' });
      return ctx.resumeWait.store.get(accepted.id);
    }))));
  await ctx.resumeWait.awaitDesktopSources([wait]);
  turns.end(owner, bucket.desktopTurnId);
  close(); attach();
  assert.equal(epochs.currentBinding(owner), null, 'ordinary active task state is not silently revived');
  assert.deepEqual(epochs.continuationBinding(owner), oldBinding, 'private identity survives with the same durable generation');
  assert.equal(ctx.resumeWait.store.fire(wait.id, 'fixture', '{}'), true);
  await ctx.resumeWait.tick();
  assert.equal(delivered.length, 1, 'scheduler text is delivered');
  beginSchedulerDesktopTurn({ ctx }, bucket, 'ws', undefined, delivered[0].delivery.desktopContinuation);
  const restored = await turns.use(owner, bucket.desktopTurnId, 'fixture', async () => epochs.ensureCapture(owner, () => true));
  assert.equal(restored, firstTask, 'valid post-stop scheduler continuation survives a host restart');
  turns.end(owner, bucket.desktopTurnId);
  epochs.closeSession(owner);
  beginSchedulerDesktopTurn({ ctx }, bucket, 'ws', undefined, delivered[0].delivery.desktopContinuation);
  await assert.rejects(turns.use(owner, bucket.desktopTurnId, 'fixture', async () => assert.fail('revoked task dispatched')), /continuation/i);
  close();
  const legacy = new SchedulerDesktopEpochRuntime(data, ui);
  assert.equal(legacy.continuationBinding(owner), null, 'legacy in-memory approvals are not restored as a capture grant');
  legacy.close();
  console.log('scheduler continuation: real task identity, stop ledger and wait survive restart; revocation blocks');
} finally {
  detach?.(); log?.close(); ledger?.close(); epochs?.close();
  removeWorkspaceFixture(temp, 'scheduler-continuation-restart-');
}
