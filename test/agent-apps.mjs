import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-apps-test-'));
const bundle = (file, name) => { const target = path.join(folder, `${name}.cjs`); buildSync({ entryPoints: [path.join(root, file)], outfile: target, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' }); return require(target); };
const sqliteStores = [];
try {
  const { AgentAppsService } = bundle('src/main/agentApps/service.ts', 'service');
  const SqliteStore = bundle('src/main/agentApps/sqliteStateStore.ts', 'sqlite-store').AgentAppsSqliteStateStore;
  const { defineRecordApp, validateAppDefinition } = bundle('src/shared/agentApps.ts', 'contract');
  const { createAppConnectors, parseFeed, isPublicAddress, fetchFeed } = bundle('src/main/agentApps/connectors.ts', 'connectors');
  const { assertCredentialStorage } = bundle('src/main/agentApps/credentialPolicy.ts', 'credential-policy');
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.throws(() => assertCredentialStorage(false, platform), /密码未保存/);
    assert.doesNotThrow(() => assertCredentialStorage(true, platform, 'gnome_libsecret'));
  }
  assert.throws(() => assertCredentialStorage(true, 'linux', 'basic_text'), /密码未保存/);
  assert.doesNotThrow(() => assertCredentialStorage(true, 'linux', 'kwallet6'));
  let now = Date.now(), confirm = true, sent = 0, failSend = false, releaseSend;
  const delivered = new Set(), emitted = [];
  const options = { authorizeDefinition: async () => true, root: path.join(folder, 'data'), workspaces: () => ['one', 'two'], now: () => now,
    storeFactory: (storeRoot, seed) => { const store = new SqliteStore(storeRoot, seed); sqliteStores.push(store); return store; },
    emit: (_kind, event) => emitted.push(event), encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString(),
    confirmSend: async () => confirm, deliver: async (ws, event) => { delivered.add(`${ws}:${event.id}`); return { messageId: event.id }; },
    connectors: { feed: async () => [{ title: '文章', externalId: 'first', content: '正文' }], test: async () => {}, sync: async (_c, _s, cursor) => ({ records: [{ subject: '来信', body: '外部消息', messageId: 'm1', uid: '1:1', folder: 'inbox', from: 'author@example.com' }], cursor: { n: Number(cursor.n ?? 0) + 1 } }),
      send: async () => { sent++; if (releaseSend) await new Promise(resolve => { releaseSend = resolve; }); if (failSend) throw Error('timeout'); return { messageId: 'sent-1' }; } }
  };
  let service = new AgentAppsService(options);
  const actor = { kind: 'agent', runId: 'turn1' }, call = (appId, commandId, params = {}, requestId) => service.execute('one', { appId, commandId, params, requestId }, actor);
  assert.equal(service.snapshot('one').apps.length, 4);
  const custom = defineRecordApp({ id: 'research-notes', name: '研究记录', fields: [{ id: 'title', label: '标题', type: 'text', required: true }], titleField: 'title' });
  let releaseApproval;
  options.authorizeDefinition = async () => new Promise(resolve => { releaseApproval = resolve; });
  const installing = service.install('one', custom);
  assert.equal(service.snapshot('one').apps.some(app => app.definition.id === custom.id), false, 'no installation before approval');
  releaseApproval(false);
  await assert.rejects(installing, /approval denied/);
  assert.equal(service.snapshot('one').apps.some(app => app.definition.id === custom.id), false);
  options.authorizeDefinition = async () => true;
  await service.install('one', custom);
  let repeatedReviews = 0;
  options.authorizeDefinition = async () => { repeatedReviews++; return true; };
  await service.setEnabled('one', custom.id, false);
  await service.setEnabled('one', custom.id, true);
  assert.equal(repeatedReviews, 0, 'same approved App definition can be re-enabled without review');

  await assert.rejects(() => service.install('one', { ...custom, commands: custom.commands.map((c, i) => i ? c : { ...c, presentation: { viewId: 'missing' } }) }), /Presentation/);
  assert.throws(() => validateAppDefinition({ ...custom, views: [{ id: 'main', title: '坏页面', kind: 'custom', html: '<p>没有 SDK</p>' }] }), /onPresent/);
  assert.throws(() => validateAppDefinition({ ...custom, collections: [{ ...custom.collections[0], titleField: undefined }] }), /titleField/);
  const note = (await call(custom.id, 'create', { values: { title: '工具驱动创建' } }, 'create1')).record;
  assert.equal((await call(custom.id, 'create', { values: { title: '工具驱动创建' } }, 'create1')).record.id, note.id);
  await assert.rejects(call(custom.id, 'update', { id: note.id, expectedRevision: 0, values: { title: 'stale' } }), /changed/);
  assert.equal(service.query('one', { appId: custom.id }).records.length, 1);
  assert.throws(() => service.query('two', { appId: custom.id }), /not installed/);
  const task = (await call('tasks', 'create', { values: { title: '需要完成' } })).record;
  await call('reminders', 'set', { values: { title: '关联提醒', dueAt: new Date(now + 10).toISOString(), targetApp: 'tasks', targetId: task.id } });
  await call('tasks', 'complete', { id: task.id, expectedRevision: 1 });
  await service.execute('two', { appId: 'reminders', commandId: 'set', params: { values: { title: '另一区到期', dueAt: new Date(now + 10).toISOString() } } }, actor);
  service = new AgentAppsService(options); now += 100;
  await service.tick(); await service.tick();
  assert.equal(delivered.size, 1); assert.ok([...delivered][0].startsWith('two:'));
  assert.equal(service.query('one', { appId: custom.id }).records[0].id, note.id, 'data survives restart');
  const reminderDefinition = service.snapshot('one').apps.find(a => a.definition.id === 'reminders').definition;
  assert.ok(reminderDefinition.views[0].commands.includes('remove'), 'reminders expose deletion in their app view');
  let removedDeliveries = 0;
  const removeOptions = { ...options, root: path.join(folder, 'remove-reminders'), deliver: async () => { removedDeliveries++; return {}; } };
  let removeService = new AgentAppsService(removeOptions);
  const removeCall = (commandId, params) => removeService.execute('one', { appId: 'reminders', commandId, params }, actor);
  const repeating = (await removeCall('set', { values: { title: '删除循环提醒', dueAt: new Date(now + 10).toISOString(), repeatMinutes: 1 } })).record;
  await assert.rejects(removeCall('remove', { id: repeating.id, expectedRevision: 0 }), /changed/);
  assert.equal(removeService.store.read('one').jobs[0].enabled, true, 'failed deletion leaves job intact');
  await removeCall('remove', { id: repeating.id, expectedRevision: repeating.revision });
  assert.equal(removeService.query('one', { appId: 'reminders' }).total, 0);
  assert.equal(removeService.store.read('one').jobs[0].enabled, false, 'deletion disables the reminder itself');
  assert.equal(removeService.store.read('one').operations.at(-1).entityId, undefined, 'deleted record must not reopen a missing detail page');
  removeService = new AgentAppsService(removeOptions); now += 100;
  await removeService.tick(); assert.equal(removedDeliveries, 0, 'deleted repeat job stays stopped after restart');
  const pendingDelete = (await removeCall('set', { values: { title: '删除待投递提醒', dueAt: new Date(now - 1).toISOString() } })).record;
  const deleteWarn = console.warn; console.warn = () => {}; try { await removeService.tick(); } finally { console.warn = deleteWarn; }
  assert.equal(removedDeliveries, 1);
  const pendingDeleteNow = removeService.query('one', { appId: 'reminders', id: pendingDelete.id }).record;
  await removeCall('remove', { id: pendingDelete.id, expectedRevision: pendingDeleteNow.revision });
  assert.equal(removeService.store.read('one').outbox[0].action, 'mute');
  removeService = new AgentAppsService(removeOptions); now += 10000; await removeService.tick();
  assert.equal(removedDeliveries, 1, 'deletion also stops pending notification retries');
  const removedTarget = (await removeService.execute('one', { appId: 'tasks', commandId: 'create', params: { values: { title: '已移除的关联待办' } } }, actor)).record;
  const orphan = (await removeCall('set', { values: { title: '解除关联提醒', dueAt: new Date(now + 10).toISOString(), targetApp: 'tasks', targetId: removedTarget.id } })).record;
  await removeService.execute('one', { appId: 'tasks', commandId: 'remove', params: { id: removedTarget.id, expectedRevision: removedTarget.revision } }, actor);
  assert.equal((await removeCall('cancel', { id: orphan.id, expectedRevision: orphan.revision })).record.values.enabled, false, 'cancellation works even after linked target deletion');
  // Existing workspaces receive additive built-in upgrades without resetting their records or preferences.
  const beforeUpgrade = structuredClone(service.store.read('one'));
  service.store.transact('one', state => {
    const app = state.installations.find(a => a.definition.id === 'reminders');
    app.definition.version = 1; app.definition.commands = app.definition.commands.filter(c => c.id !== 'remove');
    app.definition.views[0].commands = app.definition.views[0].commands.filter(id => id !== 'remove'); app.enabled = false;
    app.approvedDefinition = 'obsolete-built-in-fingerprint';
  });
  service = new AgentAppsService(options);
  const upgraded = service.store.read('one'), upgradedReminder = upgraded.installations.find(a => a.definition.id === 'reminders');
  assert.ok(upgradedReminder.definition.views[0].commands.includes('remove'));
  assert.equal(upgradedReminder.enabled, false);
  assert.deepEqual(upgraded.records, beforeUpgrade.records);
  assert.deepEqual(upgraded.jobs, beforeUpgrade.jobs);
  assert.deepEqual(upgraded.installations.find(a => a.definition.id === custom.id), beforeUpgrade.installations.find(a => a.definition.id === custom.id));
  service = new AgentAppsService(options);
  assert.ok(service.snapshot('one').apps.find(a => a.definition.id === 'reminders').definition.views[0].commands.includes('remove'));
  const reviewerBeforeBuiltinEnable = options.authorizeDefinition;
  options.authorizeDefinition = async () => { throw new Error('built-in upgrade unexpectedly reviewed'); };
  await service.setEnabled('one', 'reminders', true);
  options.authorizeDefinition = reviewerBeforeBuiltinEnable;
  let deliveryFails = true, attempts = 0;
  const pendingOptions = { ...options, root: path.join(folder, 'pending'), deliver: async () => { attempts++; if (deliveryFails) throw Error('mailbox temporarily unavailable'); return { messageId: 'stored-notice' }; } };
  let pendingService = new AgentAppsService(pendingOptions);
  await pendingService.execute('one', { appId: 'reminders', commandId: 'set', params: { values: { title: '事务通知', dueAt: new Date(now - 1).toISOString() } } }, actor);
  const pendingWarn = console.warn; console.warn = () => {}; await pendingService.tick(); console.warn = pendingWarn;
  assert.equal(pendingService.store.read('one').outbox[0].deliveredAt, undefined);
  deliveryFails = false; now += 10_000; pendingService = new AgentAppsService(pendingOptions); await pendingService.tick(); await pendingService.tick();
  assert.equal(attempts, 2); assert.equal(pendingService.store.read('one').outbox[0].messageId, 'stored-notice');
  const cancelService = new AgentAppsService({ ...options, root: path.join(folder, 'cancel'), deliver: async () => ({}) });
  const alarm = (await cancelService.execute('one', { appId: 'reminders', commandId: 'set', params: { values: { title: '取消待投递通知', dueAt: new Date(now - 1).toISOString() } } }, actor)).record;
  console.warn = () => {}; try { await cancelService.tick(); } finally { console.warn = pendingWarn; }
  assert.equal(cancelService.store.read('one').outbox[0].deliveredAt, undefined, 'an in-memory acceptance is not a durable acknowledgement');
  const alarmNow = cancelService.query('one', { appId: 'reminders', id: alarm.id }).record;
  await cancelService.execute('one', { appId: 'reminders', commandId: 'cancel', params: { id: alarm.id, expectedRevision: alarmNow.revision } }, actor);
  now += 10_000; await cancelService.tick();
  assert.equal(cancelService.store.read('one').outbox[0].action, 'mute'); assert.ok(cancelService.store.read('one').outbox[0].deliveredAt);
  // F-01 outbox 滚动保留：已投递且超 7 天的事件被裁剪；未投递事件永不清除
  {
    let retainNow = Date.now(), retainFail = false;
    const retainOptions = { ...options, root: path.join(folder, 'outbox-retain'), now: () => retainNow,
      deliver: async () => { if (retainFail) throw Error('mailbox down'); return { messageId: 'retained-1' }; } };
    let retainService = new AgentAppsService(retainOptions);
    await retainService.execute('one', { appId: 'reminders', commandId: 'set', params: { values: { title: '滚动保留已投递', dueAt: new Date(retainNow - 1).toISOString() } } }, actor);
    await retainService.tick();
    assert.equal(retainService.store.read('one').outbox.filter(e => e.deliveredAt).length, 1, '先投递成功');
    retainNow += 8 * 24 * 60 * 60 * 1000; // 超过 7 天保留窗
    retainService = new AgentAppsService(retainOptions); // 重启后由 tick 裁剪
    await retainService.tick();
    assert.equal(retainService.store.read('one').outbox.length, 0, '已投递且超保留期的事件应被裁剪');
    // 未投递（投递持续失败）事件推进 8 天也不得清除
    retainFail = true;
    await retainService.execute('one', { appId: 'reminders', commandId: 'set', params: { values: { title: '滚动保留未投递', dueAt: new Date(retainNow - 1).toISOString() } } }, actor);
    const retainWarn = console.warn; console.warn = () => {}; try { await retainService.tick(); } finally { console.warn = retainWarn; }
    retainNow += 8 * 24 * 60 * 60 * 1000; retainService = new AgentAppsService(retainOptions);
    const retainWarn2 = console.warn; console.warn = () => {}; try { await retainService.tick(); } finally { console.warn = retainWarn2; }
    const pendingEvent = retainService.store.read('one').outbox.find(e => e.title === '滚动保留未投递');
    assert.ok(pendingEvent && pendingEvent.deliveredAt === undefined, '未投递事件不受保留期裁剪');
  }
  let finishSlow, polls = 0;
  const slowDelivered = [], slow = new AgentAppsService({ ...options, root: path.join(folder, 'slow'),
    deliver: async (ws, event) => { slowDelivered.push(ws); return { messageId: event.id }; },
    connectors: { ...options.connectors, feed: () => { polls++; return new Promise(resolve => { finishSlow = resolve; }); } } });
  await slow.execute('one', { appId: 'rss', commandId: 'subscribe', params: { values: { title: '慢订阅', url: 'https://example.com/feed' } } }, actor);
  await slow.tick(); assert.equal(polls, 1);
  await slow.execute('two', { appId: 'reminders', commandId: 'set', params: { values: { title: '不能被网络拖住', dueAt: new Date(now - 1).toISOString() } } }, actor);
  await slow.tick(); await slow.tick(); assert.deepEqual(slowDelivered, ['two']); assert.equal(polls, 1, 'in-flight job is not polled again');
  slow.stop(); finishSlow([]); await new Promise(setImmediate);
  const pendingNotices = [], delayedNotices = [], noticeService = new AgentAppsService({ ...options, root: path.join(folder, 'notice-race'), deliver: async (_ws, event) => { delayedNotices.push(event.title); if (delayedNotices.length === 1) await new Promise(resolve => pendingNotices.push(resolve)); return { messageId: event.id }; } });
  for (const title of ['第一条', '第二条取消']) await noticeService.execute('one', { appId: 'reminders', commandId: 'set', params: { values: { title, dueAt: new Date(now - 1).toISOString() } } }, actor);
  const noticeTick = noticeService.tick();
  while (!pendingNotices.length) await new Promise(setImmediate);
  const secondNotice = noticeService.query('one', { appId: 'reminders' }).records.find(r => r.values.title === '第二条取消');
  await noticeService.execute('one', { appId: 'reminders', commandId: 'cancel', params: { id: secondNotice.id, expectedRevision: secondNotice.revision } }, actor);
  pendingNotices[0](); await noticeTick; assert.deepEqual(delayedNotices, ['第一条'], 'cancel while another notification is pending must use fresh outbox state');
  const feed = (await call('rss', 'subscribe', { values: { title: '消息源', url: 'https://example.com/feed' } })).record;
  await call('rss', 'sync'); await call('rss', 'sync');
  assert.equal(service.query('one', { appId: 'rss', collection: 'articles' }).total, 1);
  let finishFeed; options.connectors.feed = () => new Promise(resolve => { finishFeed = resolve; });
  const syncing = call('rss', 'sync'); await Promise.resolve();
  await call('rss', 'remove-feed', { id: feed.id, expectedRevision: feed.revision });
  finishFeed([{ title: '迟到文章', externalId: 'late' }]); await assert.rejects(syncing, /Record not found/);
  const account = { kind: 'imap-smtp', id: 'personal', name: '测试邮箱', address: 'ai@example.com', user: 'ai', imapHost: 'imap.example.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.example.com', smtpPort: 587, smtpTls: 'starttls', mailbox: 'INBOX', password: 'private-password', enabled: true, grants: { mail: ['mail.read', 'mail.send'] } };
  service.saveConnection('one', account);
  assert.ok(!JSON.stringify(service.snapshot('one')).includes('private-password'));
  for (const file of fs.readdirSync(path.join(folder, 'data'))) assert.ok(!fs.readFileSync(path.join(folder, 'data', file), 'utf8').includes('private-password'));
  await call('mail', 'sync', { accountId: 'personal' }); await call('mail', 'sync', { accountId: 'personal' });
  assert.equal(service.query('one', { appId: 'mail' }).total, 1);
  const received = service.query('one', { appId: 'mail' }).records[0];
  const reply = (await call('mail', 'reply', { id: received.id })).record; assert.equal(reply.values.replyTo, 'm1');
  const draft = (await call('mail', 'create', { values: { subject: '测试', to: 'person@example.com', body: '内容', accountId: 'personal' } })).record;
  const sendParams = { id: draft.id, expectedRevision: draft.revision };
  confirm = false; await assert.rejects(call('mail', 'send', sendParams, 'send1'), /cancelled/); assert.equal(sent, 0);
  confirm = true; releaseSend = true;
  const sending = call('mail', 'send', sendParams, 'send1'); await Promise.resolve(); await Promise.resolve();
  const duplicate = call('mail', 'send', sendParams, 'send1');
  await assert.rejects(call('mail', 'send', { ...sendParams, id: 'other' }, 'send1'), /different arguments/);
  releaseSend(); releaseSend = undefined;
  const sentRecord = (await sending).record; await duplicate; assert.equal(sent, 1); assert.equal(sentRecord.values.status, 'sent');
  await call('mail', 'send', sendParams, 'send1'); assert.equal(sent, 1);
  failSend = true;
  const unsure = (await call('mail', 'create', { values: { subject: '不确定', to: 'person@example.com', body: '内容', accountId: 'personal' } })).record;
  await assert.rejects(call('mail', 'send', { id: unsure.id, expectedRevision: unsure.revision }, 'uncertain'), /未确认/);
  const count = sent; service = new AgentAppsService(options);
  await assert.rejects(call('mail', 'send', { id: unsure.id, expectedRevision: unsure.revision }, 'uncertain'), /uncertain/); assert.equal(sent, count);
  service.store.transact('one', state => { state.records.mail.find(r => r.id === unsure.id).values.status = 'sending'; const receipt = state.receipts.find(r => r.key === 'mail:uncertain'); receipt.state = 'running'; receipt.recordId = unsure.id; });
  service = new AgentAppsService(options); assert.equal(service.query('one', { appId: 'mail', id: unsure.id }).record.values.status, 'uncertain', 'a crashed send cannot remain falsely in progress');
  service.saveConnection('one', { ...account, enabled: false, expectedRevision: 1 });
  await assert.rejects(call('mail', 'sync', { accountId: 'personal' }), /unavailable/);
  assert.throws(() => service.saveConnection('one', { ...account, expectedRevision: 1 }), /Connection changed/);
  const secondMail = { ...structuredClone(service.store.read('one').installations.find(a => a.definition.id === 'mail').definition), id: 'other-mail', name: '第二个阅读器' };
  const cursors = [], cursorService = new AgentAppsService({ ...options, root: path.join(folder, 'cursors'), connectors: { ...options.connectors, sync: async (_c, _s, cursor) => { cursors.push(cursor.n ?? 0); return { records: [], cursor: { n: Number(cursor.n ?? 0) + 1 } }; } } });
  await cursorService.install('one', secondMail); cursorService.saveConnection('one', { ...account, grants: { mail: ['mail.read'], 'other-mail': ['mail.read'] } });
  for (const appId of ['mail', 'other-mail', 'mail']) await cursorService.execute('one', { appId, commandId: 'sync', params: { accountId: account.id } }, actor);
  assert.deepEqual(cursors, [0, 0, 1], 'each authorized app has its own cursor');
  let finishUpgrade;
  const updating = new AgentAppsService({ ...options, root: path.join(folder, 'updating'), connectors: { ...options.connectors, sync: () => new Promise(resolve => { finishUpgrade = resolve; }) } });
  await updating.install('one', secondMail); updating.saveConnection('one', { ...account, grants: { 'other-mail': ['mail.read'] } });
  const pendingSync = updating.execute('one', { appId: secondMail.id, commandId: 'sync', params: { accountId: account.id } }, actor);
  await assert.rejects(() => updating.install('one', { ...secondMail, version: secondMail.version + 1 }), /in progress/);
  finishUpgrade({ records: [], cursor: {} }); await pendingSync;
  const brokenUpgrade = { ...structuredClone(secondMail), version: secondMail.version + 1 }; brokenUpgrade.commands = brokenUpgrade.commands.filter(c => c.id !== 'sync'); brokenUpgrade.views[0].commands = brokenUpgrade.views[0].commands.filter(c => c !== 'sync');
  await assert.rejects(() => updating.install('one', brokenUpgrade), /orphan an active background job/);
  await updating.install('one', { ...secondMail, version: secondMail.version + 1 });
  const dueNamedMail = structuredClone(secondMail); dueNamedMail.id = 'due-named-mail'; dueNamedMail.commands.find(c => c.id === 'sync').id = 'due'; dueNamedMail.views[0].commands = dueNamedMail.views[0].commands.map(id => id === 'sync' ? 'due' : id);
  await cursorService.install('one', dueNamedMail); cursorService.saveConnection('two', { ...account, grants: {} });
  await cursorService.install('two', dueNamedMail); cursorService.saveConnection('two', { ...account, grants: { 'due-named-mail': ['mail.read'] }, expectedRevision: 1 });
  await cursorService.tick(); await new Promise(setImmediate);
  const dueJob = cursorService.store.read('two').jobs.find(j => j.appId === dueNamedMail.id);
  // Workspace one fills both slots first; the next pass must pick the oldest remaining job.
  await cursorService.tick(); await new Promise(setImmediate);
  assert.equal(cursorService.store.read('two').jobs.find(j => j.id === dueJob.id).lastError, undefined);
  assert.ok(cursorService.store.read('two').connections[0].cursors['due-named-mail'], 'a user command named due remains a sync job');
  const sourceService = new AgentAppsService({ ...options, root: path.join(folder, 'source'), connectors: { ...options.connectors,
    sync: async () => ({ records: [{ messageId: 'om_real', sender: '用户', body: '真实消息' }], cursor: {} }), send: async () => ({ messageId: 'om_sent' }) } });
  sourceService.saveConnection('one', { kind: 'feishu', id: 'chat', name: '对话', chatId: 'oc_1', identity: 'user', enabled: true, grants: { messages: ['messages.read', 'messages.send'] } });
  assert.throws(() => sourceService.saveConnection('one', { kind: 'feishu', id: 'chat', name: '另一会话', chatId: 'oc_other', identity: 'user', enabled: true, expectedRevision: 1, grants: { messages: ['messages.read', 'messages.send'] } }), /连接目标不能更换/);
  assert.throws(() => cursorService.saveConnection('one', { ...account, user: 'another-account', expectedRevision: 1 }), /连接目标不能更换/);
  await sourceService.execute('one', { appId: 'messages', commandId: 'sync', params: { accountId: 'chat' } }, actor);
  sourceService.store.transact('one', state => { state.records.messages[0].values.messageId = 'om_forged'; });
  await assert.rejects(sourceService.execute('one', { appId: 'messages', commandId: 'send', params: { accountId: 'chat', values: { body: '不可伪造目标', replyTo: 'om_forged' } }, requestId: 'reply-forged' }, actor), /host-synced/);
  await sourceService.execute('one', { appId: 'messages', commandId: 'send', params: { accountId: 'chat', values: { body: '有效回复', replyTo: 'om_real' } }, requestId: 'reply-real' }, actor);
  let importRound = 0;
  const provenanceService = new AgentAppsService({ ...options, root: path.join(folder, 'placeholder-updates'), connectors: { ...options.connectors,
    sync: async () => ({ records: [
      { messageId: 'legacy', sender: '未知发送者', body: importRound ? '此消息已撤回' : '原始内容' },
      { messageId: 'new', sender: '未知发送者', body: importRound ? '此消息已撤回' : '原始内容' },
      { messageId: 'unchanged', sender: '未知发送者', body: '此消息已撤回' },
    ], placeholderFields: importRound
      ? [{ sender: 'message-unknown-sender', body: 'message-withdrawn' }, { sender: 'message-unknown-sender', body: 'message-withdrawn' }, { sender: 'message-unknown-sender', body: 'message-withdrawn' }]
      : [null, { sender: 'message-unknown-sender' }, null], cursor: {} }) } });
  provenanceService.saveConnection('one', { kind: 'feishu', id: 'chat', name: '对话', chatId: 'oc_1', identity: 'user', enabled: true, grants: { messages: ['messages.read'] } });
  const syncProvenance = () => provenanceService.execute('one', { appId: 'messages', commandId: 'sync', params: { accountId: 'chat' } }, actor);
  await syncProvenance(); importRound++; await syncProvenance();
  const updatedMessages = provenanceService.query('one', { appId: 'messages' }).records;
  assert.deepEqual(updatedMessages.find(row => row.values.messageId === 'legacy').placeholderFields, { body: 'message-withdrawn' }, 'unchanged historical fields do not gain guessed provenance');
  assert.deepEqual(updatedMessages.find(row => row.values.messageId === 'new').placeholderFields, { sender: 'message-unknown-sender', body: 'message-withdrawn' }, 'new known provenance survives a source edit');
  assert.equal(updatedMessages.find(row => row.values.messageId === 'unchanged').placeholderFields, undefined, 'unchanged historical records remain unchanged');
  const { phoneFeishuProfile } = bundle('src/main/agentApps/feishuAccounts.ts', 'phone-accounts');
  const phoneProfile = phoneFeishuProfile('one');
  const cliOptions = [];
  const calls = [], connector = createAppConnectors(async (args, options) => { calls.push(args); cliOptions.push(options); return { code: 0, stdout: JSON.stringify({ ok: true, data: args.includes('+chat-messages-list') ? { messages: [{ message_id: 'om_1', content: { text: '你好' }, sender: { name: '用户' }, create_time: 'invalid' }], has_more: false } : { message_id: 'om_sent' } }), stderr: '' }; });
  const feishu = { kind: 'feishu', id: 'chat', name: '对话', chatId: 'oc_1', identity: 'user', enabled: true, grants: {}, revision: 1 };
  assert.equal((await connector.sync(feishu, undefined, {})).records[0].date, '');
  const placeholdersConnector = createAppConnectors(async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, data: { messages: [
    { message_id: 'om_withdrawn', deleted: true },
    { message_id: 'om_literal', sender: { name: '未知发送者' }, content: '此消息已撤回' },
  ], has_more: false } }) }));
  const placeholderMessages = await placeholdersConnector.sync(feishu, undefined, {});
  assert.deepEqual(placeholderMessages.placeholderFields, [{ sender: 'message-unknown-sender', body: 'message-withdrawn' }, null]);
  assert.equal(placeholderMessages.records[0].sender, placeholderMessages.records[1].sender);
  assert.equal(placeholderMessages.records[0].body, placeholderMessages.records[1].body);
  await connector.send(feishu, undefined, { body: '回复', replyTo: 'om_1' }, 'send1');
  assert.ok(calls[1].includes('+messages-reply')); assert.ok(calls[1].includes('--idempotency-key')); assert.ok(!calls[1].includes('--uuid'));
  const denied = createAppConnectors(async () => ({ code: 10, stdout: '', stderr: JSON.stringify({ ok: false, error: { message: '用户授权缺失' } }) }));
  await assert.rejects(denied.sync(feishu, undefined, {}), /授权缺失/);
  const chatCalls = [], chatOptions = [], chatConnector = createAppConnectors(async (args, options) => {
    chatCalls.push(args); chatOptions.push(options);
    return { code: 0, stdout: JSON.stringify({ ok: true, data: { chats: [
      { chat_id: 'oc_1', name: '已连接会话' }, { chat_id: 'oc_bridge', name: '调度遥控' }, { chat_id: 'oc_news', name: '外界信息' }, { chat_id: 'oc_deleted', name: '已解散', chat_status: 'dissolved' }
    ], has_more: true, page_token: 'next' } }), stderr: '' };
  });
  const discovery = new AgentAppsService({ ...options, root: path.join(folder, 'chat-discovery'), connectors: chatConnector });
  const savedPhone = discovery.saveConnection('one', feishu);
  assert.equal(savedPhone.profile, phoneProfile);
  assert.throws(() => discovery.saveConnection('one', { ...feishu, id: 'spoof', profile: 'metaagent' }), /不能切换/);
  await connector.test(savedPhone); await connector.sync(savedPhone, undefined, {}); await connector.send(savedPhone, undefined, { body: 'phone test' }, 'phone-send');
  assert.ok(cliOptions.slice(-3).every(options => options.profile === phoneProfile), 'test, receive and send use phone credentials');
  assert.equal(cliOptions[0].profile, undefined, 'legacy connections keep their original credentials');
  const chatPage = await discovery.listFeishuChats('one', 'user', 'previous');
  assert.equal(chatOptions[0].profile, phoneProfile);
  assert.equal(chatPage.pageToken, 'next'); assert.equal(chatPage.chats.length, 3);
  assert.match(chatPage.chats[0].unavailable, /已添加/);
  assert.equal(chatPage.chats[1].unavailable, undefined, 'former bridge conversations are eligible for the phone connector');
  assert.equal(chatPage.chats[2].unavailable, undefined);
  assert.deepEqual(chatCalls[0], ['im', '+chat-list', '--as', 'user', '--page-size', '100', '--format', 'json', '--types', 'p2p,group', '--page-token', 'previous']);
  await discovery.listFeishuChats('one', 'bot'); assert.ok(!chatCalls[1].includes('--types'));
  assert.throws(() => discovery.saveConnection('one', { ...feishu, id: 'duplicate' }), /已添加/);
  discovery.store.transact('one', state => { state.connections.push({ ...state.connections[0], id: 'legacy-duplicate' }); });
  discovery.saveConnection('one', { ...feishu, expectedRevision: 1, enabled: false });
  assert.equal(discovery.snapshot('one').connections.find(c => c.id === feishu.id).enabled, false, 'legacy duplicates can still be edited and disabled');
  await assert.rejects(discovery.listFeishuChats('missing', 'bot'), /workspace/);
  await assert.rejects(discovery.listFeishuChats('one', 'admin'), /身份/);
  await assert.rejects(discovery.listFeishuChats('one', 'bot', {}), /分页/);
  assert.equal(chatCalls.length, 2, 'invalid requests never reach CLI');
  discovery.rememberFeishuChat('one', { chatId: 'oc_private', name: '我的飞书私聊' });
  discovery.rememberFeishuChat('one', { chatId: 'oc_private', name: '我的飞书私聊' });
  const restoredDiscovery = new AgentAppsService({ ...options, root: path.join(folder, 'chat-discovery'), connectors: chatConnector });
  const restoredChats = await restoredDiscovery.listFeishuChats('one', 'bot');
  assert.equal(restoredChats.chats.filter(chat => chat.chatId === 'oc_private').length, 1, 'paired private chat survives restart and is merged into bot group discovery once');
  const privateConnection = restoredDiscovery.snapshot('one').connections.find(c => c.chatId === 'oc_private');
  assert.ok(privateConnection, 'verified private pairing commits the connection without a renderer save');
  assert.deepEqual(privateConnection.grants, { messages: ['messages.read', 'messages.send'] });
  assert.equal(privateConnection.profile, phoneProfile);
  assert.equal(restoredDiscovery.snapshot('one').connections.filter(c => c.chatId === 'oc_private').length, 1, 'duplicate pairing reuses the existing connection');
  assert.equal(restoredDiscovery.store.read('one').jobs.filter(j => j.params.accountId === privateConnection.id && j.enabled).length, 1);
  assert.deepEqual(restoredDiscovery.connectedFeishuPrivateChats('one'), [{ chatId: 'oc_private', name: '我的飞书私聊' }], 'groups must not suppress private pairing');
  assert.deepEqual(restoredDiscovery.connectedFeishuPrivateChats('two'), []);
  restoredDiscovery.start();
  restoredDiscovery.receiveFeishuMessage('one', { messageId: 'om_after_pairing', chatId: 'oc_private', body: '私聊连接后直接收取', mine: false, status: 'received' });
  assert.equal(restoredDiscovery.query('one', { appId: 'messages' }).total, 1, 'the next private message persists without selecting a chat or saving in the UI');
  restoredDiscovery.saveConnection('one', { ...privateConnection, expectedRevision: privateConnection.revision, notify: 'mute', grants: { messages: ['messages.read'] } });
  restoredDiscovery.rememberFeishuChat('one', { chatId: 'oc_private', name: '我的飞书私聊' });
  const preservedPrivate = restoredDiscovery.snapshot('one').connections.find(c => c.id === privateConnection.id);
  assert.deepEqual(preservedPrivate.grants, { messages: ['messages.read'] }, 'pairing never restores revoked sending permission');
  assert.equal(preservedPrivate.notify, 'mute');
  restoredDiscovery.saveConnection('one', { ...preservedPrivate, expectedRevision: preservedPrivate.revision, enabled: false });
  assert.throws(() => restoredDiscovery.rememberFeishuChat('one', { chatId: 'oc_private', name: '我的飞书私聊' }), /已停用/);
  assert.deepEqual(restoredDiscovery.connectedFeishuPrivateChats('one'), []);
  restoredDiscovery.stop();
  assert.equal((await restoredDiscovery.listFeishuChats('two', 'bot')).chats.some(chat => chat.chatId === 'oc_private'), false, 'paired private chats cannot leak into another workspace');
  let historyReads = 0, receiverStarts = 0;
  const liveOptions = { ...options, root: path.join(folder, 'event-inbox'),
    feishuAccounts: { get: async () => ({ appBound: true }), ensureReceiving: async () => { receiverStarts++; }, stop() {} },
    connectors: { ...options.connectors, test: async () => { historyReads++; throw Error('Auth method is not supported'); }, sync: async () => { historyReads++; throw Error('access denied for this bot operation'); } }
  };
  const inbox = new AgentAppsService(liveOptions); inbox.start();
  const botInput = { ...feishu, identity: 'bot', chatId: 'oc_private', grants: { messages: ['messages.read'] }, enabled: true };
  inbox.saveConnection('one', botInput);
  await inbox.testConnection('one', botInput.id);
  await inbox.execute('one', { appId: 'messages', commandId: 'sync', params: { accountId: botInput.id } }, actor);
  assert.equal(historyReads, 0, 'phone bot test/sync reuses event receiving, never the unsupported history API');
  assert.ok(receiverStarts > 0);
  const incoming = { messageId: 'om_event', chatId: 'oc_private', body: '外界来信', sender: 'ou_person', date: new Date(now).toISOString(), mine: false, status: 'received' };
  inbox.receiveFeishuMessage('one', incoming); inbox.receiveFeishuMessage('one', incoming);
  inbox.receiveFeishuMessage('two', incoming); inbox.receiveFeishuMessage('one', { ...incoming, chatId: 'oc_other' });
  assert.equal(inbox.query('one', { appId: 'messages', collection: 'items' }).records.length, 1, 'events persist once, only in the explicitly connected workspace/chat');
  assert.equal(inbox.store.read('one').outbox.length, 1, 'duplicate event does not wake twice');
  inbox.stop();
  const reopenedInbox = new AgentAppsService(liveOptions);
  assert.equal(reopenedInbox.query('one', { appId: 'messages', collection: 'items' }).records[0].values.body, '外界来信', 'received SMS survives restart');
  reopenedInbox.start();
  reopenedInbox.saveConnection('one', { ...botInput, expectedRevision: 1, enabled: false });
  reopenedInbox.receiveFeishuMessage('one', { ...incoming, messageId: 'om_disabled' });
  assert.equal(reopenedInbox.query('one', { appId: 'messages', collection: 'items' }).records.length, 1, 'disabled connection cannot receive');
  reopenedInbox.stop();
  let automaticStarts = 0, automaticSends = 0;
  const autoOptions = { ...options, root: path.join(folder, 'automatic-conversations'),
    feishuAccounts: { get: async () => ({ appBound: true }), ensureReceiving: async () => { automaticStarts++; }, stop() {} },
    confirmSend: async () => false,
    connectors: { ...options.connectors, send: async () => { automaticSends++; return { messageId: 'sent' }; } }
  };
  const automatic = new AgentAppsService(autoOptions); automatic.start();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(automaticStarts, 2, 'both configured workspaces listen before any chat has been added');
  const firstPrivate = { ...incoming, chatId: 'oc_first_private', messageId: 'om_first_private' };
  const firstGroup = { ...incoming, chatId: 'oc_first_group', messageId: 'om_first_group' };
  automatic.receiveFeishuMessage('one', firstPrivate, { type: 'p2p', name: '小王' });
  automatic.receiveFeishuMessage('one', firstPrivate, { type: 'p2p', name: '小王' });
  automatic.receiveFeishuMessage('one', firstGroup, { type: 'group', mentionedBot: false });
  assert.equal(automatic.snapshot('one').connections.length, 1, 'unmentioned groups are not discovered');
  automatic.receiveFeishuMessage('one', firstGroup, { type: 'group', mentionedBot: true, name: '讨论群' });
  assert.equal(automatic.query('one', { appId: 'messages' }).total, 2);
  assert.equal(automatic.store.read('one').outbox.length, 2, 'first messages and targets are persisted once together');
  assert.equal(automatic.store.read('one').jobs.filter(j => j.kind === 'sync' && j.enabled).length, 2, 'discovered targets retain background receiver recovery');
  assert.equal(automatic.query('two', { appId: 'messages' }).total, 0, 'incoming events stay in the receiving workspace');
  const automaticPrivate = automatic.snapshot('one').connections.find(c => c.chatId === firstPrivate.chatId);
  assert.equal(automaticPrivate.name, '小王'); assert.equal(automaticPrivate.profile, phoneProfile);
  assert.deepEqual(automaticPrivate.grants, { messages: ['messages.read', 'messages.send'] }, 'new targets only grant the built-in SMS app');
  await assert.rejects(automatic.execute('one', { appId: 'messages', commandId: 'send', requestId: 'automatic-confirmation', params: { accountId: automaticPrivate.id, values: { body: '需要确认' } } }, actor), /取消|cancel|declined/i);
  assert.equal(automaticSends, 0, 'automatic discovery does not bypass the send confirmation');
  automatic.saveConnection('one', { ...automaticPrivate, expectedRevision: automaticPrivate.revision, notify: 'mute', grants: { messages: ['messages.read'] } });
  automatic.receiveFeishuMessage('one', { ...firstPrivate, messageId: 'om_next_private' }, { type: 'p2p', name: '不可覆盖手工名称' });
  const privatePreferences = automatic.snapshot('one').connections.find(c => c.id === automaticPrivate.id);
  assert.equal(privatePreferences.name, '小王'); assert.equal(privatePreferences.notify, 'mute');
  assert.deepEqual(privatePreferences.grants.messages, ['messages.read']);
  automatic.saveConnection('one', { ...privatePreferences, expectedRevision: privatePreferences.revision, enabled: false });
  automatic.receiveFeishuMessage('one', { ...firstPrivate, messageId: 'om_revoked' }, { type: 'p2p' });
  assert.equal(automatic.query('one', { appId: 'messages' }).total, 3, 'incoming messages never reactivate a disabled target');
  await automatic.setEnabled('one', 'messages', false);
  automatic.receiveFeishuMessage('one', { ...incoming, chatId: 'oc_disabled_app', messageId: 'om_disabled_app' }, { type: 'p2p' });
  assert.equal(automatic.snapshot('one').connections.length, 2, 'a disabled SMS app does not discover or grant new targets');
  await automatic.setEnabled('one', 'messages', true);
  automatic.receiveFeishuMessage('one', { ...incoming, chatId: 'oc_bridge', messageId: 'om_direct_bridge' }, { type: 'p2p' });
  assert.equal(automatic.snapshot('one').connections.length, 3, 'verified phone events from a former bridge chat use the same inbox');
  automatic.stop();
  const automaticRestart = new AgentAppsService(autoOptions);
  assert.equal(automaticRestart.query('one', { appId: 'messages' }).total, 4);
  assert.equal(automaticRestart.snapshot('one').connections.find(c => c.chatId === firstPrivate.chatId).id, automaticPrivate.id, 'history retains its original delivery target');
  const metadataCalls = [];
  const metadataConnector = createAppConnectors(async (args, opts) => { metadataCalls.push({ args, opts }); return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, data: args.includes('/open-apis/bot/v3/info') ? { open_id: 'ou_phone' } : args.includes('+messages-mget') ? { messages: [{ sender: { name: '小王' } }] } : { name: '讨论群' } }) }; });
  assert.equal(await metadataConnector.feishuBotId(phoneProfile), 'ou_phone');
  assert.equal(await metadataConnector.feishuConversationName('oc_group', 'om_group', 'group', phoneProfile), '讨论群');
  assert.equal(await metadataConnector.feishuConversationName('oc_private', 'om_private', 'p2p', phoneProfile), '小王');
  assert.ok(metadataCalls.every(c => c.opts.profile === phoneProfile && c.args.includes('bot')));
  const badBotIdentity = createAppConnectors(async () => ({ code: 0, stderr: '', stdout: '{"ok":true,"data":{}}' }));
  await assert.rejects(badBotIdentity.feishuBotId(phoneProfile), /无法取得/);
  await assert.rejects(denied.listFeishuChats('bot', undefined, phoneProfile), /授权缺失/);
  const malformedChats = data => createAppConnectors(async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' }));
  assert.deepEqual(await malformedChats({ chats: null, has_more: false }).listFeishuChats('bot', undefined, phoneProfile), { chats: [] });
  await assert.rejects(malformedChats({ items: [] }).listFeishuChats('bot', undefined, phoneProfile), /chats/);
  await assert.rejects(malformedChats({ chats: [], has_more: true }).listFeishuChats('bot', undefined, phoneProfile), /分页/);
  await assert.rejects(malformedChats({ chats: [], has_more: true, page_token: 'repeat' }).listFeishuChats('bot', 'repeat', phoneProfile), /分页/);
  assert.equal(parseFeed('<rss><channel><item><title>A &amp; B</title><guid>1</guid><description>&lt;b&gt;内容&lt;/b&gt;</description></item></channel></rss>', 'https://example.com').length, 1);
  assert.equal(parseFeed('<feed><entry><title>Atom</title><id>two</id><link href="/a"/></entry></feed>', 'https://example.com')[0].url, 'https://example.com/a');
  const noLinks = parseFeed('<rss><channel><item><title>One</title></item><item><title>Two</title></item></channel></rss>', 'https://example.com/feed');
  assert.notEqual(noLinks[0].externalId, noLinks[1].externalId, 'entries without URLs must not all collapse to the feed URL'); assert.equal(noLinks[0].url, '');
  assert.throws(() => parseFeed('<!DOCTYPE rss><rss/>', 'https://example.com'), /entities/);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '0:0:0:0:0:0:0:1', '::ffff:7f00:1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(fetchFeed('http://127.0.0.1/feed'), /non-public/);
  const isolated = new AgentAppsService({ ...options, root: path.join(folder, 'isolated'), emit: () => { throw Error('UI disconnected'); } });
  const originalWarn = console.warn; console.warn = () => {};
  await isolated.execute('one', { appId: 'tasks', commandId: 'create', params: { values: { title: '不等待界面' } } }, actor); await Promise.resolve(); console.warn = originalWarn;
  assert.equal(isolated.query('one', { appId: 'tasks' }).total, 1);
  // Damaged databases fail closed and cannot overwrite the original bytes.
  {
    const corruptRoot = path.join(folder, 'corrupt-data'); fs.mkdirSync(corruptRoot, { recursive: true });
    const seedInstallation = { definition: { id: 'demo', name: 'Demo', commands: [], version: 1 }, enabled: true };
    const store = new SqliteStore(corruptRoot, () => [structuredClone(seedInstallation)]);
    const wsId = 'corrupt-ws';
    const file = path.join(corruptRoot, `${createHash('sha256').update(wsId).digest('hex')}.sqlite`);
    try {
      fs.writeFileSync(file, 'corrupt database');
      assert.throws(() => store.read(wsId), /sqlite|database/i);
      assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt database');
      assert.equal(store.read('healthy-ws').installations[0].definition.id, 'demo', 'other workspaces remain usable');
    } finally { store.close(); }
  }
  console.log('agent-apps: durable records/jobs/outbox, scope, CAS, bindings, send dedupe/recovery, permissions and connectors passed');
} finally {
  for (const store of sqliteStores) store.close();
  const resolved = path.resolve(folder); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(resolved, { recursive: true, force: true });
}
