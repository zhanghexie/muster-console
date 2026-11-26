import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { logicalDeliveryDraft } from '../src/main/messaging/dsh-im/logical-delivery.mjs';
import { createDeliveryService } from '../src/main/messaging/dsh-im/adapters/host/delivery-service.mjs';
import { toPublicFeishuStatus } from '../src/main/messaging/dsh-im/adapters/host/channels/feishu/rpc.mjs';
import { EmailChannelBridge } from '../src/main/messaging/dsh-im/src/channels/email/email-bridge.mjs';
import { EmailController } from '../src/main/messaging/dsh-im/src/channels/email/email-controller.mjs';
import { EmailRuntime, normalizeEmail } from '../src/main/messaging/dsh-im/src/channels/email/email-runtime.mjs';
import { createAgentMailTransportForTests } from '../src/main/messaging/dsh-im/src/channels/email/transports/agent-mail.mjs';
import { ImapSmtpTransport } from '../src/main/messaging/dsh-im/src/channels/email/transports/imap-smtp.mjs';
import { FeishuRuntime } from '../src/main/messaging/dsh-im/src/channels/feishu/feishu-runtime.mjs';
import { getImHostLanguage, setImHostLanguage } from '../src/main/messaging/dsh-im/src/channels/shared/i18n.mjs';
import { patchLarkSdkHandshakeSource } from '../src/main/messaging/dsh-im/adapters/host/lark-sdk-handshake-patch.mjs';
import { WeixinRuntime } from '../src/main/messaging/dsh-im/src/channels/weixin/weixin-runtime.mjs';
import { WeixinStateStore } from '../src/main/messaging/dsh-im/src/channels/weixin/state-store.mjs';

const source = (provider, conversationId, conversationType = 'direct', threadId) =>
  ({ provider, botId: 'fixture-account', conversationId, conversationType, ...(threadId && { threadId }) });
const quiet = { info() {}, warn() {}, error() {} };

test('maps discovered native identities to all 13 account-scoped transport routes', () => {
  const routes = [
    [source('feishu', 'oc_dm'), { kind: 'group', route: { chatId: 'oc_dm' } }],
    [source('weixin', 'fixture@im.wechat'), { kind: 'user', route: { toUserId: 'fixture@im.wechat' } }],
    [source('dingtalk', 'p2p:staff-one'), { kind: 'user', route: { userId: 'staff-one' } }],
    [source('wecom', 'room-one', 'group'), { kind: 'group', route: { chatId: 'room-one' } }],
    [source('wecom-app', 'staff-one'), { kind: 'user', route: { chatId: 'staff-one' } }],
    [source('qq', 'group:fixture-openid', 'group'), { kind: 'group', route: { groupOpenId: 'fixture-openid' } }],
    [source('slack', 'C1', 'group', '1726433323.000100'), { kind: 'thread', route: { channelId: 'C1', threadTs: '1726433323.000100' } }],
    [source('telegram', '-1007', 'group', '57'), { kind: 'topic', route: { chatId: '-1007', messageThreadId: 57 } }],
    [source('discord', '925368', 'group', '925368'), { kind: 'channel', route: { channelId: '925368' } }],
    [source('whatsapp', '1234567890@s.whatsapp.net'), { kind: 'user', route: { jid: '1234567890@s.whatsapp.net' } }],
    [source('imessage', 'iMessage;-;fixture@example.test'), { kind: 'user', route: { chatGuid: 'iMessage;-;fixture@example.test' } }],
    [source('matrix', '!Fixture:example.test', 'group', '$anchor'), { kind: 'thread', route: { roomId: '!Fixture:example.test', threadId: '$anchor' } }],
    [source('email', 'reader@example.test'), { kind: 'user', route: { address: 'reader@example.test' } }],
  ];
  for (const [input, expected] of routes) assert.deepEqual(logicalDeliveryDraft(input, { text: 'fixture' }).draft, expected, input.provider);
});

test('preserves the selected thread or native reply without treating new mail as a reply', () => {
  const thread = source('feishu', 'oc_fixture', 'group', 'omt_fixture');
  assert.throws(() => logicalDeliveryDraft(thread, { text: 'fixture' }), { code: 'thread-unavailable' });
  assert.deepEqual(logicalDeliveryDraft(thread, { text: 'fixture', nativeMessageId: 'om_fixture' }).options,
    { logical: true, nativeMessageId: 'om_fixture', replyInThread: true });
  assert.throws(() => logicalDeliveryDraft(source('discord', '123', 'group', '456'), { text: 'fixture' }), { code: 'thread-unavailable' });

  const message = { text: 'fixture', nativeMessageId: '1.123' };
  const slack = source('slack', 'C1', 'group');
  assert.equal(logicalDeliveryDraft(slack, message).draft.kind, 'conversation');
  assert.deepEqual(logicalDeliveryDraft(slack, { ...message, reply: true }).draft.route, { channelId: 'C1', threadTs: '1.123' });
  assert.equal(logicalDeliveryDraft(source('telegram', '-1007', 'group'), { ...message, nativeMessageId: '57', reply: true }).options.nativeMessageId, 57);

  const mail = source('email', 'reader@example.test');
  const draft = { text: 'fixture', subject: 'Chosen subject', nativeMessageId: '<parent@example.test>' };
  assert.deepEqual(logicalDeliveryDraft(mail, draft).options, { logical: true, subject: 'Chosen subject' });
  assert.deepEqual(logicalDeliveryDraft(mail, { ...draft, reply: true }).options,
    { logical: true, nativeMessageId: '<parent@example.test>', subject: 'Chosen subject' });
  assert.throws(() => logicalDeliveryDraft(mail, { text: 'fixture', subject: 'line\r\nbreak' }), { code: 'invalid-target' });
  assert.throws(() => logicalDeliveryDraft(source('email', 'alias,reader@example.test'), draft), { code: 'invalid-target' });
  assert.throws(() => logicalDeliveryDraft(source('email', 'list:reader@example.test;'), draft), { code: 'invalid-target' });
});

test('revocation between Agent Mail preview and confirmation prevents the external send', async () => {
  const controller = new AbortController();
  const calls = [];
  const transport = createAgentMailTransportForTests({
    config: { address: 'fixture@example.test' },
    async runCliImpl(args, { signal }) {
      assert.equal(signal, controller.signal);
      if (args[0] === 'auth') return { document: { data: { logged_in: true } } };
      calls.push(args);
      controller.abort();
      return { document: { data: { confirmation_token: 'fixture-confirmation' } } };
    },
  });
  await assert.rejects(transport.sendText({ to: 'reader@example.test', subject: 'Fixture', text: 'payload', signal: controller.signal }),
    { name: 'AbortError' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('--confirmation-token'), false);
});

test('SMTP refuses a revoked source before opening the message send', async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = new ImapSmtpTransport({ config: { address: 'fixture@example.test', password: 'fixture', smtpHost: '127.0.0.1', smtpPort: 1 } });
  await assert.rejects(transport.sendText({ to: 'reader@example.test', text: 'payload', logical: true, signal: controller.signal }),
    { name: 'AbortError' });
});

test('mailbox setup rejects an already-owned IMAP inbox before probing or saving credentials', async () => {
  const unreachable = () => { throw new Error('conflicting mailbox must not write or probe'); };
  const controller = new EmailController({
    credentials: { resolve: unreachable, set: unreachable, unset: unreachable },
    configStore: { list: () => [], save: unreachable, remove: unreachable, get: botId => ({
      botId, platformId: 'box@example.test', provider: 'custom', imapHost: 'old.example.test', imapPort: 993,
    }) },
    createRuntime: unreachable, logger: quiet,
    async claimImapConsumer(mailbox, owner) {
      assert.deepEqual(mailbox, { imapHost: 'imap.qq.com', imapPort: 993, user: 'box@example.test', mailbox: 'INBOX' });
      assert.match(owner, /^dsh:/);
      throw Object.assign(new Error('fixture mailbox already claimed'), { code: 'imap-mailbox-in-use' });
    },
  });
  await assert.rejects(controller.bindMailbox({ address: 'Box@example.test', password: 'fixture', provider: 'qq' }),
    { code: 'imap-mailbox-in-use' });
  await assert.rejects(controller.updateMailboxSettings('dsh:fixture', { imapHost: 'imap.qq.com' }),
    { code: 'imap-mailbox-in-use' });
});

test('an IMAP runtime retains ownership until shutdown succeeds', async () => {
  const disconnect = Promise.withResolvers();
  let held = false;
  let disconnects = 0;
  let tipReads = 0;
  const runtime = new EmailRuntime({
    config: { botId: 'fixture-mail', platformId: 'box@example.test', imapHost: 'imap.example.test', imapPort: 993 },
    async receiveChannelMessage() {}, state: { cursor: () => null, async setCursor() {} }, logger: quiet,
    createTransport: () => ({
      async latestUid() { assert.equal(held, true); tipReads++; return 1; },
      async disconnect() { if (++disconnects === 1) await disconnect.promise; },
    }),
    async claimImapConsumer(mailbox, owner) {
      assert.deepEqual(mailbox, { imapHost: 'imap.example.test', imapPort: 993, user: 'box@example.test', mailbox: 'INBOX' });
      assert.equal(owner, 'dsh:fixture-mail');
      held = true;
      return () => { held = false; };
    },
  });
  try {
    await runtime.start();
    assert.equal(tipReads, 1);
    const stopped = assert.rejects(runtime.stop(), /fixture disconnect failure/);
    assert.equal(held, true);
    disconnect.reject(new Error('fixture disconnect failure'));
    await stopped;
    assert.equal(held, true);
    await runtime.stop();
    assert.equal(held, false);
  } finally {
    disconnect.resolve();
    await runtime.stop();
  }
});

test('a rejected mailbox selection waits for raw transport close even after the IMAP client reports closed', async t => {
  const accepted = new Set();
  const listener = createServer(socket => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(async () => {
    for (const socket of accepted) socket.destroy();
    await new Promise(resolve => listener.close(resolve));
  });
  let rawClosed = false;
  const transport = new ImapSmtpTransport({
    config: { address: 'box@example.test', password: 'fixture', imapHost: '127.0.0.1', imapPort: listener.address().port },
    createImapClient(options) {
      const client = new EventEmitter();
      client.connect = async () => {
        const socket = options.transport.connect({ host: options.host, port: options.port, secure: false });
        socket.once('close', () => { rawClosed = true; });
        await once(socket, 'connect');
      };
      client.mailboxOpen = async () => { client.emit('close'); return false; };
      client.close = () => client.emit('close');
      return client;
    },
  });
  await assert.rejects(transport.connect(), /did not open the configured mailbox/);
  assert.equal(rawClosed, true);
});

test('Feishu retains the physical account claim until its socket confirms shutdown', async () => {
  const firstClose = Promise.withResolvers();
  let currentOwner;
  let socketStarts = 0;
  let closeAttempts = 0;
  const lark = {
    Domain: { Feishu: 'fixture' }, LoggerLevel: { info: 'info' },
    Client: class {}, EventDispatcher: class { register() { return this; } },
    WSClient: class {
      constructor({ onReady }) { this.onReady = onReady; }
      async start() { socketStarts++; this.onReady(); }
      async closeAndWait() {
        if (++closeAttempts === 1) await firstClose.promise;
      }
    },
  };
  const runtimeFor = owner => new FeishuRuntime({
    lark, appId: 'cli_fixture_account', appSecret: 'fixture', ownerOpenId: '*', consumerMode: 'external-consumer',
    async receiveChannelMessage() {}, state: {}, logger: quiet,
    claimConsumer() {
      if (currentOwner) throw Object.assign(new Error('duplicate Feishu consumer'), { code: 'feishu-account-in-use' });
      currentOwner = owner;
      return () => { currentOwner = null; };
    },
  });
  const first = runtimeFor('first');
  const second = runtimeFor('second');
  try {
    await first.start();
    await assert.rejects(second.start(), { code: 'feishu-account-in-use' });
    const stopping = first.stop();
    const expectedFailure = assert.rejects(stopping, /socket never confirmed/);
    await assert.rejects(second.start(), { code: 'feishu-account-in-use' });
    firstClose.reject(new Error('socket never confirmed'));
    await expectedFailure;
    assert.equal(currentOwner, 'first');
    assert.equal(socketStarts, 1);
    await first.stop();
    await second.start();
    assert.equal(currentOwner, 'second');
    assert.equal(socketStarts, 2);
  } finally {
    firstClose.resolve();
    await first.stop();
    await second.stop();
  }
});

test('the bundled Lark SDK tracks pending and reconnect sockets before releasing Feishu ownership', async () => {
  const require = createRequire(import.meta.url);
  const sdkDirectory = path.dirname(require.resolve('@larksuiteoapi/node-sdk/package.json'));
  for (const variant of ['lib', 'es']) {
    const file = path.join(sdkDirectory, variant, 'index.js');
    const transformed = patchLarkSdkHandshakeSource(await readFile(file, 'utf8'), file);
    assert.match(transformed, /this\.musterOpenSockets\.add\(wsInstance\)/);
    assert.match(transformed, /async closeAndWait\(params = \{\}\)/);
    assert.match(transformed, /socket\.once\('close', closed\)/);
  }
});

test('Feishu settings expose a translated duplicate connection error without leaking provider details', async () => {
  const previousLanguage = getImHostLanguage();
  const error = { code: 'feishu-account-in-use', message: 'untrusted-value', details: { reason: 'feishu-account-in-use' } };
  const fixture = { configured: true, error, bots: [{ botId: 'fixture-bot', configured: true, error }] };
  try {
    setImHostLanguage('en');
    const english = await toPublicFeishuStatus(fixture);
    assert.equal(english.error.code, error.code);
    assert.match(english.error.message, /Reuse that connection or disconnect it/);
    assert.equal(english.bots[0].error.message, english.error.message);
    assert.doesNotMatch(JSON.stringify(english), /untrusted-value/);
    setImHostLanguage('zh');
    const chinese = await toPublicFeishuStatus(fixture);
    assert.match(chinese.error.message, /复用现有连接/);
  } finally {
    setImHostLanguage(previousLanguage);
  }
});

test('sends through the selected provider when another provider also has the same bot ID', async () => {
  const delivery = createDeliveryService();
  const calls = [];
  const adapter = channel => ({ channel,
    ownsBot: id => id === 'fixture-account', listBots: () => ['fixture-account'],
    listTargets: () => [], listSuggestions: () => [], createTarget() {}, updateTarget() {}, deleteTarget() {},
    sendText(id, target, text, options) { calls.push({ channel, id, target, text, options }); },
  });
  delivery.registerAdapter(adapter('feishu'));
  const dispose = delivery.registerAdapter(adapter('weixin'));
  const selected = source('weixin', 'fixture@im.wechat');
  const { draft, options } = logicalDeliveryDraft(selected, { text: 'fixture' });
  const controller = new AbortController();
  await delivery.sendLogicalText(selected.provider, selected.botId, draft, 'fixture', { ...options, signal: controller.signal });
  assert.deepEqual(calls.map(({ channel, target }) => [channel, target.route]), [['weixin', { toUserId: 'fixture@im.wechat' }]]);
  dispose();
  assert.equal(calls[0].options.signal.aborted, true);
  await assert.rejects(delivery.sendLogicalText('weixin', selected.botId, draft, 'fixture'), { code: 'provider-unavailable' });
  assert.equal(calls.length, 1);
});

test('reopens the persisted WeChat reply context for a direct Channel send', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'muster-channel-delivery-'));
  const file = path.join(dir, 'state.json');
  const token = 'fixture-token';
  const userId = 'fixture@im.wechat';
  const captured = [];
  let runtime;
  try {
    const observed = await new WeixinStateStore(file).load();
    await observed.bindContextTokens(token);
    await observed.rememberContextToken({ userId, contextToken: 'fixture-conversation-context', seq: 1 });
    runtime = new WeixinRuntime({
      state: await new WeixinStateStore(file).load(), async receiveChannelMessage() {}, token, logger: quiet,
      config: { botId: 'fixture-account', baseUrl: 'https://example.test/', ownerUserId: userId },
      api: {
        async notifyStart() {}, async notifyStop() {},
        getUpdates: ({ signal }) => setTimeout(300_000, undefined, { signal }),
        async sendText(payload) { captured.push(payload); return { providerMessageIds: ['fixture-send'] }; },
      },
    });
    await runtime.start();
    const { draft, options } = logicalDeliveryDraft(source('weixin', userId), { text: 'fixture' });
    await runtime.sendProactiveText(draft, 'fixture', options);
    assert.equal(captured[0].contextToken, 'fixture-conversation-context');
    assert.equal(captured[0].toUserId, userId);
    await assert.rejects(runtime.sendProactiveText({ kind: 'user', route: { toUserId: 'unknown' } }, 'fixture', options),
      { code: 'delivery-context-unavailable' });
    assert.equal(captured.length, 1);
  } finally {
    await runtime?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('passes mail body, subject and native reply identity to the inbox without replying automatically', async () => {
  const events = [];
  const bridge = new EmailChannelBridge({
    useTransportMessageId: true,
    async receiveChannelMessage(input) { events.push(input); },
    state: { hasSeen: () => false }, logger: quiet,
    bot: { async sendText() { assert.fail('inbox ingest must not send a reply'); } },
  });
  await bridge.accept(normalizeEmail({
    messageId: '<fixture@example.test>', uid: 'mailbox-message-1', headers: new Map(),
    from: { value: [{ address: 'reader@example.test' }] }, subject: 'New mail', text: 'fixture message',
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].conversationId, 'reader@example.test');
  assert.equal(events[0].messageId, '<fixture@example.test>');
  assert.equal(events[0].nativeMessageId, 'mailbox-message-1');
  assert.equal(events[0].subject, 'New mail');
  assert.equal(events[0].text, 'fixture message');
});
