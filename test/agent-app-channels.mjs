import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

test('old drafts and receipt metadata survive while real App worker and Channel service share authorized sources, outbox and replies', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-agent-app-channels-'));
  const worker = path.join(folder, 'service-worker.cjs'), bundle = path.join(folder, 'test.cjs');
  const compile = { bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['sharp'],
    banner: { js: `var require=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});` } };
  buildSync({ ...compile, outfile: worker, entryPoints: [path.join(root, 'src/main/agentApps/serviceWorker.ts')] });
  buildSync({ ...compile, outfile: bundle, stdin: { resolveDir: root, contents: `
    export { AgentAppsServiceClient } from './src/main/agentApps/serviceClient';
    export { AgentAppsService } from './src/main/agentApps/service';
    export { AgentAppsSqliteStateStore } from './src/main/agentApps/sqliteStateStore';
    export { LogicalChannelService } from './src/main/messaging/logicalChannelService';
    export { RemoteBindingService } from './src/main/messaging/remoteBindingService';
    export { defineRecordApp, CHANNEL_APP_ID } from './src/shared/agentApps';
  ` } });
  const { AgentAppsService, AgentAppsServiceClient, AgentAppsSqliteStateStore, LogicalChannelService, RemoteBindingService, defineRecordApp, CHANNEL_APP_ID } = require(bundle);
  let apps, core;
  t.after(async () => { await apps?.stop(); await core?.stopAndWait(); fs.rmSync(folder, { recursive: true, force: true }); });
  const deliveries = [], mailSends = [], nativeSends = [], remoteRuns = [];
  const actor = { kind: 'human', runId: 'fixture' };
  let inboundMail = [{ uid: '7:31', messageId: '<incoming@example.test>', subject: 'Original mail', body: 'Imported text', from: 'peer@example.test', folder: 'inbox', status: 'received' }];
  const options = {
    root: path.join(folder, 'agent-apps'), workspaces: () => ['one', 'two'], emit: () => {}, encrypt: value => Buffer.from(value).toString('base64'),
    decrypt: value => Buffer.from(value, 'base64').toString(), confirmSend: async () => true, deliver: async () => ({ muted: true }),
    connectors: { test: async () => {}, feed: async () => [], listFeishuChats: async () => ({ chats: [] }),
      sync: async () => ({ cursor: { uid: 31, validity: 7 }, records: inboundMail }),
      send: async (conn, secret, values, requestId) => { mailSends.push({ conn, secret, values, requestId }); return { messageId: '<fake-send@example.test>' }; }
    }
  };
  const old = new AgentAppsService({ ...options, storeFactory: (dir, seed) => new AgentAppsSqliteStateStore(dir, () => seed().filter(item => item.definition.id !== CHANNEL_APP_ID)) });
  old.saveConnection('one', { kind: 'imap-smtp', id: 'mailbox', name: 'Saved mail', address: 'fixture@example.test', user: 'fixture', imapHost: 'imap.example.test', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.example.test', smtpPort: 465, smtpTls: 'tls', mailbox: 'INBOX', password: 'fixture-only', enabled: true, notify: 'mute', grants: { mail: ['mail.read', 'mail.send'] } });
  await old.install('one', defineRecordApp({ id: 'channel', name: 'My custom app', titleField: 'title', fields: [{ id: 'title', label: 'Title', type: 'text' }] }), {}, 'human');
  const sync = await old.execute('one', { appId: 'mail', commandId: 'sync', params: { accountId: 'mailbox' } }, actor);
  assert.equal(sync.count, 1);
  const [original] = old.query('one', { appId: 'mail' }).records;
  await old.execute('one', { appId: 'mail', commandId: 'read', params: { id: original.id, expectedRevision: original.revision } }, actor);
  const draft = (await old.execute('one', { appId: 'mail', commandId: 'create', params: { values: { accountId: 'mailbox', subject: 'My draft', to: 'other@example.test', body: 'unsent' } } }, actor)).record;
  const previous = old.store.read('one');
  assert.equal(previous.connections[0].cursors.mail.uid, 31);
  old.store.transact('one', state => { for (const event of state.outbox) event.deliveredAt = Date.now(); });
  old.store.close();

  const bindings = new RemoteBindingService({ file: path.join(folder, 'bindings.json'), dispatch: async input => { remoteRuns.push(input.text); return { text: 'remote accepted' }; } });
  const legacy = Object.fromEntries(['listSources', 'listMessages', 'getMessage', 'send', 'reply', 'setMessageState', 'saveDraft'].map(method => [method, (...args) => apps.legacyChannels[method](...args)]));
  core = new LogicalChannelService({ file: path.join(folder, 'logical.sqlite'), workspaceExists: ws => options.workspaces().includes(ws),
    workspaceIds: options.workspaces, connected: async () => true,
    send: async (target, message) => { nativeSends.push({ target, message }); }, legacy,
    remote: { intent: (input, scope) => bindings.intent(input, scope), handle: (input, scope) => bindings.handle(input, scope),
      isPairingSecret: text => bindings.isPairingSecret(text), manage: (scope, method, bindingId) => bindings.manageScope(scope, method, bindingId), revoke: scope => bindings.revokeScope(scope) }
  });
  function openApps() {
    const channels = Object.fromEntries(['catalog', 'bindChannel', 'legacyAccess', 'listChannels', 'listMessages', 'getMessage', 'send', 'reply', 'setMessageState', 'saveDraft'].map(method => [method, core[method].bind(core)]));
    channels.captureLegacyNotices = (ws, notice, signal) => core.captureLegacyNotices(ws, notice, false, signal);
    return new AgentAppsServiceClient(worker, { ...options, channels, deliver: async (ws, event) => {
      const notice = await apps.notification(ws, event.id);
      if (!notice) return { muted: true };
      deliveries.push({ ws, event, notice }); return { messageId: `ledger:${event.id}` };
    } });
  }
  apps = openApps();
  const appIds = (await apps.snapshot('one')).apps.map(item => item.definition.id);
  assert.ok(appIds.includes(CHANNEL_APP_ID) && appIds.includes('channel'));
  assert.ok(!appIds.includes('mail') && !appIds.includes('messages'));
  const [mail] = (await apps.query('one', { appId: CHANNEL_APP_ID })).channels;
  assert.match(mail.sources[0].sourceId, /^legacy:[a-f0-9]{64}$/);
  assert.equal((await apps.query('two', { appId: CHANNEL_APP_ID })).channels.length, 0);
  const call = (commandId, params, requestId) => apps.execute('one', { appId: CHANNEL_APP_ID, commandId, params, requestId }, actor);
  const [imported] = (await call('list', { channelId: mail.id, search: 'Imported' })).channelMessages.messages;
  assert.equal(imported.id, `${mail.sources[0].sourceId}:mail:${original.id}`);
  assert.equal(imported.read, true);
  assert.equal((await call('list', { channelId: mail.id, drafts: true })).channelMessages.messages[0].id, `${mail.sources[0].sourceId}:mail:${draft.id}`);
  await call('state', { channelId: mail.id, messageId: imported.id, processed: true });
  assert.equal((await apps.query('one', { appId: 'mail', id: original.id })).record.values.processed, true);
  const replyParams = { channelId: mail.id, messageId: imported.id, text: 'Reply via the original mailbox', recipient: 'forged@example.test' };
  await call('reply', replyParams, 'mail-reply');
  await call('reply', replyParams, 'mail-reply');
  assert.equal(mailSends.length, 1);
  assert.equal(mailSends[0].values.to, 'peer@example.test');
  assert.equal(mailSends[0].values.replyTo, '<incoming@example.test>');
  assert.equal(mailSends[0].secret.password, 'fixture-only');
  const model = { kind: 'agent', runId: 'scheduler-fixture' };
  const legacyRead = { appId: 'mail', commandId: 'get', params: { id: original.id }, requestId: 'legacy-read-receipt' };
  assert.equal((await apps.execute('one', legacyRead, model)).record.id, original.id);
  const catalog = await apps.query('two', { appId: CHANNEL_APP_ID, viewId: 'bindings' });
  assert.deepEqual(catalog.channelCatalog, [{ id: mail.id, name: 'Saved mail', sourceCount: 1, bound: false }]);
  const select = (ws, commandId) => apps.execute(ws, { appId: CHANNEL_APP_ID, commandId, params: { channelId: mail.id } }, model);
  assert.equal((await select('two', 'bind')).status, 'bound');
  assert.equal((await apps.query('two', { appId: CHANNEL_APP_ID, channelId: mail.id, id: imported.id })).channelMessage.text, 'Imported text');
  assert.equal((await select('one', 'unbind')).status, 'unbound');
  await assert.rejects(apps.execute('one', legacyRead, model), /catalog and bind/);
  await assert.rejects(apps.execute('one', { appId: 'mail', commandId: 'send', params: { id: draft.id, expectedRevision: draft.revision }, requestId: 'old-direct-send' }, model), /catalog and bind/);
  assert.equal(mailSends.length, 1);
  assert.equal((await select('one', 'bind')).status, 'bound');
  assert.equal((await select('two', 'unbind')).status, 'unbound');

  const signal = new AbortController().signal;
  const rpc = async (method, data = {}) => {
    const result = await core.invoke(method, data, signal);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  const inbound = (messageId, text, more = {}) => ({ channelKey: 'telegram', botId: 'bot', conversationId: 'conversation', senderId: 'sender', senderIsBot: false, addressed: true,
    conversationType: 'direct', messageId, nativeMessageId: messageId, text, ...more });
  await core.receive(inbound('discovery', 'discover'));
  const native = (await rpc('sources.list')).find(source => source.provider === 'telegram');
  await rpc('sources.add', { channelId: mail.id, sourceId: native.id, permission: 'reply', notify: 'wake' });
  const mirror = await rpc('create', { name: 'Mirror', notify: 'digest' });
  await rpc('sources.add', { channelId: mirror.id, sourceId: native.id, permission: 'read', remoteTarget: { kind: 'workbench' } });
  await rpc('bindings.add', { workspaceId: 'one', channelId: mirror.id });
  await core.receive(inbound('evt-1', 'New Telegram request'));
  const rows = (await call('list', { channelId: mail.id, sourceId: native.id })).channelMessages.messages;
  assert.equal(rows[0].text, 'New Telegram request');
  const global = await apps.query('one', { appId: CHANNEL_APP_ID, search: 'Telegram request' });
  assert.deepEqual(new Set(global.channelMessages.messages.map(message => message.channelId)), new Set([mail.id, mirror.id]));
  assert.ok(global.channelMessages.messages.every(message => message.sourceId === native.id));
  assert.deepEqual((await apps.query('two', { appId: CHANNEL_APP_ID, search: 'Telegram request' })).channelMessages.messages, []);
  await call('reply', { channelId: mail.id, messageId: rows[0].id, text: 'Telegram reply' }, 'tm-reply');
  assert.equal(nativeSends[0].message.nativeMessageId, 'evt-1');
  assert.equal(nativeSends[0].target.conversationId, 'conversation');
  await apps.tick();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].notice.action, 'wake');
  assert.equal(deliveries[0].notice.payload.data[0].text, 'New Telegram request');

  const code = await rpc('remote.begin', { channelId: mirror.id, sourceId: native.id });
  await core.receive(inbound('pairing', code.binding.code));
  await core.receive(inbound('remote-command', 'Handled by Workbench'));
  assert.deepEqual(remoteRuns, ['Handled by Workbench']);
  await core.receive(inbound('evt-2', 'Pending while app worker closes', { senderId: 'unbound' }));
  await apps.stop();
  apps = openApps();
  await apps.tick();
  await apps.tick();
  assert.deepEqual(deliveries.map(item => item.notice.payload.data[0].text), ['New Telegram request', 'Pending while app worker closes']);
  assert.equal((await apps.notification('one', deliveries[0].event.id)).payload.data[0].messageId, rows[0].id);
  await rpc('bindings.remove', { workspaceId: 'one', channelId: mail.id });
  assert.equal(await apps.notification('one', deliveries[1].event.id), null, 'unbinding revokes the queued notification even while another Channel is bound');
  await rpc('bindings.add', { workspaceId: 'one', channelId: mail.id });
  await call('state', { channelId: mail.id, messageId: rows[0].id, processed: true });
  assert.equal(await apps.notification('one', deliveries[0].event.id), null, 'before model consumption, resolved content is rechecked against processing state');

  await rpc('update', { channelId: mail.id, notify: 'wake' });
  await select('two', 'bind');
  const incomingMail = (id, body) => ({ ...inboundMail[0], uid: `7:${id}`, messageId: `<${id}@example.test>`, body });
  const syncMailbox = () => apps.execute('one', { appId: 'mail', commandId: 'sync', params: { accountId: 'mailbox' } }, actor);
  inboundMail = [incomingMail(32, 'One inbound from the existing mailbox'), incomingMail(33, 'Another inbound from the existing mailbox')];
  assert.equal((await syncMailbox()).count, 2);
  await apps.stop();
  apps = openApps();
  await apps.tick();
  await apps.tick();
  const legacyNotices = deliveries.slice(2);
  assert.equal(legacyNotices.length, 1, 'old IMAP batches remain one alert per binding, including across restart');
  assert.equal(legacyNotices[0].ws, 'two', 'the original workspace is bound but its old account is muted');
  assert.equal(legacyNotices[0].event.appId, CHANNEL_APP_ID);
  assert.equal(legacyNotices[0].notice.action, 'wake');
  const messageId = legacyNotices[0].notice.payload.data[0].messageId;
  await apps.execute('two', { appId: CHANNEL_APP_ID, commandId: 'state', params: { channelId: mail.id, messageId, read: true } }, actor);
  assert.equal(await apps.notification('two', legacyNotices[0].event.id), null, 'read state is revalidated in the recipient workspace');

  const updateOldNotify = async notify => {
    const mailbox = (await apps.snapshot('one')).connections.find(connection => connection.id === 'mailbox');
    await apps.saveConnection('one', { ...mailbox, expectedRevision: mailbox.revision, notify });
  };
  await updateOldNotify('wake');
  inboundMail = [incomingMail(34, 'Notify both bound workspaces')];
  assert.equal((await syncMailbox()).count, 1);
  await apps.tick();
  await apps.tick();
  const entitled = deliveries.slice(3);
  assert.deepEqual(entitled.map(item => item.ws).sort(), ['one', 'two']);
  await updateOldNotify('mute');
  assert.equal(await apps.notification('one', entitled.find(item => item.ws === 'one').event.id), null,
    'changing the old connection to mute also revokes the owner’s already queued content');
  assert.ok(await apps.notification('two', entitled.find(item => item.ws === 'two').event.id),
    'another workspace keeps its Channel notice');

  await select('one', 'unbind');
  inboundMail = [incomingMail(35, 'Owner unbound, another workspace still receives')];
  assert.equal((await syncMailbox()).count, 1);
  await apps.tick();
  await apps.tick();
  assert.deepEqual(deliveries.slice(5).map(item => item.ws), ['two']);

  inboundMail = [incomingMail(36, 'A message from the revoked binding generation')];
  assert.equal((await syncMailbox()).count, 1);
  await select('two', 'unbind');
  await select('two', 'bind');
  await apps.tick();
  await apps.tick();
  assert.equal(deliveries.length, 6, 'delayed legacy handoff cannot wake a replacement binding');
  assert.equal((await apps.query('two', { appId: CHANNEL_APP_ID, channelId: mail.id, search: 'revoked binding' })).channelMessages.messages.length, 1);
});
