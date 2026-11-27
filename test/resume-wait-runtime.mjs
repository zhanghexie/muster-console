import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-wait-runtime-'));
const originalNow = Date.now;
let log, detach, workerEpochRuntime, schedulerEpochRuntime, resetMessageStore;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const mailStore = await load('main/metaAgent/messageStore.ts');
  resetMessageStore = mailStore.resetMessageStoreChainsForTest;
  const { ResumeWaitStore } = await load('main/resumeWait/store.ts');
  const { attachResumeWait, refreshResumeWait } = await load('main/resumeWait/runtime.ts');
  const { WorkerDesktopEpochRuntime } = await load('main/desktop/workerEpochRuntime.ts');
  const { SchedulerDesktopEpochRuntime } = await load('main/desktop/schedulerEpochRuntime.ts');
  const dir = path.join(tmp, 'data'); mailStore.setAgentMessagesUserDataDir(dir);
  log = new EventLog(dir); const router = new EventRouter(log, async () => {});
  let now = originalNow(), busy = true, orchBusy = true, humanWaiting = false, aborts = 0;
  let guiCapabilities, driverAvailable = true;
  Date.now = () => now;
  const sends = [], interjects = [], lifecycle = new Set(), phases = new Set(), removed = new Set(), notifications = [];
  const cliSessions = new Map(), cliBindings = new Map(), running = new Set(), strategies = new Map();
  const writes = [], relaunches = [], respawns = [], nativeMessages = [];
  const worker = { id: 'worker', name: 'worker', type: 'terminal', launchKind: 'agent', runtime: 'codex-gui', workspaceId: 'ws', createdAt: 1, lifecycle: 'working' };
  const archiveGuards = new Set(), sessionToken = {};
  const subscribe = set => fn => { set.add(fn); return () => set.delete(fn); };
  const ctx = { eventRouter: router, resolveBubbleWorkspaceId: () => 'ws', config: { get: () => ({}) },
    workspaces: { list: () => [{ id: 'ws', path: dir }] },
    sessions: { get: id => id === 'worker' ? worker : cliSessions.get(id), peek: id => id === 'worker' ? worker : cliSessions.get(id),
      sessionScopeToken: id => id === 'worker' && !worker.archived ? sessionToken : undefined,
      onBeforeArchive: subscribe(archiveGuards), onLifecycle: subscribe(lifecycle), onPhaseFlip: subscribe(phases), onSessionRemoved: subscribe(removed),
      isChatRuntime: runtime => runtime === 'codex-gui', broadcastMessagesChanged() {},
      getCliWorkspaceContext: id => cliBindings.get(id),
      injectStrategy: async runtime => strategies.get(runtime), pasteInput: async () => false,
      async respawn(id) { respawns.push(id); running.add(id); cliBindings.set(id, {}); cliSessions.get(id).lifecycle = 'idle'; },
      async relaunchWithPrompt(id, text) { relaunches.push({ id, text }); },
      captureManagedInterruptSnapshot: async (_id, _now, workContext) => ({ brief: `managed work snapshot\n${workContext}` }) },
    agentSessions: { entries: new Map(), isBusy: () => busy, isOpen: () => true,
      getDriver: () => driverAvailable ? { ...(guiCapabilities ? { deliveryCapabilities: guiCapabilities } : {}) } : undefined,
      async send(_id, text, _images, opts) { sends.push({ text, id: opts.messageId, desktopContinuation: opts.desktopContinuation }); return { ok: true }; },
      async abort(id) { aborts++; busy = false; this.entries.get(id).busy = false; },
      observe: () => ({ busy, updatedAt: 1, lastReply: null }) },
    orchestrator: { isBusy: () => orchBusy, getHumanWait: () => humanWaiting ? {} : null, onEvent: () => () => {},
      async interjectHostNotification(_ws, delivery) { const batch = await delivery.prepare(); interjects.push(batch); await delivery.accepted(batch); return true; } },
    notify: { push(entry) { notifications.push(entry); } }, pty: { getBufferTail() {}, isRunning: id => running.has(id),
      captureWriter: () => ({ write(id, data) { writes.push({ id, data }); return running.has(id); } }) } };
  const staleStore = new ResumeWaitStore(dir);
  const staleWait = staleStore.arm({ owner: 'deleted-worker', workspaceId: 'ws', condition: { kind: 'time', at: new Date(now).toISOString() }, note: 'stale wait', priority: 'normal', deadlineAt: null });
  staleStore.close();
  detach = attachResumeWait(ctx, dir);
  assert.equal(ctx.resumeWait.store.get(staleWait.id).state, 'cancelled', 'startup retires waits whose managed session was deleted');
  workerEpochRuntime = new WorkerDesktopEpochRuntime(dir, ctx.sessions);
  ctx.desktopEpochs = workerEpochRuntime;
  const actualBinding = ctx.resumeWait.arm('worker', 'ws', { condition: { kind: 'mail', from: 'epoch-test' }, note: 'epoch' });
  assert.equal(actualBinding.desktopEpoch, 'worker');
  assert.equal(actualBinding.desktopEpochGeneration, 0);
  for (const guard of archiveGuards) guard([worker]);
  worker.archived = true;
  for (const fn of lifecycle) fn(worker, 'idle', 'exited');
  assert.equal(ctx.resumeWait.store.get(actualBinding.id).state, 'cancelled', 'archiving a managed session retires its pending wait');
  assert.throws(() => workerEpochRuntime.currentBinding('worker'), /unavailable/);
  worker.archived = false;
  const afterArchive = ctx.resumeWait.arm('worker', 'ws', { condition: { kind: 'mail', from: 'epoch-test-2' }, note: 'epoch 2' });
  assert.equal(afterArchive.desktopEpochGeneration, 1);
  assert.equal(ctx.resumeWait.store.get(actualBinding.id).desktopEpochGeneration, 0);
  schedulerEpochRuntime = new SchedulerDesktopEpochRuntime(dir, { async confirmWithReceipt() {
    return { approvalId: 'scheduler-receipt', decision: { confirmed: true, kind: 'allowOnce' } };
  } });
  await schedulerEpochRuntime.ensureCapture('orchestrator:ws', () => true);
  ctx.desktopEpochs = schedulerEpochRuntime;
  const schedulerBinding = ctx.resumeWait.arm('orchestrator:ws', 'ws', { condition: { kind: 'mail', from: 'scheduler-epoch-test' }, note: 'scheduler epoch' });
  assert.equal(schedulerBinding.desktopEpoch, 'scheduler-receipt');
  schedulerEpochRuntime.closeSession('orchestrator:ws');
  const schedulerReset = ctx.resumeWait.arm('orchestrator:ws', 'ws', { condition: { kind: 'mail', from: 'scheduler-reset-test' }, note: 'new conversation' });
  assert.equal(schedulerReset.desktopEpoch, null); assert.equal(schedulerReset.desktopEpochUnknown, false);
  ctx.desktopEpochs = { currentBinding: owner => owner === 'worker' ? { epoch: 'worker-epoch', anchor: 'worker-confirmation', generation: 2 } : null };
  const spin = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'scheduled runtime work did not settle');
  };
  const wait = ctx.resumeWait.arm('worker', 'ws', { condition: { kind: 'event', source: 'gitlab', types: ['issue'], scope: '6528' }, note: 'keep this\n  exactly' });
  assert.equal(wait.desktopEpoch, 'worker-epoch', 'runtime binds host-owned epoch at arm time');
  delete ctx.desktopEpochs;
  assert.equal(ctx.resumeWait.store.get(wait.id).desktopEpoch, 'worker-epoch');
  const missingProvider = ctx.resumeWait.arm('worker', 'ws', { condition: { kind: 'mail', from: 'never-missing' }, note: 'still deliver' });
  assert.equal(missingProvider.desktopEpochUnknown, true, 'runtime must not treat an unconnected identity provider as an empty epoch');
  ctx.desktopEpochs = { currentBinding: () => null };
  router.publish({ source: 'gitlab', type: 'issue', scope: '6528', workspaceId: 'ws', receivedAt: now, summary: 'one', payload: '{}' });
  await spin(() => ctx.resumeWait.store.get(wait.id).attempts > 0);
  assert.equal(sends.length, 0, 'normal delivery waits for turn boundary');
  busy = false; worker.lifecycle = 'idle';
  for (const fn of lifecycle) fn(worker, 'working', 'idle');
  refreshResumeWait(ctx);
  await spin(() => sends.length === 1);
  assert.equal(guiCapabilities, undefined, 'a GUI driver without deliveryCapabilities can arm and use the ordinary host send channel');
  assert.equal(ctx.resumeWait.store.get(wait.id).state, 'delivering', 'host admission is not consumption');
  assert.match(sends[0].text, /keep this\n  exactly/);
  assert.equal(typeof sends[0].desktopContinuation?.allows, 'function', 'the GUI host receives a private continuation guard');
  assert.equal(sends[0].desktopContinuation.allows({ owner: 'worker', workspaceId: 'ws', stopGeneration: 0 }), false,
    'missing host desktop source never becomes authorization');
  assert.equal(ctx.resumeWait.acknowledge('worker', sends[0].id), true);
  assert.equal(ctx.resumeWait.store.get(wait.id).state, 'consumed');
  const urgent = ctx.resumeWait.arm('orchestrator:ws', 'ws', { condition: { kind: 'event', source: 'gitlab', types: ['issue'], scope: 'urgent' }, note: 'resume scheduler', priority: 'preempt' });
  router.publish({ source: 'gitlab', type: 'issue', scope: 'urgent', workspaceId: 'ws', receivedAt: now, summary: 'urgent', payload: '{}' });
  await spin(() => interjects.length === 1);
  assert.equal(ctx.resumeWait.store.get(urgent.id).state, 'consumed');
  assert.match(interjects[0].content, /resume scheduler/);
  humanWaiting = true;
  const held = ctx.resumeWait.arm('orchestrator:ws', 'ws', { condition: { kind: 'event', source: 'gitlab', types: ['issue'], scope: 'held' }, note: 'hold for human', priority: 'preempt' });
  router.publish({ source: 'gitlab', type: 'issue', scope: 'held', workspaceId: 'ws', receivedAt: now, summary: 'held', payload: '{}' });
  await spin(() => ctx.resumeWait.store.get(held.id).failures === 1);
  assert.equal(interjects.length, 1, 'preemption does not bypass a pending human question');
  humanWaiting = false; now += 500; refreshResumeWait(ctx);
  await spin(() => interjects.length === 2);
  assert.equal(ctx.resumeWait.store.get(held.id).state, 'consumed');

  const schedulerWakes = [];
  orchBusy = false;
  ctx.schedulerStatus = { get: () => ({ phase: 'needs_you' }) };
  ctx.orchestrator.send = async (_text, _ws, _images, options) => {
    if (!options.beforeStart()) return options.onSkipped();
    assert.equal(options.schedulerWake, true);
    const batch = await options.notification.prepare();
    schedulerWakes.push(batch.content);
    await options.notification.accepted(batch);
    options.notification.started(batch);
    options.notification.settled();
  };
  const workerPhaseWait = ctx.resumeWait.arm('orchestrator:ws', 'ws', {
    condition: { kind: 'session', sessionId: 'worker', phase: 'needs_you' }, note: 'Read the worker report and continue.'
  });
  worker.phase = { value: 'needs_you', source: 'model', ts: now };
  for (const fn of phases) fn(worker, 'needs_you');
  await spin(() => ctx.resumeWait.store.get(workerPhaseWait.id).state === 'consumed');
  assert.equal(schedulerWakes.length, 1);
  assert.match(schedulerWakes[0], /Read the worker report and continue\./);
  delete worker.phase;
  delete ctx.schedulerStatus;

  busy = true; worker.lifecycle = 'working'; guiCapabilities = { interject: false, snapshot: true };
  ctx.agentSessions.entries.set('worker', { busy: true, activeExecutionTurnId: 'turn-1', lastTurnInput: { text: 'old work' },
    assistant: { parts: [{ kind: 'text', text: 'partial work' }] } });
  const preempt = ctx.resumeWait.arm('worker', 'ws', { condition: { kind: 'event', source: 'gitlab', types: ['issue'], scope: 'worker' }, note: 'handle urgent', priority: 'preempt' });
  router.publish({ source: 'gitlab', type: 'issue', scope: 'worker', workspaceId: 'ws', receivedAt: now, summary: 'worker', payload: '{}' });
  await spin(() => sends.length === 2);
  assert.equal(aborts, 1);
  assert.match(sends[1].text, /handle urgent[\s\S]*managed work snapshot[\s\S]*old work/);
  assert.equal(ctx.resumeWait.acknowledge('worker', sends[1].id), true);
  assert.equal(ctx.resumeWait.store.get(preempt.id).state, 'consumed');
  let guiMessage;
  busy = true; guiCapabilities = { interject: true, snapshot: true };
  ctx.agentSessions.entries.set('worker', { busy: true, activeExecutionTurnId: 'turn-2',
    connection: { async receiveMessage(message) { guiMessage = message; return { status: 'accepted', method: 'steered' }; } } });
  const native = ctx.resumeWait.arm('worker', 'ws', { condition: { kind: 'event', source: 'gitlab', types: ['issue'], scope: 'native' }, note: 'urgent on pi', priority: 'preempt' });
  router.publish({ source: 'gitlab', type: 'issue', scope: 'native', workspaceId: 'ws', receivedAt: now, summary: 'native', payload: '/skill:not-a-user-request' });
  await spin(() => ctx.resumeWait.store.get(native.id).state === 'consumed');
  assert.equal(guiMessage.hostNotification, true);
  assert.match(guiMessage.text, /\/skill:not-a-user-request/);
  assert.equal(aborts, 1, 'native host interjection does not stop the working turn');
  guiCapabilities = undefined;
  const beforeBoundary = sends.length;
  const boundary = ctx.resumeWait.arm('worker', 'ws', { condition: { kind: 'time', at: new Date(now).toISOString() },
    note: 'no native preemption; continue at idle', priority: 'preempt' });
  await ctx.resumeWait.tick();
  assert.equal(ctx.resumeWait.store.get(boundary.id).state, 'ready');
  assert.equal(sends.length, beforeBoundary);
  assert.equal(aborts, 1, 'missing preemption capabilities must not stop the working GUI turn');
  await ctx.resumeWait.tick();
  assert.equal(ctx.resumeWait.store.get(boundary.id).attempts, 1, 'busy boundary waiting must not repeatedly submit');
  const queuedNotice = notifications.find(entry => entry.text.includes(boundary.id));
  assert.ok(queuedNotice, 'a queued preempt wait reports that it is waiting for the boundary');
  assert.match(queuedNotice.label, /排队/);
  assert.match(queuedNotice.text, /已排队到回合边界投递/);
  assert.doesNotMatch(queuedNotice.text, /未完成|核对目标会话|避免重复执行/,
    'queueing behind a busy turn is not reported as a failed or uncertain delivery');
  const hostNotices = mailStore.readAgentMessageLedger(dir, 'ws').messages
    .filter(message => message.from === 'host' && message.to === 'orchestrator:ws' && message.text.includes(boundary.id));
  assert.ok(hostNotices.some(message => /已排队到回合边界投递/.test(message.text)));
  assert.ok(hostNotices.every(message => !/未完成|核对目标会话|避免重复执行/.test(message.text)),
    'the scheduler notice must not claim an incomplete delivery while the wait is still queued');
  busy = false; worker.lifecycle = 'idle';
  ctx.agentSessions.entries.get('worker').busy = false;
  for (const fn of lifecycle) fn(worker, 'working', 'idle');
  await spin(() => sends.length === beforeBoundary + 1);
  assert.equal(ctx.resumeWait.store.get(boundary.id).state, 'delivering');
  assert.equal(ctx.resumeWait.acknowledge('worker', sends.at(-1).id), true);

  driverAvailable = false;
  const missingDriver = ctx.resumeWait.arm('worker', 'ws', { condition: { kind: 'time', at: new Date(now).toISOString() }, note: 'ordinary GUI send still owns admission' });
  await ctx.resumeWait.tick();
  assert.equal(sends.length, beforeBoundary + 2, 'an absent optional driver lookup does not replace ordinary host admission');
  assert.equal(ctx.resumeWait.store.get(missingDriver.id).state, 'delivering');
  assert.equal(ctx.resumeWait.acknowledge('worker', sends.at(-1).id), true);

  const addCli = (id, { cold = false, strategy, receiveMessage } = {}) => {
    const session = { id, name: id, type: 'terminal', launchKind: 'agent', runtime: id, workspaceId: 'ws',
      cwd: dir, externalSessionId: `engine-${id}`, lifecycle: cold ? 'exited' : 'idle' };
    cliSessions.set(id, session);
    if (!cold) running.add(id);
    if (strategy) strategies.set(id, strategy);
    if (receiveMessage) cliBindings.set(id, { receiveMessage });
    return session;
  };
  const armCli = (id, more = {}) => ctx.resumeWait.arm(id, 'ws', {
    condition: { kind: 'time', at: new Date(now).toISOString() }, note: `continue ${id}`, ...more });
  for (const [id, options] of [['cli-pty', {}], ['cli-relaunch', { strategy: 'relaunch-resume' }], ['cli-cold', { cold: true }]]) {
    addCli(id, options);
    const cliWait = armCli(id);
    await ctx.resumeWait.tick();
    assert.equal(ctx.resumeWait.store.get(cliWait.id).state, 'consumed', `${id}: ordinary transport acceptance closes delivery without inventing a task completion receipt`);
    if (options.strategy) {
      assert.match(relaunches.find(item => item.id === id)?.text ?? '', new RegExp(`continue ${id}`));
      assert.equal(writes.some(item => item.id === id), false, 'relaunch strategy must not also type the same notice');
    } else {
      const terminal = writes.filter(item => item.id === id);
      assert.equal(terminal.length, 2, `${id}: one body and one Enter through the common PTY transport`);
      assert.match(terminal[0].data, new RegExp(`continue ${id}`));
      assert.equal(terminal[1].data, '\r');
    }
    if (options.cold) assert.deepEqual(respawns, [id], 'cold CLI restores its existing binding through the common respawn path');
  }

  const busyCli = addCli('cli-boundary'); busyCli.lifecycle = 'working';
  const cliBoundary = armCli(busyCli.id, { priority: 'preempt' });
  const writesBeforeBoundary = writes.length;
  await ctx.resumeWait.tick(); await ctx.resumeWait.tick();
  assert.equal(ctx.resumeWait.store.get(cliBoundary.id).state, 'ready');
  assert.equal(ctx.resumeWait.store.get(cliBoundary.id).attempts, 1);
  assert.equal(writes.length, writesBeforeBoundary, 'busy CLI without native capabilities never receives typed preemption');
  busyCli.lifecycle = 'idle';
  await ctx.resumeWait.tick();
  assert.equal(ctx.resumeWait.store.get(cliBoundary.id).state, 'consumed');
  assert.equal(writes.length, writesBeforeBoundary + 2, 'the same wait is sent once when the CLI becomes idle');

  for (const method of ['written', 'sent', 'steered', 'stopped-and-sent', 'queued']) {
    const id = `cli-native-${method}`;
    addCli(id, { async receiveMessage(message) { nativeMessages.push({ id, message }); return { status: 'accepted', method }; } });
    const nativeWait = armCli(id), writesBefore = writes.length;
    await ctx.resumeWait.tick();
    const pending = ctx.resumeWait.store.get(nativeWait.id);
    assert.equal(pending.state, 'consumed', `${method}: native transport acceptance settles delivery without claiming engine execution or task completion`);
    assert.equal(writes.length, writesBefore, 'an accepted native notice must not also enter the keyboard transport');
    assert.equal(nativeMessages.at(-1).message.messageId, pending.deliveryId);
    assert.equal(nativeMessages.at(-1).message.idleOnly, true);
  }
  const acceptedCounts = [writes.length, relaunches.length, nativeMessages.length];
  now += 30001;
  await ctx.resumeWait.tick();
  now += 90000;
  await ctx.resumeWait.tick(); await ctx.resumeWait.tick();
  assert.deepEqual([writes.length, relaunches.length, nativeMessages.length], acceptedCounts,
    'accepted CLI transport submissions, including native queued, must not repeat after the turn-receipt timeout and uncertainty grace');
  for (const unavailable of ['missing', 'archived', 'shell']) {
    const id = `cli-unavailable-${unavailable}`;
    if (unavailable !== 'missing') {
      const session = addCli(id);
      if (unavailable === 'archived') session.archived = true;
      else session.launchKind = 'shell';
    }
    const unavailableWait = armCli(id);
    await ctx.resumeWait.tick();
    const current = ctx.resumeWait.store.get(unavailableWait.id);
    assert.equal(current.state, 'ready', `${unavailable}: an unavailable owner cannot become a successful delivery`);
    assert.equal(current.failures, 1, 'actual target unavailability is a known non-submission, not a capability error or an uncertain send');
    assert.deepEqual([writes.length, relaunches.length, nativeMessages.length], acceptedCounts);
    assert.deepEqual(respawns, ['cli-cold'], 'unavailable targets must not be relaunched');
  }
  orchBusy = false;
} finally { detach?.(); schedulerEpochRuntime?.close(); workerEpochRuntime?.close(); resetMessageStore?.(); log?.close(); Date.now = originalNow; fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
console.log('resume-wait-runtime: ok');
