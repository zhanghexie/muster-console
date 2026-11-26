import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { BotWorkspaceStore, createAccountIngress } from '../src/main/messaging/dsh-im/src/channels/shared/bot-workspace-store.mjs';
import { connectionTestTarget } from '../src/main/messaging/dsh-im/src/channels/shared/connection-test.mjs';
import { accessPolicyProvider, initialAccessPolicyFor } from '../src/main/messaging/dsh-im/adapters/host/channels/shared/access-policy-production.mjs';
import { WeixinRuntime } from '../src/main/messaging/dsh-im/src/channels/weixin/weixin-runtime.mjs';
import { WeixinStateStore } from '../src/main/messaging/dsh-im/src/channels/weixin/state-store.mjs';
import { EmailChannelBridge } from '../src/main/messaging/dsh-im/src/channels/email/email-bridge.mjs';
import { normalizeEmail } from '../src/main/messaging/dsh-im/src/channels/email/email-runtime.mjs';
import { SlackChannelBridge } from '../src/main/messaging/dsh-im/src/channels/slack/slack-bridge.mjs';
import { normalizeSlackEvent } from '../src/main/messaging/dsh-im/src/channels/slack/slack-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-messaging-remote-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const compile = createSharedCompiler(root, path.join(temp, 'compiled'));
const { MessagingHost } = await import(pathToFileURL(compile('main/messaging/messagingHost.ts')).href);
const { RemoteBindingService } = await import(pathToFileURL(compile('main/messaging/remoteBindingService.ts')).href);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const quiet = { error() {}, warn() {}, info() {} };
async function until(predicate) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await setTimeout(1);
  }
  throw new Error('Fixture did not settle');
}

test('iLink poll delivers binding guidance before the old empty ACL and replies through the original sender', async () => {
  const botId = 'weixin-fixture';
  const workspaces = await new BotWorkspaceStore(path.join(temp, 'workspaces.json'), { defaultWorkspace: temp }).load();
  await workspaces.ensure(botId, { initialAccessPolicy: initialAccessPolicyFor('weixin') });
  const state = await new WeixinStateStore(path.join(temp, 'weixin.json')).load();
  const finishBindingContextWrite = deferred();
  const rememberContextToken = state.rememberContextToken.bind(state);
  state.rememberContextToken = (input) => {
    const written = rememberContextToken(input);
    return input.contextToken === 'context-101' ? written.then(() => finishBindingContextWrite.promise) : written;
  };
  const deliveries = [];
  const images = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvOQAAAAASUVORK5CYII=', 'base64');
  const screenshot = path.join(temp, 'fixture-screenshot.png');
  fs.writeFileSync(screenshot, png);
  const inputs = [];
  const forwarded = [];
  const completed = new Set();
  const finishFirstLongChunk = deferred();
  const binding = new RemoteBindingService({
    file: path.join(temp, 'weixin-bindings.json'),
    async dispatch(input) {
      forwarded.push(input);
      return {
        text: input.text === '/long' ? '回'.repeat(4_000) : '工作台回执',
        image: { filePath: screenshot, mimeType: 'image/png' },
      };
    },
  });
  const sender = 'attested-sender';
  const scope = { id: 'fixture-weixin-source', source: {
    provider: 'weixin', botId, conversationId: sender, conversationType: 'direct',
  } };
  const receiveChannelMessage = createAccountIngress(async (input, reply) => {
    const event = { channelKey: 'weixin', ...input };
    inputs.push(event);
    try {
      const result = await binding.handle({ ...event, deliver: reply }, scope);
      if (result.text || result.image) await reply(result);
    } finally { completed.add(input.messageId); }
  }, { botId, workspaces });
  const polls = [];
  const runtime = new WeixinRuntime({
    receiveChannelMessage, state,
    accessPolicy: accessPolicyProvider(workspaces, botId),
    config: { botId, baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: sender },
    token: 'synthetic-token', logger: quiet,
    api: {
      async notifyStart() {},
      async notifyStop() {},
      getUpdates({ signal }) {
        const batch = deferred();
        polls.push(batch);
        return new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          const aborted = () => reject(signal.reason);
          signal.addEventListener('abort', aborted, { once: true });
          void batch.promise.then(result => {
            signal.removeEventListener('abort', aborted);
            resolve(result);
          });
        });
      },
      async sendText(envelope) {
        deliveries.push(envelope);
        if (envelope.contextToken === 'context-103') await finishFirstLongChunk.promise;
        return {};
      },
      async sendImage(envelope) { images.push(envelope); return {}; },
    },
  });
  try {
    await runtime.start();
    assert.equal(runtime.status.ready, true);
    const incoming = (sequence, text, withContext = true) => ({
      message_id: sequence, seq: sequence, message_type: 1, from_user_id: sender,
      ...(withContext && { context_token: `context-${sequence}` }),
      item_list: [{ type: 1, text_item: { text } }],
    });
    let batchIndex = 0;
    async function queueBatch(...msgs) {
      const index = batchIndex++;
      await until(() => polls.length > index);
      polls[index].resolve({
        msgs,
        get_updates_buf: `cursor-${index}`,
      });
    }
    async function assertDelivery(sequence, text, reply, expectedToken = `context-${sequence}`) {
      const index = sequence - 100;
      await until(() => deliveries.length > index);
      const out = deliveries[index];
      assert.equal(out.toUserId, sender);
      assert.equal(out.contextToken, expectedToken);
      assert.match(out.text, reply);
      assert.deepEqual({ ...inputs[index], signal: undefined }, {
        channelKey: 'weixin', botId, conversationId: sender, conversationType: 'direct', senderId: sender,
        addressed: true, senderIsBot: false, messageId: String(sequence), text, signal: undefined,
      });
    }
    async function deliver(sequence, text, reply) {
      await queueBatch(incoming(sequence, text));
      await assertDelivery(sequence, text, reply);
    }
    await deliver(100, '你好', /为此来源启用远程输入/);
    assert.equal(forwarded.length, 0);
    assert.equal(images.length, 0);
    assert.deepEqual(connectionTestTarget(state), { toUserId: sender });
    const code = binding.manageScope(scope, 'remote.begin').binding.code;
    assert.match(code, /^\d{6}$/);
    const task = '请处理同批次任务';
    await queueBatch(incoming(101, code), incoming(102, task, false));
    await until(() => inputs.some(input => input.messageId === '102'));
    assert.deepEqual(inputs.slice(1).map(input => input.messageId), ['101', '102']);
    await assertDelivery(101, code, /绑定成功/);
    await assertDelivery(102, task, /工作台回执/, 'context-101');
    finishBindingContextWrite.resolve();
    assert.equal(binding.manageScope(scope, 'remote.status').binding, null);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].senderId, sender);
    assert.equal(forwarded[0].text, task);
    await until(() => images.length === 1);
    assert.equal(images[0].toUserId, sender);
    assert.equal(images[0].contextToken, 'context-101');
    assert.equal(images[0].file.mediaType, 'image/png');
    assert.deepEqual(images[0].file.bytes, png);

    await deliver(103, '/long', /回/);
    const activeSend = deliveries.at(-1);
    assert.equal(activeSend.signal.aborted, false);
    const [{ id: bindingId }] = binding.manageScope(scope, 'remote.status').boundUsers;
    binding.manageScope(scope, 'remote.revoke', bindingId);
    assert.equal(activeSend.signal.aborted, true);
    finishFirstLongChunk.resolve();
    await until(() => completed.has('103'));
    assert.equal(deliveries.length, 4, 'revocation must prevent subsequent outbound chunks');
    assert.equal(images.length, 1, 'revocation must prevent the queued screenshot');
  } finally {
    binding.stopAdmission();
    finishBindingContextWrite.resolve();
    finishFirstLongChunk.resolve();
    await runtime.stop();
  }
});

test('account incarnation changes reject stale receives and replies', async () => {
  let incarnation = 1;
  const workspaces = { has: () => true, incarnationFor: () => incarnation };
  const received = [];
  const replies = [];
  const receive = createAccountIngress(async (input, reply) => {
    received.push({ input, reply });
  }, { botId: 'account', workspaces });

  await receive({ text: 'before removal' }, reply => replies.push(reply));
  assert.equal(received[0].input.botId, 'account');
  incarnation++;
  await receive({ text: 'after removal' }, reply => replies.push(reply));
  await received[0].reply({ text: 'stale reply' });
  assert.equal(received.length, 1);
  assert.deepEqual(replies, []);
});

test('mail auth assertions reach the Channel inbox as mail without authorizing a Workbench sender', async () => {
  const scope = { id: 'mail-source', source: {
    provider: 'email', botId: 'mail-account', conversationId: 'address@example.test', conversationType: 'direct',
  } };
  const bindings = new RemoteBindingService({
    file: path.join(temp, 'mail-bindings.json'),
    async dispatch() { assert.fail('An email may not authorize a Workbench sender'); },
  });
  const received = [];
  const bridge = new EmailChannelBridge({
    async receiveChannelMessage(input) {
      received.push(input);
      assert.equal(bindings.intent({ ...input, botId: scope.source.botId, channelKey: 'email' }, scope), 'none');
    },
    state: { hasSeen: () => false },
    bot: { async sendText() { assert.fail('Inbox ingestion does not send a reply'); } },
  });
  await bridge.accept(normalizeEmail({
    messageId: '<fixture@example.test>',
    from: { value: [{ address: 'address@example.test' }] },
    headers: new Map([['authentication-results', 'trusted.test; dkim=pass header.d=example.test']]),
    subject: 'Status',
    text: '/status',
  }));
  assert.equal(received[0].conversationId, scope.source.conversationId);
  assert.equal(received[0].subject, 'Status');
});

test('Slack distinguishes a real inbound thread from the SDK reply anchor', async () => {
  const events = [];
  const replies = [];
  const bridge = new SlackChannelBridge({
    async receiveChannelMessage(event, reply) {
      events.push(event);
      if (event.addressed) await reply({ text: 'response' });
    },
    state: { hasSeen: () => false },
    bot: { async sendText(target) { replies.push(target.threadTs); } },
    logger: quiet,
  });
  const inbound = (ts, extra) => normalizeSlackEvent({
    event_id: `event-${ts}`,
    event: { type: 'message', user: 'user', channel: 'dm', channel_type: 'im', ts, text: 'hello', ...extra },
  }, 'bot');
  await bridge.accept(inbound('1.100'));
  await bridge.accept(inbound('1.200'));
  await bridge.accept(inbound('1.300', { thread_ts: '1.200' }));
  await bridge.accept(inbound('2.100', { channel: 'group', channel_type: 'channel' }));
  assert.deepEqual(events.map(({ conversationId, threadId }) => ({ conversationId, threadId })), [
    { conversationId: 'dm', threadId: undefined },
    { conversationId: 'dm', threadId: undefined },
    { conversationId: 'dm', threadId: '1.200' },
    { conversationId: 'group', threadId: undefined },
  ]);
  assert.equal(events.at(-1).addressed, false);
  assert.deepEqual(replies, ['1.100', '1.200', '1.200']);
});

test('desktop account management rejects legacy settings and preserves removal and reply barriers', async () => {
  const forwarded = [];
  const removed = [];
  const sends = [];
  const remoteSend = deferred();
  const pending = deferred();
  let providerRelease = false;
  const host = new MessagingHost({
    dataDir: path.join(temp, 'managed'),
    credentials: { async resolve() {}, async describe() { return { configured: false }; }, async set() {}, async unset() {} },
    async handleRemote({ onProgress }) {
      pending.resolve();
      await onProgress('accepted');
      await onProgress('duplicate progress');
      return { text: 'response' };
    },
    async beforeAccountRemoval(channel, botId) {
      if (botId === 'fails') throw new Error('synthetic revocation failure');
      removed.push({ channel, botId });
      forwarded.push('revoke');
    },
    runtimeLoader: async () => ({
      createRuntime: () => ({ async install(channel, ctx, configs) {
        if (!['weixin', 'email'].includes(channel)) return;
        ctx.effect(() => () => { providerRelease = true; });
        if (channel === 'weixin') forwarded.push(configs.dispatchRemote);
        return ctx.registerChannel(channel, async method => {
          forwarded.push(method);
          return { ok: true, value: {} };
        });
      } })
    }),
  });
  host.start();
  await until(() => host.status().state === 'ready');
  const payload = { botId: 'account' };
  assert.equal((await host.invoke('weixin', 'bot.workspace.set', payload)).error.code, 'remote-managed-by-workbench');
  assert.equal((await host.invoke('weixin', 'bot.thinking-traces.set', payload)).error.code, 'remote-managed-by-workbench');
  assert.equal((await host.invoke('dsh-im-delivery-sync', 'settings.delivery-sync.set')).error.code, 'unknown-channel');
  assert.equal((await host.invoke('email', 'remote.begin', payload)).error.code, 'remote-managed-by-workbench');
  assert.equal((await host.invoke('weixin', 'remote.begin', payload)).error.code, 'remote-managed-by-workbench');
  await host.invoke('weixin', 'bot.delete', { ...payload, confirm: true });
  await host.invoke('weixin', 'bot.delete', { botId: 'account:scope@example.test', confirm: true });
  assert.equal((await host.invoke('weixin', 'bot.delete', { botId: 'fails', confirm: true })).error.code, 'remote-binding-revocation-failed');
  assert.equal((await host.invoke('weixin', 'bot.delete', payload)).error.code, 'invalid-remote-account-removal');
  assert.equal((await host.invoke('weixin', 'bot.delete', { botId: '\0', confirm: true })).error.code, 'invalid-remote-account-removal');
  assert.equal((await host.invoke('weixin', 'bot.remove', { ...payload, confirm: true })).error.code, 'invalid-remote-account-removal');
  assert.deepEqual(removed, [{ channel: 'weixin', botId: 'account' }, { channel: 'weixin', botId: 'account:scope@example.test' }]);
  assert.deepEqual(forwarded.slice(1), ['revoke', 'bot.delete', 'revoke', 'bot.delete']);

  const reply = forwarded[0]({ channelKey: 'weixin' }, async ({ text }) => {
    sends.push(text);
    await remoteSend.promise;
  });
  await pending.promise;
  const closing = host.stopAndWait();
  await setImmediate();
  assert.equal(providerRelease, false, 'a platform stays available while its accepted reply is sending');
  remoteSend.resolve();
  await Promise.all([reply, closing]);
  assert.equal(providerRelease, true);
  assert.deepEqual(sends, ['accepted', 'response']);
});
