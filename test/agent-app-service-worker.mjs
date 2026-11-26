import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const folder = fs.mkdtempSync(path.join(tempRoot, 'agent-app-service-worker-'));
if (path.dirname(fs.realpathSync(folder)) !== tempRoot) throw new Error('Unexpected test directory');
let client;
try {
  const worker = path.join(folder, 'service-worker.cjs'), clientFile = path.join(folder, 'service-client.cjs');
  for (const [source, outfile] of [['serviceWorker.ts', worker], ['serviceClient.ts', clientFile]]) buildSync({ entryPoints: [path.join(root, 'src/main/agentApps', source)], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['sharp'], banner: { js: `var require=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});` }, logLevel: 'silent' });
  const { AgentAppsServiceClient } = createRequire(import.meta.url)(clientFile);
  const contractFile = path.join(folder, 'contract.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/shared/agentApps.ts')], outfile: contractFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { defineRecordApp } = createRequire(import.meta.url)(contractFile), sharp = createRequire(path.join(root, 'package.json'))('sharp');
  const events = [], deliveries = [];
  let sent = 0, reviews = 0;
  const options = { root: path.join(folder, 'agent-apps'), workspaces: () => ['one', 'two'], emit: (kind, value) => events.push({ kind, value }),
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(), confirmSend: async ws => (await client.snapshot(ws)).connections.some(connection => connection.id === 'mailbox'), authorizeDefinition: async () => { reviews++; return true; },
    deliver: async (ws, event) => { deliveries.push({ ws, event }); return { messageId: event.id }; },
    connectors: { feed: async () => [{ title: 'News', externalId: 'article' }], sync: async () => ({ records: [], cursor: {} }), send: async () => { sent++; return { messageId: 'fake-send' }; }, test: async () => {}, listFeishuChats: async () => ({ chats: [] }) } };
  client = new AgentAppsServiceClient(worker, options);
  await client.start();
  assert.equal((await client.snapshot('one')).apps.length, 4);
  const album = (await client.listLibrary('one')).find(item => item.catalogId === 'template:photo-album');
  await client.installFromLibrary('one', album.catalogId, undefined, 'human');
  assert.equal(reviews, 0, 'human identity crosses the worker boundary without review');
  await client.installFromLibrary('two', album.catalogId);
  assert.equal(reviews, 0, 'an agent installation of the exact bundled template also skips review');
  const custom = defineRecordApp({ id: 'worker-custom-review', name: 'Custom', fields: [{ id: 'title', label: 'Title', type: 'text', required: true }], titleField: 'title' });
  await client.install('two', custom);
  assert.equal(reviews, 1, 'an AI-created app still goes through review across the worker boundary');
  const actor = { kind: 'human', runId: 'test' };
  const result = await client.execute('one', { appId: 'tasks', commandId: 'create', params: { values: { title: 'Worker task' } } }, actor);
  assert.equal((await client.query('one', { appId: 'tasks', id: result.record.id })).record.values.title, 'Worker task');
  await client.execute('one', { appId: 'reminders', commandId: 'set', params: { values: { title: 'Notify user', dueAt: new Date(Date.now() - 1).toISOString() } } }, actor);
  await client.tick();
  assert.equal(deliveries.length, 1);
  assert.equal((await client.notification('one', deliveries[0].event.id)).payload.data[0].title, 'Notify user');
  const account = { kind: 'imap-smtp', id: 'mailbox', name: 'Mailbox', address: 'a@example.com', user: 'a', imapHost: 'imap.example.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.example.com', smtpPort: 465, smtpTls: 'tls', mailbox: 'INBOX', password: 'test-secret', enabled: true, grants: { mail: ['mail.read', 'mail.send'] } };
  await client.saveConnection('one', account);
  assert.ok(!JSON.stringify(await client.snapshot('one')).includes('test-secret'));
  for (const name of fs.readdirSync(options.root)) assert.ok(!fs.readFileSync(path.join(options.root, name)).includes(Buffer.from('test-secret')), 'credential plaintext must not reach SQLite files');
  options.connectors.sync = async () => ({ records: [
    { subject: '无主题', body: '邮件较大，正文未下载（上限 2 MB）', uid: 'one', messageId: 'one', folder: 'inbox' },
    { subject: '无主题', body: '邮件较大，正文未下载（上限 2 MB）', uid: 'two', messageId: 'two', folder: 'inbox' },
    { subject: '无主题', uid: 'three', messageId: 'three', folder: 'drafts', status: 'draft' },
    { subject: '实际标题', uid: 'four', messageId: 'four', folder: 'inbox' },
  ], placeholderFields: [{ subject: 'mail-no-subject', body: 'mail-body-omitted' }, null, { subject: 'mail-no-subject' }, { subject: 'mail-no-subject' }], cursor: { uid: 4 } });
  await client.execute('one', { appId: 'mail', commandId: 'sync', params: { accountId: 'mailbox' } }, actor);
  const mailRows = (await client.query('one', { appId: 'mail' })).records;
  const markedMail = mailRows.find(row => row.values.uid === 'one'), originalMail = mailRows.find(row => row.values.uid === 'two');
  assert.deepEqual(markedMail.placeholderFields, { subject: 'mail-no-subject', body: 'mail-body-omitted' });
  assert.equal(originalMail.placeholderFields, undefined, 'identical real source content must never be marked');
  assert.equal(mailRows.find(row => row.values.uid === 'four').placeholderFields, undefined, 'a marker cannot change an unrelated value');
  const editableMail = mailRows.find(row => row.values.uid === 'three');
  await client.execute('one', { appId: 'mail', commandId: 'update', params: { id: editableMail.id, expectedRevision: editableMail.revision, values: { subject: '无主题' } } }, actor);
  assert.equal((await client.query('one', { appId: 'mail', id: editableMail.id })).record.placeholderFields, undefined, 'an explicit edit removes provenance even when the text is identical');
  await client.execute('one', { appId: 'mail', commandId: 'read', params: { id: markedMail.id, expectedRevision: markedMail.revision } }, actor);
  assert.deepEqual((await client.query('one', { appId: 'mail', id: markedMail.id })).record.placeholderFields, markedMail.placeholderFields, 'unrelated updates preserve markers');
  await client.receiveFeishuMessage('one', { chatId: 'oc_worker', messageId: 'om_worker', sender: '对方', body: '[消息]' }, { type: 'p2p' }, { sender: 'message-peer', body: 'message-unknown-body' });
  const liveMessage = (await client.query('one', { appId: 'messages' })).records.find(row => row.values.messageId === 'om_worker');
  assert.deepEqual(liveMessage.placeholderFields, { sender: 'message-peer', body: 'message-unknown-body' }, 'live message markers cross the worker boundary');
  const generatedConnection = (await client.snapshot('one')).connections.find(c => c.kind === 'feishu' && c.chatId === 'oc_worker');
  assert.equal(generatedConnection.name, '飞书私聊 1');
  assert.equal(generatedConnection.namePlaceholder, 'feishu-private', 'only generated conversation names get provenance');
  await client.receiveFeishuMessage('one', { chatId: 'oc_named', messageId: 'om_named', sender: '外部', body: '消息' }, { type: 'p2p', name: '飞书私聊 1' });
  const suppliedConnection = (await client.snapshot('one')).connections.find(c => c.kind === 'feishu' && c.chatId === 'oc_named');
  assert.equal(suppliedConnection.namePlaceholder, undefined, 'an identical external name must not be marked');
  let resolveLateName;
  options.connectors.feishuConversationName = chatId => chatId === 'oc_late' ? new Promise(resolve => { resolveLateName = resolve; }) : undefined;
  await client.receiveFeishuMessage('one', { chatId: 'oc_late', messageId: 'om_late', sender: '外部', body: '消息' }, { type: 'p2p' });
  const lateConnection = (await client.snapshot('one')).connections.find(c => c.kind === 'feishu' && c.chatId === 'oc_late');
  assert.equal(lateConnection.namePlaceholder, 'feishu-private');
  for (let attempt = 0; attempt < 100 && !resolveLateName; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof resolveLateName, 'function', 'the late metadata lookup starts');
  resolveLateName(lateConnection.name);
  let resolvedConnection;
  for (let attempt = 0; attempt < 100; attempt++) {
    resolvedConnection = (await client.snapshot('one')).connections.find(c => c.id === lateConnection.id);
    if (resolvedConnection.revision > lateConnection.revision) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(resolvedConnection.revision, lateConnection.revision + 1);
  assert.equal(resolvedConnection.namePlaceholder, undefined, 'late external metadata clears provenance even if its text matches');
  const draft = (await client.execute('one', { appId: 'mail', commandId: 'create', params: { values: { subject: 'Test', to: 'b@example.com', body: 'Fake', accountId: 'mailbox' } } }, actor)).record;
  const send = { appId: 'mail', commandId: 'send', params: { id: draft.id, expectedRevision: draft.revision }, requestId: 'same-send' };
  await client.execute('one', send, actor); await client.execute('one', send, actor);
  assert.equal(sent, 1, 'the worker can re-enter for authorization without resending a stable request');
  const feed = (await client.execute('one', { appId: 'rss', commandId: 'subscribe', params: { values: { title: 'Slow feed', url: 'https://example.com/feed' } } }, actor)).record;
  options.connectors.feed = async () => ({ records: [{ title: '无标题', externalId: 'untitled' }, { title: '无标题', externalId: 'real-title' }], placeholderFields: [{ title: 'rss-no-title' }, null] });
  await client.execute('one', { appId: 'rss', commandId: 'sync', params: { id: feed.id } }, actor);
  const articles = (await client.query('one', { appId: 'rss', collection: 'articles' })).records;
  assert.deepEqual(articles.find(row => row.values.externalId === 'untitled').placeholderFields, { title: 'rss-no-title' });
  assert.equal(articles.find(row => row.values.externalId === 'real-title').placeholderFields, undefined);
  let feedStarted;
  const started = new Promise(resolve => { feedStarted = resolve; });
  options.connectors.feed = (_url, signal) => new Promise((_resolve, reject) => { feedStarted(); signal.addEventListener('abort', () => reject(new Error('cancelled feed')), { once: true }); });
  const controller = new AbortController();
  const pendingFeed = client.execute('one', { appId: 'rss', commandId: 'sync', params: { id: feed.id } }, { ...actor, signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pendingFeed, /abort|cancel/i);
  assert.equal((await client.query('one', { appId: 'rss', collection: 'articles' })).total, 2, 'cancelled connector cannot commit new records');
  assert.ok(events.some(event => event.kind === 'changed'));
  const photoApp = defineRecordApp({ id: 'photos', name: 'Photos', fields: [{ id: 'title', label: 'Title', type: 'text', required: true }, { id: 'image', label: 'Image', type: 'image', required: true }], titleField: 'title' });
  await client.install('one', photoApp); await client.install('two', photoApp);
  const sourceImage = path.join(folder, 'fixture.png');
  fs.writeFileSync(sourceImage, await sharp({ create: { width: 20, height: 12, channels: 3, background: '#2288aa' } }).png().toBuffer());
  const image = await client.importImage('one', 'photos', sourceImage);
  const photo = (await client.execute('one', { appId: 'photos', commandId: 'create', params: { values: { title: 'One', image: image.id } } }, actor)).record;
  assert.equal((await client.readImage('one', 'photos', image.id, true)).mime, 'image/png');
  await assert.rejects(client.readImage('two', 'photos', image.id), /unavailable/);
  await client.uninstall('one', 'photos');
  await client.install('one', photoApp);
  assert.equal((await client.readImage('one', 'photos', image.id)).mime, 'image/png', 'default uninstall retains image data');
  await client.execute('one', { appId: 'photos', commandId: 'remove', params: { id: photo.id, expectedRevision: photo.revision } }, actor);
  await assert.rejects(client.readImage('one', 'photos', image.id), /unavailable/, 'deleting the last record removes its unreferenced image');
  let shutdownFeedStarted, shutdownFeedCleaned = false;
  const shutdownStarted = new Promise(resolve => { shutdownFeedStarted = resolve; });
  options.connectors.feed = (_url, signal) => new Promise((_resolve, reject) => {
    shutdownFeedStarted();
    signal.addEventListener('abort', () => setTimeout(() => { shutdownFeedCleaned = true; reject(new Error('shutdown cancelled feed')); }, 40), { once: true });
  });
  const pendingAtShutdown = client.execute('one', { appId: 'rss', commandId: 'sync', params: { id: feed.id } }, actor);
  const shutdownFailure = assert.rejects(pendingAtShutdown, /abort|cancel|stopped/i);
  await shutdownStarted;
  await client.stop(); client = undefined;
  await shutdownFailure;
  assert.equal(shutdownFeedCleaned, true, 'shutdown waits for aborted connector cleanup before closing its database');
  client = new AgentAppsServiceClient(worker, options);
  assert.equal((await client.query('one', { appId: 'tasks', id: result.record.id })).record.values.title, 'Worker task');
  assert.deepEqual((await client.query('one', { appId: 'mail', id: markedMail.id })).record.placeholderFields, markedMail.placeholderFields, 'provenance survives worker and database restart');
  const restoredConnection = (await client.snapshot('one')).connections.find(c => c.id === generatedConnection.id);
  assert.equal(restoredConnection.namePlaceholder, 'feishu-private', 'name provenance survives worker and database restart');
  const changed = await client.saveConnection('one', { ...restoredConnection, expectedRevision: restoredConnection.revision, notify: 'mute' });
  assert.equal(changed.namePlaceholder, 'feishu-private', 'unrelated settings preserve provenance');
  const { namePlaceholder: _namePlaceholder, ...explicitName } = changed;
  const edited = await client.saveConnection('one', { ...explicitName, expectedRevision: changed.revision });
  assert.equal(edited.namePlaceholder, undefined, 'an explicit name edit clears provenance even when text matches');
  const spoofed = await client.saveConnection('one', { ...edited, expectedRevision: edited.revision, namePlaceholder: 'feishu-private' });
  assert.equal(spoofed.namePlaceholder, undefined, 'clients cannot invent provenance for existing user content');
  assert.equal((await client.query('two', { appId: 'tasks' })).total, 0);
  console.log('agent app service worker: SQLite commands, callbacks, secrets and restart passed');
} finally {
  if (client) await client.stop();
  fs.rmSync(folder, { recursive: true, force: true });
}
