import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-delivery-'));
let log, stopWakes;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const { deliverSubscriptionEvent } = await load('main/awareness/eventDelivery.ts');
  const { attachMailboxWakes } = await load('main/messages/wake.ts');
  const { getSubscriptionPolicyStore } = await load('main/orchestrator/subscriptionPolicyStore.ts');
  const store = await load('main/metaAgent/messageStore.ts');
  store.setAgentMessagesUserDataDir(path.join(tmp, 'user'));
  const worker = { id: 'worker', workspaceId: 'w', name: 'Worker' };
  const ctx = { workspaces: { list: () => [{ id: 'w', path: tmp }] },
    sessions: { get: id => id === worker.id ? worker : undefined, broadcastMessagesChanged() {}, onLifecycle: () => () => {} },
    resolveBubbleWorkspaceId: () => 'w' };
  log = new EventLog(path.join(tmp, 'db'));
  const router = new EventRouter(log, (sub, event) => deliverSubscriptionEvent(ctx, sub, event));
  ctx.eventRouter = router; stopWakes = attachMailboxWakes(ctx);
  const base = { workspaceId: 'w', source: 'gitlab', types: ['issue'], scope: '6528', createdAt: Date.now(), expiresAt: null };
  log.subscribe({ ...base, subject: 'orchestrator:w', mode: 'digest' });
  log.subscribe({ ...base, subject: 'worker', mode: 'instant' });
  const input = id => ({ source: 'gitlab', deliveryId: id, type: 'issue', scope: '6528', receivedAt: Date.now(), summary: 'issue', payload: '{}' });
  router.publish(input('one')); await router.replay();
  let rows = store.readAgentMessageLedger(tmp, 'w').messages;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.to === 'orchestrator:w').meta.digest, true);
  assert.equal(rows.find(row => row.to === 'worker').meta.digest, undefined);
  getSubscriptionPolicyStore().write(tmp, { version: 1, rules: [{ id: 'mute-gitlab', match: { kind: 'event.subscription', factKind: 'gitlab' }, action: 'mute' }], timing: {}, guards: {} },
    { by: 'test', reason: 'test', now: Date.now() });
  router.publish(input('two')); await router.replay();
  rows = store.readAgentMessageLedger(tmp, 'w').messages;
  assert.equal(rows.filter(row => row.to === 'orchestrator:w').length, 1, 'scheduler source policy can mute');
  assert.equal(rows.filter(row => row.to === 'worker').length, 2, 'scheduler policy does not affect workers');
  stopWakes(); stopWakes = undefined; router.stop(); log.close(); log = undefined;
} finally { stopWakes?.(); log?.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
console.log('event-delivery: ok');
