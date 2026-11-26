import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-wake-'));
const originalNow = Date.now;
let wakes;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const store = await load('main/metaAgent/messageStore.ts');
  const { MailboxWakes } = await load('main/messages/wake.ts');
  store.setAgentMessagesUserDataDir(path.join(tmp, 'user'));
  let now = originalNow(); Date.now = () => now;
  const ctx = { workspaces: { list: () => [{ id: 'w', path: tmp }] }, sessions: { get: () => undefined, broadcastMessagesChanged() {} } };
  let sends = 0;
  wakes = new MailboxWakes(ctx, async () => { sends++; return true; });
  const event = id => store.appendAgentMessageToStore(tmp, 'w', { from: 'host', to: 'orchestrator:w', kind: 'notice', ts: now, receipt: 'stored',
    text: JSON.stringify({ type: 'event-subscription', source: 'gitlab', eventType: 'issue', summary: id, data: { eventId: id } }),
    meta: { hostNotification: { kind: 'event', eventId: id }, eventId: id, subscriptionIds: ['s'], subscriptionEvent: true } });
  await event('one');
  const oldSetTimeout = globalThis.setTimeout, delays = [];
  try {
    globalThis.setTimeout = (fn, delay, ...args) => { delays.push(delay); return oldSetTimeout(fn, delay, ...args); };
    const flushing = wakes.flush('orchestrator:w', 'w');
    wakes.request('orchestrator:w', 'w');
    await flushing;
    assert.equal(delays.at(-1), 120, 'ordinary mail arriving during a flush expedites the next wake');
  } finally { globalThis.setTimeout = oldSetTimeout; }
  assert.equal(sends, 0, 'subscription alone waits for merge window');
  now += 20000; await event('two');
  await wakes.flush('orchestrator:w', 'w');
  assert.equal(sends, 0, 'later event extends the window');
  now += 24999; await wakes.flush('orchestrator:w', 'w');
  assert.equal(sends, 0);
  now += 1; await wakes.flush('orchestrator:w', 'w');
  assert.equal(sends, 1, 'max wait bounds the window');
  const entries = store.readAgentMessageLedger(tmp, 'w').messages;
  await store.markAgentMessagesReadInStore(tmp, 'w', entries.map(m => m.id));
  now += 100; await event('three');
  await store.appendAgentMessageToStore(tmp, 'w', { from: 'other', to: 'orchestrator:w', kind: 'notice', ts: now, receipt: 'stored', text: 'urgent ordinary mail' });
  await wakes.flush('orchestrator:w', 'w');
  assert.equal(sends, 2, 'ordinary mail does not wait for the event window');
  wakes.dispose(); wakes = undefined;
} finally {
  Date.now = originalNow; wakes?.dispose(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
console.log('event-mailbox-wake: ok');
