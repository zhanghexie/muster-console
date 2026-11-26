import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'event-log-'));
let log;
try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const compile = createSharedCompiler(root, path.join(dir, 'compiled'));
  const { EventLog, EVENT_RETENTION_MS } = await import(pathToFileURL(compile('main/awareness/eventLog.ts')).href);
  const { dispatchRuntimeFacts } = await import(pathToFileURL(compile('main/awareness/dispatch.ts')).href);
  // Seed the pre-v2 pending schema to exercise the in-place migration path.
  const legacyDb = new DatabaseSync(path.join(dir, 'event-log.sqlite'));
  legacyDb.exec(`CREATE TABLE phase_pending (
    subscription_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, event_sequence INTEGER NOT NULL,
    due_at INTEGER NOT NULL, event_json TEXT NOT NULL, payload TEXT NOT NULL
  );`);
  legacyDb.prepare(`INSERT INTO phase_pending (subscription_id, event_id, event_sequence, due_at, event_json, payload)
    VALUES (?, ?, ?, ?, ?, ?)`).run('legacy-sub', 'legacy-event', 1, 2000,
    JSON.stringify({ id: 'legacy-event', sequence: 1, source: 'phase', deliveryId: 'legacy-delivery', type: 'issue', scope: 'workspace', workspaceId: 'workspace', receivedAt: 1000, summary: 'legacy' }),
    'legacy payload');
  legacyDb.close();
  log = new EventLog(dir);
  const pendingColumns = log.db.prepare('PRAGMA table_info(phase_pending)').all();
  assert.equal(pendingColumns.some(column => column.name === 'payload'), false, 'phase pending keeps the canonical event payload only once');
  assert.equal(log.payload('legacy-event')?.text, 'legacy payload', 'legacy pending payload is restored before migration');
  log.close();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  log = new EventLog(dir);
  const input = { source: 'gitlab', deliveryId: 'uuid', type: 'issue', scope: '6528', receivedAt: 1000, summary: 'test', payload: '你好😀'.repeat(12000) };
  const first = log.append(input);
  assert.equal(first.inserted, true);
  assert.equal(log.append(input).inserted, false);
  assert.throws(() => log.append({ ...input, payload: 'changed' }), /Conflicting event delivery ID/);
  const factCtx = { eventRouter: { publish: event => log.append(event) } };
  const fact = value => ({ id: 'live:session.phase:session-1', kind: 'session.phase', ts: 1000, sessionId: 'session-1', workspaceId: 'workspace',
    summary: `phase=${value}`, data: { value }, source: 'live' });
  await dispatchRuntimeFacts(factCtx, [fact('needs_you')]);
  await dispatchRuntimeFacts(factCtx, [fact('done')]);
  assert.equal(log.list({ source: 'fact' }).length, 2, 'changed live facts get distinct durable delivery IDs');
  assert.equal(log.append({ ...input, source: 'github' }).inserted, true);
  assert.equal(log.append({ ...input, deliveryId: undefined }).inserted, true);
  assert.equal(log.append({ ...input, deliveryId: undefined }).inserted, true);
  const phaseEvent = log.append({ ...input, source: 'phase', deliveryId: 'phase-1', scope: 'workspace', workspaceId: 'workspace' }).event;
  const phaseSub = log.subscribe({ subject: 'phase-worker', workspaceId: 'workspace', source: 'phase', types: ['issue'], scope: 'workspace', mode: 'digest', createdAt: 1000, expiresAt: null });
  log.rememberPhase(phaseSub.id, phaseEvent, input.payload, 2000);
  assert.equal(log.pendingPhase(phaseSub.id)?.event.id, phaseEvent.id);
  assert.equal(log.payload(phaseEvent.id, 0, 32)?.text, input.payload.slice(0, 32), 'pending payload is read from canonical events');
  const sub = log.subscribe({ subject: 'worker', workspaceId: 'workspace', source: 'gitlab', types: ['issue'], scope: '6528', mode: 'instant', createdAt: 1000, expiresAt: null });
  assert.equal(sub.cursor, log.list().at(-1).sequence, 'new subscriptions start at the current end');
  assert.equal(log.advance(sub.id, sub.cursor + 1, sub.cursor + 2), false, 'stale cursor cannot skip events');
  assert.equal(log.advance(sub.id, sub.cursor, sub.cursor + 1), true);
  assert.equal(log.unsubscribe(sub.id, 'other'), false);
  assert.equal(log.subscriptions('worker')[0].cursor, sub.cursor + 1);
  assert.equal(log.list({ limit: 1 })[0].id, first.event.id);
  assert.equal(log.list({ after: first.event.sequence, source: 'gitlab' }).length, 2);
  let offset = 0, reconstructed = '';
  do {
    const page = log.payload(first.event.id, offset, 997);
    reconstructed += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, input.payload);
  log.close();
  log = new EventLog(dir);
  assert.equal(log.subscriptions('worker')[0].cursor, sub.cursor + 1, 'subscription progress survives restart');
  assert.equal(log.unsubscribe(sub.id, 'worker'), true);
  assert.equal(log.append(input).event.id, first.event.id);
  log.clearPendingPhase(phaseSub.id);
  assert.equal(log.prune(1000 + EVENT_RETENTION_MS), 0);
  assert.equal(log.prune(1001 + EVENT_RETENTION_MS), 7);
  assert.deepEqual(log.list(), []);
  const rateSub = log.subscribe({ subject: 'rate', workspaceId: 'w', source: 'gitlab', types: [], scope: '', mode: 'instant', createdAt: 2000, expiresAt: null });
  let cursor = rateSub.cursor;
  for (let i = 0; i < 20; i++) {
    const next = log.append({ ...input, deliveryId: `rate-${i}`, receivedAt: 2000 }).event;
    assert.equal(log.mayDeliver(rateSub.id, 'gitlab', 2000), true);
    log.finishDelivery(rateSub.id, 'gitlab', cursor, next.sequence, 2000); cursor = next.sequence;
  }
  assert.equal(log.mayDeliver(rateSub.id, 'gitlab', 2000), false, 'subscription rate limit is durable');
  assert.equal(log.mayDeliver(rateSub.id, 'gitlab', 3602001), true, 'rate limit expires');
  assert.equal(log.claimLaunch(rateSub.id, cursor), 'claimed');
  assert.equal(log.claimLaunch(rateSub.id, cursor), 'uncertain');
  assert.equal(log.resolveLaunch(rateSub.id, cursor, 'complete'), true);
  assert.equal(log.claimLaunch(rateSub.id, cursor), 'done');
  assert.throws(() => log.list({ limit: 201 }));
  assert.throws(() => log.payload(first.event.id, -1));
  log.close();
  log = undefined;
} finally {
  log?.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log('event-log: ok');
