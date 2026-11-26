/** Scheduler Pi tool path with real Pi, projection, executor, serialization and durable Cua gate.
 * The model stream, desktop host handler, target and Cua process are offline fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const root = process.cwd();
const prefix = 'scheduler-pi-delivery-';
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const globalCrash = !!process.env.SCHEDULER_PI_GLOBAL_CRASH_DIR;
const crashDir = process.env.SCHEDULER_PI_GLOBAL_CRASH_DIR ?? process.env.SCHEDULER_PI_CRASH_DIR;
const tmp = crashDir ? path.join(crashDir, 'child') : fs.mkdtempSync(path.join(root, '.tmp', prefix));
fs.mkdirSync(tmp, { recursive: true });
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const compiled = path.join(tmp, 'compiled');

// Replace only system/business host boundaries; executeTool, projection and serializeResult remain real.
const executorOut = compile('main/capabilities/executor.ts');
const executorSource = fs.readFileSync(path.join(root, 'src/main/capabilities/executor.ts'), 'utf8');
for (const [, exports, filename] of executorSource.matchAll(/import \{ ([^}]+) \} from '\.\/hosts\/([^']+)';/g)) {
  const source = filename === 'desktop'
    ? "export const desktopHost = { 'desktop.act': (...args) => globalThis.__schedulerPiDesktopHandler(...args) };"
    : filename === 'browser'
    ? "export const browserHost = { 'browser.screenshot': () => globalThis.__browserShot };"
    : filename === 'sessions'
    ? "export const sessionsHost = { 'sessions.setStatus': () => globalThis.__workerStatus };"
    : exports.split(',').map(name => `export const ${name.trim()} = {};`).join('\n');
  fs.writeFileSync(path.join(compiled, `main/capabilities/hosts/${filename}.mjs`), source);
}
// `createSharedCompiler` 已生成导出完整具名面（含 ipcMain）的 CJS electron 桩。
// 不要在这里再覆盖成只导出 app 的 ESM 桩：cuaSemanticRuntime → managedStdioTransport
// → process/owner → processMonitor → ipc/handle 的 `import { ipcMain } from 'electron'`
// 会在 ESM 链接期直接失败。
const validation = path.join(compiled, 'main/capabilities/validateArguments.mjs');
if (fs.existsSync(validation)) fs.writeFileSync(validation, fs.readFileSync(validation, 'utf8').replace(
  '@earendil-works/pi-ai/utils/validation', pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/utils/validation.js')).href));

const { executeTool, serializeModelToolResult, serializeResult } = await import(pathToFileURL(executorOut));
const { executeProjectedScheduler } = await import(pathToFileURL(compile('main/capabilities/projectedScheduler.ts')));
const { schedulerProjectedCatalog } = await import(pathToFileURL(compile('main/capabilities/catalog/projectedCatalog.ts')));
const { resolveToolCallArgs } = await import(pathToFileURL(compile('main/capabilities/catalog.ts')));
const { SchedulerPiDelivery, captureSchedulerPiCuaDeliverySlot, captureSchedulerPiWin32DeliverySlot, executeSchedulerPiTool } = await import(pathToFileURL(compile('main/agent/schedulerPiDelivery.ts')));
const { runWithSchedulerDesktopTurnSource } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
const { createVisibleActionRuntime } = await import(pathToFileURL(compile('main/desktop/visibleActionFactory.ts')));
const { WriteOutbox } = await import(pathToFileURL(compile('main/desktop/writeOutbox.ts')));
const { DesktopTaskLock } = await import(pathToFileURL(compile('main/desktop/taskLock.ts')));
const { VisibleActionBarrier } = await import(pathToFileURL(compile('main/desktop/visibleActionBarrier.ts')));
const { VisibleActionCoordinator } = await import(pathToFileURL(compile('main/desktop/visibleActionCoordinator.ts')));
const { DesktopActivityRuntime } = await import(pathToFileURL(compile('main/desktop/desktopActivityRuntime.ts')));
const { CuaSemanticRuntime } = await import(pathToFileURL(compile('main/desktop/cuaSemanticRuntime.ts')));
const { createCuaVisibleAction } = await import(pathToFileURL(compile('main/desktop/cuaVisibleAction.ts')));
const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
const { VisibleActionDispatcher } = await import(pathToFileURL(compile('main/desktop/visibleActionDispatcher.ts')));
const { GlobalDesktopWriteBarrier } = await import(pathToFileURL(compile('main/desktop/globalDesktopWriteBarrier.ts')));
const { GlobalVisibleActionDispatcher, scopedGlobalVisibleRequestId } = await import(pathToFileURL(compile('main/desktop/globalVisibleActionDispatcher.ts')));
const { createGlobalDeliveryEvidenceVault } = await import(pathToFileURL(compile('main/desktop/globalDeliveryEvidenceVault.ts')));
const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1:9',
  reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const owner = 'orchestrator:fixture', taskId = 'task', turnId = 'turn';
let sequence = 0;

async function exercise(mode, directory) {
  const globalMode = mode.startsWith('global-');
  if (globalMode) mode = mode.slice('global-'.length);
  const dir = directory ?? path.join(tmp, `case-${++sequence}`);
  fs.mkdirSync(dir, { recursive: true });
  const databasePath = path.join(dir, 'outbox.sqlite'), locksPath = path.join(dir, 'locks');
  let holdAckAcquire = false, reachedAcquire, resumeAcquire;
  const acquired = new Promise(resolve => { reachedAcquire = resolve; });
  const proceed = new Promise(resolve => { resumeAcquire = resolve; });
  let durable, globalBarrier, vault;
  if (globalMode) {
    const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
      legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
      verifyLegacyDelivery: () => true, verifyLegacyResolution: () => true };
    vault = createGlobalDeliveryEvidenceVault(() => globalBarrier.inspect());
    globalBarrier = await GlobalDesktopWriteBarrier.activate({ root: path.join(dir, 'global'), legacyRoots: [], legacyOutboxes: [], fence,
      authority: { legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
        verifyDelivery: vault.verifier.verifyDelivery, executorStopped: () => true, verifyRecovery: () => true, verifyAbandonedLock: () => true } });
  } else if (mode === 'close-while-acquiring') {
    const outbox = new WriteOutbox(databasePath), barrier = new VisibleActionBarrier(databasePath);
    const realLock = new DesktopTaskLock(locksPath);
    const lock = { async acquire(task) {
      const release = await realLock.acquire(task);
      if (holdAckAcquire) { reachedAcquire(); await proceed; }
      return release;
    } };
    durable = { coordinator: new VisibleActionCoordinator(outbox, lock, barrier), close() { barrier.close(); outbox.close(); } };
  } else durable = createVisibleActionRuntime(databasePath, locksPath);
  const receipts = new DesktopActionIdempotency(path.join(dir, 'receipts'));
  const dispatcher = globalMode ? new GlobalVisibleActionDispatcher(globalBarrier, {
    resolveLogicalOperationId: value => scopedGlobalVisibleRequestId(value.sessionId, value.taskId, value.requestId),
    classifyResult: (_request, value) => ({ outcome: 'known', value }), deliveryEvidence: vault.verifier.deliveryEvidence
  }) : new VisibleActionDispatcher(receipts, durable.coordinator);
  const activity = new DesktopActivityRuntime({
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' },
    createIndicator: () => ({ show: async () => {}, close() {} }), releaseAll: async () => {}
  });
  let turnCurrent = true, targetCurrent = true, indicatorCurrent = true, calls = 0, ackCount = 0, lease, stop, session;
  let resolveFirst;
  const firstDone = new Promise(resolve => { resolveFirst = resolve; });
  const reports = [], diagnostics = [], delivery = new SchedulerPiDelivery(reason => reports.push(reason),
    globalMode ? { stager: vault.stager, issuer: vault.issuer, inspectMarker: () => globalBarrier.inspect() } : undefined);
  let prematureAck;
  const actor = { sessionId: mode === 'wrong-actor' ? 'wrong-session' : owner, taskId, turnId, isCurrent: () => turnCurrent };
  const persisted = createCuaVisibleAction(dispatcher, request => {
    const hostLease = mode === 'wrong-lease' ? { ...lease, owner: 'wrong-session' } : lease;
    const slot = captureSchedulerPiCuaDeliverySlot(request, { lease: hostLease, indicatorEpoch: activity.visibilityEpoch(),
      isIndicatorCurrent: epoch => indicatorCurrent && activity.visibilityEpoch() === epoch, isTargetCurrent: () => targetCurrent });
    diagnostics.push({ slotCurrent: slot.lease.isCurrent(), slotAborted: slot.lease.signal.aborted,
      requestCurrent: request.isCurrent(), leaseCurrent: lease.isCurrent(), report: [...reports] });
    return { ...slot, stageDelivery(id, value, ack) {
      prematureAck = ack;
      return slot.stageDelivery(id, value, async receiptId => {
        ackCount++;
        assert.equal(receiptId, id, 'only the existing invocation identity crosses the compatibility parameter');
        if (mode === 'close-during-ack') delivery.close();
        if (mode === 'abort-during-ack') session.agent.abort();
        if (mode === 'provider-turn-during-ack') delivery.endTurn();
        if (mode === 'target-during-ack') targetCurrent = false;
        if (mode === 'indicator-during-ack') indicatorCurrent = false;
        if (mode === 'stop-during-ack') stop = activity.stop();
        if (mode === 'duplicate-during-ack') {
          await assert.rejects(delivery.run('call-1', 'host_desktop_run', session.agent.signal,
            async () => { throw new Error('duplicate must not execute'); }), /Duplicate Pi tool call ID/);
        }
        if (mode === 'close-while-acquiring') {
          holdAckAcquire = true;
          const pending = ack(receiptId);
          void pending.catch(() => {});
          let timer;
          try {
            await Promise.race([acquired, pending.then(() => { throw new Error('ack finished before the lock was held'); }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ack did not reach lock acquisition')), 5000); })]);
            delivery.close();
          } finally { clearTimeout(timer); resumeAcquire(); }
          return pending;
        }
        return ack(receiptId);
      });
    } };
  });
  const semantic = new CuaSemanticRuntime({ resolveTarget: () => ({ pid: 12, windowId: 34, generation: 'generation',
    isCurrent: () => targetCurrent }),
    createConnection: () => ({ async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
      async call(name) {
        if (name === 'get_window_state') return { structuredContent: { pid: 12, window_id: 34, snapshot_id: 's00000001',
          elements_complete: true, elements: [{ element_token: 's00000001:0', role: 'Button', label: 'Open', actions: ['invoke'] }] } };
        calls++; return { structuredContent: { effect: 'confirmed' } };
      }, async close() {} }), runPersistedAction: persisted });

  activity.turns.noteUserInstruction(owner, 'message');
  activity.turns.begin(owner, turnId, () => turnCurrent, true, 'message');
  globalThis.__schedulerPiDesktopHandler = async (_ctx, args, options) => {
    if (args.requestId === 'second') await firstDone;
    if (mode.startsWith('win32')) {
      return activity.turns.use(owner, turnId, 'window', async (seatSignal, currentLease) => {
        const slot = captureSchedulerPiWin32DeliverySlot(actor, { lease: currentLease, indicatorEpoch: activity.visibilityEpoch(),
          isIndicatorCurrent: epoch => indicatorCurrent && activity.visibilityEpoch() === epoch, isTargetCurrent: () => targetCurrent,
          onUnknown: () => {} });
        const effect = { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' };
        const result = await dispatcher.run({ sessionId: owner, taskId, target: 'window', action: 'win32.click',
          indicatorEpoch: slot.indicatorEpoch, isCurrent: slot.lease.isCurrent, isIndicatorCurrent: slot.isIndicatorCurrent,
          signal: slot.lease.signal }, args.requestId, 'a'.repeat(64), async () => { seatSignal.throwIfAborted(); calls++; return effect; });
        if (result.reply.outcome !== 'dispatched') return result.reply;
        await slot.stageDelivery(result.reply.invocationId, effect, async receiptId => { ackCount++; return result.acknowledge(receiptId); });
        return { outcome: 'dispatched', invocationId: result.reply.invocationId,
          value: mode === 'win32-projection-change' ? { ...effect, effect: 'confirmed' } : effect };
      });
    }
    const page = await activity.turns.use(owner, turnId, 'window', signal => semantic.observe(actor, 'window', signal), false);
    const result = await activity.turns.use(owner, turnId, 'window', (seatSignal, currentLease) => {
      lease = currentLease;
      return semantic.act(actor, { snapshotId: page.snapshotId, ref: page.elements[0].ref,
        requestId: args.requestId, action: 'click' }, AbortSignal.any([options.signal, seatSignal]));
    });
    if (args.requestId === 'first') resolveFirst();
    if (mode === 'projection-change') return { ...result, effect: 'unknown' };
    if (mode === 'serialization-loss') return { ...result, extra: 'x'.repeat(13000) };
    return result;
  };

  const entries = schedulerProjectedCatalog();
  // R5 域壳化：desktop.act 不再单独注册，桌面写操作统一走 host.desktop.run({action:'act',params}).
  const tool = { name: 'host_desktop_run', label: 'desktop', description: 'offline scheduler fixture',
    parameters: Type.Object({ action: Type.String(), params: Type.Object({
      surfaceId: Type.String(), requestId: Type.String(), action: Type.String(),
      target: Type.Object({ windowId: Type.String() })
    }) }), async execute(id, args, signal) {
      if (mode === 'duplicate' && args.requestId === 'second') await firstDone;
      return executeSchedulerPiTool({ delivery, id, name: tool.name, signal, params: args,
        resolve: resolveToolCallArgs, serialize: (result, args) => serializeModelToolResult(result, 'host.desktop.run', args), execute: async resolved => {
        const value = await executeProjectedScheduler(entries, 'host.desktop.run', resolved, {
          isCurrent: () => !signal.aborted, resolveSession: () => undefined,
          execute: (target, raw) => executeTool({}, target, JSON.stringify(raw), { signal })
        });
        if (mode === 'stop' && args.requestId === 'first') stop = activity.stop();
        if (mode === 'turn-end' && args.requestId === 'first') activity.turns.end(owner, turnId);
        if (mode === 'provider-turn-end' && args.requestId === 'first') delivery.endTurn();
        return value;
      } });
    } };
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(dir, 'models'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('fixture', { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-test-key',
    models: [{ id: model.id, name: model.name, reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512, cost: model.cost }] });
  const selected = modelRuntime.getModel('fixture', 'fixture');
  let requests = 0;
  modelRuntime.streamSimple = () => {
    const first = ++requests === 1;
    const callArgs = requestId => ({ action: 'act', params: {
      surfaceId: 'window', requestId, action: 'click', target: { windowId: 'window' }
    } });
    const callsToEmit = first ? [{ type: 'toolCall', id: mode === 'bad-id' ? '' : 'call-1', name: tool.name, arguments: callArgs('first') }] : [];
    if (first && ['parallel', 'duplicate', 'duplicate-before'].includes(mode)) callsToEmit.push({ type: 'toolCall',
      id: mode.startsWith('duplicate') ? 'call-1' : 'call-2', name: tool.name, arguments: callArgs('second') });
    const reply = { role: 'assistant', content: callsToEmit, api: selected.api, provider: selected.provider, model: selected.id,
      usage, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: reply });
      stream.push({ type: 'done', reason: reply.stopReason, message: reply }); stream.end(reply); });
    return stream;
  };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const rewrite = api => api.on('message_end', event => event.message.role === 'toolResult'
    ? { message: { ...event.message, content: [{ type: 'text', text: 'rewritten by extension' }] } } : undefined);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Offline scheduler fixture.', extensionFactories: mode === 'rewrite' ? [rewrite] : [] });
  try {
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
      modelRuntime, model: selected, tools: [tool.name], customTools: [tool],
      sessionManager: SessionManager.create(dir, path.join(dir, 'sessions')), thinkingLevel: 'off' }));
    session.agent.subscribe(async event => {
      if (event.type === 'tool_execution_end') {
        assert.equal(ackCount, 0, 'tool return is not delivery');
        if (globalMode && prematureAck) {
          const result = await prematureAck('premature');
          assert.equal(result.outcome, 'unknown', 'a tool return cannot issue evidence');
          assert.ok(globalBarrier.inspect(), 'early acknowledgement must keep the global marker');
        }
        if (mode === 'close') delivery.close();
        if (mode === 'crash') process.exit(71);
      }
      if (event.type === 'turn_end' && mode === 'output-loss') {
        session.agent.state.messages = session.agent.state.messages.filter(message => message.role !== 'toolResult');
      }
    });
    delivery.attach(session.agent);
    await runWithSchedulerDesktopTurnSource(() => ({ sessionId: owner, desktopTurnId: turnId,
      isDesktopCurrent: () => turnCurrent }), () => session.prompt('Run the fixture.'));
    // duplicate 与 duplicate-before 都属派发前拒绝：delivery.run 会 poison 首个
    // in-flight 调用（report 'duplicate-tool-call-id'），桌面动作零派发、barrier 保持 known。
    const rejectedBeforeDispatch = ['duplicate', 'duplicate-before', 'bad-id', 'wrong-actor', 'wrong-lease'].includes(mode);
    assert.equal(calls, rejectedBeforeDispatch ? 0 : 1, `unexpected desktop dispatch count (${mode}): ${JSON.stringify({ diagnostics, messages: session.agent.state.messages.filter(message => message.role === 'toolResult') })}`);
    const fresh = { sessionId: owner, taskId, target: 'window', action: 'cua.click', indicatorEpoch: 1,
      isCurrent: () => true, isIndicatorCurrent: () => true };
    // stop() / DesktopTurns.end() / provider endTurn() 现在只推进 generation，不再 abort
    // 已派发动作的 lease：turn-end 与 provider-turn-end 与 normal 一样正常确认（ack 1 次、
    // reports 空、barrier known），其 toolResult 是已派发结果，不再含 unconfirmed 文案。
    const confirmed = ['normal', 'parallel', 'win32', 'stop', 'turn-end', 'provider-turn-end'].includes(mode);
    if (confirmed) {
      assert.equal(ackCount, 1, JSON.stringify({ mode, globalMode, reports, diagnostics,
        messages: session.agent.state.messages.filter(message => message.role === 'toolResult') }));
      assert.deepEqual(reports, []);
      if (globalMode) assert.equal(globalBarrier.inspect(), null);
      else assert.equal((await durable.coordinator.run(fresh, async () => ({ ok: true }))).outcome, 'known');
    } else if (rejectedBeforeDispatch) {
      assert.equal(ackCount, 0);
      if (mode === 'duplicate-before') assert.ok(reports.includes('duplicate-tool-call-id'));
      if (globalMode) assert.equal(globalBarrier.inspect(), null);
      else assert.equal((await durable.coordinator.run(fresh, async () => ({ ok: true }))).outcome, 'known',
        'a rejected pre-dispatch duplicate created no unresolved barrier');
    } else {
      const acked = mode.endsWith('-during-ack') || mode === 'close-while-acquiring';
      assert.equal(ackCount, acked ? 1 : 0,
        `unexpected acknowledgement attempt count (${mode}); diagnostics=${JSON.stringify({ reports, diagnostics })}`);
      assert.ok(reports.length, `expected an unconfirmed report for ${mode}`);
      // 每个未确认 mode 的精确报告内容：本地 -during-ack 是 acknowledgement-failed；
      // global 经 withVerifiedEvent 返回 unknown 结果，故为 acknowledgement-unknown。
      const failure = globalMode ? 'acknowledgement-unknown' : 'acknowledgement-failed';
      const expectedReports = mode === 'duplicate-during-ack' ? ['duplicate-tool-call-id', failure]
        : acked ? [failure]
        : mode === 'close' ? ['tracker-closed']
        : ['rewrite', 'output-loss'].includes(mode) ? ['result-mismatch']
        : ['semantic-result-unconfirmed'];
      assert.deepEqual(reports, expectedReports, `unexpected unconfirmed reports for ${mode}`);
      if (globalMode) assert.ok(globalBarrier.inspect(), `${mode} must retain the global marker`);
      else await assert.rejects(durable.coordinator.run(fresh, async () => { throw new Error('must not dispatch'); }), /not dispatched/);
    }
    const messages = session.agent.state.messages.filter(message => message.role === 'toolResult');
    assert.ok(!JSON.stringify(messages).includes('deliveryToken'));
    // turn-end / provider-turn-end 已归入正常确认；仍返回 failed() 的 unconfirmed
    // 文案的只有投影变更与序列化丢失（含 global-projection-change）。
    if (['projection-change', 'win32-projection-change', 'serialization-loss'].includes(mode)) {
      assert.match(messages[0].content[0].text, /unconfirmed/);
    }
    if (mode === 'parallel') assert.match(messages[1].content[0].text, /not dispatched/);
  } finally {
    delete globalThis.__schedulerPiDesktopHandler;
    delivery.close(); session?.dispose(); if (stop) await stop;
    await semantic.close(); await activity.dispose(); receipts.close(); durable?.close(); vault?.close(); globalBarrier?.close();
  }
}

if (crashDir) {
  await exercise(globalCrash ? 'global-crash' : 'crash', crashDir);
  throw new Error('crash fixture did not exit at the intended boundary');
}

try {
  // Exercise both real catalogue routes. Only the browser side effect is stubbed.
  // Each duplicate alone fits the budget, together they would replace success with an error.
  const file = '/fixture/' + 'p'.repeat(6200);
  for (const [name, action] of [['host.browser.run', 'navigate'], ['host.browser.run', 'close'], ['host.themes.run', 'remove']]) {
    const serialize = result => JSON.parse(serializeModelToolResult({ ok: true, result }, name, { action }));
    assert.deepEqual(serialize({ ok: true }), { ok: true });
    assert.deepEqual(serialize({ ok: true, note: 'warning' }).result, { ok: true, note: 'warning' });
    assert.deepEqual(serialize({ ok: false, reason: 'denied' }).result, { ok: false, reason: 'denied' });
  }
  assert.deepEqual(JSON.parse(serializeModelToolResult({ ok: true, result: { ok: true } },
    'ext.custom', { action: 'close' })).result, { ok: true });
  // A real combined update can mutate the title and then fail to pin. The
  // scheduler must expose both facts as JSON data instead of JSON-in-error.
  const updateArgs = { sessionId: 'worker', name: 'Renamed', pinned: true };
  const updatedSession = { id: 'worker', type: 'terminal', name: 'Renamed', createdAt: 1,
    acceptanceLog: [{ note: 'old history'.repeat(2000) }] };
  const updateRaw = await executeProjectedScheduler(schedulerProjectedCatalog(), 'host.sessions.update', updateArgs, {
    isCurrent: () => true, resolveSession: () => updatedSession, sessionIdentity: () => updatedSession,
    execute: async name => name === 'sessions.rename'
      ? { ok: true, result: updatedSession } : { ok: false, error: 'pin denied' }
  });
  assert.equal(updateRaw.ok, false);
  assert.ok(JSON.stringify(updateRaw).length > 12000, 'the completed source carries a full historical session');
  const updateResult = { ok: false, result: updateRaw, error: updateRaw.failed.error };
  const updateOutput = await executeSchedulerPiTool({
    id: 'test-partial-update', name: 'host_sessions_update', params: updateArgs,
    delivery: { run: (_id, _name, _signal, execute) => execute() }, resolve: resolveToolCallArgs,
    execute: async () => updateResult,
    serialize: (raw, args) => serializeModelToolResult(raw, 'host.sessions.update', args)
  });
  const partial = JSON.parse(updateOutput.content[0].text);
  assert.equal(partial.ok, false, 'partial effects remain a tool failure');
  assert.deepEqual(partial.result.completed, [{ tool: 'sessions.rename',
    result: { ok: true, result: { id: 'worker', name: 'Renamed' } } }]);
  assert.deepEqual(partial.result.failed, updateRaw.failed, 'the failed operation is readable after one parse');
  const longReason = '"'.repeat(4000);
  const singleReason = JSON.parse(serializeModelToolResult({ ok: false, error: longReason, result: {
    ok: false, completed: [], failed: { tool: 'sessions.setPinned', error: longReason }
  } }, 'host.sessions.update', updateArgs));
  assert.equal(singleReason.result.failed.error, longReason, 'one copy fits the budget while two copies would lose the entire receipt');
  assert.ok(updateOutput.content[0].text.length < 12000, 'projection precedes the final JSON budget');
  assert.deepEqual(JSON.parse(serializeResult(updateResult)), { ok: false, cancelled: false, error: updateRaw.failed.error },
    'ordinary programmatic receipts keep their original failure contract');
  const oversizedUpdate = { ok: false, error: 'failed', result: { ok: false, completed: [],
    failed: { tool: 'sessions.setPinned', error: '\"'.repeat(13000) } } };
  const tooLarge = JSON.parse(serializeModelToolResult(oversizedUpdate, 'host.sessions.update', updateArgs));
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.result, undefined, 'partial receipts still obey the final serialized budget');
  assert.match(tooLarge.error, /12000/);
  const errorText = JSON.stringify({ ok: false, completed: [], failed: { tool: 'pretend' } });
  assert.deepEqual(JSON.parse(serializeModelToolResult({ ok: false, error: errorText }, 'host.sessions.update', updateArgs)),
    { ok: false, cancelled: false, error: errorText }, 'untrusted JSON-shaped error strings are never parsed');
  globalThis.__browserShot = { ok: true, path: file, previewPath: file, note: 'keep warning' };
  const evidence = [];
  const ctx = { sessions: { get: () => ({ name: 'Worker', workspaceId: 'w' }) },
    evidence: { recordBrowserShot: (...args) => evidence.push(args) } };
  const shot = { action: 'screenshot', params: { tabId: 'tab' } };
  const expectedShot = { ok: true, path: file, note: 'keep warning' };
  const output = await executeSchedulerPiTool({
    id: 'test-shot', name: 'host_browser_run', params: { arguments_json: JSON.stringify(shot) },
    delivery: { run: (_id, _name, _signal, execute) => execute() }, resolve: resolveToolCallArgs,
    execute: resolved => executeProjectedScheduler(schedulerProjectedCatalog(), 'host.browser.run', resolved, {
      isCurrent: () => true, execute: (name, args) => executeTool(ctx, name, JSON.stringify(args))
    }),
    afterExecute: raw => assert.equal(raw.display.imagePath, file),
    serialize: (raw, args) => serializeModelToolResult(raw, 'host.browser.run', args)
  });
  assert.deepEqual(JSON.parse(output.content[0].text), { ok: true, result: expectedShot });
  const { buildCatalogHostTools } = await import(pathToFileURL(compile('main/agentSession/tools/catalogHostTools.ts')));
  const { buildProjectedGuiTools } = await import(pathToFileURL(compile('main/agentSession/tools/projectedGuiTools.ts')));
  const [gui] = buildProjectedGuiTools(ctx, { sessionId: 'worker', cwd: tmp, getTurnId: () => 'turn',
    hostTools: buildCatalogHostTools(ctx).filter(tool => tool.id === 'browser.run'),
    getPolicyState: () => ({ mode: 'auto', planExecuting: false }) });
  const guiShot = JSON.parse(await gui.execute(shot, { sessionId: 'worker', cwd: tmp }));
  assert.deepEqual(guiShot, { ok: true, result: expectedShot });
  assert.deepEqual(evidence, [['worker', file]]);
  globalThis.__workerStatus = { id: 'worker', name: 'Worker', type: 'terminal', createdAt: 1,
    phase: { value: 'done', source: 'user', ts: 1 }, liveStatus: { label: '结束', kind: 'done', ts: 2 },
    archiveTerminalText: 'old terminal output'.repeat(1000), statusToken: 'private' };
  const [guiStatus] = buildProjectedGuiTools(ctx, { sessionId: 'worker', cwd: tmp, getTurnId: () => 'turn',
    hostTools: buildCatalogHostTools(ctx).filter(tool => tool.id === 'sessions.setStatus'),
    getPolicyState: () => ({ mode: 'auto', planExecuting: false }) });
  assert.deepEqual(JSON.parse(await guiStatus.execute({ phase: 'needs_you' }, { sessionId: 'worker', cwd: tmp })), {
    ok: true, result: { id: 'worker', phase: { value: 'done', source: 'user' }, liveStatus: { label: '结束', kind: 'done' } }
  }, 'GUI status shows the effective phase and remains readable even with >12k archived output');
  delete globalThis.__workerStatus;
  delete globalThis.__browserShot;
  const providerSource = fs.readFileSync(path.join(root, 'src/main/agent/providers/piProvider.ts'), 'utf8');
  assert.match(providerSource, /executeSchedulerPiTool\(\{ delivery: opts\.delivery, id: _id, name: apiName, signal, params/);
  assert.match(providerSource, /serializeModelToolResult\(result, def\.name, \(args/);
  assert.match(providerSource, /return \{ ok: false, result: value, error: \(value as \{ failed\?: \{ error: string \} \}\)\.failed\?\.error \}/,
    'the real scheduler registration passes the known partial receipt as data');
  assert.match(providerSource, /delivery\.attach\(created\.session\.agent\)/);
  assert.match(providerSource, /sessionDeliveries\.get\(session\)\?\.endTurn\(\)/);
  for (const mode of ['normal', 'win32', 'win32-projection-change', 'parallel', 'duplicate', 'duplicate-before', 'bad-id', 'wrong-actor', 'wrong-lease', 'rewrite', 'output-loss', 'projection-change',
    'serialization-loss', 'stop', 'turn-end', 'provider-turn-end', 'close', 'close-during-ack', 'abort-during-ack',
    'duplicate-during-ack', 'provider-turn-during-ack', 'target-during-ack', 'indicator-during-ack', 'stop-during-ack',
    'close-while-acquiring']) {
    await exercise(mode);
  }
  for (const mode of ['normal', 'win32', 'parallel', 'rewrite', 'output-loss', 'projection-change', 'stop',
    'provider-turn-end', 'close', 'abort-during-ack', 'duplicate-during-ack', 'stop-during-ack']) await exercise(`global-${mode}`);
  const processDir = path.join(tmp, 'crash'); fs.mkdirSync(processDir);
  const child = spawnSync(process.execPath, [process.argv[1]], { cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, SCHEDULER_PI_CRASH_DIR: processDir } });
  assert.equal(child.status, 71, `child must exit before turn_end: ${child.stderr}`);
  const reopened = createVisibleActionRuntime(path.join(processDir, 'outbox.sqlite'), path.join(processDir, 'locks'));
  const reopenedOutbox = new WriteOutbox(path.join(processDir, 'outbox.sqlite'));
  try {
    assert.equal(reopenedOutbox.isTaskBlocked(owner, taskId), true, 'process exit leaves unresolved durable state');
    await assert.rejects(reopened.coordinator.run({ sessionId: owner, taskId, target: 'window', action: 'cua.click', indicatorEpoch: 1,
      isCurrent: () => true, isIndicatorCurrent: () => true }, async () => { throw new Error('must not dispatch'); }), /not dispatched/);
  } finally { reopenedOutbox.close(); reopened.close(); }
  const globalProcessDir = path.join(tmp, 'global-crash'); fs.mkdirSync(globalProcessDir);
  const globalChild = spawnSync(process.execPath, [process.argv[1]], { cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, SCHEDULER_PI_GLOBAL_CRASH_DIR: globalProcessDir } });
  assert.equal(globalChild.status, 71, `global child must exit before turn_end: ${globalChild.stderr}`);
  const reopenedGlobal = GlobalDesktopWriteBarrier.open(path.join(globalProcessDir, 'global'), {
    legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true, verifyDelivery: () => false,
    executorStopped: () => true, verifyRecovery: () => false, verifyAbandonedLock: () => false });
  try {
    assert.equal(reopenedGlobal.inspect()?.phase, 'known', 'process exit must retain the known global marker');
    const blocked = new GlobalVisibleActionDispatcher(reopenedGlobal, {
      resolveLogicalOperationId: value => scopedGlobalVisibleRequestId(value.sessionId, value.taskId, value.requestId),
      classifyResult: (_request, value) => ({ outcome: 'known', value }), deliveryEvidence: () => undefined });
    await assert.rejects(blocked.run({ sessionId: 'different-session', taskId: 'different-task', target: 'window',
      action: 'cua.click', indicatorEpoch: 1, isCurrent: () => true, isIndicatorCurrent: () => true }, 'next', 'a'.repeat(64),
    async () => { throw new Error('must not dispatch'); }), /not dispatched/);
  } finally { reopenedGlobal.close(); }
  console.log('scheduler-pi-delivery: real Pi, executor projection, serialization and crash boundaries passed');
} finally { removeWorkspaceFixture(tmp, prefix); }
