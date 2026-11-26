import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'messaging-boundaries-'));
const submitting = deferred();
const finishSubmission = deferred();
const closingTransport = deferred();
const finishClose = deferred();
let manager;
let store;

try {
  const compile = createSharedCompiler(path.resolve(import.meta.dirname, '..'), temp);
  const load = file => import(pathToFileURL(compile(file)).href);
  const [
    { ChannelRegistry },
    { MessagingChannelManager },
    { ConversationRouter },
    { ConversationStateStore }
  ] = await Promise.all([
    load('main/messaging/channelRegistry.ts'),
    load('main/messaging/manager.ts'),
    load('main/messaging/conversationRouter.ts'),
    load('main/messaging/state/conversationStateStore.ts')
  ]);

  const account = {
    channelKey: 'fixture', botId: 'local-account', enabled: true, displayName: 'Fixture',
    credentialRef: { provider: 'fixture', id: 'credential-reference' }
  };
  const address = { channelKey: account.channelKey, botId: account.botId, conversationId: 'direct-chat' };
  const message = messageId => ({
    ...address, messageId, conversationType: 'direct', senderId: 'allowed-user',
    senderIsBot: false, addressed: true, plainText: 'fixture input'
  });

  store = new ConversationStateStore(path.join(temp, 'messages.sqlite'));
  store.setAccount(account);
  store.setBinding({
    ...address, workspaceId: 'workspace', sessionId: 'session',
    access: { direct: 'allowlist', group: 'off', allowedSenderIds: ['allowed-user'] }
  });
  const submitted = [];
  const router = new ConversationRouter(store, {
    async submit(input) {
      submitted.push(input.origin.messageId);
      if (input.origin.messageId === 'in-flight') {
        submitting.resolve();
        await finishSubmission.promise;
      }
      return { status: 'accepted', turnId: 'turn-' + input.origin.messageId };
    }
  });
  const registry = new ChannelRegistry();
  let receive;
  registry.register({
    descriptor: {
      channelKey: account.channelKey, displayName: 'Fixture', connection: 'polling',
      inbound: ['text'], outbound: [], limits: {},
      defaultTriggers: { direct: 'allowlist', group: 'off' }
    },
    createConnection(_account, context) {
      receive = context.receive;
      return {
        start() {},
        async close() {
          closingTransport.resolve();
          await finishClose.promise;
        }
      };
    }
  });
  manager = new MessagingChannelManager(registry, router);
  manager.registerAccount(account);
  manager.start();
  await manager.startAccount(account);

  const first = receive(message('in-flight'));
  await submitting.promise;
  const queued = receive(message('queued'));

  // Runtime Kernel stops admission before closing the Session domains.
  manager.stopAdmission();
  assert.equal((await receive(message('after-admission-closed'))).status, 'not-admitted');
  let stopped = false;
  const stopping = manager.stopAndWait().then(() => { stopped = true; });
  let closeRequested = false;
  void closingTransport.promise.then(() => { closeRequested = true; });
  await tick();
  assert.equal(closeRequested, false, 'transport stays available while an admitted Session receipt is pending');
  assert.deepEqual(submitted, ['in-flight']);

  finishSubmission.resolve();
  const [firstReceipt, queuedReceipt] = await Promise.all([first, queued]);
  assert.equal(firstReceipt.status, 'accepted');
  assert.equal(store.getInboundReceipt(firstReceipt.requestId)?.status, 'accepted');
  assert.equal(queuedReceipt.status, 'retryable', 'a queued message with no Session call is safe to redeliver');
  assert.equal(store.getInboundReceipt(queuedReceipt.requestId)?.status, 'retryable');
  assert.deepEqual(submitted, ['in-flight'], 'stopping admission prevents queued work from starting a Session');

  await closingTransport.promise;
  assert.equal(stopped, false, 'shutdown waits for the transport to release its resources');
  finishClose.resolve();
  await stopping;
  assert.equal(manager.snapshot().accounts[0]?.state, 'stopped');
  assert.equal((await receive(message('stale-callback'))).status, 'not-admitted');
  assert.deepEqual(submitted, ['in-flight']);
  console.log('messaging boundaries: stop admission, finish accepted work, preserve queued work and wait for transport close');
} finally {
  finishSubmission.resolve();
  finishClose.resolve();
  await manager?.stopAndWait().catch(() => {});
  store?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
