import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const folder = fs.mkdtempSync(path.join(tempRoot, 'agent-app-sqlite-service-'));
if (path.dirname(fs.realpathSync(folder)) !== tempRoot) throw new Error('Unexpected test directory');
let service;
try {
  const bundle = path.join(folder, 'service.cjs');
  buildSync({ stdin: { contents: "export { AgentAppsService } from './src/main/agentApps/service'; export { AgentAppsSqliteStateStore } from './src/main/agentApps/sqliteStateStore'; export { defineRecordApp } from './src/shared/agentApps';", resolveDir: root, sourcefile: 'service-sqlite-test.ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { AgentAppsService, AgentAppsSqliteStateStore, defineRecordApp } = createRequire(import.meta.url)(bundle);
  let now = Date.parse('2026-10-31T01:00:00.000Z');
  const deliveries = [];
  const options = { root: path.join(folder, 'agent-apps'), storeFactory: (root, seed) => new AgentAppsSqliteStateStore(root, seed), workspaces: () => ['one', 'two'], now: () => now, emit() {}, encrypt: x => x, decrypt: x => x, confirmSend: async () => true, authorizeDefinition: async () => true,
    deliver: async (ws, event) => { deliveries.push({ ws, event, notification: service.notification(ws, event.id) }); return { messageId: event.id }; },
    connectors: { feed: async () => [{ title: 'News', externalId: 'article-1' }], sync: async () => ({ records: [], cursor: {} }), send: async () => ({ messageId: 'unused' }), test: async () => {} } };
  service = new AgentAppsService(options);
  const actor = { kind: 'human', runId: 'test' };
  const call = (ws, appId, commandId, params = {}) => service.execute(ws, { appId, commandId, params }, actor);
  const task = (await call('one', 'tasks', 'create', { values: { title: 'A task' } })).record;
  await call('one', 'reminders', 'set', { values: { title: 'Remind user', dueAt: new Date(now + 1).toISOString(), repeatMinutes: 1, targetApp: 'tasks', targetId: task.id } });
  now += 2; await service.tick();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].notification.payload.data[0].dueAt, new Date(now - 1).toISOString());
  const feed = (await call('one', 'rss', 'subscribe', { values: { title: 'Feed', url: 'https://example.com/feed' } })).record;
  await call('one', 'rss', 'sync', { id: feed.id });
  await call('one', 'rss', 'sync', { id: feed.id });
  assert.equal(service.query('one', { appId: 'rss', collection: 'articles' }).total, 1);
  const custom = defineRecordApp({ id: 'notes', name: 'Notes', fields: [{ id: 'title', label: 'Title', type: 'text' }], titleField: 'title' });
  await service.install('one', custom);
  const entry = service.listLibrary('two').find(item => item.appId === 'notes');
  await service.installFromLibrary('two', entry.catalogId);
  const note = (await call('two', 'notes', 'create', { values: { title: 'Independent' } })).record;
  assert.equal(service.query('one', { appId: 'notes' }).total, 0);
  service.uninstall('two', 'notes');
  await service.installFromLibrary('two', entry.catalogId);
  assert.equal(service.query('two', { appId: 'notes' }).records[0].id, note.id);
  service.store.close(); service = new AgentAppsService(options);
  assert.equal(service.query('one', { appId: 'tasks', id: task.id }).record.values.title, 'A task');
  assert.equal(service.query('two', { appId: 'notes' }).records[0].values.title, 'Independent');
  assert.ok(fs.readdirSync(options.root).every(name => !name.endsWith('.json')));
  const safe = (await call('two', 'tasks', 'create', { values: { title: 'Target' } })).record;
  const unrelated = (await call('two', 'tasks', 'create', { values: { title: 'Other' } })).record;
  service.store.close();
  const tamper = new DatabaseSync(path.join(options.root, `${createHash('sha256').update('two').digest('hex')}.sqlite`));
  tamper.prepare('UPDATE records SET value=? WHERE app_id=? AND id=?').run('invalid-json', 'tasks', unrelated.id);
  tamper.close();
  service = new AgentAppsService(options);
  const updated = (await call('two', 'tasks', 'update', { id: safe.id, expectedRevision: safe.revision, values: { title: 'Updated' } })).record;
  assert.equal(updated.values.title, 'Updated', 'a single-record update does not deserialize unrelated records');
  assert.equal(service.query('two', { appId: 'tasks', id: safe.id }).record.values.title, 'Updated');
  console.log('agent apps SQLite service: commands, reminders, feeds, sharing, uninstall and restart passed');
} finally {
  service?.store.close?.();
  fs.rmSync(folder, { recursive: true, force: true });
}
