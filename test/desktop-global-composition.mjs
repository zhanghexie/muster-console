/** Real SQLite and Pi agent-core; model stream and desktop effects are offline fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const prefix = 'desktop-global-composition-';
const temp = fs.mkdtempSync(path.resolve('.tmp', prefix));
const opened = new Set();
let tracker;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createGlobalDesktopComposition } = await import(pathToFileURL(compile('main/desktop/globalDesktopComposition.ts')));
  const { scopedGlobalVisibleRequestId, isRecordedGlobalVisibleRequest } = await import(pathToFileURL(compile('main/desktop/globalVisibleActionDispatcher.ts')));
  const { desktopLogicalOperationId, classifyDesktopActionResult } = await import(pathToFileURL(compile('main/desktop/desktopActionAuthority.ts')));
  const { PiToolDeliveryTracker } = await import(pathToFileURL(compile('main/agentSession/piToolDelivery.ts')));
  const fingerprint = 'ab'.repeat(32);
  const flags = { writers: true, continuations: true, stopped: false, recovery: false, lock: false };
  // These booleans are only fixture proofs, not assertions about the real host.
  const authority = { legacyWritersExcluded: () => flags.writers, legacyAutomaticContinuationsExcluded: () => flags.continuations,
    executorStopped: () => flags.stopped, verifyRecovery: ({ evidenceId }) => flags.recovery && evidenceId === 'fixture-independent-evidence',
    verifyAbandonedLock: () => flags.lock };
  const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
    legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyLegacyDelivery: () => false, verifyLegacyResolution: () => false };
  const actions = { resolveLogicalOperationId: r => scopedGlobalVisibleRequestId(r.sessionId, r.taskId, r.requestId),
    classifyResult: (_request, value) => value?.effect === 'unknown' ? { outcome: 'unknown' } : { outcome: 'known', value } };
  const context = (extra = {}) => ({ sessionId: 'session-1', taskId: 'task-1', target: 'window', action: 'win32.click', indicatorEpoch: 1,
    isCurrent: () => true, isIndicatorCurrent: epoch => epoch === 1, ...extra });
  const value = { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' };
  const dbFile = root => path.join(root, 'global-desktop-write.sqlite');
  const activate = async (name, overrides = {}) => {
    const root = path.join(temp, name);
    const runtime = await createGlobalDesktopComposition({ mode: 'activate', root, legacyRoots: [], legacyOutboxes: [], fence,
      authority, actions, ...overrides });
    opened.add(runtime); return { root, runtime };
  };
  const reopen = async (root, overrides = {}) => {
    const runtime = await createGlobalDesktopComposition({ mode: 'open', root, authority, actions, ...overrides });
    opened.add(runtime); return runtime;
  };
  const close = async runtime => { await runtime.close(); opened.delete(runtime); };
  const dbRead = (root, sql, ...args) => {
    const db = new DatabaseSync(dbFile(root), { readOnly: true });
    try { return db.prepare(sql).get(...args); } finally { db.close(); }
  };

  // Validate requirements before creating storage; a host cannot override vault verification.
  for (const overrides of [
    { authority: { ...authority, verifyDelivery: () => true } },
    { actions: { ...actions, deliveryEvidence: () => 'forged' } },
    { authority: { ...authority, verifyRecovery: undefined } },
    { authority: { ...authority, verifyUnknownContinuation: null } },
    { authority: { ...authority, verifyStorageUpgrade: true } },
    { actions: { ...actions, classifyResult: undefined } }
  ]) {
    const root = path.join(temp, `invalid-${Math.random().toString(16).slice(2)}`);
    await assert.rejects(createGlobalDesktopComposition({ mode: 'activate', root, legacyRoots: [], legacyOutboxes: [], fence,
      authority, actions, ...overrides }), /callbacks are required/);
    assert.equal(fs.existsSync(root), false);
  }

  // An exclusion that becomes invalid after the SQLite file is created aborts
  // construction, closes the handle and leaves an unsealed store to inspect.
  {
    const root = path.join(temp, 'incomplete');
    const changing = { ...authority, legacyWritersExcluded: () => !fs.existsSync(dbFile(root)) };
    await assert.rejects(createGlobalDesktopComposition({ mode: 'activate', root, legacyRoots: [], legacyOutboxes: [], fence,
      authority: changing, actions }), /excluded/);
    assert.equal(dbRead(root, 'SELECT ready FROM global_desktop_control').ready, 0);
    await assert.rejects(createGlobalDesktopComposition({ mode: 'open', root, authority, actions }), /not fully activated/);
  }

  // A real Pi tracker observes two actual agent-core turn_end events. The
  // stream supplies fake model messages and the dispatch is an offline fixture.
  {
    const { root, runtime } = await activate('pi', { actions: {
      resolveLogicalOperationId: desktopLogicalOperationId, classifyResult: classifyDesktopActionResult
    } });
    flags.continuations = false;
    await assert.rejects(runtime.dispatcher.run(context(), 'unfenced', fingerprint,
      async () => assert.fail('unfenced action dispatched')), /not dispatched/);
    flags.continuations = true;
    assert.equal(runtime.inspectMarker(), null);
    const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1:9',
      reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let requests = 0, effects = 0, acknowledgements = 0, agent;
    const reports = [], operations = [];
    const tool = { name: 'host_desktop_act', label: 'desktop', description: 'offline fixture', parameters: Type.Object({}),
      async execute(id, _args, signal) {
        assert.equal(signal, agent.signal);
        const requestId = id === 'call-1' ? 'first' : 'second';
        const current = () => !signal.aborted;
        const result = await runtime.dispatcher.run(context({ signal, isCurrent: current }), requestId, fingerprint,
          async () => { effects++; return value; });
        assert.equal(result.reply.outcome, 'dispatched');
        operations.push(result.reply.invocationId);
        assert.deepEqual(await result.acknowledge(), { outcome: 'unknown', reason: 'acknowledgement-failed' });
        const engine = runtime.desktopEngineDelivery(), marker = engine.inspectMarker();
        assert.equal(marker.operationId, result.reply.invocationId);
        const stage = engine.stager.stage({ marker, value, signal, isCurrent: current });
        const binding = { engine: 'scheduler-pi', connectionId: 'fixture-connection', hostTurnId: `host-${id}`,
          engineTurnId: `turn-${id}`, toolCallId: id, toolName: tool.name };
        const outputText = JSON.stringify({ ok: true, result: { outcome: 'dispatched', invocationId: marker.operationId, value } });
        engine.stager.bindOutput(stage, { binding, kind: 'win32', outputText });
        tracker.expect({ toolCallId: id, toolName: tool.name, outputText, isCurrent: current,
          acknowledge: () => engine.issuer.withVerifiedEvent(stage, { ...binding, outputText }, async () => {
            acknowledgements++; return result.acknowledge();
          }), onUnconfirmed: reason => reports.push(reason) });
        return { content: [{ type: 'text', text: outputText }], details: {} };
      } };
    const streamFn = () => {
      const n = ++requests, callId = n === 1 ? 'call-1' : n === 3 ? 'call-2' : null;
      const reply = { role: 'assistant', content: callId ? [{ type: 'toolCall', id: callId, name: tool.name, arguments: {} }] : [],
        api: model.api, provider: model.provider, model: model.id, usage, stopReason: callId ? 'toolUse' : 'stop', timestamp: Date.now() };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: reply });
        stream.push({ type: 'done', reason: reply.stopReason, message: reply }); stream.end(reply); });
      return stream;
    };
    agent = new Agent({ initialState: { model, tools: [tool] }, streamFn });
    tracker = new PiToolDeliveryTracker(agent);
    await agent.prompt('Run first fixture.');
    assert.equal(runtime.inspectMarker(), null);
    await agent.prompt('Run second fixture.');
    assert.equal(runtime.inspectMarker(), null);
    assert.equal(effects, 2); assert.equal(acknowledgements, 2); assert.deepEqual(reports, []);
    for (const id of operations) assert.equal(dbRead(root, 'SELECT phase FROM global_desktop_history WHERE operation_id=?', id).phase, 'confirmed');
    tracker.close(); tracker = undefined;

    const duplicate = await runtime.dispatcher.run(context(), 'first', fingerprint, async () => assert.fail('duplicate dispatched'));
    assert.equal(duplicate.reply.reason, 'request-already-recorded');
    assert.equal(isRecordedGlobalVisibleRequest(duplicate), true, 'composition preserves the private duplicate brand');

    const uncertain = await runtime.dispatcher.run(context(), 'uncertain', fingerprint, async () => ({ effect: 'unknown' }));
    assert.equal(uncertain.reply.outcome, 'unknown');
    assert.equal(runtime.inspectMarker().phase, 'unknown');
    await assert.rejects(runtime.dispatcher.run(context({ taskId: 'other-task' }), 'new', fingerprint,
      async () => assert.fail('unknown marker was bypassed')), /not dispatched/);
    await assert.rejects(runtime.recover(uncertain.reply.invocationId, 'fixture-independent-evidence', 'confirmed-not-applied', () => true), /evidence/);
    assert.equal(runtime.inspectMarker().operationId, uncertain.reply.invocationId);
    await close(runtime);
    const reopened = await reopen(root);
    assert.equal(reopened.inspectMarker().operationId, uncertain.reply.invocationId, 'close and restart preserve unknown state');
    await assert.rejects(reopened.dispatcher.run(context({ taskId: 'later' }), 'later', fingerprint,
      async () => assert.fail('restart bypassed marker')), /not dispatched/);
    flags.stopped = true; flags.recovery = true;
    assert.deepEqual(await reopened.recover(uncertain.reply.invocationId, 'fixture-independent-evidence', 'confirmed-not-applied', () => true),
      { outcome: 'resolved' });
    assert.equal(reopened.inspectMarker(), null);
    flags.stopped = false; flags.recovery = false;
    await close(reopened);
  }

  // The host supplies the opaque user event. A model string or another
  // operation's proof cannot clear the shared marker, including after reopen.
  {
    const proofs = new WeakMap();
    const continuationAuthority = { ...authority, verifyUnknownContinuation({ marker, authorization }) {
      assert.equal(this, continuationAuthority, 'host callbacks retain their receiver');
      const proof = proofs.get(authorization);
      return proof?.marker === JSON.stringify(marker) && proof.knewUnknown && proof.explicitContinue ? proof.eventId : null;
    } };
    const grant = (marker, eventId, overrides = {}) => {
      const proof = Object.freeze({});
      proofs.set(proof, { marker: JSON.stringify(marker), eventId, knewUnknown: true, explicitContinue: true, ...overrides });
      return proof;
    };
    const { root, runtime } = await activate('continuation', { authority: continuationAuthority });
    const first = await runtime.dispatcher.run(context(), 'unknown-first', fingerprint, async () => ({ effect: 'unknown' }));
    const marker = runtime.inspectMarker();
    assert.equal(first.reply.outcome, 'unknown');
    assert.equal(marker.operationId, first.reply.invocationId);
    assert.equal(marker.phase, 'unknown');
    const proof = grant(marker, 'fixture-user-event-1');
    const withoutVerifier = await reopen(root);
    await assert.rejects(withoutVerifier.acknowledgeUnknown(marker.operationId, proof, () => true), /verification is unavailable/i);
    await close(withoutVerifier);
    flags.stopped = false;
    await assert.rejects(runtime.acknowledgeUnknown(marker.operationId, proof, () => true), /executor must be stopped/i);
    flags.stopped = true;
    await assert.rejects(runtime.acknowledgeUnknown(marker.operationId, proof, () => false), /executor must be stopped/i);
    await assert.rejects(runtime.acknowledgeUnknown(randomUUID(), proof, () => true), /executor must be stopped/i);
    await assert.rejects(runtime.acknowledgeUnknown(marker.operationId, 'model-text', () => true), /trusted user/i);
    await assert.rejects(runtime.acknowledgeUnknown(marker.operationId, {}, () => true), /matching trusted/i);
    await assert.rejects(runtime.acknowledgeUnknown(marker.operationId, grant({ ...marker, phase: 'prepared' }, 'wrong-marker'), () => true), /matching trusted/i);
    await assert.rejects(runtime.acknowledgeUnknown(marker.operationId, grant(marker, 'not-informed', { knewUnknown: false }), () => true), /matching trusted/i);
    assert.equal(runtime.inspectMarker().operationId, marker.operationId);
    assert.deepEqual(await runtime.acknowledgeUnknown(marker.operationId, proof, () => true), { outcome: 'acknowledged-unknown' });
    assert.equal(runtime.inspectMarker(), null);
    const stored = dbRead(root, 'SELECT phase,resolution FROM global_desktop_history WHERE operation_id=?', marker.operationId);
    assert.deepEqual({ ...stored }, { phase: 'acknowledged-unknown', resolution: null });
    const duplicate = await runtime.dispatcher.run(context(), 'unknown-first', fingerprint, async () => assert.fail('unknown request replayed'));
    assert.equal(duplicate.reply.outcome, 'unknown');
    assert.equal(duplicate.reply.invocationId, marker.operationId);
    assert.equal(isRecordedGlobalVisibleRequest(duplicate), true);

    // A different request is allowed, but a previously consumed host event
    // cannot acknowledge that request even with a newly minted fixture proof.
    let effects = 0;
    const second = await runtime.dispatcher.run(context(), 'unknown-second', fingerprint, async () => { effects++; return { effect: 'unknown' }; });
    assert.equal(effects, 1);
    const secondMarker = runtime.inspectMarker();
    assert.deepEqual(await runtime.acknowledgeUnknown(second.reply.invocationId,
      grant(secondMarker, 'fixture-user-event-1'), () => true), { outcome: 'unknown', reason: 'barrier-finalization-failed' });
    assert.equal(runtime.inspectMarker().operationId, second.reply.invocationId);
    assert.deepEqual(await runtime.acknowledgeUnknown(second.reply.invocationId,
      grant(secondMarker, 'fixture-user-event-2'), () => true), { outcome: 'acknowledged-unknown' });
    await close(runtime);
    const reopened = await reopen(root, { authority: continuationAuthority });
    const retained = await reopened.dispatcher.run(context(), 'unknown-first', fingerprint, async () => assert.fail('restart replayed'));
    assert.equal(retained.reply.outcome, 'unknown');
    assert.equal(retained.reply.invocationId, marker.operationId);
    assert.equal(isRecordedGlobalVisibleRequest(retained), true);
    await close(reopened);
    flags.stopped = false;
  }

  // A v1 store requires the actual host-provided migration fence. These are
  // fixture callbacks, not evidence that the production host has that fence.
  {
    const root = path.join(temp, 'migration-v1');
    fs.mkdirSync(root, { recursive: true });
    const digest = text => createHash('sha256').update(text).digest('hex');
    const operationId = randomUUID(), requestHash = digest('v1-request');
    const db = new DatabaseSync(dbFile(root));
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE global_desktop_control(slot INTEGER PRIMARY KEY CHECK(slot=1),version INTEGER NOT NULL CHECK(version=1),instance TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1)));
      CREATE TABLE global_desktop_history(request_hash TEXT PRIMARY KEY,context_hash TEXT NOT NULL,fingerprint_hash TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK(phase IN ('prepared','unknown','known','confirmed','resolved')),result_hash TEXT,token_hash TEXT,audit_hash TEXT,resolution TEXT);
      CREATE INDEX global_desktop_history_phase ON global_desktop_history(phase);
      CREATE TABLE global_desktop_marker(slot INTEGER PRIMARY KEY CHECK(slot=1),request_hash TEXT NOT NULL UNIQUE REFERENCES global_desktop_history(request_hash),operation_id TEXT NOT NULL UNIQUE);
      CREATE TABLE global_desktop_legacy_control(slot INTEGER PRIMARY KEY CHECK(slot=1),receipt_count INTEGER NOT NULL CHECK(receipt_count>=0),manifest_hash TEXT NOT NULL);
      CREATE TABLE global_desktop_legacy_receipts(root_hash TEXT NOT NULL,request_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,result_hash TEXT NOT NULL,
        format TEXT NOT NULL,delivery_state TEXT NOT NULL CHECK(delivery_state='unverified'),PRIMARY KEY(root_hash,request_hash));
      CREATE INDEX global_desktop_legacy_request ON global_desktop_legacy_receipts(request_hash);`);
    db.prepare('INSERT INTO global_desktop_control VALUES(1,1,?,1)').run(randomUUID());
    db.prepare('INSERT INTO global_desktop_legacy_control VALUES(1,0,?)').run(digest('[]'));
    db.prepare('INSERT INTO global_desktop_history VALUES(?,?,?,?,?,?,?,?,?)')
      .run(requestHash, digest('context'), digest('fingerprint'), operationId, 'unknown', null, null, null, null);
    db.prepare('INSERT INTO global_desktop_marker VALUES(1,?,?)').run(requestHash, operationId);
    db.close();
    await assert.rejects(reopen(root), /exclusive host fence/i);
    const migrationAuthority = { ...authority, permitted: false, checks: 0, remaining: Infinity, verifyStorageUpgrade(input) {
      assert.equal(this, migrationAuthority, 'migration callback retains its receiver');
      assert.deepEqual(input, { from: 1, to: 2 });
      this.checks++;
      return this.permitted && this.remaining-- > 0;
    } };
    await assert.rejects(reopen(root, { authority: migrationAuthority }), /exclusive host fence/i);
    assert.equal(dbRead(root, 'SELECT version FROM global_desktop_control').version, 1);
    assert.equal(dbRead(root, 'SELECT operation_id FROM global_desktop_marker').operation_id, operationId);
    migrationAuthority.permitted = true;
    migrationAuthority.remaining = 1;
    await assert.rejects(reopen(root, { authority: migrationAuthority }), /exclusive host fence/i);
    assert.equal(dbRead(root, 'SELECT version FROM global_desktop_control').version, 1, 'lost fence rolls migration back');
    assert.equal(dbRead(root, 'SELECT operation_id FROM global_desktop_marker').operation_id, operationId);
    migrationAuthority.remaining = Infinity;
    const upgraded = await reopen(root, { authority: migrationAuthority });
    assert.ok(migrationAuthority.checks >= 5, 'the upgrade rechecks the host fence before commit');
    assert.equal(upgraded.inspectMarker().operationId, operationId);
    assert.equal(dbRead(root, 'SELECT version FROM global_desktop_control').version, 2);
    await close(upgraded);
    const reopened = await reopen(root);
    assert.equal(reopened.inspectMarker().operationId, operationId);
    await close(reopened);
  }

  // Shutdown during the verifier must revoke the current operation and wait
  // for its lock cleanup rather than closing the backing SQLite handle early.
  {
    let runtime, closing;
    const continuationAuthority = { ...authority, verifyUnknownContinuation() {
      closing = runtime.close();
      return 'fixture-close-event';
    } };
    ({ runtime } = await activate('continuation-close', { authority: continuationAuthority }));
    const result = await runtime.dispatcher.run(context(), 'close-unknown', fingerprint, async () => ({ effect: 'unknown' }));
    const marker = runtime.inspectMarker();
    flags.stopped = true;
    await assert.rejects(runtime.acknowledgeUnknown(result.reply.invocationId, {}, () => true), /matching trusted|executor must be stopped/i);
    await closing; opened.delete(runtime);
    assert.throws(() => runtime.acknowledgeUnknown(marker.operationId, {}, () => true), /closing or closed/i);
    const reopened = await reopen(path.join(temp, 'continuation-close'));
    assert.equal(reopened.inspectMarker().operationId, marker.operationId);
    await close(reopened);
    flags.stopped = false;
  }

  // Shutdown also tracks the asynchronous host identity resolver before a
  // marker exists, so it cannot close SQLite while that call is still active.
  {
    let started, release, closed = false;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const slowActions = { ...actions, async resolveLogicalOperationId(request) {
      started(); await gate; return scopedGlobalVisibleRequestId(request.sessionId, request.taskId, request.requestId);
    } };
    const { root, runtime } = await activate('resolving', { actions: slowActions });
    const pending = runtime.dispatcher.run(context(), 'resolving', fingerprint, async () => assert.fail('shutdown dispatched'))
      .then(() => null, error => error);
    await entered;
    const closing = runtime.close();
    try {
      closing.then(() => { closed = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed, false);
      assert.equal(dbRead(root, 'SELECT COUNT(*) AS count FROM global_desktop_marker').count, 0);
    } finally {
      release();
      const error = await pending;
      assert.match(error?.message ?? '', /not dispatched/);
      await closing; opened.delete(runtime);
    }
  }

  // In-flight backend ignores cancellation: shutdown must wait for real backend
  // and lock cleanup. A reentrant close triggered by abort receives same promise.
  {
    const { root, runtime } = await activate('closing');
    let started, release, reentrant, settled = false, effects = 0;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const pending = runtime.dispatcher.run(context(), 'slow', fingerprint, async signal => {
      effects++;
      signal.addEventListener('abort', () => { reentrant = runtime.close(); }, { once: true });
      started(); await gate; return value;
    });
    await entered;
    let closing;
    try {
      const duplicate = await runtime.dispatcher.run(context(), 'slow', fingerprint, async () => assert.fail('concurrent duplicate dispatched'));
      assert.equal(duplicate.reply.reason, 'request-already-recorded');
      assert.equal(isRecordedGlobalVisibleRequest(duplicate), true);
      await assert.rejects(runtime.dispatcher.run(context({ taskId: 'other-task' }), 'concurrent', fingerprint,
        async () => assert.fail('concurrent write dispatched')), /not dispatched/);
      assert.equal(effects, 1);
      closing = runtime.close();
      const result = await pending;
      assert.equal(result.reply.outcome, 'unknown');
      assert.equal(reentrant, closing);
      assert.equal(runtime.close(), closing);
      closing.then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(dbRead(root, `SELECT h.phase FROM global_desktop_marker m
        JOIN global_desktop_history h ON h.operation_id=m.operation_id`).phase, 'unknown');
      await assert.rejects(runtime.dispatcher.run(context(), 'other', fingerprint, async () => assert.fail()), /closing or closed/);
    } finally {
      release(); await (closing ?? runtime.close()); opened.delete(runtime);
    }
    const reopened = await reopen(root);
    assert.equal(reopened.inspectMarker().phase, 'unknown');
    await close(reopened);
  }

  // Closing after staging revokes the unobserved proof and preserves the known
  // marker; calling an old acknowledgement closure cannot manufacture delivery.
  {
    const { root, runtime } = await activate('staged');
    const controller = new AbortController(), current = () => !controller.signal.aborted;
    const result = await runtime.dispatcher.run(context({ signal: controller.signal, isCurrent: current }), 'staged', fingerprint, async () => value);
    const engine = runtime.desktopEngineDelivery(), marker = engine.inspectMarker();
    const stage = engine.stager.stage({ marker, value, signal: controller.signal, isCurrent: current });
    const binding = { engine: 'scheduler-pi', connectionId: 'c', hostTurnId: 'h', engineTurnId: 'e', toolCallId: 'i', toolName: 'host_desktop_act' };
    const outputText = JSON.stringify({ ok: true, result: { outcome: 'dispatched', invocationId: marker.operationId, value } });
    engine.stager.bindOutput(stage, { binding, kind: 'win32', outputText });
    await close(runtime);
    await assert.rejects(engine.issuer.withVerifiedEvent(stage, { ...binding, outputText }, () => result.acknowledge()));
    assert.equal((await result.acknowledge()).outcome, 'unknown');
    const reopened = await reopen(root);
    assert.equal(reopened.inspectMarker().operationId, marker.operationId);
    assert.equal(reopened.inspectMarker().phase, 'known');
    await close(reopened);
  }
  console.log('desktop-global-composition: SQLite, Pi receipt, recovery and shutdown boundaries passed');
} finally {
  tracker?.close();
  for (const runtime of opened) await runtime.close();
  removeWorkspaceFixture(temp, prefix);
}
