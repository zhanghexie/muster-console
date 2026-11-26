import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-notifications-'));
const services = [];
try {
  const output = path.join(tmp, 'test.cjs');
  await build({ stdin: { contents: `
    export { AgentAppsService } from './src/main/agentApps/service';
    export { hostNotificationDelivery } from './src/main/messages/hostNotifications';
    export { sendHostNotification } from './src/main/agent/providers/hostNotification';
    export { MailboxWakes } from './src/main/messages/wake';
    export { deliverAgentMessage } from './src/main/messages/deliver';
    export { readMailbox } from './src/main/messages/read';
    export { sendMailboxWake } from './src/main/messages/transport';
    export * from './src/main/metaAgent/messageStore';
    export { readMailPresentations } from './src/shared/mailReadPresentation';
    export { applyLocaleSetting } from './src/shared/i18n';
  `, resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    banner: { js: `var require = require('node:module').createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` }, logLevel: 'silent' });
  const api = require(output);
  const createService = options => { const service = new api.AgentAppsService(options); services.push(service); return service; };
  api.setAgentMessagesUserDataDir(tmp);
  let now = Date.now(), articles = [];
  const actor = { kind: 'agent', runId: 'test' };
  const options = { root: path.join(tmp, 'apps'), workspaces: () => ['one', 'two'], now: () => now,
    emit() {}, encrypt: x => x, decrypt: x => x, confirmSend: async () => true,
    deliver: async () => ({ messageId: 'durable' }),
    connectors: { feed: async () => articles, test: async () => {}, sync: async () => ({ records: [], cursor: {} }) } };
  let service = createService(options);
  const ctx = { agentApps: service, workspaces: { list: () => [{ id: 'one', path: tmp }, { id: 'two', path: tmp }] },
    sessions: { get: () => undefined, list: () => [], broadcastMessagesChanged() {} } };
  const call = (commandId, params, appId = 'rss') => service.execute('one', { appId, commandId, params }, actor);
  const feed = (await call('subscribe', { values: { title: 'OpenAI News', url: 'https://example.com/rss', notify: 'wake', notificationHint: '关注 API 兼容性；重要时说明影响' } })).record;
  articles = Array.from({ length: 3 }, (_, i) => ({ externalId: `old-${i}`, title: `历史 ${i}`, content: '历史内容', url: `https://example.com/old/${i}` }));
  await call('sync', { id: feed.id });
  let state = service.store.read('one');
  assert.equal(state.outbox[0].kind, 'rss.imported');
  assert.equal(state.outbox[0].action, 'digest', 'initial history must not wake even a wake subscription');
  state.outbox[0].recordIds.forEach(id => { const r = state.records.rss.find(r => r.id === id); r.values.processed = true; });
  articles = Array.from({ length: 3 }, (_, i) => ({ externalId: `new-${i}`, title: `API 更新 ${i}`, content: '这次有用的新内容', publishedAt: '2026-10-24', url: `https://example.com/new/${i}` }));
  await call('sync', { id: feed.id });
  const event = service.store.read('one').outbox.at(-1);
  const stored = await api.appendAgentMessageToStore(tmp, 'one', { from: 'host', to: 'orchestrator:one', kind: 'notice', text: event.title, ts: now, receipt: 'stored',
    meta: { hostNotification: { kind: 'app', appId: 'rss', eventId: event.id } } });
  let delivery = api.hostNotificationDelivery(ctx, 'one');
  let batch = await delivery.prepare();
  assert.equal(batch.summary, '收到 3 条 RSS 更新');
  ctx.agentApps = { notifications: async (...args) => { await Promise.resolve(); return service.notifications(...args); } };
  assert.equal((await delivery.prepare()).summary, '收到 3 条 RSS 更新', 'worker-backed async notification reads remain supported');
  ctx.agentApps = service;
  try {
    api.applyLocaleSetting('en');
    assert.equal((await delivery.prepare()).summary, 'RSS updates received: 3');
  } finally { api.applyLocaleSetting('zh-CN'); }
  assert.match(batch.content, /这次有用的新内容/);
  assert.match(batch.content, /关注 API 兼容性/);
  assert.match(batch.content, /expectedRevision/);
  assert.match(batch.content, /publishedAt/);
  assert.match(batch.content, /host\.apps\.run/);
  assert.doesNotMatch(batch.content, /sessions.readMessages|workspaceId|sourceSessionId|subscriptionIds/);
  assert.ok(batch.content.length < 4000, `three self-contained records: ${batch.content.length} chars`);
  assert.ok(!batch.summary.includes('API 更新'));
  assert.equal(await api.hostNotificationDelivery(ctx, 'two').prepare(), null, 'workspace scoped');
  await assert.rejects(call('edit-feed', { id: feed.id, expectedRevision: 1, values: { notificationHint: 'a'.repeat(2001) } }), /2000/);

  // Native channel persists hidden content, emits only a summary, and still runs prompt preflight.
  const listeners = new Set(), entries = [], shown = [], prompts = [], custom = [];
  const session = { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    sessionManager: { getEntries: () => entries },
    async sendCustomMessage(message, opts) {
      assert.equal(opts.triggerTurn, false, 'preserve normal prompt preflight/mode hooks');
      custom.push(message);
      entries.push({ type: 'custom_message', ...message });
      for (const fn of listeners) fn({ type: 'message_end', message });
    },
    async prompt(text, options) { prompts.push({ text, options }); }
  };
  let noHistoryAccepted = false;
  await assert.rejects(api.sendHostNotification({ ...session, sessionManager: undefined }, {
    prepare: () => ({ ids: ['missing-history'], summary: 'missing', content: 'event' }),
    accepted: () => { noHistoryAccepted = true; }
  }, () => {}, true), /无法核验 PI 会话历史/);
  assert.equal(noHistoryAccepted, false, 'an event without readable native history is not a durable receipt');
  custom.length = 0;
  assert.equal(await api.sendHostNotification(session, delivery, (summary, id) => shown.push({ summary, id }), true), true);
  assert.equal(custom[0].display, false);
  assert.equal(shown[0].summary, '收到 3 条 RSS 更新');
  assert.deepEqual(Object.keys(shown[0]).sort(), ['id', 'summary']);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].options.expandPromptTemplates, false);
  assert.equal(await delivery.prepare(), null, 'consumed notification does not reappear');
  const consumed = api.readAgentMessageLedger(tmp, 'one').messages.find(m => m.id === stored.id);
  assert.ok(consumed.read && consumed.notifiedAt);
  const fact = await api.appendAgentMessageToStore(tmp, 'one', { from: 'host', to: 'orchestrator:one', kind: 'notice',
    text: JSON.stringify({ eventType: 'session.phase', sourceSessionId: 'fixture-session', summary: 'changed' }), ts: now,
    receipt: 'stored', meta: { hostNotification: { kind: 'event', eventId: 'fixture-fact' } } });
  const factDelivery = api.hostNotificationDelivery(ctx, 'one', [fact.id]);
  const factBatch = await factDelivery.prepare();
  assert.match(factBatch.content, /host\.sessions\.observe/);
  await factDelivery.accepted(factBatch);
  const subscription = await api.appendAgentMessageToStore(tmp, 'one', { from: 'host', to: 'orchestrator:one', kind: 'notice',
    text: JSON.stringify({ type: 'event-subscription', source: 'fixture', eventType: 'fixture.changed', data: { eventId: 'fixture-event' } }), ts: now,
    receipt: 'stored', meta: { hostNotification: { kind: 'event', eventId: 'fixture-event' } } });
  const subscriptionDelivery = api.hostNotificationDelivery(ctx, 'one', [subscription.id]);
  const subscriptionBatch = await subscriptionDelivery.prepare();
  assert.match(subscriptionBatch.content, /host\.events\.read/);
  await subscriptionDelivery.accepted(subscriptionBatch);
  assert.notEqual(service.query('one', { appId: 'rss', id: event.recordIds[0] }).record.values.processed, true, 'context consumption is not processing');
  service = createService(options); ctx.agentApps = service;
  assert.equal(await api.hostNotificationDelivery(ctx, 'one').prepare(), null, 'restart does not redeliver');

  // Pending bodies are recalculated: processed records and disabled/deleted sources cannot wake.
  const more = await api.appendAgentMessageToStore(tmp, 'one', { from: 'host', to: 'orchestrator:one', kind: 'notice', text: event.title, ts: now,
    receipt: 'stored', meta: { notificationKey: `app:${event.id}` } });
  const record = service.query('one', { appId: 'rss', id: event.recordIds[0] }).record;
  await call('processed', { id: record.id, expectedRevision: record.revision });
  assert.equal((await api.hostNotificationDelivery(ctx, 'one', [more.id]).prepare()).summary, '收到 2 条 RSS 更新');
  const currentFeed = service.query('one', { appId: 'rss', collection: 'feeds', id: feed.id }).record;
  let releaseRead;
  const delayedRead = new Promise(resolve => { releaseRead = resolve; });
  ctx.agentApps = { notifications: async (...args) => { await delayedRead; return service.notifications(...args); } };
  const preparingDuringCancellation = api.hostNotificationDelivery(ctx, 'one', [more.id]).prepare();
  await call('edit-feed', { id: feed.id, expectedRevision: currentFeed.revision, values: { enabled: false } });
  releaseRead();
  assert.equal(await preparingDuringCancellation, null, 'a delayed worker read rechecks a cancellation before building the model input');
  ctx.agentApps = service;
  assert.equal(await api.hostNotificationDelivery(ctx, 'one', [more.id]).prepare(), null);
  await new Promise(resolve => setImmediate(resolve));

  // Exact batch reading has a stable member order, survives updates, and cannot query another app/workspace.
  const feedNow = service.query('one', { appId: 'rss', collection: 'feeds', id: feed.id }).record;
  await call('edit-feed', { id: feed.id, expectedRevision: feedNow.revision, values: { enabled: true } });
  const page = service.query('one', { appId: 'rss', notificationId: event.id, offset: 1, limit: 1 });
  assert.equal(page.records[0].id, event.recordIds[1]);
  assert.throws(() => service.query('two', { appId: 'rss', notificationId: event.id }), /Notification not found/);
  assert.throws(() => service.query('one', { appId: 'mail', notificationId: event.id }), /Notification not found/);

  // Large batches contain content, a bounded set of actionable IDs, and one exact continuation.
  articles = Array.from({ length: 200 }, (_, i) => ({ externalId: `bulk-${i}`, title: `条目 ${i}`, content: '长内容'.repeat(3000) }));
  await call('sync', { id: feed.id });
  const bulk = service.store.read('one').outbox.at(-1);
  const material = service.notification('one', bulk.id);
  assert.ok(JSON.stringify(material.payload).length < 9000);
  assert.ok(material.payload.data.length < 10);
  assert.equal(material.payload.next.params.notificationId, bulk.id);
  assert.equal(material.payload.next.params.offset, material.payload.data.length, 'continue after the supplied records');
  assert.ok(material.payload.data[0].truncated.includes('content'));
  assert.equal(material.summary, '收到 200 条 RSS 更新');
  const continuation = service.query('one', { appId: 'rss', ...material.payload.next.params });
  assert.ok(JSON.stringify(continuation).length < 14000, 'batch reads also keep a context budget');
  assert.ok(continuation.truncated[continuation.records[0].id].includes('content'));
  assert.equal(continuation.nextOffset, material.payload.next.params.offset + continuation.records.length);
  const deletedId = bulk.recordIds[continuation.nextOffset - 1];
  service.store.transact('one', s => { s.records.rss = s.records.rss.filter(r => r.id !== deletedId); });
  assert.equal(service.query('one', { appId: 'rss', notificationId: bulk.id, offset: continuation.nextOffset, limit: 1 }).records[0].id,
    bulk.recordIds[continuation.nextOffset], 'earlier deletion does not shift the continuation');

  // Generic Agent letters remain normal mail; host events cannot leak through old read-mail cards.
  const letter = await api.appendAgentMessageToStore(tmp, 'one', { from: 'worker', to: 'orchestrator:one', kind: 'notice', text: '已完成修改', ts: now, receipt: 'stored' });
  const result = await api.readMailbox(ctx, {}, { id: 'orchestrator:one', hostView: false, workspaceId: 'one' });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, letter.id);
  assert.equal(api.readMailPresentations([{ name: 'sessions.readMessages', status: 'ok', result: JSON.stringify({ messages: [{ ...stored, read: true, text: '不应显示' }] }) }]).length, 0);

  const bulkStored = await api.appendAgentMessageToStore(tmp, 'one', { from: 'host', to: 'orchestrator:one', kind: 'notice', text: bulk.title, ts: now,
    receipt: 'stored', meta: { hostNotification: { kind: 'app', appId: 'rss', eventId: bulk.id } } });
  let busy = true, wakesSent = 0;
  const wakes = new api.MailboxWakes(ctx, async (_ctx, _recipient, _ws, text, _id, needed, opts) => {
    if (busy) return false;
    assert.equal(needed(), true);
    assert.equal(text, '', 'host-only wake has no mailbox detour');
    assert.ok(opts.notification);
    wakesSent++;
    await api.sendHostNotification(session, opts.notification, () => {}, true);
    return true;
  });
  try {
    await wakes.flush('orchestrator:one', 'one');
    assert.equal(api.readAgentMessageLedger(tmp, 'one').messages.find(m => m.id === bulkStored.id).notifiedAt, undefined);
    busy = false;
    await wakes.flush('orchestrator:one', 'one');
    assert.equal(wakesSent, 1);
    assert.ok(api.readAgentMessageLedger(tmp, 'one').messages.find(m => m.id === bulkStored.id).read);
    await wakes.flush('orchestrator:one', 'one');
    assert.equal(wakesSent, 1);
  } finally { wakes.dispose(); }

  // Ambiguous SDK submission is retained for diagnosis, never automatically retried.
  let uncertain = 0;
  const uncertainDelivery = { prepare: () => ({ ids: ['x'], content: 'payload', summary: '提示' }), accepted: () => assert.fail('not acknowledged'), uncertain: () => { uncertain++; } };
  await assert.rejects(api.sendHostNotification({ subscribe: () => () => {}, sendCustomMessage: async () => { throw new Error('lost ACK'); } }, uncertainDelivery, () => {}, true), /lost ACK/);
  assert.equal(uncertain, 1);
  await assert.rejects(api.sendHostNotification(session, { ...uncertainDelivery,
    accepted: async () => { throw new Error('receipt storage unavailable'); }
  }, () => assert.fail('no success display before durable receipt'), true), /receipt storage unavailable/);
  assert.equal(uncertain, 2, 'a failed durable receipt after PI submission is also ambiguous');
  await assert.rejects(api.sendHostNotification({ ...session, prompt: async () => { throw new Error('model offline'); } },
    { ...uncertainDelivery, accepted() {} }, () => {}, true), /model offline/);
  assert.equal(uncertain, 2, 'a failed model request after context receipt must not replay the batch');
  let promptCount = 0;
  await api.sendHostNotification({ ...session, prompt: async () => { promptCount++; } }, { prepare: () => null, accepted() {} }, () => {}, true);
  assert.equal(promptCount, 0, 'cancelled batch never opens a model loop');

  let admission, resolved = false;
  ctx.orchestrator = { isBusy: () => false, send: async (_text, _ws, _images, options) => { admission = options; options.beforeStart(); } };
  const transport = api.sendMailboxWake(ctx, 'orchestrator:one', 'one', '', 'pending-host', () => true,
    { prepare: () => ({ ids: [], content: 'internal', summary: '提示' }), accepted: async () => {} }).then(value => { resolved = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false, 'autonomy gate admission alone is not a context ACK');
  await admission.notification.accepted({ ids: [], content: 'internal', summary: '提示' });
  assert.equal(await transport, true);
  const failedAdmission = api.sendMailboxWake(ctx, 'orchestrator:one', 'one', '', 'failed-host', () => true,
    { prepare: () => null, accepted() {} });
  await new Promise(resolve => setImmediate(resolve));
  admission.notification.settled();
  assert.equal(await failedAdmission, false, 'preflight failure remains pending for bounded queue retry');
  console.log('host-notifications: native hidden input + preflight, dense payload, first import, replay, workspace, stale cancellation, batch query and ordinary mail passed');
} finally { for (const service of services) service.store.close?.(); fs.rmSync(tmp, { recursive: true, force: true }); }
