import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-messaging-core-'));
after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const moduleUrl = source => pathToFileURL(compile(`main/messaging/${source}.ts`)).href;
const stateUrl = moduleUrl('state/conversationStateStore');
const { ConversationStateStore } = await import(stateUrl);
const { ConversationRouter, conversationKey } = await import(moduleUrl('conversationRouter'));
const { ChannelRegistry } = await import(moduleUrl('channelRegistry'));
const { inboundMessageKey } = await import(moduleUrl('contracts'));

const account = {
  channelKey: 'fake', botId: 'bot-1', enabled: true, displayName: 'Fake',
  credentialRef: { provider: 'test-only', id: 'fixture-reference' }
};
const address = { channelKey: account.channelKey, botId: account.botId, conversationId: 'chat' };
const access = { allowedSenderIds: ['person'], direct: 'allowlist', group: 'mention' };
const binding = { ...address, workspaceId: 'workspace', sessionId: 'session', access };
const message = (messageId, override = {}) => ({
  ...address, eventKind: 'message', messageId, senderId: 'person', senderIsBot: false,
  plainText: 'fixture text', conversationType: 'direct', addressed: false, ...override
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function createStore(t, name, options) {
  const directory = fs.mkdtempSync(path.join(temp, 'fixture-'));
  const store = new ConversationStateStore(path.join(directory, `${name}.sqlite`), options);
  t.after(() => store.close());
  store.setAccount(account);
  store.setBinding(binding);
  return store;
}

function fakeTransport(router) {
  return { emit: (id, override) => router.accept(message(id, override)) };
}

function fakeSession(handler = async input => ({ status: 'accepted', turnId: `turn-${input.message.messageId}` })) {
  const seen = [];
  return { seen, async submit(input) { seen.push(input); return handler(input); } };
}

test('conversation and event keys preserve identity and platform scope', () => {
  const keys = [
    { channelKey: 'fake:bot', botId: 'one', conversationId: 'chat' },
    { channelKey: 'fake', botId: 'bot:one', conversationId: 'chat' },
    { ...address, conversationId: 'chat:thread' },
    { ...address, threadId: 'thread' },
    { ...address },
    { ...address, botId: 'bot-2' }
  ].map(conversationKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(conversationKey(address), conversationKey({ ...address, threadId: undefined }));
  assert.equal(inboundMessageKey(message('same', { idempotencyScope: 'account' })),
    inboundMessageKey(message('same', { idempotencyScope: 'account', conversationId: 'elsewhere' })));
  assert.equal(inboundMessageKey(message('same')), inboundMessageKey(message('same', { threadId: 'reply-thread' })));
  assert.notEqual(inboundMessageKey(message('same', { idempotencyScope: 'thread' })),
    inboundMessageKey(message('same', { idempotencyScope: 'thread', threadId: 'reply-thread' })));
  assert.notEqual(inboundMessageKey(message('same')), inboundMessageKey(message('same', { botId: 'another' })));
});

test('channel registry snapshots descriptors and rejects duplicate or invalid definitions', () => {
  const registry = new ChannelRegistry();
  const descriptor = {
    channelKey: 'fake', displayName: 'Fake', connection: 'local', inbound: ['text'], outbound: ['text'],
    defaultTriggers: { direct: 'allowlist', group: 'mention', raw: 'must not surface' }, limits: { maxTextLength: 42 },
    raw: 'must not surface'
  };
  registry.register({ descriptor, createConnection() {} });
  descriptor.inbound.push('file');
  descriptor.defaultTriggers.group = 'all';
  const entry = registry.get('fake');
  assert.deepEqual(entry.descriptor.inbound, ['text']);
  assert.deepEqual(entry.descriptor.defaultTriggers, { direct: 'allowlist', group: 'mention' });
  assert.equal('raw' in entry.descriptor, false);
  assert.equal(registry.list()[0], entry);
  assert.throws(() => registry.register({ descriptor }), /already registered/);
  assert.throws(() => registry.register({ descriptor: { ...descriptor, channelKey: 'invalid', limits: { maxTextLength: -1 } } }), /Invalid/);
});

test('access and address checks happen before durable deduplication', async t => {
  const store = createStore(t, 'access');
  const session = fakeSession();
  const transport = fakeTransport(new ConversationRouter(store, session));
  assert.deepEqual(await transport.emit('message', { senderId: 'stranger' }), { status: 'ignored', reason: 'forbidden' });
  assert.deepEqual(await transport.emit('message', { senderIsBot: true }), { status: 'ignored', reason: 'bot' });
  assert.deepEqual(await transport.emit('message', { conversationType: 'group' }), { status: 'ignored', reason: 'not-addressed' });
  assert.deepEqual(await transport.emit('', { idempotencyKey: 'an-event-id' }), { status: 'ignored', reason: 'invalid-message' });
  assert.deepEqual(await transport.emit('message', { conversationId: 'unknown' }), { status: 'ignored', reason: 'unbound' });
  assert.equal(store.getBinding(address).lastActivityAt, undefined);

  const accepted = await transport.emit('message', { conversationType: 'group', addressed: true, plainText: '/clear', rawEvent: { privateData: true } });
  assert.equal(accepted.status, 'accepted');
  assert.equal(session.seen.length, 1);
  assert.equal(session.seen[0].intent, 'external-message');
  assert.equal(session.seen[0].actor, 'remote-human');
  assert.equal(session.seen[0].message.plainText, '/clear');
  assert.equal('rawEvent' in session.seen[0].message, false);
  assert.equal('access' in session.seen[0].binding, false);
  assert.deepEqual(await transport.emit('message'), { status: 'duplicate', receipt: store.getInboundReceipt(accepted.requestId) });
  assert.equal(session.seen.length, 1);
});

test('queue serializes an address, admits other threads, and applies backpressure', async t => {
  const store = createStore(t, 'queue');
  store.setBinding({ ...binding, threadId: 'topic' });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const session = fakeSession(async input => {
    if (input.message.messageId === 'first') {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    return { status: 'accepted', turnId: `turn-${input.message.messageId}` };
  });
  const router = new ConversationRouter(store, session, { maxPerConversation: 2, maxPending: 3 });
  const transport = fakeTransport(router);
  const first = transport.emit('first', { sourceTimestamp: 40 });
  await firstStarted.promise;
  try {
    const secondInput = message('second', { sourceTimestamp: 20 });
    const second = router.accept(secondInput);
    secondInput.plainText = 'modified after admission';
    assert.deepEqual(await transport.emit('third'), { status: 'backpressure', limit: 'conversation' });
    assert.equal((await transport.emit('second')).receipt.status, 'queued');
    const other = transport.emit('other', { threadId: 'topic' });
    assert.deepEqual(await transport.emit('fourth', { threadId: 'topic' }), { status: 'backpressure', limit: 'router' });
    assert.equal((await other).status, 'accepted');
    assert.deepEqual(session.seen.map(input => input.message.messageId), ['first', 'other']);
    releaseFirst.resolve();
    assert.equal((await first).status, 'accepted');
    assert.equal((await second).status, 'accepted');
    assert.equal(session.seen.at(-1).message.plainText, 'fixture text');
    assert.equal((await transport.emit('third')).status, 'accepted');
  } finally {
    releaseFirst.resolve();
    await router.stopAndWait();
  }
});

test('revocation, unbinding and a new target stop previously queued effects', async t => {
  for (const [reason, change] of [
    ['forbidden', store => store.setBinding({ ...binding, access: { ...access, allowedSenderIds: [] } })],
    ['unbound', store => store.deleteBinding(address)],
    ['account-disabled', store => store.setAccount({ ...account, enabled: false })],
    ['binding-changed', store => store.setBinding({ ...binding, workspaceId: 'next-workspace', sessionId: 'new-session' })]
  ]) {
    await t.test(reason, async t => {
      const store = createStore(t, 'revocation');
      const original = store.getBinding(address);
      const firstStarted = deferred();
      const release = deferred();
      const session = fakeSession(async () => { firstStarted.resolve(); return release.promise; });
      const router = new ConversationRouter(store, session);
      const transport = fakeTransport(router);
      const first = transport.emit('first');
      await firstStarted.promise;
      const second = transport.emit('second');
      change(store);
      if (reason === 'account-disabled') assert.throws(() => store.deleteAccount(account), /in progress/);
      release.resolve({ status: 'accepted', turnId: 'original-turn' });
      const accepted = await first;
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual(await second, { status: 'ignored', reason });
      assert.equal(session.seen.length, 1);
      assert.equal(store.getInboundReceipt(accepted.requestId).binding.revision, original.revision);
      assert.deepEqual(session.seen[0].origin, { ...address, messageId: 'first' });
      await router.stopAndWait();
    });
  }
});

test('known non-admission retries keep correlation, while a different target rejects the old event', async t => {
  const store = createStore(t, 'retry');
  const session = fakeSession(async input => session.seen.filter(seen => seen.message.messageId === input.message.messageId).length === 1
    ? { status: 'retryable' } : { status: 'accepted', turnId: 'retried-turn' });
  const transport = fakeTransport(new ConversationRouter(store, session));
  const first = await transport.emit('retry');
  assert.equal(first.status, 'retryable');
  const firstBinding = store.getInboundReceipt(first.requestId).binding;
  store.setBinding({ ...binding, access: { ...access, group: 'all' } }); // same target, new policy revision
  const retried = await transport.emit('retry');
  assert.deepEqual(retried, { status: 'accepted', requestId: first.requestId, turnId: 'retried-turn' });
  assert.deepEqual(session.seen.at(-1).binding, firstBinding);

  const second = await transport.emit('stale');
  assert.equal(second.status, 'retryable');
  store.setBinding({ ...binding, sessionId: 'new-session' });
  assert.deepEqual(await transport.emit('stale'), { status: 'ignored', reason: 'binding-changed' });
  assert.equal(store.getInboundReceipt(second.requestId).status, 'rejected');
  assert.equal((await transport.emit('stale')).status, 'duplicate');
  assert.equal(session.seen.length, 3);
});

test('restart recovers only known-undispatched rows as retryable and keeps unknown results', async t => {
  const store = createStore(t, 'recovery', { retentionMs: 10, maxReceiptsPerAccount: 2 });
  const savedBinding = store.getBinding(address);
  const inFlight = store.reserveInbound(message('in-flight'), savedBinding, 1).receipt;
  const queued = store.reserveInbound(message('queued'), savedBinding, 1).receipt;
  store.beginDispatch(message('in-flight'), inFlight.requestId, 2);
  store.close();
  const reopened = new ConversationStateStore(store.file, { retentionMs: 10, maxReceiptsPerAccount: 2 });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.listAccounts().map(config => config.credentialRef), [account.credentialRef]);
  reopened.recoverInterrupted(3);
  const session = fakeSession();
  const transport = fakeTransport(new ConversationRouter(reopened, session, { now: () => 8 }));
  assert.equal((await transport.emit('in-flight')).receipt.status, 'unknown');
  assert.deepEqual(await transport.emit('capacity'), { status: 'backpressure', limit: 'receipts' });
  assert.equal((await transport.emit('queued')).requestId, queued.requestId);
  assert.deepEqual(session.seen.map(input => input.message.messageId), ['queued']);

  const later = fakeTransport(new ConversationRouter(reopened, session, { now: () => 100 }));
  assert.equal((await later.emit('in-flight')).receipt.status, 'unknown');
  assert.equal(reopened.getInboundReceipt(queued.requestId), undefined);
  assert.equal((await later.emit('capacity')).status, 'accepted');
  reopened.setAccount({ ...account, enabled: false });
  assert.throws(() => reopened.deleteAccount(account), /unknown outcome/);
});

test('failed state transaction never dispatches and a failed acceptance receipt never resubmits', async t => {
  const store = createStore(t, 'io-failure');
  const raw = new DatabaseSync(store.file);
  t.after(() => raw.close());
  const session = fakeSession();
  const transport = fakeTransport(new ConversationRouter(store, session));
  raw.exec(`CREATE TRIGGER fail_admit BEFORE UPDATE OF last_activity_at ON messaging_bindings
    BEGIN SELECT RAISE(ABORT, 'synthetic reserve failure'); END`);
  assert.deepEqual(await transport.emit('fixture'), { status: 'state-unavailable' });
  assert.equal(session.seen.length, 0);
  assert.equal(store.getBinding(address).lastActivityAt, undefined);
  raw.exec('DROP TRIGGER fail_admit');
  raw.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF turn_id ON messaging_inbox
    BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END`);
  const unknown = await transport.emit('fixture');
  assert.equal(unknown.status, 'unknown');
  assert.equal((await transport.emit('fixture')).status, 'duplicate');
  assert.equal(session.seen.length, 1);
  raw.exec('DROP TRIGGER fail_receipt');
  store.close();
  const reopened = new ConversationStateStore(store.file);
  t.after(() => reopened.close());
  reopened.recoverInterrupted();
  assert.equal(reopened.getInboundReceipt(unknown.requestId).status, 'unknown');
});

test('adapter exceptions have unknown outcomes and never trigger automatic retries', async t => {
  const store = createStore(t, 'unknown-adapter');
  const session = fakeSession(async () => { throw new Error('synthetic failure after possible admission'); });
  const transport = fakeTransport(new ConversationRouter(store, session));
  const unknown = await transport.emit('maybe-accepted');
  assert.equal(unknown.status, 'unknown');
  const duplicate = await transport.emit('maybe-accepted');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.receipt.status, 'unknown');
  assert.equal(duplicate.receipt.requestId, unknown.requestId);
  assert.equal(session.seen.length, 1);
});

test('version and corrupt state fail closed without replacement', t => {
  const store = createStore(t, 'version');
  store.close();
  const raw = new DatabaseSync(store.file);
  raw.exec('PRAGMA user_version=99');
  raw.close();
  for (const [file, content] of [
    [store.file, fs.readFileSync(store.file)],
    [path.join(temp, 'broken.sqlite'), Buffer.from('truncated synthetic database')],
    [path.join(temp, 'zero-byte.sqlite'), Buffer.alloc(0)]
  ]) {
    if (file !== store.file) fs.writeFileSync(file, content);
    assert.throws(() => new ConversationStateStore(file), /could not be opened/);
    assert.deepEqual(fs.readFileSync(file), content);
  }
});

test('account removal is scoped and requires deactivation without in-flight work', async t => {
  const store = createStore(t, 'remove');
  const other = { ...account, botId: 'bot-2' };
  store.setAccount(other);
  store.setBinding({ ...binding, botId: other.botId });
  assert.throws(() => store.setAccount({ ...account, credentialRef: { ...account.credentialRef, id: 'another-ref' } }), /new messaging account/);
  assert.throws(() => store.deleteAccount(account), /Disable/);
  const accepted = await fakeTransport(new ConversationRouter(store, fakeSession())).emit('accepted');
  store.setAccount({ ...account, enabled: false });
  assert.equal(store.deleteAccount(account), true);
  assert.equal(store.getBinding(address), undefined);
  assert.equal(store.getInboundReceipt(accepted.requestId), undefined);
  assert.ok(store.getBinding({ ...address, botId: other.botId }));
  assert.ok(store.getAccount(other));
});

test('independent SQLite writers retain all configuration and admit a shared event once', async t => {
  const store = createStore(t, 'concurrent');
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { ConversationStateStore } = await import(workerData.stateUrl);
      const store = new ConversationStateStore(workerData.file);
      parentPort.once('message', () => {
        try {
          for (let index = 0; index < 10; index++) {
            store.setAccount({ ...workerData.account, botId: workerData.prefix + index });
          }
          const binding = store.getBinding(workerData.event);
          const result = store.reserveInbound(workerData.event, binding, 1);
          store.close();
          parentPort.postMessage(result.status);
        } catch (error) { throw error; }
      });
      parentPort.postMessage('ready');
    })().catch(error => { throw error; });
  `;
  const writers = ['writer-a-', 'writer-b-'].map(prefix => {
    const worker = new Worker(workerSource, { eval: true, workerData: { stateUrl, prefix, file: store.file, account, event: message('race') } });
    t.after(() => worker.terminate());
    const ready = deferred();
    const result = new Promise((resolve, reject) => {
      worker.on('message', value => value === 'ready' ? ready.resolve() : resolve(value));
      worker.once('error', error => { ready.resolve(); reject(error); });
    });
    return { worker, ready: ready.promise, result };
  });
  const results = Promise.all(writers.map(writer => writer.result));
  await Promise.race([Promise.all(writers.map(writer => writer.ready)), results]);
  for (const { worker } of writers) worker.postMessage('write');
  assert.deepEqual((await results).sort(), ['duplicate', 'queued']);
  assert.equal(store.listAccounts().length, 21);
});
