/** Wake-path error regressions: corrupted host letters, missing app service, repeated failures, shell targets. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-wake-errors-'));
const compile = createSharedCompiler(root, tmp);
const load = rel => import(pathToFileURL(compile(rel)).href);
const store = await load('main/metaAgent/messageStore.ts');
const { hostNotificationDelivery } = await load('main/messages/hostNotifications.ts');
const { MailboxWakes } = await load('main/messages/wake.ts');

let seq = 0;
function world(overrides = {}) {
  const dir = path.join(tmp, `world-${++seq}`); fs.mkdirSync(dir);
  store.setAgentMessagesUserDataDir(dir);
  let broadcasts = 0;
  const people = new Map(Object.entries({
    a: { id: 'a', name: 'a', runtime: 'pi', workspaceId: 'ws', lifecycle: 'idle' },
    b: { id: 'b', name: 'b', runtime: 'pi', workspaceId: 'ws', lifecycle: 'idle', launchKind: 'shell' },
    c: { id: 'c', name: 'c', runtime: 'pi', workspaceId: 'ws', lifecycle: 'idle' }
  }));
  const ctx = {
    sessions: { get: id => people.get(id), peek: id => people.get(id),
      broadcastMessagesChanged() { broadcasts++; }, isChatRuntime: () => true,
      onLifecycle() { return () => {}; } },
    workspaces: { list: () => [{ id: 'ws', path: dir }] },
    resolveBubbleWorkspaceId: () => 'ws',
    agentSessions: { isOpen: () => true, isBusy: () => false, send: async () => ({ ok: true }) },
    ...overrides
  };
  const seed = entry => store.appendAgentMessageToStore(dir, 'ws', {
    kind: 'notice', ts: Date.now(), receipt: 'stored', fromName: entry.from, toName: entry.to, ...entry
  });
  const ledger = () => store.readAgentMessageLedger(dir, 'ws');
  return { ctx, dir, people, seed, ledger, broadcasts: () => broadcasts };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('corrupted host event letter is retired without blocking the batch', async () => {
  const w = world();
  const bad = await w.seed({ id: 'mail-bad', from: 'host', to: 'orchestrator:ws', text: 'not-json{',
    meta: { eventId: 'e-bad', subscriptionIds: ['s1'] } });
  const good = await w.seed({ id: 'mail-good', from: 'host', to: 'orchestrator:ws',
    text: JSON.stringify({ eventType: 'session.phase', sourceSessionId: 'a', occurredAt: 1, summary: '相位变化', data: { value: 'needs_you' } }),
    meta: { eventId: 'e-good', subscriptionIds: ['s1'] } });
  const errors = []; const originalError = console.error; console.error = (...a) => errors.push(a);
  let batch;
  try {
    batch = await hostNotificationDelivery(w.ctx, 'ws').prepare();
  } finally { console.error = originalError; }
  assert.ok(batch, 'good letter still prepares a batch');
  assert.deepEqual(batch.ids, [good.id]);
  assert.ok(errors.length >= 1, 'corruption is logged');
  await tick(); await tick();
  const messages = w.ledger().messages;
  assert.equal(messages.find(m => m.id === bad.id).read, true, 'corrupted letter retired as read');
  assert.equal(messages.find(m => m.id === good.id).read, false, 'good letter stays unread');
});

test('missing agentApps service skips the app letter instead of throwing', async () => {
  const w = world();
  await w.seed({ id: 'mail-app', from: 'host', to: 'orchestrator:ws', text: 'ignored',
    meta: { notificationKey: 'app:evt-1' } });
  const batch = await hostNotificationDelivery(w.ctx, 'ws').prepare();
  assert.equal(batch, null, 'nothing preparable while the service is down');
  await tick();
  assert.equal(w.ledger().messages[0].read, false, 'skipped letter stays unread for a later retry');
});

test('a failing wake writes the error once and never rewrites the same reason', async () => {
  const w = world();
  await w.seed({ id: 'mail-1', from: 'a', to: 'c', text: '结果汇报' });
  const warn = console.warn; console.warn = () => {};
  const wakes = new MailboxWakes(w.ctx, async () => { throw new Error('boom-prepare'); });
  try {
    await wakes.flush('c', 'ws');
    await wakes.flush('c', 'ws');
    await wakes.flush('c', 'ws');
  } finally { console.warn = warn; }
  const message = w.ledger().messages[0];
  assert.equal(message.wakeError, 'boom-prepare');
  assert.equal(message.wakeUncertain, undefined);
  assert.equal(w.broadcasts(), 1, 'same failing reason must not rewrite or re-broadcast');
});

test('letters to a plain shell terminal get a definite wakeError instead of silent stranding', async () => {
  const w = world();
  await w.seed({ id: 'mail-shell', from: 'a', to: 'b', text: '给 shell 的信' });
  const wakes = new MailboxWakes(w.ctx, async () => { throw new Error('must not send to shell'); });
  await wakes.flush('b', 'ws');
  const message = w.ledger().messages[0];
  assert.equal(message.wakeError, '普通 shell 终端不接收唤醒');
  assert.equal(message.notifiedAt, undefined);
  assert.equal(w.broadcasts(), 1);
  await wakes.flush('b', 'ws');
  assert.equal(w.broadcasts(), 1, 'already recorded non-delivery is not rewritten');
});

test('letters to an archived recipient get a definite wakeError instead of silent stranding (X2-F01)', async () => {
  const w = world();
  await w.seed({ id: 'mail-archived', from: 'a', to: 'c', text: '投递后才归档的信' });
  w.people.get('c').archived = true;
  const wakes = new MailboxWakes(w.ctx, async () => { throw new Error('must not send to archived'); });
  await wakes.flush('c', 'ws');
  const message = w.ledger().messages[0];
  assert.equal(message.wakeError, '会话已归档，不再唤醒');
  assert.equal(message.notifiedAt, undefined);
  assert.equal(w.broadcasts(), 1);
  await wakes.flush('c', 'ws');
  assert.equal(w.broadcasts(), 1, 'already recorded non-delivery is not rewritten');
});

test('letters to a deleted recipient get a definite wakeError instead of silent stranding (X2-F01)', async () => {
  const w = world();
  await w.seed({ id: 'mail-deleted', from: 'a', to: 'ghost', text: '投递后才删除的信' });
  const wakes = new MailboxWakes(w.ctx, async () => { throw new Error('must not send to deleted'); });
  await wakes.flush('ghost', 'ws');
  const message = w.ledger().messages[0];
  assert.equal(message.wakeError, '会话已删除，不再唤醒');
  assert.equal(message.notifiedAt, undefined);
  assert.equal(w.broadcasts(), 1);
});
