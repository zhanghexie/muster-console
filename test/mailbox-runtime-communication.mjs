/** Real mailbox + seeded TUI script + production Pi receive method. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-native-'));
const compile = createSharedCompiler(root, tmp);
const load = p => import(pathToFileURL(compile(p)).href);
const store = await load('main/metaAgent/messageStore.ts');
const { RuntimeHost } = await load('main/runtime/host.ts');
const { deliverMailboxNotice } = await load('main/messages/communication.ts');
const { sendInterruptMail } = await load('main/messages/interrupt.ts');
const { attachMailboxWakes, MailboxWakes, flushMailboxWake } = await load('main/messages/wake.ts');
const { deliverAgentMessage } = await load('main/messages/deliver.ts');
let sequence = 0;
function world() {
  const dir = path.join(tmp, `world-${++sequence}`); fs.mkdirSync(dir);
  store.setAgentMessagesUserDataDir(dir);
  const child = { id: 'child', name: 'child', workspaceId: 'ws', runtime: 'native-test', cwd: dir,
    parentSessionId: 'parent', externalSessionId: 'engine-1', lifecycle: 'working' };
  const parent = { id: 'parent', workspaceId: 'ws' };
  const ledger = () => store.readAgentMessageLedger(dir, 'ws');
  let writes = 0;
  const ctx = { config: { get: () => ({}) }, sessions: {
    get: id => id === 'child' ? child : id === 'parent' ? parent : undefined,
    peek: id => id === 'child' ? child : parent, broadcastMessagesChanged() {},
    isChatRuntime: () => false, onLifecycle: () => () => {}, getCliWorkspaceContext: () => undefined
  }, workspaces: { list: () => [{ id: 'ws', path: dir }] }, resolveBubbleWorkspaceId: () => 'ws',
  pty: { isRunning: () => true, write() { writes++; throw new Error('keyboard fallback must not run'); } } };
  const off = attachMailboxWakes(ctx);
  return { ctx, child, dir, ledger, off, writes: () => writes,
    send: (args = {}) => sendInterruptMail(ctx, { from: 'parent', to: 'child', text: 'new instructions',
      idempotencyKey: 'priority', ...args }) };
}
try {
  const immediate = world();
  try {
    await assert.rejects(() => store.appendAgentMessageToStore(immediate.dir, 'ws', {
      from: 'parent', to: 'child', text: 'reply', ts: 1, receipt: 'stored', replyTo: 'missing-id'
    }), error => /missing-id/.test(error.message) && /host\.mail\.read/.test(error.message));
    immediate.child.lifecycle = 'idle';
    let needed = true;
    const binding = { async receiveMessage(input) {
      assert.equal(input.isCurrent(), true);
      immediate.child.lifecycle = 'working'; needed = false;
      return { status: 'accepted', method: 'sent' };
    } };
    immediate.ctx.sessions.getCliWorkspaceContext = () => binding;
    const receipt = await deliverMailboxNotice(immediate.ctx, 'child', 'ws', 'notice', 'immediate', () => needed);
    assert.equal(receipt.status, 'accepted', 'a successful wake may start work and read mail before acknowledgement');
  } finally { immediate.off(); }
  const selfReader = world();
  try {
    let busy = true, sends = 0, notice = '';
    selfReader.ctx.sessions.isChatRuntime = () => true;
    selfReader.ctx.agentSessions = { isBusy: () => busy, isOpen: () => true,
      deliverMessage() { throw Error('ordinary notices must not enter the native queue'); },
      async send(_id, text) { sends++; notice = text; return { ok: true }; } };
    const saved = await deliverAgentMessage(selfReader.ctx, { from: 'parent', to: 'child', text: 'read while active' });
    await flushMailboxWake(selfReader.ctx, 'child', 'ws');
    assert.equal(sends, 0);
    await store.markAgentMessagesReadInStore(selfReader.dir, 'ws', [saved.messageId]);
    busy = false;
    await flushMailboxWake(selfReader.ctx, 'child', 'ws');
    assert.equal(sends, 0, 'self-read during the turn must not leave a stale follow-up');
    await deliverAgentMessage(selfReader.ctx, { from: 'parent', to: 'child', text: 'new idle mail' });
    await flushMailboxWake(selfReader.ctx, 'child', 'ws');
    await flushMailboxWake(selfReader.ctx, 'child', 'ws');
    assert.equal(sends, 1, 'unread idle mail wakes once, independently of preview/read');
    assert.match(notice, /host\.mail\.read/);
    assert.doesNotMatch(notice, /sessions\.readMessages/);
  } finally { selfReader.off(); }
  const w = world();
  try {
    const builtinsDir = path.join(w.dir, 'builtins');
    fs.mkdirSync(path.join(builtinsDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(builtinsDir, 'registry.json'), JSON.stringify({ runtimes: [{
      id: 'native-test', label: 'Native test', script: 'native-test.mjs', builtin: true,
      enabled: true, surface: 'pty', updatedAt: 0
    }] }));
    const logPath = path.join(w.dir, 'native-received.jsonl');
    fs.writeFileSync(path.join(builtinsDir, 'scripts/native-test.mjs'), `
      import fs from 'node:fs';
      export async function allocate() { return {sessionId:'engine-1'}; }
      export function resolveLaunch() { return {command:'node',args:[]}; }
      export async function receiveMessage(input) {
        if (!input.isCurrent()) throw new Error('stale connection');
        fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({intent:input.intent,id:input.messageId,session:input.sessionId,text:input.text})+'\\n');
        return {status:'accepted',method:input.intent === 'interrupt' ? 'steered' : 'queued'};
      }`);
    const runtimes = new RuntimeHost({ userDataDir: w.dir, builtinsDir });
    await runtimes.ensureSeeded();
    w.ctx.runtimes = runtimes;
    const launch = await runtimes.resolveLaunch('native-test', 'start', 'engine-1', w.dir, []);
    const binding = { receiveMessage: launch.receiveMessage };
    w.ctx.sessions.getCliWorkspaceContext = () => binding;
    await runtimes.update('native-test', { scriptSource: `
      export async function allocate() { return {sessionId:'engine-1'}; }
      export function resolveLaunch() { return {command:'node',args:[]}; }
      export async function receiveMessage() { throw new Error('new module must wait for next launch'); }` });
    const normal = await deliverMailboxNotice(w.ctx, 'child', 'ws', 'new mail', 'normal', () => true);
    assert.equal(normal.status, 'deferred', 'busy agents read themselves; never enqueue an ordinary notice');
    assert.equal(fs.existsSync(logPath), false);
    w.child.lifecycle = 'idle';
    const idle = await deliverMailboxNotice(w.ctx, 'child', 'ws', 'new mail', 'normal', () => true);
    assert.equal(idle.method, 'queued');
    w.child.lifecycle = 'working';
    const [first, retry] = await Promise.all([w.send(), w.send()]);
    assert.equal(first.messageId, retry.messageId);
    assert.equal(first.interruption, 'accepted'); assert.equal(first.deliveryMethod, 'steered');
    assert.equal(w.writes(), 0); assert.equal(w.ledger().messages[0].read, false);
    assert.ok(w.ledger().messages[0].notifiedAt);
    await w.send();
    const received = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(received.map(x => x.intent), ['normal', 'interrupt']);
    assert.equal(received[1].session, 'engine-1');
    assert.match(received[1].text, /host\.mail\.read/);
    assert.doesNotMatch(received[1].text, /sessions\.readMessages/);
    await assert.rejects(w.send({ from: 'stranger' }), /直接子/);
    assert.equal(w.ledger().messages.length, 1);
  } finally { w.off(); }

  const unready = world();
  try {
    unready.child.externalSessionId = undefined;
    unready.ctx.runtimes = { async loadModule() { return { async receiveMessage() { throw new Error('must wait for engine identity'); } }; } };
    const result = await deliverMailboxNotice(unready.ctx, 'child', 'ws', 'notice', 'unready', () => true);
    assert.equal(result.status, 'deferred'); assert.equal(unready.writes(), 0);
  } finally { unready.off(); }

  for (const response of ['throw', 'invalid', 'stale']) {
    const w = world();
    try {
      let calls = 0;
      w.ctx.runtimes = { async loadModule() { return { async receiveMessage() {
        calls++;
        if (response === 'throw') throw new Error('ack lost');
        if (response === 'stale') w.child.externalSessionId = 'replacement';
        return response === 'invalid' ? { status: 'success' } : { status: 'accepted', method: 'steered' };
      } }; } };
      await assert.rejects(w.send(), /已保存.*未确认/);
      assert.equal(w.ledger().messages[0].interruption, 'delivering');
      await assert.rejects(w.send(), /状态未知/);
      assert.equal(calls, 1, 'unknown delivery cannot be replayed or switch to keyboard');
      assert.equal(w.writes(), 0);
    } finally { w.off(); }
  }

  const retryNative = world();
  try {
    let ready = false, calls = 0;
    retryNative.ctx.runtimes = { async loadModule() { return { async receiveMessage() {
      calls++;
      return ready ? { status: 'accepted', method: 'steered' } : { status: 'deferred', reason: 'waiting for engine ready' };
    } }; } };
    retryNative.child.parentSessionId = undefined;
    const receipt = await retryNative.send({ from: 'orchestrator:ws' });
    assert.equal(receipt.wake, 'deferred');
    assert.deepEqual(receipt.wakeDeferred, { reason: 'waiting for engine ready', retryWhileUnread: true });
    assert.equal('wakeError' in receipt, false);
    assert.equal(retryNative.ledger().messages[0].interruption, 'pending');
    ready = true; await flushMailboxWake(retryNative.ctx, 'child', 'ws');
    assert.equal(retryNative.ledger().messages[0].deliveryMethod, 'steered');
    assert.equal(retryNative.ledger().messages[0].interruption, 'accepted');
    assert.equal(retryNative.writes(), 0); assert.ok(calls >= 2);
  } finally { retryNative.off(); }

  const uncertain = world();
  try {
    uncertain.child.lifecycle = 'idle';
    let calls = 0;
    uncertain.ctx.runtimes = { async loadModule() { return { async receiveMessage() { calls++; throw new Error('lost native ack'); } }; } };
    await deliverAgentMessage(uncertain.ctx, { from: 'parent', to: 'child', text: 'ordinary mail' });
    await flushMailboxWake(uncertain.ctx, 'child', 'ws');
    assert.equal(uncertain.ledger().messages[0].wakeUncertain, true);
    await flushMailboxWake(uncertain.ctx, 'child', 'ws');
    assert.equal(calls, 1, 'ordinary native delivery must not replay unknown input either');
  } finally { uncertain.off(); }

  // Pi currently queues follow-up messages; exercise its actual adapter policy.
  const ts = createRequire(import.meta.url)('typescript');
  const source = fs.readFileSync(path.join(root, 'src/main/agentSession/drivers/pi/workerHost.ts'), 'utf8');
  const ast = ts.createSourceFile('pi.ts', source, ts.ScriptTarget.Latest, true);
  let method;
  function visit(n) { if (ts.isMethodDeclaration(n) && n.name?.getText(ast) === 'receiveMessage') method = n.getText(ast); ts.forEachChild(n, visit); }
  visit(ast); assert.ok(method);
  const code = ts.transpileModule(`({${method}}).receiveMessage`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const nativePi = new Function('turnActive', 'closed', 'isHostTurnCurrent', `return ${code}`)(true, false, () => true);
  assert.equal((await nativePi({ idleOnly: false })).status, 'unsupported');
  assert.equal((await nativePi({ idleOnly: true })).status, 'deferred');

  const lateReady = world();
  try {
    await store.appendAgentMessageToStore(lateReady.dir, 'ws', { id: 'mail-22222222-1111-1111-1111-111111111111',
      from: 'parent', to: 'child', kind: 'notice', text: 'late engine ready', ts: Date.now(), receipt: 'stored' });
    let attempts = 0;
    const wakes = new MailboxWakes(lateReady.ctx, async () => ++attempts < 6
      ? { status: 'deferred', reason: 'waiting for native ready' }
      : { status: 'accepted', method: 'sent' }, [5, 5, 5, 10]);
    try {
      await wakes.flush('child', 'ws');
      for (let n = 0; n < 100 && !lateReady.ledger().messages[0].notifiedAt; n++) await new Promise(r => setTimeout(r, 10));
      assert.equal(attempts, 6, 'no idle event: definitely unsubmitted wake still recovers after the initial burst');
      assert.equal(lateReady.ledger().messages[0].deliveryMethod, 'sent');
    } finally { wakes.dispose(); }
  } finally { lateReady.off(); }

  const deferred = world();
  try {
    await store.appendAgentMessageToStore(deferred.dir, 'ws', { id: 'mail-11111111-1111-1111-1111-111111111111',
      from: 'parent', to: 'child', kind: 'notice', text: 'keep me', ts: Date.now(), receipt: 'stored' });
    const wakes = new MailboxWakes(deferred.ctx, async () => ({ status: 'deferred', reason: 'waiting for native ready' }));
    await wakes.flush('child', 'ws'); wakes.dispose();
    assert.match(deferred.ledger().messages[0].wakeDeferred, /native ready/);
    assert.equal(deferred.ledger().messages[0].wakeError, undefined);
    assert.equal(deferred.ledger().messages[0].notifiedAt, undefined);
  } finally { deferred.off(); }
  console.log('mailbox-runtime-communication: OK (builtin TUI, Pi queue policy, native receipts, no unknown replay, durable deferral)');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
