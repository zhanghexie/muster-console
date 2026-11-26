import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const folder = fs.mkdtempSync(path.join(tempRoot, 'agent-reminder-daily-'));
if (path.dirname(fs.realpathSync(folder)) !== tempRoot) throw new Error('Unexpected test directory');
const originalTz = process.env.TZ;
const services = [];
try {
  process.env.TZ = 'America/New_York';
  const bundle = path.join(folder, 'service.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/main/agentApps/service.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { AgentAppsService } = createRequire(import.meta.url)(bundle);
  const createService = options => { const service = new AgentAppsService(options); services.push(service); return service; };
  let now = Date.parse('2026-03-07T13:59:00.000Z');
  const deliveries = [];
  const options = {
    root: path.join(folder, 'data'), workspaces: () => ['one'], now: () => now,
    emit() {}, encrypt: value => value, decrypt: value => value, confirmSend: async () => true,
    connectors: { feed: async () => [], sync: async () => ({ records: [], cursor: {} }), send: async () => ({ messageId: 'unused' }), test: async () => {} },
    deliver: async (_workspace, event) => { deliveries.push(event); return { messageId: event.id }; }
  };
  let service = createService(options);
  const actor = { kind: 'human', runId: 'test' };
  const set = values => service.execute('one', { appId: 'reminders', commandId: 'set', params: { values } }, actor);
  const record = (await set({ title: '提醒用户打卡', dailyTime: '09:00' })).record;
  assert.equal(record.values.dueAt, '2026-03-07T14:00:00.000Z');
  await assert.rejects(set({ title: '无效时间', dailyTime: '25:00' }), /time|时间/i);
  await assert.rejects(set({ title: '冲突', dailyTime: '09:00', repeatMinutes: 60 }), /daily|repeat|重复/i);
  now = Date.parse(record.values.dueAt);
  await service.tick();
  assert.equal(deliveries.length, 1);
  let current = service.query('one', { appId: 'reminders', id: record.id }).record;
  assert.equal(current.values.dueAt, '2026-03-08T13:00:00.000Z', 'daily schedule follows DST instead of adding 24 hours');
  service = createService(options);
  assert.equal(service.query('one', { appId: 'reminders', id: record.id }).record.values.dueAt, current.values.dueAt);
  now += 60 * 60_000;
  process.env.TZ = 'Europe/London';
  await service.tick();
  current = service.query('one', { appId: 'reminders', id: record.id }).record;
  assert.equal(current.values.dueAt, '2026-03-08T09:00:00.000Z', 'local daily schedule follows a system timezone change');
  await service.execute('one', { appId: 'reminders', commandId: 'cancel', params: { id: record.id, expectedRevision: current.revision } }, actor);
  now = Date.parse('2026-03-08T09:00:00.000Z');
  await service.tick();
  assert.equal(deliveries.length, 1, 'cancelled daily reminder must not fire');
  process.env.TZ = 'America/New_York';
  now = Date.parse('2026-03-07T13:59:00.000Z');
  const weekly = (await set({ title: '每周提醒', dailyTime: '09:00', weekdays: '0,3' })).record;
  assert.equal(weekly.values.dueAt, '2026-03-08T13:00:00.000Z', 'Sunday remains 09:00 through DST');
  await assert.rejects(set({ title: '星期无效', dailyTime: '09:00', weekdays: '7' }), /weekdays/);
  await assert.rejects(set({ title: '没有时间', dueAt: '2026-03-08T13:00:00Z', weekdays: '0' }), /weekdays/);
  now = Date.parse(weekly.values.dueAt); await service.tick();
  let weeklyCurrent = service.query('one', { appId: 'reminders', id: weekly.id }).record;
  assert.equal(weeklyCurrent.values.dueAt, '2026-03-11T13:00:00.000Z', 'next selected weekday is persisted');
  service = createService(options);
  weeklyCurrent = service.query('one', { appId: 'reminders', id: weekly.id }).record;
  assert.equal(weeklyCurrent.values.dueAt, '2026-03-11T13:00:00.000Z', 'weekly reminder survives restart');
  process.env.TZ = 'Europe/London'; await service.tick();
  weeklyCurrent = service.query('one', { appId: 'reminders', id: weekly.id }).record;
  assert.equal(weeklyCurrent.values.dueAt, '2026-03-11T09:00:00.000Z', 'weekly reminder follows system timezone changes');
  weeklyCurrent = (await service.execute('one', { appId: 'reminders', commandId: 'set', params: { id: weekly.id, expectedRevision: weeklyCurrent.revision, values: { weekdays: '' } } }, actor)).record;
  assert.equal(weeklyCurrent.values.dueAt, '2026-03-09T09:00:00.000Z', 'clearing weekdays returns to daily');
  console.log('agent reminder daily: DST, timezone changes, restart and cancellation passed');
} finally {
  for (const service of services) service.store.close?.();
  if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
  fs.rmSync(folder, { recursive: true, force: true });
}
