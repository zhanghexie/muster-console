import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-continuation-integration-'));
let log, detach, ledger, gateway;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = file => import(pathToFileURL(compile(file)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const { attachResumeWait } = await load('main/resumeWait/runtime.ts');
  const { resumeWaitHost } = await load('main/capabilities/hosts/resumeWait.ts');
  const { startHostToolGateway } = await load('main/agentSession/drivers/acp/hostToolGateway.ts');
  const { DesktopResumeStateLedger } = await load('main/desktop/desktopResumeState.ts');
  const { DesktopActivity } = await load('main/desktop/desktopActivity.ts');
  const { DesktopTurns } = await load('main/desktop/desktopTurns.ts');
  const { runAsGuiExecutionTurn, runAsSchedulerTool, runAsAgentWorkspace, runWithSchedulerDesktopTurnSource, runAsCapturedSchedulerDesktopTurn } = await load('main/agent/agentScope.ts');
  const { beginSchedulerDesktopTurn } = await load('main/agent/orchestrator/internal.ts');
  const mailStore = await load('main/metaAgent/messageStore.ts');
  const data = path.join(temp, 'data');
  mailStore.setAgentMessagesUserDataDir(data);
  const labels = { active: 'Active', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const stopFile = path.join(data, 'desktop', 'stop.sqlite');
  let turns, binding = { epoch: 'task-A', generation: 1 }, guiBusy = false, schedulerBusy = false;
  const worker = { id: 'worker', type: 'terminal', launchKind: 'agent', runtime: 'codex-gui', workspaceId: 'ws', lifecycle: 'idle' };
  const gui = [], sched = [], steered = [], entries = new Map();
  const bucket = { busy: false };
  const ctx = {
    config: { get: () => ({}) },
    workspaces: { list: () => [{ id: 'ws', path: data }] }, desktopTurns: () => turns,
    desktopEpochs: { currentBinding: () => binding },
    sessions: { get: id => id === 'worker' ? worker : undefined, isChatRuntime: () => true,
      onLifecycle: () => () => {}, onPhaseFlip: () => () => {}, onSessionRemoved: () => () => {} },
    agentSessions: { entries, isBusy: () => guiBusy, isOpen: () => true,
      getDriver: () => ({ deliveryCapabilities: { interject: true, snapshot: false } }),
      async send(id, text, _images, opts) { gui.push({ id, text, opts }); return { ok: true }; } },
    orchestrator: { buckets: new Map([['ws', bucket]]), isBusy: () => schedulerBusy, onEvent: () => () => {}, getHumanWait: () => null,
      async send(_text, _ws, _images, opts) {
        if (!opts.beforeStart()) { opts.onSkipped?.(); return; }
        const batch = await opts.notification.prepare();
        sched.push({ batch, delivery: opts.notification });
        await opts.notification.accepted(batch);
      },
      async interjectHostNotification(_ws, delivery) {
        const batch = await delivery.prepare();
        delivery.beforeSubmit?.();
        steered.push(batch.content);
        await delivery.accepted(batch);
        return true;
      } },
    notify: { push() {} }, pty: { getBufferTail() {} }
  };
  function attach() {
    ledger = new DesktopResumeStateLedger(stopFile);
    turns = new DesktopTurns(new DesktopActivity({ show: async () => {}, close() {} }, async () => {}, labels, undefined, undefined, ledger));
    log = new EventLog(data); ctx.eventRouter = new EventRouter(log, async () => {}); detach = attachResumeWait(ctx, data);
  }
  function close() { detach?.(); detach = undefined; log?.close(); log = undefined; ledger?.close(); ledger = undefined; }
  const condition = { kind: 'time', at: '2099-01-01T00:00:00Z' };
  const hostArm = (note, priority = 'normal') => {
    const result = resumeWaitHost.waitFor(ctx, { __actorSessionId: 'worker', condition, note, priority });
    return ctx.resumeWait.store.get(result.id);
  };
  const armGui = (turnId, note, opts = {}) => runAsGuiExecutionTurn({ sessionId: 'worker', turnId: 'engine',
    desktopTurnId: turnId, isCurrent: () => true, isDesktopCurrent: () => opts.current !== false }, async () =>
      hostArm(note, opts.priority));
  const armScheduler = (turnId, note) => runAsAgentWorkspace('ws', () => runAsSchedulerTool(() => runWithSchedulerDesktopTurnSource(
    () => ({ sessionId: 'orchestrator:ws', desktopTurnId: turnId, isDesktopCurrent: () => true }),
    () => runAsCapturedSchedulerDesktopTurn(async () => hostArm(note)))));
  async function fire(...waits) {
    for (const wait of waits) assert.equal(ctx.resumeWait.store.fire(wait.id, `fixture:${wait.id}`, '{}'), true);
    await ctx.resumeWait.tick();
  }
  function takeGui() {
    const item = gui.shift(); assert.ok(item, 'text continuation must be delivered');
    assert.equal(ctx.resumeWait.acknowledge('worker', item.opts.messageId), true);
    return item.opts.desktopContinuation;
  }
  async function use(owner, turnId, proof) {
    turns.begin(owner, turnId, () => true, false, undefined, { continuation: proof, workspaceId: 'ws' });
    return turns.use(owner, turnId, 'fixture', async () => 'dispatched');
  }
  function user(owner, turnId) {
    turns.noteUserInstruction(owner, `message-${turnId}`);
    turns.begin(owner, turnId, () => true, true, `message-${turnId}`, { workspaceId: 'ws' });
  }

  attach();
  user('worker', 'before-stop');
  const old = await armGui('before-stop', 'old wait');
  await ctx.resumeWait.awaitDesktopSources([old]);
  await turns.stop();
  user('worker', 'after-stop');
  const fresh = await armGui('after-stop', 'fresh wait');
  await ctx.resumeWait.awaitDesktopSources([fresh]);
  assert.equal(ledger.isResumed('worker'), true);
  close(); attach(); // source, stop generation and owner resume are all read back from SQLite
  await fire(fresh);
  const freshProof = takeGui();
  assert.equal(await use('worker', 'fresh-auto', freshProof), 'dispatched', 'a post-stop authorized wait survives restart');
  turns.end('worker', 'fresh-auto');
  await fire(old);
  const oldProof = takeGui();
  await assert.rejects(use('worker', 'old-auto', oldProof), /continuation|instruction/i, 'a later user message cannot revive a pre-stop wait');
  await assert.rejects(use('other-owner', 'wrong-owner', freshProof), /continuation|instruction/i, 'one owner cannot borrow another source');

  // The source is checked again after binding, not merely when the wake was queued.
  turns.begin('worker', 'arm-more', () => true, false, undefined, { continuation: freshProof, workspaceId: 'ws' });
  const tampered = await armGui('arm-more', 'immutable wait');
  await ctx.resumeWait.awaitDesktopSources([tampered]);
  await fire(tampered); const tamperedProof = takeGui();
  const db = new DatabaseSync(path.join(data, 'event-log.sqlite'));
  db.prepare('UPDATE resume_waits SET note=? WHERE id=?').run('forged', tampered.id); db.close();
  await assert.rejects(use('worker', 'tampered-auto', tamperedProof), /continuation/i);

  turns.begin('worker', 'batch-author', () => true, false, undefined, { continuation: freshProof, workspaceId: 'ws' });
  const known = await armGui('batch-author', 'known source');
  const unknown = hostArm('unknown source');
  await ctx.resumeWait.awaitDesktopSources([known]);
  await fire(known, unknown);
  const mixed = takeGui();
  await assert.rejects(use('worker', 'mixed-auto', mixed), /continuation/i, 'one unknown source freezes a whole batch');

  // A changed task binding cannot inherit the prior task's continuation.
  binding = { epoch: 'task-B', generation: 1 };
  await assert.rejects(use('worker', 'different-task', freshProof), /continuation/i);
  binding = { epoch: 'task-A', generation: 2 };
  await assert.rejects(use('worker', 'different-generation', freshProof), /continuation/i);
  binding = undefined;
  await assert.rejects(use('worker', 'unknown-task', freshProof), /continuation/i);
  binding = { epoch: 'task-A', generation: 1 };

  // The scheduler's actual turn entry and captured tool scope issue the same private proof.
  bucket.busy = true; schedulerBusy = true;
  turns.noteUserInstruction('orchestrator:ws', 'scheduler-user');
  beginSchedulerDesktopTurn({ ctx }, bucket, 'ws', 'scheduler-user');
  const schedulerWait = await armScheduler(bucket.desktopTurnId, 'scheduler wait');
  await ctx.resumeWait.awaitDesktopSources([schedulerWait]);
  schedulerBusy = false; bucket.busy = false;
  await fire(schedulerWait);
  assert.equal(sched.length, 1, 'scheduler text is delivered');
  bucket.busy = true;
  beginSchedulerDesktopTurn({ ctx }, bucket, 'ws', undefined, sched[0].delivery.desktopContinuation);
  assert.equal(await turns.use('orchestrator:ws', bucket.desktopTurnId, 'fixture', async () => 'scheduler-dispatched'), 'scheduler-dispatched');
  turns.end('orchestrator:ws', bucket.desktopTurnId);

  // Native preemption delivers text, while an untrusted source immediately blocks its active desktop turn.
  user('worker', 'preempt-user');
  await turns.use('worker', 'preempt-user', 'fixture', async () => 'before-preempt');
  const goodPreempt = await armGui('preempt-user', 'trusted preempt', { priority: 'preempt' });
  await ctx.resumeWait.awaitDesktopSources([goodPreempt]);
  const entry = { busy: true, activeExecutionTurnId: 'engine', activeDesktopTurnId: 'preempt-user',
    connection: { async receiveMessage(message) { steered.push(message.text); return { status: 'accepted', method: 'steered' }; } } };
  entries.set('worker', entry); guiBusy = true;
  await fire(goodPreempt);
  assert.equal(await turns.use('worker', 'preempt-user', 'fixture', async () => 'after-valid-preempt'), 'after-valid-preempt');
  const noSource = hostArm('untrusted preempt', 'preempt');
  await fire(noSource);
  assert.ok(steered.some(text => text.includes('untrusted preempt')), 'text preemption must continue');
  await assert.rejects(turns.use('worker', 'preempt-user', 'fixture', async () => assert.fail('preempt dispatched')), /continuation|active|stopped/i);
  guiBusy = false;

  // Accepted stale inbound identity cannot sign a wait even if a new turn exists.
  user('worker', 'newer');
  const staleSource = await armGui('newer', 'stale inbound', { current: false });
  await ctx.resumeWait.awaitDesktopSources([staleSource]);
  await fire(staleSource);
  await assert.rejects(use('worker', 'stale-source-auto', takeGui()), /continuation/i);

  // Real HTTP headers bind the old desktop turn even if the request body
  // completes after a new user instruction; the wait still delivers as text.
  let currentDesktop = 'http-old', sawHeaders;
  user('worker', currentDesktop);
  gateway = await startHostToolGateway({ sessionId: 'worker', cwd: temp,
    getTurnId: () => { sawHeaders?.(); sawHeaders = undefined; return 'engine'; },
    getDesktopTurnId: () => currentDesktop,
    hostTools: [{ id: 'host.waitFor', label: 'wait', description: 'wait', permissionClass: 'status',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: async () => JSON.stringify(resumeWaitHost.waitFor(ctx, { __actorSessionId: 'worker', condition, note: 'slow request' })) }],
    requestApproval: async () => ({ approved: true }), getPolicyState: () => ({ mode: 'auto', planExecuting: false }), log() {} });
  const headers = new Promise(resolve => { sawHeaders = resolve; });
  const body = JSON.stringify({ token: gateway.token, name: 'host_waitFor', arguments: {} });
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(gateway.url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(JSON.parse(text)));
    });
    request.on('error', reject);
  });
  request.write(body.slice(0, 5)); await headers;
  currentDesktop = 'http-new'; user('worker', currentDesktop);
  request.end(body.slice(5));
  const httpResult = await response;
  assert.equal(httpResult.isError, false, 'stale desktop source must not block waitFor text');
  const slowWait = ctx.resumeWait.store.get(JSON.parse(httpResult.text).id);
  await ctx.resumeWait.awaitDesktopSources([slowWait]);
  await fire(slowWait);
  await assert.rejects(use('worker', 'slow-http-auto', takeGui()), /continuation/i,
    'a slow old request cannot borrow the newer desktop turn');
  gateway.close(); gateway = undefined;

  // An already queued action must recheck its private source at the input seat.
  let valid = true, unblock, entered;
  const revocable = { allows: origin => valid && freshProof.allows(origin) };
  turns.begin('worker', 'seat-turn', () => true, false, undefined, { workspaceId: 'ws', continuation: revocable });
  const enteredSeat = new Promise(resolve => { entered = resolve; });
  const held = turns.use('worker', 'seat-turn', 'fixture', async () => {
    entered(); await new Promise(resolve => { unblock = resolve; }); return 'first';
  });
  void held.catch(() => {});
  await enteredSeat;
  let queuedDispatched = false;
  const queued = turns.use('worker', 'seat-turn', 'fixture', async () => { queuedDispatched = true; });
  void queued.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  valid = false; unblock();
  await assert.rejects(held, /continuation|current|unknown|stopped/i);
  await assert.rejects(queued, /continuation|current|aborted|stopped/i);
  assert.equal(queuedDispatched, false, 'revocation while queued must prevent backend entry');

  // A wait may arrive before the stop barrier has finished. Text is delivered
  // immediately; the desktop waits for the source to be durably authorized.
  let releaseStop, holdRelease = true;
  turns = new DesktopTurns(new DesktopActivity({ show: async () => {}, close() {} },
    () => holdRelease ? new Promise(resolve => { releaseStop = resolve; }) : Promise.resolve(), labels, undefined, undefined, ledger));
  const stopping = turns.stop();
  user('worker', 'pending-user');
  const pendingWait = await armGui('pending-user', 'pending authorization');
  assert.equal(ctx.resumeWait.desktopSourcesPending([pendingWait]), true);
  await fire(pendingWait);
  const pendingProof = takeGui();
  assert.equal(pendingProof.pending(), true, 'source readiness does not delay text delivery');
  const pendingUse = use('worker', 'pending-auto', pendingProof);
  let completed = false; void pendingUse.finally(() => { completed = true; }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'desktop use waits for the accepted instruction to finish resuming');
  holdRelease = false; releaseStop();
  await stopping;
  assert.equal(await pendingUse, 'dispatched');
  turns.end('worker', 'pending-auto');

  // A valid preemption from the same pending instruction waits for its own
  // source without creating a cycle with the turn's existing readiness.
  holdRelease = true; releaseStop = undefined;
  const preemptStop = turns.stop();
  user('worker', 'pending-preempt-user');
  const pendingPreempt = await armGui('pending-preempt-user', 'pending preempt', { priority: 'preempt' });
  entry.activeDesktopTurnId = 'pending-preempt-user'; guiBusy = true;
  await fire(pendingPreempt);
  assert.ok(steered.some(text => text.includes('pending preempt')), 'pending proof must not delay preempted text');
  const preemptUse = turns.use('worker', 'pending-preempt-user', 'fixture', async () => 'post-preempt');
  void preemptUse.catch(() => {});
  holdRelease = false; releaseStop();
  await preemptStop;
  assert.equal(await preemptUse, 'post-preempt');
  guiBusy = false;
  turns.end('worker', 'pending-preempt-user');

  // Closing the wait runtime before a pending source was committed cannot
  // recreate the source database later or grant the next process a false proof.
  holdRelease = true; releaseStop = undefined;
  const closingStop = turns.stop();
  user('worker', 'closing-user');
  const closingWait = await armGui('closing-user', 'pending during shutdown');
  const closingService = ctx.resumeWait;
  assert.equal(closingService.desktopSourcesPending([closingWait]), true);
  detach(); detach = undefined;
  holdRelease = false; releaseStop();
  await closingStop; await closingService.awaitDesktopSources([closingWait]);
  log.close(); log = undefined; ledger.close(); ledger = undefined;
  attach();
  await fire(closingWait);
  await assert.rejects(use('worker', 'after-closed-source', takeGui()), /continuation/i,
    'an uncommitted source stays unavailable after restart');

  // If a second stop wins while the source is pending, the stale instruction
  // and the wait it tried to create cannot recover a desktop run.
  turns = new DesktopTurns(new DesktopActivity({ show: async () => {}, close() {} },
    () => holdRelease ? new Promise(resolve => { releaseStop = resolve; }) : Promise.resolve(), labels, undefined, undefined, ledger));
  holdRelease = true; releaseStop = undefined;
  const firstStop = turns.stop();
  user('worker', 'racing-user');
  const racingWait = await armGui('racing-user', 'second stop wins');
  const secondStop = turns.stop();
  await fire(racingWait);
  const racingProof = takeGui();
  const racingUse = use('worker', 'racing-auto', racingProof);
  void racingUse.catch(() => {});
  holdRelease = false; releaseStop();
  await Promise.all([firstStop, secondStop]);
  await assert.rejects(racingUse, /continuation|instruction|stopped/i);

  // A cached in-memory owner resume cannot mask a subsequently damaged ledger.
  const faultFile = path.join(temp, 'owner-fault.sqlite');
  const faultLedger = new DesktopResumeStateLedger(faultFile);
  const faultTurns = new DesktopTurns(new DesktopActivity({ show: async () => {}, close() {} }, async () => {}, labels, undefined, undefined, faultLedger));
  await faultTurns.stop();
  faultTurns.noteUserInstruction('fault-owner', 'fault-message');
  faultTurns.begin('fault-owner', 'fault-user', () => true, true, 'fault-message');
  assert.equal(await faultTurns.use('fault-owner', 'fault-user', 'fixture', async () => 'authorized'), 'authorized');
  faultTurns.end('fault-owner', 'fault-user');
  const corrupt = new DatabaseSync(faultFile); corrupt.exec('DROP TABLE desktop_resume_owners'); corrupt.close();
  faultTurns.begin('fault-owner', 'fault-auto', () => true, false, undefined,
    { continuation: { allows: () => true }, workspaceId: 'ws' });
  await assert.rejects(faultTurns.use('fault-owner', 'fault-auto', 'fixture', async () => assert.fail('ledger failure dispatched')), /stop state is unavailable/i);
  faultLedger.close();
  console.log('desktop continuation integration: SQLite restart, source issuance, task epochs, mixed/tampered batches and preemption passed');
} finally {
  gateway?.close(); detach?.(); log?.close(); ledger?.close();
  removeWorkspaceFixture(temp, 'desktop-continuation-integration-');
}
