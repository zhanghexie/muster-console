import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-wait-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const { EventLog } = await import(pathToFileURL(compile('main/awareness/eventLog.ts')).href);
  const { ResumeWaitStore } = await import(pathToFileURL(compile('main/resumeWait/store.ts')).href);
  const { ResumeWaitService } = await import(pathToFileURL(compile('main/resumeWait/service.ts')).href);
  const dir = path.join(tmp, 'data');
  const events = new EventLog(dir);
  events.append({ source: 'gitlab', type: 'issue', scope: '6528', workspaceId: 'ws', receivedAt: 1, summary: 'old', payload: '{}' });
  let store = new ResumeWaitStore(dir);
  const legacyBinding = store.arm({ owner: 'owner', workspaceId: 'ws', condition: { kind: 'mail' },
    note: 'legacy binding', priority: 'normal', deadlineAt: null, desktopEpoch: 'legacy-epoch', desktopEpochGeneration: 0 }, 99);
  const raw = new DatabaseSync(path.join(dir, 'event-log.sqlite'));
  raw.prepare('UPDATE resume_waits SET desktop_epoch_generation = NULL WHERE id = ?').run(legacyBinding.id);
  assert.equal(store.get(legacyBinding.id).desktopEpochUnknown, true, 'legacy binding without generation is not treated as first use');
  assert.equal(store.get(legacyBinding.id).desktopEpoch, null);
  raw.prepare('DELETE FROM resume_waits WHERE id = ?').run(legacyBinding.id);
  raw.close();
  const wait = store.arm({ owner: 'owner', workspaceId: 'ws', condition: { kind: 'event', source: 'gitlab', types: ['issue'], scope: '6528' },
    note: '逐字续接\n  保留空格', priority: 'normal', deadlineAt: null, desktopEpoch: 'epoch-at-arm', desktopEpochGeneration: 7 }, 100);
  assert.equal(wait.eventCursor, 1, 'arming starts after the already persisted event');
  assert.equal(store.fire(wait.id, 'event-2', '{"untrusted":true}'), true);
  assert.equal(store.fire(wait.id, 'timeout', 'timeout'), false, 'a competing trigger cannot overwrite the first');
  const deliveryId = store.attempted(wait.id, 120);
  assert.ok(deliveryId);
  assert.equal(store.attempted(wait.id, 121), null, 'parallel attempts cannot both acquire delivery');
  // Simulate a crash after reserving a delivery but before learning its outcome.
  store.close();
  store = new ResumeWaitStore(dir);
  const reopened = store.get(wait.id);
  assert.equal(reopened.note, '逐字续接\n  保留空格');
  assert.equal(reopened.desktopEpochGeneration, 7);
  assert.equal(reopened.desktopEpoch, 'epoch-at-arm', 'arm-time epoch survives host restart');
  assert.equal(reopened.state, 'uncertain', 'restart cannot treat unknown delivery as success or blindly retry');
  assert.equal(reopened.triggerId, 'event-2');
  assert.equal(store.attempted(wait.id, 130), null);
  assert.equal(store.confirm(deliveryId, 140, 'owner'), true);
  assert.equal(store.confirm(deliveryId, 141, 'owner'), false);
  assert.deepEqual(store.history(wait.id).map(item => item.status), ['attempted', 'uncertain', 'confirmed-late']);
  assert.equal(store.pending().length, 0);
  assert.equal(store.prune(200, 100), 0);
  assert.equal(store.prune(241, 100), 1);
  const interrupted = store.arm({ owner: 'owner', workspaceId: 'ws', condition: { kind: 'time', at: '2026-11-02T00:00:00Z' },
    note: 'retry after restart', priority: 'normal', deadlineAt: null }, 300);
  assert.equal(store.fire(interrupted.id, 'time', '{}'), true);
  store.attempted(interrupted.id, 301);
  const replay = store.arm({ owner: 'owner', workspaceId: 'ws', condition: { kind: 'event', source: 'gitlab', types: ['issue'], scope: '6528' },
    note: 'replay after restart', priority: 'normal', deadlineAt: null }, 302);
  events.append({ source: 'gitlab', deliveryId: 'after-arm', type: 'issue', scope: '6528', workspaceId: 'ws', receivedAt: 303, summary: 'new', payload: '{}' });
  store.close();
  store = new ResumeWaitStore(dir);
  let now = store.get(interrupted.id).uncertainAt + 90001;
  const delivered = [];
  const service = new ResumeWaitService(store, { now: () => now, isBusy: () => false,
    deliver: async (record, content) => { delivered.push({ record, content }); return { status: 'confirmed' }; }, alert() {} });
  service.events(events);
  assert.equal(store.get(replay.id).state, 'ready', 'armed event is recovered from the persisted cursor');
  await service.tick(); await service.tick();
  assert.equal(store.get(interrupted.id).state, 'consumed', 'unknown in-flight attempt is retried after restart and grace');
  assert.equal(store.get(replay.id).state, 'consumed', 'replayed event resumes its original wait');
  assert.ok(delivered.some(item => item.content.includes('retry after restart')));
  assert.ok(delivered.some(item => item.content.includes('replay after restart')));
  store.close();
  events.close();
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
console.log('resume-wait-store: ok');
