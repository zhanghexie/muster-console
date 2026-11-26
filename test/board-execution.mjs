/** Real SessionsService method bodies + controlled PTY/LLM/store; no user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(import.meta.url)('typescript');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-execution-'));
const compile = createSharedCompiler(root, tmp);
const load = (p) => import(pathToFileURL(compile(p)).href);
const board = await load('shared/boardStatus.ts');
const activity = await load('shared/sessionActivity.ts');
const review = await load('shared/boardReview.ts');
const gate = await load('shared/screenClassify.ts');
const { parseStatusBody } = await load('main/protocol/statusBody.ts');
const source = fs.readFileSync(process.env.BOARD_SESSIONS_SOURCE ?? path.join(root, 'src/main/sessions.ts'), 'utf8');
const ast = ts.createSourceFile('sessions.ts', source, ts.ScriptTarget.Latest, true);
const cls = ast.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === 'SessionsService');
let outputCallback;
function findOutputCallback(node) {
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'ptyMgr.onData') outputCallback = node.right.getText(ast);
  ts.forEachChild(node, findOutputCallback);
}
findOutputCallback(ast);
assert.ok(outputCallback, 'exercise the actual production PTY callback');
const names = ['applyActivitySignal', 'applyLifecycle', 'touchUsed', 'setPhase', 'pollOutputLifecycle', 'runScreenClassify', 'runScreenClassifyOwned', 'refreshFresh'];
const members = names.map((name) => cls.members.find((n) => n.name?.getText(ast) === name).getText(ast)).join('\n');
let resolveLlm;
let now = 1_800_000_000_000;
const oldNow = Date.now;
Date.now = () => now;
const env = {
  ...board, ...activity, ...gate, ...review,
  SCREEN_CLASSIFY_MAX_BACKOFF_MS: 600_000, LIFECYCLE_BUFFER_TAIL_CHARS: 12_000,
  t: (s) => s, notifyDelegateSlotFreed() {}, formatNotifyText() {}, errorMessage: String,
  plainTextFromPtyBuffer: (text) => ({ text }), resolveLlmConfig: () => ({ openai: {} }),
  classifyTerminalScreen: () => new Promise((resolve) => { resolveLlm = resolve; })
};
const evaluate = (code) => new Function(...Object.keys(env), ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText)(...Object.values(env));
const Probe = evaluate(`return class Probe { ${members} }`);
function setup(extra = {}) {
  const s = { id: 's', name: 'task', type: 'terminal', launchKind: 'agent', workspaceId: 'w', createdAt: now - 90_000, status: 'running', lifecycle: 'idle', ...extra };
  const svc = new Probe();
  const pty = { outputAt: now, buffer: 'old screen' };
  Object.assign(svc, {
    sessions: [s], broadcasts: [], ptyWorkingSince: new Map(), lifecycleListeners: [],
    classifyBySession: new Map(), classifyInFlight: new Set(), config: { get: () => ({}) },
    monitorTasks: new Set(), monitorController: new AbortController(),
    resolveSessionRef: () => ({ id: s.id }), workspaceIdFor: () => 'w', get: () => s,
    persist() {}, broadcast() { this.broadcasts.push(structuredClone(s)); },
    emitSessionFactKind() {}, notifyPhaseListeners() {}, notifyBus: { report() {} }, notify: { push() {} }, maybeClassifyScreen() {},
    worktreeCtx: () => ({ config: { get: () => ({}) }, git: null, notify: { push() {} }, persist() {}, broadcast() {} }),
    ptyMgr: { getLastOutputAt: () => pty.outputAt, getBufferTail: () => pty.buffer }
  });
  return { svc, s, pty };
}
try {
  const stopped = setup({ lifecycle: 'working' });
  stopped.svc.applyActivitySignal('s', 'idle', 'stop');
  const onData = new Function(`return (${outputCallback});`).call(stopped.svc);
  now += 100; stopped.pty.outputAt = now;
  onData('s', '\u001b[2Jrecap');
  assert.equal(stopped.s.lifecycle, 'idle', 'trailing redraw must not revoke authoritative Stop');
  now += 3_600_000; stopped.svc.pollOutputLifecycle(stopped.s);
  assert.equal(stopped.s.lifecycle, 'idle', 'polling cannot strand a completed turn in quiet');
  stopped.svc.touchUsed('s');
  assert.equal(stopped.s.activity, undefined, 'actual user input revokes old Stop');
  assert.equal(stopped.s.lifecycle, 'working');
  stopped.svc.applyActivitySignal('s', 'waiting_input', 'permission');
  onData('s', 'permission repaint');
  assert.equal(stopped.s.activity.kind, 'waiting_input');
  // Metadata-only activity updates must publish once, even at identical lifecycle.
  for (const kind of ['active', 'blocked', 'idle', 'waiting_input']) {
    const { svc, s } = setup({ lifecycle: kind === 'active' ? 'working' : kind === 'blocked' ? 'blocked' : 'idle' });
    svc.applyActivitySignal(s.id, kind, 'test');
    assert.equal(svc.broadcasts.length, 1, `${kind}: one coherent snapshot`);
    assert.deepEqual(svc.broadcasts[0].activity, s.activity);
  }
  const quiet = setup({ lifecycle: 'working' });
  now += 600_000; quiet.svc.pollOutputLifecycle(quiet.s);
  assert.equal(board.boardStatusOfSession(quiet.s), 'quiet');
  const restarted = setup();
  restarted.svc.isChatRuntime = () => false;
  const starts = [];
  restarted.svc.respawn = async (...args) => starts.push(args);
  await restarted.svc.refreshFresh('s');
  assert.deepEqual(starts, [['s', 'new', true]], 'explicit restart selects a fresh launch and its first prompt');
  for (const oldPhase of ['idle', 'done', 'needs_you']) {
    const { svc, s } = setup({ phase: { value: oldPhase, source: 'model', ts: now - 1 } });
    svc.applyActivitySignal(s.id, 'active', 'gui-turn-start');
    now += 600_000;
    assert.equal(s.phase, undefined);
    assert.equal(board.boardStatusOfSession(s), 'working');
    svc.applyActivitySignal(s.id, 'idle', 'gui-turn-end');
    assert.equal(board.boardStatusOfSession(s), 'idle');
  }
  for (const [start, end] of [['gui-turn-start', 'gui-turn-end'], ['user-prompt-submit', 'stop']]) {
    for (const phase of [undefined, 'needs_you', 'done']) {
      const { svc, s } = setup();
      svc.applyActivitySignal(s.id, 'active', start);
      if (phase) svc.setPhase(s.id, { value: phase, source: 'model' });
      const capsule = { label: phase ?? '查资料', kind: phase ? 'info' : 'active', ts: now };
      s.liveStatus = capsule;
      svc.applyActivitySignal(s.id, 'idle', end);
      assert.equal(s.phase?.value, phase, 'ordinary turn end never writes a delivery phase');
      assert.equal(board.boardStatusOfSession(s), phase === 'needs_you' ? 'waiting' : phase ?? 'idle');
      assert.equal(s.liveStatus, phase ? capsule : undefined, 'only an explicit phase keeps its capsule at rest');
      svc.applyActivitySignal(s.id, 'active', start);
      assert.equal(s.liveStatus, undefined, 'a fresh user turn clears the previous report text');
    }
  }
  for (const newTurn of ['gui-turn-start', 'user-prompt-submit']) {
    const acceptanceLog = [{ at: now, decision: 'processed' }];
    const manual = setup({ phase: { value: 'done', source: 'user', ts: now }, acceptanceLog });
    manual.svc.applyActivitySignal('s', 'active', 'pre-tool-use');
    assert.equal(board.boardStatusOfSession(manual.s), 'done', 'tool activity preserves manual completion');
    manual.svc.applyActivitySignal('s', 'active', newTurn);
    assert.equal(manual.s.phase, undefined, `${newTurn} clears manual completion`);
    assert.equal(board.boardStatusOfSession(manual.s), 'working');
    assert.deepEqual(manual.s.acceptanceLog, [{ at: now, decision: 'processed' }]);
  }
  const hooks = setup();
  for (const id of ['a', 'b', 'a']) hooks.svc.applyActivitySignal('s', 'active', 'shell-start', id);
  now += 600_000; hooks.svc.pollOutputLifecycle(hooks.s);
  assert.equal(board.boardStatusOfSession(hooks.s), 'working');
  assert.equal(gate.shouldScreenClassifyCheap({ now, createdAt: 1, activity: hooks.s.activity }).ok, false);
  hooks.svc.applyActivitySignal('s', 'active', 'shell-end', 'a');
  now += 600_000; hooks.svc.pollOutputLifecycle(hooks.s);
  assert.equal(board.boardStatusOfSession(hooks.s), 'working');
  hooks.svc.applyActivitySignal('s', 'active', 'shell-end', 'b');
  now += 600_000; hooks.svc.pollOutputLifecycle(hooks.s);
  assert.equal(board.boardStatusOfSession(hooks.s), 'quiet');
  hooks.svc.applyActivitySignal('s', 'idle', 'stop');
  hooks.svc.pollOutputLifecycle(hooks.s);
  assert.equal(board.boardStatusOfSession(hooks.s), 'idle');
  const noId = activity.nextSessionActivity(undefined, 'active', 'shell-start', undefined, now);
  assert.equal(activity.hasRunningExecution(noId), true);
  assert.equal(activity.hasRunningExecution(activity.nextSessionActivity(noId, 'active', 'shell-end', undefined, now)), false);
  assert.equal(parseStatusBody({ activity: 'active', event: 'shell-start', toolUseId: 'a' }).toolUseId, 'a');

  for (const result of ['idle', 'needs_you', 'done']) {
    for (const invalidate of [
      ({ svc }) => svc.applyActivitySignal('s', 'active', 'user-prompt-submit'),
      ({ svc }) => svc.touchUsed('s'),
      ({ s }) => { s.phase = { value: 'idle', source: 'model', ts: now }; },
      ({ pty }) => { pty.buffer = 'new screen'; },
      ({ pty }) => { pty.outputAt++; },
      ({ svc }) => { svc.classifyBySession.delete('s'); }, // restart/exit invalidation
      ({ svc, s }) => { svc.sessions = [{ ...s }]; }, // same-id reload
      ({ s }) => { s.lifecycle = 'exited'; },
      ({ svc }) => { svc.sessions = []; }
    ]) {
      const ctx = setup();
      const pending = ctx.svc.runScreenClassify('s', ctx.pty.buffer, gate.hashScreenText(ctx.pty.buffer));
      await Promise.resolve();
      invalidate(ctx);
      const phase = ctx.s.phase;
      resolveLlm(result); await pending;
      assert.equal(ctx.s.phase, phase, `discard obsolete ${result}`);
    }
  }
  const current = setup();
  const pending = current.svc.runScreenClassify('s', current.pty.buffer, gate.hashScreenText(current.pty.buffer));
  await Promise.resolve();
  resolveLlm('idle'); await pending;
  assert.equal(current.s.phase?.source, 'llm', 'current result is still usable');

  for (const extra of [
    { activity: { kind: 'blocked', ts: now } },
    { activity: { kind: 'waiting_input', ts: now } },
    { lifecycle: 'exited', activity: { kind: 'blocked', ts: now } },
    { lifecycle: 'starting', createdAt: now - 100_000 }
  ]) {
    const { s } = setup(extra);
    assert.equal(review.canReviewSession(s), false);
    assert.equal(review.isNeedsYouPeekSession(s), true);
    assert.equal(board.sessionBoardColumn(s), 'needsYou');
  }
  assert.equal(review.reviewFactsOf(setup({ liveStatus: { label: '等待 API key', ts: now } }).s).summary, '');
  // Exercise the actual capability guards, before any destructive method is reached.
  const hostText = fs.readFileSync(path.join(root, 'src/main/capabilities/hosts/sessions.ts'), 'utf8');
  const hostAst = ts.createSourceFile('host.ts', hostText, ts.ScriptTarget.Latest, true);
  const handlers = new Map();
  function visit(n) { if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) handlers.set(n.name.text, n.initializer.getText(hostAst)); ts.forEachChild(n, visit); }
  visit(hostAst);
  env.resolveQueryIds = (sessions, ids) => ({ ok: ids.filter(id => sessions.some(s => s.id === id)), failed: ids.filter(id => !sessions.some(s => s.id === id)) });
  const runReview = evaluate(`return (${handlers.get('sessions.review')});`);
  const runBulk = evaluate(`return (${handlers.get('sessions.completeAndArchive')});`);
  const s = setup({ activity: { kind: 'blocked', ts: now } }).s;
  let mutations = 0;
  const ctx = { sessions: { resolveSessionRef: () => ({ id: s.id }), get: () => s, listForAgent: () => ({ sessions: [s] }), markProcessed: () => { mutations++; } } };
  await assert.rejects(runReview(ctx, { sessionId: 's', decision: 'passed' }), /不是待验收/);
  assert.throws(() => runBulk(ctx, { workspaceId: 'w', sessionIds: ['s'] }), /状态已变化/);
  assert.equal(mutations, 0);
  const first = setup({ id: 'a', phase: { value: 'done', source: 'user', ts: now } }).s;
  const second = setup({ id: 'b', phase: { value: 'done', source: 'user', ts: now } }).s;
  const effects = [];
  const batchCtx = { resolveBubbleWorkspaceId: () => 'w', sessions: {
    listForAgent: () => ({ sessions: [first, second] }),
    clearDimensionGates: id => effects.push(`clear:${id}`),
    markProcessed: (id, options) => effects.push(`processed:${id}:${options.note}`)
  } };
  assert.throws(() => runBulk(batchCtx, { workspaceId: 'w', sessionIds: ['a', 'missing'] }), /会话不存在/);
  assert.deepEqual(effects, [], 'legacy batch archive also rejects all targets when one reference is missing');
  await assert.rejects(runReview(batchCtx, { sessionIds: ['a', 'missing'], decision: 'processed' }), /会话不存在/);
  second.archived = true;
  await assert.rejects(runReview(batchCtx, { sessionIds: ['a', 'b'], decision: 'processed' }), /状态已变化/);
  delete second.archived;
  await assert.rejects(runReview(batchCtx, { sessionIds: ['a'], decision: 'passed' }), /Batch review requires/);
  assert.deepEqual(effects, [], 'no preflight failure may clear gates or process any session');
  assert.deepEqual(await runReview(batchCtx, { sessionIds: ['a', 'b', 'a'], decision: 'processed', note: '  accepted  ' }),
    { ok: true, decision: 'processed', workspaceId: 'w', processed: ['a', 'b'], count: 2 });
  assert.deepEqual(effects, ['clear:a', 'processed:a:accepted', 'clear:b', 'processed:b:accepted']);
  effects.length = 0;
  batchCtx.sessions.markProcessed = id => { if (id === 'b') throw new Error('save failed'); effects.push(`processed:${id}`); };
  const partial = await runReview(batchCtx, { sessionIds: ['a', 'b'], decision: 'processed' });
  assert.deepEqual(partial.processed, ['a']);
  assert.equal(partial.outcome, 'unknown');
  assert.match(partial.error, /inspect this target/);
  console.log('[ok] board-execution: execution facts, 27 stale-result paths, broadcast and capability guards');
} finally { Date.now = oldNow; fs.rmSync(tmp, { recursive: true, force: true }); }
