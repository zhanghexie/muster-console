import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-interrupt-'));
const compile = createSharedCompiler(process.cwd(), tmp);
const load = name => import(pathToFileURL(compile(name)).href);
const store = await load('main/metaAgent/messageStore.ts');
const { sendInterruptMail } = await load('main/messages/interrupt.ts');
const { sessionsHost } = await load('main/capabilities/hosts/sessions.ts');
const { runAsSchedulerTool } = await load('main/agent/agentScope.ts');
const { ACTOR_SESSION_ID_ARG } = await load('main/capabilities/hosts/actors.ts');
const { attachMailboxWakes, flushMailboxWake } = await load('main/messages/wake.ts');
let next = 0;
function world() {
  const dir = path.join(tmp, `world-${++next}`); fs.mkdirSync(dir); store.setAgentMessagesUserDataDir(dir);
  const sessions = new Map(['parent', 'child', 'sibling'].map(id => [id, { id, name: id, workspaceId: 'ws', runtime: 'pi', lifecycle: 'idle', ...(id === 'child' ? { parentSessionId: 'parent' } : {}) }]));
  let busy = true, abortCount = 0, snapshots = 0, fail = false, abortDelay = 0;
  const received = [];
  const ctx = { sessions: { get: id => sessions.get(id), peek: id => sessions.get(id), broadcastMessagesChanged() {}, isChatRuntime: () => true,
    onLifecycle: () => () => {}, getCliWorkspaceContext: () => undefined,
    async captureManagedInterruptSnapshot(id, _now, workContext) { snapshots++; sessions.get(id).interruptSnapshot = { interruptedAt: 1, lastActivityAt: 1,
      reason: 'preemption', worktreeClean: true, uncommitted: [], workContext }; } }, resolveBubbleWorkspaceId: () => 'ws', workspaces: { list: () => [{ id: 'ws', path: dir }] },
    agentSessions: { isOpen: () => true, isBusy: () => busy,
      entries: new Map(['child', 'sibling'].map(id => [id, { busy: true, activeExecutionTurnId: 'old-turn',
        lastTurnInput: { text: 'original work request' }, assistant: { parts: [{ kind: 'text', text: 'partial work' }] } }])),
      async abort() { abortCount++; assert.ok(snapshots > 0, 'snapshot exists before abort'); assert.ok(ledger().messages.length >= 1, 'mail is durable before abort');
        if (fail) throw new Error('cannot stop');
        if (abortDelay) await new Promise(resolve => setTimeout(resolve, abortDelay));
        busy = false; },
      async send(id, text, images, options) { assert.equal(busy, false); assert.match(text, /mail-/); received.push({ id, text, options }); return { ok: true }; } } };
  const ledger = () => store.readAgentMessageLedger(dir, 'ws');
  const off = attachMailboxWakes(ctx);
  return { ctx, ledger, received, off, count: () => abortCount, finish: () => { busy = false; }, fail: () => { fail = true; }, delayAbort: () => { abortDelay = 100; },
    send: (args = {}) => sendInterruptMail(ctx, { from: 'parent', to: 'child', text: '停止旧方案，先读这里', workspaceId: 'ws', idempotencyKey: 'change-plan', ...args }) };
}
try {
  const w = world();
  try {
    const [first, retry] = await Promise.all([w.send(), w.send()]);
    assert.equal(first.messageId, retry.messageId);
    assert.equal(w.ledger().messages.length, 1);
    assert.equal(w.count(), 1, 'concurrent retry does not interrupt twice');
    assert.equal(w.received.length, 1, 'one host wake');
    assert.match(w.received[0].text, /工作续接快照/, 'wake carries the interrupted work snapshot');
    assert.match(w.received[0].text, /original work request[\s\S]*partial work/, 'the original turn context accompanies the interrupt');
    assert.equal(w.ledger().messages[0].interruption, 'stopped');
    assert.equal(w.ledger().messages[0].read, false, 'wake is not a read receipt');
    await w.send(); assert.equal(w.count(), 1); assert.equal(w.received.length, 1);
    await assert.rejects(w.send({ from: 'sibling' }), /直接子/);
    await assert.rejects(w.send({ from: 'child', to: 'parent' }), /直接子/);
    assert.equal(w.ledger().messages.length, 1, 'invalid actor cannot even append interrupt mail');
  } finally { w.off(); }
  const completedDuringSnapshot = world();
  try {
    const capture = completedDuringSnapshot.ctx.sessions.captureManagedInterruptSnapshot;
    completedDuringSnapshot.ctx.sessions.captureManagedInterruptSnapshot = async id => { await capture(id); completedDuringSnapshot.finish(); };
    const result = await completedDuringSnapshot.send();
    assert.equal(result.interruption, 'stopped');
    assert.equal(completedDuringSnapshot.count(), 0, 'do not interrupt a later turn after snapshot preparation');
    assert.equal(completedDuringSnapshot.received.length, 1);
  } finally { completedDuringSnapshot.off(); }
  const scheduler = world();
  try {
    const receipt = await runAsSchedulerTool(() => sessionsHost['sessions.message'](scheduler.ctx,
      { to: 'sibling', text: 'scheduler instruction', interrupt: true }));
    assert.equal(receipt.receipt, 'stored'); assert.equal(receipt.from, 'orchestrator:ws');
    assert.equal(receipt.interruption, 'stopped'); assert.equal(receipt.read, false);
    assert.equal(scheduler.received[0].id, 'sibling');
    assert.equal(scheduler.ledger().messages[0].from, 'orchestrator:ws');
    await assert.rejects(sessionsHost['sessions.message'](scheduler.ctx,
      { to: 'sibling', text: 'denied', interrupt: true, [ACTOR_SESSION_ID_ARG]: 'parent' }), /直接子/);
    assert.equal(scheduler.ledger().messages.length, 1);
  } finally { scheduler.off(); }
  const schedulerFailure = world();
  try {
    schedulerFailure.fail();
    await assert.rejects(runAsSchedulerTool(() => sessionsHost['sessions.message'](schedulerFailure.ctx,
      { to: 'sibling', text: 'failure preserved', interrupt: true })), /已保存.*中断阶段未完成/);
    assert.equal(schedulerFailure.ledger().messages[0].interruption, 'requested');
    assert.equal(schedulerFailure.ledger().messages[0].read, false);
    assert.equal(schedulerFailure.received.length, 0);
  } finally { schedulerFailure.off(); }
  const concurrent = world(); concurrent.delayAbort();
  try {
    const results = await Promise.all([concurrent.send({ idempotencyKey: 'first' }), concurrent.send({ idempotencyKey: 'second', text: '另一封补充信' })]);
    assert.notEqual(results[0].messageId, results[1].messageId);
    assert.equal(concurrent.count(), 1, 'distinct concurrent letters stop the same turn once');
    assert.equal(concurrent.received.length, 1, 'both letters share one reader wake');
    assert.equal(concurrent.ledger().messages.length, 2);
    assert.ok(concurrent.ledger().messages.every(mail => mail.interruption === 'stopped' && mail.notifiedAt && !mail.read));
  } finally { concurrent.off(); }
  const f = world();
  try {
    f.fail(); await assert.rejects(f.send(), /已保存.*未完成/);
    assert.equal(f.ledger().messages[0].interruption, 'requested');
    assert.equal(f.received.length, 0, 'failed stop cannot start a concurrent reader turn');
  } finally { f.off(); }
  const retry = world();
  try {
    let accepted = false, signals = 0;
    retry.ctx.sessions.isChatRuntime = () => false;
    retry.ctx.sessions.get('child').lifecycle = 'working';
    retry.ctx.pty = { isRunning: () => true, write: (_id, data) => {
      assert.equal(data, '\x03');
      if (!accepted) return false;
      signals++; retry.ctx.sessions.get('child').lifecycle = 'idle'; return true;
    } };
    await assert.rejects(retry.send(), /未能发送中断信号/);
    assert.equal(retry.ledger().messages[0].interruption, 'pending', 'definitely rejected write can be retried');
    accepted = true;
    const result = await retry.send();
    assert.equal(result.interruption, 'stopped');
    assert.equal(signals, 1); assert.equal(retry.ledger().messages.length, 1, 'retry preserves the durable letter');
    await retry.send(); assert.equal(signals, 1, 'successful retry remains idempotent');
  } finally { retry.off(); }
  const escape = world();
  try {
    const child = escape.ctx.sessions.get('child'); child.lifecycle = 'working';
    const binding = { interruptInput: '\x1b' };
    const signals = [];
    escape.ctx.config = { get: () => ({}) };
    escape.ctx.sessions.isChatRuntime = () => false;
    escape.ctx.sessions.getCliWorkspaceContext = () => binding;
    escape.ctx.sessions.injectStrategy = async () => 'relaunch-resume';
    escape.ctx.sessions.pasteInput = async () => false;
    escape.ctx.sessions.relaunchWithPrompt = async () => {};
    escape.ctx.pty = { isRunning: () => true, write: (_id, data) => {
      signals.push(data); child.lifecycle = 'idle'; return true;
    } };
    const result = await escape.send();
    assert.deepEqual(signals, ['\x1b'], 'use the current process adapter key, not a hard-coded Ctrl+C');
    assert.equal(result.interruption, 'stopped');
    assert.ok(escape.ledger().messages[0].notifiedAt);
  } finally { escape.off(); }
  const late = world();
  try {
    const child = late.ctx.sessions.get('child');
    child.lifecycle = 'working';
    late.ctx.sessions.isChatRuntime = () => false;
    late.ctx.config = { get: () => ({}) };
    late.ctx.sessions.getCliWorkspaceContext = () => undefined;
    late.ctx.sessions.injectStrategy = async () => 'relaunch-resume';
    late.ctx.sessions.pasteInput = async () => false;
    let notices = 0;
    late.ctx.sessions.relaunchWithPrompt = async () => { notices++; };
    late.ctx.pty = { isRunning: () => true, write: () => { throw Error('must never repeat the stop'); } };
    await store.appendAgentMessageToStore(late.ctx.workspaces.list()[0].path, 'ws', {
      id: 'mail-11111111-2222-3333-4444-555555555555', from: 'parent', to: 'child', text: 'delayed stop',
      kind: 'notice', receipt: 'stored', ts: Date.now(), meta: { interrupt: true }, interruption: 'requested' });
    await flushMailboxWake(late.ctx, 'child', 'ws'); assert.equal(notices, 0);
    child.lifecycle = 'idle';
    await flushMailboxWake(late.ctx, 'child', 'ws');
    assert.equal(notices, 1); assert.equal(late.ledger().messages[0].interruption, 'stopped');
  } finally { late.off(); }
  const schedulerLate = world();
  try {
    const target = schedulerLate.ctx.sessions.get('sibling'); target.lifecycle = 'working';
    schedulerLate.ctx.sessions.isChatRuntime = () => false;
    schedulerLate.ctx.config = { get: () => ({}) };
    schedulerLate.ctx.sessions.getCliWorkspaceContext = () => undefined;
    schedulerLate.ctx.sessions.injectStrategy = async () => 'relaunch-resume';
    schedulerLate.ctx.sessions.pasteInput = async () => false;
    let notices = 0;
    schedulerLate.ctx.sessions.relaunchWithPrompt = async () => { notices++; };
    schedulerLate.ctx.pty = { isRunning: () => true, write: () => { throw Error('must never repeat stop'); } };
    await store.appendAgentMessageToStore(schedulerLate.ctx.workspaces.list()[0].path, 'ws', {
      id: 'mail-21111111-2222-3333-4444-555555555555', from: 'orchestrator:ws', to: 'sibling', text: 'delayed stop',
      kind: 'notice', receipt: 'stored', ts: Date.now(), meta: { interrupt: true }, interruption: 'requested' });
    await flushMailboxWake(schedulerLate.ctx, 'sibling', 'ws'); assert.equal(notices, 0);
    target.lifecycle = 'idle'; await flushMailboxWake(schedulerLate.ctx, 'sibling', 'ws');
    assert.equal(notices, 1); assert.equal(schedulerLate.ledger().messages[0].interruption, 'stopped');
  } finally { schedulerLate.off(); }
  const nativeStop = world();
  try {
    const child = nativeStop.ctx.sessions.get('child');
    Object.assign(child, { lifecycle: 'working', externalSessionId: 'native', cwd: tmp });
    let sent = false, prepared = false;
    const binding = { interruptInput: '\x1b', async prepareInterrupt(input) {
      assert.equal(sent, false); assert.equal(input.sessionId, 'native'); prepared = true;
      return async () => sent;
    } };
    nativeStop.ctx.config = { get: () => ({}) };
    nativeStop.ctx.sessions.isChatRuntime = () => false;
    nativeStop.ctx.sessions.getCliWorkspaceContext = () => binding;
    nativeStop.ctx.sessions.applyActivitySignal = (_id, activity) => { assert.equal(activity, 'idle'); child.lifecycle = 'idle'; };
    nativeStop.ctx.sessions.injectStrategy = async () => 'relaunch-resume';
    nativeStop.ctx.sessions.pasteInput = async () => false;
    nativeStop.ctx.sessions.relaunchWithPrompt = async () => {};
    nativeStop.ctx.pty = { isRunning: () => true, write: () => { assert.equal(prepared, true); sent = true; return true; } };
    const result = await nativeStop.send();
    assert.equal(result.interruption, 'stopped'); assert.ok(nativeStop.ledger().messages[0].notifiedAt);
  } finally { nativeStop.off(); }
  console.log('mailbox-interrupt: OK (direct parent, durable order, true stop, pinned control key, idempotency, failure preserves mail)');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
