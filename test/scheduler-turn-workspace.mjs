/** Actual runTurn holds all roots before recall awaits and cleans up a failed recall. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-turn-'));
const compiled = path.join(temp, 'compiled');
const compile = createSharedCompiler(repo, compiled);
const entry = compile('main/agent/orchestrator/turnExecution.ts');
const boundary = (rel, code) => fs.writeFileSync(path.join(compiled, rel), code);
boundary('main/agent/providers/piProvider.mjs', 'export const abortPiTurn = () => {}; export const disposePiSessionResources = async () => {}; export const runPiProvider = args => globalThis.__schedulerFixtureRun(args);');
boundary('main/agent/providers/modeExtension.mjs', 'export const getModeController = () => globalThis.__schedulerFixtureMode;');
boundary('main/agent/orchestrator/planModes.mjs', 'export const bindModeController = () => {}; export const updatePlanCard = () => {};');
boundary('main/agent/orchestrator/turnGate.mjs', 'export const releaseTurnGate = () => {};');
boundary('main/agent/orchestrator/memoryInjection.mjs', 'export const composeReadPathTurnText = (...args) => globalThis.__schedulerFixtureRecall(...args);');
boundary('main/turnChanges/runtime.mjs', 'export const turnChanges = () => ({ begin: (_owner, messageId) => ({ summary: {id: messageId, state: "collecting", files: [], warnings: []}, ready: Promise.resolve(), finish: async () => ({id: messageId, state: "ready", files: [], warnings: []}) }) });');
// 桶生命周期的附件清理是外部边界；本夹具不启动 Electron 或附件 Worker。
const electronStub = path.join(compiled, 'node_modules', 'electron');
fs.mkdirSync(electronStub, { recursive: true });
fs.writeFileSync(path.join(electronStub, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
fs.writeFileSync(path.join(electronStub, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(temp)} };`);
boundary('main/attachments/service.mjs', 'export const clearAttachments = () => {};');
const { startTurn, retry, recallAborted } = await import(pathToFileURL(entry).href);
const { ensureBucket } = await import(pathToFileURL(compile('main/agent/orchestrator/buckets.ts')).href);
const { workspaceRootUsesFor } = await import(pathToFileURL(compile('main/workspaceRootUses.ts')).href);
const { getActiveSchedulerContext } = await import(pathToFileURL(compile('main/agent/schedulerWorkspaceContext.ts')).href);
const { initialCompactBreakerState } = await import(pathToFileURL(compile('shared/compactBreaker.ts')).href);
try {
  const a = path.join(temp, 'a'); const b = path.join(temp, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  const ws = { id: 'ws', name: 'Project', path: a, controlRoot: a, defaultRootId: 'a', rootsRevision: 1,
    roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
  const cfg = { workspaces: [ws], activeWorkspaceId: 'elsewhere' }; const config = { get: () => cfg };
  const bucket = { display: [], busy: false, resetPiOnNextSend: true, queue: [], mode: 'default',
    compactBreaker: initialCompactBreakerState() };
  const events = []; let invalidations = 0;
  const o = { ctx: { config, usage: { recordSessionActivity(id, info) { events.push({ activityId: id, ...info }); }, recordDispatchTurn() {} }, ui: { setBubble() {} }, notify: { push: event => events.push(event) } },
    autoRetryTimers: new Map(), autoRetryAttempts: new Map(), emit: (name, event) => events.push({ name, ...event }),
    invalidatePiSession() { invalidations++; }, abortPendingAsk() {}, persistBucket() {}, getThinkingLevel: () => null,
    scheduleTranscriptIndex() {}, maybeAutoCompact() {} };
  let rejectRecall; let providerCalls = 0;
  globalThis.__schedulerFixtureRecall = () => new Promise((_, reject) => { rejectRecall = reject; });
  globalThis.__schedulerFixtureRun = () => { providerCalls++; };
  const originalEmit = o.emit; let settled = 0;
  o.emit = () => { throw new Error('assistant append refused'); };
  await assert.rejects(startTurn(o, bucket, 'ws', '', undefined, true, { settled() { settled++; } }), /assistant append refused/);
  assert.deepEqual(bucket.display, []); assert.equal(bucket.streamingAssistant, undefined);
  assert.equal(providerCalls, 0); assert.equal(settled, 1, 'failed initial append releases native receipt waiter');
  o.emit = originalEmit;
  const failedTurn = startTurn(o, bucket, 'ws', 'memory failure');
  assert.equal(bucket.busy, true);
  assert.deepEqual(workspaceRootUsesFor(config).list('ws').map(use => use.rootId).sort(), ['a', 'b'], 'registered synchronously before recall');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bucket.display.at(-1).turnChanges?.state, 'collecting', 'the live dispatch message must own its tracker before recall/provider work');
  assert.ok(events.some(e => e.name === 'agent:message' && e.turnChanges?.state === 'collecting'), 'publish collecting metadata so collision updates can match the dispatch message');
  rejectRecall(new Error('fixture recall failed'));
  await failedTurn;
  assert.equal(bucket.busy, false, 'recall rejection is inside the turn cleanup');
  assert.equal(bucket.display.at(-1).error, 'fixture recall failed'); assert.equal(providerCalls, 0);
  assert.ok(invalidations > 0); assert.equal(bucket.resetPiOnNextSend, true, 'failed new conversation retries as new');
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0); assert.equal(getActiveSchedulerContext(config, 'ws'), undefined);

  let finishRecall; let received;
  globalThis.__schedulerFixtureRecall = () => new Promise(resolve => { finishRecall = resolve; });
  globalThis.__schedulerFixtureRun = args => { received = args.workspaceContext; };
  const turn = startTurn(o, bucket, 'ws', 'original source');
  await new Promise(resolve => setImmediate(resolve));
  ws.path = b; ws.defaultRootId = 'b'; ws.roots.reverse(); ws.rootsRevision++;
  finishRecall('with recall'); await turn;
  assert.equal(received.cwd, a, 'configuration changes during recall do not redirect cwd');
  assert.equal(received.controlRoot, a); assert.equal(received.rootsRevision, 1);
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0); assert.equal(bucket.busy, false);

  bucket.display = [
    { id: 'human', role: 'user', content: 'OLDER HUMAN REQUEST MUST NOT REPLAY', createdAt: 1 },
    { id: 'human-done', role: 'assistant', content: 'done', createdAt: 2 },
    { id: 'activity', role: 'user', host: true, content: '收到 3 条 RSS 更新', createdAt: 3 },
    { id: 'host-failed', role: 'assistant', hostEvent: 'consumed', content: '', error: 'fixture failed', createdAt: 4 }
  ];
  o.ensureBucket = () => bucket;
  o.buckets = new Map([['ws', bucket]]);
  let retryInput;
  globalThis.__schedulerFixtureRecall = async (_ctx, _bucket, _ws, text) => text;
  globalThis.__schedulerFixtureRun = args => { retryInput = args; };
  assert.equal(retry(o, 'ws').accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retryInput.turnKind, 'host');
  assert.equal(retryInput.originalUserText, undefined);
  assert.match(retryInput.text, /继续处理刚才未完成的宿主事件/);
  assert.ok(!retryInput.text.includes('OLDER HUMAN REQUEST'));
  assert.equal(bucket.display.at(-1).hostEvent, 'consumed', 'retry keeps autonomous provenance');
  bucket.display.at(-1).error = 'not submitted'; bucket.display.at(-1).hostEvent = 'pending';
  assert.equal(retry(o, 'ws').accepted, false, 'pending durable event must not replay an older human turn');

  const priorSteps = [{ text: 'old plan', done: false }];
  globalThis.__schedulerFixtureMode = { planSteps: priorSteps };
  bucket.display = [
    { id: 'plan', role: 'assistant', content: '', plan: { status: 'pending', active: false, steps: [{ text: 'retained plan', done: false }] } },
    { id: 'recall-user', role: 'user', content: 'edit this' },
    { id: 'recall-aborted', role: 'assistant', content: '', aborted: true }
  ];
  const beforeRecall = JSON.stringify(bucket.display);
  bucket.schedulerSession = { recordEdit() { throw new Error('recall append refused'); } };
  assert.throws(() => recallAborted(o, 'ws', 'recall-user'), /recall append refused/);
  assert.equal(globalThis.__schedulerFixtureMode.planSteps, priorSteps, 'failed durable recall must not mutate the execution controller');
  assert.equal(JSON.stringify(bucket.display), beforeRecall);
  bucket.schedulerSession.recordEdit = () => {};
  assert.equal(recallAborted(o, 'ws', 'recall-user').text, 'edit this');
  assert.deepEqual(globalThis.__schedulerFixtureMode.planSteps, [{ text: 'retained plan', done: false }]);
  assert.deepEqual(bucket.display.map(message => message.id), ['plan']);
  delete bucket.schedulerSession;

  const completed = { id: 'done', role: 'assistant', content: '', createdAt: 1, turnChanges: { id: 'complete', state: 'ready', files: [], warnings: [] } };
  const interrupted = { id: 'stopped', role: 'assistant', content: '', createdAt: 2, turnChanges: { id: 'pending', state: 'collecting', files: [], warnings: [] } };
  const { SchedulerSessionAdapter } = await import(pathToFileURL(compile('main/runtimeKernel/schedulerSession.ts')).href);
  const seeded = new SchedulerSessionAdapter(temp, 'restored', { display: [completed, interrupted], api: [] });
  await seeded.flush('fixture');
  const restored = { ...o, buckets: new Map(), modes: {}, models: {}, thinkings: {}, ctx: { ...o.ctx, store: { loadChat: () => { throw new Error('legacy read forbidden'); } } } };
  const restoredBucket = ensureBucket(restored, 'restored');
  assert.deepEqual(restoredBucket.display[0], completed, 'settled snapshots retain their state');
  assert.equal(restoredBucket.display[1].turnChanges.state, 'error', 'restart must settle a dispatch capture that cannot finish');
  assert.ok(restoredBucket.display[1].turnChanges.warnings.includes('上次改动采集中断，没有可用的回退快照'));
  assert.equal(interrupted.turnChanges.state, 'collecting', 'restore does not mutate the saved input');
  await restoredBucket.schedulerSession.flush('fixture');
  const reloaded = new SchedulerSessionAdapter(temp, 'restored', { display: [], api: [] });
  assert.equal(reloaded.snapshot().display[1].turnChanges.state, 'error', 'restart sanitation is itself durable');
  assert.ok(events.some(e => e.activityId === 'scheduler:ws' && e.workspaceId === 'ws'), '调度回合记录实际工作区的活跃会话');
  console.log('scheduler-turn-workspace: recall waits, cleanup, immutable roots, live capture identity and interrupted restore passed');
} finally {
  delete globalThis.__schedulerFixtureRecall; delete globalThis.__schedulerFixtureRun; delete globalThis.__schedulerFixtureMode;
  fs.rmSync(temp, { recursive: true, force: true });
}
