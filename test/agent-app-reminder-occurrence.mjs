import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const folder = fs.mkdtempSync(path.join(tempRoot, 'agent-reminder-occurrence-'));
if (path.dirname(fs.realpathSync(folder)) !== tempRoot) throw new Error('Unexpected test directory');
const services = [];
try {
  const bundle = path.join(folder, 'service.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/main/agentApps/service.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { AgentAppsService } = createRequire(import.meta.url)(bundle);
  const createService = options => { const instance = new AgentAppsService(options); services.push(instance); return instance; };
  const firstDue = Date.parse('2026-10-30T01:00:00.000Z');
  let now = firstDue - 1;
  const deliveries = [];
  let service;
  const options = {
    root: path.join(folder, 'data'), workspaces: () => ['one'], now: () => now,
    emit() {}, encrypt: value => value, decrypt: value => value, confirmSend: async () => true,
    connectors: { feed: async () => [], sync: async () => ({ records: [], cursor: {} }), send: async () => ({ messageId: 'unused' }), test: async () => {} },
    deliver: async (workspace, event) => {
      deliveries.push({ event: structuredClone(event), notification: service.notification(workspace, event.id) });
      return { messageId: event.id };
    }
  };
  service = createService(options);
  const actor = { kind: 'human', runId: 'test' };
  const record = (await service.execute('one', { appId: 'reminders', commandId: 'set', params: { values: {
    title: '提醒用户打卡', dueAt: new Date(firstDue).toISOString(), repeatMinutes: 1440
  } } }, actor)).record;
  now = firstDue;
  await service.tick();
  assert.equal(deliveries.length, 1);
  const secondDue = firstDue + 1440 * 60_000;
  assert.equal(service.query('one', { appId: 'reminders', id: record.id }).record.values.dueAt, new Date(secondDue).toISOString());
  assert.equal(deliveries[0].event.occurrenceAt, firstDue);
  assert.equal(deliveries[0].notification.payload.data[0].dueAt, new Date(firstDue).toISOString());
  assert.equal(deliveries[0].notification.payload.data[0].nextDueAt, new Date(secondDue).toISOString());
  service = createService(options);
  assert.equal(service.notification('one', deliveries[0].event.id).payload.data[0].dueAt, new Date(firstDue).toISOString(), 'persisted occurrence must survive restart');
  now = secondDue;
  await service.tick();
  assert.equal(deliveries.length, 2);
  assert.notEqual(deliveries[0].event.id, deliveries[1].event.id);
  assert.equal(deliveries[1].notification.payload.data[0].dueAt, new Date(secondDue).toISOString());
  assert.equal(service.notification('one', deliveries[0].event.id).payload.data[0].dueAt, new Date(firstDue).toISOString(), 'later occurrences must not change earlier facts');
  console.log('agent reminder occurrences: immutable due times, restart and repeat passed');
} finally {
  for (const instance of services) instance.store.close?.();
  fs.rmSync(folder, { recursive: true, force: true });
}
