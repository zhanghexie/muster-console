import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-lifecycle-'));
const services = [];
try {
  const target = path.join(folder, 'service.cjs');
  buildSync({ entryPoints: ['src/main/agentApps/service.ts'], outfile: target, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { AgentAppsService } = createRequire(import.meta.url)(target);
  const createService = options => { const service = new AgentAppsService(options); services.push(service); return service; };
  const contract = path.join(folder, 'contract.cjs');
  buildSync({ entryPoints: ['src/shared/agentApps.ts'], outfile: contract, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { defineRecordApp, validateAppDefinition } = createRequire(import.meta.url)(contract);
  const app = defineRecordApp({ id: 'notes', name: 'Notes', fields: [{ id: 'title', label: 'Title', type: 'text' }, { id: 'done', label: 'Done', type: 'boolean' }], titleField: 'title' });
  assert.throws(() => validateAppDefinition({ ...app, extensionPayload: 'x'.repeat(64_001) }), /extension fields/i);
  assert.doesNotThrow(() => validateAppDefinition({ ...app, extensionPayload: 'x'.repeat(63_000) }));
  assert.throws(() => validateAppDefinition({ ...app, commands: app.commands.filter(c => c.id !== 'remove'), views: [{ ...app.views[0], commands: ['create', 'update'] }] }), /items.*records.remove/);
  assert.throws(() => validateAppDefinition({ ...app, views: [{ ...app.views[0], commands: ['create'] }] }), /items.*records.remove/);
  const fixed = { ...app, commands: [...app.commands.filter(c => c.id !== 'update'), { id: 'complete', title: 'Complete', collection: 'items', handler: 'records.update', patch: { done: true } }], views: [{ ...app.views[0], commands: ['create', 'complete', 'remove'] }] };
  assert.throws(() => validateAppDefinition(fixed), /complete.*reverse.*done/);
  let articles = [{ title: 'old', content: 'deleted-body', externalId: 'old' }];
  const options = { root: path.join(folder, 'data'), workspaces: () => ['one'], emit: () => {}, encrypt: x => x, decrypt: x => x, confirmSend: async () => true, deliver: async () => ({ muted: true }), connectors: { feed: async () => articles, sync: async () => ({ records: [], cursor: {} }), send: async () => ({ messageId: 'sent' }), test: async () => {} } };
  let service = createService(options);
  const call = (appId, commandId, params = {}, requestId) => service.execute('one', { appId, commandId, params, requestId }, { kind: 'human' });
  const feed = (await call('rss', 'subscribe', { values: { title: 'Feed', url: 'https://example.com/feed' } })).record;
  await call('rss', 'sync', { id: feed.id });
  let record = service.query('one', { appId: 'rss', collection: 'articles' }).records[0];
  for (const command of ['save', 'unsave', 'save', 'read', 'unread', 'processed', 'unprocessed']) {
    const prior = record.revision;
    record = (await call('rss', command, { id: record.id, expectedRevision: prior })).record;
    assert.equal(record.revision, prior + 1);
  }
  await call('rss', 'get', { id: record.id }, 'read-body');
  await call('rss', 'remove', { id: record.id, expectedRevision: record.revision });
  assert.ok(!JSON.stringify(service.store.read('one')).includes('deleted-body'));
  service = createService(options);
  articles.push({ title: 'new', externalId: 'new' });
  await call('rss', 'sync', { id: feed.id });
  assert.deepEqual(service.query('one', { appId: 'rss', collection: 'articles' }).records.map(r => r.values.title), ['new']);
  const draft = (await call('mail', 'create', { values: { subject: 'pending', body: 'body' } })).record;
  service.store.transact('one', s => { s.records.mail.find(r => r.id === draft.id).values.status = 'uncertain'; });
  await assert.rejects(call('mail', 'remove', { id: draft.id, expectedRevision: draft.revision }), /reconciliation/);
  service.store.transact('one', s => { s.records.mail.find(r => r.id === draft.id).values.status = 'draft'; });
  await call('mail', 'remove', { id: draft.id, expectedRevision: draft.revision });
  assert.equal(service.query('one', { appId: 'mail' }).total, 0);

  // Replay old mailbox history through the real sync handler, including restart.
  let mailRows = [{ subject: 'received', body: 'mail-secret-body', uid: 'v1:1', messageId: 'mail-1', folder: 'inbox' }];
  options.connectors.sync = async () => ({ records: mailRows, cursor: { last: 1 } });
  service.store.transact('one', state => state.connections.push({ id: 'mailbox', kind: 'imap-smtp', name: 'Mailbox', address: 'a@example.com', user: 'a', imapHost: 'imap.example.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.example.com', smtpPort: 465, smtpTls: 'tls', mailbox: 'INBOX', enabled: true, grants: { mail: ['mail.read'] }, revision: 1 }));
  await call('mail', 'sync', { accountId: 'mailbox' });
  const received = service.query('one', { appId: 'mail' }).records[0];
  await call('mail', 'remove', { id: received.id, expectedRevision: received.revision });
  service = createService(options);
  mailRows.push({ subject: 'fresh', messageId: 'mail-2', uid: 'v1:2', folder: 'inbox' });
  await call('mail', 'sync', { accountId: 'mailbox' });
  assert.deepEqual(service.query('one', { appId: 'mail' }).records.map(r => r.values.subject), ['fresh']);
  assert.ok(!JSON.stringify(service.store.read('one')).includes('mail-secret-body'));
  // Real phone event discovery and replay do not resurrect deleted local messages.
  const event = { chatId: 'oc_lifecycle', messageId: 'event-1', body: 'event-secret-body', sender: 'person' };
  service.start();
  service.receiveFeishuMessage('one', event, { type: 'p2p', name: 'Person' });
  const message = service.query('one', { appId: 'messages' }).records[0];
  await call('messages', 'remove', { id: message.id, expectedRevision: message.revision });
  service.stop();
  service = createService(options);
  service.start();
  service.receiveFeishuMessage('one', event, { type: 'p2p', name: 'Person' });
  assert.equal(service.query('one', { appId: 'messages' }).total, 0);
  service.receiveFeishuMessage('one', { ...event, messageId: 'event-2', body: 'fresh' }, { type: 'p2p', name: 'Person' });
  assert.equal(service.query('one', { appId: 'messages' }).total, 1);
  assert.ok(!JSON.stringify(service.store.read('one')).includes('event-secret-body'));
  service.stop();
  // Hold actual delivery failures so pending source events exist at unsubscribe.
  let delivered = 0;
  const pendingOptions = { ...options, root: path.join(folder, 'pending'), deliver: async () => { delivered++; throw Error('offline'); } };
  const pending = createService(pendingOptions);
  const pendingCall = (commandId, params) => pending.execute('one', { appId: 'rss', commandId, params }, { kind: 'human' });
  const pendingFeed = (await pendingCall('subscribe', { values: { title: 'Pending', url: 'https://example.com/pending' } })).record;
  await pendingCall('sync', { id: pendingFeed.id });
  await pendingCall('remove-feed', { id: pendingFeed.id, expectedRevision: pendingFeed.revision });
  await pending.tick();
  assert.equal(delivered, 0, 'unsubscribing prevents not-yet-submitted source notifications');
  assert.equal(pending.query('one', { appId: 'rss', collection: 'articles' }).total, 2, 'unsubscribe retains articles');

  // A real multi-mail sync produces one batch; deleting one item preserves its sibling.
  const mixedDeliveries = [];
  const mixed = createService({ ...options, root: path.join(folder, 'mixed'), deliver: async (_ws, event) => { mixedDeliveries.push(event); return { messageId: event.id }; } });
  mixed.store.transact('one', state => state.connections.push({ ...structuredClone(service.store.read('one').connections.find(c => c.id === 'mailbox')) }));
  await mixed.execute('one', { appId: 'mail', commandId: 'sync', params: { accountId: 'mailbox' } }, { kind: 'human' });
  const mixedRecords = mixed.query('one', { appId: 'mail' }).records;
  const removedMail = mixedRecords.find(r => r.values.messageId === 'mail-1');
  const keptMail = mixedRecords.find(r => r.values.messageId === 'mail-2');
  await mixed.execute('one', { appId: 'mail', commandId: 'remove', params: { id: removedMail.id, expectedRevision: removedMail.revision } }, { kind: 'human' });
  await mixed.tick();
  assert.equal(mixedDeliveries.length, 1);
  assert.deepEqual(mixedDeliveries[0].recordIds, [keptMail.id]);
  // Shared source batches also preserve articles from unrelated subscriptions.
  const sourceOptions = { ...options, root: path.join(folder, 'mixed-feeds'), deliver: async (_ws, event) => { mixedDeliveries.push(event); return { messageId: event.id }; } };
  const sources = createService(sourceOptions);
  const sourceCall = (commandId, params) => sources.execute('one', { appId: 'rss', commandId, params }, { kind: 'human' });
  const firstFeed = (await sourceCall('subscribe', { values: { title: 'First', url: 'https://example.com/first' } })).record;
  const secondFeed = (await sourceCall('subscribe', { values: { title: 'Second', url: 'https://example.com/second' } })).record;
  await sourceCall('sync', {});
  const sourceRecords = sources.query('one', { appId: 'rss', collection: 'articles' }).records;
  // Model a coalesced host batch with both subscriptions represented.
  sources.store.transact('one', state => { state.outbox[0].recordIds = sourceRecords.map(r => r.id); state.outbox = [state.outbox[0]]; });
  await sourceCall('remove-feed', { id: firstFeed.id, expectedRevision: firstFeed.revision });
  await sources.tick();
  assert.deepEqual(mixedDeliveries.at(-1).recordIds.sort(), sourceRecords.filter(r => r.values.sourceId === secondFeed.id).map(r => r.id).sort());
  // Cancel/set does not silently replay an already delivered overdue occurrence.
  let reminderClock = Date.now(), reminderDeliveries = 0;
  const reminderService = createService({ ...options, root: path.join(folder, 'restored-reminder'), now: () => reminderClock, deliver: async (_ws, event) => { reminderDeliveries++; return { messageId: event.id }; } });
  const reminderCall = (commandId, params) => reminderService.execute('one', { appId: 'reminders', commandId, params }, { kind: 'human' });
  let reminder = (await reminderCall('set', { values: { title: 'One shot', dueAt: new Date(reminderClock - 1).toISOString() } })).record;
  await reminderService.tick();
  assert.equal(reminderDeliveries, 1);
  reminder = reminderService.query('one', { appId: 'reminders', id: reminder.id }).record;
  reminder = (await reminderCall('cancel', { id: reminder.id, expectedRevision: reminder.revision })).record;
  await assert.rejects(reminderCall('set', { id: reminder.id, expectedRevision: reminder.revision, values: { note: 'restore' } }), /explicit dueAt/);
  await reminderService.tick();
  assert.equal(reminderDeliveries, 1);
  reminder = (await reminderCall('set', { id: reminder.id, expectedRevision: reminder.revision, values: { dueAt: new Date(reminderClock + 1000).toISOString() } })).record;
  await reminderService.tick();
  assert.equal(reminderDeliveries, 1);
  reminderClock += 1001;
  await reminderService.tick();
  assert.equal(reminderDeliveries, 2);
  // Capacity comes from real deletions. Keep this in a memory-only store to avoid 10k disk rewrites.
  const bounded = createService({ ...options, root: path.join(folder, 'bounded') });
  let boundedState = structuredClone(bounded.store.read('one'));
  bounded.store.read = () => boundedState;
  bounded.store.transact = (_ws, fn) => fn(boundedState);
  boundedState.installations.push({ definition: app, enabled: true, installedAt: 1 });
  boundedState.records.notes = Array.from({ length: 10001 }, (_, i) => ({ id: 'bounded-' + i, collection: 'items', revision: 1, createdAt: 1, updatedAt: 1, values: { title: 'record' } }));
  for (let i = 0; i < 10001; i++) await bounded.execute('one', { appId: 'notes', commandId: 'remove', params: { id: 'bounded-' + i, expectedRevision: 1 } }, { kind: 'human' });
  assert.equal(boundedState.deletions.length, 10000);
  assert.equal(new Set(boundedState.deletions).size, 10000);
  assert.equal(boundedState.records.notes.length, 0);
  // Built-in migration keeps both account policy and existing custom definitions.
  service.store.transact('one', state => {
    state.installations.find(a => a.definition.id === 'mail').definition.version = 1;
    state.installations.find(a => a.definition.id === 'mail').enabled = false;
    state.installations.push({ definition: { ...app, version: 1, commands: app.commands.filter(c => c.id !== 'remove'), views: [{ ...app.views[0], commands: ['create', 'update'] }] }, enabled: false, installedAt: 42 });
  });
  // The persisted contract is JSON: optional properties with undefined are omitted on disk.
  const prior = JSON.parse(JSON.stringify(service.store.read('one')));
  service = createService(options);
  const migrated = service.store.read('one');
  assert.deepEqual(migrated.records, prior.records);
  assert.deepEqual(migrated.connections, prior.connections);
  assert.equal(migrated.installations.find(a => a.definition.id === 'mail').enabled, false);
  assert.deepEqual(migrated.installations.find(a => a.definition.id === 'notes'), prior.installations.find(a => a.definition.id === 'notes'));

  const cross = structuredClone(fixed);
  cross.collections.push({ ...structuredClone(app.collections[0]), id: 'other-items' });
  cross.commands.push({ id: 'remove-other', title: 'Delete', handler: 'records.remove', collection: 'other-items' }, { id: 'restore-other', title: 'Restore', handler: 'records.update', collection: 'other-items', patch: { done: false } });
  cross.views.push({ id: 'other-view', title: 'Other', kind: 'list', collection: 'other-items', commands: ['remove-other', 'restore-other'] });
  assert.throws(() => validateAppDefinition(cross), /items.*complete.*reverse/);
  const mailDefinition = structuredClone(service.store.read('one').installations.find(a => a.definition.id === 'mail').definition);
  mailDefinition.commands = mailDefinition.commands.filter(c => !['unread', 'unprocessed'].includes(c.id));
  mailDefinition.views[0].commands = mailDefinition.views[0].commands.filter(id => !['unread', 'unprocessed'].includes(id));
  assert.throws(() => validateAppDefinition(mailDefinition), /reverse/, 'draft-only update cannot restore received or sent mail status');
  const multi = structuredClone(fixed);
  multi.collections[0].fields.push({ id: 'saved', label: 'Saved', type: 'boolean' });
  multi.commands.find(c => c.id === 'complete').patch.saved = true;
  multi.commands.push({ id: 'reopen', title: 'Reopen', handler: 'records.update', collection: 'items', patch: { done: false } });
  multi.views[0].commands.push('reopen');
  assert.throws(() => validateAppDefinition(multi), /reverse/);
  multi.commands.find(c => c.id === 'reopen').patch.saved = false;
  assert.doesNotThrow(() => validateAppDefinition(multi));
  const textState = structuredClone(fixed);
  textState.commands.find(c => c.id === 'complete').patch = { title: 'fixed' };
  textState.commands.push({ id: 'other', title: 'Other', handler: 'records.update', collection: 'items', patch: { title: 'other' } });
  textState.views[0].commands.push('other');
  assert.throws(() => validateAppDefinition(textState), /reverse/);

  // A clean-break SQLite schema error is persistent until the workspace is reset.
  // The background loop reports it once and stops retrying every two seconds.
  const schemaErrors = [];
  const originalError = console.error;
  console.error = (...args) => { if (String(args[0]).includes('[agentApps] workspace background')) schemaErrors.push(args); };
  try {
    const broken = createService({ ...options, root: path.join(folder, 'broken-background'), storeFactory: () => ({
      read() { throw new Error('App SQLite database schema is incomplete'); },
      transact() { throw new Error('App SQLite database schema is incomplete'); },
      close() {}
    }) });
    await broken.tick();
    await broken.tick();
    assert.equal(schemaErrors.length, 1, 'persistent schema errors must not be logged on every background tick');
    assert.match(String(schemaErrors[0][0]), /disabled until restart/);
  } finally { console.error = originalError; }
  console.log('agent apps lifecycle regression passed');

} finally { for (const service of services) service.store.close?.(); fs.rmSync(folder, { recursive: true, force: true }); }
