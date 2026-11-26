/** Real Pi agent-core and durable coordinator; model stream and desktop effect are offline fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const root = process.cwd();
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const prefix = 'pi-tool-delivery-';
const tmp = fs.mkdtempSync(path.join(root, '.tmp', prefix));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { PiToolDeliveryTracker } = await import(pathToFileURL(compile('main/agentSession/piToolDelivery.ts')));
const { createVisibleActionRuntime } = await import(pathToFileURL(compile('main/desktop/visibleActionFactory.ts')));
const { DesktopActivityRuntime } = await import(pathToFileURL(compile('main/desktop/desktopActivityRuntime.ts')));
const { CuaSemanticRuntime } = await import(pathToFileURL(compile('main/desktop/cuaSemanticRuntime.ts')));
const { createCuaVisibleAction } = await import(pathToFileURL(compile('main/desktop/cuaVisibleAction.ts')));
const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
const { VisibleActionDispatcher } = await import(pathToFileURL(compile('main/desktop/visibleActionDispatcher.ts')));
const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1:9',
  reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let sequence = 0;

async function runFixture(options = {}) {
  const dir = path.join(tmp, `case-${++sequence}`); fs.mkdirSync(dir);
  const runtime = createVisibleActionRuntime(path.join(dir, 'outbox.sqlite'), path.join(dir, 'locks'));
  let current = true, effects = 0, acknowledgements = 0, requests = 0, known, output, nextRequest, sdkToolSignal;
  const reports = [], events = [];
  const context = { sessionId: 'session', taskId: 'task', target: 'fixture', action: 'click', indicatorEpoch: 1,
    isCurrent: () => current, isIndicatorCurrent: epoch => current && epoch === 1 };
  let tracker, agent;
  const streamFn = (_model, llmContext) => {
    const first = ++requests === 1;
    if (!first) nextRequest = llmContext.messages;
    const reply = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'call-1', name: 'host_desktop_act', arguments: {} }] : [],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: reply });
      stream.push({ type: 'done', reason: reply.stopReason, message: reply }); stream.end(reply); });
    return stream;
  };
  const tool = { name: 'host_desktop_act', label: 'desktop', description: 'offline action fixture', parameters: Type.Object({}),
    async execute(id, _args, signal) {
      sdkToolSignal = signal;
      assert.equal(signal, agent.signal, 'Pi 1.4.0 passes the active run signal into its tool');
      known = await runtime.coordinator.run(context, async () => { effects++; return { fixture: 'acted' }; });
      assert.equal(known.outcome, 'known');
      output = JSON.stringify({ ok: true, result: known.value });
      tracker.expect({ toolCallId: id, toolName: 'host_desktop_act', outputText: output,
        isCurrent: () => current,
        acknowledge: async () => {
          acknowledgements++;
          if (options.ackUnknown) return { outcome: 'unknown', reason: 'acknowledgement-failed' };
          if (options.ackThrows) throw new Error('storage failed');
          return runtime.coordinator.acknowledgeKnown(context, known.invocationId, 'receipt-1', known.deliveryToken);
        },
        onUnconfirmed: reason => reports.push(reason) });
      if (options.duplicate) assert.throws(() => tracker.expect({ toolCallId: id, toolName: 'host_desktop_act', outputText: output,
        isCurrent: () => current, acknowledge: async () => ({ outcome: 'acknowledged' }), onUnconfirmed() {} }), /already awaiting/);
      if (options.close) tracker.close();
      if (options.abort) agent.abort();
      return { content: [{ type: 'text', text: output }], details: {} };
    } };
  agent = new Agent({ initialState: { model, tools: [tool] }, streamFn,
    ...(options.modifyResult ? { afterToolCall: async () => ({ content: [{ type: 'text', text: 'modified' }] }) } : {}) });
  agent.subscribe(async (event, signal) => {
    events.push(event.type);
    if (event.type === 'turn_end' && event.toolResults.length) {
      assert.equal(signal, sdkToolSignal, 'the tool and receipt event belong to the same Pi run');
    }
    if (event.type === 'tool_execution_end') {
      assert.equal(acknowledgements, 0, 'execution end is earlier than an engine receipt');
      await assert.rejects(runtime.coordinator.run(context, async () => { effects++; }), /not dispatched/);
      if (options.invalidate) current = false;
    }
    if (event.type === 'message_end' && event.message.role === 'toolResult') {
      assert.equal(acknowledgements, 0, 'message_end alone does not establish the completed tool turn');
    }
    if (event.type === 'turn_end' && options.dropState) {
      agent.state.messages = agent.state.messages.filter(message => message.role !== 'toolResult');
    }
    if (event.type === 'turn_end' && options.dropCall) event.message.content = [];
  });
  tracker = new PiToolDeliveryTracker(agent);
  try {
    await agent.prompt('Run the fixture.');
    return { runtime, context, tracker, restoreCurrent() { current = true; }, known, output, nextRequest,
      effects, acknowledgements, reports, events };
  } catch (error) {
    tracker.close(); runtime.close(); throw error;
  }
}

async function blocked(fixture) {
  const before = fixture.effects;
  await assert.rejects(fixture.runtime.coordinator.run(fixture.context, async () => { throw new Error('must not dispatch'); }), /not dispatched/);
  assert.equal(fixture.effects, before);
}

async function runRealSession(modifyMessage) {
  const dir = path.join(tmp, `session-${++sequence}`); fs.mkdirSync(dir);
  const desktop = createVisibleActionRuntime(path.join(dir, 'outbox.sqlite'), path.join(dir, 'locks'));
  const ctx = { sessionId: 'session', taskId: 'task', target: 'fixture', action: 'click', indicatorEpoch: 1,
    isCurrent: () => true, isIndicatorCurrent: epoch => epoch === 1 };
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(dir, 'models'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('fixture', { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-test-key',
    models: [{ id: model.id, name: model.name, reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512, cost: model.cost }] });
  const selected = modelRuntime.getModel('fixture', 'fixture'); assert.ok(selected);
  let requests = 0, tracker, session, known, expectedText, ackCount = 0;
  const reports = [];
  modelRuntime.streamSimple = () => {
    const first = ++requests === 1;
    const reply = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'real-1', name: 'host_desktop_act', arguments: {} }] : [],
      api: selected.api, provider: selected.provider, model: selected.id, usage, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: reply });
      stream.push({ type: 'done', reason: reply.stopReason, message: reply }); stream.end(reply); });
    return stream;
  };
  const tool = { name: 'host_desktop_act', label: 'desktop', description: 'offline action fixture', parameters: Type.Object({}),
    async execute(id) {
      known = await desktop.coordinator.run(ctx, async () => ({ fixture: 'acted' }));
      assert.equal(known.outcome, 'known');
      expectedText = JSON.stringify({ ok: true, result: known.value });
      tracker.expect({ toolCallId: id, toolName: 'host_desktop_act', outputText: expectedText, isCurrent: () => true,
        acknowledge: async () => {
          ackCount++;
          const recorded = session.sessionManager.getBranch().filter(entry => entry.type === 'message' && entry.message?.role === 'toolResult');
          assert.equal(recorded.length, 1, 'Pi session recorded the result before the core receipt');
          assert.equal(recorded[0].message.content[0].text, expectedText);
          return desktop.coordinator.acknowledgeKnown(ctx, known.invocationId, 'session-receipt', known.deliveryToken);
        }, onUnconfirmed: reason => reports.push(reason) });
      return { content: [{ type: 'text', text: expectedText }], details: {} };
    } };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const rewrite = api => api.on('message_end', event => event.message.role === 'toolResult'
    ? { message: { ...event.message, content: [{ type: 'text', text: 'extension changed the result' }] } } : undefined);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Offline receipt fixture.', extensionFactories: modifyMessage ? [rewrite] : [] });
  try {
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
      modelRuntime, model: selected, tools: ['host_desktop_act'], customTools: [tool],
      sessionManager: SessionManager.create(dir, path.join(dir, 'sessions')), thinkingLevel: 'off' }));
    tracker = new PiToolDeliveryTracker(session.agent);
    await session.prompt('Run the fixture.');
    if (modifyMessage) {
      assert.equal(ackCount, 0); assert.deepEqual(reports, ['result-mismatch']);
      await assert.rejects(desktop.coordinator.run(ctx, async () => { throw new Error('must not dispatch'); }), /not dispatched/);
    } else {
      assert.equal(ackCount, 1); assert.deepEqual(reports, []);
      const next = await desktop.coordinator.run(ctx, async () => ({ ok: true }));
      assert.equal(next.outcome, 'known');
    }
  } finally { tracker?.close(); session?.dispose(); desktop.close(); }
}

async function runStopBoundary() {
  const dir = path.join(tmp, `stop-${++sequence}`); fs.mkdirSync(dir);
  const durable = createVisibleActionRuntime(path.join(dir, 'outbox.sqlite'), path.join(dir, 'locks'));
  let finishCleanup, blockCleanup = false, indicatorVisible = false;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const activity = new DesktopActivityRuntime({
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' },
    createIndicator: () => ({ show: async () => { indicatorVisible = true; }, close: () => { indicatorVisible = false; } }),
    releaseAll: async () => { if (blockCleanup) await cleanup; }
  });
  const toolSignal = new AbortController();
  let hostTurnCurrent = true, perActionSignal, unsafeSignal, delivery, context, known;
  try {
    activity.turns.begin('session', 'turn', () => hostTurnCurrent);
    known = await activity.turns.use('session', 'turn', 'window', async (signal, lease) => {
      perActionSignal = signal;
      delivery = lease;
      const epoch = activity.visibilityEpoch();
      // This is the currently passed per-call combination; it stops following
      // the run after the seat operation has completed.
      unsafeSignal = AbortSignal.any([toolSignal.signal, signal]);
      const safeSignal = AbortSignal.any([toolSignal.signal, signal, delivery.signal]);
      context = { sessionId: 'session', taskId: 'task', target: 'window', action: 'click', indicatorEpoch: epoch,
        signal: safeSignal, isCurrent: () => hostTurnCurrent && delivery.isCurrent(),
        isIndicatorCurrent: value => activity.visibilityEpoch() === value };
      return durable.coordinator.run(context, async () => ({ fixture: 'acted' }));
    });
    assert.equal(known.outcome, 'known');
    assert.equal(delivery.isCurrent(), true);
    assert.equal(indicatorVisible, true, 'indicator stays visible between calls in the same turn');
    const epoch = activity.visibilityEpoch();
    blockCleanup = true;
    const stopping = activity.stop();
    assert.equal(toolSignal.signal.aborted, false, 'desktop stop need not end the model turn');
    assert.equal(hostTurnCurrent, true, 'desktop stop need not end the host turn');
    assert.equal(perActionSignal.aborted, false, 'completed seat signal no longer follows run cancellation');
    assert.equal(unsafeSignal.aborted, false, 'the per-call combination is not a receipt lease');
    assert.equal(activity.visibilityEpoch(), epoch, 'the indicator remains visible while stop cleanup is pending');
    assert.equal(delivery.signal.aborted, true, 'the host-owned run signal invalidates synchronously');
    assert.equal(delivery.isCurrent(), false);
    assert.equal(context.signal.aborted, true);
    await assert.rejects(durable.coordinator.acknowledgeKnown(context, known.invocationId, 'stop-receipt', known.deliveryToken), /acknowledgement rejected/);
    const later = { ...context, signal: undefined, isCurrent: () => true, isIndicatorCurrent: () => true };
    await assert.rejects(durable.coordinator.run(later, async () => { throw new Error('must not dispatch'); }), /not dispatched/);
    finishCleanup(); await stopping;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activity.isVisible(), false);
  } finally {
    hostTurnCurrent = false; finishCleanup();
    await activity.dispose(); durable.close();
  }
}

async function runHostEndBoundary() {
  const dir = path.join(tmp, `host-end-${++sequence}`); fs.mkdirSync(dir);
  const durable = createVisibleActionRuntime(path.join(dir, 'outbox.sqlite'), path.join(dir, 'locks'));
  const activity = new DesktopActivityRuntime({
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' },
    createIndicator: () => ({ show: async () => {}, close() {} }), releaseAll: async () => {}
  });
  let turnCurrent = true, perActionSignal, delivery, context;
  try {
    activity.turns.begin('session', 'turn', () => turnCurrent);
    const known = await activity.turns.use('session', 'turn', 'window', async (signal, lease) => {
      perActionSignal = signal;
      delivery = lease;
      const epoch = activity.visibilityEpoch();
      context = { sessionId: 'session', taskId: 'task', target: 'window', action: 'click', indicatorEpoch: epoch,
        signal: AbortSignal.any([signal, delivery.signal]), isCurrent: () => turnCurrent && delivery.isCurrent(),
        isIndicatorCurrent: value => activity.visibilityEpoch() === value };
      return durable.coordinator.run(context, async () => ({ fixture: 'acted' }));
    });
    assert.equal(known.outcome, 'known');
    assert.equal(activity.isVisible(), true);
    // The host invalidates its turn identity before calling DesktopTurns.end.
    turnCurrent = false;
    activity.turns.end('session', 'turn');
    assert.equal(perActionSignal.aborted, false, 'the old seat signal is not a host-turn lease');
    assert.equal(delivery.signal.aborted, true);
    assert.equal(delivery.isCurrent(), false);
    await assert.rejects(durable.coordinator.acknowledgeKnown(context, known.invocationId, 'ended-receipt', known.deliveryToken), /acknowledgement rejected/);
    const later = { ...context, signal: undefined, isCurrent: () => true, isIndicatorCurrent: () => true };
    await assert.rejects(durable.coordinator.run(later, async () => { throw new Error('must not dispatch'); }), /not dispatched/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activity.isVisible(), false);
  } finally { await activity.dispose(); durable.close(); }
}

async function runSemanticPiComposition(mode) {
  const stopBeforeReceipt = mode === 'stop';
  const dir = path.join(tmp, `semantic-pi-${++sequence}`); fs.mkdirSync(dir);
  const durable = createVisibleActionRuntime(path.join(dir, 'outbox.sqlite'), path.join(dir, 'locks'));
  const receipts = new DesktopActionIdempotency(path.join(dir, 'receipts'));
  const dispatcher = new VisibleActionDispatcher(receipts, durable.coordinator);
  const activity = new DesktopActivityRuntime({
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' },
    createIndicator: () => ({ show: async () => {}, close() {} }), releaseAll: async () => {}
  });
  const owner = 'semantic-session', taskId = 'semantic-task';
  let turnCurrent = true, targetCurrent = true, calls = 0, closes = 0, delivery, stage, tracker, stop, semanticSignal;
  let expectedText, ackCount = 0, requests = 0, nextMessages;
  const reports = [];
  const actor = { sessionId: owner, taskId, turnId: 'turn', isCurrent: () => turnCurrent };
  const persisted = createCuaVisibleAction(dispatcher, () => ({ lease: delivery,
    indicatorEpoch: activity.visibilityEpoch(), isIndicatorCurrent: value => activity.visibilityEpoch() === value,
    isTargetCurrent: () => targetCurrent,
    stageDelivery(invocationId, value, acknowledge) { stage = { invocationId, value, acknowledge }; } }));
  const semantic = new CuaSemanticRuntime({ resolveTarget: () => ({ pid: 12, windowId: 34, generation: 'window-generation',
    isCurrent: () => targetCurrent }),
    createConnection: () => ({ async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
      async call(name) {
        if (name === 'get_window_state') return { structuredContent: { pid: 12, window_id: 34, snapshot_id: 's00000001',
          elements_complete: true, elements: [{ element_token: 's00000001:0', role: 'Button', label: 'Open', actions: ['invoke'] }] } };
        calls++; return { structuredContent: { effect: 'confirmed' } };
      }, async close() { closes++; } }),
    runPersistedAction: (request, dispatch, signal) => { semanticSignal = signal; return persisted(request, dispatch, signal); } });
  try {
    activity.turns.noteUserInstruction(owner, 'message');
    activity.turns.begin(owner, 'turn', () => turnCurrent, true, 'message');
    const page = await activity.turns.use(owner, 'turn', 'window', signal => semantic.observe(actor, 'window', signal), false);
    const tool = { name: 'host_desktop_act', label: 'desktop', description: 'offline semantic action', parameters: Type.Object({}),
      async execute(id, _args, signal) {
        const result = await activity.turns.use(owner, 'turn', 'window', (seatSignal, lease) => {
          delivery = lease;
          return semantic.act(actor, { snapshotId: page.snapshotId, ref: page.elements[0].ref,
            requestId: 'request', action: 'click' }, AbortSignal.any([signal, seatSignal]));
        });
        assert.equal(result.outcome, 'dispatched');
        assert.equal(closes, 1, 'the private semantic driver is retired before the tool result is prepared');
        assert.equal(semanticSignal.aborted, true, 'semantic session retirement invalidates its action-only signal');
        assert.equal(delivery.signal.aborted, false, 'the originating desktop run remains active');
        assert.equal(stage.invocationId, result.invocationId);
        const { outcome: _outcome, invocationId: _invocationId, ...effect } = result;
        assert.deepEqual(effect, stage.value);
        expectedText = JSON.stringify({ ok: true, result });
        tracker.expect({ toolCallId: id, toolName: 'host_desktop_act', outputText: expectedText,
          isCurrent: () => turnCurrent && targetCurrent && delivery.isCurrent(),
          acknowledge: async () => { ackCount++; return stage.acknowledge('semantic-pi-receipt'); },
          onUnconfirmed: reason => reports.push(reason) });
        if (stopBeforeReceipt) {
          stop = activity.stop();
          assert.equal(delivery.signal.aborted, true, 'stopping after semantic cleanup invalidates the original run');
        }
        if (mode === 'target-changed') targetCurrent = false;
        return { content: [{ type: 'text', text: expectedText }], details: {} };
      } };
    const streamFn = (_model, llmContext) => {
      const first = ++requests === 1;
      if (!first) nextMessages = llmContext.messages;
      const reply = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'semantic-1', name: tool.name, arguments: {} }] : [],
        api: model.api, provider: model.provider, model: model.id, usage, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: reply });
        stream.push({ type: 'done', reason: reply.stopReason, message: reply }); stream.end(reply); });
      return stream;
    };
    const agent = new Agent({ initialState: { model, tools: [tool] }, streamFn });
    tracker = new PiToolDeliveryTracker(agent);
    await agent.prompt('Run the semantic fixture.');
    assert.equal(calls, 1);
    const delivered = nextMessages.find(message => message.role === 'toolResult' && message.toolCallId === 'semantic-1');
    assert.equal(delivered.content[0].text, expectedText, 'the engine receives the full final semantic response');
    const fresh = { sessionId: owner, taskId, target: 'window', action: 'cua.click', indicatorEpoch: 1,
      isCurrent: () => true, isIndicatorCurrent: () => true };
    if (stopBeforeReceipt || mode === 'target-changed') {
      assert.equal(ackCount, 0); assert.deepEqual(reports, ['invalidated']);
      await assert.rejects(durable.coordinator.run(fresh, async () => { throw new Error('must not dispatch'); }), /not dispatched/);
    } else {
      assert.equal(ackCount, 1); assert.deepEqual(reports, []);
      const next = await durable.coordinator.run(fresh, async () => ({ ok: true }));
      assert.equal(next.outcome, 'known', 'only the verified Pi result frees the task barrier');
    }
  } finally {
    tracker?.close(); if (stop) await stop;
    await semantic.close(); await activity.dispose(); receipts.close(); durable.close();
  }
}

try {
  {
    const f = await runFixture({ duplicate: true });
    try {
      assert.equal(f.effects, 1);
      assert.equal(f.acknowledgements, 1);
      assert.deepEqual(f.reports, []);
      assert.ok(f.events.indexOf('tool_execution_end') < f.events.indexOf('message_end', f.events.indexOf('tool_execution_end')));
      const delivered = f.nextRequest.find(message => message.role === 'toolResult' && message.toolCallId === 'call-1');
      assert.equal(delivered.content[0].text, f.output, 'the following offline request sees the exact result');
      assert.ok(!JSON.stringify(f.nextRequest).includes(f.known.deliveryToken), 'host token must not enter model content');
      const next = await f.runtime.coordinator.run(f.context, async () => ({ ok: true }));
      assert.equal(next.outcome, 'known', 'a verified receipt releases the task barrier');
    } finally { f.tracker.close(); f.runtime.close(); }
  }
  for (const [options, reason] of [
    [{ modifyResult: true }, 'result-mismatch'],
    [{ dropState: true }, 'result-mismatch'],
    [{ invalidate: true }, 'invalidated'],
    [{ abort: true }, 'invalidated'],
    [{ ackUnknown: true }, 'acknowledgement-unknown'],
    [{ ackThrows: true }, 'acknowledgement-failed'],
    [{ dropCall: true }, 'result-not-observed'],
    [{ close: true }, 'tracker-closed']
  ]) {
    const f = await runFixture(options);
    try {
      assert.deepEqual(f.reports, [reason]);
      assert.equal(f.acknowledgements, options.ackUnknown || options.ackThrows ? 1 : 0);
      // Reactivating the test context checks the durable barrier independently of the stop.
      f.restoreCurrent();
      await blocked(f);
    } finally { f.tracker.close(); f.runtime.close(); }
  }
  await runRealSession(false);
  await runRealSession(true);
  await runStopBoundary();
  await runHostEndBoundary();
  await runSemanticPiComposition('normal');
  await runSemanticPiComposition('stop');
  await runSemanticPiComposition('target-changed');
  console.log('pi-tool-delivery: Pi, semantic action, durable receipt and stop boundaries passed');
} finally {
  removeWorkspaceFixture(tmp, prefix);
}
