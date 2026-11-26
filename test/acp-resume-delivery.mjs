/** ACP prompt receipts and host continuations use the real driver/RPC/state machine, without a model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-resume-delivery-'));
const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
const load = file => import(pathToFileURL(compile(file)).href);
const { AcpRuntimeDriver } = await load('main/agentSession/drivers/acp/driver.ts');
const { NdjsonRpc } = await load('main/agentSession/drivers/acp/jsonRpc.ts');
const { ResumeWaitStore } = await load('main/resumeWait/store.ts');
const { ResumeWaitService } = await load('main/resumeWait/service.ts');
const { deliverSession } = await load('main/agentSession/delivery.ts');

async function until(predicate, label) {
  for (let n = 0; n < 150 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), label);
}
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(onEvent = () => {}, { resumeToken, capabilities = {}, resumeError = false } = {}) {
  const incoming = new PassThrough(), outgoing = new PassThrough();
  const rpc = new NdjsonRpc(incoming, outgoing);
  const lines = createInterface({ input: incoming });
  const requests = [], prompts = [], events = [];
  const sessionId = 'acp-receipt-session';
  const emit = message => outgoing.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const result = (request, value = { stopReason: 'end_turn' }) => emit({ id: request.id, result: value });
  lines.on('line', line => {
    const request = JSON.parse(line);
    requests.push(request);
    if (request.method === 'initialize') result(request, { protocolVersion: 2, agentCapabilities: capabilities });
    else if (request.method === 'session/new') result(request, { sessionId });
    else if (request.method === 'session/load' || request.method === 'session/resume') {
      if (resumeError) emit({ id: request.id, error: { code: -32602, message: 'saved session is missing' } });
      else result(request, { sessionId });
    }
    else if (request.method === 'session/prompt') prompts.push(request);
  });
  const driver = new AcpRuntimeDriver({ config: { get: () => ({}) } }, { userDataDir: tmp }, {
    spawnAgent: () => ({ rpc, kill: () => {} }),
    resolveLaunch: () => ({ command: 'offline-acp', args: [] }),
    closeDrainTimeoutMs: 20
  });
  const conn = await driver.connect({
    sessionId: 'worker', cwd: tmp, acpAgent: 'opencode', systemPromptAppend: '',
    ...(resumeToken ? { resumeToken, hasPriorConversation: true } : {}),
    mode: 'default', planExecuting: false, permissionMode: 'acceptEdits', modeController: {},
    hostTools: [], requestApproval: async () => ({ approved: true }),
    getTurnId: () => 'host-turn', getPolicyState: () => ({ mode: 'default', planExecuting: false }), log() {}
  }).catch(error => {
    lines.close(); incoming.destroy(); outgoing.destroy();
    throw Object.assign(error, { requests });
  });
  const pump = (async () => {
    for await (const event of conn.events) { events.push(event); onEvent(event); }
  })();
  return { driver, conn, prompts, events, requests, emit, result,
    starts: () => events.filter(event => event.type === 'turn-started').map(event => event.userMessageId),
    update: (update, id = sessionId) => emit({ method: 'session/update', params: { ...(id === null ? {} : { sessionId: id }), update } }),
    send: id => conn.send('resume work', undefined, undefined, { forkIdentity: { userMessageId: id, assistantMessageId: `assistant-${id}` } }),
    disconnect: () => outgoing.destroy(new Error('offline fixture disconnected')),
    async close() { await conn.close(); await pump; lines.close(); incoming.destroy(); outgoing.destroy(); }
  };
}

try {
  const resumeToken = 'acp-receipt-session';
  await assert.rejects(fixture(undefined, { resumeToken }), error => {
    assert.match(error.message, /未声明会话恢复能力/);
    assert.deepEqual(error.requests.map(request => request.method), ['initialize']);
    return true;
  });
  await assert.rejects(fixture(undefined, { resumeToken, capabilities: { loadSession: true }, resumeError: true }), error => {
    assert.match(error.message, /saved session is missing/);
    assert.deepEqual(error.requests.map(request => request.method), ['initialize', 'session/load']);
    assert.equal(error.requests[1].params.sessionId, resumeToken);
    return true;
  });
  const resumed = await fixture(undefined, { resumeToken, capabilities: { sessionCapabilities: { resume: {} } } });
  try {
    assert.deepEqual(resumed.requests.map(request => request.method), ['initialize', 'session/resume']);
    assert.equal(resumed.requests[1].params.sessionId, resumeToken);
  } finally { await resumed.close(); }

  for (const update of [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
    // Extension metadata cannot override the standard session ownership of activity.
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working through a subagent' },
      _meta: { 'cognition.ai/subagent_context': { id: 'child' } } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'read', status: 'in_progress' }
  ]) {
    const f = await fixture();
    try {
      assert.equal(f.driver.deliveryCapabilities, undefined, 'ordinary sends require no optional preemption declaration');
      await f.send('input-1');
      await settle();
      assert.deepEqual(f.starts(), [], 'writing the request must not acknowledge delivery');
      assert.equal(f.prompts.length, 1);
      await assert.rejects(f.send('overlapping-input'), /回合进行中/);
      f.update(update);
      await until(() => f.starts().length === 1, 'matching turn activity acknowledges its input');
      assert.deepEqual(f.starts(), ['input-1']);
      f.update(update);
      f.result(f.prompts[0]);
      await until(() => f.events.some(event => event.type === 'turn-complete'), 'first turn finishes');
      assert.deepEqual(f.starts(), ['input-1'], 'chunks and completion share one receipt');
      const start = f.events.findIndex(event => event.type === 'turn-started');
      const activity = f.events.findIndex(event => ['text-delta', 'thinking-delta', 'tool-start'].includes(event.type));
      assert.ok(start < activity, 'the receipt precedes the activity that proves acceptance');
    } finally { await f.close(); }
  }

  {
    const f = await fixture();
    try {
      const results = await Promise.allSettled([f.send('racing-1'), f.send('racing-2')]);
      assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected'],
        'permission refresh must not allow two sends to enter the same ACP session');
      assert.match(results[1].reason.message, /回合进行中/);
      assert.equal(f.prompts.length, 1);
      f.result(f.prompts[0]);
      await until(() => f.events.some(event => event.type === 'turn-complete'), 'single admitted send finishes');
      assert.deepEqual(f.starts(), ['racing-1']);
    } finally { await f.close(); }
  }

  {
    const f = await fixture();
    try {
      await f.send('permission-turn');
      f.emit({ id: 'permission-request', method: 'session/request_permission', params: {
        sessionId: 'acp-receipt-session', toolCall: { toolCallId: 'tool-permission', title: 'read', kind: 'read' },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }]
      } });
      await until(() => f.starts().length === 1, 'a current-session tool permission request proves prompt acceptance');
      assert.deepEqual(f.starts(), ['permission-turn']);
      f.result(f.prompts[0]);
      await until(() => f.events.some(event => event.type === 'turn-complete'), 'permission turn completes');
    } finally { await f.close(); }
  }

  {
    const f = await fixture();
    try {
      await f.send('empty-turn');
      f.result(f.prompts[0]);
      await until(() => f.events.some(event => event.type === 'turn-complete'), 'empty success completes');
      assert.deepEqual(f.starts(), ['empty-turn'], 'a correlated successful response confirms a silent turn');
      f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late old output' } });
      await f.send('next-turn');
      // Old RPC responses, wrong/missing session IDs and session-level metadata
      // cannot stand in for acceptance of the next prompt.
      f.result(f.prompts[0]);
      f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong session' } }, 'another-session');
      f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unbound session' } }, null);
      f.update({ sessionUpdate: 'available_commands_update', availableCommands: [] });
      f.update({ sessionUpdate: 'current_mode_update', currentModeId: 'default' });
      await settle();
      assert.deepEqual(f.starts(), ['empty-turn']);
      f.result(f.prompts[1]);
      await until(() => f.starts().length === 2, 'the next response confirms the next input');
      assert.deepEqual(f.starts(), ['empty-turn', 'next-turn']);
    } finally { await f.close(); }
  }

  for (const outcome of ['reject', 'cancel', 'server-cancel', 'disconnect']) {
    const f = await fixture();
    try {
      await f.send(outcome);
      if (outcome === 'reject') f.emit({ id: f.prompts[0].id, error: { code: -32602, message: 'prompt rejected' } });
      if (outcome === 'cancel') {
        await f.conn.abort();
        assert.ok(f.requests.some(request => request.method === 'session/cancel'));
        f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late cancelled output' } });
        f.result(f.prompts[0]);
      }
      if (outcome === 'server-cancel') f.result(f.prompts[0], { stopReason: 'cancelled' });
      if (outcome === 'disconnect') f.disconnect();
      await until(() => f.events.some(event => ['turn-complete', 'error'].includes(event.type)), outcome);
      assert.deepEqual(f.starts(), [], `${outcome} before activity must not acknowledge the input`);
      if (outcome === 'cancel' || outcome === 'server-cancel') {
        assert.equal(f.events.find(event => event.type === 'turn-complete')?.cancelled, true,
          `${outcome} remains distinguishable from a successful silent turn at the shared Host boundary`);
      }
    } finally { await f.close(); }
  }

  {
    let service, busy = false, now = Date.now();
    const f = await fixture(event => {
      if (event.type === 'turn-started') service?.acknowledge('worker', event.userMessageId);
      if (event.type === 'turn-complete' || event.type === 'error') busy = false;
    });
    const store = new ResumeWaitStore(path.join(tmp, 'continuations'));
    try {
      const alert = [];
      service = new ResumeWaitService(store, {
        now: () => now, desktopEpoch: () => null,
        isBusy: () => busy, alert: async (_wait, reason) => { alert.push(reason); },
        deliver: async (_wait, content, deliveryId) => deliverSession({
          capabilities: { interject: false, snapshot: false }, isBusy: () => busy,
          wake: async () => { busy = true; await f.send(deliveryId); return { status: 'submitted' }; },
          queue: async () => {}
        }, content, { priority: _wait.priority, deliveryId })
      });
      busy = true;
      await f.send('existing-work');
      const wait = service.arm('worker', 'ws', { condition: { kind: 'mail', from: 'child' }, note: 'check child result' });
      service.mail('ws', { id: 'mail-1', from: 'child', to: 'worker', text: 'done', ts: now });
      await service.tick();
      assert.equal(f.prompts.length, 1, 'a busy ACP turn is not interrupted or sent an overlapping prompt');
      assert.equal(store.get(wait.id).state, 'ready');
      f.result(f.prompts[0]);
      await until(() => !busy, 'existing prompt ends');
      await service.tick();
      assert.equal(f.prompts.length, 2, 'continuation sends through the same connection at the turn boundary');
      const sent = store.get(wait.id);
      assert.equal(sent.state, 'delivering', 'host submission is not engine acceptance');
      f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'checking result' } });
      await until(() => store.get(wait.id).state === 'consumed', 'driver receipt consumes the exact continuation');
      assert.equal(f.starts().at(-1), sent.deliveryId);
      now += 120000;
      await service.tick();
      assert.equal(f.prompts.length, 2, 'an acknowledged continuation is never retried for a missing receipt');
      assert.deepEqual(alert, []);
      f.result(f.prompts[1]);
      await until(() => !busy, 'continuation finishes');
    } finally { await f.close(); store.close(); }
  }
  console.log('acp-resume-delivery: ok');
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
