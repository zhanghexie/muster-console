import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const originalLoad = Module._load;
const previousExtension = require.extensions['.ts'];
const terminalPort = {
  'terminal.write': (ctx, input, options) => ctx.writeTerminal(input, options),
  'terminal.capture': (ctx, input, options) => ctx.captureTerminal(input, options)
};
let WorkbenchMessagingHost;
let messagingTurnIdentity;
let sendWorkbenchRemote;
let openSession;
try {
  require.extensions['.ts'] = (module, filename) => {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
    }).outputText, filename);
  };
  Module._load = function (request, parent, isMain) {
    if (request === '../capabilities/hosts/terminal' && parent?.filename.endsWith(`${path.sep}workbenchBridge.ts`)) return { terminalHost: terminalPort };
    if (parent?.filename.endsWith(`${path.sep}orchestrator${path.sep}sessions.ts`)) {
      if (request === '../providers/piProvider') return { loadPiSessionDisplay: (ctx, wsId, file) => ctx.loadPiSessionDisplay(wsId, file) };
      if (['./eventBus', './buckets', '../schedulerWorkspaceContext', '../../sessionReminders/service'].includes(request)) return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ WorkbenchMessagingHost } = require('../src/main/messaging/workbenchBridge.ts'));
  ({ messagingTurnIdentity } = require('../src/main/messaging/sessionAuthority.ts'));
  ({ sendWorkbenchRemote } = require('../src/main/agent/orchestrator/workbenchRemote.ts'));
  ({ openSession } = require('../src/main/agent/orchestrator/sessions.ts'));
} finally {
  Module._load = originalLoad;
  if (previousExtension) require.extensions['.ts'] = previousExtension;
  else delete require.extensions['.ts'];
}

const workspaces = [{ id: 'one', name: 'Planning' }, { id: 'two', name: 'Delivery' }];
const workers = [
  { id: 'gui-existing', workspaceId: 'one', type: 'terminal', runtime: 'pi', name: 'Existing Worker', lifecycle: 'idle' },
  { id: 'pty-existing', workspaceId: 'one', type: 'terminal', runtime: 'claude-code', name: 'Existing Terminal', lifecycle: 'idle', status: 'running' },
  { id: 'archived', workspaceId: 'one', type: 'terminal', runtime: 'pi', name: 'Archived Worker', archived: true }
];

function fixtures() {
  const calls = [];
  const listeners = new Set();
  const currentSessionFiles = new Map();
  const ctx = {
    config: { get: () => ({ activeWorkspaceId: 'one' }) },
    workspaces: { list: () => workspaces },
    sessions: {
      listForAgent: id => ({ sessions: workers.filter(row => row.workspaceId === id) }),
      get: id => workers.find(row => row.id === id),
      isChatRuntime: runtime => runtime === 'pi',
      createTerminal: () => assert.fail('remote must reuse existing workbench sessions'),
      select: () => assert.fail('remote routing must not move a desktop conversation')
    },
    orchestrator: {
      isBusy: () => false,
      currentAssistantMessageId: () => 'unrelated-desktop-answer',
      getAgentMode: () => 'ask',
      getCurrentSessionFile: wsId => currentSessionFiles.get(wsId),
      async sendWorkbenchRemote(text, wsId, requestId) {
        calls.push({ type: 'scheduler', text, wsId, requestId });
        return { status: 'completed', message: { content: `Scheduler ${wsId}: ${text}` } };
      },
      send: () => assert.fail('remote must use exact scheduler receipt port'),
      stop: () => assert.fail('remote must not stop a desktop turn'),
      async listSessions(wsId) { return [{ path: `record-${wsId}`, title: `Task ${wsId}`, modified: Date.now() }]; },
      async openSession(wsId, file) {
        currentSessionFiles.set(wsId, file);
        calls.push({ type: 'open', wsId, file });
        return { ok: true };
      },
      clearHistory(wsId) { currentSessionFiles.delete(wsId); calls.push({ type: 'new', wsId }); }
    },
    agentSessions: {
      open: session => calls.push({ type: 'gui-open', id: session.id }),
      isBusy: () => false,
      currentAssistantMessageId: () => 'unrelated-desktop-answer',
      getHistoryRange: () => ({ messages: [] }),
      onPush(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      sendWorkbenchRemoteInput(id, input) {
        const { assistantMessageId: turnId } = messagingTurnIdentity(input.requestId);
        calls.push({ type: 'gui', id, text: input.text, turnId });
        return { status: 'accepted', turnId };
      },
      send: () => assert.fail('bound remote input must not receive desktop authority'),
      abort: () => assert.fail('remote must not stop a desktop turn')
    },
    pty: { isRunning: () => true, getStatus: () => 'running' },
    async writeTerminal(input, options) { calls.push({ type: 'pty-write', ...input }); options.onFirstSubmit(); return { outputCursor: 'pty-cursor' }; },
    async captureTerminal(input) {
      calls.push({ type: 'pty-capture', ...input });
      return { textTail: 'terminal output', previewPath: '/synthetic/terminal.png' };
    }
  };
  const bridge = new WorkbenchMessagingHost(ctx);
  const emit = (id, messages) => { for (const listener of listeners) listener({ kind: 'sync', sessionId: id, messages }); };
  return { bridge, ctx, calls, emit, listeners };
}

function route(bridge, conversationId = 'private-chat', extra = {}) {
  let sequence = 0;
  return (text, override = {}) => bridge.handle({ channelKey: 'weixin', botId: 'paired-bot', conversationId, senderId: 'paired-sender',
    messageId: `msg-${++sequence}`, text, conversationType: 'direct', addressed: false, senderIsBot: false, ...extra, ...override });
}

test('source pairings and compatible account routes offer all workbench destination commands', async t => {
  const { bridge } = fixtures();
  t.after(() => bridge.stopAndWait());
  for (const send of [route(bridge, 'source-pairing', { authorizationId: 'source-authorization' }), route(bridge, 'legacy-account')]) {
    const help = (await send('/help')).text;
    assert.match(help, /\/ws <.*切工作区/);
    assert.match(help, /\/s <.*切调度会话/);
    assert.match(help, /\/ts · 工作会话列表/);
    assert.match(help, /\/bind <.*绑定工作会话/);
    assert.match(help, /\/unbind · 退出绑定/);
    assert.match(help, /\/status/);
    assert.match(help, /\/stop · 停止当前远程回合/);
  }
});

test('ordinary IM text uses workbench scheduler and per-chat workspace selection', async t => {
  const { bridge, calls } = fixtures();
  t.after(() => bridge.stopAndWait());
  const first = route(bridge, 'first-chat');
  const second = route(bridge, 'second-chat');
  assert.match((await first('/ws')).text, /Delivery/);
  assert.match((await first('切工作区 2')).text, /Delivery/);
  assert.deepEqual(await first('hello'), { text: 'Scheduler two: hello' });
  assert.deepEqual(await second('hello'), { text: 'Scheduler one: hello' });
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  assert.match((await first('调度会话列表')).text, /Task two/);
  await first('/s 1');
  await first('/new');
  assert.deepEqual(calls.slice(-2), [{ type: 'open', wsId: 'two', file: 'record-two' }, { type: 'new', wsId: 'two' }]);
  assert.equal((await second('/stop')).text.includes('停止当前回合'), false);
});

test('a deleted workspace or work session never redirects a paired sender’s input', async t => {
  const { bridge, ctx, calls } = fixtures();
  t.after(() => bridge.stopAndWait());
  const send = route(bridge, 'removed-destination', { authorizationId: 'paired-grant' });
  await send('/ws');
  await send('/ws 2');
  ctx.workspaces.list = () => [workspaces[0]];
  assert.match((await send('unroutable work')).text, /工作区不可用.*\/ws/);
  assert.match((await send('/ws 2')).text, /无法确定工作区/);
  assert.deepEqual(calls, []);
  await send('/ws');
  assert.match((await send('/ws 1')).text, /Planning/);
  await send('/bind Existing Worker');
  ctx.sessions.get = () => undefined;
  for (const message of ['first attempt', 'second attempt']) {
    assert.match((await send(message)).text, /工作会话已不存在.*\/bind.*\/unbind/);
  }
  assert.deepEqual(calls, []);
  await send('/unbind');
  assert.deepEqual(await send('back at intended scheduler'), { text: 'Scheduler one: back at intended scheduler' });
});

test('scheduler selection is held for the source and never follows another sender’s explicit switch', async t => {
  const { bridge, ctx, calls } = fixtures();
  t.after(() => bridge.stopAndWait());
  const first = route(bridge, 'planning-room', { authorizationId: 'first', conversationType: 'group', addressed: true, senderId: 'first' });
  const second = route(bridge, 'planning-room', { authorizationId: 'second', conversationType: 'group', addressed: true, senderId: 'second' });
  ctx.orchestrator.listSessions = async () => [
    { path: 'planning-a', title: 'Planning A', modified: Date.now() },
    { path: 'planning-b', title: 'Planning B', modified: Date.now() }
  ];
  await first('/s', { messageId: 'first-list' });
  assert.match((await first('/s Planning', { messageId: 'ambiguous-choice' })).text, /无法确定调度会话/);
  assert.match((await first('/s 1', { messageId: 'first-choice' })).text, /Planning A/);
  await second('/s', { messageId: 'second-list' });
  assert.match((await second('/s 2', { messageId: 'second-choice' })).text, /Planning B/);
  assert.match((await first('scheduler task', { messageId: 'first-task' })).text, /所选调度会话已变更.*\/s/);
  assert.equal(calls.filter(call => call.type === 'scheduler').length, 0);
  assert.deepEqual(await second('other task', { messageId: 'second-task' }), { text: 'Scheduler one: other task' });
  const reopened = new WorkbenchMessagingHost(ctx);
  t.after(() => reopened.stopAndWait());
  assert.deepEqual(await route(reopened, 'planning-room', { authorizationId: 'first' })('resumed remotely'), { text: 'Scheduler one: resumed remotely' });
});

test('bound existing GUI replies use the exact assistant ID and never emit a desktop reply', async t => {
  const { bridge, calls, emit, listeners } = fixtures();
  t.after(() => bridge.stopAndWait());
  const send = route(bridge);
  const list = (await send('/ts')).text;
  assert.match(list, /Existing Worker/);
  assert.doesNotMatch(list, /Archived Worker/);
  assert.match((await send('/bind 1')).text, /Existing Worker/);
  const pending = send('GUI task');
  await new Promise(resolve => setImmediate(resolve));
  const { turnId } = calls.find(item => item.type === 'gui');
  let delivered = false;
  void pending.then(() => { delivered = true; });
  const finished = (id, text) => ({ id, role: 'assistant', finishedAt: 1, parts: [{ kind: 'text', text }] });
  emit('gui-existing', [finished('desktop-answer', 'desktop secret')]);
  emit('different-worker', [finished(turnId, 'other worker secret')]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered, false);
  emit('gui-existing', [finished(turnId, 'exact remote answer')]);
  assert.deepEqual(await pending, { text: 'exact remote answer' });
  assert.equal(listeners.size, 0);
  await send('/unbind');
  assert.match((await send('back to scheduler')).text, /Scheduler one/);
});

test('bound PTY uses existing typed submit and sends only its local capture to the origin', async t => {
  const { bridge, calls } = fixtures();
  t.after(() => bridge.stopAndWait());
  const send = route(bridge);
  await send('/bind Existing Terminal');
  const result = await send('terminal input');
  assert.equal(result.image.filePath, '/synthetic/terminal.png');
  assert.match(result.text, /Existing Terminal/);
  assert.doesNotMatch(result.text, /terminal output/);
  assert.deepEqual(calls[0], { type: 'pty-write', sessionId: 'pty-existing', text: 'terminal input', mode: 'typed', submit: true });
  assert.deepEqual(calls[1], {
    type: 'pty-capture', sessionId: 'pty-existing', after: 'pty-cursor', waitFor: { quietMs: 700, timeoutMs: 15_000 }
  });
  assert.match((await send('bad\x03input')).text, /控制字符/);
  assert.equal(calls.length, 2);
});

test('PTY stop cancels a pending submission or retries without claiming to stop the CLI', async t => {
  for (const firstEnterSent of [false, true]) {
    const { bridge, calls, ctx } = fixtures();
    t.after(() => bridge.stopAndWait());
    const send = route(bridge);
    await send('/bind Existing Terminal');
    let onWrite;
    const wrote = new Promise(resolve => { onWrite = resolve; });
    ctx.writeTerminal = async (_input, { signal, onFirstSubmit }) => {
      if (firstEnterSent) onFirstSubmit();
      onWrite();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const inFlight = send('terminal task');
    await wrote;
    assert.match((await send('/stop')).text, firstEnterSent ? /已提交/ : /已撤销/);
    assert.deepEqual(await inFlight, { text: '' });
    assert.deepEqual(calls, []);
  }
});

test('revocation and route changes block a scheduler session switch after its archive was read', async t => {
  for (const changeWorkspace of [false, true]) {
    const { bridge, ctx } = fixtures();
    t.after(() => bridge.stopAndWait());
    const send = route(bridge);
    const authority = new AbortController();
    const bucket = { display: [], busy: false };
    ctx.store = { getPiSessionDir: () => '/synthetic/tasks' };
    ctx.desktopEpochs = { endScheduler: () => assert.fail('revoked switch must not alter desktop epochs') };
    let beginRead;
    let finishRead;
    const read = new Promise(resolve => { beginRead = resolve; });
    const loaded = new Promise(resolve => { finishRead = resolve; });
    ctx.loadPiSessionDisplay = () => { beginRead(); return loaded; };
    ctx.orchestrator.listSessions = async () => [{ path: '/synthetic/tasks/queued.jsonl', title: 'Pending', modified: 1 }];
    const host = { ctx, ensureBucket: () => bucket, buckets: new Map([['one', bucket]]) };
    ctx.orchestrator.openSession = (...args) => openSession(host, ...args);
    await send('/s');
    const switching = send('/s 1', { signal: authority.signal });
    await read;
    try {
      if (changeWorkspace) await send('/ws 2');
      else authority.abort();
    } finally { finishRead([{ id: 'archive-answer', role: 'assistant', createdAt: 1, content: 'Desktop archive' }]); }
    assert.deepEqual(await switching, { text: '' });
    assert.deepEqual(bucket, { display: [], busy: false });
  }
});

test('a new pairing of the same sender starts at default routing and cannot replay old events', async t => {
  const { bridge } = fixtures();
  t.after(() => bridge.stopAndWait());
  const first = route(bridge, 're-paired-chat', { authorizationId: 'pairing-one' });
  assert.match((await first('/bind Existing Terminal')).text, /Existing Terminal/);
  const next = route(bridge, 're-paired-chat', { authorizationId: 'pairing-two' });
  assert.deepEqual(await next('/bind Existing Terminal', { messageId: 'msg-1' }), { text: '' });
  assert.deepEqual(await next('new pairing task'), { text: 'Scheduler one: new pairing task' });
});

test('other remote conversations do not evict an authorized user’s selected workspace', async t => {
  const { bridge } = fixtures();
  t.after(() => bridge.stopAndWait());
  const send = route(bridge, 'pinned-chat', { authorizationId: 'pinned-authorization' });
  assert.match((await send('/ws 2')).text, /Delivery/);
  for (let index = 0; index < 4096; index++) {
    await route(bridge, `help-chat-${index}`)('/help');
  }
  assert.deepEqual(await send('selected work'), { text: 'Scheduler two: selected work' });
});

test('duplicate events, bots, and unaddressed group messages do not start a scheduler turn', async t => {
  const { bridge, calls } = fixtures();
  t.after(() => bridge.stopAndWait());
  const send = route(bridge, 'group', { conversationType: 'group' });
  assert.deepEqual(await send('ignored group text'), { text: '' });
  assert.deepEqual(await send('bot text', { addressed: true, senderIsBot: true }), { text: '' });
  assert.match((await send('addressed text', { addressed: true, messageId: 'repeat' })).text, /Scheduler one/);
  assert.deepEqual(await send('duplicate', { addressed: true, messageId: 'repeat' }), { text: '' });
  assert.equal(calls.length, 1);
  await bridge.stopAndWait();
  assert.deepEqual(await send('late', { addressed: true }), { text: '' });
});

test('paired group members keep separate controls and only plain work sends an acknowledgment', async t => {
  const { bridge, ctx, calls } = fixtures();
  t.after(() => bridge.stopAndWait());
  const progress = [];
  const group = { conversationType: 'group', addressed: true, onProgress: async text => progress.push(text) };
  const first = route(bridge, 'same-group', { ...group, senderId: 'member-one' });
  const second = route(bridge, 'same-group', { ...group, senderId: 'member-two' });
  await first('/ws 2', { messageId: 'first-workspace' });
  assert.deepEqual(progress, []);
  ctx.orchestrator.isBusy = id => id === 'two';
  const waiting = first('queued', { messageId: 'first-work' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progress.length, 1);
  assert.match(progress[0], /等待/);
  assert.match((await second('/stop', { messageId: 'second-stop' })).text, /没有/);
  assert.match((await second('separate', { messageId: 'second-work' })).text, /Scheduler one/);
  assert.equal(calls.length, 1);
  await first('/stop', { messageId: 'first-stop' });
  await waiting;
  assert.equal(progress.length, 2);
  assert.equal(calls.length, 1);
});

test('bound worker cancellation calls the matching host abort and waits for its acknowledgment', async t => {
  const { bridge, ctx, calls, listeners } = fixtures();
  t.after(() => bridge.stopAndWait());
  const send = route(bridge);
  await send('/bind 1');
  const lifecycle = new AbortController();
  const aborts = [];
  let releaseAbort;
  ctx.agentSessions.abort = id => {
    aborts.push(id);
    return new Promise(resolve => { releaseAbort = resolve; });
  };
  const running = send('cancel the bound task', { signal: lifecycle.signal });
  await new Promise(resolve => setImmediate(resolve));
  const work = calls.find(item => item.type === 'gui');
  ctx.agentSessions.currentAssistantMessageId = () => work.turnId;
  let settled = false;
  void running.then(() => { settled = true; });
  try {
    lifecycle.abort();
    assert.deepEqual(aborts, [work.id]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally { releaseAbort?.(); }
  assert.deepEqual(await running, { text: '' });
  assert.equal(listeners.size, 0);
});

test('scheduler cancellation can stop only the assistant captured by this remote request', async () => {
  for (const replaceWithDesktop of [false, true]) {
    const signal = new AbortController();
    const bucket = { busy: false };
    const stops = [];
    let finish;
    const provider = new Promise(resolve => { finish = resolve; });
    const scheduler = { buckets: new Map([['one', bucket]]), isBusy: () => bucket.busy, getHistoryRange: () => ({ messages: [] }),
      async send(_text, id, _images, options) {
        assert.equal(options.beforeStart(), true);
        assert.equal(options.requireIdle, true);
        const assistant = { role: 'assistant', id: options.workbenchRemote.assistantId, content: '' };
        bucket.streamingAssistant = assistant;
        bucket.busy = true;
        options.onAccepted();
        await provider;
        options.workbenchRemote.settle(bucket.streamingAssistant === assistant ? assistant : undefined);
        assert.equal(id, 'one');
      },
      stop(id) { stops.push(id); finish(); }
    };
    const task = sendWorkbenchRemote(scheduler, 'remote turn', 'one', 'paired-event', signal.signal, () => true);
    if (replaceWithDesktop) bucket.streamingAssistant = { id: 'desktop-concurrent', aborted: false };
    signal.abort();
    finish();
    const done = await task;
    if (replaceWithDesktop) {
      assert.deepEqual(stops, []);
      assert.equal(bucket.streamingAssistant.aborted, false);
      assert.equal(done.status, 'unknown');
    } else {
      assert.deepEqual(stops, ['one']);
      assert.equal(done.status, 'completed');
      assert.equal(done.message.aborted, true);
    }
  }
});
