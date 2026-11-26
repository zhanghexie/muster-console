import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, '.tmp', 'scheduler-desktop-turns-'));
const compiled = path.join(temp, 'compiled');
const compile = createSharedCompiler(root, compiled);
const sendEntry = compile('main/agent/orchestrator/sendPipeline.ts');
const turnEntry = compile('main/agent/orchestrator/turnExecution.ts');
const queueEntry = compile('main/agent/orchestrator/queueOps.ts');
const scopeEntry = compile('main/agent/agentScope.ts');
const activityEntry = compile('main/desktop/desktopActivity.ts');
const turnsEntry = compile('main/desktop/desktopTurns.ts');
const breakerEntry = compile('shared/compactBreaker.ts');
const boundary = (rel, code) => fs.writeFileSync(path.join(compiled, rel), code);
boundary('main/agent/providers/piProvider.mjs', 'export const abortPiTurn = () => {}; export const disposePiSessionResources = async () => {}; export const runPiProvider = args => globalThis.__desktopSchedulerProvider(args);');
boundary('main/agent/providers/modeExtension.mjs', 'export const getModeController = () => undefined;');
boundary('main/agent/orchestrator/planModes.mjs', 'export const bindModeController = () => {}; export const updatePlanCard = () => {};');
boundary('main/agent/orchestrator/turnGate.mjs', 'export const releaseTurnGate = () => {}; export const releaseGateTokenOnly = () => {}; export const bindTurnGateToken = () => {};');
boundary('main/agent/orchestrator/memoryInjection.mjs', 'export const composeReadPathTurnText = async (_ctx, _bucket, _ws, text) => text;');
boundary('main/agent/schedulerWorkspaceContext.mjs', 'export const captureSchedulerWorkspaceContext = () => ({ cwd: ".", writableDirectories: [] }); export const beginSchedulerWorkspaceContext = () => () => {}; export const getSchedulerConnectionContext = () => undefined;');
boundary('main/memory/runtime.mjs', 'export const getMemoryService = () => undefined; export const resolveMemoryWorkspaceRoot = () => undefined;');
boundary('main/turnChanges/runtime.mjs', 'export const turnChanges = () => ({ begin: (_owner, id) => ({ summary: { id, state: "collecting", files: [], warnings: [] }, ready: Promise.resolve(), finish: async () => ({ id, state: "ready", files: [], warnings: [] }) }) });');
boundary('main/turnChanges/rootDirs.mjs', 'export const reviewRootDirs = () => [];');
boundary('main/attachments/service.mjs', 'export const clearAttachments = () => {};');
const electronStub = path.join(compiled, 'node_modules', 'electron');
fs.mkdirSync(electronStub, { recursive: true });
fs.writeFileSync(path.join(electronStub, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
fs.writeFileSync(path.join(electronStub, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(temp)} };`);

const sendPipeline = await import(pathToFileURL(sendEntry).href);
const execution = await import(pathToFileURL(turnEntry).href);
const queueOps = await import(pathToFileURL(queueEntry).href);
const scope = await import(pathToFileURL(scopeEntry).href);
const { DesktopActivity } = await import(pathToFileURL(activityEntry).href);
const { DesktopTurns } = await import(pathToFileURL(turnsEntry).href);
const { initialCompactBreakerState } = await import(pathToFileURL(breakerEntry).href);

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

function fixture() {
  const activity = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, {});
  const real = new DesktopTurns(activity);
  const notes = [], begins = [];
  const turns = {
    noteUserInstruction(owner, id) { notes.push({ owner, id }); return real.noteUserInstruction(owner, id); },
    begin(...args) { begins.push(args); return real.begin(...args); },
    end(...args) { return real.end(...args); },
    use(...args) { return real.use(...args); },
    stop() { return real.stop(); }
  };
  const bucket = { display: [], api: [], busy: false, resetPiOnNextSend: false, queue: [], mode: 'default',
    compactBreaker: initialCompactBreakerState(), piSession: null };
  const o = { ctx: { desktopTurns: () => turns, config: { get: () => ({}) },
    usage: { recordSessionActivity() {}, recordDispatchTurn() {} }, ui: { setBubble() {} }, notify: { push() {} } },
    buckets: new Map([['ws', bucket]]), autoRetryTimers: new Map(), autoRetryAttempts: new Map(), pendingAsks: new Map(),
    ensureBucket: () => bucket, checkSendImages: () => ({ ok: true }), maybeIdleMicrocompact: async () => {},
    emit() {}, persistBucket() {}, abortPendingAsk() {}, invalidatePiSession() {}, getThinkingLevel: () => null,
    maybeAutoCompact() {}, onOrchestratorIdle() {}, scheduleTurnAutoRetry() {},
    startTurn: (...args) => execution.startTurn(o, ...args),
    drainQueue: (...args) => execution.drainQueue(o, ...args),
    send: (...args) => sendPipeline.send(o, ...args) };
  return { o, bucket, turns, notes, begins };
}

async function attemptDesktop(turns) {
  return scope.runAsCapturedSchedulerDesktopTurn(async () => {
    const turn = scope.currentSchedulerDesktopExecutionTurn();
    assert.ok(turn && Object.isFrozen(turn));
    return turns.use(turn.sessionId, turn.desktopTurnId, 'fixture', async () => 42);
  });
}

try {
  {
    const f = fixture();
    let report = 'needs_you';
    f.o.ctx.schedulerStatus = { remove(id) { assert.equal(id, 'ws'); report = undefined; } };
    globalThis.__desktopSchedulerProvider = async () => {};
    await sendPipeline.send(f.o, 'ordinary follow-up', 'ws');
    assert.equal(report, undefined, 'a human conversation can return to idle without a model call to setStatus');
    globalThis.__desktopSchedulerProvider = async () => { report = 'done'; };
    await sendPipeline.send(f.o, 'finish the task', 'ws');
    assert.equal(report, 'done', 'ending a turn preserves its explicit report');
    for (const phase of ['done', 'needs_you']) {
      report = phase;
      globalThis.__desktopSchedulerProvider = async () => {};
      await sendPipeline.send(f.o, 'host event', 'ws', undefined, { host: true, gateToken: 'host-slot' });
      assert.equal(report, phase, 'a background event preserves the human conversation status');
    }
  }
  // Acceptance precedes even the first microcompaction await. A message queued
  // before Stop must retain that exact identity when it is eventually drained.
  {
    const f = fixture(), compact = deferred();
    f.bucket.busy = true;
    f.o.maybeIdleMicrocompact = () => compact.promise;
    const sending = sendPipeline.send(f.o, 'queued before stop', 'ws');
    assert.equal(f.notes.length, 1, 'human acceptance must be recorded synchronously');
    compact.resolve(); await sending;
    const queued = f.bucket.queue[0];
    assert.equal(queued.id, f.notes[0].id);
    assert.equal(queued.desktopInstructionId, f.notes[0].id);
    await f.turns.stop(); f.bucket.busy = false;
    let rejected;
    globalThis.__desktopSchedulerProvider = async () => { try { await attemptDesktop(f.turns); } catch (e) { rejected = e.message; } };
    await execution.drainQueue(f.o, f.bucket, 'ws');
    assert.match(rejected, /predates the latest stop/);
    assert.equal(f.begins.at(-1)[4], queued.id);
  }

  // A genuinely new user instruction can resume; host and automatic retries
  // cannot manufacture an instruction after the stop.
  {
    const f = fixture(); await f.turns.stop();
    let result;
    globalThis.__desktopSchedulerProvider = async () => { result = await attemptDesktop(f.turns); };
    await sendPipeline.send(f.o, 'new user request', 'ws');
    assert.equal(result, 42);
    assert.equal(f.notes.length, 1);
    await f.turns.stop();
    let rejected;
    globalThis.__desktopSchedulerProvider = async () => { try { await attemptDesktop(f.turns); } catch (e) { rejected = e.message; } };
    await sendPipeline.send(f.o, 'host event', 'ws', undefined, { host: true, gateToken: 'host-slot' });
    assert.match(rejected, /new user instruction/);
    assert.equal(f.notes.length, 1, 'host events must not create user instructions');
    rejected = undefined;
    await sendPipeline.send(f.o, 'notification', 'ws', undefined, { notification: { settled() {} } });
    assert.match(rejected, /new user instruction/);
    assert.equal(f.notes.length, 1, 'notifications must not create user instructions');
    f.bucket.display = [
      { id: 'human', role: 'user', content: 'old request', createdAt: 1 },
      { id: 'failed', role: 'assistant', content: '', error: 'failure', createdAt: 2 }
    ];
    const retried = deferred();
    globalThis.__desktopSchedulerProvider = async () => {
      try { await attemptDesktop(f.turns); } catch (e) { rejected = e.message; }
      retried.resolve();
    };
    assert.equal(execution.retry(f.o, 'ws').accepted, true);
    await retried.promise;
    assert.match(rejected, /new user instruction/);
    assert.equal(f.notes.length, 1, 'retry must not create a fresh user instruction');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.bucket.busy, false);
  }

  // A tool that started before steer retains its old snapshot across awaits;
  // fresh tools receive the new identity only after steer delivery succeeds.
  {
    const f = fixture(), providerEntered = deferred(), oldRelease = deferred(), newCapture = deferred(), providerFinish = deferred();
    const steering = deferred();
    f.bucket.piSession = { isStreaming: true, steer: () => steering.promise };
    let oldTurn, oldAfter, oldNested, oldRejected, freshTurn, outside, emitPi;
    globalThis.__desktopSchedulerProvider = async args => {
      emitPi = args.onPiEvent;
      emitPi({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'initial request' }] } });
      const old = scope.runAsCapturedSchedulerDesktopTurn(async () => {
        oldTurn = scope.currentSchedulerDesktopExecutionTurn();
        providerEntered.resolve();
        await oldRelease.promise;
        oldAfter = scope.currentSchedulerDesktopExecutionTurn();
        await scope.runAsCapturedSchedulerDesktopTurn(async () => { oldNested = scope.currentSchedulerDesktopExecutionTurn(); });
        try { await f.turns.use(oldAfter.sessionId, oldAfter.desktopTurnId, 'fixture', async () => 1); }
        catch (e) { oldRejected = e.message; }
      });
      await newCapture.promise;
      await scope.runAsCapturedSchedulerDesktopTurn(async () => { freshTurn = scope.currentSchedulerDesktopExecutionTurn(); });
      await scope.runOutsideAgentScope(() => scope.runAsCapturedSchedulerDesktopTurn(async () => {
        outside = scope.currentSchedulerDesktopExecutionTurn();
      }));
      await old;
      await providerFinish.promise;
    };
    const running = sendPipeline.send(f.o, 'initial request', 'ws');
    await providerEntered.promise;
    assert.equal(oldTurn.isDesktopCurrent(), true);
    const steerPromise = queueOps.sendNow(f.o, 'new instruction', 'ws');
    assert.equal(oldTurn.isDesktopCurrent(), false, 'old tool identity must end before steer awaits');
    assert.equal(f.bucket.desktopTurnId, undefined, 'no fresh identity exists while delivery is pending');
    steering.resolve(); assert.equal(await steerPromise, 'steered');
    assert.equal(f.bucket.desktopTurnId, undefined, 'queue acceptance must not authorize a tool from the old model response');
    emitPi({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'new instruction' }] } });
    newCapture.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(freshTurn);
    assert.notEqual(freshTurn.desktopTurnId, oldTurn.desktopTurnId);
    assert.equal(freshTurn.isDesktopCurrent(), true);
    oldRelease.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(oldAfter, oldTurn, 'an in-flight call cannot inherit the steered turn');
    assert.equal(oldNested, oldTurn, 'nested work must retain the original captured turn');
    assert.equal(oldAfter.isDesktopCurrent(), false);
    assert.match(oldRejected, /unavailable/);
    assert.equal(outside, undefined, 'background work cannot inherit scheduler desktop identity');
    assert.equal(scope.currentSchedulerDesktopExecutionTurn(), undefined, 'identity is not global');
    providerFinish.resolve(); await running;
    assert.equal(freshTurn.isDesktopCurrent(), false, 'turn settlement invalidates the identity');
  }

  {
    let current;
    const wake = deferred();
    await scope.runWithSchedulerDesktopTurnSource(() => current, async () => {
      const work = scope.runAsCapturedSchedulerDesktopTurn(async () => {
        assert.equal(scope.currentSchedulerDesktopExecutionTurn(), undefined);
        await wake.promise;
        return scope.runAsCapturedSchedulerDesktopTurn(async () => scope.currentSchedulerDesktopExecutionTurn());
      });
      current = { sessionId: 'orchestrator:ws', desktopTurnId: 'new', isDesktopCurrent: () => true };
      wake.resolve();
      assert.equal(await work, undefined, 'an invocation that began without a turn cannot acquire one later');
      const fresh = await scope.runAsCapturedSchedulerDesktopTurn(async () => scope.currentSchedulerDesktopExecutionTurn());
      assert.equal(fresh.desktopTurnId, 'new');
      const headless = await scope.runOutsideSchedulerDesktopTurn(() =>
        scope.runAsCapturedSchedulerDesktopTurn(async () => scope.currentSchedulerDesktopExecutionTurn()));
      assert.equal(headless, undefined, 'headless execution cannot inherit an interactive desktop turn');
    });
  }

  // The installed Pi agent-core's real tool dispatch must preserve the
  // invocation snapshot across its own async tool execution boundary.
  {
    const entered = deferred(), wake = deferred();
    let current = { sessionId: 'orchestrator:ws', desktopTurnId: 'pi-old', isDesktopCurrent: () => true };
    let first, after;
    const tool = { name: 'fixture', label: 'fixture', description: 'fixture', parameters: Type.Object({}),
      execute: async () => scope.runAsCapturedSchedulerDesktopTurn(async () => {
        first = scope.currentSchedulerDesktopExecutionTurn(); entered.resolve(); await wake.promise;
        after = scope.currentSchedulerDesktopExecutionTurn();
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      }) };
    const call = scope.runWithSchedulerDesktopTurnSource(() => current, () => runToolCall(
      { id: 'call', name: 'fixture', arguments: {} },
      { tools: [tool], assistantMessage: { role: 'assistant', content: [] }, context: { messages: [], tools: [tool] } }
    ));
    await entered.promise;
    current = { sessionId: 'orchestrator:ws', desktopTurnId: 'pi-new', isDesktopCurrent: () => true };
    wake.resolve();
    const result = await call;
    assert.equal(result.isError, false);
    assert.equal(first.desktopTurnId, 'pi-old');
    assert.equal(after, first);
  }

  // Work originating in an already completed engine run must not acquire the
  // next run's live bucket identity merely because it wakes later.
  {
    const f = fixture(), wakeOld = deferred(), oldDone = deferred(), secondStarted = deferred(), finishSecond = deferred();
    let lateIdentity;
    globalThis.__desktopSchedulerProvider = async () => {
      void (async () => {
        await wakeOld.promise;
        await scope.runAsCapturedSchedulerDesktopTurn(async () => { lateIdentity = scope.currentSchedulerDesktopExecutionTurn(); });
        oldDone.resolve();
      })();
    };
    await sendPipeline.send(f.o, 'first turn', 'ws');
    globalThis.__desktopSchedulerProvider = async () => { secondStarted.resolve(); await finishSecond.promise; };
    const second = sendPipeline.send(f.o, 'second turn', 'ws');
    await secondStarted.promise;
    wakeOld.resolve(); await oldDone.promise;
    assert.equal(lateIdentity, undefined, 'a settled engine run cannot borrow the next turn');
    finishSecond.resolve(); await second;
  }

  // A rejected steer falling back to the queue must not re-record its old
  // instruction after a later Stop and thereby manufacture a new grant.
  {
    const f = fixture(), steering = deferred();
    f.bucket.busy = true;
    f.bucket.piSession = { isStreaming: true, steer: () => steering.promise };
    const sending = queueOps.sendNow(f.o, 'fallback message', 'ws');
    assert.equal(f.notes.length, 1);
    await f.turns.stop();
    steering.reject(new Error('steer rejected'));
    assert.equal(await sending, 'queued');
    const queued = f.bucket.queue[0];
    assert.equal(f.notes.length, 1);
    assert.equal(queued.id, f.notes[0].id);
    f.bucket.busy = false;
    let rejected;
    globalThis.__desktopSchedulerProvider = async () => { try { await attemptDesktop(f.turns); } catch (e) { rejected = e.message; } };
    await execution.drainQueue(f.o, f.bucket, 'ws');
    assert.match(rejected, /predates the latest stop/);
  }

  // Consumption may race ahead of the steer promise; a handled or rewritten
  // message must never be treated as a confirmed native user delivery.
  {
    const f = fixture(), providerEntered = deferred(), finish = deferred(), steering = deferred();
    f.bucket.piSession = { isStreaming: true, steer: () => steering.promise };
    let emitPi;
    globalThis.__desktopSchedulerProvider = async args => {
      emitPi = args.onPiEvent;
      emitPi({ type: 'message_start', message: { role: 'user', content: 'initial' } });
      providerEntered.resolve(); await finish.promise;
    };
    const running = sendPipeline.send(f.o, 'initial', 'ws');
    await providerEntered.promise;
    const pending = queueOps.sendNow(f.o, 'direct instruction', 'ws');
    emitPi({ type: 'message_start', message: { role: 'user', content: 'direct instruction' } });
    assert.equal(f.bucket.desktopTurnId, undefined, 'consumption alone cannot authorize before steer is accepted');
    steering.resolve('queued');
    assert.equal(await pending, 'steered');
    assert.ok(f.bucket.desktopTurnId, 'an accepted, consumed steer opens its own turn');
    f.bucket.piSession.steer = async () => 'handled';
    assert.equal(await queueOps.sendNow(f.o, 'handled command', 'ws'), 'steered');
    emitPi({ type: 'message_start', message: { role: 'user', content: 'handled command' } });
    assert.equal(f.bucket.desktopTurnId, undefined, 'handled input does not authorize desktop use');
    f.bucket.piSession.steer = async () => 'queued';
    assert.equal(await queueOps.sendNow(f.o, '/expanded', 'ws'), 'steered');
    emitPi({ type: 'message_start', message: { role: 'user', content: 'expanded by an input handler' } });
    assert.equal(f.bucket.desktopTurnId, undefined, 'unmatched transformed input fails closed');
    finish.resolve(); await running;
  }

  {
    const f = fixture(), providerEntered = deferred(), finish = deferred(), first = deferred(), second = deferred();
    let calls = 0, emitPi;
    f.bucket.piSession = { isStreaming: true, steer: () => (++calls === 1 ? first.promise : second.promise) };
    globalThis.__desktopSchedulerProvider = async args => {
      emitPi = args.onPiEvent;
      emitPi({ type: 'message_start', message: { role: 'user', content: 'initial' } });
      providerEntered.resolve(); await finish.promise;
    };
    const running = sendPipeline.send(f.o, 'initial', 'ws');
    await providerEntered.promise;
    const a = queueOps.sendNow(f.o, 'same text', 'ws');
    const b = queueOps.sendNow(f.o, 'same text', 'ws');
    second.resolve('queued'); await b;
    emitPi({ type: 'message_start', message: { role: 'user', content: 'same text' } });
    assert.equal(f.bucket.desktopTurnId, undefined, 'one of two identical pending inputs cannot authorize the later input');
    first.resolve('queued'); await a;
    assert.equal(f.bucket.desktopTurnId, undefined);
    emitPi({ type: 'message_start', message: { role: 'user', content: 'same text' } });
    assert.ok(f.bucket.desktopTurnId, 'both identical native messages have now been consumed');
    finish.resolve(); await running;
  }

  assert.deepEqual(queueOps.collectRestoredQueue([{ id: 'host', role: 'user', content: 'event', queued: true, host: true }]),
    [{ id: 'host', text: 'event', host: true }]);
  console.log('scheduler desktop turns: acceptance, queued stop, new instruction, host/retry and steer snapshots passed');
} finally {
  delete globalThis.__desktopSchedulerProvider;
  removeWorkspaceFixture(temp, 'scheduler-desktop-turns-');
}
