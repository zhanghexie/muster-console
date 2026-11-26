import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-reminder-'));
let log, stopWakes;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const { deliverSystemReminderEvent } = await load('main/awareness/eventDelivery.ts');
  const { attachMailboxWakes } = await load('main/messages/wake.ts');
  const store = await load('main/metaAgent/messageStore.ts');
  store.setAgentMessagesUserDataDir(path.join(tmp, 'user'));
  let valid = true;
  const ctx = { workspaces: { list: () => [{ id: 'w', path: tmp }] },
    sessions: { get: () => undefined, broadcastMessagesChanged() {}, onLifecycle: () => () => {} },
    resolveBubbleWorkspaceId: () => 'w', agentApps: { notification: async () => valid ? { ok: true } : null } };
  log = new EventLog(path.join(tmp, 'db'));
  const router = new EventRouter(log, (sub, event) => deliverSystemReminderEvent(ctx, sub, event));
  ctx.eventRouter = router;
  stopWakes = attachMailboxWakes(ctx);
  log.subscribe({ subject: 'system:reminder:w', workspaceId: 'w', source: 'reminder', types: [], scope: '', mode: 'instant', createdAt: Date.now(), expiresAt: null });
  const input = id => ({ source: 'reminder', deliveryId: `w:${id}`, type: 'reminder.due', scope: 'reminder', workspaceId: 'w',
    receivedAt: Date.now(), summary: 'Reminder', payload: JSON.stringify({ id, appId: 'reminder', kind: 'reminder.due', title: 'Reminder', action: 'wake' }) });
  router.publish(input('one')); await router.replay();
  let messages = store.readAgentMessageLedger(tmp, 'w').messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].meta.hostNotification.kind, 'app');
  assert.equal(messages[0].meta.subscriptionEvent, true);
  router.publish(input('one')); await router.replay();
  assert.equal(store.readAgentMessageLedger(tmp, 'w').messages.length, 1, 'outbox retry does not duplicate mail');
  valid = false;
  router.publish(input('cancelled')); await router.replay();
  messages = store.readAgentMessageLedger(tmp, 'w').messages;
  assert.equal(messages.length, 1, 'cancelled reminder is rechecked before delivery');
  stopWakes(); stopWakes = undefined; router.stop(); log.close(); log = undefined;
} finally { stopWakes?.(); log?.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
console.log('event-reminder: ok');
