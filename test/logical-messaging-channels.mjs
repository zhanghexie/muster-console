import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const previous = require.extensions['.ts'];
let LogicalChannelService;
let RemoteBindingService;
try {
  require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file
  }).outputText, file);
  ({ LogicalChannelService } = require('../src/main/messaging/logicalChannelService.ts'));
  ({ RemoteBindingService } = require('../src/main/messaging/remoteBindingService.ts'));
} finally {
  if (previous) require.extensions['.ts'] = previous;
  else delete require.extensions['.ts'];
}

function fixtures(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-logical-channels-'));
  const file = path.join(root, 'channels.sqlite');
  const bindingFile = path.join(root, 'bindings.json');
  const dispatches = [];
  const sends = [];
  const services = [];
  const dispatch = extra.dispatch ?? (async (input, scope) => {
    dispatches.push({ text: input.text, scope, authorizationId: input.authorizationId });
    return { text: `Workbench: ${input.text}` };
  });
  function open() {
    const binding = new RemoteBindingService({ file: bindingFile, dispatch });
    const service = new LogicalChannelService({
      file,
      workspaceExists: ws => ws === 'one' || ws === 'two',
      workspaceIds: () => ['one', 'two'],
      connected: extra.connected ?? (async () => true),
      send: async (address, message, signal) => {
        sends.push({ address, message });
        if (extra.send) await extra.send(address, message, signal);
      },
      legacy: extra.legacy,
      now: extra.now ?? (() => 1000),
      remote: {
        intent: (input, scope) => binding.intent(input, scope),
        isPairingSecret: text => binding.isPairingSecret(text),
        handle: (input, scope) => binding.handle(input, scope),
        manage: (scope, method, bindingId) => binding.manageScope(scope, method, bindingId),
        revoke: scope => binding.revokeScope(scope)
      }
    });
    services.push(service);
    return service;
  }
  t.after(async () => {
    await Promise.all(services.map(service => service.stopAndWait()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = open();
  return { file, service, open, dispatches, sends };
}

function message(messageId, text, override = {}) {
  return { channelKey: 'telegram', botId: 'linked-bot', conversationId: '-10044', threadId: '11',
    senderId: 'sender', senderIsBot: false, conversationType: 'group', addressed: true, messageId, text, ...override };
}

async function rpc(service, method, data = {}) {
  const result = await service.invoke(method, data, new AbortController().signal);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

async function attach(service, source, extra = {}, ws = 'one') {
  const channel = await rpc(service, 'create', { name: `Channel ${ws}` });
  await rpc(service, 'bindings.add', { workspaceId: ws, channelId: channel.id });
  return rpc(service, 'sources.add', { channelId: channel.id, sourceId: source.id, permission: 'reply', ...extra });
}

test('discovers trusted native sources, commits a scoped inbox, and addresses replies to the original thread', async t => {
  const { service, sends, open } = fixtures(t);
  await service.receive(message('unaddressed', 'ignore discovery', { addressed: false }));
  await service.receive(message('bot-echo', 'own bot output', { senderIsBot: true }));
  assert.deepEqual(await rpc(service, 'sources.list'), []);
  assert.deepEqual(await service.receive(message('seen', 'discover')), { text: '' });
  const [source] = await rpc(service, 'sources.list');
  assert.equal(source.provider, 'telegram');
  assert.equal(source.threadId, '11');
  const channel = await attach(service, source);
  const mirror = await attach(service, source, { notify: 'wake' });
  const other = await attach(service, source, {}, 'two');
  const incoming = message('event-1', 'received text', { addressed: false, nativeMessageId: '42', senderLabel: 'Customer' });
  await service.receive(incoming);
  await service.receive(incoming);
  await service.receive(message('other-thread', 'not granted', { threadId: '22' }));
  const inbox = await service.listMessages('one', channel.id);
  const secondInbox = await service.listMessages('one', mirror.id);
  const thirdInbox = await service.listMessages('two', other.id);
  assert.equal(inbox.messages.length, 1);
  assert.equal(secondInbox.messages.length, 1);
  assert.equal(thirdInbox.messages.length, 1);
  assert.equal([inbox.messages[0], secondInbox.messages[0]].filter(row => row.notificationOwner).length, 1);
  assert.equal(inbox.messages[0].nativeMessageId, undefined);
  assert.equal(inbox.messages[0].senderLabel, 'Customer');
  await assert.rejects(service.listMessages('two', channel.id), /channel-not-bound/);
  await assert.rejects(service.reply({
    workspaceId: 'one', channelId: mirror.id, messageId: inbox.messages[0].id, text: 'Cannot cross Channel', requestId: 'cross'
  }), /channel-message-not-found/);
  const target = { workspaceId: 'one', channelId: channel.id, messageId: inbox.messages[0].id, text: 'Reply', requestId: 'stable' };
  assert.equal((await service.reply(target)).status, 'sent');
  assert.equal((await service.reply(target)).status, 'sent');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], {
    address: { provider: 'telegram', botId: 'linked-bot', conversationId: '-10044', threadId: '11', conversationType: 'group' },
    message: { text: 'Reply', nativeMessageId: '42', reply: true }
  });
  await service.stopAndWait();
  const reopened = open();
  assert.equal((await reopened.reply(target)).status, 'sent');
  assert.equal(sends.length, 1);
  const updated = await reopened.setMessageState({ workspaceId: 'one', channelId: mirror.id,
    messageId: secondInbox.messages[0].id, read: true, processed: true });
  assert.equal(updated.processed, true);
  assert.equal((await reopened.listMessages('one', channel.id, { unread: true })).messages.length, 0);
  assert.equal((await reopened.getMessage('one', channel.id, inbox.messages[0].id)).processed, true);
  assert.equal((await reopened.getMessage('two', other.id, thirdInbox.messages[0].id)).processed, false);
  assert.deepEqual((await reopened.listMessages('one', mirror.id, { notifications: true })).messages, []);
  assert.equal((await reopened.listMessages('two', other.id, { notifications: true })).messages.length, 1);
});

test('global pairing authorizes only the selected source and sender and needs no workspace binding', async t => {
  const { service, dispatches } = fixtures(t);
  await service.receive(message('discovery', 'discover'));
  await service.receive(message('discovery-2', 'discover thread 22', { threadId: '22' }));
  const sources = await rpc(service, 'sources.list');
  const correct = sources.find(source => source.threadId === '11');
  const wrong = sources.find(source => source.threadId === '22');
  const channel = await attach(service, correct, { remoteTarget: { kind: 'workbench' } });
  const other = await attach(service, wrong);
  const pair = await rpc(service, 'remote.begin', { channelId: channel.id, sourceId: correct.id });
  assert.match(pair.binding.code, /^\d{6}$/);
  assert.equal((await service.listChannels('one')).find(row => row.id === channel.id).sources[0].remote, null, 'Apps receive no challenge secret');
  await rpc(service, 'bindings.remove', { workspaceId: 'one', channelId: channel.id });
  await service.receive(message('misdirected-code', pair.binding.code, { threadId: '22' }));
  assert.deepEqual((await service.listMessages('one', other.id)).messages, []);
  assert.equal(dispatches.length, 0);
  const delivered = [];
  const deliver = async (result, signal) => { assert.equal(signal.aborted, false); delivered.push(result.text); };
  await service.receive(message('correct-code', pair.binding.code, { deliver }));
  assert.match(delivered[0], /绑定成功/);
  await service.receive(message('same-origin-task', 'remote task', { deliver }));
  await service.receive(message('same-origin-task', 'duplicate', { deliver }));
  await service.receive(message('client-voice', 'customer asks', { senderId: 'different' }));
  assert.equal(dispatches.length, 1);
  assert.deepEqual(Object.keys(dispatches[0].scope).sort(), ['id', 'source']);
  assert.equal(delivered[1], 'Workbench: remote task');
  await rpc(service, 'bindings.add', { workspaceId: 'one', channelId: channel.id });
  const { messages } = await service.listMessages('one', channel.id);
  assert.deepEqual(messages.map(row => [row.text, row.remoteHandled, row.notificationOwner]).sort(),
    [['customer asks', false, false], ['remote task', true, false]]);
  const diagnostics = await rpc(service, 'diagnostics', { channelId: channel.id });
  assert.equal(diagnostics.stages.authorized, 1);
  assert.equal(diagnostics.stages.routed, 1);
  assert.equal(diagnostics.stages.reply, 2);
  const renewed = await rpc(service, 'remote.begin', { channelId: channel.id, sourceId: correct.id });
  await service.receive(message('already-bound-pairing-code', renewed.binding.code, { deliver }));
  assert.match(delivered[2], /已绑定/);
  assert.equal(dispatches.length, 1, 'a pairing code must not be submitted as model input');
  await rpc(service, 'sources.remove', { channelId: channel.id, sourceId: correct.id });
  assert.deepEqual(await service.receive(message('revoked', 'no longer authorized', { deliver })), { text: '' });
  assert.equal(dispatches.length, 1);
});

test('retiring a bot preserves inbox history, revokes in-flight sends, and discovers a fresh source on reconnection', async t => {
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const { service } = fixtures(t, {
    send: async (_, _message, signal) => {
      begin();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  });
  await service.receive(message('discover', 'hello'));
  const [source] = await rpc(service, 'sources.list');
  const channel = await attach(service, source);
  await service.receive(message('first', 'historical source body'));
  const send = service.send({ workspaceId: 'one', channelId: channel.id, sourceId: source.id, text: 'In flight', requestId: 'retire' });
  await started;
  service.revokeAccount(source.provider, source.botId, true);
  assert.equal((await send).status, 'unknown');
  const history = await service.listMessages('one', channel.id);
  assert.equal(history.messages.some(row => row.text === 'historical source body'), true);
  assert.equal((await service.getChannel('one', channel.id)).sources[0].source.connected, false);
  assert.deepEqual(await rpc(service, 'sources.list'), []);
  await service.receive(message('reconnected', 'metadata only'));
  const [fresh] = await rpc(service, 'sources.list');
  assert.notEqual(fresh.id, source.id);
  assert.equal((await service.listMessages('one', channel.id)).messages.length, 2);
  await assert.rejects(service.send({ workspaceId: 'one', channelId: channel.id, sourceId: source.id, text: 'Wrong incarnation', requestId: 'later' }), /channel-source-not-sendable/);
});

test('an authorized dispatch to an unavailable target records failure without a successful workbench reply', async t => {
  const { service } = fixtures(t, { dispatch: async () => ({ text: 'Target removed', failure: 'remote-target-unavailable' }) });
  await service.receive(message('discover', 'discover'));
  const [source] = await rpc(service, 'sources.list');
  const channel = await attach(service, source, { remoteTarget: { kind: 'workbench' } });
  const pairing = await rpc(service, 'remote.begin', { channelId: channel.id, sourceId: source.id });
  await service.receive(message('pair', pairing.binding.code));
  const delivered = [];
  await service.receive(message('failed-route', 'task', { deliver: async value => delivered.push(value.text) }));
  assert.deepEqual(delivered, ['Target removed']);
  const diagnostics = await rpc(service, 'diagnostics', { channelId: channel.id });
  assert.equal(diagnostics.stages.routed, 1);
  assert.equal(diagnostics.stages.reply, 0);
  assert.equal(diagnostics.stages.failure, 1);
  assert.equal(diagnostics.lastStage.reason, 'remote-target-unavailable');
});

test('a submitted receipt left by a process becomes unknown and is never sent again', async t => {
  const { service, file, open, sends } = fixtures(t);
  await service.receive(message('discover', 'discover source'));
  const [source] = await rpc(service, 'sources.list');
  const channel = await attach(service, source);
  const input = { workspaceId: 'one', channelId: channel.id, sourceId: source.id, text: 'Sent before crash', requestId: 'submit' };
  assert.equal((await service.send(input)).status, 'sent');
  await service.stopAndWait();
  const persisted = new DatabaseSync(file);
  persisted.exec("UPDATE send_receipts SET status='submitted'; UPDATE messages SET status='submitted';");
  persisted.close();
  const recovered = open();
  assert.equal((await recovered.send(input)).status, 'unknown');
  assert.equal(sends.length, 1);
});

test('notification pagination follows durable arrival even when message timestamps are identical', async t => {
  const { service } = fixtures(t);
  await service.receive(message('discover', 'discover'));
  const [source] = await rpc(service, 'sources.list');
  const digest = await attach(service, source);
  const channel = await attach(service, source, { notify: 'wake' });
  await service.receive(message('same-clock-one', 'first'));
  const first = await service.listMessages('one', channel.id, { notifications: true, limit: 1 });
  assert.deepEqual(first.messages.map(row => row.text), ['first']);
  assert.deepEqual((await service.listMessages('one', digest.id, { notifications: true })).messages, [], 'immediate source receives the shared notification');
  await service.receive(message('same-clock-two', 'second'));
  const next = await service.listMessages('one', channel.id, { notifications: true, after: first.nextCursor });
  assert.deepEqual(next.messages.map(row => row.text), ['second']);
  await assert.rejects(service.listMessages('one', digest.id, { notifications: true, after: first.nextCursor }), /invalid-channel-cursor/);
});

test('expired discovery hashes do not prune accepted Channel history or permit old events to replay', async t => {
  let at = 1000;
  const { service } = fixtures(t, { now: () => at });
  await service.receive(message('discover', 'discover'));
  const [source] = await rpc(service, 'sources.list');
  const channel = await attach(service, source);
  const old = message('old-event', 'retain this text');
  await service.receive(old);
  const archived = (await service.listMessages('one', channel.id)).messages[0];
  await service.setMessageState({ workspaceId: 'one', channelId: channel.id, messageId: archived.id, processed: true });
  at += 31 * 24 * 60 * 60_000;
  await service.receive(old);
  await service.receive(message('new-event', 'another message'));
  const page = await service.listMessages('one', channel.id);
  assert.deepEqual(page.messages.map(row => row.text), ['another message', 'retain this text']);
  assert.equal(page.messages[1].processed, true);
});

test('a connected legacy Feishu source shares the same Channel and remote authority without a second login', async t => {
  const legacySource = {
    id: 'legacy:feishu-conversation', botId: 'feishu-conversation', provider: 'feishu', conversationId: 'oc_linked',
    conversationType: 'group', label: 'Existing Feishu bot', connected: true, lastSeenAt: 1, canSend: true, canRemote: true,
    legacyDefault: { name: 'Existing Feishu', permission: 'reply', notify: 'digest' }
  };
  const duplicate = { ...legacySource, id: 'legacy:duplicate-connection', botId: 'duplicate-connection', legacyDefault: undefined };
  const { service, dispatches } = fixtures(t, { legacy: {
    async listSources(ws) { return ws === 'one' ? [legacySource, duplicate] : []; },
    async listMessages(_ws, channelId, sourceId) {
      return [{ id: 'legacy:messages:one', channelId, sourceId, direction: 'inbound', text: 'Original message',
        senderLabel: 'Original', createdAt: 1, status: 'received', read: false, processed: false }];
    }
  } });
  const [compat] = await service.listChannels('one');
  const scopedSourceId = compat.sources[0].sourceId;
  assert.notEqual(scopedSourceId, legacySource.id);
  const sources = await rpc(service, 'sources.list');
  assert.equal(sources.find(source => source.id === scopedSourceId).legacyOwnerWorkspaceId, 'one');
  const duplicateSourceId = sources.find(source => source.botId === duplicate.botId).id;
  assert.deepEqual(await service.listChannels('two'), []);
  assert.equal((await service.listMessages('one', compat.id)).messages[0].text, 'Original message');
  assert.deepEqual((await service.listMessages('one', compat.id, { notifications: true })).messages, []);
  await rpc(service, 'sources.update', { channelId: compat.id, sourceId: scopedSourceId, remoteTarget: { kind: 'workbench' } });
  const blocked = await service.invoke('sources.add', {
    channelId: compat.id, sourceId: duplicateSourceId, remoteTarget: { kind: 'workbench' }
  }, new AbortController().signal);
  assert.equal(blocked.error.code, 'channel-remote-source-in-use');
  const pair = await rpc(service, 'remote.begin', { channelId: compat.id, sourceId: scopedSourceId });
  const replies = [];
  const event = (id, text, overrides = {}) => ({
    messageId: id, text, senderId: 'ou_person', senderIsBot: false, conversationType: 'direct',
    addressed: true, conversationId: 'oc_linked', deliver: async reply => replies.push(reply.text), ...overrides
  });
  assert.equal(await service.receiveLegacyRemote('two', event('wrong-workspace', pair.binding.code)), true, 'misdirected challenge is not written to a shared inbox');
  assert.equal(await service.receiveLegacyRemote('one', event('ordinary-app', 'Other message')), false);
  assert.equal(await service.receiveLegacyRemote('one', event('thread', pair.binding.code, { threadId: 'thread-ungranted' })), true);
  assert.equal(dispatches.length, 0, 'wrong threads may not use a pairing challenge');
  assert.equal(await service.receiveLegacyRemote('one', event('legacy-pair', pair.binding.code)), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(replies[0], /绑定成功/);
  assert.equal(await service.receiveLegacyRemote('one', event('legacy-task', 'Run in Workbench')), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].scope.source.botId, legacySource.botId);
  service.revokeLegacyProvider('one', 'feishu');
  assert.equal(await service.receiveLegacyRemote('one', event('revoked', 'Old authorization')), false);
  await rpc(service, 'remove', { channelId: compat.id });
  assert.deepEqual(await service.listChannels('one'), [], 'manual removal does not recreate migrated definitions');
});

test('an existing malformed Channel database is preserved without accepting an event', async t => {
  const { service, file } = fixtures(t);
  const corrupt = Buffer.from('existing unrecognized database\n');
  fs.writeFileSync(file, corrupt);
  await assert.rejects(service.receive(message('event', 'message')), /logical-channel-store-unavailable/);
  assert.deepEqual(fs.readFileSync(file), corrupt);
});

test('global catalog, shared inbox, isolated dispositions, and binding revocation survive reopening', async t => {
  const { service, sends, open } = fixtures(t);
  const changes = [];
  service.subscribe(change => changes.push(change));
  await service.receive(message('discover', 'discover'));
  const [source] = await rpc(service, 'sources.list');
  const channel = await rpc(service, 'create', { name: 'Shared project' });
  assert.deepEqual(new Set(changes.map(change => change.workspaceId)), new Set(['one', 'two']));
  await rpc(service, 'sources.add', { channelId: channel.id, sourceId: source.id, permission: 'reply' });
  assert.deepEqual(await service.catalog('two'), [{ id: channel.id, name: 'Shared project', sourceCount: 1, bound: false }]);
  assert.deepEqual(await service.listChannels('one'), []);
  await service.receive(message('before-binding', 'previous shared message'));
  await rpc(service, 'bindings.add', { workspaceId: 'one', channelId: channel.id });
  await rpc(service, 'bindings.add', { workspaceId: 'two', channelId: channel.id });
  const [first] = (await service.listMessages('one', channel.id)).messages;
  assert.equal(first.text, 'previous shared message');
  assert.equal((await service.getMessage('two', channel.id, first.id)).read, false);
  assert.deepEqual((await service.listMessages('two', channel.id, { notifications: true })).messages, []);
  await service.receive(message('while-bound', 'new shared message'));
  const [notice] = (await service.listMessages('two', channel.id, { notifications: true })).messages;
  await service.setMessageState({ workspaceId: 'one', channelId: channel.id, messageId: notice.id, read: true, processed: true });
  assert.equal((await service.getMessage('one', channel.id, notice.id)).processed, true);
  assert.equal((await service.getMessage('two', channel.id, notice.id)).processed, false);
  assert.equal((await service.getMessage('two', channel.id, notice.id)).notificationOwner, true);
  const send = { workspaceId: 'one', channelId: channel.id, sourceId: source.id, text: 'once', requestId: 'global-attempt' };
  const sent = await service.send(send);
  await rpc(service, 'bindings.remove', { workspaceId: 'one', channelId: channel.id });
  await assert.rejects(service.send(send), /channel-not-bound/);
  await assert.rejects(service.getMessage('one', channel.id, notice.id), /channel-not-bound/);
  assert.equal((await service.getMessage('two', channel.id, notice.id)).text, 'new shared message');
  await service.stopAndWait();
  const restarted = open();
  assert.deepEqual(await restarted.listChannels('one'), []);
  assert.equal((await restarted.listChannels('two'))[0].id, channel.id);
  await rpc(restarted, 'bindings.add', { workspaceId: 'one', channelId: channel.id });
  assert.equal((await restarted.send(send)).id, sent.id);
  assert.equal(sends.length, 1);
  assert.equal((await restarted.getMessage('one', channel.id, notice.id)).processed, true);
  assert.deepEqual((await restarted.listMessages('one', channel.id, { notifications: true })).messages, []);
});

test('a binding removed while an outbound waits for connectivity prevents submission even if re-added', async t => {
  let delayed = false;
  let release;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const { service, sends } = fixtures(t, { connected: async () => {
    if (delayed) { notifyStarted(); await waiting; }
    return true;
  } });
  await service.receive(message('discover', 'discover'));
  const [source] = await rpc(service, 'sources.list');
  const channel = await attach(service, source);
  delayed = true;
  const send = service.send({ workspaceId: 'one', channelId: channel.id, sourceId: source.id, text: 'do not submit', requestId: 'paused' });
  await started;
  await rpc(service, 'bindings.remove', { workspaceId: 'one', channelId: channel.id });
  await rpc(service, 'bindings.add', { workspaceId: 'one', channelId: channel.id });
  release();
  await assert.rejects(send, { name: 'AbortError' });
  assert.deepEqual(sends, []);
});

test('v1 workspace definitions migrate atomically with receipts, dispositions and remote scope identity intact', async t => {
  const { service, file, open, sends } = fixtures(t);
  await service.receive(message('first-discovery', 'discover'));
  const [source] = await rpc(service, 'sources.list');
  const channel = await attach(service, source, { remoteTarget: { kind: 'workbench' } });
  await service.receive(message('old-event', 'old body'));
  const [original] = (await service.listMessages('one', channel.id)).messages;
  const send = { workspaceId: 'one', channelId: channel.id, sourceId: source.id, text: 'old send', requestId: 'v1-request' };
  const sent = await service.send(send);
  await service.stopAndWait();
  const old = new DatabaseSync(file);
  const { id: scopeId } = old.prepare('SELECT id FROM grants WHERE source_id=?').get(source.id);
  old.exec(`DROP TABLE legacy_notice_refs; DROP TABLE legacy_workspace_notices; DROP TABLE legacy_notice_claims;
    ALTER TABLE grants DROP COLUMN linked_at;
    DROP TABLE workspace_notices; DROP TABLE workspace_message_state; DROP TABLE channel_bindings;
    UPDATE channels SET workspace_id='one'; UPDATE grants SET target='{"kind":"gui","sessionId":"old-gui"}';
    UPDATE messages SET details=json_set(details,'$.read',json('true'),'$.processed',json('true'),'$.notificationOwner',json('true')) WHERE direction='inbound';
    PRAGMA user_version=1;`);
  old.close();
  const migrated = open();
  const [bound] = await rpc(migrated, 'bindings.list', { workspaceId: 'one' });
  assert.equal(bound.id, channel.id);
  assert.deepEqual(await migrated.listChannels('two'), []);
  const [definition] = await rpc(migrated, 'list');
  assert.deepEqual(definition.sources[0].remoteTarget, { kind: 'workbench' });
  assert.equal((await migrated.getMessage('one', channel.id, original.id)).read, true);
  assert.equal((await migrated.getMessage('one', channel.id, original.id)).processed, true);
  assert.equal((await migrated.send(send)).id, sent.id);
  assert.equal(sends.length, 1);
  await rpc(migrated, 'bindings.add', { workspaceId: 'two', channelId: channel.id });
  assert.equal((await migrated.getMessage('two', channel.id, original.id)).read, false);
  const persisted = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(persisted.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(persisted.prepare('SELECT id FROM grants WHERE source_id=?').get(source.id).id, scopeId);
  } finally { persisted.close(); }
});

test('legacy sources with the same local IDs route to their own account and isolate cross-workspace state', async t => {
  const source = { id: 'legacy:mailbox', botId: 'mailbox', provider: 'email', conversationId: 'mailbox',
    conversationType: 'direct', connected: true, lastSeenAt: 1, canSend: true, canRemote: false };
  const record = (owner, channelId, sourceId) => ({ id: 'legacy:mail:shared-id', channelId, sourceId, direction: 'inbound',
    text: `original from ${owner}`, senderLabel: owner, createdAt: 8, status: 'received', read: true, processed: false });
  const replies = [];
  const { service } = fixtures(t, { legacy: {
    async listSources(owner) { return [{ ...source, label: `Mailbox ${owner}` }]; },
    async listMessages(owner, channelId, sourceId) { return [record(owner, channelId, sourceId)]; },
    async getMessage(owner, channelId, sourceId, messageId) {
      if (messageId === 'legacy:mail:shared-id') return record(owner, channelId, sourceId);
    },
    async reply(input) { replies.push(input); return { ...record(input.workspaceId, input.channelId, input.sourceId), id: 'legacy:mail:out', direction: 'outbound', status: 'sent' }; }
  } });
  const channelsSources = await rpc(service, 'sources.list');
  const one = channelsSources.find(item => item.legacyOwnerWorkspaceId === 'one');
  const two = channelsSources.find(item => item.legacyOwnerWorkspaceId === 'two');
  assert.notEqual(one.id, two.id);
  const channel = await attach(service, one);
  await rpc(service, 'sources.add', { channelId: channel.id, sourceId: two.id, permission: 'reply' });
  await rpc(service, 'bindings.add', { workspaceId: 'two', channelId: channel.id });
  const { messages } = await service.listMessages('two', channel.id);
  const first = messages.find(item => item.sourceId === one.id);
  assert.equal(first.text, 'original from one');
  assert.equal(first.read, false);
  assert.notEqual(first.id, messages.find(item => item.sourceId === two.id).id);
  await service.setMessageState({ workspaceId: 'two', channelId: channel.id, messageId: first.id, processed: true });
  assert.equal((await service.getMessage('two', channel.id, first.id)).processed, true);
  assert.equal((await service.getMessage('one', channel.id, first.id)).processed, false);
  await service.reply({ workspaceId: 'two', channelId: channel.id, messageId: first.id, text: 'answer', requestId: 'from-two' });
  assert.equal(replies[0].workspaceId, 'one');
  assert.equal(replies[0].sourceId, 'legacy:mailbox');
  assert.equal(replies[0].messageId, 'legacy:mail:shared-id');
});
