/** Cross-layer regression: real SessionsService cold load/select + observers + both monitors.
 * No user data, CLI, network or real timers beyond the service's disposable poll.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-restart-'));
const originalLoad = Module._load, originalExtension = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const load = rel => require(path.join(root, 'src', rel));
let service;
try {
  const { SessionsService } = load('main/sessions.ts');
  const { RuntimeAwarenessStore } = load('main/awareness/store.ts');
  const { PipelineStallScanner } = load('main/pipeline/stallScanner.ts');
  const { OrchestratorEventPump } = load('main/orchestrator/events.ts');
  const { boardStatusOfSession } = load('shared/boardStatus.ts');
  const { observeHost } = load('main/sessions/observe.ts');
  const { nextPtyLifecycle } = load('shared/sessionActivity.ts');
  const { shouldScreenClassifyCheap } = load('shared/screenClassify.ts');
  const now = Date.now(), old = now - 60 * 60_000, stall = 15 * 60_000;
  const workspace = { id: 'ws', path: tmp, roots: [{ id: 'root', path: tmp }] };
  const config = { get: () => ({ workspaces: [workspace], activeWorkspaceId: 'ws', defaultRuntime: 'fixture-tui', pipeline: { stallMs: stall } }) };
  let saved = ['working', 'quiet', 'idle', 'blocked', 'starting', 'exited'].map(lifecycle => ({
    id: lifecycle, name: lifecycle, type: 'terminal', launchKind: 'agent', runtime: 'fixture-tui', workspaceId: 'ws',
    cwd: tmp, externalSessionId: 'fixture-' + lifecycle, createdAt: old, lastUsedAt: old, lifecycle, status: 'running', orchestrated: true,
    runtimeStartedAt: old, runtimePresence: 'running', lastOutputAt: old,
    activity: { kind: 'active', ts: old, pendingTools: ['lost-tool'] }
  }));
  saved.push(...['idle', 'needs_you', 'done'].map(value => ({ ...saved[0], id: `phase-${value}`, phase: { value, source: 'model', ts: old } })));
  const store = { loadSessions: () => structuredClone(saved), saveSessions: rows => { saved = structuredClone(rows); },
    loadEndedSessionRefs: () => [], saveEndedSessionRefs() {} };
  const processes = new Map(); let outputAt = 0, launches = 0;
  const pty = { isRunning: id => processes.get(id) === 'running', getStatus: id => processes.get(id) ?? 'idle',
    getLastOutputAt: () => outputAt, getBufferTail: () => undefined };
  service = new SessionsService(store, pty, config, () => null, { push() {} }, { report() {} }, { get: () => ({ surface: 'pty', terminalResume: 'by-id' }) });
  const ctx = { config, sessions: service, awareness: new RuntimeAwarenessStore(tmp), workspaces: { list: () => [workspace] },
    pty, resolveBubbleWorkspaceId: () => 'ws', agentSessions: { isBusy: () => false } };
  const makePump = (clock = () => now, disk = tmp) => new OrchestratorEventPump({ ctx, now: clock, guardStateDir: disk,
    setTimeout: () => 0, clearTimeout() {}, enabled: () => true });
  service.launchTerminal = async row => { launches++; processes.set(row.id, 'running'); row.status = 'running'; row.runtimeStartedAt = Date.now(); };
  for (let boot = 0; boot < 2; boot++) {
    if (boot) service.reloadFromDisk();
    service.pollLifecycles();
    const restored = service.get('working');
    assert.equal(restored.runtimePresence, 'dormant');
    assert.equal(restored.lifecycle, 'idle');
    assert.equal(restored.activity, undefined);
    assert.equal(restored.runtimeStartedAt, undefined);
    assert.equal(boardStatusOfSession(restored, now), 'idle');
    assert.equal(service.get('phase-needs_you').phase.value, 'needs_you');
    assert.equal(boardStatusOfSession(service.get('phase-done'), now), 'done');
    const detail = await observeHost(ctx, { sessionId: 'working', facts: { kinds: ['pipeline.verdict'] } });
    assert.equal(detail.busy, false);
    assert.equal(detail.runtimePresence, 'dormant');
    assert.equal(detail.state.facts.find(f => f.kind === 'pipeline.verdict')?.data.stalled, false);
    const scanner = new PipelineStallScanner({ ctx });
    assert.equal((await scanner.scanOnce(now + 90 * 60_000)).facts.length, 0);
    const pump = makePump(() => now + 90 * 60_000); pump.tickGuards();
    assert.equal(pump.peek('ws').filter(e => e.kind === 'heartbeat_stale').length, 0);
    assert.equal(launches, 0, 'loading/observing/scanning must not spawn a TUI');
    pump.stop();
  }
  assert.equal(service.sessions.find(s => s.id === 'working').lifecycle, 'working', 'history remains for interrupt snapshots');
  await service.select('working');
  assert.equal(launches, 1, 'explicit select still resumes lazily');
  const row = service.sessions.find(s => s.id === 'working');
  assert.ok(row.runtimeStartedAt >= now);
  assert.equal(service.get('working').runtimePresence, 'running');
  row.lifecycle = 'quiet';
  assert.equal((await new PipelineStallScanner({ ctx }).scanOnce(now + 1000)).facts.length, 0, 'new runtime gets its own grace');
  row.runtimeStartedAt = old; row.activity = undefined;
  outputAt = now;
  const beforeSort = row.lastUsedAt;
  assert.equal((await new PipelineStallScanner({ ctx }).scanOnce(now)).facts.length, 0, 'fresh output is monitor activity');
  assert.equal(row.lastUsedAt, beforeSort, 'monitor output cannot reorder rail');
  outputAt = old;
  let scanner = new PipelineStallScanner({ ctx });
  assert.equal((await scanner.scanOnce(now)).facts.filter(f => f.data.stalled).length, 1);
  ctx.awareness = new RuntimeAwarenessStore(tmp);
  scanner = new PipelineStallScanner({ ctx });
  assert.equal((await scanner.scanOnce(now + 1)).facts.length, 0, 'persisted same-instance stall survives scanner recreation');
  row.activity = { kind: 'idle', event: 'stop', ts: now }; row.lifecycle = 'idle';
  assert.equal((await scanner.scanOnce(now + 2)).facts[0]?.data.recovered, true);
  assert.equal((await new PipelineStallScanner({ ctx }).scanOnce(now + stall * 3)).facts.length, 0, 'idle is never a new stall');
  row.activity = { kind: 'idle', event: 'stop', ts: old };
  row.phase = { value: 'idle', source: 'model', ts: old };
  const idle = await observeHost(ctx, { sessionId: row.id, facts: { kinds: ['pipeline.verdict'] } });
  assert.equal(idle.state.facts.filter(f => f.source !== 'event').find(f => f.kind === 'pipeline.verdict')?.data.stalled, false);

  // Hook freshness and explicit execution use the same conditions in both monitors.
  row.lifecycle = 'working'; row.phase = undefined;
  for (const activity of [{ kind: 'active', ts: now }, { kind: 'active', ts: old, pendingTools: ['long'] },
    { kind: 'active', ts: old, guiTurn: true }, { kind: 'waiting_input', ts: old }, { kind: 'blocked', ts: old }]) {
    row.activity = activity;
    assert.equal((await new PipelineStallScanner({ ctx }).scanOnce(now)).facts.filter(f => f.data.stalled).length, 0);
    const pump = makePump(); pump.tickGuards();
    assert.equal(pump.peek('ws').filter(e => e.kind === 'heartbeat_stale').length, 0); pump.stop();
  }
  row.activity = { kind: 'active', ts: old };
  ctx.agentSessions.isBusy = () => true;
  assert.equal((await new PipelineStallScanner({ ctx }).scanOnce(now)).facts.filter(f => f.data.stalled).length, 0);
  const guiBusy = await observeHost(ctx, { sessionId: row.id, facts: { kinds: ['pipeline.verdict'] } });
  assert.equal(guiBusy.state.facts.filter(f => f.source !== 'event').find(f => f.kind === 'pipeline.verdict')?.data.stalled, false);
  ctx.agentSessions.isBusy = () => false;
  row.activity = { kind: 'active', ts: now - 31_000 };
  row.lifecycle = nextPtyLifecycle({ lifecycle: 'working', activity: row.activity, lastOutputAt: now - 31_000, now });
  assert.equal(row.lifecycle, 'quiet');
  assert.equal(boardStatusOfSession(service.get(row.id), now), 'quiet');
  assert.equal(shouldScreenClassifyCheap({ now, createdAt: old, lifecycle: row.lifecycle, activity: row.activity }).ok, true);

  // Alerts are observations, never worker heartbeats. Other sessions' files are not ours.
  row.activity = { kind: 'active', ts: old }; row.lifecycle = 'quiet';
  let clock = now;
  const guardDir = path.join(tmp, 'guards-isolated');
  let pump = makePump(() => clock, guardDir); pump.tickGuards();
  const alert = pump.peek('ws').find(e => e.kind === 'heartbeat_stale'); assert.ok(alert);
  const state = JSON.parse(fs.readFileSync(path.join(guardDir, 'orchestrator-guard-state.json'), 'utf8'));
  assert.equal(state.lastActivity[row.id], old, 'alert must not manufacture activity');
  assert.ok(state.fired[`heartbeat_stale:ws:${row.id}`]);
  clock += stall * 3; pump.onFsChanged('ws', ['some-other-worker.txt']); pump.tickGuards();
  assert.equal(pump.peek('ws').find(e => e.kind === 'heartbeat_stale').ts, alert.ts);
  pump.stop(); pump = makePump(() => clock, guardDir); pump.tickGuards();
  assert.equal(pump.peek('ws').filter(e => e.kind === 'heartbeat_stale').length, 0);
  outputAt = clock; pump.tickGuards();
  clock += stall + 1; pump.tickGuards();
  assert.equal(pump.peek('ws').filter(e => e.kind === 'heartbeat_stale').length, 1, 'real fresh output permits a later distinct stall');
  pump.stop();

  // The candidate list may become stale while the previous notification is delivered.
  const changing = [{ ...row, id: 'first', phase: undefined, runtimePresence: 'running', lastOutputAt: old },
    { ...row, id: 'second', phase: undefined, runtimePresence: 'running', lastOutputAt: old }];
  const changingStore = new RuntimeAwarenessStore(path.join(tmp, 'changed-during-scan'));
  const record = changingStore.recordFact.bind(changingStore);
  changingStore.recordFact = fact => {
    const result = record(fact);
    if (fact.sessionId === 'first') changing[1].lifecycle = 'idle';
    return result;
  };
  const changedCtx = { ...ctx, awareness: changingStore, sessions: { list: () => structuredClone(changing) } };
  const changed = await new PipelineStallScanner({ ctx: changedCtx }).scanOnce(clock);
  assert.deepEqual(changed.errors, []);
  assert.deepEqual(changed.facts.map(f => f.sessionId), ['first'], 're-read each candidate before reporting; no async Git window');
  // Stopping a monitor must wait for the real fetch body, even if its adapter
  // observes abort before finishing, and must not apply a late phase result.
  const monitorConfig = config.get, originalFetch = globalThis.fetch, oldBuffer = pty.getBufferTail;
  let finishMonitor, enteredMonitor, monitorSignal, phaseWrites = 0;
  const monitorEntered = new Promise(resolve => { enteredMonitor = resolve; });
  const oldSetPhase = service.setPhase;
  try {
    config.get = () => ({...monitorConfig(), llm: {activeProviderId: 'fixture', activeModelId: 'fixture', providers: [{id: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', models: [{id: 'fixture'}]}]}});
    pty.getBufferTail = () => 'terminal screen';
    service.setPhase = () => { phaseWrites++; };
    globalThis.fetch = (_url, opts) => { monitorSignal = opts.signal; enteredMonitor(); return new Promise(resolve => {finishMonitor = () => resolve({ok:true,json:async()=>({choices:[{message:{content:'done'}}]})});}); };
    const hash = load('shared/screenClassify.ts').hashScreenText('terminal screen');
    const monitor = service.runScreenClassify('working', 'terminal screen', hash);
    await monitorEntered;
    let stopped = false;
    const shutdown = service.shutdownMonitoring().then(() => {stopped = true;});
    await Promise.resolve(); assert.equal(monitorSignal.aborted, true); assert.equal(stopped, false);
    finishMonitor(); await monitor; await shutdown;
    assert.equal(phaseWrites, 0, 'late classification cannot mutate the stopped service');
    await service.runScreenClassify('working', 'terminal screen', hash);
    assert.equal(service.monitorTasks.size, 0);
  } finally { config.get = monitorConfig; globalThis.fetch = originalFetch; pty.getBufferTail = oldBuffer; service.setPhase = oldSetPhase; finishMonitor?.(); }
  console.log('session-monitoring-restart: cold load/reload, lazy select, shared query/scans, activity, execution, persistent dedup OK');
} finally {
  service?.stop(); service?.cancelPersist();
  Module._load = originalLoad;
  if (originalExtension) require.extensions['.ts'] = originalExtension; else delete require.extensions['.ts'];
  const resolved = fs.realpathSync(tmp);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('session-monitor-restart-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
